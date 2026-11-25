// Finds a fisheye's round picture in a frame: the lit disc on a black surround that circular
// fisheye and all-sky cameras record.

export interface Circle {
  cx: number;
  cy: number;
  r: number;
}

/**
 * The lens circle in a `width` x `height` brightness map (0 to 255, rows top to bottom), in
 * its pixels, or null when the frame shows no clear disc. Each row's and column's longest lit
 * run ends on the circle's edge; a least-squares circle through those ends, refitted without
 * the ends far from it, ignores thin overlays such as text and rings drawn round the picture.
 */
export function findLensCircle(luma: ArrayLike<number>, width: number, height: number): Circle | null {
  if (width < 16 || height < 16) return null;
  // A 3x3 minimum wipes out lines and text a pixel or two thick, and pulls the disc's edge in
  // by one pixel, which the radius gets back at the end.
  const eroded = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let low = 255;
      for (let j = Math.max(0, y - 1); j <= Math.min(height - 1, y + 1); j += 1) {
        for (let i = Math.max(0, x - 1); i <= Math.min(width - 1, x + 1); i += 1) {
          low = Math.min(low, luma[j * width + i]);
        }
      }
      eroded[y * width + x] = low;
    }
  }
  const sorted = Array.from(eroded).sort((a, b) => a - b);
  const bright = sorted[Math.floor(sorted.length * 0.95)];
  const threshold = Math.max(20, bright * 0.2);
  const lit = (x: number, y: number) => eroded[y * width + x] >= threshold;

  const points: [number, number][] = [];
  // The longest lit run along a line, allowing gaps of two pixels; its ends become points
  // unless they sit on the frame's edge, where the circle may run on past it.
  const scan = (length: number, at: (i: number) => boolean, point: (i: number) => [number, number]) => {
    let best: [number, number] | null = null;
    let start = -1, last = -1;
    for (let i = 0; i <= length; i += 1) {
      const on = i < length && at(i);
      if (on) {
        if (start < 0 || i - last > 3) {
          if (start >= 0 && (!best || last - start > best[1] - best[0])) best = [start, last];
          start = i;
        }
        last = i;
      }
    }
    if (start >= 0 && (!best || last - start > best[1] - best[0])) best = [start, last];
    if (!best || best[1] - best[0] < 4) return;
    if (best[0] > 0) points.push(point(best[0] - 0.5));
    if (best[1] < length - 1) points.push(point(best[1] + 0.5));
  };
  for (let y = 0; y < height; y += 1) scan(width, (x) => lit(x, y), (x) => [x + 0.5, y + 0.5]);
  for (let x = 0; x < width; x += 1) scan(height, (y) => lit(x, y), (y) => [x + 0.5, y + 0.5]);

  let kept = points;
  let circle: Circle | null = null;
  for (let pass = 0; pass < 4; pass += 1) {
    circle = fitCircle(kept);
    if (!circle) return null;
    const c = circle;
    const off = kept.map(([x, y]) => Math.abs(Math.hypot(x - c.cx, y - c.cy) - c.r));
    const limit = Math.max(1.5, 3 * median(off));
    kept = kept.filter((_, i) => off[i] <= limit);
  }
  if (!circle) return null;
  circle = fitCircle(kept);
  if (!circle || kept.length < 24) return null;
  const { cx, cy, r } = circle;
  if (r < Math.min(width, height) * 0.15 || r > Math.hypot(width, height) / 2) return null;
  if (cx < 0 || cy < 0 || cx > width || cy > height) return null;
  // The edge must go most of the way round where the frame shows it, and the disc must be the
  // lit part: a normal picture's shapes can line up with a circle by chance.
  const inside = coverage(eroded, width, height, circle, 0.85, threshold);
  const outside = coverage(eroded, width, height, { cx, cy, r: r * 1.12 }, -1, threshold);
  if (inside < 0.75 || outside > 0.15) return null;
  return { cx, cy, r: r + 1 };
}

/** The share of lit pixels inside `scale` of the circle, or with a negative scale, outside it. */
function coverage(map: Uint8Array, width: number, height: number, c: Circle, scale: number, threshold: number): number {
  let lit = 0, all = 0;
  const step = Math.max(1, Math.floor(Math.min(width, height) / 120));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const d = Math.hypot(x + 0.5 - c.cx, y + 0.5 - c.cy);
      if (scale > 0 ? d > c.r * scale : d < c.r) continue;
      all += 1;
      if (map[y * width + x] >= threshold) lit += 1;
    }
  }
  return all === 0 ? 0 : lit / all;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** The least-squares circle through points (Kasa's fit), or null when they lie on a line. */
function fitCircle(points: [number, number][]): Circle | null {
  if (points.length < 3) return null;
  let mx = 0, my = 0;
  for (const [x, y] of points) {
    mx += x;
    my += y;
  }
  mx /= points.length;
  my /= points.length;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const [x, y] of points) {
    const u = x - mx, v = y - my;
    suu += u * u;
    svv += v * v;
    suv += u * v;
    suuu += u * u * u;
    svvv += v * v * v;
    suvv += u * v * v;
    svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-9) return null;
  const a = (suuu + suvv) / 2, b = (svvv + svuu) / 2;
  const uc = (a * svv - b * suv) / det;
  const vc = (b * suu - a * suv) / det;
  const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / points.length);
  return Number.isFinite(r) ? { cx: uc + mx, cy: vc + my, r } : null;
}
