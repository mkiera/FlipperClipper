import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

async function harness() {
  const source = await readFile(new URL('../src/mixer-window.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  let resolveGrow;
  const shrinkCalls = [];
  const grow = new Promise((resolve) => {
    resolveGrow = resolve;
  });
  const context = vm.createContext({ window: { __TAURI_INTERNALS__: {} } });
  const ipc = new vm.SyntheticModule(['growWindowForMixer', 'shrinkWindowAfterMixer'], function () {
    this.setExport('growWindowForMixer', () => grow);
    this.setExport('shrinkWindowAfterMixer', async (...args) => {
      shrinkCalls.push(args);
    });
  }, { context });
  const module = new vm.SourceTextModule(code, { context });
  await module.link((specifier) => {
    if (specifier === './ipc') return ipc;
    throw new Error(`Unexpected import ${specifier}`);
  });
  await module.evaluate();
  return { namespace: module.namespace, resolveGrow, shrinkCalls };
}

test('shrinks a stale grow response after close', async () => {
  const { namespace, resolveGrow, shrinkCalls } = await harness();
  const resize = namespace.initMixerWindowResize();
  const opening = resize.open(120);
  const closing = resize.close();
  resolveGrow({ addedHeight: 84, originalY: 480, openedY: 396 });
  await Promise.all([opening, closing]);
  assert.deepEqual(shrinkCalls, [[84, 480, 396]]);
});
