/**
 * The <video> element and everything that keeps it inside the trim.
 *
 * The preview never goes near ffmpeg: WebView2 hardware-decodes the original
 * file straight off disk, trimming is a clamp on the playback position and
 * speed is playbackRate. That is the whole reason scrubbing feels instant, so
 * nothing in here may introduce a transcode or a seek round-trip.
 */

import { edit, patchUi, subscribe } from './state';

/**
 * How long a file gets to produce a decodable frame before we offer the proxy.
 * Four seconds is long enough that a cold 4K file off a slow drive still makes
 * it, and short enough that someone whose GPU has no HEVC decoder is not left
 * staring at a black rectangle wondering whether the app hung.
 */
const PREVIEW_TIMEOUT_MS = 4000;

let video!: HTMLVideoElement;
let previewTroubleCb: (() => void) | null = null;
let previewTimer = 0;
let troubleReported = false;

const timeListeners = new Set<(t: number) => void>();

/**
 * requestVideoFrameCallback fires once per presented frame, which is exactly
 * when the playhead has actually moved. Falling back to rAF costs nothing but
 * paints the playhead at monitor rate instead of frame rate. A timer is never
 * an option here: it drifts against the decoder and makes scrubbing look loose.
 */
let useFrameCallback = false;
let pumpPending = false;

export function initPlayer(el: HTMLVideoElement): void {
  video = el;
  useFrameCallback = typeof video.requestVideoFrameCallback === 'function';

  video.preservesPitch = true;
  video.playbackRate = edit.speed;
  video.muted = edit.mute;

  video.addEventListener('play', () => {
    patchUi({ playing: true });
    schedulePump();
  });
  video.addEventListener('pause', () => patchUi({ playing: false }));
  video.addEventListener('seeked', () => emitTime(video.currentTime));
  video.addEventListener('timeupdate', () => emitTime(video.currentTime));
  video.addEventListener('ended', () => rewindToIn());

  video.addEventListener('loadedmetadata', () => {
    // Chromium keeps preservesPitch across a src swap, but the proxy path
    // replaces the element's source mid-session and this costs one assignment.
    video.preservesPitch = true;
    video.playbackRate = edit.speed;
    video.muted = edit.mute;
    emitTime(video.currentTime);
  });

  video.addEventListener('loadeddata', () => {
    window.clearTimeout(previewTimer);
  });

  video.addEventListener('error', () => {
    window.clearTimeout(previewTimer);
    reportPreviewTrouble();
  });

  subscribe(syncFromState);

  if (useFrameCallback) schedulePump();
}

/** Fires when the loaded file will not decode in the webview and needs a proxy. */
export function onPreviewTrouble(cb: () => void): void {
  previewTroubleCb = cb;
}

export function videoElement(): HTMLVideoElement {
  return video;
}

export function loadSource(url: string): void {
  window.clearTimeout(previewTimer);
  troubleReported = false;

  video.pause();
  video.src = url;
  video.load();

  previewTimer = window.setTimeout(() => {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) reportPreviewTrouble();
  }, PREVIEW_TIMEOUT_MS);
}

export function clearSource(): void {
  window.clearTimeout(previewTimer);
  video.pause();
  video.removeAttribute('src');
  video.load();
}

export function currentTime(): number {
  return video ? video.currentTime : 0;
}

export function onTime(cb: (t: number) => void): () => void {
  timeListeners.add(cb);
  return () => {
    timeListeners.delete(cb);
  };
}

export function play(): void {
  if (!edit.media) return;
  // Pressing play after the clip ran to the out point should start over rather
  // than sit on the last frame doing nothing.
  if (video.currentTime >= edit.outPoint - halfFrame()) video.currentTime = edit.inPoint;
  void video.play().catch(() => reportPreviewTrouble());
}

export function pause(): void {
  video.pause();
}

export function togglePlay(): void {
  if (video.paused) play();
  else pause();
}

/** Seeks, clamped into the trim. Everything that moves the playhead goes here. */
export function seek(t: number): void {
  if (!edit.media) return;
  const clamped = Math.min(Math.max(t, edit.inPoint), edit.outPoint);
  video.currentTime = clamped;
  emitTime(clamped);
}

export function stepFrames(frames: number): void {
  if (!edit.media) return;
  pause();
  seek(video.currentTime + frames * frameDuration());
}

export function stepSeconds(seconds: number): void {
  if (!edit.media) return;
  pause();
  seek(video.currentTime + seconds);
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
  video.currentTime = edit.inPoint;
  emitTime(edit.inPoint);
}

function emitTime(t: number): void {
  for (const listener of timeListeners) listener(t);
}

function reportPreviewTrouble(): void {
  if (troubleReported || !edit.media) return;
  troubleReported = true;
  previewTroubleCb?.();
}

/**
 * The out point is checked here rather than on a timeupdate listener because
 * timeupdate only fires about four times a second: at 4x speed that overshoots
 * the trim end by a visible chunk of video before the pause lands.
 */
function pump(): void {
  pumpPending = false;
  const t = video.currentTime;

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

  if (video.playbackRate !== edit.speed) video.playbackRate = edit.speed;
  if (video.muted !== edit.mute) video.muted = edit.mute;

  if (!edit.media) return;

  // Dragging a trim handle past the playhead has to move the playhead, not
  // leave it parked outside the range it is supposed to be locked into.
  const t = video.currentTime;
  if (t < edit.inPoint - 0.001) seek(edit.inPoint);
  else if (t > edit.outPoint + 0.001) seek(edit.outPoint);
}
