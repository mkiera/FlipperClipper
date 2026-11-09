import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

async function effects() {
  const source = await readFile(new URL('../src/effects.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = new vm.SourceTextModule(code, { context: vm.createContext({}) });
  await module.link((specifier) => {
    throw new Error(`Unexpected import ${specifier}`);
  });
  await module.evaluate();
  return module.namespace;
}

test('redact is off by default and sends nothing', async () => {
  const fx = await effects();
  const state = fx.defaultEffects();
  assert.equal(state.on.redact, false);
  assert.equal(fx.toEffectsJob(state, false).redact, null);
});

test('a switched-on redact sends its mode, strength and region', async () => {
  const fx = await effects();
  let state = fx.withSwitch(fx.defaultEffects(), 'redact', true);
  state = fx.withSetting(state, 'redact', { mode: 'blur', strength: 20 });
  const job = fx.toEffectsJob(state, false);
  assert.equal(job.redact.mode, 'blur');
  assert.equal(job.redact.strength, 20);
  assert.deepEqual({ ...job.redact.region }, { x: 0.35, y: 0.35, w: 0.3, h: 0.3 });
});

test('an audio-only export drops the redact', async () => {
  const fx = await effects();
  const state = fx.withSwitch(fx.defaultEffects(), 'redact', true);
  assert.equal(fx.toEffectsJob(state, true).redact, null);
});

test('a region dragged past the edge is sent back inside the frame', async () => {
  const fx = await effects();
  let state = fx.withSwitch(fx.defaultEffects(), 'redact', true);
  state = fx.withSetting(state, 'redact', { region: { x: 0.9, y: -0.2, w: 0.5, h: 0.001 } });
  const { region } = fx.toEffectsJob(state, false).redact;
  assert.ok(region.x >= 0 && region.x + region.w <= 1, JSON.stringify(region));
  assert.ok(region.y >= 0 && region.y + region.h <= 1, JSON.stringify(region));
  assert.equal(region.w, 0.5);
  assert.equal(region.h, fx.REDACT_MIN);
});

test('redact sits between the vignette and the text in the tab', async () => {
  const fx = await effects();
  const ids = fx.EFFECT_IDS;
  assert.ok(ids.indexOf('vignette') < ids.indexOf('redact'));
  assert.ok(ids.indexOf('redact') < ids.indexOf('text'));
  assert.equal(fx.effectSummary(fx.defaultEffects(), 'redact'), 'Pixelate');
});
