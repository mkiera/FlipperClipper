import {
  appVersion,
  assetUrl,
  detectEncoder,
  ffmpegCheckLog,
  ffmpegStatus,
  launchFilePath,
  makeClipsFilmstrip,
  makeFilmstrip,
  makePreviewProxy,
  onDragDrop,
  pickVideo,
  pickVideos,
  probe,
} from './ipc';
import { edit, loadMedia, patchEdit, patchUi, setClips, subscribe, ui } from './state';
import {
  currentClipPath,
  currentTime,
  initPlayer,
  loadSource,
  loadTrackPreviews,
  onPreviewTrouble,
  seek,
  setClipUrl,
  videoElement,
} from './player';
import { initClipLane } from './cliplane';
import { appendClips, byFileName, isPlain, MAX_CLIPS, timelineKey, toPieces } from './sequence';
import type { MediaInfo } from './types';
import { initTimeline } from './timeline';
import { initCrop } from './crop';
import { initKeyLane } from './keylane';
import { initRampLane } from './ramplane';
import { initOverlay } from './overlay';
import { initEffectsPanel } from './effectspanel';
import { describe, hideBanner, initControls, showBanner, showFfmpegBanner, showToast } from './controls';
import { initShortcuts } from './shortcuts';
import { initFocusRelease } from './focus';
import { initDevPanel, recordError } from './devpanel';
import { initUpdater } from './updater';
import { appSettings, buildInfo, initSettings } from './settings';
import { applyMinWindowSize } from './windowsize';

const FILMSTRIP_FRAMES = 16;
const FILMSTRIP_HEIGHT = 64;

// Three attempts across about five seconds before the banner is raised.
const FFMPEG_RETRY_MS = [1500, 3500];

/** Preview copies made this session, by the file they stand in for. */
const proxies = new Map<string, string>();

/** The timeline the filmstrip and the audio preview were last built for. */
let builtKey = '';
let rebuildTimer = 0;
const REBUILD_DELAY_MS = 250;

let emptyState!: HTMLElement;
let dropHint!: HTMLElement;
let about!: HTMLElement;

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`FlipperClipper: index.html is missing #${id}`);
  return found as T;
}

function boot(): void {
  // First, so its capture listeners see a click before anything acts on it.
  initFocusRelease();

  emptyState = el('empty');
  dropHint = el('drop-hint');
  about = el('about');

  // Player first: crop.ts measures the <video> on init, controls.ts reads its position.
  initPlayer(el<HTMLVideoElement>('video'));
  setClipUrl((path) => proxies.get(path) ?? assetUrl(path));
  initTimeline();
  initClipLane({ addClips: () => void addViaDialog() });
  initCrop();
  initRampLane();
  initKeyLane();
  // After crop: the overlays are placed on the crop rectangle when there is one.
  initOverlay();
  initEffectsPanel();
  initControls({ openFile: () => void openViaDialog() });
  initShortcuts({ openFile: () => void openViaDialog() });
  // Ships in release builds: Ctrl+Shift+D and nothing else reaches it.
  initDevPanel();
  const settingsReady = initSettings();

  el('empty-open').addEventListener('click', () => void openViaDialog());

  onPreviewTrouble(offerPreviewProxy);
  subscribe(renderStage);
  subscribe(followTimeline);
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

  // After the controls exist: the minimum is measured off the row they build.
  void applyMinWindowSize();

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

async function openPath(path: string): Promise<boolean> {
  try {
    // probe() is what puts the path into the asset-protocol scope; the URL is only safe after it.
    const media = await probe(path);
    const src = assetUrl(path);
    hideBanner('preview');
    proxies.clear();
    loadMedia(media, src);
    loadSource(src);
    builtKey = timelineKey(edit.clips);
    window.clearTimeout(rebuildTimer);
    void loadTrackPreviews();
    void loadFilmstrip();
    return true;
  } catch (error) {
    recordError(describe(error));
    showToast(describe(error), [], true);
    return false;
  }
}

/** Several files at once: the first opens, the rest follow it as clips. */
async function openPaths(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const [first, ...rest] = paths;
  if (!(await openPath(first))) return;
  await addClips(rest);
}

async function addViaDialog(): Promise<void> {
  const picked = await pickVideos();
  if (picked.length === 0) return;
  // The dialog hands files back in whatever order Windows chose, so name order is the one
  // the user can predict. The lane reorders them from there.
  const sorted = [...picked].sort(byFileName);
  if (!edit.media) await openPaths(sorted);
  else await addClips(sorted);
}

async function addClips(paths: string[]): Promise<void> {
  if (paths.length === 0 || !edit.media) return;
  const added: MediaInfo[] = [];
  const failed: string[] = [];
  for (const path of paths) {
    try {
      added.push(await probe(path));
    } catch (error) {
      recordError(describe(error));
      failed.push(path);
    }
  }
  if (!edit.media) return;
  const room = MAX_CLIPS - edit.clips.length;
  if (added.length > 0) setClips(appendClips(edit.clips, added));
  if (failed.length > 0) {
    showToast(`${failed.length === 1 ? 'One file' : `${failed.length} files`} could not be added: not a video FlipperClipper can read.`, [], true);
  } else if (added.length > room) {
    showToast(`The timeline holds up to ${MAX_CLIPS} clips, so ${added.length - room} were left out.`, [], true);
  }
}

/** The filmstrip and the audio preview are built for one timeline, so a new clip order needs
 *  them again. A short wait lets a run of undos settle first. */
function followTimeline(): void {
  if (!edit.media) return;
  const key = timelineKey(edit.clips);
  if (key === builtKey) return;
  builtKey = key;
  patchUi({ filmstrip: [] });
  window.clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(() => {
    if (timelineKey(edit.clips) !== key) return;
    void loadTrackPreviews();
    void loadFilmstrip();
  }, REBUILD_DELAY_MS);
}

async function openLaunchFile(): Promise<void> {
  const path = await launchFilePath();
  if (path) await openPath(path);
}

async function loadFilmstrip(): Promise<void> {
  if (!appSettings().showFilmstrip || !edit.media) return;
  const key = timelineKey(edit.clips);
  try {
    const frames = isPlain(edit.clips)
      ? await makeFilmstrip(edit.media.path, FILMSTRIP_FRAMES, FILMSTRIP_HEIGHT)
      : await makeClipsFilmstrip(toPieces(edit.clips), FILMSTRIP_FRAMES, FILMSTRIP_HEIGHT);
    if (timelineKey(edit.clips) === key) patchUi({ filmstrip: frames });
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
    // One file replaces what is open, as it always has. Several make a timeline of clips.
    if (event.type === 'drop' && event.paths.length === 1) void openPath(event.paths[0]);
    else if (event.type === 'drop' && event.paths.length > 1) void openPaths([...event.paths].sort(byFileName));
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
  const path = currentClipPath();
  if (!media || !path || !appSettings().autoPreviewProxy) return;

  showBanner('preview', {
    message: 'This video will not play here. A quick preview copy fixes the preview only - the export still uses the original file.',
    actionLabel: 'Make a quick preview',
    onAction: async () => {
      try {
        const proxy = await makePreviewProxy(path);
        if (!edit.clips.some((clip) => clip.media.path === path)) return;
        const src = assetUrl(proxy);
        proxies.set(path, src);
        if (isPlain(edit.clips)) {
          patchEdit({ src });
          loadSource(src);
          void loadTrackPreviews();
        } else {
          if (path === edit.clips[0].media.path) patchEdit({ src });
          // The player loads whichever file the playhead needs, and now finds the copy.
          seek(currentTime());
        }
        hideBanner('preview');
      } catch (error) {
        recordError(describe(error));
    showToast(describe(error), [], true);
      }
    },
    dismissible: true,
  });
}

document.addEventListener('DOMContentLoaded', boot);
