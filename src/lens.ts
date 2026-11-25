// The Distortion effect's camera model, shared by the preview shader and the export job.
// Directions are x right, y down, z forward. FFmpeg's v360 samples the source along
// Ry(yaw) * Rx(pitch) * Rz(roll) applied to each output ray. Every input and output formula
// here was measured against v360 in FFmpeg 6.1.

import { lensOutputSize, maxLensField } from './types';
import type { DistortFrom, DistortTo, LensJob, LensProjection, LensState, Orientation } from './types';

export { lensOutputSize, maxLensField };

export type Mat3 = number[][];
export type Vec3 = [number, number, number];

const RAD = Math.PI / 180;

export const LENS_PROJECTIONS: { value: LensProjection; label: string }[] = [
  { value: 'equidistant', label: 'Equidistant' },
  { value: 'equisolid', label: 'Equisolid' },
  { value: 'stereographic', label: 'Stereographic' },
  { value: 'orthographic', label: 'Orthographic' },
];

export const DISTORT_FROM: { value: DistortFrom; label: string }[] = [
  { value: 'fisheye', label: 'Fisheye' },
  { value: 'normal', label: 'Normal' },
  { value: 'equirect', label: '360' },
];

export const DISTORT_TO: { value: DistortTo; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'panorama', label: 'Panorama' },
  { value: 'equirect', label: '360 panorama' },
  { value: 'fisheye', label: 'Fisheye' },
  { value: 'planet', label: 'Little planet' },
];

/** The view's horizontal field, per output. A normal view cannot reach 180. */
export function fovRange(to: DistortTo): { min: number; max: number } {
  switch (to) {
    case 'normal':
      return { min: 5, max: 150 };
    case 'planet':
      return { min: 10, max: 330 };
    default:
      return { min: 10, max: 360 };
  }
}

export const LENS_FOV_MIN = 60;
export const LENS_FOV_MAX = 360;
export const SOURCE_FOV_MIN = 10;
export const SOURCE_FOV_MAX = 170;
/** Output short edges offered besides the source's own detail. */
export const LENS_SIZES = [720, 1080, 1440, 2160];

export function defaultLens(width: number, height: number): LensState {
  return {
    from: 'fisheye',
    cx: width / 2,
    cy: height / 2,
    r: Math.min(width, height) / 2,
    lensFov: 180,
    projection: 'equidistant',
    facing: 'up',
    sourceFov: 90,
    to: 'normal',
    pan: 0,
    tilt: 0,
    roll: 0,
    fov: 70,
    rise: 0,
    aspect: 16 / 9,
    size: null,
  };
}

function rx(a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [[1, 0, 0], [0, c, -s], [0, s, c]];
}
function ry(a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
}
function rz(a: number): Mat3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
}
export function mul(a: Mat3, b: Mat3): Mat3 {
  return [0, 1, 2].map((i) => [0, 1, 2].map((j) => a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j]));
}
export function apply(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

/** A fisheye pointed at the sky: framed with the sky kept above the horizon. */
export function isSky(lens: Pick<LensState, 'from' | 'facing'>): boolean {
  return lens.from === 'fisheye' && lens.facing === 'up';
}

/**
 * The rotation from view rays to source rays.
 * Sky: pan turns clockwise from the picture's top, tilt leans away from the lens centre, and
 * the view's top points back toward the centre, so the horizon sits level below.
 * Otherwise: pan right, tilt up, as v360's own yaw and pitch.
 */
export function viewRotation(lens: Pick<LensState, 'from' | 'facing' | 'pan' | 'tilt' | 'roll'>): Mat3 {
  if (!isSky(lens)) return mul(mul(ry(lens.pan * RAD), rx(lens.tilt * RAD)), rz(lens.roll * RAD));
  return mul(mul(mul(rz(lens.pan * RAD), rx(lens.tilt * RAD)), rz(Math.PI)), rz(lens.roll * RAD));
}

/** v360's yaw, pitch and roll (degrees, its default "ypr" order) for a rotation. */
export function v360Angles(m: Mat3): { yaw: number; pitch: number; roll: number } {
  const pitch = Math.asin(Math.max(-1, Math.min(1, -m[1][2])));
  if (Math.cos(pitch) < 1e-6) {
    // Straight up or down in v360's frame: yaw and roll turn about the same axis, so roll takes 0.
    return { yaw: Math.atan2(-m[2][0], m[0][0]) / RAD, pitch: pitch / RAD, roll: 0 };
  }
  return {
    yaw: Math.atan2(m[0][2], m[2][2]) / RAD,
    pitch: pitch / RAD,
    roll: Math.atan2(m[1][0], m[1][1]) / RAD,
  };
}

/** Radius on the lens circle, as a fraction of its edge, for a ray `theta` off the lens axis. */
export function lensRadius(projection: LensProjection, theta: number, lensFov: number): number {
  const half = (lensFov * RAD) / 2;
  switch (projection) {
    case 'equisolid':
      return Math.sin(theta / 2) / Math.sin(half / 2);
    case 'stereographic':
      return Math.tan(theta / 2) / Math.tan(half / 2);
    case 'orthographic':
      return Math.sin(theta) / Math.sin(Math.min(half, Math.PI / 2));
    default:
      return theta / half;
  }
}

/** The inverse of lensRadius, or null past the edge of what the projection can reach. */
export function lensTheta(projection: LensProjection, m: number, lensFov: number): number | null {
  const half = (lensFov * RAD) / 2;
  switch (projection) {
    case 'equisolid': {
      const s = m * Math.sin(half / 2);
      return Math.abs(s) > 1 ? null : 2 * Math.asin(s);
    }
    case 'stereographic':
      return 2 * Math.atan(m * Math.tan(half / 2));
    case 'orthographic': {
      const s = m * Math.sin(Math.min(half, Math.PI / 2));
      return Math.abs(s) > 1 ? null : Math.asin(s);
    }
    default:
      return m * half;
  }
}

/** A decoded-frame pixel position (frame W x H) in the turned frame: the turn, then the flips. */
export function rawToTurned(rx: number, ry: number, orientation: Orientation, W: number, H: number): [number, number] {
  let x: number, y: number;
  switch (orientation.rotate) {
    case 90:
      [x, y] = [H - ry, rx];
      break;
    case 180:
      [x, y] = [W - rx, H - ry];
      break;
    case 270:
      [x, y] = [ry, W - rx];
      break;
    default:
      [x, y] = [rx, ry];
  }
  const turned = orientation.rotate === 90 || orientation.rotate === 270;
  if (orientation.flipH) x = (turned ? H : W) - x;
  if (orientation.flipV) y = (turned ? W : H) - y;
  return [x, y];
}

/** The inverse of rawToTurned. */
export function turnedToRaw(x: number, y: number, orientation: Orientation, W: number, H: number): [number, number] {
  const turned = orientation.rotate === 90 || orientation.rotate === 270;
  if (orientation.flipH) x = (turned ? H : W) - x;
  if (orientation.flipV) y = (turned ? W : H) - y;
  switch (orientation.rotate) {
    case 90:
      return [y, H - x];
    case 180:
      return [W - x, H - y];
    case 270:
      return [W - y, x];
    default:
      return [x, y];
  }
}

/** The lens field the camera model uses, held to what its projection can describe. */
export function lensField(lens: Pick<LensState, 'projection' | 'lensFov'>): number {
  return Math.min(maxLensField(lens.projection), lens.lensFov);
}

/** A normal source's vertical field from its horizontal one and the frame's shape. */
export function sourceVerticalFov(lens: LensState, width: number, height: number): number {
  return (2 * Math.atan((Math.tan((lens.sourceFov * RAD) / 2) * height) / width)) / RAD;
}

/**
 * Where a source ray lands in the turned frame, in frame pixels, or null where the source has
 * no picture: past a fisheye's field, behind or beside a normal camera.
 */
export function rayToFrame(lens: LensState, d: Vec3, width: number, height: number): [number, number] | null {
  if (lens.from === 'equirect') {
    const lon = Math.atan2(d[0], d[2]);
    const lat = Math.asin(Math.max(-1, Math.min(1, d[1] / Math.hypot(d[0], d[1], d[2]))));
    return [((lon / Math.PI + 1) / 2) * width, ((lat / (Math.PI / 2) + 1) / 2) * height];
  }
  if (lens.from === 'normal') {
    if (d[2] <= 1e-9) return null;
    const tx = Math.tan((lens.sourceFov * RAD) / 2);
    const ty = Math.tan((sourceVerticalFov(lens, width, height) * RAD) / 2);
    const u = (d[0] / d[2] / tx + 1) / 2, v = (d[1] / d[2] / ty + 1) / 2;
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    return [u * width, v * height];
  }
  const h = Math.hypot(d[0], d[1]);
  const theta = Math.atan2(h, d[2]);
  const field = lensField(lens);
  if (theta > (field * RAD) / 2 + 1e-9) return null;
  const m = lensRadius(lens.projection, theta, field);
  if (h < 1e-12) return [lens.cx, lens.cy];
  return [lens.cx + (lens.r * m * d[0]) / h, lens.cy + (lens.r * m * d[1]) / h];
}

/** The fisheye ray through a frame pixel, or null outside the circle. */
export function frameToRay(lens: LensState, x: number, y: number): Vec3 | null {
  const dx = (x - lens.cx) / lens.r, dy = (y - lens.cy) / lens.r;
  const m = Math.hypot(dx, dy);
  if (m > 1) return null;
  const theta = lensTheta(lens.projection, m, lensField(lens));
  if (theta === null) return null;
  if (m < 1e-12) return [0, 0, 1];
  const s = Math.sin(theta);
  return [(s * dx) / m, (s * dy) / m, Math.cos(theta)];
}

/** The output's vertical field, degrees, from its horizontal field and shape. */
export function verticalFov(lens: Pick<LensState, 'to' | 'fov' | 'aspect'>): number {
  const h = lens.fov * RAD, a = lens.aspect;
  switch (lens.to) {
    case 'normal':
      return (2 * Math.atan(Math.tan(h / 2) / a)) / RAD;
    case 'panorama':
      return (2 * Math.atan(h / (2 * a))) / RAD;
    case 'equirect':
      return Math.min(180, h / a / RAD);
    case 'fisheye':
      return Math.min(360, h / a / RAD);
    case 'planet':
      return (4 * Math.atan(Math.tan(h / 4) / a)) / RAD;
  }
}

/** The rise as a shift of the normal view's tangent plane, in its own units, up negative. */
export function viewOffset(lens: Pick<LensState, 'to' | 'fov' | 'aspect' | 'rise'>): number {
  if (lens.to !== 'normal' || lens.rise === 0) return 0;
  return -lens.rise * Math.tan((verticalFov(lens) * RAD) / 2);
}

/** The output's own ray through a point, both coordinates 0 to 1, before the aim turns it. */
export function outputRay(lens: LensState, u: number, v: number): Vec3 {
  const U = 2 * u - 1, V = 2 * v - 1;
  const h = (lens.fov * RAD) / 2, vv = (verticalFov(lens) * RAD) / 2;
  const unit = (x: number, y: number, z: number): Vec3 => {
    const n = Math.hypot(x, y, z);
    return [x / n, y / n, z / n];
  };
  const polar = (theta: number, phi: number): Vec3 => [
    Math.sin(theta) * Math.cos(phi),
    Math.sin(theta) * Math.sin(phi),
    Math.cos(theta),
  ];
  switch (lens.to) {
    case 'normal':
      return unit(Math.tan(h) * U, Math.tan(vv) * V + viewOffset(lens), 1);
    case 'panorama':
      return unit(Math.sin(U * h), Math.tan(vv) * V, Math.cos(U * h));
    case 'equirect': {
      const lon = U * h, lat = V * vv;
      return [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)];
    }
    case 'fisheye': {
      const a = U * h, b = V * vv;
      return polar(Math.hypot(a, b), Math.atan2(b, a));
    }
    case 'planet': {
      const x = Math.tan(h / 2) * U, y = Math.tan(vv / 2) * V;
      return polar(2 * Math.atan(Math.hypot(x, y)), Math.atan2(y, x));
    }
  }
}

/** The source ray through a point of the output, both coordinates 0 to 1. */
export function viewRay(lens: LensState, u: number, v: number): Vec3 {
  return apply(viewRotation(lens), outputRay(lens, u, v));
}

/** Where a source ray appears in a normal view, both coordinates 0 to 1, or null behind it. */
export function viewPoint(lens: LensState, d: Vec3): [number, number] | null {
  const m = viewRotation(lens);
  const x = m[0][0] * d[0] + m[1][0] * d[1] + m[2][0] * d[2];
  const y = m[0][1] * d[0] + m[1][1] * d[1] + m[2][1] * d[2];
  const z = m[0][2] * d[0] + m[1][2] * d[1] + m[2][2] * d[2];
  if (z <= 0) return null;
  const tx = Math.tan((lens.fov * RAD) / 2);
  const ty = Math.tan((verticalFov(lens) * RAD) / 2);
  return [(x / z / tx + 1) / 2, ((y / z - viewOffset(lens)) / ty + 1) / 2];
}

export function lensJob(lens: LensState, width: number, height: number): LensJob {
  const { yaw, pitch, roll } = v360Angles(viewRotation(lens));
  const { w, h } = lensOutputSize(lens, width);
  const round = (n: number) => Math.round(n * 1000) / 1000;
  // The output's fields follow its final shape, which rounding to even pixels nudges.
  const shaped = { ...lens, aspect: w / h };
  let vFov = verticalFov(shaped), renderHeight = h, cropY = 0;
  // v360's own v_offset stops at one tangent unit, which a wide view passes at a small rise.
  // A taller view, cut down to the frame, shifts it any distance.
  if (lens.to === 'normal' && lens.rise !== 0) {
    const extra = 2 * Math.round((h * Math.abs(lens.rise)) / 2);
    renderHeight = h + extra;
    vFov = (2 * Math.atan((Math.tan((vFov * RAD) / 2) * renderHeight) / h)) / RAD;
    cropY = lens.rise > 0 ? 0 : extra;
  }
  return {
    from: lens.from,
    cx: round(lens.cx),
    cy: round(lens.cy),
    r: round(lens.r),
    lensFov: round(lensField(lens)),
    projection: lens.projection,
    inHFov: round(lens.sourceFov),
    inVFov: round(sourceVerticalFov(lens, width, height)),
    to: lens.to,
    yaw: round(yaw),
    pitch: round(pitch),
    roll: round(roll),
    hFov: round(lens.fov),
    vFov: round(vFov),
    width: w,
    height: h,
    renderHeight,
    cropY,
  };
}

/**
 * A sky view dragged by (dx, dy) screen pixels on a view `width` pixels wide. The picture follows
 * the pointer as a sky viewer's does: up and down change the tilt, sideways turns round the
 * zenith. With the sky kept up the zenith can never sit below the view's centre, so an exact
 * grab has no answer there and the aim works in angles instead.
 */
export function dragSky(lens: LensState, dx: number, dy: number, width: number): { pan: number; tilt: number } {
  // Degrees per pixel at the view's centre, so what is there keeps up with the pointer.
  const h = (lens.fov * RAD) / 2;
  const span = lens.to === 'normal' ? 2 * Math.tan(h) : lens.to === 'planet' ? 4 * Math.tan(h / 2) : 2 * h;
  const perPixel = span / RAD / Math.max(1, width);
  // A rise puts the frame's centre off the view's axis, where the picture's scale is smaller
  // and its ring round the zenith is another one.
  const o = viewOffset(lens);
  // The turn is the view's last rotation, so the pointer's move is turned back first.
  const c = Math.cos(lens.roll * RAD), s = Math.sin(lens.roll * RAD);
  [dx, dy] = [dx * c - dy * s, dx * s + dy * c];
  const ring = Math.max(Math.sin(lens.tilt * RAD + Math.atan(o)), 0.1);
  const pan = lens.pan + (dx * perPixel) / Math.sqrt(1 + o * o) / ring;
  const tilt = lens.tilt - (dy * perPixel) / (1 + o * o);
  return {
    pan: ((((pan + 180) % 360) + 360) % 360) - 180,
    // Up to straight down, past the lens's own edge.
    tilt: Math.max(0, Math.min(180, tilt)),
  };
}

/**
 * The aim that puts source ray `target` under the output point (u, v), starting from `lens`.
 * A few Newton steps on pan and tilt: the grab-drag of the preview, with no sign conventions
 * to keep in step with viewRotation.
 */
export function aimAt(lens: LensState, target: Vec3, u: number, v: number): { pan: number; tilt: number } {
  let pan = lens.pan, tilt = lens.tilt;
  // Measured on the plane square to the target, where both components vanish at the answer.
  const helper: Vec3 = Math.abs(target[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = unit(cross(target, helper));
  const e2 = cross(target, e1);
  const err = (p: number, t: number): [number, number] => {
    const d = viewRay({ ...lens, pan: p, tilt: t }, u, v);
    return [dot(d, e1), dot(d, e2)];
  };
  for (let i = 0; i < 8; i += 1) {
    const e = err(pan, tilt);
    if (Math.hypot(e[0], e[1]) < 1e-7) break;
    const h = 1e-3;
    const ep = err(pan + h, tilt), et = err(pan, tilt + h);
    const j = [[(ep[0] - e[0]) / h, (et[0] - e[0]) / h], [(ep[1] - e[1]) / h, (et[1] - e[1]) / h]];
    const det = j[0][0] * j[1][1] - j[0][1] * j[1][0];
    if (Math.abs(det) < 1e-12) break;
    let dp = (j[1][1] * e[0] - j[0][1] * e[1]) / det;
    let dt = (-j[1][0] * e[0] + j[0][0] * e[1]) / det;
    const step = Math.hypot(dp, dt);
    if (step > 20) {
      dp *= 20 / step;
      dt *= 20 / step;
    }
    pan -= dp;
    tilt -= dt;
  }
  if (!Number.isFinite(pan) || !Number.isFinite(tilt)) return { pan: lens.pan, tilt: lens.tilt };
  pan = ((((pan + 180) % 360) + 360) % 360) - 180;
  tilt = Math.max(-90, Math.min(90, tilt));
  return { pan, tilt };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function unit(a: Vec3): Vec3 {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
}
