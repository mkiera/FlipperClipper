/**
 * The one module that is allowed to touch @tauri-apps/*.
 *
 * Everything else imports from here, so when a command signature changes on the
 * Rust side there is exactly one place in the UI that has to follow, and the
 * rest of the code stays plain TypeScript that reads like DOM work.
 */

import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWebview, type DragDropEvent } from '@tauri-apps/api/webview';
import { open as openFileDialog, save as saveFileDialog } from '@tauri-apps/plugin-dialog';

import {
  EVENT,
  type ExportJob,
  type ExportProgress,
  type FfmpegStatus,
  type MediaInfo,
  type UpdateInfo,
} from './types';

/**
 * Extensions offered in the open dialog. This is a convenience filter, not a
 * guard: the dialog always keeps an "All files" entry and probe() is the real
 * arbiter of whether something is playable, so a container missing from this
 * list costs the user one extra click rather than blocking them.
 */
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

/* --------------------------------------------------------------------------
 * Commands
 * ----------------------------------------------------------------------- */

export function ffmpegStatus(): Promise<FfmpegStatus> {
  return invoke<FfmpegStatus>('ffmpeg_status');
}

/**
 * Reads the file's metadata and, as a side effect on the Rust side, adds the
 * path to the asset-protocol scope. Nothing may call assetUrl() for a path that
 * has not been through here first, or the <video> element gets a 403.
 */
export function probe(path: string): Promise<MediaInfo> {
  return invoke<MediaInfo>('probe', { path });
}

export function detectEncoder(): Promise<string> {
  return invoke<string>('detect_encoder');
}

/** Returns as soon as ffmpeg is spawned; watch the export events for the rest. */
export function startExport(job: ExportJob): Promise<void> {
  return invoke<void>('start_export', { job });
}

export function cancelExport(): Promise<void> {
  return invoke<void>('cancel_export');
}

/** Thumbnails as `data:` URIs, ready to drop straight into an <img src>. */
export function makeFilmstrip(path: string, count: number, height: number): Promise<string[]> {
  return invoke<string[]>('make_filmstrip', { path, count, height });
}

/** Returns a file path on disk, which the caller still has to run through assetUrl(). */
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

/**
 * The file path the app was launched with, if any.
 *
 * Windows hands a double-clicked or "Open with" file to the exe as argv[1], and
 * the Rust side is the only half that can see it. This resolves to null rather
 * than throwing when the command is absent so that opening by drop and dialog
 * keeps working even if the launch-argument path is not wired up.
 */
export async function launchFilePath(): Promise<string | null> {
  try {
    return await invoke<string | null>('cli_file_path');
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------------------
 * Events
 * ----------------------------------------------------------------------- */

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

// There is deliberately no listener for a file handed over after startup - a
// second "Open with" on a running QuickClip opens a second window instead of
// reaching this one. Catching that needs the single-instance plugin, which the
// app does not take, and a listener for an event nobody emits would only look
// like the case was handled.

/* --------------------------------------------------------------------------
 * Shell surfaces
 * ----------------------------------------------------------------------- */

/**
 * Tauri swallows OS drops at the window level, so the HTML5 drop event never
 * reaches the document and a plain dragover/drop pair silently does nothing.
 * This webview-level stream is the only way to see a dropped path.
 */
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

export async function pickExportTarget(defaultPath: string): Promise<string | null> {
  return await saveFileDialog({
    title: 'Export clip',
    defaultPath,
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
  });
}
