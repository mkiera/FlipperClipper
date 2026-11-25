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
  // Done as a row pass then a column pass, which is the same and nine times cheaper.
  const rows = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      let low = luma[i];
      if (x > 0) low = Math.min(low, luma[i - 1]);
      if (x < width - 1) low = Math.min(low, luma[i + 1]);
      rows[i] = low;
    }
  }
  const eroded = new Uint8Array(width * height);
  const counts = new Array<number>(256).fill(0);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      let low = rows[i];
      if (y > 0) low = Math.min(low, rows[i - width]);
      if (y < height - 1) low = Math.min(low, rows[i + width]);
      eroded[i] = low;
      counts[low] += 1;
    }
  }
  const percentile = (share: number) => {
    let seen = 0;
    for (let v = 0; v < 256; v += 1) {
      seen += counts[v];
      if (seen >= share * eroded.length) return v;
    }
    return 255;
  };
  // Lit means clearly above the black surround, judged from the picture's own range, so a dim
  // night sky and its dark horizon still count.
  const black = percentile(0.05), bright = percentile(0.95);
  if (bright - black < 12) return null;
  const threshold = black + Math.max(6, (bright - black) * 0.12);
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
  // Most of the edge must lie on the circle: a square or another bright shape does not.
  const fit = circle;
  const onEdge = points.filter(([x, y]) => Math.abs(Math.hypot(x - fit.cx, y - fit.cy) - fit.r) <= Math.max(1.5, fit.r * 0.01));
  if (onEdge.length < points.length * 0.3) return null;
  const { cx, cy, r } = circle;
  if (r < Math.min(width, height) * 0.15 || r > Math.hypot(width, height) / 2) return null;
  if (cx < 0 || cy < 0 || cx > width || cy > height) return null;
  // The edge must go most of the way round where the frame shows it, and the disc must be the
  // lit part: a normal picture's shapes can line up with a circle by chance.
  const inside = coverage(eroded, width, height, circle, 0.85, threshold);
  const outside = coverage(eroded, width, height, { cx, cy, r: r * 1.12 }, -1, threshold);
  if (inside < 0.75 || outside > 0.15) return null;
  // A real lens edge is a step. A picture that fades out toward its edge crosses the threshold
  // on a circle too, but a smaller one, and only just above it.
  const step = edgeStep(luma, width, height, { cx, cy, r: r + 1 });
  if (step < 2 * (threshold - black)) return null;
  return { cx, cy, r: r + 1 };
}

/** How much brighter the picture is just inside the circle than just outside it: the median
 *  over the edge where the frame shows both sides. */
function edgeStep(luma: ArrayLike<number>, width: number, height: number, c: Circle): number {
  const steps: number[] = [];
  const at = (x: number, y: number) => luma[Math.round(y) * width + Math.round(x)];
  for (let i = 0; i < 360; i += 1) {
    const a = (i * Math.PI) / 180, ux = Math.cos(a), uy = Math.sin(a);
    const ix = c.cx + ux * (c.r - 4), iy = c.cy + uy * (c.r - 4);
    const ox = c.cx + ux * (c.r + 3), oy = c.cy + uy * (c.r + 3);
    if (Math.min(ix, ox) < 0 || Math.min(iy, oy) < 0 || Math.max(ix, ox) > width - 1 || Math.max(iy, oy) > height - 1) continue;
    steps.push(at(ix, iy) - at(ox, oy));
  }
  return steps.length < 36 ? 0 : median(steps);
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
