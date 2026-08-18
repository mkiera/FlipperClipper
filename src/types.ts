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

export interface ExportJob {
  input: string;
  output: string;
  inPoint: number;
  outPoint: number;
  /** 0.05 - 20. 1 means untouched. */
  speed: number;
  crop: Rect | null;
  mute: boolean;
  reverse: boolean;
  /** EBU R128 loudness normalisation. Owns the gain, so volume is ignored while it is on. */
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
}

export interface EditState {
  media: MediaInfo | null;
  /** Asset-protocol URL, or a proxy when the codec will not play. */
  src: string | null;
  inPoint: number;
  outPoint: number;
  speed: number;
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
}

export interface FfmpegStatus {
  available: boolean;
  version: string | null;
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

export function outputDuration(state: EditState): number {
  return Math.max(0, (state.outPoint - state.inPoint) / state.speed);
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

export function isTrimOnly(state: EditState): boolean {
  return (
    state.speed === 1 &&
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
