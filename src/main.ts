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
  ffmpegCheckLog,
  ffmpegStatus,
  launchFilePath,
  makeFilmstrip,
  makePreviewProxy,
  onDragDrop,
  pickVideo,
  probe,
} from './ipc';
import { edit, loadMedia, patchEdit, patchUi, subscribe, ui } from './state';
import { initPlayer, loadSource, onPreviewTrouble, videoElement } from './player';
import { initTimeline } from './timeline';
import { initCrop } from './crop';
import { describe, hideBanner, initControls, showBanner, showFfmpegBanner, showToast } from './controls';
import { initShortcuts } from './shortcuts';
import { initUpdater } from './updater';
import { appSettings, buildInfo, initSettings } from './settings';

/** How many thumbnails the strip gets. Long files reuse the same budget. */
const FILMSTRIP_FRAMES = 16;
const FILMSTRIP_HEIGHT = 64;

/**
 * Waits between the retries of one FFmpeg check: three attempts across about
 * five seconds. A launch that resolves nothing on its first try costs that much
 * silence instead of a banner telling the user to install what they already have.
 */
const FFMPEG_RETRY_MS = [1500, 3500];

let emptyState!: HTMLElement;
let dropHint!: HTMLElement;
let about!: HTMLElement;

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`FlipperClipper: index.html is missing #${id}`);
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
  initControls({ openFile: () => void openViaDialog() });
  initShortcuts({ openFile: () => void openViaDialog() });
  const settingsReady = initSettings();

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

  // PATH resolution at launch is unreliable enough that a "missing" verdict can
  // be wrong, so every route back to the app re-asks. 'focus' alone is not one:
  // a window that opens already focused never fires it, and the banner then
  // outlives the conditions that raised it until the app is restarted.
  window.addEventListener('focus', () => void checkFfmpeg(true));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void checkFfmpeg(true);
  });
  window.addEventListener('pointerdown', recheckIfMissing);
  window.addEventListener('keydown', recheckIfMissing);

  void watchDrops();
  void checkFfmpeg();
  void warmEncoder();
  // After the settings land: a launch file probed on defaults would build a
  // filmstrip and offer a proxy the user turned off.
  void settingsReady.then(openLaunchFile);
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
  if (!appSettings().showFilmstrip) return;
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

let ffmpegCheckRunning = false;

/**
 * Asks whether FFmpeg is there, and does not believe the first "no".
 *
 * Each attempt is a full re-resolution on the Rust side, so a launch that races
 * something - the installer's [Run] entry starting the app before the shell has
 * the new environment, say - gets several chances before the user is told to
 * install a thing they have. The banner is only raised once every attempt has
 * failed.
 */
async function checkFfmpeg(quiet = false): Promise<void> {
  // Focus, visibility and the interaction listeners can all fire inside one
  // retry window; without this they would each start their own ladder.
  if (ffmpegCheckRunning) return;
  ffmpegCheckRunning = true;
  try {
    let failure: unknown = null;
    for (let attempt = 0; ; attempt += 1) {
      try {
        if ((await ffmpegStatus()).available) {
          patchUi({ ffmpegAvailable: true });
          hideBanner('ffmpeg');
          return;
        }
        failure = null;
      } catch (error) {
        failure = error;
      }
      if (attempt >= FFMPEG_RETRY_MS.length) break;
      await sleep(FFMPEG_RETRY_MS[attempt]);
    }

    // A quiet re-check may only clear a wrong verdict, never raise one. It can
    // start from a pointerdown, and pointerdown precedes click - so the banner's
    // own "Install it" button would otherwise be undone by the ladder it began,
    // putting the banner back after a successful install.
    if (quiet) return;

    patchUi({ ffmpegAvailable: false });
    if (failure !== null) {
      showToast(describe(failure), [], true);
      return;
    }
    showFfmpegBanner(() => void warmEncoder());
    void reportFfmpegDiagnostic();
  } finally {
    ffmpegCheckRunning = false;
  }
}

/** The banner is a verdict; the check log says which tier failed and why. */
async function reportFfmpegDiagnostic(): Promise<void> {
  try {
    const text = await ffmpegCheckLog();
    if (text) console.warn(text);
  } catch {
    /* a diagnostic that fails must not become a second failure */
  }
}

/**
 * One re-check per stretch of missing FFmpeg, not one per click. Each ladder is
 * three resolutions, and a failing one walks the registry, so re-running it on
 * every keystroke would spawn PowerShell continuously while the banner is up.
 */
let recheckedSinceMissing = false;

function recheckIfMissing(): void {
  if (ui.ffmpegAvailable) {
    recheckedSinceMissing = false;
    return;
  }
  if (recheckedSinceMissing) return;
  recheckedSinceMissing = true;
  void checkFfmpeg(true);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * The version line under the wordmark, with the commit and build date in its
 * tooltip.
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

  const info = buildInfo();
  const details = [
    info.sha ? `commit ${info.sha.slice(0, 7)}` : null,
    info.builtAt ? `built ${info.builtAt.slice(0, 10)}` : null,
  ].filter((part): part is string => part !== null);

  // The same treatment as FinFetcher's "v1.1.0 · Made by Kiera" header line,
  // because the two apps are meant to read as siblings from the first screen.
  about.textContent = `v${version} · Made by Kiera`;
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
  if (!media || !appSettings().autoPreviewProxy) return;

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
