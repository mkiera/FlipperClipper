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
  const [x, y] = L.rayToFrame(lens, L.viewRay(lens, 0.5, 0.5), 3840, 2160);
  close(x, 1920, 1e-6);
  close(y, 1065 - (805 * 60) / 90, 1e-6);
  // The view's top edge points back toward the lens centre: the sky is up.
  const top = L.rayToFrame(lens, L.viewRay(lens, 0.5, 0), 3840, 2160);
  assert.ok(top[1] > y);
  // Panning 90 degrees turns the view clockwise round the circle, to the right.
  const right = L.rayToFrame(sky(L, { tilt: 60, pan: 90 }), L.viewRay(sky(L, { tilt: 60, pan: 90 }), 0.5, 0.5), 3840, 2160);
  close(right[0], 1920 + (805 * 60) / 90, 1e-6);
  close(right[1], 1065, 1e-6);
});

test('frame pixels and lens rays convert both ways for every projection', async () => {
  const L = await lensModule();
  for (const projection of ['equidistant', 'equisolid', 'stereographic', 'orthographic']) {
    const lens = sky(L, { projection });
    for (const [x, y] of [[1920, 1065], [2300, 900], [1300, 1500], [1920 + 800, 1065]]) {
      const back = L.rayToFrame(lens, L.frameToRay(lens, x, y), 3840, 2160);
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
  const out = L.lensOutputSize(lens, 3840);
  // 805 px across 90 degrees is 512.5 px per radian; 2 tan(35) of that is 717.7 px.
  assert.deepEqual(plain(out), { w: 718, h: 404 });
  assert.deepEqual(plain(L.lensOutputSize({ ...lens, size: 1080 }, 3840)), { w: 1920, h: 1080 });
  assert.deepEqual(plain(L.lensOutputSize({ ...lens, aspect: 9 / 16, size: 1080 }, 3840)), { w: 1080, h: 1920 });
  const job = L.lensJob(lens, 3840, 2160);
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
  for (const roll of [0, 30, 180]) {
  const tilted = sky(L, { pan: 30, tilt: 45, roll });
  const centre = L.viewRay(tilted, 0.5, 0.5);
  for (const [dx, dy] of [[40, 0], [-40, 0], [0, 40], [0, -40]]) {
    const moved = { ...tilted, ...L.dragSky(tilted, dx, dy, 1000) };
    const [u, v] = L.viewPoint(moved, centre);
    if (dx) assert.ok(Math.sign(u - 0.5) === Math.sign(dx), `dx ${dx}: u ${u}`);
    if (dy) assert.ok(Math.sign(v - 0.5) === Math.sign(dy), `dy ${dy}: v ${v}`);
    close(u, 0.5 + dx / 1000, 0.01);
    close(v, 0.5 + dy / 1000 * (16 / 9), 0.02);
  }
  }
});

test('past the lens field there is no picture, and a normal source has nothing behind it', async () => {
  const L = await lensModule();
  const lens = sky(L);
  // 95 degrees off the axis of a 180 degree lens.
  const beyond = [Math.sin(95 * RAD), 0, Math.cos(95 * RAD)];
  assert.equal(L.rayToFrame(lens, beyond, 3840, 2160), null);
  const normal = { ...lens, from: 'normal', sourceFov: 90 };
  assert.equal(L.rayToFrame(normal, [0, 0, -1], 1920, 1080), null);
  const centre = L.rayToFrame(normal, [0, 0, 1], 1920, 1080);
  close(centre[0], 960, 1e-6);
  close(centre[1], 540, 1e-6);
  // A 360 source has a picture in every direction.
  assert.ok(L.rayToFrame({ ...lens, from: 'equirect' }, [0, 0, -1], 3840, 1920));
});

test('rise shifts a normal view up without tilting it', async () => {
  const L = await lensModule();
  const lens = sky(L, { facing: 'forward', fov: 90, aspect: 1 });
  const ahead = [0, 0, 1];
  const [, level] = L.viewPoint(lens, ahead);
  const [, risen] = L.viewPoint({ ...lens, rise: 0.5 }, ahead);
  close(level, 0.5, 1e-9);
  // Half a half-height up moves what is straight ahead a quarter of the frame down.
  close(risen, 0.75, 1e-9);
  // Only a normal view takes the shift.
  assert.equal(L.viewOffset({ ...lens, to: 'panorama', rise: 0.5 }), 0);
});

test('every view keeps its shape at the centre, so its own size is the source detail', async () => {
  const L = await lensModule();
  for (const to of ['normal', 'panorama', 'equirect', 'fisheye', 'planet']) {
    const lens = sky(L, { to, fov: 120, aspect: 2 });
    const out = L.lensOutputSize(lens, 3840);
    assert.ok(out.w > 0 && out.h > 0 && out.w % 2 === 0 && out.h % 2 === 0, to);
    const v = L.verticalFov(lens);
    assert.ok(v > 0 && v <= 180, `${to}: ${v}`);
  }
});

test('a rise past what v360 can shift renders a taller view and keeps the right rows', async () => {
  const L = await lensModule();
  const lens = sky(L, { facing: 'forward', fov: 150, aspect: 16 / 9, size: 1080, rise: 0.8 });
  const job = L.lensJob(lens, 3840, 2160);
  assert.equal(job.height, 1080);
  // 80% of a 1080 frame more rows above it, and the output keeps the top 1080.
  assert.equal(job.renderHeight, 1080 + 864);
  assert.equal(job.cropY, 0);
  const t = Math.tan((L.verticalFov({ ...lens, aspect: job.width / job.height }) * RAD) / 2);
  close(Math.tan((job.vFov * RAD) / 2), t * (1944 / 1080), 1e-4);
  // The kept rows' centre is where the preview puts the frame's centre.
  const centreTan = -Math.tan((job.vFov * RAD) / 2) + t;
  close(centreTan, L.viewOffset({ ...lens, aspect: job.width / job.height }), 1e-3);
  // Down keeps the bottom rows instead, and no rise renders just the frame.
  const down = L.lensJob({ ...lens, rise: -0.5 }, 3840, 2160);
  assert.equal(down.cropY, down.renderHeight - down.height);
  const level = L.lensJob({ ...lens, rise: 0 }, 3840, 2160);
  assert.equal(level.renderHeight, level.height);
});

test('a sky view can be dragged down to look straight below', async () => {
  const L = await lensModule();
  let lens = sky(L, { tilt: 100 });
  for (let i = 0; i < 40; i += 1) lens = { ...lens, ...L.dragSky(lens, 0, -100, 1000) };
  assert.equal(lens.tilt, 180);
  const centre = L.viewRay(lens, 0.5, 0.5);
  close(centre[2], -1, 1e-9);
});

test('frame positions survive every turn and flip both ways', async () => {
  const L = await lensModule();
  const W = 3840, H = 2160;
  for (const rotate of [0, 90, 180, 270]) {
    for (const flipH of [false, true]) {
      for (const flipV of [false, true]) {
        const o = { rotate, flipH, flipV };
        const [x, y] = L.rawToTurned(1000, 300, o, W, H);
        const turned = rotate === 90 || rotate === 270;
        assert.ok(x >= 0 && x <= (turned ? H : W) && y >= 0 && y <= (turned ? W : H));
        const back = L.turnedToRaw(x, y, o, W, H);
        close(back[0], 1000, 1e-9);
        close(back[1], 300, 1e-9);
      }
    }
  }
  // A quarter turn clockwise puts the picture's top-left corner at the top right.
  assert.deepEqual(plain(L.rawToTurned(0, 0, { rotate: 90, flipH: false, flipV: false }, W, H)), [H, 0]);
});

test('dragging a wide normal view moves the picture at the centre as far as the pointer', async () => {
  const L = await lensModule();
  for (const fov of [40, 110, 150]) {
    const lens = sky(L, { tilt: 80, fov });
    const centre = L.viewRay(lens, 0.5, 0.5);
    const moved = { ...lens, ...L.dragSky(lens, 0, 20, 1000) };
    const [, v] = L.viewPoint(moved, centre);
    // 20 px down on a view 1000 px wide and 562.5 px high.
    close((v - 0.5) * 562.5, 20, 1);
  }
});

test('a risen and turned drag never jumps against the pointer', async () => {
  const L = await lensModule();
  // Where pan and tilt move the frame centre the same way (fov 110, rise 0.5, tilt 46, turn -45).
  const lens = sky(L, { tilt: 46, fov: 110, rise: 0.5, roll: -45 });
  const centre = L.viewRay(lens, 0.5, 0.5);
  const moved = { ...lens, ...L.dragSky(lens, -10, 0, 1000) };
  const [u, v] = L.viewPoint(moved, centre);
  assert.ok((u - 0.5) * 1000 <= 0, `u moved ${(u - 0.5) * 1000}`);
  assert.ok(Math.hypot((u - 0.5) * 1000, (v - 0.5) * 562.5) <= 12, `moved ${(u - 0.5) * 1000}, ${(v - 0.5) * 562.5}`);
});

test('a held drag along the limit on a risen, turned view moves smoothly', async () => {
  const L = await lensModule();
  let lens = sky(L, { tilt: 40, fov: 150, rise: 0.5, roll: 30 });
  for (let i = 0; i < 20; i += 1) {
    const centre = L.viewRay(lens, 0.5, 0.5);
    lens = { ...lens, ...L.dragSky(lens, 6, 0, 1000) };
    const [u, v] = L.viewPoint(lens, centre);
    const moved = Math.hypot((u - 0.5) * 1000, (v - 0.5) * 562.5);
    assert.ok(moved <= 7, `event ${i} moved ${moved}`);
  }
});

test('with a rise, what sits at the frame centre still follows the pointer', async () => {
  const L = await lensModule();
  const cases = [];
  for (const rise of [-0.8, 0, 0.8, 1]) cases.push({ tilt: 90, rise, roll: 0 });
  // Past the zenith, and with a turn: the frame's centre then moves both ways at once.
  cases.push({ tilt: 30, rise: 0.8, roll: 0 }, { tilt: 80, rise: 0.8, roll: 30 }, { tilt: 60, rise: -0.5, roll: -45 });
  for (const { tilt, rise, roll } of cases) {
    const lens = sky(L, { tilt, fov: 150, rise, pan: 10, roll });
    // The frame's centre, wherever the rise put the view's axis.
    const centre = L.viewRay(lens, 0.5, 0.5);
    for (const [dx, dy] of [[0, 10], [10, 0]]) {
      const moved = { ...lens, ...L.dragSky(lens, dx, dy, 1000) };
      const [u, v] = L.viewPoint(moved, centre);
      close((u - 0.5) * 1000, dx, 1.5);
      close((v - 0.5) * 562.5, dy, 1.5);
    }
  }
});

test('each lens type stops at the field it can describe', async () => {
  const L = await lensModule();
  assert.equal(L.lensField({ projection: 'orthographic', lensFov: 240 }), 180);
  assert.equal(L.lensField({ projection: 'stereographic', lensFov: 360 }), 300);
  assert.equal(L.lensField({ projection: 'equidistant', lensFov: 360 }), 360);
  // At its limit a stereographic lens still has a finite, usable size.
  const lens = sky(L, { projection: 'stereographic', lensFov: 360, size: null });
  const out = L.lensOutputSize(lens, 3840);
  assert.ok(out.w > 100 && Number.isFinite(out.w), JSON.stringify(out));
});

test('a fast drag on a risen wide view lands where the same drag in slow steps does', async () => {
  const L = await lensModule();
  const lens = sky(L, { tilt: 90, fov: 150, rise: 0.8, pan: 10 });
  // A diagonal one, where solving the whole move in one step would land 4 degrees off.
  for (const [dx, dy] of [[40, 0], [80, 0], [60, 60]]) {
    const fast = L.dragSky(lens, dx, dy, 800);
    let slow = lens;
    const n = Math.round(Math.hypot(dx, dy) / 4);
    for (let i = 0; i < n; i += 1) slow = { ...slow, ...L.dragSky(slow, dx / n, dy / n, 800) };
    close(fast.pan, slow.pan, 0.5);
    close(fast.tilt, slow.tilt, 0.5);
  }
  // Level too: the ring round the zenith grows as a diagonal drag tilts (150, tilt 30).
  const level = sky(L, { tilt: 30, fov: 150 });
  const one = L.dragSky(level, 40, 40, 800);
  let twenty = level;
  for (let i = 0; i < 20; i += 1) twenty = { ...twenty, ...L.dragSky(twenty, 2, 2, 800) };
  close(one.pan, twenty.pan, 1);
  close(one.tilt, twenty.tilt, 1);
  // Pressed against the zenith on a diagonal: the tilt stops at its limit in every step, so
  // the pan does not depend on how the move was cut into events.
  const top = sky(L, { tilt: 0, fov: 150, rise: 0.8, roll: 90 });
  const once = L.dragSky(top, 80, 80, 800);
  let many = top;
  for (let i = 0; i < 20; i += 1) many = { ...many, ...L.dragSky(many, 4, 4, 800) };
  close(once.pan, many.pan, 1);
  close(once.tilt, many.tilt, 1);
});
