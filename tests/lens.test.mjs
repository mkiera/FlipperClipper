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

async function lensModule() {
  const context = vm.createContext({});
  const ramp = await load('ramp', context);
  const types = await load('types', context, { './ramp': ramp });
  return (await load('lens', context, { './types': types })).namespace;
}

const RAD = Math.PI / 180;
const plain = (value) => JSON.parse(JSON.stringify(value));
const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

// v360's own rotation, as measured against FFmpeg 6.1: Ry(yaw) Rx(pitch) Rz(roll).
function v360Matrix(L, { yaw, pitch, roll }) {
  const rx = (a) => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
  const ry = (a) => [[Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [-Math.sin(a), 0, Math.cos(a)]];
  const rz = (a) => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
  return L.mul(L.mul(ry(yaw * RAD), rx(pitch * RAD)), rz(roll * RAD));
}

function sky(L, patch = {}) {
  return { ...L.defaultLens(3840, 2160), cx: 1920, cy: 1065, r: 805, ...patch };
}

test('the angles handed to v360 rebuild the preview rotation', async () => {
  const L = await lensModule();
  for (const facing of ['up', 'forward']) {
    for (const [pan, tilt, roll] of [[0, 0, 0], [37, 50, 0], [-120, 80, 15], [170, 90, -30], [0, 90, 0], [90, 45, 180]]) {
      const lens = sky(L, { facing, pan, tilt, roll });
      const want = L.viewRotation(lens);
      const got = v360Matrix(L, L.v360Angles(want));
      for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) close(got[i][j], want[i][j], 1e-9);
    }
  }
});

test('a sky camera tilted toward the top of the picture looks there with the zenith above', async () => {
  const L = await lensModule();
  const lens = sky(L, { tilt: 60 });
  // The view's centre lands above the lens centre, 60 of the 90 degrees out.
  const [x, y] = L.rayToFrame(lens, L.viewRay(lens, 0.5, 0.5));
  close(x, 1920, 1e-6);
  close(y, 1065 - (805 * 60) / 90, 1e-6);
  // The view's top edge points back toward the lens centre: the sky is up.
  const top = L.rayToFrame(lens, L.viewRay(lens, 0.5, 0));
  assert.ok(top[1] > y);
  // Panning 90 degrees turns the view clockwise round the circle, to the right.
  const right = L.rayToFrame(sky(L, { tilt: 60, pan: 90 }), L.viewRay(sky(L, { tilt: 60, pan: 90 }), 0.5, 0.5));
  close(right[0], 1920 + (805 * 60) / 90, 1e-6);
  close(right[1], 1065, 1e-6);
});

test('frame pixels and lens rays convert both ways for every projection', async () => {
  const L = await lensModule();
  for (const projection of ['equidistant', 'equisolid', 'stereographic', 'orthographic']) {
    const lens = sky(L, { projection });
    for (const [x, y] of [[1920, 1065], [2300, 900], [1300, 1500], [1920 + 800, 1065]]) {
      const back = L.rayToFrame(lens, L.frameToRay(lens, x, y));
      close(back[0], x, 1e-6);
      close(back[1], y, 1e-6);
    }
  }
});

test('dragging keeps the grabbed point under the pointer', async () => {
  const L = await lensModule();
  for (const facing of ['up', 'forward']) {
    const lens = sky(L, { facing, pan: 20, tilt: 40 });
    const target = L.viewRay(lens, 0.3, 0.6);
    const aim = L.aimAt(lens, target, 0.55, 0.45);
    const moved = { ...lens, ...aim };
    const got = L.viewRay(moved, 0.55, 0.45);
    for (let i = 0; i < 3; i += 1) close(got[i], target[i], 1e-5);
  }
});

test('the native output size follows the lens detail at its centre', async () => {
  const L = await lensModule();
  const lens = sky(L, { fov: 70, aspect: 16 / 9 });
  const out = L.lensOutputSize(lens);
  // 805 px across 90 degrees is 512.5 px per radian; 2 tan(35) of that is 717.7 px.
  assert.deepEqual(plain(out), { w: 718, h: 404 });
  assert.deepEqual(plain(L.lensOutputSize({ ...lens, size: 1080 })), { w: 1920, h: 1080 });
  assert.deepEqual(plain(L.lensOutputSize({ ...lens, aspect: 9 / 16, size: 1080 })), { w: 1080, h: 1920 });
  const job = L.lensJob(lens);
  assert.equal(job.width, 718);
  close(job.vFov, 2 * Math.atan(Math.tan(35 * RAD) * (404 / 718)) / RAD, 1e-3);
});

test('a sky view follows the pointer in every direction, and leaves the zenith by dragging up', async () => {
  const L = await lensModule();
  const start = sky(L);
  // From straight up, dragging the picture up tilts toward the horizon; down has no room left.
  assert.ok(L.dragSky(start, 0, -100, 1000).tilt > 0);
  assert.equal(L.dragSky(start, 0, 100, 1000).tilt, 0);
  assert.notEqual(L.dragSky(start, 100, 0, 1000).pan, start.pan);
  // Away from the zenith, what was at the centre moves with the pointer.
  const tilted = sky(L, { pan: 30, tilt: 45 });
  const centre = L.viewRay(tilted, 0.5, 0.5);
  for (const [dx, dy] of [[40, 0], [-40, 0], [0, 40], [0, -40]]) {
    const moved = { ...tilted, ...L.dragSky(tilted, dx, dy, 1000) };
    const [u, v] = L.viewPoint(moved, centre);
    if (dx) assert.ok(Math.sign(u - 0.5) === Math.sign(dx), `dx ${dx}: u ${u}`);
    if (dy) assert.ok(Math.sign(v - 0.5) === Math.sign(dy), `dy ${dy}: v ${v}`);
    close(u, 0.5 + dx / 1000, 0.01);
    close(v, 0.5 + dy / 1000 * (16 / 9), 0.02);
  }
});
