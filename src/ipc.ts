/**
 * The one module allowed to touch @tauri-apps/*. Everything else imports from
 * here, so a changed command signature has exactly one place to follow.
 */

import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebview, type DragDropEvent } from '@tauri-apps/api/webview';
import { open as openFileDialog, save as saveFileDialog } from '@tauri-apps/plugin-dialog';

import {
  EVENT,
  type AlphaBuild,
  type AppSettings,
  type ExportJob,
  type ExportProgress,
  type FfmpegStatus,
  type MediaInfo,
  type ReleaseInfo,
  type UpdateChannel,
  type UpdateInfo,
} from './types';

/** Dialog convenience only - probe() decides what is actually playable. */
export const VIDEO_EXTENSIONS: string[] = [
  'mp4',
  'mov',
  'mkv',
  'webm',
  'avi',
  'm4v',
  'wmv',
  'flv',
  'mpg',
  'mpeg',
  'ts',
  'm2ts',
  'mts',
  '3gp',
  'ogv',
];

export function ffmpegStatus(): Promise<FfmpegStatus> {
  return invoke<FfmpegStatus>('ffmpeg_status');
}

/** The diagnostic the last negative ffmpegStatus() wrote; null if there is none. */
export function ffmpegCheckLog(): Promise<string | null> {
  return invoke<string | null>('ffmpeg_check_log');
}

/** Also adds the path to the asset-protocol scope; assetUrl() 403s without it. */
export function probe(path: string): Promise<MediaInfo> {
  return invoke<MediaInfo>('probe', { path });
}

export function detectEncoder(): Promise<string> {
  return invoke<string>('detect_encoder');
}

/** Returns once ffmpeg is spawned; watch the export events for the rest. */
export function startExport(job: ExportJob): Promise<void> {
  return invoke<void>('start_export', { job });
}

export function cancelExport(): Promise<void> {
  return invoke<void>('cancel_export');
}

/**
 * Projected size in bytes of the clip the same job would export. The frame size
 * and rate are passed in from the MediaInfo the caller already holds, so a
 * slider drag costs no probe. 0 means the Rust side could not say.
 */
export function estimateExportSize(job: ExportJob, media: MediaInfo): Promise<number> {
  return invoke<number>('estimate_export_size', {
    job,
    width: media.width,
    height: media.height,
    fps: media.fps,
    hasAudio: media.hasAudio,
  });
}

export function makeFilmstrip(path: string, count: number, height: number): Promise<string[]> {
  return invoke<string[]>('make_filmstrip', { path, count, height });
}

/** Returns a disk path, which the caller still runs through assetUrl(). */
export function makePreviewProxy(path: string): Promise<string> {
  return invoke<string>('make_preview_proxy', { path });
}

export function copyFileToClipboard(path: string): Promise<void> {
  return invoke<void>('copy_file_to_clipboard', { path });
}

export function revealInExplorer(path: string): Promise<void> {
  return invoke<void>('reveal_in_explorer', { path });
}

export function appVersion(): Promise<string> {
  return invoke<string>('app_version');
}

export function installFfmpeg(): Promise<void> {
  return invoke<void>('install_ffmpeg');
}

export function checkForUpdate(): Promise<UpdateInfo | null> {
  return invoke<UpdateInfo | null>('check_for_update');
}

export function applyUpdate(info: UpdateInfo): Promise<void> {
  return invoke<void>('apply_update', { info });
}

export function getSettings(): Promise<AppSettings> {
  return invoke<AppSettings>('get_settings');
}

export function saveSettings(settings: AppSettings): Promise<void> {
  return invoke<void>('save_settings', { settings });
}

export function listReleases(channel: UpdateChannel): Promise<ReleaseInfo[]> {
  return invoke<ReleaseInfo[]>('list_releases', { channel });
}

/** Like applyUpdate, this does not return when it succeeds - the app exits. */
export function installRelease(info: ReleaseInfo): Promise<void> {
  return invoke<void>('install_release', { info });
}

/**
 * Branch builds, not releases: listReleases('alpha') is rejected on purpose.
 * currentSha comes from the caller because only the frontend can read
 * build-info.json; without it no row can be marked as the running build.
 */
export function listAlphaBuilds(
  refresh: boolean,
  currentSha: string | null,
): Promise<AlphaBuild[]> {
  return invoke<AlphaBuild[]>('list_alpha_builds', { refresh, currentSha });
}

/** Like installRelease, this does not return when it succeeds - the app exits. */
export function installAlphaBuild(build: AlphaBuild): Promise<void> {
  return invoke<void>('install_alpha_build', { build });
}

/** argv[1] from a double-click or "Open with"; null keeps drop and dialog working. */
export async function launchFilePath(): Promise<string | null> {
  try {
    return await invoke<string | null>('cli_file_path');
  } catch {
    return null;
  }
}

export function onExportProgress(cb: (p: ExportProgress) => void): Promise<UnlistenFn> {
  return listen<ExportProgress>(EVENT.exportProgress, (e) => cb(e.payload));
}

export function onExportDone(cb: (outputPath: string) => void): Promise<UnlistenFn> {
  return listen<string>(EVENT.exportDone, (e) => cb(e.payload));
}

export function onExportError(cb: (message: string) => void): Promise<UnlistenFn> {
  return listen<string>(EVENT.exportError, (e) => cb(e.payload));
}

export function onUpdateProgress(cb: (fraction: number) => void): Promise<UnlistenFn> {
  return listen<number>(EVENT.updateProgress, (e) => cb(e.payload));
}

// No post-startup file handover: a second "Open with" opens a second window.
// Catching it needs the single-instance plugin, which the app does not take.

/** Tauri swallows OS drops at the window level, so HTML5 drop never fires. */
export function onDragDrop(handler: (event: DragDropEvent) => void): Promise<UnlistenFn> {
  return getCurrentWebview().onDragDropEvent((e) => handler(e.payload));
}

export function assetUrl(path: string): string {
  return convertFileSrc(path);
}

export async function pickVideo(): Promise<string | null> {
  const picked = await openFileDialog({
    multiple: false,
    directory: false,
    title: 'Open video',
    filters: [
      { name: 'Video', extensions: VIDEO_EXTENSIONS },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return typeof picked === 'string' ? picked : null;
}

/** Filter derived from defaultPath's extension so the two cannot disagree. */
export async function pickExportTarget(defaultPath: string): Promise<string | null> {
  const dot = defaultPath.lastIndexOf('.');
  const ext = dot >= 0 ? defaultPath.slice(dot + 1).toLowerCase() : 'mp4';
  return await saveFileDialog({
    title: 'Export clip',
    defaultPath,
    filters: [{ name: `${ext.toUpperCase()} file`, extensions: [ext] }],
  });
}
