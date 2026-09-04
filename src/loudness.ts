import { measureLoudness } from './ipc';
import type { AudioTrackSettings, Loudness } from './types';

let requestedKey: string | null = null;
let measured: Loudness | null = null;
let generation = 0;
const measurements = new Map<string, Loudness | null>();

export function normalizeGain(): number {
  return measured?.gain ?? 1;
}

export function loudness(): Loudness | null {
  return measured;
}

export async function ensureMeasured(
  path: string,
  onSettled: () => void,
  audioTracks: AudioTrackSettings[] = [],
): Promise<void> {
  const tracks = audioTracks.length > 1 ? audioTracks : [];
  const key = JSON.stringify([path, tracks]);
  if (requestedKey === key) return;
  requestedKey = key;
  measured = measurements.get(key) ?? null;
  const token = ++generation;
  queueMicrotask(onSettled);
  if (measurements.has(key)) return;
  if (tracks.length > 1) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 350));
    if (token !== generation) return;
  }
  try {
    const result = await measureLoudness(path, tracks);
    if (token !== generation) return;
    measurements.set(key, result);
    measured = result;
  } catch {
    if (token !== generation) return;
    measurements.set(key, null);
    measured = null;
  } finally {
    if (token === generation) onSettled();
  }
}

export function forgetLoudness(): void {
  generation += 1;
  requestedKey = null;
  measured = null;
  measurements.clear();
}
