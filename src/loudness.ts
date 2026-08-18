/**
 * The one number the live preview can stand in for loudnorm with.
 *
 * The export runs the real filter, which limits dynamically. A preview can only multiply, so it
 * multiplies by the gain that would take the file's measured loudness to the same target. That
 * is exact wherever loudnorm itself lands on a linear correction, and optimistic on material
 * with peaks it would have limited.
 */

import { measureLoudness } from './ipc';
import type { Loudness } from './types';

let forPath: string | null = null;
let measured: Loudness | null = null;
let pending: string | null = null;

/** The multiplier normalising would apply, or 1 while nothing is known about this file. */
export function normalizeGain(): number {
  return measured?.gain ?? 1;
}

/** What was measured, for the UI to explain itself with. Null until an answer arrives. */
export function loudness(): Loudness | null {
  return measured;
}

/**
 * Measures a file once and remembers it. The whole file rather than the trim: it is one pass
 * either way, and a trim moves the answer by a fraction of a LU.
 */
export async function ensureMeasured(path: string, onSettled: () => void): Promise<void> {
  if (forPath === path || pending === path) return;
  pending = path;
  try {
    const result = await measureLoudness(path);
    // A second file can have been opened while this was in flight.
    if (pending !== path) return;
    forPath = path;
    measured = result;
  } catch {
    // A clip with no measurable loudness previews at unity, which is what it did before.
    if (pending === path) {
      forPath = path;
      measured = null;
    }
  } finally {
    if (pending === path) pending = null;
    onSettled();
  }
}

/** A new file knows nothing until it is measured again. */
export function forgetLoudness(): void {
  forPath = null;
  measured = null;
  pending = null;
}
