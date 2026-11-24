// The fisheye view: fit the lens circle on the picture, then aim and zoom a flat view inside it.
// The preview is drawn on the GPU with the same camera model the export hands to v360.

import { contentBox } from './crop';
import {
  LENS_FOV_MAX,
  LENS_FOV_MIN,
  LENS_PROJECTIONS,
  LENS_SIZES,
  VIEW_FOV_MAX,
  VIEW_FOV_MIN,
  aimAt,
  defaultLens,
  lensOutputSize,
  rayToFrame,
  verticalFov,
  viewRay,
  viewRotation,
} from './lens';
import { onTime, videoElement } from './player';
import { edit, patchEdit, patchUi, subscribe, ui } from './state';
import { frameHeight, frameWidth } from './types';
import type { LensProjection, LensState } from './types';

type Tab = 'lens' | 'view';

const ASPECTS: { label: string; value: number }[] = [
  { label: '16:9', value: 16 / 9 },
  { label: '4:3', value: 4 / 3 },
  { label: '1:1', value: 1 },
  { label: '9:16', value: 9 / 16 },
];
const PROJECTION_CODE: Record<LensProjection, number> = {
  equidistant: 0,
  equisolid: 1,
  stereographic: 2,
  orthographic: 3,
};
const SVG = 'http://www.w3.org/2000/svg';

let stage!: HTMLElement;
let canvas!: HTMLCanvasElement;
let layer!: HTMLElement;
let ring!: SVGSVGElement;
let ringCircle!: SVGCircleElement;
let ringEdge!: SVGCircleElement;
let ringCentre!: SVGCircleElement;
let footprint!: SVGPathElement;
let lensRow!: HTMLElement;
let viewRow!: HTMLElement;
let tabChips!: HTMLElement;
let aspectChips!: HTMLElement;
let lensFovInput!: HTMLInputElement;
let projectionSelect!: HTMLSelectElement;
let facingSelect!: HTMLSelectElement;
let fovInput!: HTMLInputElement;
let rollInput!: HTMLInputElement;
let sizeSelect!: HTMLSelectElement;
let sizeLabel!: HTMLElement;

let working: LensState | null = null;
let tab: Tab = 'view';

let gl: WebGLRenderingContext | null = null;
let program: WebGLProgram | null = null;
const uniforms: Record<string, WebGLUniformLocation | null> = {};
let drawQueued = false;

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`FlipperClipper: index.html is missing #${id}`);
  return found as T;
}

/** The view being shown: the working copy while the controls are open. */
export function currentLens(): LensState | null {
  return ui.lensEditing ? working : edit.lens;
}

/** True while the picture on the stage is the flat view rather than the fisheye. */
export function showsFlatView(): boolean {
  return currentLens() !== null && !(ui.lensEditing && tab === 'lens');
}

export function lensCanvas(): HTMLCanvasElement {
  return canvas;
}

/** Where the flat view sits on the stage, in `host`'s coordinates, and its output size. */
export function lensFrameBox(host: HTMLElement): { left: number; top: number; width: number; height: number; scale: number } | null {
  const lens = currentLens();
  if (!lens || !edit.media) return null;
  const out = lensOutputSize(lens);
  const stageRect = stage.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  if (stageRect.width <= 0 || stageRect.height <= 0) return null;
  const fit = Math.min(stageRect.width / out.w, stageRect.height / out.h);
  const width = out.w * fit, height = out.h * fit;
  return {
    left: stageRect.left - hostRect.left + (stageRect.width - width) / 2,
    top: stageRect.top - hostRect.top + (stageRect.height - height) / 2,
    width,
    height,
    scale: fit,
  };
}

export function initLensView(): void {
  stage = el('stage');
  layer = el('lens-layer');
  lensRow = el('lens-row-lens');
  viewRow = el('lens-row-view');
  tabChips = el('lens-tabs');
  aspectChips = el('lens-aspects');
  lensFovInput = el('lens-fov');
  projectionSelect = el('lens-projection');
  facingSelect = el('lens-facing');
  fovInput = el('lens-view-fov');
  rollInput = el('lens-roll');
  sizeSelect = el('lens-size');
  sizeLabel = el('lens-out');

  canvas = document.createElement('canvas');
  canvas.id = 'lens-canvas';
  canvas.hidden = true;
  stage.insertBefore(canvas, el('fx-overlay'));
  setupGl();

  buildRing();
  buildControls();

  canvas.addEventListener('pointerdown', onAimDown);
  canvas.addEventListener('pointermove', onAimMove);
  canvas.addEventListener('pointerup', onAimUp);
  canvas.addEventListener('pointercancel', onAimUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  const video = videoElement();
  new ResizeObserver(sync).observe(stage);
  video.addEventListener('loadeddata', queueDraw);
  video.addEventListener('seeked', queueDraw);
  onTime(queueDraw);
  subscribe(sync);
  sync();
}

export function toggleLens(): void {
  if (ui.lensEditing) confirmLens();
  else enterLens();
}

export function isEditingLens(): boolean {
  return ui.lensEditing;
}

export function enterLens(): void {
  if (!edit.media || ui.lensEditing || ui.cropping) return;
  working = edit.lens ? { ...edit.lens } : defaultLens(frameWidth(edit), frameHeight(edit));
  // A new lens starts on its circle, which has to be fitted before any view makes sense.
  tab = edit.lens ? 'view' : 'lens';
  patchUi({ lensEditing: true });
}

export function confirmLens(): void {
  if (!ui.lensEditing || !working) return;
  const lens = working;
  working = null;
  patchUi({ lensEditing: false });
  patchEdit({ lens, crop: null });
}

export function cancelLens(): void {
  if (!ui.lensEditing) return;
  working = null;
  patchUi({ lensEditing: false });
}

function turnOff(): void {
  working = null;
  patchUi({ lensEditing: false });
  if (edit.lens) patchEdit({ lens: null });
}

function setWorking(patch: Partial<LensState>): void {
  if (!working) return;
  working = { ...working, ...patch };
  sync();
}

/* --- Layout --- */

function sync(): void {
  const lens = currentLens();
  const video = videoElement();
  const flat = showsFlatView() && edit.media !== null;

  layer.hidden = !ui.lensEditing;
  canvas.hidden = !flat;
  canvas.classList.toggle('aiming', ui.lensEditing);
  // Kept decoding, only out of sight, so the canvas has frames to read.
  video.style.opacity = flat ? '0' : '';

  if (flat) {
    const box = lensFrameBox(stage);
    if (box) {
      Object.assign(canvas.style, {
        left: `${box.left}px`,
        top: `${box.top}px`,
        width: `${box.width}px`,
        height: `${box.height}px`,
      });
      const ratio = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(box.width * ratio));
      const h = Math.max(1, Math.round(box.height * ratio));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
    }
    queueDraw();
  }

  if (ui.lensEditing && lens) syncControls(lens);
  drawRing();
}

function syncControls(lens: LensState): void {
  lensRow.hidden = tab !== 'lens';
  viewRow.hidden = tab !== 'view';
  for (const chip of Array.from(tabChips.children) as HTMLElement[]) {
    chip.classList.toggle('active', chip.dataset.tab === tab);
  }
  for (const chip of Array.from(aspectChips.children) as HTMLElement[]) {
    chip.classList.toggle('active', Math.abs(Number(chip.dataset.value) - lens.aspect) < 1e-6);
  }
  setValue(lensFovInput, lens.lensFov);
  projectionSelect.value = lens.projection;
  facingSelect.value = lens.facing;
  setValue(fovInput, lens.fov);
  setValue(rollInput, lens.roll);

  const native = lensOutputSize({ ...lens, size: null });
  const first = sizeSelect.options[0];
  if (first) first.textContent = `Lens detail (${native.w} x ${native.h})`;
  sizeSelect.value = lens.size === null ? '' : String(lens.size);
  const out = lensOutputSize(lens);
  sizeLabel.textContent = `${out.w} x ${out.h}`;
}

function setValue(input: HTMLInputElement, value: number): void {
  if (document.activeElement === input) return;
  input.value = String(Math.round(value * 10) / 10);
}

function buildControls(): void {
  const tabs: { label: string; value: Tab }[] = [
    { label: 'Lens circle', value: 'lens' },
    { label: 'View', value: 'view' },
  ];
  tabChips.replaceChildren(
    ...tabs.map((t) => {
      const chip = chipButton(t.label);
      chip.dataset.tab = t.value;
      chip.addEventListener('click', () => {
        tab = t.value;
        sync();
      });
      return chip;
    }),
  );
  aspectChips.replaceChildren(
    ...ASPECTS.map((a) => {
      const chip = chipButton(a.label);
      chip.dataset.value = String(a.value);
      chip.addEventListener('click', () => setWorking({ aspect: a.value }));
      return chip;
    }),
  );

  projectionSelect.replaceChildren(
    ...LENS_PROJECTIONS.map((p) => new Option(p.label, p.value)),
  );
  projectionSelect.addEventListener('change', () =>
    setWorking({ projection: projectionSelect.value as LensProjection }),
  );
  facingSelect.addEventListener('change', () => {
    // The two framings read pan and tilt differently, so the aim starts over.
    setWorking({ facing: facingSelect.value === 'forward' ? 'forward' : 'up', pan: 0, tilt: 0, roll: 0 });
  });
  sizeSelect.replaceChildren(
    new Option('Lens detail', ''),
    ...LENS_SIZES.map((s) => new Option(`${s}p`, String(s))),
  );
  sizeSelect.addEventListener('change', () =>
    setWorking({ size: sizeSelect.value === '' ? null : Number(sizeSelect.value) }),
  );

  numberInput(lensFovInput, LENS_FOV_MIN, LENS_FOV_MAX, (v) => setWorking({ lensFov: v }));
  numberInput(fovInput, VIEW_FOV_MIN, VIEW_FOV_MAX, (v) => setWorking({ fov: v }));
  numberInput(rollInput, -180, 180, (v) => setWorking({ roll: v }));

  el('lens-done').addEventListener('click', confirmLens);
  el('lens-cancel').addEventListener('click', cancelLens);
  el('lens-off').addEventListener('click', turnOff);
  el('lens-reset').addEventListener('click', () => {
    if (!working) return;
    if (tab === 'lens') {
      const d = defaultLens(frameWidth(edit), frameHeight(edit));
      setWorking({ cx: d.cx, cy: d.cy, r: d.r });
    } else {
      setWorking({ pan: 0, tilt: 0, roll: 0, fov: 70 });
    }
  });
}

function chipButton(label: string): HTMLButtonElement {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'chip';
  chip.textContent = label;
  return chip;
}

function numberInput(input: HTMLInputElement, min: number, max: number, set: (v: number) => void): void {
  input.min = String(min);
  input.max = String(max);
  input.addEventListener('change', () => {
    const v = Number(input.value);
    if (!Number.isFinite(v)) return;
    set(Math.min(max, Math.max(min, v)));
    input.blur();
  });
}

/* --- The lens circle, drawn on the fisheye picture --- */

function buildRing(): void {
  ring = document.createElementNS(SVG, 'svg');
  ring.id = 'lens-ring';
  footprint = document.createElementNS(SVG, 'path');
  footprint.setAttribute('class', 'lens-footprint');
  ringCircle = document.createElementNS(SVG, 'circle');
  ringCircle.setAttribute('class', 'lens-circle');
  ringCentre = document.createElementNS(SVG, 'circle');
  ringCentre.setAttribute('class', 'lens-handle');
  ringCentre.setAttribute('r', '7');
  ringEdge = document.createElementNS(SVG, 'circle');
  ringEdge.setAttribute('class', 'lens-handle');
  ringEdge.setAttribute('r', '7');
  ring.append(footprint, ringCircle, ringCentre, ringEdge);
  layer.prepend(ring);

  let mode: 'move' | 'size' | null = null;
  let startX = 0, startY = 0, start: LensState | null = null;
  const down = (which: 'move' | 'size') => (e: PointerEvent) => {
    if (!working) return;
    mode = which;
    startX = e.clientX;
    startY = e.clientY;
    start = { ...working };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  };
  ringCircle.addEventListener('pointerdown', down('move'));
  ringCentre.addEventListener('pointerdown', down('move'));
  ringEdge.addEventListener('pointerdown', down('size'));
  const move = (e: PointerEvent) => {
    if (!mode || !start || !working) return;
    const box = contentBox(layer);
    if (!box) return;
    const dx = (e.clientX - startX) / box.scaleX, dy = (e.clientY - startY) / box.scaleY;
    if (mode === 'move') setWorking({ cx: start.cx + dx, cy: start.cy + dy });
    else {
      const ex = start.cx + start.r + dx, ey = start.cy + dy;
      setWorking({ r: Math.max(16, Math.hypot(ex - start.cx, ey - start.cy)) });
    }
  };
  const up = (e: PointerEvent) => {
    mode = null;
    const target = e.currentTarget as Element;
    if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId);
  };
  for (const node of [ringCircle, ringCentre, ringEdge]) {
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
  }
}

function drawRing(): void {
  const lens = working;
  const show = ui.lensEditing && tab === 'lens' && lens !== null;
  ring.style.display = show ? '' : 'none';
  if (!show || !lens) return;
  const box = contentBox(layer);
  if (!box) return;
  const toX = (x: number) => box.left + x * box.scaleX;
  const toY = (y: number) => box.top + y * box.scaleY;
  ringCircle.setAttribute('cx', String(toX(lens.cx)));
  ringCircle.setAttribute('cy', String(toY(lens.cy)));
  ringCircle.setAttribute('r', String(lens.r * box.scaleX));
  ringCentre.setAttribute('cx', String(toX(lens.cx)));
  ringCentre.setAttribute('cy', String(toY(lens.cy)));
  ringEdge.setAttribute('cx', String(toX(lens.cx + lens.r)));
  ringEdge.setAttribute('cy', String(toY(lens.cy)));

  // The view's outline on the fisheye, so the circle and the aim can be judged together.
  const steps = 24;
  const edge: [number, number][] = [];
  for (let i = 0; i < steps; i += 1) edge.push([i / steps, 0]);
  for (let i = 0; i < steps; i += 1) edge.push([1, i / steps]);
  for (let i = 0; i < steps; i += 1) edge.push([1 - i / steps, 1]);
  for (let i = 0; i <= steps; i += 1) edge.push([0, 1 - i / steps]);
  let path = '';
  let pen = false;
  for (const [u, v] of edge) {
    const p = rayToFrame(lens, viewRay(lens, u, v));
    if (!p) {
      pen = false;
      continue;
    }
    path += `${pen ? 'L' : 'M'}${toX(p[0]).toFixed(1)},${toY(p[1]).toFixed(1)}`;
    pen = true;
  }
  footprint.setAttribute('d', path);
}

/* --- Aiming the flat view --- */

let aim: { target: [number, number, number]; pointer: number } | null = null;

function pointerUv(e: PointerEvent | WheelEvent): [number, number] {
  const rect = canvas.getBoundingClientRect();
  return [(e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height];
}

function onAimDown(e: PointerEvent): void {
  if (!ui.lensEditing || !working) return;
  const [u, v] = pointerUv(e);
  aim = { target: viewRay(working, u, v), pointer: e.pointerId };
  canvas.setPointerCapture(e.pointerId);
  e.preventDefault();
}

function onAimMove(e: PointerEvent): void {
  if (!aim || !working || e.pointerId !== aim.pointer) return;
  const [u, v] = pointerUv(e);
  setWorking(aimAt(working, aim.target, u, v));
}

function onAimUp(e: PointerEvent): void {
  if (!aim || e.pointerId !== aim.pointer) return;
  aim = null;
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
}

function onWheel(e: WheelEvent): void {
  if (!ui.lensEditing || !working) return;
  e.preventDefault();
  const [u, v] = pointerUv(e);
  const target = viewRay(working, u, v);
  const fov = Math.min(VIEW_FOV_MAX, Math.max(VIEW_FOV_MIN, working.fov * Math.pow(1.1, Math.sign(e.deltaY))));
  // Zooms about the pointer: the point under it stays there.
  const zoomed = { ...working, fov };
  setWorking({ fov, ...aimAt(zoomed, target, u, v) });
}

/* --- The GPU preview --- */

const VERTEX = `attribute vec2 p; varying vec2 uv;
void main() { uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;

// Mirrors lens.ts: rayToFrame for the sample point, then the turn and flips undone so the
// texture, which is the decoded picture, is read where the turned frame shows it.
const FRAGMENT = `precision highp float;
uniform sampler2D tex; uniform mat3 rot; uniform vec2 tanHalf; uniform vec3 circle; uniform vec2 frame;
uniform float halfFov; uniform int projection; uniform vec3 toRawU; uniform vec3 toRawV;
varying vec2 uv;
void main() {
  vec3 d = normalize(rot * vec3(tanHalf.x * (2.0 * uv.x - 1.0), tanHalf.y * (2.0 * uv.y - 1.0), 1.0));
  float h = length(d.xy);
  float th = atan(h, d.z);
  float m;
  if (projection == 1) m = sin(th * 0.5) / sin(halfFov * 0.5);
  else if (projection == 2) m = tan(th * 0.5) / tan(halfFov * 0.5);
  else if (projection == 3) m = sin(th) / sin(min(halfFov, 1.5707963));
  else m = th / halfFov;
  vec2 dir = h > 1e-6 ? d.xy / h : vec2(0.0);
  vec2 off = clamp(circle.z * m * dir, vec2(-circle.z), vec2(circle.z));
  vec2 px = circle.xy + off;
  vec2 t = px / frame;
  if (t.x < 0.0 || t.y < 0.0 || t.x > 1.0 || t.y > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec2 raw = vec2(dot(toRawU, vec3(t, 1.0)), dot(toRawV, vec3(t, 1.0)));
  gl_FragColor = texture2D(tex, raw);
}`;

function setupGl(): void {
  gl = canvas.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: true });
  if (!gl) return;
  const shader = (type: number, source: string) => {
    const s = gl!.createShader(type)!;
    gl!.shaderSource(s, source);
    gl!.compileShader(s);
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, shader(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(p, shader(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.error('FlipperClipper: fisheye shader', gl.getProgramInfoLog(p));
    gl = null;
    return;
  }
  program = p;
  gl.useProgram(p);
  for (const name of ['tex', 'rot', 'tanHalf', 'circle', 'frame', 'halfFov', 'projection', 'toRawU', 'toRawV']) {
    uniforms[name] = gl.getUniformLocation(p, name);
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const a = gl.getAttribLocation(p, 'p');
  gl.enableVertexAttribArray(a);
  gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  // The picture is not a power of two in size: WebGL 1 then needs clamped edges and no mipmaps.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.uniform1i(uniforms.tex, 0);
}

function queueDraw(): void {
  if (drawQueued || canvas.hidden) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    draw();
  });
}

/** Turned-frame fractions to decoded-picture fractions: the flips undone, then the turn. */
function toRaw(): { u: [number, number, number]; v: [number, number, number] } {
  const { rotate, flipH, flipV } = edit.orientation;
  // Flips act on the turned picture, so they come off first: x' = fx * x + cx.
  const fx = flipH ? -1 : 1, ox = flipH ? 1 : 0;
  const fy = flipV ? -1 : 1, oy = flipV ? 1 : 0;
  // Then the turn: raw coordinates as functions of the unflipped turned ones (x, y).
  let ru: [number, number, number], rv: [number, number, number];
  switch (rotate) {
    case 90: // shown = (1 - rawY, rawX)
      ru = [0, 1, 0];
      rv = [-1, 0, 1];
      break;
    case 180:
      ru = [-1, 0, 1];
      rv = [0, -1, 1];
      break;
    case 270: // shown = (rawY, 1 - rawX)
      ru = [0, -1, 1];
      rv = [1, 0, 0];
      break;
    default:
      ru = [1, 0, 0];
      rv = [0, 1, 0];
  }
  // Substitute x = fx * t.x + ox, y = fy * t.y + oy.
  const compose = (r: [number, number, number]): [number, number, number] => [
    r[0] * fx,
    r[1] * fy,
    r[0] * ox + r[1] * oy + r[2],
  ];
  return { u: compose(ru), v: compose(rv) };
}

function draw(): void {
  const lens = currentLens();
  const video = videoElement();
  if (!gl || !program || !lens || canvas.hidden || video.readyState < 2) return;

  const filter = video.style.filter;
  if (canvas.style.filter !== filter) canvas.style.filter = filter;

  gl.viewport(0, 0, canvas.width, canvas.height);
  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
  } catch (err) {
    console.error('FlipperClipper: fisheye preview could not read the video', err);
    return;
  }
  const m = viewRotation(lens);
  // GLSL takes the matrix column by column.
  gl.uniformMatrix3fv(uniforms.rot, false, new Float32Array([
    m[0][0], m[1][0], m[2][0],
    m[0][1], m[1][1], m[2][1],
    m[0][2], m[1][2], m[2][2],
  ]));
  const RAD = Math.PI / 180;
  gl.uniform2f(uniforms.tanHalf, Math.tan((lens.fov * RAD) / 2), Math.tan((verticalFov(lens.fov, lens.aspect) * RAD) / 2));
  gl.uniform3f(uniforms.circle, lens.cx, lens.cy, lens.r);
  gl.uniform2f(uniforms.frame, frameWidth(edit), frameHeight(edit));
  gl.uniform1f(uniforms.halfFov, (lens.lensFov * RAD) / 2);
  gl.uniform1i(uniforms.projection, PROJECTION_CODE[lens.projection]);
  const raw = toRaw();
  gl.uniform3f(uniforms.toRawU, ...raw.u);
  gl.uniform3f(uniforms.toRawV, ...raw.v);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

