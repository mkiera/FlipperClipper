import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

async function load(name, context, links = {}) {
  const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = new vm.SourceTextModule(code, { context });
  await module.link((specifier) => {
    const linked = links[specifier];
    if (!linked) throw new Error(`Unexpected import ${specifier}`);
    return linked;
  });
  await module.evaluate();
  return module;
}

async function sequence() {
  const context = vm.createContext({});
  const ramp = await load('ramp', context, {});
  const types = await load('types', context, { './ramp': ramp });
  const seq = await load('sequence', context, { './types': types });
  return seq.namespace;
}

const plain = (value) => JSON.parse(JSON.stringify(value));

function media(path, duration, tracks = 1) {
  return {
    path,
    duration,
    width: 1920,
    height: 1080,
    fps: 60,
    rotation: 0,
    hasAudio: tracks > 0,
    videoCodec: 'h264',
    audioCodec: tracks > 0 ? 'aac' : null,
    audioTracks: Array.from({ length: tracks }, (_, index) => ({ index, title: null, codec: 'aac', channels: 2 })),
    sizeBytes: duration * 1000,
  };
}

const A = media('C:\\clips\\a.mp4', 10);
const B = media('C:\\clips\\b.mp4', 6, 6);
const whole = (m, id) => ({ id, media: m, start: 0, end: m.duration });

function effects(keys = [], redactKeys = []) {
  return {
    on: { blur: false, redact: redactKeys.length > 0 },
    settings: {
      blur: { sigma: 8, keys },
      fade: { inSeconds: 0, outSeconds: 0 },
      redact: { items: [{ id: 1, on: true, keys: redactKeys }] },
    },
  };
}

test('one file played whole, split or not, is plain', async () => {
  const s = await sequence();
  assert.equal(s.isPlain([whole(A, 1)]), true);
  const split = s.splitAt([whole(A, 1)], 4);
  assert.equal(split.length, 2);
  assert.equal(s.isPlain(split), true);
  assert.equal(s.isPlain(s.moveClip(split, 0, 1)), false);
  assert.equal(s.isPlain([whole(A, 1), whole(B, 2)]), false);
  assert.equal(s.isPlain([{ ...whole(A, 1), end: 8 }]), false);
});

test('timeline times map to a clip and a moment in its file', async () => {
  const s = await sequence();
  // b[2,6] then a[0,10]: 4 s then 10 s.
  const clips = [{ id: 1, media: B, start: 2, end: 6 }, whole(A, 2)];
  assert.deepEqual(plain(s.locate(clips, 1)), { index: 0, local: 3 });
  assert.deepEqual(plain(s.locate(clips, 4)), { index: 1, local: 0 }, 'an edge belongs to the later clip');
  assert.deepEqual(plain(s.locate(clips, 4, true)), { index: 0, local: 6 }, 'an end belongs to the earlier one');
  assert.deepEqual(plain(s.locate(clips, 99)), { index: 1, local: 10 });
  assert.equal(s.timelineTime(clips, 1, 5), 9);
  assert.equal(s.totalDuration(clips), 14);
});

test('a split too close to an edge is refused', async () => {
  const s = await sequence();
  assert.equal(s.splitAt([whole(A, 1)], 0.05), null);
  assert.equal(s.splitAt([whole(A, 1)], 9.99), null);
  const split = s.splitAt([whole(A, 1)], 3);
  assert.deepEqual(plain(split.map((c) => [c.start, c.end])), [[0, 3], [3, 10]]);
  assert.notEqual(split[0].id, split[1].id);
});

test('the timeline is described by its first clip and its richest audio', async () => {
  const s = await sequence();
  const media = s.timelineMedia([whole(A, 1), { id: 2, media: B, start: 0, end: 3 }]);
  assert.equal(media.duration, 13);
  assert.equal(media.width, 1920);
  assert.equal(media.audioTracks.length, 6);
  assert.equal(media.path, A.path);
  assert.equal(s.timelineMedia([whole(A, 1)]), A, 'one file keeps its own media object');
});

test('a trim inside one clip moves with that clip', async () => {
  const s = await sequence();
  const before = [whole(A, 1), whole(B, 2)];
  const moved = s.remapEdit(
    { clips: before, inPoint: 11, outPoint: 15, ramp: [], effects: effects() },
    s.moveClip(before, 1, 0),
  );
  // b now starts at 0, so 1-5 s into it is 1-5 on the timeline.
  assert.equal(moved.inPoint, 1);
  assert.equal(moved.outPoint, 5);
});

test('a reorder that crosses the trim falls back to the whole timeline', async () => {
  const s = await sequence();
  const before = [whole(A, 1), whole(B, 2)];
  const after = s.moveClip(before, 1, 0);
  const moved = s.remapEdit(
    { clips: before, inPoint: 2, outPoint: 12, ramp: [], effects: effects() },
    after,
  );
  assert.equal(moved.inPoint, 0);
  assert.equal(moved.outPoint, 16);
});

test('keyframes follow their clip and are dropped with a removed one', async () => {
  const s = await sequence();
  const before = [whole(A, 1), whole(B, 2)];
  const reordered = s.moveClip(before, 1, 0);
  const moved = s.remapEdit(
    {
      clips: before,
      inPoint: 0,
      outPoint: 16,
      ramp: [{ t: 11, speed: 2 }],
      effects: effects([{ t: 1, v: 3, on: true }, { t: 13, v: 5, on: true }], [{ t: 12, x: 0, y: 0, w: 1, h: 1, on: true }]),
    },
    reordered,
  );
  assert.equal(moved.inPoint, 0);
  assert.equal(moved.outPoint, 16, 'an untrimmed timeline stays untrimmed');
  assert.deepEqual(plain(moved.ramp), [{ t: 1, speed: 2 }]);
  assert.deepEqual(plain(moved.effects.settings.blur.keys.map((k) => k.t)), [3, 7]);
  assert.deepEqual(plain(moved.effects.settings.redact.items[0].keys.map((k) => k.t)), [2]);

  const removed = s.removeClip(before, 1);
  const after = s.remapEdit(
    {
      clips: before,
      inPoint: 0,
      outPoint: 16,
      ramp: [],
      effects: effects([{ t: 1, v: 3, on: true }, { t: 13, v: 5, on: true }], [{ t: 12, x: 0, y: 0, w: 1, h: 1, on: true }]),
    },
    removed,
  );
  assert.equal(after.outPoint, 10);
  assert.deepEqual(plain(after.effects.settings.blur.keys.map((k) => k.t)), [1]);
  assert.equal(after.effects.settings.redact.items[0].on, false, 'a redaction whose footage is gone goes off');
});

test('effects with no keyframes are left as the same object', async () => {
  const s = await sequence();
  const before = [whole(A, 1), whole(B, 2)];
  const fx = effects();
  const moved = s.remapEdit({ clips: before, inPoint: 0, outPoint: 16, ramp: [], effects: fx }, s.moveClip(before, 0, 1));
  assert.equal(moved.effects, fx);
});

test('the last clip cannot be removed and the timeline has a ceiling', async () => {
  const s = await sequence();
  assert.equal(s.removeClip([whole(A, 1)], 0), null);
  const many = s.appendClips([], Array.from({ length: s.MAX_CLIPS + 5 }, () => A));
  assert.equal(many.length, s.MAX_CLIPS);
  assert.equal(new Set(many.map((c) => c.id)).size, s.MAX_CLIPS);
  assert.equal(s.splitAt(many, 5), null);
});

test('files are added in natural name order', async () => {
  const s = await sequence();
  const names = ['C:\\v\\Replay 10.mp4', 'C:\\v\\Replay 2.mp4', 'C:\\v\\replay 1.mp4'];
  assert.deepEqual([...names].sort(s.byFileName), ['C:\\v\\replay 1.mp4', 'C:\\v\\Replay 2.mp4', 'C:\\v\\Replay 10.mp4']);
});

test('the timeline key names the clips, or the file when there is one', async () => {
  const s = await sequence();
  assert.equal(s.timelineKey([whole(A, 1)]), A.path);
  const key = s.timelineKey([whole(A, 1), whole(B, 2)]);
  assert.notEqual(key, A.path);
  assert.notEqual(key, s.timelineKey([whole(B, 2), whole(A, 1)]));
});

test('a file on the timeline twice keeps each copy apart', async () => {
  const s = await sequence();
  const twice = [whole(A, 1), whole(A, 2)];
  assert.equal(s.remapTime(twice, twice, 12), 12);
  // Splitting the second copy at 15 leaves a keyframe at 17 where it was.
  const split = s.splitAt(twice, 15);
  assert.equal(s.remapTime(twice, split, 17), 17);
  assert.equal(s.remapTime(twice, split, 12), 12);
  assert.equal(s.remapTime(twice, split, 5), 5);
  // Moving the second copy first carries its keyframes along.
  assert.equal(s.remapTime(twice, s.moveClip(twice, 1, 0), 12), 2);
});
