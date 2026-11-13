/**
 * Several clips on one timeline. Every time the rest of the app works with (the playhead, the
 * trim, keyframes, the speed curve) is a time on the timeline the clips make in order. This
 * module turns those times into a clip and a moment in its file, and back.
 *
 * DOM-free, so the tests can run it.
 */

import {
  CLIP_EPSILON,
  isPlainClips,
  type Clip,
  type ClipPiece,
  type EditState,
  type EffectsState,
  type MediaInfo,
} from './types';

/** Past this the export command line gets too long for Windows. */
export const MAX_CLIPS = 32;

/** The shortest clip a split leaves behind. Shorter than this is a slip of the pointer. */
export const MIN_CLIP_SECONDS = 0.1;

export const isPlain = isPlainClips;

export function clipLength(clip: Clip): number {
  return Math.max(0, clip.end - clip.start);
}

export function totalDuration(clips: Clip[]): number {
  return clips.reduce((sum, clip) => sum + clipLength(clip), 0);
}

/** Where each clip starts on the timeline. */
export function clipStarts(clips: Clip[]): number[] {
  const starts: number[] = [];
  let at = 0;
  for (const clip of clips) {
    starts.push(at);
    at += clipLength(clip);
  }
  return starts;
}

export interface Located {
  index: number;
  /** Seconds into the clip's file. */
  local: number;
}

/**
 * The clip under a timeline time. A time on the edge between two clips belongs to the later
 * one, because that is the frame that shows there; `atEnd` gives it to the earlier one, which
 * is what an out point or the end of a range means.
 */
export function locate(clips: Clip[], t: number, atEnd = false): Located | null {
  if (clips.length === 0) return null;
  let at = 0;
  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index];
    const length = clipLength(clip);
    const inside = atEnd ? t <= at + length + CLIP_EPSILON : t < at + length - CLIP_EPSILON;
    if (inside || index === clips.length - 1) {
      const offset = Math.min(Math.max(t - at, 0), length);
      return { index, local: clip.start + offset };
    }
    at += length;
  }
  return null;
}

export function timelineTime(clips: Clip[], index: number, local: number): number {
  const clip = clips[index];
  if (!clip) return 0;
  const offset = Math.min(Math.max(local - clip.start, 0), clipLength(clip));
  return clipStarts(clips)[index] + offset;
}

/** What the timeline as a whole looks like, as far as the rest of the app asks: its length,
 *  the first clip's frame, which the export fits every other clip into, and the most audio
 *  tracks any clip has, since a clip without one of them plays silence there. */
export function timelineMedia(clips: Clip[]): MediaInfo | null {
  if (clips.length === 0) return null;
  if (isPlain(clips)) return clips[0].media;
  const first = clips[0].media;
  const richest = clips.reduce(
    (best, clip) => (clip.media.audioTracks.length > best.audioTracks.length ? clip.media : best),
    first,
  );
  const sizeBytes = clips.reduce((sum, clip) => {
    const share = clip.media.duration > 0 ? clipLength(clip) / clip.media.duration : 0;
    return sum + clip.media.sizeBytes * share;
  }, 0);
  return {
    ...first,
    duration: totalDuration(clips),
    hasAudio: clips.some((clip) => clip.media.hasAudio),
    audioCodec: richest.audioCodec,
    audioTracks: richest.audioTracks,
    sizeBytes: Math.round(sizeBytes),
  };
}

export function toPieces(clips: Clip[]): ClipPiece[] {
  return clips.map((clip) => ({ path: clip.media.path, start: clip.start, end: clip.end }));
}

/** Names the timeline, so anything cached against it (loudness, the audio preview, the
 *  filmstrip) can tell when it changed. One file played whole is named by its path. */
export function timelineKey(clips: Clip[]): string {
  if (clips.length === 0) return '';
  if (isPlain(clips)) return clips[0].media.path;
  return JSON.stringify(toPieces(clips));
}

export function nextClipId(clips: Clip[]): number {
  return clips.reduce((max, clip) => Math.max(max, clip.id), 0) + 1;
}

export function wholeClip(media: MediaInfo, id: number): Clip {
  return { id, media, start: 0, end: media.duration };
}

/** Cuts the clip under `t` in two. Null when `t` is too close to an edge to leave a usable
 *  clip either side. */
export function splitAt(clips: Clip[], t: number): Clip[] | null {
  if (clips.length >= MAX_CLIPS) return null;
  const hit = locate(clips, t);
  if (!hit) return null;
  const clip = clips[hit.index];
  if (hit.local - clip.start < MIN_CLIP_SECONDS || clip.end - hit.local < MIN_CLIP_SECONDS) return null;
  const id = nextClipId(clips);
  const head: Clip = { ...clip, end: hit.local };
  const tail: Clip = { ...clip, id, start: hit.local };
  return [...clips.slice(0, hit.index), head, tail, ...clips.slice(hit.index + 1)];
}

export function moveClip(clips: Clip[], from: number, to: number): Clip[] | null {
  if (from === to || from < 0 || to < 0 || from >= clips.length || to >= clips.length) return null;
  const next = [...clips];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function removeClip(clips: Clip[], index: number): Clip[] | null {
  if (clips.length <= 1 || index < 0 || index >= clips.length) return null;
  return clips.filter((_, i) => i !== index);
}

export function appendClips(clips: Clip[], media: MediaInfo[]): Clip[] {
  const room = Math.max(0, MAX_CLIPS - clips.length);
  let id = nextClipId(clips);
  return [...clips, ...media.slice(0, room).map((m) => wholeClip(m, id++))];
}

/**
 * Where a moment of footage sits after the clips changed: found by its file and its time in
 * that file, so a keyframe moves with the picture it was set on. Null when that footage is no
 * longer on the timeline.
 */
export function remapTime(before: Clip[], after: Clip[], t: number, atEnd = false): number | null {
  const hit = locate(before, t, atEnd);
  if (!hit) return null;
  const source = before[hit.index];
  const local = hit.local;
  const contains = (clip: Clip) => clip.media.path === source.media.path
    && local >= clip.start - CLIP_EPSILON && local <= clip.end + CLIP_EPSILON;
  // On a shared edge the earlier clip owns an end and the later one owns a start.
  const strictly = (clip: Clip) => (atEnd ? local > clip.start + CLIP_EPSILON : local < clip.end - CLIP_EPSILON);
  const candidates = after.map((clip, index) => ({ clip, index })).filter(({ clip }) => contains(clip));
  if (candidates.length === 0) return null;
  // The same file can be on the timeline more than once, so the clip itself is followed: by
  // its id, or after a split by the new clip its tail became.
  const known = new Set(before.map((clip) => clip.id));
  const ranked = [
    ...candidates.filter(({ clip }) => clip.id === source.id),
    ...candidates.filter(({ clip }) => !known.has(clip.id)),
    ...candidates,
  ];
  const { index } = ranked.find(({ clip }) => strictly(clip)) ?? ranked[0];
  return timelineTime(after, index, local);
}

type Timed = { t: number };

function remapKeys<T extends Timed>(before: Clip[], after: Clip[], keys: T[]): T[] {
  const moved: T[] = [];
  for (const key of keys) {
    const t = remapTime(before, after, key.t);
    if (t !== null) moved.push({ ...key, t });
  }
  return moved.sort((a, b) => a.t - b.t);
}

function remapEffects(before: Clip[], after: Clip[], effects: EffectsState): EffectsState {
  const settings = { ...effects.settings } as Record<string, unknown>;
  let changed = false;
  for (const [id, value] of Object.entries(effects.settings)) {
    const setting = value as { keys?: Timed[]; items?: { keys: Timed[]; on: boolean }[] };
    if (Array.isArray(setting.keys) && setting.keys.length > 0) {
      settings[id] = { ...setting, keys: remapKeys(before, after, setting.keys) };
      changed = true;
    }
    if (Array.isArray(setting.items) && setting.items.some((item) => item.keys.length > 0)) {
      changed = true;
      settings[id] = {
        ...setting,
        items: setting.items.map((item) => {
          if (item.keys.length === 0) return item;
          const keys = remapKeys(before, after, item.keys);
          // Every keyframe was on footage that is gone, and so was what it hid.
          return keys.length === 0 ? { ...item, keys, on: false } : { ...item, keys };
        }),
      };
    }
  }
  if (!changed) return effects;
  return { ...effects, settings: settings as unknown as EffectsState['settings'] };
}

/** The edit fields that live on the timeline, carried over to a new clip order. */
export function remapEdit(
  state: Pick<EditState, 'clips' | 'inPoint' | 'outPoint' | 'ramp' | 'effects'>,
  after: Clip[],
): Pick<EditState, 'inPoint' | 'outPoint' | 'ramp' | 'effects'> {
  const before = state.clips;
  const oldTotal = totalDuration(before);
  const newTotal = totalDuration(after);
  const whole = state.inPoint <= CLIP_EPSILON && state.outPoint >= oldTotal - CLIP_EPSILON;
  let inPoint = 0;
  let outPoint = newTotal;
  if (!whole) {
    const mappedIn = remapTime(before, after, state.inPoint) ?? 0;
    const mappedOut = remapTime(before, after, state.outPoint, true) ?? newTotal;
    // A reorder can carry the out point ahead of the in point; the whole timeline is the
    // only range that still means something then.
    if (mappedOut - mappedIn > MIN_CLIP_SECONDS / 2) {
      inPoint = mappedIn;
      outPoint = mappedOut;
    }
  }
  return {
    inPoint,
    outPoint,
    ramp: state.ramp.length > 0 ? remapKeys(before, after, state.ramp) : state.ramp,
    effects: remapEffects(before, after, state.effects),
  };
}

export function fileName(path: string): string {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return cut >= 0 ? path.slice(cut + 1) : path;
}

/** Natural order, so "Replay 2" comes before "Replay 10". */
export function byFileName(a: string, b: string): number {
  return fileName(a).localeCompare(fileName(b), undefined, { numeric: true, sensitivity: 'base' });
}
