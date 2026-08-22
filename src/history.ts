/**
 * Undo and redo for the edit, Ctrl+Z and Ctrl+Y.
 *
 * The whole edit is snapshotted rather than the individual change, which is affordable because
 * EditState is a handful of numbers plus three objects that are already replaced rather than
 * mutated: ramp.ts, crop.ts and effects.ts every one of them returns a new object, so a shallow
 * copy is a true snapshot. Anything that starts mutating one in place breaks this quietly, so
 * the rule matters more than the copy.
 *
 * Only the edit is here. The output settings - format, quality, resolution, bitrate, lossless -
 * are deliberately outside it: they survive a clip, they are not what a mis-drag ruins, and
 * stepping back through them would make Ctrl+Z undo things the user cannot see on the picture.
 *
 * Memory only, and cleared when a clip is opened. There is nothing to save and nothing to
 * manage, which is the same rule the rest of the app follows.
 */

import { edit, replaceEdit } from './state';
import type { EditState } from './types';

/** A drag emits a patch per pointer move. Steps this close together that move the SAME field
 *  are one gesture and collapse into one entry, rather than filling the stack with a slider's
 *  every position. Different fields never merge, so pressing M then R quickly is two steps. */
const MERGE_MS = 400;

/** Enough for any session's worth of edits on one clip. The cap exists so a long scrub cannot
 *  grow the stack without limit, not because anyone reaches it. */
const MAX_STEPS = 200;

/** What undo restores. Everything else on EditState is either the file itself or an output
 *  setting, and neither belongs in an edit history. */
const TRACKED = [
  'inPoint',
  'outPoint',
  'speed',
  'ramp',
  'crop',
  'mute',
  'reverse',
  'normalize',
  'volume',
  'orientation',
  'effects',
] as const;

type Tracked = (typeof TRACKED)[number];
export type EditSnapshot = Pick<EditState, Tracked>;

let past: EditSnapshot[] = [];
let future: EditSnapshot[] = [];

/** The state as it was before the patch being applied now, held until it is known whether the
 *  patch changed anything worth recording. */
let pending: EditSnapshot | null = null;
let lastPushedAt = 0;

/** Which fields the last recorded step changed, so a merge can require the same ones. */
let lastKeys = '';

/** Set while undo or redo is applying, so the patch they make is not recorded as a new edit. */
let restoring = false;

function snapshot(): EditSnapshot {
  const out = {} as Record<string, unknown>;
  for (const key of TRACKED) out[key] = edit[key];
  return out as EditSnapshot;
}

/** Which tracked fields differ, as a stable string. Identity, not deep equality: every tracked
 *  object is replaced rather than mutated, so two snapshots share a reference exactly when
 *  nothing changed. */
function changedKeys(a: EditSnapshot, b: EditSnapshot): string {
  return TRACKED.filter((key) => a[key] !== b[key]).join(',');
}

/** Called by state.ts before a patch lands, and again after. Splitting it in two is what lets
 *  a patch that changes nothing - and there are many, since the controls re-apply their own
 *  values - leave the stack alone. */
export function beforePatch(): void {
  if (restoring) return;
  pending = snapshot();
}

export function afterPatch(): void {
  if (restoring || !pending) {
    pending = null;
    return;
  }
  const before = pending;
  pending = null;
  const keys = changedKeys(before, snapshot());
  if (keys === '') return;

  // A new edit is a new branch: whatever was undone is no longer reachable.
  future = [];

  const now = performance.now();
  const merged = past.length > 0 && keys === lastKeys && now - lastPushedAt < MERGE_MS;
  lastPushedAt = now;
  lastKeys = keys;
  // Merging keeps the OLDER entry, which is where the gesture started.
  if (merged) return;

  past.push(before);
  if (past.length > MAX_STEPS) past.shift();
}

export function canUndo(): boolean {
  return past.length > 0;
}

export function canRedo(): boolean {
  return future.length > 0;
}

export function undo(): boolean {
  const previous = past.pop();
  if (!previous) return false;
  future.push(snapshot());
  apply(previous);
  return true;
}

export function redo(): boolean {
  const next = future.pop();
  if (!next) return false;
  past.push(snapshot());
  apply(next);
  return true;
}

function apply(state: EditSnapshot): void {
  restoring = true;
  try {
    replaceEdit(state);
  } finally {
    restoring = false;
  }
  // A restored step is its own gesture: the next edit must not merge into the one before it.
  lastPushedAt = 0;
  lastKeys = '';
}

/** A new clip has no history worth keeping - the previous clip's trim points mean nothing
 *  against a different file's length. */
export function clearHistory(): void {
  past = [];
  future = [];
  pending = null;
  lastPushedAt = 0;
  lastKeys = '';
}
