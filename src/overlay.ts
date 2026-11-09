/**
 * What the effects look like on the preview.
 *
 * Four of them cannot be expressed as a CSS filter on the <video>, so they are drawn as
 * layers over it, stacked in the order the export applies them: vignette, then redact, then
 * text, then the fade shade over all of them. Each layer is positioned on the region the export would actually
 * contain, which is the crop rectangle when there is one - drawtext and vignette run after the
 * crop filter, so text pinned to "bottom left" belongs at the bottom left of the crop.
 *
 * A CSS filter or an overlay drops the video off the GPU's overlay plane onto the compositor's
 * own colour conversion, which shifts the picture slightly. That is unavoidable here and the
 * reason nothing is drawn, and no filter is set, while every effect is switched off.
 */

import { frameGeometry } from './crop';
import { blurPixels, cssFilterFor, hasEffect, rgba } from './effects';
import { currentTime, onTime, videoElement } from './player';
import { clampRegion, stateAt, withEdit } from './redact';
import {
  keyTolerance,
  playheadTime,
  redactItems,
  selectRedaction,
  selectedRedaction,
  updateRedaction,
} from './redactedit';
import { edit, subscribe, ui } from './state';
import { frameHeight, frameWidth, outputDuration } from './types';
import type { RedactItem, RedactRegion } from './types';

/** The margin drawtext leaves, as a fraction of frame height. Kept in step with ffmpeg.rs. */
const TEXT_MARGIN = 0.04;

/** The plate's border width around the text, as a fraction of frame height. */
const TEXT_PAD = 0.012;

/** Arial, because ffmpeg is handed arial.ttf: the two rasterise differently but they are at
 *  least the same typeface at the same nominal size. */
const TEXT_FONT = 'Arial, sans-serif';

let layer!: HTMLElement;
/** The layer's offset parent. Measuring against the layer itself would be circular: its own
 *  left is what the measurement sets, so every render after the first would drift by it. */
let stage!: HTMLElement;
let vignette!: HTMLElement;
let textLayer!: HTMLElement;
let textSpan!: HTMLElement;
let fadeShade!: HTMLElement;
let redactLayer!: HTMLElement;
/** The last frame geometry, so the boxes can follow the playhead without re-measuring. */
let lastGeometry: { width: number; height: number; scale: number } | null = null;
let blurAmount!: SVGFEGaussianBlurElement;

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`FlipperClipper: index.html is missing #${id}`);
  return found as T;
}

export function initOverlay(): void {
  layer = el('fx-overlay');
  const host = layer.parentElement;
  if (!host) throw new Error('FlipperClipper: #fx-overlay has no stage to sit in');
  stage = host;
  vignette = el('fx-vignette');
  textLayer = el('fx-text');
  textSpan = el('fx-text-span');
  fadeShade = el('fx-fade');
  redactLayer = el('fx-redact-layer');
  initRedactDrag();
  blurAmount = el<HTMLElement>('fx-blur-amount') as unknown as SVGFEGaussianBlurElement;

  const video = videoElement();
  new ResizeObserver(render).observe(video);
  // Before metadata arrives the element reports no dimensions, so the geometry is wrong.
  video.addEventListener('loadedmetadata', render);

  subscribe(render);
  // Per presented frame, so the fade tracks the playhead without re-laying out the rest.
  onTime(() => {
    renderFade();
    renderRedactions();
  });
  video.addEventListener('seeked', renderRedactions);
  video.addEventListener('loadeddata', renderRedactions);
  render();
}

export function render(): void {
  const video = videoElement();
  const effects = edit.effects;

  applyTurn(video);

  const geometry = edit.media ? frameGeometry(stage) : null;
  const scale = geometry?.scale ?? 1;
  // Set before the filter is applied, so the first blurred frame is drawn at the right radius.
  blurAmount.setAttribute('stdDeviation', blurPixels(effects, scale).toFixed(2));
  const filter = cssFilterFor(effects, scale);
  if (video.style.filter !== filter) video.style.filter = filter;

  const drawsText = hasEffect(effects, 'text');
  const drawsVignette = hasEffect(effects, 'vignette');
  const drawsFade = hasEffect(effects, 'fade');
  const drawsRedact = hasEffect(effects, 'redact');

  layer.hidden = !geometry || !(drawsText || drawsVignette || drawsFade || drawsRedact);
  if (!geometry || layer.hidden) return;

  Object.assign(layer.style, {
    left: `${geometry.left}px`,
    top: `${geometry.top}px`,
    width: `${geometry.width}px`,
    height: `${geometry.height}px`,
  });

  vignette.hidden = !drawsVignette;
  if (drawsVignette) {
    const strength = effects.settings.vignette.amount;
    // An approximation of ffmpeg's lens falloff, which is a cosine law rather than a gradient
    // stop. Close enough to place the effect; the exported file is the real answer.
    vignette.style.background = `radial-gradient(ellipse at center, rgba(0,0,0,0) 35%, rgba(0,0,0,${(
      strength * 0.95
    ).toFixed(2)}) 100%)`;
  }

  redactLayer.hidden = !drawsRedact;
  lastGeometry = { width: geometry.width, height: geometry.height, scale };
  renderRedactions();

  textLayer.hidden = !drawsText;
  if (drawsText) renderText(geometry.height);

  fadeShade.hidden = !drawsFade;
  renderFade();
}

/**
 * The turn, as a CSS transform on the <video>.
 *
 * A quarter turn needs the element sized to the stage's OTHER way round before it is rotated,
 * or the transform spins a stage-shaped box and the picture inside it hangs off the top and
 * bottom. Sized H by W and turned, it lands back on exactly W by H.
 *
 * crop.ts does not read this. It works the picture out from the stage and the turned aspect,
 * because a transformed element's own rect is the box after the transform and says nothing
 * about where the picture inside it went.
 */
function applyTurn(video: HTMLVideoElement): void {
  const { rotate, flipH, flipV } = edit.orientation;
  const turned = rotate === 90 || rotate === 270;

  if (!turned) {
    video.style.removeProperty('width');
    video.style.removeProperty('height');
    video.style.removeProperty('left');
    video.style.removeProperty('top');
    video.style.removeProperty('position');
  } else {
    const box = stage.getBoundingClientRect();
    Object.assign(video.style, {
      position: 'absolute',
      width: `${box.height}px`,
      height: `${box.width}px`,
      left: `${(box.width - box.height) / 2}px`,
      top: `${(box.height - box.width) / 2}px`,
    });
  }

  const parts: string[] = [];
  // A transform list applies right to left, so the flips listed first act on the turned
  // picture - the same order hflip and vflip sit in after transpose in the export chain.
  if (flipH) parts.push('scaleX(-1)');
  if (flipV) parts.push('scaleY(-1)');
  if (rotate !== 0) parts.push(`rotate(${rotate}deg)`);
  const transform = parts.length > 0 ? parts.join(' ') : '';
  if (video.style.transform !== transform) video.style.transform = transform;
}

function renderText(frameHeight: number): void {
  const text = edit.effects.settings.text;

  Object.assign(textLayer.style, {
    justifyContent: text.anchorX === 'left' ? 'flex-start' : text.anchorX === 'right' ? 'flex-end' : 'center',
    alignItems: text.anchorY === 'top' ? 'flex-start' : text.anchorY === 'bottom' ? 'flex-end' : 'center',
    padding: `${frameHeight * TEXT_MARGIN}px`,
  });

  textSpan.textContent = text.text;
  Object.assign(textSpan.style, {
    fontFamily: TEXT_FONT,
    fontSize: `${frameHeight * text.size}px`,
    color: rgba(text.color, text.opacity),
    background: text.boxed ? 'rgba(0, 0, 0, 0.45)' : 'transparent',
    padding: text.boxed ? `${frameHeight * TEXT_PAD}px` : '0',
  });
}

/**
 * The fade is the one effect that changes with the playhead, so it is redrawn per presented
 * frame rather than per state change. Everything is in output time - the timeline the finished
 * clip has, after the trim and the speed change - because that is what ffmpeg's fade sees.
 */
function renderFade(): void {
  if (fadeShade.hidden) return;

  const { inSeconds, outSeconds } = edit.effects.settings.fade;
  const total = outputDuration(edit);
  if (total <= 0) {
    fadeShade.style.opacity = '0';
    return;
  }

  // A reversed clip plays from the out point back, so its output position counts the other way.
  const t = currentTime();
  const raw = edit.reverse ? edit.outPoint - t : t - edit.inPoint;
  const position = Math.min(Math.max(raw / edit.speed, 0), total);

  let visible = 1;
  if (inSeconds > 0 && position < inSeconds) visible = Math.min(visible, position / inSeconds);
  if (outSeconds > 0 && position > total - outSeconds) {
    visible = Math.min(visible, (total - position) / outSeconds);
  }

  fadeShade.style.opacity = String(1 - Math.min(Math.max(visible, 0), 1));
}

/* --- Redact --- */

/** One element per redaction, reused while the count stays the same. */
function redactBoxes(items: RedactItem[]): HTMLElement[] {
  while (redactLayer.children.length < items.length) {
    const box = document.createElement('div');
    box.className = 'fx-redact-box';
    // The canvas sits on the export's block grid, which overhangs the box; the clip trims it
    // while the box itself stays unclipped for its corner handles.
    const clip = document.createElement('div');
    clip.className = 'fx-redact-clip';
    clip.append(document.createElement('canvas'));
    box.append(clip);
    for (const corner of ['nw', 'ne', 'se', 'sw']) {
      const handle = document.createElement('span');
      handle.className = `ch ch-${corner}`;
      handle.dataset.handle = corner;
      box.append(handle);
    }
    redactLayer.append(box);
  }
  while (redactLayer.children.length > items.length) redactLayer.lastElementChild?.remove();
  return Array.from(redactLayer.children) as HTMLElement[];
}

/**
 * Every redaction as it stands at the playhead. A black box is a fill, a blur is a backdrop
 * filter of the same sigma the export uses, and a pixelation is a canvas of one pixel per
 * block, on the same grid the export pixelates the whole frame on, stretched back up without
 * smoothing.
 */
function renderRedactions(): void {
  if (redactLayer.hidden || !lastGeometry) return;
  const { width, height, scale } = lastGeometry;
  const items = redactItems();
  const boxes = redactBoxes(items);
  const t = playheadTime();
  const panelOpen = ui.effectsOpen && !ui.cropping;
  const selected = selectedRedaction();

  items.forEach((item, index) => {
    const box = boxes[index];
    const { region: r, on } = stateAt(item, t);
    box.dataset.id = String(item.id);
    const isSelected = selected?.id === item.id;
    box.classList.toggle('editing', panelOpen && isSelected);
    box.classList.toggle('selectable', panelOpen && !isSelected);
    box.classList.toggle('off', !on);
    // A box hidden here is only drawn while it can be edited.
    box.hidden = !on && !panelOpen;
    Object.assign(box.style, {
      left: `${r.x * width}px`,
      top: `${r.y * height}px`,
      width: `${r.w * width}px`,
      height: `${r.h * height}px`,
      background: item.mode === 'box' ? '#000' : 'transparent',
      backdropFilter: item.mode === 'blur' ? `blur(${(item.strength * scale).toFixed(2)}px)` : 'none',
    });
    const canvas = box.querySelector('canvas') as HTMLCanvasElement;
    canvas.hidden = item.mode !== 'pixelate';
    if (item.mode === 'pixelate' && on) drawPixelate(canvas, item, r, width / cutSize().w);
  });
}

/** The frame the export redacts: the crop when there is one, in turned source pixels. */
function cutSize(): { x: number; y: number; w: number; h: number } {
  return edit.crop ?? { x: 0, y: 0, w: frameWidth(edit), h: frameHeight(edit) };
}

function drawPixelate(canvas: HTMLCanvasElement, item: RedactItem, r: RedactRegion, display: number): void {
  const media = edit.media;
  const video = videoElement();
  if (!media || video.readyState < 2) return;

  // The export scales the whole cut frame down to this many blocks and back up.
  const cut = cutSize();
  const block = Math.max(1, Math.round(item.strength));
  const cols = Math.max(1, Math.floor(cut.w / block));
  const rows = Math.max(1, Math.floor(cut.h / block));
  const bw = cut.w / cols;
  const bh = cut.h / rows;

  const sx = r.x * cut.w;
  const sy = r.y * cut.h;
  const c0 = Math.floor(sx / bw);
  const r0 = Math.floor(sy / bh);
  const c1 = Math.min(cols, Math.ceil((sx + r.w * cut.w) / bw));
  const r1 = Math.min(rows, Math.ceil((sy + r.h * cut.h) / bh));
  const across = Math.max(1, c1 - c0);
  const down = Math.max(1, r1 - r0);
  if (canvas.width !== across) canvas.width = across;
  if (canvas.height !== down) canvas.height = down;
  Object.assign(canvas.style, {
    left: `${(c0 * bw - sx) * display}px`,
    top: `${(r0 * bh - sy) * display}px`,
    width: `${across * bw * display}px`,
    height: `${down * bh * display}px`,
  });

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { rotate, flipH, flipV } = edit.orientation;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, across, down);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // The grade the <video> wears, so the blocks carry the same colour as the frame around them.
  ctx.filter = video.style.filter || 'none';
  // Canvas pixels are blocks of the cut frame. The video is drawn turned and flipped about the
  // frame's centre the same way its CSS transform is: flips act on the turned picture.
  ctx.scale(1 / bw, 1 / bh);
  ctx.translate(-(cut.x + c0 * bw), -(cut.y + r0 * bh));
  ctx.translate(frameWidth(edit) / 2, frameHeight(edit) / 2);
  ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
  ctx.rotate((rotate * Math.PI) / 180);
  ctx.drawImage(video, -media.width / 2, -media.height / 2, media.width, media.height);
}

/** Dragging the selected box moves it and dragging a corner resizes it, in fractions of the
 *  frame, at the playhead. Pressing another box selects it. */
function initRedactDrag(): void {
  let drag: { id: number; handle: string; start: RedactRegion; x: number; y: number; target: HTMLElement } | null =
    null;

  redactLayer.addEventListener('pointerdown', (e) => {
    const target = e.target as HTMLElement;
    const box = target.closest('.fx-redact-box') as HTMLElement | null;
    if (!box) return;
    const id = Number(box.dataset.id);
    if (box.classList.contains('selectable')) {
      selectRedaction(id);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (!box.classList.contains('editing')) return;
    const item = redactItems().find((it) => it.id === id);
    if (!item) return;
    drag = {
      id,
      handle: target.dataset.handle ?? 'move',
      start: stateAt(item, playheadTime()).region,
      x: e.clientX,
      y: e.clientY,
      target: box,
    };
    box.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  });

  redactLayer.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const width = lastGeometry?.width || 1;
    const height = lastGeometry?.height || 1;
    const dx = (e.clientX - drag.x) / width;
    const dy = (e.clientY - drag.y) / height;
    const region =
      drag.handle === 'move' ? moveRegion(drag.start, dx, dy) : resizeRegion(drag.start, drag.handle, dx, dy);
    const t = playheadTime();
    updateRedaction(drag.id, (item) => withEdit(item, t, { region }, keyTolerance()));
  });

  const end = (e: PointerEvent) => {
    if (!drag) return;
    if (drag.target.hasPointerCapture(e.pointerId)) drag.target.releasePointerCapture(e.pointerId);
    drag = null;
  };
  redactLayer.addEventListener('pointerup', end);
  redactLayer.addEventListener('pointercancel', end);
}

function moveRegion(start: RedactRegion, dx: number, dy: number): RedactRegion {
  return clampRegion({ ...start, x: start.x + dx, y: start.y + dy });
}

function resizeRegion(start: RedactRegion, handle: string, dx: number, dy: number): RedactRegion {
  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;
  if (handle.includes('w')) left = Math.min(Math.max(left + dx, 0), right - 0.02);
  if (handle.includes('e')) right = Math.max(Math.min(right + dx, 1), left + 0.02);
  if (handle.includes('n')) top = Math.min(Math.max(top + dy, 0), bottom - 0.02);
  if (handle.includes('s')) bottom = Math.max(Math.min(bottom + dy, 1), top + 0.02);
  return clampRegion({ x: left, y: top, w: right - left, h: bottom - top });
}
