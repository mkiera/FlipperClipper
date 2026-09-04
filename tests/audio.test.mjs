import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

async function harness({ suspended = false, blockedPlay = false } = {}) {
  let unblocked = false;
  const contexts = [];
  class Node {
    connections = [];
    gain = { value: 1 };
    fftSize = 1024;
    amplitude = 0.1;
    connect(node) { this.connections.push(node); }
    disconnect() { this.connections = []; }
    getFloatTimeDomainData(samples) { samples.fill(this.amplitude); }
  }
  class Context {
    state = suspended && !unblocked ? 'suspended' : 'running';
    destination = new Node();
    sources = [];
    closed = false;
    constructor() { contexts.push(this); }
    createGain() { return new Node(); }
    createAnalyser() { return new Node(); }
    createMediaElementSource(element) {
      const source = new Node();
      source.element = element;
      this.sources.push(source);
      return source;
    }
    resume() {
      if (this.state === 'suspended' && !unblocked) return new Promise(() => {});
      this.state = 'running';
      return Promise.resolve();
    }
    close() { this.closed = true; return Promise.resolve(); }
  }
  class Element {
    style = {};
    volume = 1;
    paused = true;
    set src(value) { this.url = value; queueMicrotask(() => this.onloadeddata?.()); }
    play() {
      if (blockedPlay && !unblocked) return Promise.reject(new DOMException('Gesture required', 'NotAllowedError'));
      this.paused = false;
      return Promise.resolve();
    }
    pause() { this.paused = true; }
    remove() {}
  }
  const source = await readFile(new URL('../src/audio.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const context = vm.createContext({
    AudioContext: Context,
    DOMException,
    URL,
    Blob,
    performance,
    document: { createElement: () => new Element(), body: { appendChild() {} } },
    window: { setTimeout: (callback, delay) => setTimeout(callback, Math.min(delay, 5)) },
  });
  const module = new vm.SourceTextModule(code, { context });
  await module.link(() => {});
  await module.evaluate();
  return { api: module.namespace, contexts, Element, unblock: () => { unblocked = true; } };
}

test('track analysers share a context and retain source levels when gain is muted', async () => {
  const { api, contexts, Element } = await harness();
  const first = new Element();
  const second = new Element();
  assert.deepEqual(await Promise.all([api.enableElementBoost(first), api.enableElementBoost(second)]), [true, true]);
  assert.equal(contexts.length, 2);
  const shared = contexts[1];
  assert.equal(shared.sources.length, 2);
  first.paused = false;
  second.paused = false;
  api.applyElementGain(first, 0);
  api.applyElementGain(second, 2);
  const firstAnalyser = shared.sources[0].connections[0];
  assert.equal(firstAnalyser.connections[0].gain.value, 0);
  assert.ok(Math.abs(api.elementLevel(first) - 2 / 3) < 0.0001);
  firstAnalyser.amplitude = 0;
  assert.equal(api.elementLevel(first), 0);
  api.disposeElementGain(first);
  assert.equal(shared.closed, false);
  assert.ok(api.elementLevel(second) > 0);
  second.paused = true;
  assert.equal(api.elementLevel(second), 0);
  api.disposeElementGain(second);
});

for (const blocked of [{ suspended: true }, { blockedPlay: true }]) {
  test(`retries the audio probe after ${Object.keys(blocked)[0]}`, async () => {
    const { api, contexts, Element, unblock } = await harness(blocked);
    const element = new Element();
    assert.equal(await api.enableElementBoost(element), false);
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].closed, true);
    unblock();
    assert.equal(await api.enableElementBoost(element), true);
    assert.equal(contexts.length, 3);
    element.paused = false;
    assert.ok(api.elementLevel(element) > 0);
    api.disposeElementGain(element);
  });
}
