/**
 * Redactions and their keyframes. DOM-free, so the panel, the overlay and the timeline lane all
 * read the same rules and the tests can run them without a page.
 *
 * A redaction with no keyframes is static: its own region and visibility hold for the whole
 * clip. Once it has a keyframe, the keyframes alone decide: the region moves in a straight line
 * from one keyframe to the next, visibility switches at each keyframe, and before the first or
 * after the last the nearest one holds. Keyframe times are on the source timeline, like the
 * speed curve, so a trim or a speed change leaves them on the same frames of the picture.
 */

import type { RedactItem, RedactJob, RedactKey, RedactRegion } from './types';

/** The smallest side a region can be dragged down to, as a fraction of the frame. */
export const REDACT_MIN = 0.02;

/** As many as anyone hides in one clip, and few enough that the export stays one pass. */
export const REDACT_MAX_ITEMS = 8;

export interface RedactState {
  region: RedactRegion;
  on: boolean;
}

/** A region kept inside the frame and no smaller than REDACT_MIN on either side. */
export function clampRegion(region: RedactRegion): RedactRegion {
  const w = Math.min(Math.max(region.w, REDACT_MIN), 1);
  const h = Math.min(Math.max(region.h, REDACT_MIN), 1);
  return {
    x: Math.min(Math.max(region.x, 0), 1 - w),
    y: Math.min(Math.max(region.y, 0), 1 - h),
    w,
    h,
  };
}

function regionOf(key: RedactKey): RedactRegion {
  return { x: key.x, y: key.y, w: key.w, h: key.h };
}

function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

/** Where the redaction is and whether it shows, at source time `t`. */
export function stateAt(item: RedactItem, t: number): RedactState {
  const keys = item.keys;
  if (keys.length === 0) return { region: clampRegion(item.region), on: item.on };
  if (t <= keys[0].t) return { region: clampRegion(regionOf(keys[0])), on: keys[0].on };
  const last = keys[keys.length - 1];
  if (t >= last.t) return { region: clampRegion(regionOf(last)), on: last.on };

  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].t <= t) i += 1;
  const a = keys[i];
  const b = keys[i + 1];
  const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  return {
    region: clampRegion({
      x: lerp(a.x, b.x, f),
      y: lerp(a.y, b.y, f),
      w: lerp(a.w, b.w, f),
      h: lerp(a.h, b.h, f),
    }),
    on: a.on,
  };
}

/** The keyframe within `tolerance` seconds of `t`, or -1. */
export function keyIndexAt(item: RedactItem, t: number, tolerance: number): number {
  let best = -1;
  let closest = tolerance;
  item.keys.forEach((key, index) => {
    const away = Math.abs(key.t - t);
    if (away <= closest) {
      closest = away;
      best = index;
    }
  });
  return best;
}

function sorted(keys: RedactKey[]): RedactKey[] {
  return [...keys].sort((a, b) => a.t - b.t);
}

function keyFrom(t: number, state: RedactState): RedactKey {
  const r = clampRegion(state.region);
  return { t, x: r.x, y: r.y, w: r.w, h: r.h, on: state.on };
}

/**
 * A change made with the playhead at `t`. Static redactions change in place. Keyframed ones
 * change the keyframe at the playhead, adding one there when there is none, so moving the box
 * at a new moment is how a new keyframe is set.
 */
export function withEdit(
  item: RedactItem,
  t: number,
  patch: Partial<RedactState>,
  tolerance: number,
): RedactItem {
  if (item.keys.length === 0) {
    return {
      ...item,
      region: patch.region ? clampRegion(patch.region) : item.region,
      on: patch.on ?? item.on,
    };
  }
  const index = keyIndexAt(item, t, tolerance);
  const at = index >= 0 ? item.keys[index].t : t;
  const current = stateAt(item, at);
  const key = keyFrom(at, { region: patch.region ?? current.region, on: patch.on ?? current.on });
  const keys = item.keys.slice();
  if (index >= 0) keys[index] = key;
  else keys.push(key);
  return { ...item, keys: sorted(keys) };
}

/** The keyframe button: removes the keyframe at the playhead, or adds one holding what is
 *  showing there now. */
export function withKeyToggled(item: RedactItem, t: number, tolerance: number): RedactItem {
  const index = keyIndexAt(item, t, tolerance);
  if (index >= 0) return withoutKey(item, index);
  return { ...item, keys: sorted([...item.keys, keyFrom(t, stateAt(item, t))]) };
}

/** Removing the last keyframe leaves the redaction static where that keyframe had it. */
export function withoutKey(item: RedactItem, index: number): RedactItem {
  const removed = item.keys[index];
  if (!removed) return item;
  const keys = item.keys.filter((_, i) => i !== index);
  if (keys.length > 0) return { ...item, keys };
  return { ...item, keys, region: clampRegion(regionOf(removed)), on: removed.on };
}

/** A keyframe dragged along the timeline. Returns the item and where the key landed in the
 *  re-sorted list, so a drag can keep hold of it past its neighbours. */
export function withKeyMoved(
  item: RedactItem,
  index: number,
  t: number,
): { item: RedactItem; index: number } {
  const key = item.keys[index];
  if (!key) return { item, index };
  const moved = { ...key, t: Math.max(0, t) };
  const keys = item.keys.slice();
  keys[index] = moved;
  const next = sorted(keys);
  return { item: { ...item, keys: next }, index: next.indexOf(moved) };
}

/** Whether the redaction shows at any moment of the clip. */
export function everShown(item: RedactItem): boolean {
  return item.keys.length === 0 ? item.on : item.keys.some((key) => key.on);
}

/** What the export gets: always at least one keyframe, so a static redaction is a single
 *  keyframe the export holds for the whole clip. */
export function toRedactJob(item: RedactItem): RedactJob {
  const keys =
    item.keys.length === 0
      ? [keyFrom(0, { region: item.region, on: item.on })]
      : item.keys.map((key) => keyFrom(key.t, { region: regionOf(key), on: key.on }));
  return { mode: item.mode, strength: item.strength, keys };
}

/** A new redaction, offset from the last so it does not land exactly on top of it. */
export function newRedaction(items: RedactItem[]): RedactItem {
  const id = items.reduce((max, item) => Math.max(max, item.id), 0) + 1;
  const step = (items.length % 5) * 0.06;
  return {
    id,
    mode: items[items.length - 1]?.mode ?? 'pixelate',
    strength: items[items.length - 1]?.strength ?? 16,
    region: clampRegion({ x: 0.35 + step, y: 0.35 + step, w: 0.3, h: 0.3 }),
    on: true,
    keys: [],
  };
}

export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The block size a pixelation of `strength` uses across a frame of `size` pixels: the export
 *  scales the whole frame down to whole blocks and back up. */
export function blockSize(strength: number, size: number): number {
  return size / Math.max(1, Math.floor(size / Math.max(1, Math.round(strength))));
}

/**
 * The source area a redaction's preview has to rebuild, in cut-frame pixels. Walked backwards
 * through the earlier redactions: a blur reads up to three sigma beyond what it writes, and a
 * pixelation reads its whole blocks, so each one widens what the ones before it must supply.
 */
export function sourceBounds(
  target: Bounds,
  earlier: { item: RedactItem; region: RedactRegion }[],
  width: number,
  height: number,
): Bounds {
  let b = { ...target };
  for (let i = earlier.length - 1; i >= 0; i -= 1) {
    const { item, region } = earlier[i];
    const box = {
      x0: region.x * width,
      y0: region.y * height,
      x1: (region.x + region.w) * width,
      y1: (region.y + region.h) * height,
    };
    // Only the part of this redaction that lands inside what is needed matters.
    const hit = {
      x0: Math.max(b.x0, box.x0),
      y0: Math.max(b.y0, box.y0),
      x1: Math.min(b.x1, box.x1),
      y1: Math.min(b.y1, box.y1),
    };
    if (item.mode === 'box' || hit.x0 >= hit.x1 || hit.y0 >= hit.y1) continue;
    if (item.mode === 'blur') {
      const pad = item.strength * 3;
      b = { x0: Math.min(b.x0, hit.x0 - pad), y0: Math.min(b.y0, hit.y0 - pad), x1: Math.max(b.x1, hit.x1 + pad), y1: Math.max(b.y1, hit.y1 + pad) };
    } else {
      const bw = blockSize(item.strength, width);
      const bh = blockSize(item.strength, height);
      b = {
        x0: Math.min(b.x0, Math.floor(hit.x0 / bw) * bw),
        y0: Math.min(b.y0, Math.floor(hit.y0 / bh) * bh),
        x1: Math.max(b.x1, Math.ceil(hit.x1 / bw) * bw),
        y1: Math.max(b.y1, Math.ceil(hit.y1 / bh) * bh),
      };
    }
  }
  return { x0: Math.max(0, b.x0), y0: Math.max(0, b.y0), x1: Math.min(width, b.x1), y1: Math.min(height, b.y1) };
}
