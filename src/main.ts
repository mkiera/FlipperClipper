// tsconfig.json lists no "types", so import.meta.glob below is not on
// ImportMeta as far as tsc is concerned and the file will not compile without
// this line.
/// <reference types="vite/client" />

/**
 * Boot and the open flows.
 *
 * A file can arrive three ways - dropped on the window, picked in the dialog,
 * or handed to the exe as a launch argument - and all three funnel into
 * openPath() so that probing, the asset URL and the filmstrip happen once and
 * in one order.
 */

import {
  appVersion,
  assetUrl,
  detectEncoder,
  ffmpegStatus,
  launchFilePath,
  makeFilmstrip,
  makePreviewProxy,
  onDragDrop,
  pickVideo,
  probe,
} from './ipc';
import { edit, loadMedia, patchEdit, patchUi, subscribe } from './state';
import { initPlayer, loadSource, onPreviewTrouble, videoElement } from './player';
import { initTimeline } from './timeline';
import { initCrop } from './crop';
import { describe, hideBanner, initControls, showBanner, showFfmpegBanner, showToast } from './controls';
import { initShortcuts } from './shortcuts';
import { initUpdater } from './updater';

/** How many thumbnails the strip gets. Long files reuse the same budget. */
const FILMSTRIP_FRAMES = 16;
const FILMSTRIP_HEIGHT = 64;

/**
 * What scripts/build_info.mjs stamps into src/generated/build-info.json. Every
 * field is optional there - a working copy without git on PATH gets nulls -
 * so nothing here may be treated as present.
 */
interface BuildInfo {
  sha: string | null;
  branch: string | null;
  runId: number | null;
  builtAt: string | null;
}

/**
 * That file is generated on every build path but never committed, so a fresh
 * clone that runs `npm run dev` before the stamp script has none. A glob is
 * the one import form that resolves to an empty set instead of failing the
 * bundle when the file is not there.
 */
const BUILD_INFO = import.meta.glob<{ default: Partial<BuildInfo> }>(
  './generated/build-info.json',
  { eager: true },
);

let emptyState!: HTMLElement;
let dropHint!: HTMLElement;
let about!: HTMLElement;

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`QuickClip: index.html is missing #${id}`);
  return found as T;
}

function boot(): void {
  emptyState = el('empty');
  dropHint = el('drop-hint');
  about = el('about');

  // The player goes first: crop.ts measures the <video> element the moment it
  // initialises, and controls.ts reads the playback position for its first
  // render, so both need a player that already has its element.
  initPlayer(el<HTMLVideoElement>('video'));
  initTimeline();
  initCrop();
  initControls();
  initShortcuts({ openFile: () => void openViaDialog() });

  el('empty-open').addEventListener('click', () => void openViaDialog());

  onPreviewTrouble(offerPreviewProxy);
  subscribe(renderStage);
  renderStage();

  // Losing focus mid-drag (the user dropped the file on another window after
  // all) never produces a 'leave', so the hint would stay up until the next
  // drag started.
  window.addEventListener('blur', () => {
    dropHint.hidden = true;
  });

  void watchDrops();
  void checkFfmpeg();
  void warmEncoder();
  void openLaunchFile();
  void showBuildIdentity();

  initUpdater();
}

function renderStage(): void {
  const hasMedia = edit.media !== null;
  emptyState.hidden = hasMedia;
  videoElement().classList.toggle('loaded', hasMedia);
}

/* --------------------------------------------------------------------------
 * Opening
 * ----------------------------------------------------------------------- */

async function openViaDialog(): Promise<void> {
  const picked = await pickVideo();
  if (picked) await openPath(picked);
}

async function openPath(path: string): Promise<void> {
  try {
    // probe() is also what puts the path into the asset-protocol scope, so the
    // URL is only safe to build once this has resolved.
    const media = await probe(path);
    const src = assetUrl(path);
    hideBanner('preview');
    loadMedia(media, src);
    loadSource(src);
    void loadFilmstrip(path);
  } catch (error) {
    showToast(describe(error), [], true);
  }
}

async function openLaunchFile(): Promise<void> {
  const path = await launchFilePath();
  if (path) await openPath(path);
}

/**
 * The strip is deliberately fire-and-forget: it is decoration over a timeline
 * that already works, so a slow or failed ffmpeg run must not surface as an
 * error the user has to dismiss before trimming.
 */
async function loadFilmstrip(path: string): Promise<void> {
  try {
    const frames = await makeFilmstrip(path, FILMSTRIP_FRAMES, FILMSTRIP_HEIGHT);
    if (edit.media?.path === path) patchUi({ filmstrip: frames });
  } catch {
    /* no thumbnails, no problem */
  }
}

async function watchDrops(): Promise<void> {
  await onDragDrop((event) => {
    if (event.type === 'enter' || event.type === 'over') {
      dropHint.hidden = false;
      return;
    }

    dropHint.hidden = true;
    if (event.type === 'drop' && event.paths.length > 0) void openPath(event.paths[0]);
  });
}

/* --------------------------------------------------------------------------
 * Startup checks
 * ----------------------------------------------------------------------- */

async function checkFfmpeg(): Promise<void> {
  try {
    const status = await ffmpegStatus();
    patchUi({ ffmpegAvailable: status.available });
    if (!status.available) showFfmpegBanner(() => void warmEncoder());
  } catch (error) {
    patchUi({ ffmpegAvailable: false });
    showToast(describe(error), [], true);
  }
}

/**
 * The version in the corner of the empty state, with the commit and build date
 * in its tooltip.
 *
 * package.json says the same version for every build off a branch, so "which
 * build of 0.1.0 is this?" can only be answered by the commit, and that is the
 * first question when two people are running different test artifacts. The
 * line stays hidden when nothing can be said - a clone that never ran the
 * stamp script, or a checkout-less build where git left the fields null -
 * because a version with no story behind it is not worth a line of chrome, and
 * none of this is a failure the user could act on.
 */
async function showBuildIdentity(): Promise<void> {
  let version: string;
  try {
    version = await appVersion();
  } catch {
    return;
  }

  const info = Object.values(BUILD_INFO)[0]?.default ?? {};
  const details = [
    info.sha ? `commit ${info.sha.slice(0, 7)}` : null,
    info.builtAt ? `built ${info.builtAt.slice(0, 10)}` : null,
  ].filter((part): part is string => part !== null);

  about.textContent = `v${version}`;
  if (details.length > 0) about.title = details.join(' - ');
  about.hidden = false;
}

/**
 * Encoder detection costs a one-frame test encode per candidate, and doing it
 * now means the first Export click does not sit there for a second while NVENC
 * is ruled in or out.
 */
async function warmEncoder(): Promise<void> {
  try {
    await detectEncoder();
  } catch {
    /* Export will report the real problem if there is one */
  }
}

/* --------------------------------------------------------------------------
 * Preview fallback
 * ----------------------------------------------------------------------- */

function offerPreviewProxy(): void {
  const media = edit.media;
  if (!media) return;

  showBanner('preview', {
    message: 'This video will not play here. A quick preview copy fixes the preview only - the export still uses the original file.',
    actionLabel: 'Make a quick preview',
    onAction: async () => {
      try {
        const proxy = await makePreviewProxy(media.path);
        // The proxy replaces edit.src but never edit.media.path, which is what
        // the export job is built from.
        const src = assetUrl(proxy);
        patchEdit({ src });
        loadSource(src);
        hideBanner('preview');
      } catch (error) {
        showToast(describe(error), [], true);
      }
    },
    dismissible: true,
  });
}

document.addEventListener('DOMContentLoaded', boot);
