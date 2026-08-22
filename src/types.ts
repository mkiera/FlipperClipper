import { hasRamp, rampedDuration } from './ramp';

// The IPC contract. The Rust structs carry #[serde(rename_all = "camelCase")] to match these
// names - rename in both places or not at all.

/** A rectangle in source pixels, in display orientation. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** width/height are DISPLAY dimensions: an upright phone video reports 1080x1920. */
export interface MediaInfo {
  path: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  rotation: number;
  hasAudio: boolean;
  videoCodec: string;
  audioCodec: string | null;
  sizeBytes: number;
}

export type VideoFormat = 'mp4' | 'mkv' | 'mov' | 'webm' | 'gif';
export type AudioFormat = 'mp3' | 'm4a' | 'wav' | 'flac' | 'ogg' | 'opus';
export type ExportFormat = VideoFormat | AudioFormat;

export const VIDEO_FORMATS: VideoFormat[] = ['mp4', 'mkv', 'mov', 'webm', 'gif'];
export const AUDIO_FORMATS: AudioFormat[] = ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus'];

/** 'fit' pairs with a typed size in EditState.targetMb. */
export type QualityPreset = 'high' | 'balanced' | 'small' | 'fit';

/** null = follow the source. Otherwise the clip's SMALLER dimension, the way "1080p" names it. */
export type OutputHeight = number | null;

export interface Rendition {
  height: OutputHeight;
  /** null = let quality decide (CRF/CQ). Otherwise an explicit rate. */
  videoKbps: number | null;
}

export const OUTPUT_HEIGHTS: number[] = [2160, 1440, 1080, 720, 480, 360];

/** The range the volume input and the Rust validator agree on, as a multiplier. */
export const VOLUME_MAX = 10;

/** The range the kbps input and the Rust validator agree on. */
export const VIDEO_KBPS_MIN = 50;
export const VIDEO_KBPS_MAX = 200_000;

/** What loudnorm's analysis pass measured, and the gain it implies. */
export interface Loudness {
  /** Integrated loudness, LUFS. */
  integrated: number;
  /** True peak, dBTP. What is left of it after the gain is the clipping headroom. */
  truePeak: number;
  /** Linear multiplier that would reach the target. */
  gain: number;
}

/** Where a text overlay sits: a 3x3 grid rather than free coordinates, so it stays put
 *  whatever the frame is. */
export type TextAnchorX = 'left' | 'center' | 'right';
export type TextAnchorY = 'top' | 'middle' | 'bottom';

export interface TextOverlay {
  text: string;
  /** Fraction of the frame height, so the same setting reads the same at 1080p and 480p. */
  size: number;
  /** '#rrggbb'. */
  color: string;
  /** 0 - 1. */
  opacity: number;
  anchorX: TextAnchorX;
  anchorY: TextAnchorY;
  /** A dark plate behind the text, for footage it would otherwise disappear into. */
  boxed: boolean;
}

/** What the export applies. Null is off: a switched-off effect keeps its dial in
 *  EffectsState, and nothing here remembers it. */
export interface EffectsJob {
  /** Gaussian sigma, in source pixels. */
  blur: number | null;
  /** Linear multipliers; 1 is unchanged. */
  brightness: number | null;
  contrast: number | null;
  saturation: number | null;
  /** Degrees, -180 to 180. */
  hue: number | null;
  /** 0 - 1. */
  vignette: number | null;
  /** Seconds, measured on the exported timeline - after the trim and the speed change. */
  fadeIn: number | null;
  fadeOut: number | null;
  text: TextOverlay | null;
}

/** The dials themselves, kept whether or not the effect is switched on. */
export interface EffectSettings {
  blur: { sigma: number };
  brightness: { amount: number };
  contrast: { amount: number };
  saturation: { amount: number };
  hue: { degrees: number };
  vignette: { amount: number };
  fade: { inSeconds: number; outSeconds: number };
  text: TextOverlay;
}

export type EffectId = keyof EffectSettings;

/** Switches live apart from settings, which is the whole point: turning an effect off has to
 *  leave its dials where the user put them. */
export interface EffectsState {
  on: Record<EffectId, boolean>;
  settings: EffectSettings;
}

/** One point on the speed curve: a multiplier on the speed slider, at a moment on the source
 *  timeline. Between two points the multiplier moves linearly, and outside them it holds. */
/** Quarter turns clockwise, as the frame is shown. A file's own rotation tag is already
 *  applied by ffmpeg and by parse_probe, so this is what the user asked for on top of it. */
export type Rotation = 0 | 90 | 180 | 270;

/** How the frame is turned before anything else happens to it. */
export interface Orientation {
  rotate: Rotation;
  /** Mirrored left to right, applied after the turn. */
  flipH: boolean;
  flipV: boolean;
}

export const NO_ORIENTATION: Orientation = { rotate: 0, flipH: false, flipV: false };

export function isTurned(orientation: Orientation): boolean {
  return orientation.rotate === 90 || orientation.rotate === 270;
}

export function hasOrientation(orientation: Orientation): boolean {
  return orientation.rotate !== 0 || orientation.flipH || orientation.flipV;
}

export interface SpeedPoint {
  /** Seconds into the source, not into the trim. */
  t: number;
  /** Multiplier on `speed`. A curve of all 1s is the slider on its own. */
  speed: number;
}

export interface ExportJob {
  input: string;
  output: string;
  inPoint: number;
  outPoint: number;
  /** 0.05 - 20. 1 means untouched. */
  speed: number;
  /** The speed curve on top of `speed`, on the source timeline. Empty is a flat 1. */
  ramp: SpeedPoint[];
  /** Applied at the head of the chain, so the crop rectangle is in the turned frame. */
  orientation: Orientation;
  crop: Rect | null;
  mute: boolean;
  reverse: boolean;
  /** EBU R128 loudness normalisation. Runs before volume, which trims from the level it sets. */
  normalize: boolean;
  /** 0 - 10. Above 1 is a boost the preview cannot show. */
  volume: number;
  format: ExportFormat;
  quality: QualityPreset;
  /** Decimal megabytes; only read when quality is 'fit'. */
  targetMb: number | null;
  outputHeight: number | null;
  videoKbps: number | null;
  lossless: boolean;
  effects: EffectsJob;
}

export interface EditState {
  media: MediaInfo | null;
  /** Asset-protocol URL, or a proxy when the codec will not play. */
  src: string | null;
  inPoint: number;
  outPoint: number;
  speed: number;
  /** The speed curve on top of `speed`. Empty is a flat 1: the slider on its own. */
  ramp: SpeedPoint[];
  orientation: Orientation;
  crop: Rect | null;
  mute: boolean;
  reverse: boolean;
  normalize: boolean;
  /** 0 - 10, 1 = unchanged. */
  volume: number;
  format: ExportFormat;
  /** UI only: swaps the format dropdown to AudioFormats. Not sent to Rust. */
  audioOnly: boolean;
  targetMb: number;
  quality: QualityPreset;
  outputHeight: OutputHeight;
  /** null = automatic, i.e. the quality preset sets the rate. */
  videoKbps: number | null;
  lossless: boolean;
  effects: EffectsState;
}

/** One external tool, as the debug panel found it. */
export interface ToolReport {
  found: boolean;
  /** Where it resolved to, which is the answer when two FFmpegs are installed. */
  path: string | null;
  version: string | null;
}

export interface DebugReport {
  appVersion: string;
  tauriVersion: string;
  arch: string;
  osFamily: string;
  ffmpeg: ToolReport;
  ffprobe: ToolReport;
  /** What an export would actually encode with, hardware or software. */
  encoder: string;
  configDir: string | null;
  tempDir: string;
}

export interface DiagnosticResult {
  success: boolean;
  message: string;
  /** Whatever FFmpeg said, when it said anything. Empty on success. */
  detail: string;
  millis: number;
}

export interface FfmpegStatus {
  available: boolean;
  version: string | null;
}

/** What a failed export reports. The message goes in the toast; the detail is the tail
 *  FFmpeg printed, which the debug panel keeps for a report. */
export interface ExportFailure {
  message: string;
  detail: string;
  /** True when the part-written file was removed, so the toast can say the output is gone. */
  cleanedUp: boolean;
}

export interface ExportProgress {
  /** 0 - 1. */
  percent: number;
  speed: number | null;
  etaSeconds: number | null;
}

export interface UpdateInfo {
  version: string;
  releaseUrl: string;
  downloadUrl: string;
  assetName: string;
  sizeBytes: number;
  prerelease: boolean;
}

export type UpdateChannel = 'stable' | 'prerelease' | 'alpha';
export type EncoderPreference = 'auto' | 'software';
/** 'source' keeps the opened file's own container. */
export type DefaultFormat = ExportFormat | 'source';

export interface AppSettings {
  updateChannel: UpdateChannel;
  autoCheckUpdates: boolean;
  defaultFormat: DefaultFormat;
  defaultQuality: QualityPreset;
  defaultTargetMb: number;
  defaultOutputHeight: OutputHeight;
  showFilmstrip: boolean;
  encoder: EncoderPreference;
  autoPreviewProxy: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  updateChannel: 'stable',
  autoCheckUpdates: true,
  defaultFormat: 'source',
  defaultQuality: 'balanced',
  defaultTargetMb: 10,
  defaultOutputHeight: null,
  showFilmstrip: true,
  encoder: 'auto',
  autoPreviewProxy: true,
};

export interface ReleaseInfo {
  version: string;
  tagName: string;
  publishedAt: string | null;
  prerelease: boolean;
  releaseUrl: string;
  downloadUrl: string;
  assetName: string;
  sizeBytes: number;
}

/** One row of the alpha list: the newest successful CI build of a branch. */
export interface AlphaBuild {
  runId: number;
  branch: string;
  /** Short, 7 chars. */
  sha: string;
  runNumber: number;
  /** ISO 8601 from the API. */
  createdAt: string | null;
  artifactName: string;
  /** The nightly.link zip URL. */
  downloadUrl: string;
  /** Head sha matches build-info.json's sha for the running build. */
  isCurrent: boolean;
}

export const EVENT = {
  exportProgress: 'export-progress',
  exportDone: 'export-done',
  exportError: 'export-error',
  updateProgress: 'update-progress',
  ffmpegProgress: 'ffmpeg-progress',
} as const;

/** The finished clip's length. ramp.ts owns the integral; callers have been handing an
 *  EditState to this name since before the curve existed and need not learn a second one. */
export function outputDuration(state: EditState): number {
  return rampedDuration(state);
}

export function defaultFormatFor(inputPath: string): VideoFormat {
  const dot = inputPath.lastIndexOf('.');
  const ext = dot >= 0 ? inputPath.slice(dot + 1).toLowerCase() : '';
  switch (ext) {
    case 'mp4':
    case 'm4v':
      return 'mp4';
    case 'mov':
      return 'mov';
    case 'mkv':
      return 'mkv';
    case 'webm':
      return 'webm';
    case 'gif':
      return 'gif';
    default:
      return 'mp4';
  }
}

/** The smaller dimension of the frame after crop; null with no media. */
export function shortEdge(state: EditState): number | null {
  const width = state.crop?.w ?? state.media?.width ?? null;
  const height = state.crop?.h ?? state.media?.height ?? null;
  return width === null || height === null ? null : Math.min(width, height);
}

/** False for a height at or above the source: that one emits no scale filter. */
export function scalesDown(state: EditState): boolean {
  const edge = shortEdge(state);
  return state.outputHeight !== null && edge !== null && state.outputHeight < edge;
}

/** True when nothing in the effects tab is switched on. */
export function anyEffectOn(effects: EffectsState): boolean {
  return Object.values(effects.on).some(Boolean);
}

/** The frame's size after the turn, which is the coordinate space the crop rectangle and
 *  every crop control work in. */
export function frameWidth(state: EditState): number {
  const media = state.media;
  if (!media) return 0;
  return isTurned(state.orientation) ? media.height : media.width;
}

export function frameHeight(state: EditState): number {
  const media = state.media;
  if (!media) return 0;
  return isTurned(state.orientation) ? media.width : media.height;
}

export function isTrimOnly(state: EditState): boolean {
  return (
    state.speed === 1 &&
    !hasOrientation(state.orientation) &&
    // A curve retimes the clip, and a stream copy never reaches the filter that would do it.
    !hasRamp(state) &&
    !anyEffectOn(state.effects) &&
    state.crop === null &&
    !state.mute &&
    !state.reverse &&
    !state.normalize &&
    state.volume === 1 &&
    !scalesDown(state) &&
    state.videoKbps === null
  );
}

/** A stream copy cannot change codecs, so the container must be the one the file arrived in. */
export function losslessEligible(state: EditState): boolean {
  if (!isTrimOnly(state) || state.audioOnly || state.format === 'gif') return false;
  if (state.media === null) return false;
  return state.format === defaultFormatFor(state.media.path) || state.format === 'mkv';
}
