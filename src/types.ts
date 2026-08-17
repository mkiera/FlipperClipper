/**
 * The contract between the web UI and the Rust side. Every field crosses the
 * IPC boundary, so the Rust structs carry #[serde(rename_all = "camelCase")] to
 * match these names - rename in both places or not at all.
 */

/** A rectangle in source pixels, in display orientation. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * What ffprobe could tell us. width/height are DISPLAY dimensions - an upright
 * phone video reports 1080x1920 though it is stored 1920x1080 with a rotation
 * flag. Browser and ffmpeg both rotate on decode, so crop coordinates pass
 * straight through with no conversion.
 */
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

/** In dropdown order; also used to validate a stored value. */
export const VIDEO_FORMATS: VideoFormat[] = ['mp4', 'mkv', 'mov', 'webm', 'gif'];
export const AUDIO_FORMATS: AudioFormat[] = ['mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus'];

/** 'fit' pairs with a typed size in EditState.targetMb. */
export type QualityPreset = 'high' | 'balanced' | 'small' | 'fit';

/** Everything the Rust side needs to build one ffmpeg command. */
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
  /** 0 - 2. Above 1 is a boost the preview cannot show. */
  volume: number;
  format: ExportFormat;
  quality: QualityPreset;
  /** Decimal megabytes; only read when quality is 'fit'. */
  targetMb: number | null;
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
  /** 0 - 2, 1 = unchanged. */
  volume: number;
  format: ExportFormat;
  /** UI only: swaps the format dropdown to AudioFormats. Not sent to Rust. */
  audioOnly: boolean;
  targetMb: number;
  quality: QualityPreset;
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
  showFilmstrip: true,
  encoder: 'auto',
  autoPreviewProxy: true,
};

/** One row of the release list. version carries no leading v. */
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

/** Tauri event names, so both sides spell them the same way. */
export const EVENT = {
  exportProgress: 'export-progress',
  exportDone: 'export-done',
  exportError: 'export-error',
  updateProgress: 'update-progress',
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

export function isTrimOnly(state: EditState): boolean {
  return (
    state.speed === 1 &&
    state.crop === null &&
    !state.mute &&
    !state.reverse &&
    state.volume === 1
  );
}

/**
 * A stream copy cannot change codecs, so the container must be the one the file
 * arrived in - mkv excepted, since it holds anything. gif never qualifies: the
 * palette pass is a re-encode even from a gif source.
 */
export function losslessEligible(state: EditState): boolean {
  if (!isTrimOnly(state) || state.audioOnly || state.format === 'gif') return false;
  if (state.media === null) return false;
  return state.format === defaultFormatFor(state.media.path) || state.format === 'mkv';
}
