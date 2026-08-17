/**
 * The contract between the web UI and the Rust side.
 *
 * Every field here is serialised across the IPC boundary, so the Rust structs
 * in src-tauri/src/ carry `#[serde(rename_all = "camelCase")]` to match these
 * names exactly. Changing a name here means changing it there in the same
 * commit.
 */

/** A rectangle in *source* pixels, in display orientation. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * What ffprobe could tell us about a file.
 *
 * `width`/`height` are display dimensions: a phone video shot upright reports
 * 1080x1920 here even though the stream is stored 1920x1080 with a rotation
 * flag. Both the browser and ffmpeg apply that rotation on decode, so keeping
 * one orientation throughout is what lets crop coordinates pass straight from
 * the overlay to the ffmpeg command without a conversion step.
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

/** Export quality choices, as shown in the one dropdown the UI has. */
export type QualityPreset = 'high' | 'balanced' | 'small' | 'fit10' | 'fit25';

/** Everything the Rust side needs to build one ffmpeg command. */
export interface ExportJob {
  input: string;
  output: string;
  inPoint: number;
  outPoint: number;
  /** 0.25 - 4. 1 means untouched. */
  speed: number;
  crop: Rect | null;
  mute: boolean;
  quality: QualityPreset;
  /** Stream-copy instead of re-encoding. Only valid when trim is the only edit. */
  lossless: boolean;
}

/** The whole editor state. One object, no framework. */
export interface EditState {
  media: MediaInfo | null;
  /** Preview source URL (asset protocol, or a proxy when the codec won't play). */
  src: string | null;
  inPoint: number;
  outPoint: number;
  speed: number;
  crop: Rect | null;
  mute: boolean;
  quality: QualityPreset;
  lossless: boolean;
}

export interface FfmpegStatus {
  available: boolean;
  version: string | null;
}

export interface ExportProgress {
  /** 0 - 1, derived from ffmpeg's out_time against the known output duration. */
  percent: number;
  speed: number | null;
  etaSeconds: number | null;
}

export interface UpdateInfo {
  version: string;
  /** Browser URL of the release page, for the "what's new" link. */
  releaseUrl: string;
  downloadUrl: string;
  assetName: string;
  sizeBytes: number;
  prerelease: boolean;
}

/** Tauri event names. Listed here so both sides spell them the same way. */
export const EVENT = {
  exportProgress: 'export-progress',
  exportDone: 'export-done',
  exportError: 'export-error',
  updateProgress: 'update-progress',
} as const;

/** The duration of the exported clip, which speed changes. */
export function outputDuration(state: EditState): number {
  return Math.max(0, (state.outPoint - state.inPoint) / state.speed);
}

/** True when trimming is the only thing being asked for. */
export function isTrimOnly(state: EditState): boolean {
  return state.speed === 1 && state.crop === null && !state.mute;
}
