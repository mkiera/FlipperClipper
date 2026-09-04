import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

class FakeAudio {
  constructor() {
    this.currentTime = 0;
    this.duration = 60;
    this.paused = true;
    this.playbackRate = 1;
    this.preservesPitch = false;
    this.readyState = 0;
    this.src = '';
    this.volume = 1;
    this.muted = false;
    this.playCount = 0;
    this.pauseCount = 0;
    this.listeners = new Map();
    this.nextPlay = null;
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  removeEventListener(name, listener) {
    this.listeners.get(name)?.delete(listener);
  }

  dispatch(name) {
    for (const listener of this.listeners.get(name) ?? []) listener();
  }

  load() {}

  pause() {
    this.paused = true;
    this.pauseCount += 1;
  }

  play() {
    this.paused = false;
    this.playCount += 1;
    return this.nextPlay ?? Promise.resolve();
  }

  removeAttribute(name) {
    if (name === 'src') this.src = '';
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function harness() {
  const source = await readFile(new URL('../src/track-preview.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const created = [];
  const gains = new Map();
  const disposed = [];
  const extractions = [];
  const frames = new Map();
  let frameId = 0;
  const readings = new Map();
  const attachments = [];
  const edit = {
    media: null,
    mute: false,
    reverse: false,
    normalize: false,
    volume: 1,
    audioTracks: [],
  };
  const context = vm.createContext({
    console,
    DOMException,
    performance,
    requestAnimationFrame: (callback) => { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame: (id) => frames.delete(id),
    setTimeout,
    clearTimeout,
    window: { setTimeout, clearTimeout },
    document: {
      createElement() {
        const audio = new FakeAudio();
        created.push(audio);
        return audio;
      },
    },
    HTMLMediaElement: { HAVE_METADATA: 1 },
  });
  const modules = {
    './audio': {
      applyElementGain: (element, gain) => gains.set(element, gain),
      disposeElementGain: (element) => disposed.push(element),
      enableElementBoost: async (element) => { attachments.push(element); return true; },
      elementLevel: (element) => readings.get(element) ?? 0,
    },
    './ipc': {
      assetUrl: (path) => `asset:${path}`,
      makeAudioPreviews: (path, start) => {
        const call = deferred();
        extractions.push({ path, start, ...call });
        return call.promise;
      },
    },
    './loudness': { normalizeGain: () => 2 },
    './state': { edit, refresh: () => {} },
  };
  const linked = new Map();
  const main = new vm.SourceTextModule(code, { context });
  await main.link(async (specifier) => {
    if (!linked.has(specifier)) {
      const values = modules[specifier];
      const module = new vm.SyntheticModule(Object.keys(values), function setExports() {
        for (const [name, value] of Object.entries(values)) this.setExport(name, value);
      }, { context });
      linked.set(specifier, module);
    }
    return linked.get(specifier);
  });
  await main.evaluate();
  const video = new FakeAudio();
  main.namespace.initTrackPreview(video);
  return { api: main.namespace, created, disposed, edit, extractions, gains, video, frames, readings, attachments };
}

function media(path) {
  return {
    path,
    duration: 1200,
    audioTracks: [
      { index: 0, title: 'Game', codec: 'aac', channels: 2 },
      { index: 1, title: 'Mic', codec: 'aac', channels: 1 },
    ],
  };
}

async function finishLoad(run, paths = ['game.m4a', 'mic.m4a']) {
  const before = run.created.length;
  const call = run.extractions.at(-1);
  call.resolve({ paths, start: call.start, duration: 60 });
  while (run.created.length < before + 2) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const pending = run.created.slice(-2);
  for (const audio of pending) {
    audio.readyState = 1;
    audio.dispatch('loadedmetadata');
  }
  await Promise.resolve();
  await Promise.resolve();
  return pending;
}

test('applies independent track controls and follows transport state', async () => {
  const run = await harness();
  run.edit.media = media('clip.mkv');
  run.edit.audioTracks = [
    { index: 0, volume: 2, mute: false },
    { index: 1, volume: 0.5, mute: false },
  ];
  run.edit.volume = 0.5;
  run.edit.normalize = true;
  run.video.currentTime = 4;
  run.video.paused = true;

  const loading = run.api.loadTrackPreviews('clip.mkv');
  const tracks = await finishLoad(run);
  await loading;
  assert.equal(run.video.muted, true);
  assert.equal(run.attachments.length, 0);
  assert.deepEqual(tracks.map((track) => run.gains.get(track)), [2, 0.5]);

  run.api.playTrackPreview();
  assert.deepEqual(tracks.map((track) => track.currentTime), [4, 4]);
  assert.deepEqual(tracks.map((track) => track.playCount), [1, 1]);

  run.api.seekTrackPreview(8);
  assert.deepEqual(tracks.map((track) => track.currentTime), [8, 8]);
  run.video.paused = false;
  run.video.playbackRate = 1.75;
  run.api.tickTrackPreview(8.2);
  assert.deepEqual(tracks.map((track) => track.currentTime), [8.2, 8.2]);
  assert.deepEqual(tracks.map((track) => track.playbackRate), [1.75, 1.75]);

  run.edit.audioTracks[1].mute = true;
  run.api.syncTrackPreview();
  assert.equal(run.gains.get(tracks[1]), 0);
  run.edit.audioTracks[1].mute = false;
  run.edit.normalize = false;
  run.edit.volume = 0.25;
  run.api.syncTrackPreview();
  assert.deepEqual(tracks.map((track) => run.gains.get(track)), [0.5, 0.125]);
  run.edit.mute = true;
  run.api.syncTrackPreview();
  assert.deepEqual(tracks.map((track) => run.gains.get(track)), [0, 0]);

  run.edit.mute = false;
  run.edit.reverse = true;
  run.api.syncTrackPreview();
  assert.ok(tracks.every((track) => track.paused));

  run.api.clearTrackPreviews();
  assert.deepEqual(run.disposed, tracks);
  assert.ok(tracks.every((track) => track.src === ''));
});

test('ignores stale extraction and playback failures from an old clip', async () => {
  const run = await harness();
  run.edit.media = media('old.mkv');
  run.edit.audioTracks = [
    { index: 0, volume: 1, mute: false },
    { index: 1, volume: 1, mute: false },
  ];
  const oldLoad = run.api.loadTrackPreviews('old.mkv');

  run.edit.media = media('new.mkv');
  const newLoad = run.api.loadTrackPreviews('new.mkv');
  run.extractions[0].resolve({ paths: ['old-1.m4a', 'old-2.m4a'], start: 0, duration: 60 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(run.created.length, 0);

  const newTracks = await finishLoad(run, ['new-1.m4a', 'new-2.m4a']);
  await newLoad;
  await oldLoad;
  assert.deepEqual(newTracks.map((track) => track.src), ['asset:new-1.m4a', 'asset:new-2.m4a']);

  const rejectedPlay = deferred();
  newTracks[0].nextPlay = rejectedPlay.promise;
  run.api.playTrackPreview();
  run.edit.media = media('third.mkv');
  run.api.syncTrackPreview();
  assert.ok(newTracks.every((track) => track.paused));
  void run.api.loadTrackPreviews('third.mkv');
  rejectedPlay.reject(new Error('old decoder failed'));
  await Promise.resolve();
  assert.equal(run.api.trackPreviewStatus(), 'Preparing audio preview...');
});

test('coalesces rapid seeks into one pending window and uses local timestamps', async () => {
  const run = await harness();
  run.edit.media = media('long.mp4');
  const loading = run.api.loadTrackPreviews('long.mp4');
  run.api.seekTrackPreview(135);
  run.api.seekTrackPreview(280);
  run.api.seekTrackPreview(281);
  assert.equal(run.extractions.length, 1);
  run.extractions[0].resolve({ paths: ['old-a', 'old-b'], start: 0, duration: 60 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(run.created.length, 0);
  assert.equal(run.extractions.length, 2);
  assert.equal(run.extractions[1].start, 270);
  const tracks = await finishLoad(run);
  await loading;
  assert.deepEqual(tracks.map((track) => track.currentTime), [11, 11]);
  assert.equal(run.api.trackPreviewStatus(), null);
  run.api.clearTrackPreviews();
});

test('prefetches the next window once and replaces tracks during overlap', async () => {
  const run = await harness();
  run.edit.media = media('long.mp4');
  const loading = run.api.loadTrackPreviews('long.mp4');
  const first = await finishLoad(run);
  await loading;
  run.video.currentTime = 30;
  run.video.paused = false;
  run.api.playTrackPreview();
  run.api.tickTrackPreview(30);
  run.api.tickTrackPreview(30.1);
  assert.equal(run.extractions.length, 2);
  assert.equal(run.extractions[1].start, 45);
  assert.ok(first.every((element) => !element.paused));
  const second = await finishLoad(run, ['next-a', 'next-b']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(first.every((element) => !element.paused));
  assert.ok(second.every((element) => element.paused));
  run.video.currentTime = 46;
  run.api.tickTrackPreview(46);
  assert.ok(first.every((element) => element.src === '' && element.paused));
  assert.ok(second.every((element) => !element.paused));
  assert.deepEqual(second.map((element) => element.currentTime), [1, 1]);
  run.video.currentTime = 60;
  run.api.tickTrackPreview(60);
  assert.deepEqual(second.map((element) => element.currentTime), [15, 15]);
  run.api.clearTrackPreviews();
});

test('meters emit separate source activity, stop on pause, and share one frame loop', async () => {
  const run = await harness();
  run.edit.media = media('long.mp4');
  run.edit.audioTracks = [{ index: 0, volume: 1, mute: true }, { index: 1, volume: 1, mute: false }];
  let latest;
  const unsubscribe = run.api.onTrackLevels((levels) => { latest = new Map(levels); });
  const loading = run.api.loadTrackPreviews('long.mp4');
  const tracks = await finishLoad(run);
  await loading;
  run.readings.set(tracks[0], 0.8);
  run.readings.set(tracks[1], 0.25);
  run.video.paused = false;
  run.api.playTrackPreview();
  run.api.playTrackPreview();
  assert.equal(run.frames.size, 1);
  const [id, callback] = [...run.frames.entries()][0];
  run.frames.delete(id);
  callback(16);
  assert.equal(latest.get(0), 0.8);
  assert.equal(latest.get(1), 0.25);
  assert.equal(run.gains.get(tracks[0]), 0);
  assert.equal(run.frames.size, 1);
  run.video.paused = true;
  run.api.pauseTrackPreview();
  assert.deepEqual([...latest.values()], [0, 0]);
  assert.equal(run.frames.size, 0);
  unsubscribe();
  run.api.clearTrackPreviews();
});

test('single track media keeps native playback and skips previews and meter work', async () => {
  const run = await harness();
  run.edit.media = media('single.mp4');
  run.edit.media.audioTracks.splice(1);
  await run.api.loadTrackPreviews('single.mp4');
  run.video.paused = false;
  run.api.playTrackPreview();
  run.api.tickTrackPreview(100);
  assert.equal(run.extractions.length, 0);
  assert.equal(run.created.length, 0);
  assert.equal(run.frames.size, 0);
  assert.equal(run.video.muted, false);
});
