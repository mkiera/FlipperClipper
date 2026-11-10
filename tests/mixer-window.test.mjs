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

async function loadWith(globals, ipc) {
  const source = await readFile(new URL('../src/mixer-window.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const context = vm.createContext(globals);
  const module = new vm.SourceTextModule(code, { context });
  await module.link(async () => {
    const names = Object.keys(ipc);
    return new vm.SyntheticModule(names, function () {
      for (const name of names) this.setExport(name, ipc[name]);
    }, { context });
  });
  await module.evaluate();
  return module.namespace;
}

test('lane changes that overlap leave the video area unpinned once the window settles', async () => {
  const workspace = { style: { flex: '', height: '' }, getBoundingClientRect: () => ({ height: 653 }) };
  const globals = {
    window: { __TAURI_INTERNALS__: {} },
    document: { getElementById: () => workspace },
    requestAnimationFrame: (run) => setTimeout(run, 0),
  };
  const calls = [];
  const slow = () => new Promise((resolve) => setTimeout(resolve, 5));
  const ipc = {
    growWindowForMixer: async (added) => {
      calls.push(['grow', added]);
      await slow();
      return { addedHeight: added, originalY: 100, openedY: 100 };
    },
    shrinkWindowAfterMixer: async (amount, originalY) => {
      calls.push(['shrink', amount, originalY]);
      await slow();
    },
  };
  const { initStripWindowResize } = await loadWith(globals, ipc);
  const resize = initStripWindowResize();
  assert.ok(resize, 'no resize outside Tauri');

  resize(20);
  resize(36);
  resize(0);
  assert.equal(workspace.style.height, '653px');
  for (let i = 0; i < 20 && workspace.style.height !== ''; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual({ ...workspace.style }, { flex: '', height: '' });
  assert.deepEqual(calls, [
    ['grow', 20],
    ['grow', 16],
    ['shrink', 36, 100],
  ]);
});

test('the mixer and the keyframe lane pinning at once leave the video area free in either release order', async () => {
  for (const order of [['a', 'b'], ['b', 'a']]) {
    const workspace = { style: { flex: '', height: '' }, getBoundingClientRect: () => ({ height: 653 }) };
    const { pinWorkspace } = await loadWith(
      { window: { __TAURI_INTERNALS__: {} }, document: { getElementById: () => workspace } },
      { growWindowForMixer: async () => ({}), shrinkWindowAfterMixer: async () => {} },
    );
    const releases = { a: pinWorkspace(), b: pinWorkspace() };
    releases[order[0]]();
    assert.equal(workspace.style.height, '653px', `still held after ${order[0]}`);
    releases[order[1]]();
    assert.deepEqual({ ...workspace.style }, { flex: '', height: '' }, order.join(' then '));
  }
});
