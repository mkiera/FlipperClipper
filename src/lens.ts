// The fisheye view's camera model, shared by the preview shader and the export job.
// Directions are x right, y down, z along the lens axis. FFmpeg's v360 samples the fisheye at
// Ry(yaw) * Rx(pitch) * Rz(roll) applied to each output ray, measured against v360 6.1.

import { lensOutputSize } from './types';
import type { LensJob, LensProjection, LensState } from './types';

export { lensOutputSize };

export type Mat3 = number[][];
export type Vec3 = [number, number, number];

const RAD = Math.PI / 180;

export const LENS_PROJECTIONS: { value: LensProjection; label: string }[] = [
  { value: 'equidistant', label: 'Equidistant' },
  { value: 'equisolid', label: 'Equisolid' },
  { value: 'stereographic', label: 'Stereographic' },
  { value: 'orthographic', label: 'Orthographic' },
];

export const VIEW_FOV_MIN = 5;
export const VIEW_FOV_MAX = 150;
export const LENS_FOV_MIN = 60;
export const LENS_FOV_MAX = 360;
/** Output short edges offered besides the lens's own resolution. */
export const LENS_SIZES = [720, 1080, 1440, 2160];

export function defaultLens(width: number, height: number): LensState {
  return {
    cx: width / 2,
    cy: height / 2,
    r: Math.min(width, height) / 2,
    lensFov: 180,
    projection: 'equidistant',
    facing: 'up',
    pan: 0,
    tilt: 0,
    roll: 0,
    fov: 70,
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

/**
 * The rotation from view rays to lens rays.
 * Facing up (a sky camera): pan turns clockwise from the picture's top, tilt leans away from the
 * lens centre, and the view's top points back toward the centre, so the horizon sits level below.
 * Facing forward: pan right, tilt up, as v360's own yaw and pitch.
 */
export function viewRotation(lens: Pick<LensState, 'facing' | 'pan' | 'tilt' | 'roll'>): Mat3 {
  if (lens.facing === 'forward') return mul(mul(ry(lens.pan * RAD), rx(lens.tilt * RAD)), rz(lens.roll * RAD));
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

/** Where a lens ray lands in the frame, in frame pixels, or null outside the lens circle. */
export function rayToFrame(lens: LensState, d: Vec3): [number, number] | null {
  const h = Math.hypot(d[0], d[1]);
  const theta = Math.atan2(h, d[2]);
  if (theta > (lens.lensFov * RAD) / 2 + 1e-9) return null;
  const m = lensRadius(lens.projection, theta, lens.lensFov);
  if (h < 1e-12) return [lens.cx, lens.cy];
  return [lens.cx + (lens.r * m * d[0]) / h, lens.cy + (lens.r * m * d[1]) / h];
}

/** The lens ray through a frame pixel, or null outside the circle. */
export function frameToRay(lens: LensState, x: number, y: number): Vec3 | null {
  const dx = (x - lens.cx) / lens.r, dy = (y - lens.cy) / lens.r;
  const m = Math.hypot(dx, dy);
  if (m > 1) return null;
  const theta = lensTheta(lens.projection, m, lens.lensFov);
  if (theta === null) return null;
  if (m < 1e-12) return [0, 0, 1];
  const s = Math.sin(theta);
  return [(s * dx) / m, (s * dy) / m, Math.cos(theta)];
}

export function verticalFov(fov: number, aspect: number): number {
  return (2 * Math.atan(Math.tan((fov * RAD) / 2) / aspect)) / RAD;
}

/** The view ray through a point of the output, both coordinates 0 to 1. */
export function viewRay(lens: LensState, u: number, v: number): Vec3 {
  const tx = Math.tan((lens.fov * RAD) / 2);
  const ty = Math.tan((verticalFov(lens.fov, lens.aspect) * RAD) / 2);
  const x = tx * (2 * u - 1), y = ty * (2 * v - 1);
  const n = Math.hypot(x, y, 1);
  return apply(viewRotation(lens), [x / n, y / n, 1 / n]);
}

export function lensJob(lens: LensState): LensJob {
  const { yaw, pitch, roll } = v360Angles(viewRotation(lens));
  const { w, h } = lensOutputSize(lens);
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    cx: round(lens.cx),
    cy: round(lens.cy),
    r: round(lens.r),
    lensFov: round(lens.lensFov),
    projection: lens.projection,
    yaw: round(yaw),
    pitch: round(pitch),
    roll: round(roll),
    hFov: round(lens.fov),
    vFov: round(2 * Math.atan(Math.tan((lens.fov * RAD) / 2) * (h / w)) / RAD),
    width: w,
    height: h,
  };
}

/**
 * The aim that puts lens ray `target` under the output point (u, v), starting from `lens`.
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
  const tiltLimit = lens.facing === 'up' ? lens.lensFov / 2 + 30 : 179;
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
  if (lens.facing === 'up') tilt = Math.max(0, Math.min(tiltLimit, tilt));
  else tilt = Math.max(-89.9, Math.min(89.9, tilt));
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
