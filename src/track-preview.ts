import { applyElementGain, disposeElementGain, enableElementBoost } from './audio';
import { assetUrl, makeAudioPreviews } from './ipc';
import { normalizeGain } from './loudness';
import { edit, refresh } from './state';
import type { AudioTrackInfo } from './types';

const LOAD_TIMEOUT_MS = 15_000;
const DRIFT_SECONDS = 0.08;

interface TrackState {
  info: AudioTrackInfo;
  element: HTMLAudioElement;
}

let video: HTMLVideoElement | null = null;
let tracks: TrackState[] = [];
let status: string | null = null;
let generation = 0;
let loadedPath: string | null = null;

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

export async function loadTrackPreviews(path: string): Promise<void> {
  const expected = mediaTracks();
  const loadGeneration = ++generation;
  disposeElements();

  if (expected.length <= 1) {
    setStatus(null);
    syncTrackPreview();
    return;
  }

  setStatus('Preparing audio preview...');
  syncTrackPreview();

  try {
    const paths = await makeAudioPreviews(path);
    if (loadGeneration !== generation || edit.media?.path !== path) return;
    if (paths.length < expected.length) throw new Error('Audio preview returned too few tracks');

    loadedPath = path;
    tracks = expected.map((info, ordinal) => createTrack(info, assetUrl(paths[ordinal])));
    await Promise.all(tracks.map(({ element }) => waitUntilReady(element)));
    if (loadGeneration !== generation || edit.media?.path !== path) return;

    setStatus(null);
    seekTrackPreview(video?.currentTime ?? 0);
    syncTrackPreview();
    if (video && !video.paused && !edit.reverse) playTrackPreview();
  } catch {
    if (loadGeneration !== generation) return;
    disposeElements();
    setStatus('Audio preview unavailable');
    syncTrackPreview();
  }
}

export function clearTrackPreviews(): void {
  generation += 1;
  disposeElements();
  setStatus(null);
  syncTrackPreview();
}

export function syncTrackPreview(): void {
  if (!video) return;
  const multitrack = hasTrackPreview();
  video.muted = multitrack || edit.mute;
  if (!multitrack) return;
  if (loadedPath !== edit.media?.path) {
    pauseTrackPreview();
    return;
  }

  const edits = edit.audioTracks;
  const rate = video.playbackRate;
  for (const track of tracks) {
    const trackEdit = edits.find((candidate) => candidate.index === track.info.index);
    const gain = edit.mute || trackEdit?.mute
      ? 0
      : edit.volume * (trackEdit?.volume ?? 1) * (edit.normalize ? normalizeGain() : 1);
    track.element.playbackRate = rate;
    track.element.preservesPitch = true;
    if (gain > 1) {
      void enableElementBoost(track.element).then((attached) => {
        if (attached) {
          applyElementGain(track.element, currentGain(track.info.index));
          refresh();
        }
      });
    }
    applyElementGain(track.element, gain);
  }

  if (edit.reverse) pauseTrackPreview();
}

export function playTrackPreview(): void {
  if (!hasTrackPreview() || loadedPath !== edit.media?.path || edit.reverse) return;
  syncTrackPreview();
  const at = video?.currentTime ?? 0;
  const playGeneration = generation;
  for (const { element } of tracks) {
    if (Math.abs(element.currentTime - at) > DRIFT_SECONDS) element.currentTime = at;
    void element.play().catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (playGeneration !== generation || !tracks.some((track) => track.element === element)) return;
      pauseTrackPreview();
      setStatus('Audio preview unavailable');
    });
  }
}

export function pauseTrackPreview(): void {
  for (const { element } of tracks) element.pause();
}

export function seekTrackPreview(time: number): void {
  for (const { element } of tracks) {
    if (Number.isFinite(element.duration)) {
      element.currentTime = Math.min(Math.max(time, 0), element.duration);
    }
  }
}

export function tickTrackPreview(time: number): void {
  if (!video || video.paused || edit.reverse) return;
  for (const { element } of tracks) {
    if (Math.abs(element.currentTime - time) > DRIFT_SECONDS) element.currentTime = time;
  }
  syncTrackPreview();
}

function createTrack(info: AudioTrackInfo, url: string): TrackState {
  const element = document.createElement('audio');
  element.preload = 'auto';
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

function disposeElements(): void {
  for (const { element } of tracks) {
    element.pause();
    disposeElementGain(element);
    element.removeAttribute('src');
    element.load();
  }
  tracks = [];
  loadedPath = null;
}

function setStatus(next: string | null): void {
  if (status === next) return;
  status = next;
  refresh();
}
