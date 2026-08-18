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
import { initOverlay } from './overlay';
import { initEffectsPanel } from './effectspanel';
import { describe, hideBanner, initControls, showBanner, showFfmpegBanner, showToast } from './controls';
import { initShortcuts } from './shortcuts';
import { initUpdater } from './updater';
import { appSettings, buildInfo, initSettings } from './settings';

const FILMSTRIP_FRAMES = 16;
const FILMSTRIP_HEIGHT = 64;

// Three attempts across about five seconds before the banner is raised.
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

  // Player first: crop.ts measures the <video> on init, controls.ts reads its position.
  initPlayer(el<HTMLVideoElement>('video'));
  initTimeline();
  initCrop();
  // After crop: the overlays are placed on the crop rectangle when there is one.
  initOverlay();
  initEffectsPanel();
  initControls({ openFile: () => void openViaDialog() });
  initShortcuts({ openFile: () => void openViaDialog() });
  const settingsReady = initSettings();

  el('empty-open').addEventListener('click', () => void openViaDialog());

  onPreviewTrouble(offerPreviewProxy);
  subscribe(renderStage);
  renderStage();

  // Losing focus mid-drag never produces a 'leave', so the hint would stay up.
  window.addEventListener('blur', () => {
    dropHint.hidden = true;
  });

  // A window that opens already focused never fires 'focus', so visibility asks too.
  window.addEventListener('focus', () => void checkFfmpeg(true));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void checkFfmpeg(true);
  });
  window.addEventListener('pointerdown', recheckIfMissing);
  window.addEventListener('keydown', recheckIfMissing);

  void watchDrops();
  void checkFfmpeg();
  void warmEncoder();
  // After the settings: a launch file on defaults would build a filmstrip the user turned off.
  void settingsReady.then(openLaunchFile);
  void showBuildIdentity();

  initUpdater();
}

function renderStage(): void {
  const hasMedia = edit.media !== null;
  emptyState.hidden = hasMedia;
  videoElement().classList.toggle('loaded', hasMedia);
}

async function openViaDialog(): Promise<void> {
  const picked = await pickVideo();
  if (picked) await openPath(picked);
}

async function openPath(path: string): Promise<void> {
  try {
    // probe() is what puts the path into the asset-protocol scope; the URL is only safe after it.
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

async function loadFilmstrip(path: string): Promise<void> {
  if (!appSettings().showFilmstrip) return;
  try {
    const frames = await makeFilmstrip(path, FILMSTRIP_FRAMES, FILMSTRIP_HEIGHT);
    if (edit.media?.path === path) patchUi({ filmstrip: frames });
  } catch {
    /* decoration over a timeline that already works */
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

let ffmpegCheckRunning = false;

// Never believes the first no: PATH resolution at launch races the shell.
async function checkFfmpeg(quiet = false): Promise<void> {
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

    // A quiet re-check may only clear a verdict, never raise one: pointerdown precedes click,
    // so the banner's own Install button would be undone by the ladder it started.
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

async function reportFfmpegDiagnostic(): Promise<void> {
  try {
    const text = await ffmpegCheckLog();
    if (text) console.warn(text);
  } catch {
    /* a diagnostic that fails must not become a second failure */
  }
}

// One re-check per stretch of missing FFmpeg: a failing resolution walks the registry.
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

  about.textContent = `v${version} · Made by Kiera`;
  if (details.length > 0) about.title = details.join(' - ');
  about.hidden = false;
}

// A one-frame test encode per candidate, done now so the first Export click is not slow.
async function warmEncoder(): Promise<void> {
  try {
    await detectEncoder();
  } catch {
    /* Export will report the real problem if there is one */
  }
}

function offerPreviewProxy(): void {
  const media = edit.media;
  if (!media || !appSettings().autoPreviewProxy) return;

  showBanner('preview', {
    message: 'This video will not play here. A quick preview copy fixes the preview only - the export still uses the original file.',
    actionLabel: 'Make a quick preview',
    onAction: async () => {
      try {
        const proxy = await makePreviewProxy(media.path);
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
