/**
 * The whole application state, in two plain objects with a subscribe/notify list
 * around them. No reactivity layer: a module subscribes, reads what it cares
 * about and rewrites its own corner of the DOM.
 *
 * Playhead position is deliberately NOT here - it changes every presented frame
 * and would re-render the control row 60 times a second. player.ts owns it.
 */

import {
  AUDIO_FORMATS,
  DEFAULT_SETTINGS,
  defaultFormatFor,
  type AppSettings,
  type EditState,
  type ExportFormat,
  type MediaInfo,
  type QualityPreset,
} from './types';

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

function rememberedQuality(): QualityPreset | null {
  const raw = localStorage.getItem(QUALITY_KEY);
  return QUALITIES.find((q) => q === raw) ?? null;
}

function rememberedTargetMb(): number | null {
  const raw = Number(localStorage.getItem(TARGET_MB_KEY));
  return Number.isFinite(raw) && raw >= 0.5 && raw <= 10_000 ? raw : null;
}

/** The saved settings. The settings modal owns writing them; everyone else reads. */
export const settings: AppSettings = { ...DEFAULT_SETTINGS };

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
  targetMb: rememberedTargetMb() ?? settings.defaultTargetMb,
  quality: rememberedQuality() ?? settings.defaultQuality,
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
  if (!settings.showFilmstrip) dropFilmstrip();
  notify();
}

/** Replaces the loaded settings and re-renders everything that reads them. */
export function setSettings(next: AppSettings): void {
  Object.assign(settings, next);
  if (rememberedQuality() === null) edit.quality = settings.defaultQuality;
  if (rememberedTargetMb() === null) edit.targetMb = settings.defaultTargetMb;
  if (!settings.showFilmstrip) dropFilmstrip();
  notify();
}

// Only when there is something to drop: timeline.ts skips the rebuild by
// comparing array identity, and a fresh [] every time would defeat that.
function dropFilmstrip(): void {
  if (ui.filmstrip.length > 0) ui.filmstrip = [];
}

/**
 * A new file starts from the saved settings, except where the user changed
 * quality or fit size by hand this session - that choice is remembered and wins.
 */
export function loadMedia(media: MediaInfo, src: string): void {
  let format: ExportFormat =
    settings.defaultFormat === 'source' ? defaultFormatFor(media.path) : settings.defaultFormat;
  let audioOnly = (AUDIO_FORMATS as string[]).includes(format);
  // An audio default has nothing to extract from a file with no audio track.
  if (audioOnly && !media.hasAudio) {
    format = defaultFormatFor(media.path);
    audioOnly = false;
  }

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
    format,
    audioOnly,
    quality: rememberedQuality() ?? settings.defaultQuality,
    targetMb: rememberedTargetMb() ?? settings.defaultTargetMb,
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
