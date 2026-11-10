/**
 * Keyframes on one effect dial. DOM-free, like redact.ts, and the same rules: with no
 * keyframes the dial and the effect's switch hold for the whole clip. With any, the value
 * moves in a straight line from one keyframe to the next, on/off switches at each keyframe,
 * and before the first or after the last the nearest one holds. Times are on the source
 * timeline.
 */

import type { ValueKey } from './types';

export interface ValueState {
  v: number;
  on: boolean;
}

export function valueAt(keys: ValueKey[], fallback: ValueState, t: number): ValueState {
  if (keys.length === 0) return fallback;
  const first = keys[0];
  if (t <= first.t) return { v: first.v, on: first.on };
  const last = keys[keys.length - 1];
  if (t >= last.t) return { v: last.v, on: last.on };
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].t <= t) i += 1;
  const a = keys[i];
  const b = keys[i + 1];
  const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  return { v: a.v + (b.v - a.v) * f, on: a.on };
}

/** The keyframe within `tolerance` seconds of `t`, or -1. */
export function valueKeyIndexAt(keys: ValueKey[], t: number, tolerance: number): number {
  let best = -1;
  let closest = tolerance;
  keys.forEach((key, index) => {
    const away = Math.abs(key.t - t);
    if (away <= closest) {
      closest = away;
      best = index;
    }
  });
  return best;
}

function sorted(keys: ValueKey[]): ValueKey[] {
  return [...keys].sort((a, b) => a.t - b.t);
}

/** A change at the playhead on a keyframed dial: the keyframe there changes, or one is added. */
export function withValueEdit(
  keys: ValueKey[],
  t: number,
  patch: Partial<ValueState>,
  tolerance: number,
): ValueKey[] {
  const index = valueKeyIndexAt(keys, t, tolerance);
  const at = index >= 0 ? keys[index].t : t;
  const current = valueAt(keys, { v: 0, on: true }, at);
  const key = { t: at, v: patch.v ?? current.v, on: patch.on ?? current.on };
  const next = keys.slice();
  if (index >= 0) next[index] = key;
  else next.push(key);
  return sorted(next);
}

/** The keyframe button: removes the keyframe at the playhead, or adds one holding what shows
 *  there now. */
export function withValueKeyToggled(
  keys: ValueKey[],
  fallback: ValueState,
  t: number,
  tolerance: number,
): ValueKey[] {
  const index = valueKeyIndexAt(keys, t, tolerance);
  if (index >= 0) return keys.filter((_, i) => i !== index);
  const now = valueAt(keys, fallback, t);
  return sorted([...keys, { t, v: now.v, on: now.on }]);
}

/** A keyframe dragged along the timeline, and where it landed in the re-sorted list. */
export function withValueKeyMoved(
  keys: ValueKey[],
  index: number,
  t: number,
): { keys: ValueKey[]; index: number } {
  const key = keys[index];
  if (!key) return { keys, index };
  const moved = { ...key, t: Math.max(0, t) };
  const next = keys.slice();
  next[index] = moved;
  const result = sorted(next);
  return { keys: result, index: result.indexOf(moved) };
}

/** The stretches of [0, duration] where the keyframes have the effect on. */
export function onSpans(keys: { t: number; on: boolean }[], duration: number): [number, number][] {
  const spans: [number, number][] = [];
  if (keys.length === 0) return spans;
  const edges = [0, ...keys.map((key) => key.t), duration];
  for (let i = 0; i < edges.length - 1; i += 1) {
    // Before the first keyframe the first one holds, then each one rules until the next.
    const key = keys[Math.max(0, i - 1)];
    const start = Math.min(Math.max(edges[i], 0), duration);
    const end = Math.min(Math.max(edges[i + 1], 0), duration);
    if (key.on && end > start) spans.push([start, end]);
  }
  return spans;
}
