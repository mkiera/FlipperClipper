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
  const effects = await load('effects', { './redact': { ...redact } });
  return { redact, fx: effects };
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
