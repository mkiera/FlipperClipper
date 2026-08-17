/**
 * The whole application state, in two plain objects with a subscribe/notify
 * list around them.
 *
 * There is deliberately no reactivity layer. A module subscribes, reads the
 * fields it cares about and rewrites its own corner of the DOM; that costs a
 * few redundant attribute writes per change and buys a call stack you can read
 * top to bottom when a value ends up wrong.
 *
 * Playhead position is the one thing that is NOT kept here. It changes on every
 * presented frame, and routing it through this notifier would re-render the
 * control row and the timeline sixty times a second. player.ts owns it and
 * hands it out on its own channel.
 */

import type { EditState, MediaInfo, QualityPreset } from './types';

/** Transient things the user can see but that are not part of the edit. */
export interface UiState {
  /** False puts the install banner up and disables Export. */
  ffmpegAvailable: boolean;
  playing: boolean;
  cropping: boolean;
  exporting: boolean;
  /** 0 - 1, mirrored from the export-progress event. */
  exportPercent: number;
  /** Thumbnail data URIs; empty until the filmstrip command comes back. */
  filmstrip: string[];
}

const QUALITY_KEY = 'quickclip.quality';
const QUALITIES: QualityPreset[] = ['high', 'balanced', 'small', 'fit10', 'fit25'];

function storedQuality(): QualityPreset {
  const raw = localStorage.getItem(QUALITY_KEY);
  const match = QUALITIES.find((q) => q === raw);
  return match ?? 'balanced';
}

export const edit: EditState = {
  media: null,
  src: null,
  inPoint: 0,
  outPoint: 0,
  speed: 1,
  crop: null,
  mute: false,
  quality: storedQuality(),
  lossless: false,
};

export const ui: UiState = {
  ffmpegAvailable: true,
  playing: false,
  cropping: false,
  exporting: false,
  exportPercent: 0,
  filmstrip: [],
};

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  // Iterating a copy so that a listener which unsubscribes itself while being
  // called (the toast does exactly that) cannot skip the listener after it.
  for (const listener of [...listeners]) listener();
}

export function patchEdit(patch: Partial<EditState>): void {
  Object.assign(edit, patch);
  if (patch.quality !== undefined) localStorage.setItem(QUALITY_KEY, patch.quality);
  notify();
}

export function patchUi(patch: Partial<UiState>): void {
  Object.assign(ui, patch);
  notify();
}

/**
 * Swaps in a freshly opened file. Every edit resets except the quality choice,
 * which is the only preference the app remembers at all - opening a second clip
 * to send to the same person should not make you re-pick "Fit 10 MB".
 */
export function loadMedia(media: MediaInfo, src: string): void {
  Object.assign(edit, {
    media,
    src,
    inPoint: 0,
    outPoint: media.duration,
    speed: 1,
    crop: null,
    mute: false,
    lossless: false,
  } satisfies Partial<EditState>);
  Object.assign(ui, {
    playing: false,
    cropping: false,
    filmstrip: [],
  } satisfies Partial<UiState>);
  notify();
}

/** Redraw everything without changing anything, e.g. after a window resize. */
export function refresh(): void {
  notify();
}
