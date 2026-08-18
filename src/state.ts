// Playhead position is deliberately not here: it changes every presented frame and would
// re-render the control row with it. player.ts owns it.

import { forgetLoudness } from './loudness';
import {
  AUDIO_FORMATS,
  DEFAULT_SETTINGS,
  defaultFormatFor,
  type AppSettings,
  type EditState,
  type ExportFormat,
  type MediaInfo,
  type OutputHeight,
  type QualityPreset,
} from './types';

export interface UiState {
  ffmpegAvailable: boolean;
  playing: boolean;
  cropping: boolean;
  exporting: boolean;
  exportPercent: number;
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
  normalize: false,
  volume: 1,
  format: 'mp4',
  audioOnly: false,
  targetMb: rememberedTargetMb() ?? settings.defaultTargetMb,
  quality: rememberedQuality() ?? settings.defaultQuality,
  outputHeight: settings.defaultOutputHeight,
  videoKbps: null,
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
  // A copy, so a listener that unsubscribes itself mid-call cannot skip the one after it.
  for (const listener of [...listeners]) listener();
}

export function patchEdit(patch: Partial<EditState>): void {
  Object.assign(edit, patch);
  notify();
}

// Separate from patchEdit: the app demotes quality itself when a format cannot hit a size
// target, and persisting that would erase a remembered 'fit'.
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

export function setSettings(next: AppSettings): void {
  Object.assign(settings, next);
  if (rememberedQuality() === null) edit.quality = settings.defaultQuality;
  if (rememberedTargetMb() === null) edit.targetMb = settings.defaultTargetMb;
  if (!settings.showFilmstrip) dropFilmstrip();
  notify();
}

// Only when there is something to drop: timeline.ts compares array identity.
function dropFilmstrip(): void {
  if (ui.filmstrip.length > 0) ui.filmstrip = [];
}

// A new file starts from the saved settings, except where the user changed quality or fit
// size by hand this session.
export function loadMedia(media: MediaInfo, src: string): void {
  forgetLoudness();
  let format: ExportFormat =
    settings.defaultFormat === 'source' ? defaultFormatFor(media.path) : settings.defaultFormat;
  let audioOnly = (AUDIO_FORMATS as string[]).includes(format);
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
    normalize: false,
    volume: 1,
    format,
    audioOnly,
    quality: rememberedQuality() ?? settings.defaultQuality,
    targetMb: rememberedTargetMb() ?? settings.defaultTargetMb,
    outputHeight: seedOutputHeight(media),
    videoKbps: null,
    lossless: false,
  } satisfies Partial<EditState>);
  Object.assign(ui, {
    playing: false,
    cropping: false,
    filmstrip: [],
  } satisfies Partial<UiState>);
  notify();
}

function seedOutputHeight(media: MediaInfo): OutputHeight {
  const wanted = settings.defaultOutputHeight;
  if (wanted === null) return null;
  return wanted > Math.min(media.width, media.height) ? null : wanted;
}

export function refresh(): void {
  notify();
}
