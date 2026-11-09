import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

class FakeElement {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.parent = null;
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.className = '';
    this.title = '';
    this.style = {};
    this.listeners = {};
    const classes = new Set();
    this.classList = { add: (c) => classes.add(c), remove: (c) => classes.delete(c) };
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }
  appendChild(node) {
    node.parent = this;
    this.children.push(node);
    return node;
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }
  setAttribute() {}
  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }
  click() {
    this.listeners.click?.();
  }
  find(className) {
    return this.children.find((child) => child.className === className);
  }
}

async function harness() {
  const source = await readFile(new URL('../src/updater.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;

  const body = new FakeElement('body');
  const head = new FakeElement('head');
  const storage = new Map();
  const timeouts = [];
  const intervals = [];
  const clock = { now: 0 };
  const calls = { check: 0 };

  const context = vm.createContext({
    document: {
      body,
      head,
      createElement: (tag) => new FakeElement(tag),
      getElementById: () => null,
    },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    window: {
      setTimeout: (fn, ms) => timeouts.push({ fn, ms }),
      setInterval: (fn, ms) => intervals.push({ fn, ms }),
    },
    Date: { now: () => clock.now },
  });
  const ipc = new vm.SyntheticModule(['applyUpdate', 'checkForUpdate', 'onUpdateProgress'], function () {
    this.setExport('applyUpdate', () => new Promise(() => {}));
    this.setExport('checkForUpdate', async () => {
      calls.check += 1;
      return null;
    });
    this.setExport('onUpdateProgress', async () => () => {});
  }, { context });
  const state = new vm.SyntheticModule(['settings'], function () {
    this.setExport('settings', { autoCheckUpdates: true });
  }, { context });
  const types = new vm.SyntheticModule([], function () {}, { context });

  const module = new vm.SourceTextModule(code, { context });
  await module.link((specifier) => {
    if (specifier === './ipc') return ipc;
    if (specifier === './state') return state;
    if (specifier === './types') return types;
    throw new Error(`Unexpected import ${specifier}`);
  });
  await module.evaluate();
  return {
    namespace: module.namespace,
    body,
    clock,
    calls,
    timeouts,
    intervals,
  };
}

function release(version) {
  return {
    version,
    releaseUrl: `https://example.invalid/v${version}`,
    downloadUrl: 'https://example.invalid/setup.exe',
    assetName: 'FlipperClipper-Setup.exe',
    sizeBytes: 10,
    prerelease: false,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('a check during a download leaves the downloading pill alone', async () => {
  const { namespace, body } = await harness();
  namespace.showUpdate(release('1.2.0'));
  const pill = body.children[0];
  pill.find('fc-update-action').click();
  await flush();

  namespace.showUpdate(release('1.3.0'), true);

  assert.equal(body.children.length, 1);
  assert.equal(body.children[0], pill);
  assert.equal(pill.find('fc-update-label').textContent, 'Downloading…');
});

test('the hourly recheck runs on its first tick', async () => {
  const { namespace, clock, calls, timeouts, intervals } = await harness();
  namespace.initUpdater();
  const [first] = timeouts;
  const [recheck] = intervals;

  clock.now = first.ms;
  first.fn();
  await flush();
  assert.equal(calls.check, 1);

  clock.now = recheck.ms;
  recheck.fn();
  await flush();
  assert.equal(calls.check, 2);
});
