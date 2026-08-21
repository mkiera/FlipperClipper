/**
 * The speed curve: how fast the clip runs at each moment, rather than all the way through.
 *
 * A ramp is a list of points on the SOURCE timeline, each holding a multiplier on top of the
 * speed slider. No points at all means a flat 1, which is the speed slider on its own and the
 * behaviour the app had before ramps existed.
 *
 * Between two points the speed moves GEOMETRICALLY, not by equal steps: halfway from 8x to 1x
 * is 2.83x rather than 4.5x. Speed is multiplicative, and the lane draws it on a log axis, so
 * a geometric move is the one that draws as a straight line between the two points. The line
 * in the lane is then the speed itself rather than a picture of it.
 *
 * Output time is the integral of 1/speed, so a ramp shortens the clip by a different amount
 * than its endpoints suggest. A geometric ramp integrates in closed form, and ffmpeg's setpts
 * gets that same expression, so the preview, the size estimate and the exported file all agree
 * on how long the clip is.
 *
 * DOM-free on purpose - ramplane.ts draws the lane and player.ts follows the curve, and both
 * read the maths from here.
 */

import type { EditState, SpeedPoint } from './types';

/** The bounds a point can hold, matching the speed slider's own range. */
export const RAMP_MIN = 0.05;
export const RAMP_MAX = 20;

/** Two points closer than this are the same instant to a pointer, and a segment that short
 *  integrates to nothing useful. */
export const RAMP_EPSILON = 0.001;

/** Points are kept sorted, so a lane that drags one past another does not have to re-think. */
export function sortPoints(points: SpeedPoint[]): SpeedPoint[] {
  return [...points].sort((a, b) => a.t - b.t);
}

/** The multiplier at a source time, holding flat outside the points. */
export function multiplierAt(points: SpeedPoint[], t: number): number {
  if (points.length === 0) return 1;
  if (t <= points[0].t) return points[0].speed;
  const last = points[points.length - 1];
  if (t >= last.t) return last.speed;

  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (t <= b.t) {
      const span = b.t - a.t;
      if (span <= RAMP_EPSILON) return b.speed;
      return betweenSpeeds(a.speed, b.speed, (t - a.t) / span);
    }
  }
  return last.speed;
}

/** A speed part way from one to another, moving by equal ratios rather than equal steps. On
 *  the lane's log axis this is the straight line between the two points. */
export function betweenSpeeds(from: number, to: number, fraction: number): number {
  if (from <= 0 || to <= 0) return from;
  return from * Math.pow(to / from, fraction);
}

/** What the clip actually runs at: the slider, bent by the curve. */
export function speedAt(state: EditState, t: number): number {
  return state.speed * multiplierAt(state.ramp, t);
}

/** True once the curve does something, so the flat case can keep the old, cheaper path. */
export function hasRamp(state: EditState): boolean {
  return state.ramp.length > 0 && state.ramp.some((p) => Math.abs(p.speed - 1) > 1e-9);
}

/**
 * The curve as flat and sloped pieces across [from, to], with the speed at each end. Every
 * calculation below walks these rather than the points, so the ends of the trim and the points
 * outside it are handled once here instead of in each of them.
 */
export interface RampSegment {
  from: number;
  to: number;
  speedFrom: number;
  speedTo: number;
}

export function segmentsOver(state: EditState, from: number, to: number): RampSegment[] {
  const cuts = [from];
  for (const point of state.ramp) {
    if (point.t > from + RAMP_EPSILON && point.t < to - RAMP_EPSILON) cuts.push(point.t);
  }
  cuts.push(to);

  const out: RampSegment[] = [];
  for (let i = 1; i < cuts.length; i += 1) {
    const a = cuts[i - 1];
    const b = cuts[i];
    if (b - a <= RAMP_EPSILON) continue;
    out.push({ from: a, to: b, speedFrom: speedAt(state, a), speedTo: speedAt(state, b) });
  }
  return out;
}

/** How long one segment lasts in the finished clip. Constant speed divides; a geometric ramp
 *  integrates in closed form, which is exact rather than a fine-enough sum of slices. */
export function segmentOutput(segment: RampSegment): number {
  const { from, to, speedFrom, speedTo } = segment;
  const span = to - from;
  if (span <= 0 || speedFrom <= 0 || speedTo <= 0) return 0;
  if (Math.abs(speedTo - speedFrom) < 1e-9) return span / speedFrom;
  return (span * (1 / speedFrom - 1 / speedTo)) / Math.log(speedTo / speedFrom);
}

/** The finished clip's length. Replaces dividing the trim by one speed. */
export function rampedDuration(state: EditState): number {
  if (state.speed <= 0) return 0;
  const span = state.outPoint - state.inPoint;
  if (span <= 0) return 0;
  if (!hasRamp(state)) return span / state.speed;
  return Math.max(
    0,
    segmentsOver(state, state.inPoint, state.outPoint).reduce(
      (total, segment) => total + segmentOutput(segment),
      0,
    ),
  );
}

/** Where a source time lands in the finished clip. The lane uses it to place its own playhead
 *  and the preview uses it to know how far through the export it is. */
export function outputTimeAt(state: EditState, t: number): number {
  const clamped = Math.min(Math.max(t, state.inPoint), state.outPoint);
  if (!hasRamp(state)) return (clamped - state.inPoint) / Math.max(state.speed, 1e-9);
  return segmentsOver(state, state.inPoint, clamped).reduce(
    (total, segment) => total + segmentOutput(segment),
    0,
  );
}

/** A point added to the curve without disturbing the shape it already has. */
export function withPointAt(points: SpeedPoint[], t: number, speed: number): SpeedPoint[] {
  const kept = points.filter((p) => Math.abs(p.t - t) > RAMP_EPSILON);
  return sortPoints([...kept, { t, speed: clampSpeed(speed) }]);
}

export function withoutPoint(points: SpeedPoint[], index: number): SpeedPoint[] {
  return points.filter((_, i) => i !== index);
}

/** One point moved. Kept inside its neighbours so the curve never doubles back on itself,
 *  which would make two speeds true at the same instant. */
export function withPointMoved(
  points: SpeedPoint[],
  index: number,
  t: number,
  speed: number,
): SpeedPoint[] {
  if (index < 0 || index >= points.length) return points;
  // Twice the epsilon, not once. export.rs refuses two points closer than RAMP_EPSILON, and a
  // drag that stops exactly on that line leaves the rounding of one subtraction to decide
  // whether the export is accepted.
  const gap = RAMP_EPSILON * 2;
  const low = index > 0 ? points[index - 1].t + gap : -Infinity;
  const high = index < points.length - 1 ? points[index + 1].t - gap : Infinity;
  const next = [...points];
  next[index] = { t: Math.min(Math.max(t, low), high), speed: clampSpeed(speed) };
  return next;
}

export function clampSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1;
  return Math.min(Math.max(speed, RAMP_MIN), RAMP_MAX);
}
