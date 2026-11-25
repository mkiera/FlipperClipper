// The Distortion effect on the stage: the reprojected picture drawn on the GPU with the same
// camera model the export hands to v360, aimed by dragging and zoomed by scrolling while its
// row is open, and the fisheye's lens circle fitted on the source picture.

import { contentBox } from './crop';
import { withSetting } from './effects';
import {
  aimAt,
  defaultLens,
  dragSky,
  fovRange,
  isSky,
  lensField,
  lensOutputSize,
  rawToTurned,
  rayToFrame,
  turnedToRaw,
  sourceVerticalFov,
  verticalFov,
  viewOffset,
  viewRay,
  viewRotation,
} from './lens';
import { findLensCircle } from './lensfit';
import { onTime, videoElement } from './player';
import { edit, patchEdit, subscribe, ui } from './state';
import { frameHeight, frameWidth, isTurned } from './types';
import type { DistortFrom, DistortTo, LensProjection, LensState, Orientation } from './types';

const FROM_CODE: Record<DistortFrom, number> = { fisheye: 0, normal: 1, equirect: 2 };
const TO_CODE: Record<DistortTo, number> = { normal: 0, panorama: 1, equirect: 2, fisheye: 3, planet: 4 };
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

/** The lens circle is being fitted: the stage shows the source picture with the ring on it. */
let fitting = false;
/** Whether the Distortion row is open in the effects panel, where aiming happens. */
let rowOpen: () => boolean = () => false;

let gl: WebGLRenderingContext | null = null;
let program: WebGLProgram | null = null;
const uniforms: Record<string, WebGLUniformLocation | null> = {};
let drawQueued = false;

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`FlipperClipper: index.html is missing #${id}`);
  return found as T;
}

/** The Distortion settings while the effect is on. */
export function currentLens(): LensState | null {
  return edit.media && edit.effects.on.distortion ? edit.effects.settings.distortion : null;
}

/** The controls for the picture are live: the effect is on and its row is open. */
function aiming(): boolean {
  return currentLens() !== null && ui.effectsOpen && rowOpen();
}

/** True while the stage shows the fitting circle on the source picture. */
export function isFitting(): boolean {
  return fitting && aiming() && currentLens()?.from === 'fisheye';
}

export function setFitting(on: boolean): void {
  fitting = on;
  sync();
}

/** True while the picture on the stage is the reprojected one rather than the source. */
export function showsFlatView(): boolean {
  return currentLens() !== null && !isFitting();
}

export function lensCanvas(): HTMLCanvasElement {
  return canvas;
}

/**
 * The start for any fisheye: the round picture found in the frame on show, or failing that
 * the circle that fills the frame. In turned frame pixels.
 */
export function fittedCircle(orientation: Orientation): Pick<LensState, 'cx' | 'cy' | 'r'> {
  const media = edit.media;
  if (!media) return { cx: 0, cy: 0, r: 0 };
  const turned = isTurned(orientation);
  const found = findCircleOnShow(orientation);
  if (found) return found;
  const d = defaultLens(turned ? media.height : media.width, turned ? media.width : media.height);
  return { cx: d.cx, cy: d.cy, r: d.r };
}

/** True while the circle is unset or still the frame-filling guess, so finding it is safe. */
export function circleUnfitted(lens: LensState, orientation: Orientation): boolean {
  const media = edit.media;
  if (lens.r <= 0 || !media) return true;
  const turned = isTurned(orientation);
  const d = defaultLens(turned ? media.height : media.width, turned ? media.width : media.height);
  return Math.abs(lens.cx - d.cx) < 0.5 && Math.abs(lens.cy - d.cy) < 0.5 && Math.abs(lens.r - d.r) < 0.5;
}

/** The media whose frames refitIfGuessed has looked at, how often, and whether it fitted. */
let refit: { media: unknown; tries: number; done: boolean; at: number } = { media: null, tries: 0, done: false, at: 0 };

/**
 * A frame too dark to find the circle in leaves the guess, so a few later frames get a look,
 * spaced out so a scrub through a dark stretch does not use them all. Only once per clip: a
 * picture with no disc stops costing a readback on every seek, and an undo back to the guess
 * is not fitted over again.
 */
function refitIfGuessed(): void {
  const lens = currentLens();
  if (!lens || lens.from !== 'fisheye' || !circleUnfitted(lens, edit.orientation)) return;
  if (refit.media !== edit.media) refit = { media: edit.media, tries: 0, done: false, at: 0 };
  const now = performance.now();
  if (refit.done || refit.tries >= 10 || now - refit.at < 500) return;
  refit.tries += 1;
  refit.at = now;
  const found = findCircleOnShow(edit.orientation);
  if (!found) return;
  refit.done = true;
  setLens(found);
}

/** The lens circle in the decoded frame on show, moved into the turned frame, or null. */
function findCircleOnShow(orientation: Orientation): Pick<LensState, 'cx' | 'cy' | 'r'> | null {
  const media = edit.media;
  const video = videoElement();
  if (!media || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
  const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
  const w = Math.max(16, Math.round(video.videoWidth * scale));
  const h = Math.max(16, Math.round(video.videoHeight * scale));
  let pixels: Uint8ClampedArray;
  try {
    const work = document.createElement('canvas');
    work.width = w;
    work.height = h;
    const ctx = work.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, w, h);
    pixels = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null;
  }
  const luma = new Uint8Array(w * h);
  for (let i = 0; i < luma.length; i += 1) {
    luma[i] = (pixels[i * 4] * 299 + pixels[i * 4 + 1] * 587 + pixels[i * 4 + 2] * 114) / 1000;
  }
  const found = findLensCircle(luma, w, h);
  if (!found) return null;
  const kx = media.width / w, ky = media.height / h;
  const [cx, cy] = rawToTurned(found.cx * kx, found.cy * ky, orientation, media.width, media.height);
  return { cx, cy, r: (found.r * (kx + ky)) / 2 };
}

/** The lens circle kept on the same part of the picture when the turn or flips change. */
export function movedCircle(lens: LensState, from: Orientation, to: Orientation): Pick<LensState, 'cx' | 'cy'> {
  const W = edit.media?.width ?? 0, H = edit.media?.height ?? 0;
  const [rx, ry] = turnedToRaw(lens.cx, lens.cy, from, W, H);
  const [cx, cy] = rawToTurned(rx, ry, to, W, H);
  return { cx, cy };
}

export function setLens(patch: Partial<LensState>): void {
  patchEdit({ effects: withSetting(edit.effects, 'distortion', patch) });
}

/** Where the reprojected picture sits on the stage, in `host`'s coordinates. */
export function lensFrameBox(host: HTMLElement): { left: number; top: number; width: number; height: number; scale: number } | null {
  const lens = currentLens();
  if (!lens) return null;
  const out = lensOutputSize(lens, frameWidth(edit));
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

export function initLensView(isRowOpen: () => boolean): void {
  rowOpen = isRowOpen;
  stage = el('stage');
  layer = el('lens-layer');

  canvas = document.createElement('canvas');
  canvas.id = 'lens-canvas';
  canvas.hidden = true;
  stage.insertBefore(canvas, el('fx-overlay'));
  setupGl();
  buildRing();

  canvas.addEventListener('pointerdown', onAimDown);
  canvas.addEventListener('pointermove', onAimMove);
  canvas.addEventListener('pointerup', onAimUp);
  canvas.addEventListener('pointercancel', onAimUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  const video = videoElement();
  new ResizeObserver(sync).observe(stage);
  video.addEventListener('loadeddata', queueDraw);
  video.addEventListener('seeked', queueDraw);
  // A frame too dark to find the circle in leaves the guess; a later frame may show it.
  for (const type of ['loadeddata', 'seeked']) video.addEventListener(type, refitIfGuessed);
  onTime(queueDraw);
  subscribe(sync);
  sync();
}

/* --- Layout --- */

export function sync(): void {
  const video = videoElement();
  const flat = showsFlatView();

  canvas.hidden = !flat;
  canvas.classList.toggle('aiming', aiming());
  // Kept decoding, only out of sight, so the canvas has frames to read.
  video.style.opacity = flat ? '0' : '';
  layer.hidden = !isFitting();

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
  drawRing();
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
    const lens = currentLens();
    if (!lens) return;
    mode = which;
    startX = e.clientX;
    startY = e.clientY;
    start = { ...lens };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  };
  ringCircle.addEventListener('pointerdown', down('move'));
  ringCentre.addEventListener('pointerdown', down('move'));
  ringEdge.addEventListener('pointerdown', down('size'));
  const move = (e: PointerEvent) => {
    if (!mode || !start) return;
    const box = contentBox(layer);
    if (!box) return;
    const dx = (e.clientX - startX) / box.scaleX, dy = (e.clientY - startY) / box.scaleY;
    if (mode === 'move') setLens({ cx: start.cx + dx, cy: start.cy + dy });
    else {
      const ex = start.cx + start.r + dx, ey = start.cy + dy;
      setLens({ r: Math.max(16, Math.hypot(ex - start.cx, ey - start.cy)) });
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
  const lens = currentLens();
  const show = isFitting() && lens !== null;
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
    const p = rayToFrame(lens, viewRay(lens, u, v), frameWidth(edit), frameHeight(edit));
    if (!p) {
      pen = false;
      continue;
    }
    path += `${pen ? 'L' : 'M'}${toX(p[0]).toFixed(1)},${toY(p[1]).toFixed(1)}`;
    pen = true;
  }
  footprint.setAttribute('d', path);
}

/* --- Aiming --- */

let aim: { target: [number, number, number]; pointer: number; x: number; y: number } | null = null;

function pointerUv(e: PointerEvent | WheelEvent): [number, number] {
  const rect = canvas.getBoundingClientRect();
  return [(e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height];
}

function onAimDown(e: PointerEvent): void {
  const lens = currentLens();
  if (!lens || !aiming()) return;
  const [u, v] = pointerUv(e);
  aim = { target: viewRay(lens, u, v), pointer: e.pointerId, x: e.clientX, y: e.clientY };
  canvas.setPointerCapture(e.pointerId);
  e.preventDefault();
}

function onAimMove(e: PointerEvent): void {
  const lens = currentLens();
  if (!aim || !lens || e.pointerId !== aim.pointer) return;
  if (isSky(lens)) {
    const width = canvas.getBoundingClientRect().width;
    const step = dragSky(lens, e.clientX - aim.x, e.clientY - aim.y, width);
    aim.x = e.clientX;
    aim.y = e.clientY;
    setLens(step);
    return;
  }
  const [u, v] = pointerUv(e);
  setLens(aimAt(lens, aim.target, u, v));
}

function onAimUp(e: PointerEvent): void {
  if (!aim || e.pointerId !== aim.pointer) return;
  aim = null;
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
}

function onWheel(e: WheelEvent): void {
  const lens = currentLens();
  if (!lens || !aiming()) return;
  e.preventDefault();
  const range = fovRange(lens.to);
  const fov = Math.min(range.max, Math.max(range.min, lens.fov * Math.pow(1.1, Math.sign(e.deltaY))));
  // A sky view zooms about its centre, since the zenith cannot always be held under the
  // pointer with the sky kept up. Every other view zooms about the pointer.
  if (isSky(lens)) {
    setLens({ fov });
    return;
  }
  const [u, v] = pointerUv(e);
  const target = viewRay(lens, u, v);
  setLens({ fov, ...aimAt({ ...lens, fov }, target, u, v) });
}

/* --- The GPU preview --- */

const VERTEX = `attribute vec2 p; varying vec2 uv;
void main() { uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;

// Mirrors lens.ts: outputRay, the aim, then rayToFrame for the sample point, and the turn and
// flips undone so the texture, which is the decoded picture, is read where the frame shows it.
const FRAGMENT = `precision highp float;
uniform sampler2D tex; uniform mat3 rot; uniform vec2 outHalf; uniform float offset; uniform int outType;
uniform int inType; uniform vec3 circle; uniform vec2 frame; uniform float halfFov; uniform int projection;
uniform vec2 inTan; uniform vec3 toRawU; uniform vec3 toRawV;
varying vec2 uv;
const float PI = 3.14159265;
vec3 polar(float th, float ph) { return vec3(sin(th) * cos(ph), sin(th) * sin(ph), cos(th)); }
void main() {
  vec2 c = 2.0 * uv - 1.0;
  vec3 o;
  if (outType == 0) o = normalize(vec3(tan(outHalf.x) * c.x, tan(outHalf.y) * c.y + offset, 1.0));
  else if (outType == 1) o = normalize(vec3(sin(c.x * outHalf.x), tan(outHalf.y) * c.y, cos(c.x * outHalf.x)));
  else if (outType == 2) o = vec3(cos(c.y * outHalf.y) * sin(c.x * outHalf.x), sin(c.y * outHalf.y), cos(c.y * outHalf.y) * cos(c.x * outHalf.x));
  else if (outType == 3) { vec2 a = c * outHalf; o = polar(length(a), atan(a.y, a.x)); }
  else { vec2 a = c * tan(outHalf * 0.5); o = polar(2.0 * atan(length(a)), atan(a.y, a.x)); }
  vec3 d = rot * o;
  vec2 t;
  if (inType == 2) {
    float lon = atan(d.x, d.z);
    float lat = asin(clamp(d.y / length(d), -1.0, 1.0));
    t = vec2((lon / PI + 1.0) * 0.5, (lat / (PI * 0.5) + 1.0) * 0.5);
  } else if (inType == 1) {
    if (d.z <= 0.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    t = vec2((d.x / d.z / inTan.x + 1.0) * 0.5, (d.y / d.z / inTan.y + 1.0) * 0.5);
  } else {
    float h = length(d.xy);
    float th = atan(h, d.z);
    // Past the lens's field there is no picture: black, as the export masks it.
    if (th > halfFov) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    float m;
    if (projection == 1) m = sin(th * 0.5) / sin(halfFov * 0.5);
    else if (projection == 2) m = tan(th * 0.5) / tan(halfFov * 0.5);
    else if (projection == 3) m = sin(th) / sin(min(halfFov, 1.5707963));
    else m = th / halfFov;
    vec2 dir = h > 1e-6 ? d.xy / h : vec2(0.0);
    t = (circle.xy + circle.z * m * dir) / frame;
  }
  if (t.x < 0.0 || t.y < 0.0 || t.x > 1.0 || t.y > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec2 raw = vec2(dot(toRawU, vec3(t, 1.0)), dot(toRawV, vec3(t, 1.0)));
  gl_FragColor = texture2D(tex, raw);
}`;

const UNIFORMS = ['tex', 'rot', 'outHalf', 'offset', 'outType', 'inType', 'circle', 'frame', 'halfFov', 'projection', 'inTan', 'toRawU', 'toRawV'];

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
    console.error('FlipperClipper: distortion shader', gl.getProgramInfoLog(p));
    gl = null;
    return;
  }
  program = p;
  gl.useProgram(p);
  for (const name of UNIFORMS) uniforms[name] = gl.getUniformLocation(p, name);
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
  // Flips act on the turned picture, so they come off first: x' = fx * x + ox.
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
    console.error('FlipperClipper: the distortion preview could not read the video', err);
    return;
  }
  const RAD = Math.PI / 180;
  const width = frameWidth(edit), height = frameHeight(edit);
  // The preview's own shape, which the output size rounds only slightly.
  const out = lensOutputSize(lens, width);
  const shaped = { ...lens, aspect: out.w / out.h };
  const m = viewRotation(lens);
  // GLSL takes the matrix column by column.
  gl.uniformMatrix3fv(uniforms.rot, false, new Float32Array([
    m[0][0], m[1][0], m[2][0],
    m[0][1], m[1][1], m[2][1],
    m[0][2], m[1][2], m[2][2],
  ]));
  gl.uniform2f(uniforms.outHalf, (lens.fov * RAD) / 2, (verticalFov(shaped) * RAD) / 2);
  gl.uniform1f(uniforms.offset, viewOffset(shaped));
  gl.uniform1i(uniforms.outType, TO_CODE[lens.to]);
  gl.uniform1i(uniforms.inType, FROM_CODE[lens.from]);
  gl.uniform3f(uniforms.circle, lens.cx, lens.cy, lens.r);
  gl.uniform2f(uniforms.frame, width, height);
  gl.uniform1f(uniforms.halfFov, (lensField(lens) * RAD) / 2);
  gl.uniform1i(uniforms.projection, PROJECTION_CODE[lens.projection]);
  gl.uniform2f(
    uniforms.inTan,
    Math.tan((lens.sourceFov * RAD) / 2),
    Math.tan((sourceVerticalFov(lens, width, height) * RAD) / 2),
  );
  const raw = toRaw();
  gl.uniform3f(uniforms.toRawU, ...raw.u);
  gl.uniform3f(uniforms.toRawV, ...raw.v);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}
