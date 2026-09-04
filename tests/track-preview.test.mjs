import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

class FakeAudio {
  constructor() {
    this.currentTime = 0;
    this.duration = 30;
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
      enableElementBoost: async () => true,
    },
    './ipc': {
      assetUrl: (path) => `asset:${path}`,
      makeAudioPreviews: (path) => {
        const call = deferred();
        extractions.push({ path, ...call });
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
  return { api: main.namespace, created, disposed, edit, extractions, gains, video };
}

function media(path) {
  return {
    path,
    audioTracks: [
      { index: 0, title: 'Game', codec: 'aac', channels: 2 },
      { index: 1, title: 'Mic', codec: 'aac', channels: 1 },
    ],
  };
}

async function finishLoad(run, paths = ['game.m4a', 'mic.m4a']) {
  const before = run.created.length;
  run.extractions.at(-1).resolve(paths);
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
  run.extractions[0].resolve(['old-1.m4a', 'old-2.m4a']);
  await oldLoad;
  assert.equal(run.created.length, 0);

  const newTracks = await finishLoad(run, ['new-1.m4a', 'new-2.m4a']);
  await newLoad;
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
