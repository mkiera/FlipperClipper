import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

async function load(name, links = {}) {
  const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const context = vm.createContext({});
  const module = new vm.SourceTextModule(code, { context });
  await module.link(async (specifier) => {
    const linked = links[specifier];
    if (!linked) throw new Error(`Unexpected import ${specifier}`);
    const exports = Object.keys(linked);
    const synthetic = new vm.SyntheticModule(exports, function () {
      for (const key of exports) this.setExport(key, linked[key]);
    }, { context });
    return synthetic;
  });
  await module.evaluate();
  return module.namespace;
}

async function modules() {
  const redact = await load('redact');
  const valuekeys = await load('valuekeys');
  const effects = await load('effects', { './redact': { ...redact }, './valuekeys': { ...valuekeys } });
  return { redact, valuekeys, fx: effects };
}

const plain = (value) => JSON.parse(JSON.stringify(value));

const item = (over = {}) => ({
  id: 1,
  mode: 'pixelate',
  strength: 16,
  region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
  on: true,
  keys: [],
  ...over,
});

test('redact is off by default and sends nothing', async () => {
  const { fx } = await modules();
  const state = fx.defaultEffects();
  assert.equal(state.on.redact, false);
  assert.equal(state.settings.redact.items.length, 1);
  assert.deepEqual([...fx.toEffectsJob(state, false).redact], []);
});

test('a static redaction goes to the export as one keyframe', async () => {
  const { fx } = await modules();
  const state = fx.withSwitch(fx.defaultEffects(), 'redact', true);
  const [job] = fx.toEffectsJob(state, false).redact;
  assert.equal(job.mode, 'pixelate');
  assert.equal(job.keys.length, 1);
  assert.deepEqual({ ...job.keys[0] }, { t: 0, x: 0.35, y: 0.35, w: 0.3, h: 0.3, on: true });
});

test('an audio-only export and a never-shown redaction send nothing', async () => {
  const { fx } = await modules();
  let state = fx.withSwitch(fx.defaultEffects(), 'redact', true);
  assert.deepEqual([...fx.toEffectsJob(state, true).redact], []);
  state = fx.withSetting(state, 'redact', { items: [item({ on: false })] });
  assert.deepEqual([...fx.toEffectsJob(state, false).redact], []);
  assert.equal(fx.hasEffect(state, 'redact'), false);
});

test('position and size move between keyframes and visibility steps', async () => {
  const { redact } = await modules();
  const it = item({
    keys: [
      { t: 1, x: 0, y: 0, w: 0.2, h: 0.2, on: true },
      { t: 3, x: 0.4, y: 0.2, w: 0.4, h: 0.6, on: false },
    ],
  });
  const before = redact.stateAt(it, 0);
  assert.deepEqual({ ...before.region }, { x: 0, y: 0, w: 0.2, h: 0.2 });
  const mid = redact.stateAt(it, 2);
  assert.ok(Math.abs(mid.region.x - 0.2) < 1e-9 && Math.abs(mid.region.h - 0.4) < 1e-9);
  assert.equal(mid.on, true);
  assert.equal(redact.stateAt(it, 3).on, false);
  assert.equal(redact.stateAt(it, 9).on, false);
});

test('moving a static box changes it in place, moving a keyed one adds a keyframe', async () => {
  const { redact } = await modules();
  const moved = redact.withEdit(item(), 2, { region: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 } }, 0.02);
  assert.equal(moved.keys.length, 0);
  assert.equal(moved.region.x, 0.5);

  const keyed = item({ keys: [{ t: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.2, on: true }] });
  const added = redact.withEdit(keyed, 3, { region: { x: 0.6, y: 0.1, w: 0.2, h: 0.2 } }, 0.02);
  assert.deepEqual(plain(added.keys.map((k) => k.t)), [1, 3]);
  assert.equal(added.keys[1].x, 0.6);

  // Within half a frame of a keyframe, that keyframe changes instead of a new one appearing.
  const same = redact.withEdit(added, 3.01, { on: false }, 0.02);
  assert.deepEqual(plain(same.keys.map((k) => k.t)), [1, 3]);
  assert.equal(same.keys[1].on, false);
});

test('the keyframe button adds the showing state and removes the last key back to static', async () => {
  const { redact } = await modules();
  const one = redact.withKeyToggled(item(), 2, 0.02);
  assert.deepEqual(plain(one.keys.map((k) => [k.t, k.x])), [[2, 0.1]]);
  const back = redact.withKeyToggled(one, 2, 0.02);
  assert.equal(back.keys.length, 0);
  assert.equal(back.region.x, 0.1);
});

test('a keyframe dragged past its neighbour keeps its place in the sorted list', async () => {
  const { redact } = await modules();
  const it = item({
    keys: [
      { t: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.2, on: true },
      { t: 2, x: 0.3, y: 0.1, w: 0.2, h: 0.2, on: true },
    ],
  });
  const { item: moved, index } = redact.withKeyMoved(it, 0, 4);
  assert.deepEqual(plain(moved.keys.map((k) => k.t)), [2, 4]);
  assert.equal(index, 1);
  assert.equal(moved.keys[1].x, 0.1);
});

test('new redactions get fresh ids up to the limit and do not stack exactly', async () => {
  const { redact } = await modules();
  const first = redact.newRedaction([]);
  const second = redact.newRedaction([first]);
  assert.equal(second.id, first.id + 1);
  assert.notEqual(second.region.x, first.region.x);
  assert.equal(redact.REDACT_MAX_ITEMS, 8);
});

test('redact sits between the vignette and the text in the tab', async () => {
  const { fx } = await modules();
  const ids = fx.EFFECT_IDS;
  assert.ok(ids.indexOf('vignette') < ids.indexOf('redact'));
  assert.ok(ids.indexOf('redact') < ids.indexOf('text'));
  assert.equal(fx.effectSummary(fx.defaultEffects(), 'redact'), 'Pixelate');
});

test('the preview rebuilds every pixel an earlier redaction reads', async () => {
  const { redact } = await modules();
  const target = { x0: 400, y0: 400, x1: 437, y1: 437 };
  // An earlier 100 px pixelation covering the target reads its whole 100 px blocks.
  const coarse = { item: item({ mode: 'pixelate', strength: 100 }), region: { x: 0, y: 0, w: 1, h: 1 } };
  assert.deepEqual(plain(redact.sourceBounds(target, [coarse], 1000, 1000)), { x0: 400, y0: 400, x1: 500, y1: 500 });
  // A blur before that widens the 100 px blocks by three sigma, and a black box widens nothing.
  const blur = { item: item({ mode: 'blur', strength: 10 }), region: { x: 0, y: 0, w: 1, h: 1 } };
  const box = { item: item({ mode: 'box' }), region: { x: 0, y: 0, w: 1, h: 1 } };
  assert.deepEqual(plain(redact.sourceBounds(target, [blur, box, coarse], 1000, 1000)), { x0: 370, y0: 370, x1: 530, y1: 530 });
  // A redaction elsewhere in the frame changes nothing.
  const away = { item: item({ mode: 'blur', strength: 10 }), region: { x: 0.9, y: 0.9, w: 0.1, h: 0.1 } };
  assert.deepEqual(plain(redact.sourceBounds(target, [away], 1000, 1000)), target);
});

test('a keyframed dial moves between keyframes and switches off at a keyframe', async () => {
  const { fx } = await modules();
  let state = fx.withSwitch(fx.defaultEffects(), 'brightness', true);
  // Without keyframes the slider changes the dial for the whole clip.
  state = fx.withDial(state, 'brightness', 3, { v: 1.5 }, 0.02);
  assert.equal(state.settings.brightness.amount, 1.5);
  assert.equal(state.settings.brightness.keys.length, 0);

  state = fx.withEffectKeyToggled(state, 'brightness', 1, 0.02);
  state = fx.withDial(state, 'brightness', 3, { v: 0.5 }, 0.02);
  state = fx.withDial(state, 'brightness', 4, { on: false }, 0.02);
  assert.deepEqual(plain(state.settings.brightness.keys.map((k) => [k.t, k.v, k.on])), [
    [1, 1.5, true],
    [3, 0.5, true],
    [4, 0.5, false],
  ]);
  assert.ok(Math.abs(fx.dialAt(state, 'brightness', 2).v - 1) < 1e-9);
  assert.equal(fx.activeAt(state, 'brightness', 3.5), true);
  assert.equal(fx.activeAt(state, 'brightness', 4.5), false);
  assert.equal(fx.cssFilterFor(state, 1, 2), 'brightness(1)');
  assert.equal(fx.cssFilterFor(state, 1, 5), 'none');
  assert.equal(fx.effectSummary(state, 'brightness'), '3 keyframes');
});

test('the export gets each dial keyframes, and the first keyframe as the dial', async () => {
  const { fx } = await modules();
  let state = fx.withSwitch(fx.defaultEffects(), 'blur', true);
  state = fx.withEffectKeyToggled(state, 'blur', 2, 0.02);
  state = fx.withDial(state, 'blur', 4, { v: 20 }, 0.02);
  state = fx.withDial(state, 'blur', 2, { v: 3 }, 0.02);
  const job = fx.toEffectsJob(state, false);
  assert.equal(job.blur, 3);
  assert.deepEqual(plain(job.keys.blur), [
    { t: 2, v: 3, on: true },
    { t: 4, v: 20, on: true },
  ]);
  assert.deepEqual(plain(job.keys.brightness), []);
  // Keyframes that never switch it on send nothing.
  const off = fx.withSetting(state, 'blur', { keys: [{ t: 0, v: 3, on: false }] });
  assert.equal(fx.toEffectsJob(off, false).blur, null);
  assert.deepEqual(plain(fx.toEffectsJob(off, false).keys.blur), []);
});

test('text keyframes animate the opacity the export gets, and not the overlay fields', async () => {
  const { fx } = await modules();
  let state = fx.withSwitch(fx.defaultEffects(), 'text', true);
  state = fx.withSetting(state, 'text', { keys: [{ t: 1, v: 0.3, on: true }, { t: 2, v: 1, on: true }] });
  const job = fx.toEffectsJob(state, false);
  assert.equal(job.text.opacity, 0.3);
  assert.equal('keys' in job.text, false);
  assert.equal(job.keys.text.length, 2);
});

test('removing the last keyframe leaves the dial where that keyframe had it', async () => {
  const { fx } = await modules();
  let state = fx.withSwitch(fx.defaultEffects(), 'hue', true);
  state = fx.withSetting(state, 'hue', { keys: [{ t: 1, v: -90, on: true }] });
  state = fx.withoutEffectKey(state, 'hue', 0);
  assert.equal(state.settings.hue.keys.length, 0);
  assert.equal(state.settings.hue.degrees, -90);
});

test('a dial keyframe dragged past its neighbour keeps its place', async () => {
  const { valuekeys } = await modules();
  const keys = [
    { t: 1, v: 1, on: true },
    { t: 2, v: 2, on: true },
  ];
  const moved = valuekeys.withValueKeyMoved(keys, 0, 3);
  assert.deepEqual(plain(moved.keys.map((k) => k.t)), [2, 3]);
  assert.equal(moved.index, 1);
  assert.deepEqual(plain(valuekeys.onSpans([{ t: 1, on: false }, { t: 2, on: true }], 5)), [[2, 5]]);
});
