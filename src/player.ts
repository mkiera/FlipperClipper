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

/**
 * Seek coalescing. A backwards seek makes the decoder start over at the
 * previous keyframe, and a scrub drag produces a pointermove per mouse packet;
 * assigning currentTime for each one queues dozens of keyframe-decodes that
 * the element works through serially, which is exactly the "scrubbing
 * backwards is slow" complaint. So at most one seek is ever in flight: new
 * targets overwrite `pendingTarget` and the freshest one is issued when
 * 'seeked' says the element is free again. Every abandoned intermediate target
 * is a keyframe-decode that never happens.
 */
let seekInFlight = false;
let pendingTarget: number | null = null;
/** The last target anyone asked for, so a scrub release can land on it exactly. */
let lastTarget: number | null = null;
/**
 * True while the timeline is dragging the playhead. During the drag we take
 * fastSeek (keyframe-accurate, no re-decode) when the element offers it;
 * Chromium historically shipped without fastSeek, so it is feature-detected
 * rather than assumed, and the release always re-seeks precisely.
 */
let scrubbing = false;
let hasFastSeek = false;

/**
 * Reverse preview. Chromium rejects a negative playbackRate, so "playing" a
 * reversed clip means repeatedly seeking backwards: a rAF loop moves a
 * wall-clock cursor toward the in point at the chosen speed and feeds it to
 * the coalescer above. The picture advances at whatever rate backwards seeks
 * actually complete, which is the honest preview of a reversed clip - the
 * export is exact.
 */
let reverseActive = false;
let reverseRaf = 0;
let reversePos = 0;
let reverseWall = 0;

/**
 * Chromium throws NotSupportedError for a playbackRate outside [0.0625, 16] and
 * the throw would abort the state-notify loop, so the preview clamps. The
 * exported clip still uses edit.speed exactly.
 */
function previewRate(): number {
  return Math.min(Math.max(edit.speed, 0.0625), 16);
}

function playElement(): void {
  void video.play().catch((err: unknown) => {
    // A play() interrupted by a pause or a new source rejects with AbortError,
    // which says nothing about whether the file decodes.
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
    // Chromium keeps preservesPitch across a src swap, but the proxy path
    // replaces the element's source mid-session and this costs one assignment.
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
    // A dead element never fires 'seeked', and leaving the flag up would make
    // every later seek queue behind one that can no longer complete.
    seekInFlight = false;
    pendingTarget = null;
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

/**
 * The position the UI should show. While a seek is queued, video.currentTime
 * still reports where the decoder last was; drawing that would make the
 * playhead snap back under the cursor mid-drag and then catch up.
 */
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
  // Pressing play after the clip ran to the out point should start over rather
  // than sit on the last frame doing nothing.
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

/** Seeks, clamped into the trim. Everything that moves the playhead goes here. */
export function seek(t: number): void {
  if (!edit.media) return;
  const clamped = Math.min(Math.max(t, edit.inPoint), edit.outPoint);
  // A reverse preview would otherwise yank the picture back to its own cursor
  // on the next tick, so a click or scrub steers the countdown instead.
  if (reverseActive) {
    reversePos = clamped;
    reverseWall = performance.now();
  }
  requestSeek(clamped);
  emitTime(clamped);
}

/**
 * The timeline brackets a scrub drag with these so the coalescer knows when
 * keyframe-sloppy seeks are acceptable. On release the exact last target is
 * re-issued precisely, because fastSeek may have parked the picture on a
 * keyframe up to a GOP away from where the cursor stopped.
 */
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

  // Seeking to where the decoder already is would still run the whole seek
  // algorithm, and the reverse loop's first tick does exactly that. Skipping
  // it also removes any reliance on 'seeked' firing for a zero-length seek.
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
  // Mirror of the forward replay rule: parked at the in point, a reversed clip
  // has nowhere to go, so Space restarts it from the out point.
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
  // A trim handle can move while the preview runs; without this the cursor
  // keeps counting down from a position that no longer exists and the picture
  // sits pinned at the out point until the numbers catch up.
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

/**
 * The out point is checked here rather than on a timeupdate listener because
 * timeupdate only fires about four times a second: at 4x speed that overshoots
 * the trim end by a visible chunk of video before the pause lands.
 */
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
  // The element's volume tops out at 1, so the boosted half of the 0..2 range
  // previews at unity gain; wiring WebAudio in just to preview a boost would
  // put a graph between the file and the speakers for one slider position.
  const previewGain = Math.min(edit.volume, 1);
  if (video.volume !== previewGain) video.volume = previewGain;

  if (!edit.media) {
    stopReverse();
    return;
  }

  // Toggling reverse mid-play switches direction in place instead of stopping:
  // startReverse pauses the element itself, and the mirror case resumes it.
  if (edit.reverse && !video.paused) startReverse();
  else if (!edit.reverse && reverseActive) {
    stopReverse();
    playElement();
  }

  // Dragging a trim handle past the playhead has to move the playhead, not
  // leave it parked outside the range it is supposed to be locked into.
  const t = displayTime();
  if (t < edit.inPoint - 0.001) seek(edit.inPoint);
  else if (t > edit.outPoint + 0.001) seek(edit.outPoint);
}
