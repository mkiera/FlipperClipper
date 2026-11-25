import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

async function fitModule() {
  const source = await readFile(new URL('../src/lensfit.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = new vm.SourceTextModule(code, { context: vm.createContext({}) });
  await module.link(() => {
    throw new Error('lensfit imports nothing');
  });
  await module.evaluate();
  return module.namespace;
}

/** A 640 x 360 frame: a lit disc with sky-like shading, a thin ring round it and a text block. */
function frame({ cx, cy, r, ring = true, text = true }) {
  const w = 640, h = 360, out = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      let v = 4;
      // Brighter in the middle, darker toward the horizon, as an all-sky picture is.
      if (d <= r) v = 60 + 120 * (1 - d / r) + ((x * 7 + y * 13) % 23);
      if (ring && Math.abs(d - r * 1.15) < 0.6) v = 200;
      if (text && x > 20 && x < 120 && y > 20 && y < 40 && (x + y) % 3 === 0) v = 230;
      out[y * w + x] = v;
    }
  }
  return out;
}

test('finds the round picture despite a ring and text drawn round it', async () => {
  const F = await fitModule();
  const got = F.findLensCircle(frame({ cx: 322, cy: 173, r: 134 }), 640, 360);
  assert.ok(got);
  assert.ok(Math.abs(got.cx - 322) < 1.5, `cx ${got.cx}`);
  assert.ok(Math.abs(got.cy - 173) < 1.5, `cy ${got.cy}`);
  assert.ok(Math.abs(got.r - 134) < 1.5, `r ${got.r}`);
});

test('finds a circle cut off by the top and bottom of the frame', async () => {
  const F = await fitModule();
  const got = F.findLensCircle(frame({ cx: 300, cy: 180, r: 220, ring: false }), 640, 360);
  assert.ok(got);
  assert.ok(Math.abs(got.cx - 300) < 2 && Math.abs(got.cy - 180) < 3 && Math.abs(got.r - 220) < 3, JSON.stringify(got));
});

test('finds nothing in a normal picture or a black one', async () => {
  const F = await fitModule();
  const w = 640, h = 360;
  const normal = new Uint8Array(w * h).map((_, i) => 40 + ((i % w) * 3 + Math.floor(i / w) * 5) % 180);
  assert.equal(F.findLensCircle(normal, w, h), null);
  assert.equal(F.findLensCircle(new Uint8Array(w * h), w, h), null);
});

test('a bright square is not taken for a lens circle', async () => {
  const F = await fitModule();
  const w = 640, h = 360, out = new Uint8Array(w * h);
  for (let y = 50; y < 309; y += 1) for (let x = 190; x < 449; x += 1) out[y * w + x] = 180;
  assert.equal(F.findLensCircle(out, w, h), null);
});

test('a picture that fades out toward its edge gives no circle rather than a small one', async () => {
  const F = await fitModule();
  const w = 640, h = 360;
  for (const fade of [(t) => 1 - t * t, (t) => Math.cos((t * Math.PI) / 2) ** 2]) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const t = Math.hypot(x + 0.5 - 320, y + 0.5 - 180) / 150;
        out[y * w + x] = t <= 1 ? Math.round(180 * fade(t)) : 3;
      }
    }
    assert.equal(F.findLensCircle(out, w, h), null);
  }
});
