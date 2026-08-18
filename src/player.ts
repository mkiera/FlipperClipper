import { edit, patchUi, refresh, subscribe } from './state';
import { applyGain, enableBoost } from './audio';
import { normalizeGain } from './loudness';

const PREVIEW_TIMEOUT_MS = 4000;

let video!: HTMLVideoElement;
let previewTroubleCb: (() => void) | null = null;
let previewTimer = 0;
let troubleReported = false;

const timeListeners = new Set<(t: number) => void>();

// requestVideoFrameCallback fires per presented frame; a timer drifts against the decoder.
let useFrameCallback = false;
let pumpPending = false;

// One seek in flight, freshest target wins: a backwards seek re-decodes from the previous keyframe.
let seekInFlight = false;
let pendingTarget: number | null = null;
let lastTarget: number | null = null;
// fastSeek is feature-detected; Chromium historically shipped without it.
let scrubbing = false;
let hasFastSeek = false;

// Chromium rejects a negative playbackRate, so reverse is repeated backwards seeks.
let reverseActive = false;
let reverseRaf = 0;
let reversePos = 0;
let reverseWall = 0;

// Chromium throws outside [0.0625, 16] and the throw would abort the notify loop.
function previewRate(): number {
  return Math.min(Math.max(edit.speed, 0.0625), 16);
}

function playElement(): void {
  void video.play().catch((err: unknown) => {
    // AbortError says nothing about whether the file decodes.
    if (err instanceof DOMException && err.name === 'AbortError') return;
    reportPreviewTrouble();
  });
}

export function initPlayer(el: HTMLVideoElement): void {
  video = el;
  useFrameCallback = typeof video.requestVideoFrameCallback === 'function';
  hasFastSeek = typeof video.fastSeek === 'function';

  video.preservesPitch = true;
  video.playbackRate = previewRate();
  video.muted = edit.mute;

  video.addEventListener('play', () => {
    patchUi({ playing: true });
    schedulePump();
  });
  video.addEventListener('pause', () => {
    if (!reverseActive) patchUi({ playing: false });
  });
  video.addEventListener('seeked', () => {
    seekInFlight = false;
    if (pendingTarget !== null) issueSeek();
    emitTime(displayTime());
  });
  video.addEventListener('timeupdate', () => emitTime(displayTime()));
  video.addEventListener('ended', () => rewindToIn());

  video.addEventListener('loadedmetadata', () => {
    // preservesPitch survives a src swap, but the proxy path replaces the source mid-session.
    video.preservesPitch = true;
    video.playbackRate = previewRate();
    video.muted = edit.mute;
    emitTime(video.currentTime);
  });

  video.addEventListener('loadeddata', () => {
    window.clearTimeout(previewTimer);
  });

  video.addEventListener('error', () => {
    window.clearTimeout(previewTimer);
    // A dead element never fires 'seeked', and every later seek would queue behind it.
    seekInFlight = false;
    pendingTarget = null;
    reportPreviewTrouble();
  });

  subscribe(syncFromState);

  if (useFrameCallback) schedulePump();
}

export function onPreviewTrouble(cb: () => void): void {
  previewTroubleCb = cb;
}

export function videoElement(): HTMLVideoElement {
  return video;
}

export function loadSource(url: string): void {
  window.clearTimeout(previewTimer);
  troubleReported = false;
  resetSeekMachinery();

  video.pause();
  video.src = url;
  video.load();

  previewTimer = window.setTimeout(() => {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) reportPreviewTrouble();
  }, PREVIEW_TIMEOUT_MS);
}

export function clearSource(): void {
  window.clearTimeout(previewTimer);
  resetSeekMachinery();
  video.pause();
  video.removeAttribute('src');
  video.load();
}

// While a seek is queued, video.currentTime still reports where the decoder last was.
export function currentTime(): number {
  if (!video) return 0;
  return displayTime();
}

export function onTime(cb: (t: number) => void): () => void {
  timeListeners.add(cb);
  return () => {
    timeListeners.delete(cb);
  };
}

export function play(): void {
  if (!edit.media) return;
  if (edit.reverse) {
    startReverse();
    return;
  }
  if (displayTime() >= edit.outPoint - halfFrame()) seek(edit.inPoint);
  playElement();
}

export function pause(): void {
  stopReverse();
  video.pause();
}

export function togglePlay(): void {
  if (isPlaying()) pause();
  else play();
}

function isPlaying(): boolean {
  return reverseActive || !video.paused;
}

export function seek(t: number): void {
  if (!edit.media) return;
  const clamped = Math.min(Math.max(t, edit.inPoint), edit.outPoint);
  // Steer the reverse countdown, or its next tick yanks the picture back.
  if (reverseActive) {
    reversePos = clamped;
    reverseWall = performance.now();
  }
  requestSeek(clamped);
  emitTime(clamped);
}

// fastSeek can park up to a GOP away, so release re-issues the exact target.
export function beginScrub(): void {
  scrubbing = true;
}

export function endScrub(): void {
  if (!scrubbing) return;
  scrubbing = false;
  if (hasFastSeek && edit.media && lastTarget !== null) requestSeek(lastTarget);
}

export function stepFrames(frames: number): void {
  if (!edit.media) return;
  pause();
  seek(displayTime() + frames * frameDuration());
}

export function stepSeconds(seconds: number): void {
  if (!edit.media) return;
  pause();
  seek(displayTime() + seconds);
}

function requestSeek(t: number): void {
  pendingTarget = t;
  lastTarget = t;
  if (!seekInFlight) issueSeek();
}

function issueSeek(): void {
  if (pendingTarget === null) return;
  const target = pendingTarget;
  pendingTarget = null;

  // A zero-length seek still runs the seek algorithm, and may never fire 'seeked'.
  if (!video.seeking && Math.abs(video.currentTime - target) < 0.0001) {
    emitTime(target);
    return;
  }

  seekInFlight = true;
  if (scrubbing && hasFastSeek) video.fastSeek(target);
  else video.currentTime = target;
}

function displayTime(): number {
  return pendingTarget ?? video.currentTime;
}

function resetSeekMachinery(): void {
  stopReverse();
  seekInFlight = false;
  pendingTarget = null;
  lastTarget = null;
  scrubbing = false;
}

function startReverse(): void {
  if (!edit.media) return;
  stopReverse();
  video.pause();

  let from = displayTime();
  if (from <= edit.inPoint + halfFrame()) from = edit.outPoint;

  reversePos = Math.min(Math.max(from, edit.inPoint), edit.outPoint);
  reverseWall = performance.now();
  reverseActive = true;
  patchUi({ playing: true });
  seek(reversePos);
  reverseRaf = requestAnimationFrame(reverseTick);
}

function reverseTick(): void {
  if (!reverseActive) return;

  const now = performance.now();
  reversePos -= ((now - reverseWall) / 1000) * edit.speed;
  reverseWall = now;
  if (reversePos > edit.outPoint) reversePos = edit.outPoint;

  if (reversePos <= edit.inPoint) {
    stopReverse();
    seek(edit.inPoint);
    return;
  }

  seek(reversePos);
  reverseRaf = requestAnimationFrame(reverseTick);
}

function stopReverse(): void {
  if (!reverseActive) return;
  reverseActive = false;
  cancelAnimationFrame(reverseRaf);
  patchUi({ playing: false });
}

function frameDuration(): number {
  const fps = edit.media?.fps ?? 0;
  return fps > 0 ? 1 / fps : 1 / 30;
}

function halfFrame(): number {
  return frameDuration() / 2;
}

function rewindToIn(): void {
  video.pause();
  seek(edit.inPoint);
}

function emitTime(t: number): void {
  for (const listener of timeListeners) listener(t);
}

function reportPreviewTrouble(): void {
  if (troubleReported || !edit.media) return;
  troubleReported = true;
  previewTroubleCb?.();
}

// timeupdate fires about four times a second: at 4x that overshoots the out point visibly.
function pump(): void {
  pumpPending = false;
  const t = displayTime();

  if (edit.media && !video.paused && t >= edit.outPoint - halfFrame()) rewindToIn();
  else emitTime(t);

  if (useFrameCallback || !video.paused) schedulePump();
}

function schedulePump(): void {
  if (pumpPending) return;
  pumpPending = true;
  if (useFrameCallback) video.requestVideoFrameCallback(pump);
  else requestAnimationFrame(pump);
}

function syncFromState(): void {
  if (!video) return;

  const rate = previewRate();
  if (video.playbackRate !== rate) video.playbackRate = rate;
  if (video.muted !== edit.mute) video.muted = edit.mute;
  // Normalise first, then the slider trims from there - the same order the export emits.
  const wanted = edit.volume * (edit.normalize ? normalizeGain() : 1);
  // Only a boost needs the graph, so a session that never asks for one never attaches it.
  // Attaching lands after this render, so the one call that succeeds asks for another - and
  // only that call, or re-rendering would chase itself.
  if (wanted > 1 && edit.src) {
    void enableBoost(video, edit.src).then((attached) => {
      if (attached) refresh();
    });
  }
  applyGain(video, wanted);

  if (!edit.media) {
    stopReverse();
    return;
  }

  if (edit.reverse && !video.paused) startReverse();
  else if (!edit.reverse && reverseActive) {
    stopReverse();
    playElement();
  }

  const t = displayTime();
  if (t < edit.inPoint - 0.001) seek(edit.inPoint);
  else if (t > edit.outPoint + 0.001) seek(edit.outPoint);
}
