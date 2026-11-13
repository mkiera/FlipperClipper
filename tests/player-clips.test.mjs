import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

class FakeVideo {
  constructor() {
    this.currentTime = 0;
    this.paused = true;
    this.ended = false;
    this.seeking = false;
    this.playbackRate = 1;
    this.preservesPitch = false;
    this.readyState = 0;
    this.muted = false;
    this.src = '';
    this.listeners = new Map();
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  dispatch(name) {
    for (const listener of this.listeners.get(name) ?? []) listener();
  }

  load() {
    this.currentTime = 0;
    this.paused = true;
  }

  pause() {
    this.paused = true;
  }

  play() {
    this.paused = false;
    return Promise.resolve();
  }

  removeAttribute() {}
}

async function transpile(name) {
  const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
}

async function harness() {
  const context = vm.createContext({
    console,
    performance,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    window: { setTimeout: () => 0, clearTimeout: () => {} },
    HTMLMediaElement: { HAVE_CURRENT_DATA: 2 },
    DOMException,
  });
  const real = {};
  const module = async (name, links) => {
    const m = new vm.SourceTextModule(await transpile(name), { context });
    await m.link((specifier) => {
      const linked = links[specifier];
      if (!linked) throw new Error(`Unexpected import ${specifier} from ${name}`);
      return linked;
    });
    await m.evaluate();
    return m;
  };
  real.ramp = await module('ramp', {});
  real.types = await module('types', { './ramp': real.ramp });
  real.sequence = await module('sequence', { './types': real.types });

  const listeners = new Set();
  const edit = {
    media: null,
    clips: [],
    src: null,
    inPoint: 0,
    outPoint: 0,
    speed: 1,
    ramp: [],
    mute: false,
    reverse: false,
    normalize: false,
    volume: 1,
  };
  const synthetic = (values) => {
    const m = new vm.SyntheticModule(Object.keys(values), function () {
      for (const [k, v] of Object.entries(values)) this.setExport(k, v);
    }, { context });
    return m;
  };
  const notify = () => {
    for (const l of [...listeners]) l();
  };
  const player = await module('player', {
    './state': synthetic({
      edit,
      patchUi: () => {},
      refresh: () => {},
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    }),
    './audio': synthetic({ applyGain: () => {}, enableBoost: async () => false }),
    './loudness': synthetic({ normalizeGain: () => 1 }),
    './ramp': real.ramp,
    './sequence': real.sequence,
    './types': real.types,
    './track-preview': synthetic({
      clearTrackPreviews: () => {},
      hasTrackPreview: () => false,
      initTrackPreview: () => {},
      pauseTrackPreview: () => {},
      playTrackPreview: () => {},
      seekTrackPreview: () => {},
      syncTrackPreview: () => {},
      tickTrackPreview: () => {},
      loadTrackPreviews: async () => {},
      onTrackLevels: () => () => {},
      trackPreviewStatus: () => null,
    }),
  });
  const api = player.namespace;
  const video = new FakeVideo();
  api.initPlayer(video);
  api.setClipUrl((path) => `asset:${path}`);
  return { api, video, edit, notify, seq: real.sequence.namespace };
}

const media = (path, duration) => ({ path, duration, fps: 30, audioTracks: [], hasAudio: false, sizeBytes: 0 });
const A = media('a.mp4', 10);
const B = media('b.mp4', 6);

function setTimeline(run, clips) {
  run.edit.clips = clips;
  run.edit.media = run.seq.timelineMedia(clips);
  run.edit.inPoint = 0;
  run.edit.outPoint = run.seq.totalDuration(clips);
  run.notify();
}

/** Finishes whatever load or seek the element is in the middle of. */
function settle(video) {
  video.readyState = 4;
  video.dispatch('loadedmetadata');
  video.dispatch('seeked');
}

test('a reorder keeps the playhead on the footage it was showing', async () => {
  const run = await harness();
  const clips = [{ id: 1, media: A, start: 0, end: 10 }, { id: 2, media: B, start: 0, end: 6 }];
  run.edit.clips = clips;
  run.edit.media = run.seq.timelineMedia(clips);
  run.edit.src = 'asset:a.mp4';
  run.api.loadSource('asset:a.mp4');
  setTimeline(run, clips);
  run.api.seek(12);
  settle(run.video);
  assert.equal(run.video.src, 'asset:b.mp4');
  assert.equal(run.api.currentTime(), 12);

  setTimeline(run, [clips[1], clips[0]]);
  settle(run.video);
  assert.equal(run.video.src, 'asset:b.mp4');
  assert.equal(run.video.currentTime, 2, 'still 2 s into b');
  assert.equal(run.api.currentTime(), 2);
});

test('pausing while another file loads does not start playback once it has loaded', async () => {
  const run = await harness();
  const clips = [{ id: 1, media: A, start: 0, end: 10 }, { id: 2, media: B, start: 0, end: 6 }];
  run.edit.clips = clips;
  run.edit.media = run.seq.timelineMedia(clips);
  run.api.loadSource('asset:a.mp4');
  setTimeline(run, clips);
  settle(run.video);
  run.api.play();
  assert.equal(run.video.paused, false);

  run.api.seek(12);
  run.api.pause();
  settle(run.video);
  assert.equal(run.video.src, 'asset:b.mp4');
  assert.equal(run.video.paused, true);
});

test('playback carries on from one file into the next', async () => {
  const run = await harness();
  const clips = [{ id: 1, media: A, start: 0, end: 10 }, { id: 2, media: B, start: 0, end: 6 }];
  run.edit.clips = clips;
  run.edit.media = run.seq.timelineMedia(clips);
  run.api.loadSource('asset:a.mp4');
  setTimeline(run, clips);
  settle(run.video);
  run.api.play();
  run.video.currentTime = 10;
  run.video.paused = true;
  run.video.ended = true;
  run.video.dispatch('ended');
  assert.equal(run.video.src, 'asset:b.mp4');
  run.video.ended = false;
  settle(run.video);
  assert.equal(run.video.paused, false, 'the next file plays on');
  assert.equal(run.api.currentTime(), 10);
});
