import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

async function load(name, context) {
  const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  return new vm.SourceTextModule(code, { context });
}

async function types() {
  const context = vm.createContext({});
  const ramp = await load('ramp', context);
  const main = await load('types', context);
  await main.link(() => ramp);
  await main.evaluate();
  return main.namespace;
}

function trimOnly(path, format) {
  return {
    media: { path, width: 640, height: 360 },
    speed: 1,
    ramp: [],
    orientation: { rotate: 0, flipH: false, flipV: false },
    effects: { on: {} },
    crop: null,
    mute: false,
    reverse: false,
    normalize: false,
    volume: 1,
    audioTracks: [],
    outputHeight: null,
    videoKbps: null,
    audioOnly: false,
    format,
  };
}

test('lossless keeps the source container for the formats mp4, mov and webm hold', async () => {
  const { losslessEligible } = await types();
  assert.equal(losslessEligible(trimOnly('C:\\clips\\a.mp4', 'mp4')), true);
  assert.equal(losslessEligible(trimOnly('C:\\clips\\a.M4V', 'mp4')), true);
  assert.equal(losslessEligible(trimOnly('C:\\clips\\a.mov', 'mov')), true);
  assert.equal(losslessEligible(trimOnly('C:\\clips\\a.webm', 'webm')), true);
  assert.equal(losslessEligible(trimOnly('C:\\clips\\a.mkv', 'mkv')), true);
  assert.equal(losslessEligible(trimOnly('C:\\clips\\a.mp4', 'mkv')), true);
  assert.equal(losslessEligible(trimOnly('C:\\clips\\a.mp4', 'webm')), false);
});

test('lossless from WMV, OGV and other containers is only offered as mkv', async () => {
  const { losslessEligible } = await types();
  for (const path of ['C:\\clips\\a.wmv', 'C:\\clips\\a.ogv', 'C:\\clips\\a.avi', 'C:\\clips.v2\\noext']) {
    assert.equal(losslessEligible(trimOnly(path, 'mp4')), false, path);
    assert.equal(losslessEligible(trimOnly(path, 'mkv')), true, path);
  }
});
