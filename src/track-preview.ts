import { applyElementGain, disposeElementGain, elementLevel, enableElementBoost } from './audio';
import { assetUrl, makeAudioPreviews } from './ipc';
import { normalizeGain } from './loudness';
import { edit, refresh } from './state';
import type { AudioTrackInfo } from './types';

const LOAD_TIMEOUT_MS = 15_000;
const DRIFT_SECONDS = 0.08;
const WINDOW_STEP_SECONDS = 45;

interface TrackState {
  info: AudioTrackInfo;
  element: HTMLAudioElement;
}

interface PreviewWindow {
  start: number;
  duration: number;
  tracks: TrackState[];
}

interface WindowRequest {
  path: string;
  start: number;
  generation: number;
  expected: AudioTrackInfo[];
}

let video: HTMLVideoElement | null = null;
let active: PreviewWindow | null = null;
let standby: PreviewWindow | null = null;
let status: string | null = null;
let generation = 0;
let loadedPath: string | null = null;
let desiredTime = 0;
let wanted: WindowRequest | null = null;
let loading: Promise<void> | null = null;
let failedStart: number | null = null;
let meterFrame = 0;
let meterTime = 0;
const levels = new Map<number, number>();
const levelListeners = new Set<(levels: ReadonlyMap<number, number>) => void>();

function mediaTracks(): AudioTrackInfo[] {
  return edit.media?.audioTracks ?? [];
}

export function initTrackPreview(element: HTMLVideoElement): void {
  video = element;
}

export function hasTrackPreview(): boolean {
  return mediaTracks().length > 1;
}

export function trackPreviewStatus(): string | null {
  return status;
}

export function onTrackLevels(listener: (levels: ReadonlyMap<number, number>) => void): () => void {
  levelListeners.add(listener);
  listener(levels);
  scheduleMeters();
  return () => {
    levelListeners.delete(listener);
    if (levelListeners.size === 0) stopMeters();
  };
}

export async function loadTrackPreviews(path: string): Promise<void> {
  generation += 1;
  wanted = null;
  disposeWindows();
  failedStart = null;
  desiredTime = video?.currentTime ?? 0;
  if (!hasTrackPreview()) {
    setStatus(null);
    syncTrackPreview();
    return;
  }
  loadedPath = path;
  setStatus('Preparing audio preview...');
  syncTrackPreview();
  await requestWindow(windowStart(desiredTime));
}

export function clearTrackPreviews(): void {
  generation += 1;
  wanted = null;
  disposeWindows();
  failedStart = null;
  setStatus(null);
  syncTrackPreview();
}

export function syncTrackPreview(): void {
  if (!video) return;
  const multitrack = hasTrackPreview();
  video.muted = multitrack || edit.mute;
  if (!multitrack || loadedPath !== edit.media?.path) {
    pauseTrackPreview();
    return;
  }
  for (const track of active?.tracks ?? []) {
    if (track.element.playbackRate !== video.playbackRate) {
      track.element.playbackRate = video.playbackRate;
    }
    applyElementGain(track.element, currentGain(track.info.index));
  }
  if (edit.reverse) pauseTrackPreview();
}

export function playTrackPreview(): void {
  if (!hasTrackPreview() || loadedPath !== edit.media?.path || edit.reverse) return;
  desiredTime = video?.currentTime ?? 0;
  failedStart = null;
  ensureWindow(desiredTime);
  if (!contains(active, desiredTime)) return;
  syncTrackPreview();
  alignTracks(desiredTime);
  const playGeneration = generation;
  for (const { element } of active?.tracks ?? []) {
    void enableElementBoost(element).then((attached) => {
      if (attached && active?.tracks.some((track) => track.element === element)) syncTrackPreview();
    });
    if (!element.paused) continue;
    void element.play().catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (playGeneration !== generation || !active?.tracks.some((track) => track.element === element)) return;
      pauseTrackPreview();
      setStatus('Audio preview unavailable');
    });
  }
  scheduleMeters();
}

export function pauseTrackPreview(): void {
  for (const { element } of active?.tracks ?? []) element.pause();
  stopMeters();
  clearLevels();
}

export function seekTrackPreview(time: number): void {
  desiredTime = time;
  failedStart = null;
  if (edit.reverse) return;
  ensureWindow(time);
  alignTracks(time);
  if (video && !video.paused && contains(active, time)) playTrackPreview();
}

export function tickTrackPreview(time: number): void {
  if (!video || video.paused || edit.reverse || !hasTrackPreview()) return;
  desiredTime = time;
  ensureWindow(time);
  alignTracks(time);
  syncTrackPreview();
}

function windowStart(time: number): number {
  return Math.floor(Math.max(0, time) / WINDOW_STEP_SECONDS) * WINDOW_STEP_SECONDS;
}

function contains(window: PreviewWindow | null, time: number): boolean {
  return window !== null && time >= window.start && time < window.start + window.duration;
}

function ensureWindow(time: number): void {
  if (!hasTrackPreview() || loadedPath !== edit.media?.path) return;
  if (contains(standby, time)) activateStandby();
  if (!contains(active, time)) {
    pauseTrackPreview();
    if (failedStart !== windowStart(time)) setStatus('Preparing audio preview...');
    void requestWindow(windowStart(time));
    return;
  }
  const current = active!;
  const lead = Math.max(30, (video?.playbackRate ?? 1) * 3);
  const nextStart = current.start + WINDOW_STEP_SECONDS;
  const mediaEnd = edit.media?.duration ?? current.start + current.duration;
  if (time >= current.start + current.duration - lead && nextStart < mediaEnd) {
    void requestWindow(nextStart);
  }
}

function requestWindow(start: number): Promise<void> {
  const path = loadedPath;
  if (!path || !hasTrackPreview() || failedStart === start
    || active?.start === start || standby?.start === start) return Promise.resolve();
  if (wanted?.path !== path || wanted.start !== start || wanted.generation !== generation) {
    wanted = { path, start, generation, expected: [...mediaTracks()] };
  }
  loading ??= drainRequests().finally(() => { loading = null; });
  return loading;
}

async function drainRequests(): Promise<void> {
  while (wanted) {
    const request = wanted;
    let created: TrackState[] = [];
    try {
      const result = await makeAudioPreviews(request.path, request.start);
      if (request !== wanted || request.generation !== generation) continue;
      if (result.paths.length < request.expected.length || result.duration <= 0) {
        throw new Error('Audio preview returned incomplete tracks');
      }
      created = request.expected.map((info, ordinal) => createTrack(info, assetUrl(result.paths[ordinal])));
      await Promise.all(created.map(({ element }) => waitUntilReady(element)));
      if (request !== wanted || request.generation !== generation) {
        disposeTracks(created);
        continue;
      }
      disposeTracks(standby?.tracks ?? []);
      standby = { start: result.start, duration: result.duration, tracks: created };
      created = [];
      wanted = null;
      if (contains(standby, desiredTime)) activateStandby();
    } catch {
      disposeTracks(created);
      if (request !== wanted || request.generation !== generation) continue;
      wanted = null;
      failedStart = request.start;
      if (!contains(active, desiredTime)) setStatus('Audio preview unavailable');
    }
  }
}

function activateStandby(): void {
  if (!standby) return;
  disposeTracks(active?.tracks ?? []);
  active = standby;
  standby = null;
  setStatus(null);
  syncTrackPreview();
  alignTracks(desiredTime);
  if (video && !video.paused && !edit.reverse) playTrackPreview();
}

function alignTracks(time: number): void {
  if (!contains(active, time)) return;
  const localTime = time - active!.start;
  for (const { element } of active!.tracks) {
    if (Math.abs(element.currentTime - localTime) > DRIFT_SECONDS) {
      element.currentTime = Math.min(localTime, element.duration);
    }
  }
}

function createTrack(info: AudioTrackInfo, url: string): TrackState {
  const element = document.createElement('audio');
  element.preload = 'auto';
  element.crossOrigin = 'anonymous';
  element.preservesPitch = true;
  element.src = url;
  element.load();
  return { info, element };
}

function waitUntilReady(element: HTMLAudioElement): Promise<void> {
  return new Promise((resolve, reject) => {
    if (element.readyState >= HTMLMediaElement.HAVE_METADATA) {
      resolve();
      return;
    }
    let timer = 0;
    const finish = (error?: Error) => {
      window.clearTimeout(timer);
      element.removeEventListener('loadedmetadata', loaded);
      element.removeEventListener('error', failed);
      if (error) reject(error);
      else resolve();
    };
    const loaded = () => finish();
    const failed = () => finish(new Error('Audio preview failed to load'));
    element.addEventListener('loadedmetadata', loaded);
    element.addEventListener('error', failed);
    timer = window.setTimeout(() => finish(new Error('Audio preview timed out')), LOAD_TIMEOUT_MS);
  });
}

function currentGain(index: number): number {
  const track = edit.audioTracks.find((candidate) => candidate.index === index);
  return edit.mute || track?.mute
    ? 0
    : edit.volume * (track?.volume ?? 1) * (edit.normalize ? normalizeGain() : 1);
}

function disposeTracks(tracks: TrackState[]): void {
  for (const { element } of tracks) {
    element.pause();
    disposeElementGain(element);
    element.removeAttribute('src');
    element.load();
  }
}

function disposeWindows(): void {
  disposeTracks(active?.tracks ?? []);
  disposeTracks(standby?.tracks ?? []);
  active = null;
  standby = null;
  loadedPath = null;
  stopMeters();
  clearLevels();
}

function scheduleMeters(): void {
  if (meterFrame || !levelListeners.size || !active || !video || video.paused || edit.reverse) return;
  meterFrame = requestAnimationFrame(updateMeters);
}

function updateMeters(now: number): void {
  meterFrame = 0;
  const decay = Math.exp(-Math.min(100, now - meterTime) / 160);
  meterTime = now;
  for (const { info, element } of active?.tracks ?? []) {
    levels.set(info.index, Math.max(elementLevel(element), (levels.get(info.index) ?? 0) * decay));
  }
  for (const listener of levelListeners) listener(levels);
  scheduleMeters();
}

function stopMeters(): void {
  if (meterFrame) cancelAnimationFrame(meterFrame);
  meterFrame = 0;
  meterTime = 0;
}

function clearLevels(): void {
  levels.clear();
  for (const info of mediaTracks()) levels.set(info.index, 0);
  for (const listener of levelListeners) listener(levels);
}

function setStatus(next: string | null): void {
  if (status === next) return;
  status = next;
  refresh();
}
