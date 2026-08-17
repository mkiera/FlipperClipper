/**
 * The whole application state, in two plain objects with a subscribe/notify list
 * around them. No reactivity layer: a module subscribes, reads what it cares
 * about and rewrites its own corner of the DOM.
 *
 * Playhead position is deliberately NOT here - it changes every presented frame
 * and would re-render the control row 60 times a second. player.ts owns it.
 */

import { defaultFormatFor, type EditState, type MediaInfo, type QualityPreset } from './types';

/** Things the user can see that are not part of the edit. */
export interface UiState {
  ffmpegAvailable: boolean;
  playing: boolean;
  cropping: boolean;
  exporting: boolean;
  /** 0 - 1, mirrored from the export-progress event. */
  exportPercent: number;
  /** Thumbnail data URIs; empty until the filmstrip command returns. */
  filmstrip: string[];
}

const QUALITY_KEY = 'flipperclipper.quality';
const TARGET_MB_KEY = 'flipperclipper.targetMb';
const QUALITIES: QualityPreset[] = ['high', 'balanced', 'small', 'fit'];

function storedQuality(): QualityPreset {
  const raw = localStorage.getItem(QUALITY_KEY);
  const match = QUALITIES.find((q) => q === raw);
  return match ?? 'balanced';
}

function storedTargetMb(): number {
  const raw = Number(localStorage.getItem(TARGET_MB_KEY));
  return Number.isFinite(raw) && raw >= 0.5 && raw <= 10_000 ? raw : 10;
}

export const edit: EditState = {
  media: null,
  src: null,
  inPoint: 0,
  outPoint: 0,
  speed: 1,
  crop: null,
  mute: false,
  reverse: false,
  volume: 1,
  format: 'mp4',
  audioOnly: false,
  targetMb: storedTargetMb(),
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
  // A copy, so a listener that unsubscribes itself mid-call (the toast does)
  // cannot skip the one after it.
  for (const listener of [...listeners]) listener();
}

export function patchEdit(patch: Partial<EditState>): void {
  Object.assign(edit, patch);
  notify();
}

// Separate from patchEdit: the app demotes quality itself when a format cannot
// hit a size target, and persisting that would erase a remembered 'fit' the
// moment a .gif is opened. Only the two control handlers call these.
export function rememberQuality(quality: QualityPreset): void {
  localStorage.setItem(QUALITY_KEY, quality);
}

export function rememberTargetMb(targetMb: number): void {
  localStorage.setItem(TARGET_MB_KEY, String(targetMb));
}

export function patchUi(patch: Partial<UiState>): void {
  Object.assign(ui, patch);
  notify();
}

/**
 * Quality and fit size survive a new file; the format does not - it follows the
 * new file's extension, so a remembered webm cannot silently re-encode every
 * mp4 opened after it.
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
    reverse: false,
    volume: 1,
    format: defaultFormatFor(media.path),
    audioOnly: false,
    lossless: false,
  } satisfies Partial<EditState>);
  Object.assign(ui, {
    playing: false,
    cropping: false,
    filmstrip: [],
  } satisfies Partial<UiState>);
  notify();
}

/** Redraw without changing anything, e.g. after a window resize. */
export function refresh(): void {
  notify();
}
