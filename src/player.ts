import { edit, patchUi, refresh, subscribe } from './state';
import { applyGain, enableBoost } from './audio';
import { normalizeGain } from './loudness';
import { speedAt } from './ramp';
import { isPlain, locate, remapTime, timelineTime, totalDuration } from './sequence';
import type { Clip } from './types';
import {
  clearTrackPreviews,
  hasTrackPreview,
  initTrackPreview,
  pauseTrackPreview,
  playTrackPreview,
  seekTrackPreview,
  syncTrackPreview,
  tickTrackPreview,
} from './track-preview';

export { loadTrackPreviews, onTrackLevels, trackPreviewStatus } from './track-preview';

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

// Several clips: the element plays one file at a time, and the playhead is a time on the
// timeline the clips make. `clipIndex` is the clip the element is showing.
let loadedUrl: string | null = null;
let clipIndex = 0;
let layout: Clip[] = [];
// While the element loads another file it reports 0, so the playhead holds here meanwhile.
let heldTime: number | null = null;
let switchLocal: number | null = null;
let resumeAfterSwitch = false;
let urlForPath: (path: string) => string = (path) => path;

/** How a clip's file becomes a URL the element can play, which main.ts owns because it
 *  knows about preview copies. */
export function setClipUrl(resolve: (path: string) => string): void {
  urlForPath = resolve;
}

function sequenceMode(): boolean {
  return !isPlain(edit.clips);
}

/** The file the picture is coming from, for the preview copy offer. */
export function currentClipPath(): string | null {
  if (!edit.media) return null;
  if (!sequenceMode()) return edit.media.path;
  return edit.clips[clipIndex]?.media.path ?? edit.media.path;
}

// Chromium throws outside [0.0625, 16] and the throw would abort the notify loop.
function previewRate(): number {
  // Under a curve the rate is whatever the playhead is standing on, so the preview speeds up
  // and slows down where the export will.
  const wanted = edit.ramp.length > 0 ? speedAt(edit, displayTime()) : edit.speed;
  return Math.min(Math.max(wanted, 0.0625), 16);
}

/** Follows the curve while the clip plays. Called per presented frame, and only written when
 *  the rate has actually moved: assigning playbackRate every frame stutters the audio. */
function followRamp(): void {
  if (edit.ramp.length === 0) return;
  const wanted = previewRate();
  if (Math.abs(video.playbackRate - wanted) > 0.01) video.playbackRate = wanted;
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
  initTrackPreview(video, displayTime);
  useFrameCallback = typeof video.requestVideoFrameCallback === 'function';
  hasFastSeek = typeof video.fastSeek === 'function';

  video.preservesPitch = true;
  video.playbackRate = previewRate();
  video.muted = edit.mute;

  video.addEventListener('play', () => {
    patchUi({ playing: true });
    playTrackPreview();
    schedulePump();
  });
  video.addEventListener('pause', () => {
    pauseTrackPreview();
    if (!reverseActive) patchUi({ playing: false });
  });
  video.addEventListener('seeked', () => {
    if (switchLocal !== null) return;
    seekInFlight = false;
    heldTime = null;
    if (pendingTarget !== null) issueSeek();
    seekTrackPreview(displayTime());
    emitTime(displayTime());
  });
  video.addEventListener('timeupdate', () => emitTime(displayTime()));
  video.addEventListener('ended', () => {
    if (!advanceClip()) rewindToIn();
  });

  video.addEventListener('loadedmetadata', () => {
    // preservesPitch survives a src swap, but the proxy path replaces the source mid-session.
    video.preservesPitch = true;
    video.playbackRate = previewRate();
    if (switchLocal !== null) finishSwitch();
    syncTrackPreview();
    emitTime(displayTime());
  });

  video.addEventListener('loadeddata', () => {
    window.clearTimeout(previewTimer);
  });

  video.addEventListener('error', () => {
    window.clearTimeout(previewTimer);
    // A dead element never fires 'seeked', and every later seek would queue behind it.
    seekInFlight = false;
    pendingTarget = null;
    heldTime = null;
    switchLocal = null;
    resumeAfterSwitch = false;
    pauseTrackPreview();
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
  clipIndex = 0;
  layout = edit.clips;

  video.pause();
  syncTrackPreview();
  loadedUrl = url;
  video.src = url;
  video.load();
  armPreviewTimer();
}

function armPreviewTimer(): void {
  window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) reportPreviewTrouble();
  }, PREVIEW_TIMEOUT_MS);
}

/** Puts another clip's file in the element and seeks it once it knows its length. */
function switchTo(url: string, index: number, local: number, timeline: number): void {
  resumeAfterSwitch = resumeAfterSwitch || (!video.paused && !reverseActive);
  seekInFlight = true;
  heldTime = timeline;
  switchLocal = local;
  clipIndex = index;
  loadedUrl = url;
  troubleReported = false;
  video.src = url;
  video.load();
  armPreviewTimer();
}

function finishSwitch(): void {
  const local = switchLocal ?? 0;
  switchLocal = null;
  if (Math.abs(video.currentTime - local) < 0.0001) {
    seekInFlight = false;
    heldTime = null;
  } else {
    // 'seeked' clears the hold and runs anything queued meanwhile.
    video.currentTime = local;
  }
  if (resumeAfterSwitch) {
    resumeAfterSwitch = false;
    playElement();
  }
  if (!seekInFlight && pendingTarget !== null) issueSeek();
}

/** At the end of a clip, carries playback on into the next one. False at the end of the
 *  timeline, or with one file, where the caller loops back to the in point. */
function advanceClip(): boolean {
  if (!sequenceMode() || reverseActive || !edit.media) return false;
  const next = clipIndex + 1;
  if (next >= edit.clips.length) return false;
  const start = timelineTime(edit.clips, next, edit.clips[next].start);
  if (start >= edit.outPoint - halfFrame()) return false;
  const resume = !video.paused || video.ended;
  resumeAfterSwitch = resumeAfterSwitch || resume;
  requestSeek(start);
  // The next clip may be in the same file, where nothing reloads to resume it: an ended file
  // has paused itself.
  if (switchLocal === null) {
    resumeAfterSwitch = false;
    if (resume && video.paused) playElement();
  }
  return true;
}

export function clearSource(): void {
  window.clearTimeout(previewTimer);
  resetSeekMachinery();
  loadedUrl = null;
  video.pause();
  clearTrackPreviews();
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
  resumeAfterSwitch = false;
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
  seekTrackPreview(clamped);
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

  let local = target;
  if (sequenceMode()) {
    const hit = locate(edit.clips, target);
    if (!hit) return;
    const url = urlForPath(edit.clips[hit.index].media.path);
    if (url !== loadedUrl) {
      switchTo(url, hit.index, hit.local, target);
      return;
    }
    clipIndex = hit.index;
    local = hit.local;
  }

  // A zero-length seek still runs the seek algorithm, and may never fire 'seeked'.
  if (!video.seeking && Math.abs(video.currentTime - local) < 0.0001) {
    emitTime(target);
    return;
  }

  seekInFlight = true;
  if (scrubbing && hasFastSeek) video.fastSeek(local);
  else video.currentTime = local;
}

function displayTime(): number {
  if (pendingTarget !== null) return pendingTarget;
  if (heldTime !== null) return heldTime;
  if (!video) return 0;
  if (!sequenceMode()) return video.currentTime;
  return timelineTime(edit.clips, clipIndex, video.currentTime);
}

function resetSeekMachinery(): void {
  stopReverse();
  seekInFlight = false;
  pendingTarget = null;
  lastTarget = null;
  scrubbing = false;
  heldTime = null;
  switchLocal = null;
  resumeAfterSwitch = false;
}

function startReverse(): void {
  if (!edit.media) return;
  stopReverse();
  video.pause();
  pauseTrackPreview();

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
  else if (edit.media && !video.paused && !seekInFlight && clipEnded()) advanceClip();
  else emitTime(t);

  followRamp();
  tickTrackPreview(t);

  if (useFrameCallback || !video.paused) schedulePump();
}

function clipEnded(): boolean {
  if (!sequenceMode()) return false;
  const clip = edit.clips[clipIndex];
  return clip !== undefined && video.currentTime >= clip.end - halfFrame();
}

function schedulePump(): void {
  if (pumpPending) return;
  pumpPending = true;
  if (useFrameCallback) video.requestVideoFrameCallback(pump);
  else requestAnimationFrame(pump);
}

/** The clips changed under the playhead: keep it on the same footage where that is still on
 *  the timeline, and put the right file in the element. */
function followClips(): void {
  const before = layout;
  layout = edit.clips;
  if (before.length === 0) return;
  // Read through the order the element was playing, not the new one.
  let was: number;
  if (pendingTarget !== null) was = pendingTarget;
  else if (heldTime !== null) was = heldTime;
  else if (isPlain(before)) was = video.currentTime;
  else was = timelineTime(before, clipIndex, video.currentTime);
  const total = totalDuration(edit.clips);
  const moved = remapTime(before, edit.clips, was) ?? Math.min(was, total);
  // One file played whole again, which may not be the file that opened the session: removing
  // the first of two clips leaves the second.
  const wanted = sequenceMode() || !edit.clips[0] ? null : urlForPath(edit.clips[0].media.path);
  if (wanted !== null && wanted !== loadedUrl) {
    const playing = !video.paused;
    resetSeekMachinery();
    switchTo(wanted, 0, moved, moved);
    resumeAfterSwitch = playing;
    return;
  }
  pendingTarget = null;
  requestSeek(Math.min(Math.max(moved, edit.inPoint), edit.outPoint));
}

function syncFromState(): void {
  if (!video) return;

  const rate = previewRate();
  if (video.playbackRate !== rate) video.playbackRate = rate;
  syncTrackPreview();
  // Normalise first, then the slider trims from there - the same order the export emits.
  const wanted = edit.volume * (edit.normalize ? normalizeGain() : 1);
  // Only a boost needs the graph, so a session that never asks for one never attaches it.
  // Attaching lands after this render, so the one call that succeeds asks for another - and
  // only that call, or re-rendering would chase itself.
  if (!hasTrackPreview() && wanted > 1 && edit.src) {
    void enableBoost(video).then((attached) => {
      if (attached) refresh();
    });
  }
  if (!hasTrackPreview()) applyGain(video, wanted);

  if (!edit.media) {
    stopReverse();
    return;
  }

  if (edit.clips !== layout) followClips();

  if (edit.reverse && !video.paused) startReverse();
  else if (!edit.reverse && reverseActive) {
    stopReverse();
    playElement();
  }

  const t = displayTime();
  if (t < edit.inPoint - 0.001) seek(edit.inPoint);
  else if (t > edit.outPoint + 0.001) seek(edit.outPoint);
}
