import { edit, patchEdit, patchUi, subscribe, ui } from './state';
import { frameHeight, frameWidth, isTurned } from './types';
import { videoElement } from './player';
import type { Rect } from './types';

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
  // Per axis: non-square pixels render wider or taller than the stored dimensions.
  scaleX: number;
  scaleY: number;
}

const ASPECTS: { label: string; value: number | null }[] = [
  { label: 'Free', value: null },
  { label: '16:9', value: 16 / 9 },
  { label: '9:16', value: 9 / 16 },
  { label: '1:1', value: 1 },
];

const MIN_SIZE = 16;

let layer!: HTMLElement;
let rectEl!: HTMLElement;
let sizeLabel!: HTMLElement;
let aspectChips!: HTMLElement;

let markLayer!: HTMLElement;
let markShade!: HTMLElement;
let markOutline!: HTMLElement;
let markLabel!: HTMLElement;

let working: Rect = { x: 0, y: 0, w: 0, h: 0 };
let aspect: number | null = null;

let dragHandle: string | null = null;
let dragStartRect: Rect = { x: 0, y: 0, w: 0, h: 0 };
let dragStartX = 0;
let dragStartY = 0;
let dragScaleX = 1;
let dragScaleY = 1;

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`FlipperClipper: index.html is missing #${id}`);
  return found as T;
}

export function initCrop(): void {
  layer = el('crop-layer');
  rectEl = el('crop-rect');
  sizeLabel = el('crop-size');
  aspectChips = el('crop-aspects');

  buildAspectChips();
  buildMark();

  el('crop-done').addEventListener('click', confirmCrop);
  el('crop-cancel').addEventListener('click', cancelCrop);
  el('crop-reset').addEventListener('click', () => {
    working = fullFrame();
    if (aspect !== null) working = fitAspect(working, aspect);
    drawRect();
  });

  rectEl.addEventListener('pointerdown', onPointerDown);
  rectEl.addEventListener('pointermove', onPointerMove);
  rectEl.addEventListener('pointerup', onPointerUp);
  rectEl.addEventListener('pointercancel', onPointerUp);

  new ResizeObserver(() => {
    if (ui.cropping) drawRect();
    drawMark();
  }).observe(videoElement());

  // Before metadata contentBox() falls back to ffprobe's shape, wrong on anamorphic footage.
  videoElement().addEventListener('loadedmetadata', () => {
    if (ui.cropping) drawRect();
    drawMark();
  });

  subscribe(syncVisibility);
  syncVisibility();
}

export function isCropping(): boolean {
  return ui.cropping;
}

export function enterCrop(): void {
  if (!edit.media || ui.cropping) return;
  working = edit.crop ? { ...edit.crop } : fullFrame();
  aspect = null;
  markActiveChip();
  patchUi({ cropping: true });
  drawRect();
}

export function confirmCrop(): void {
  if (!ui.cropping) return;
  const rounded: Rect = {
    x: Math.round(working.x),
    y: Math.round(working.y),
    w: Math.round(working.w),
    h: Math.round(working.h),
  };
  // A rect still covering the whole frame is not a crop, and would cost the lossless path.
  patchEdit({ crop: coversFrame(rounded) ? null : rounded });
  patchUi({ cropping: false });
}

export function cancelCrop(): void {
  if (!ui.cropping) return;
  patchUi({ cropping: false });
}

export function toggleCrop(): void {
  if (ui.cropping) confirmCrop();
  else enterCrop();
}

function syncVisibility(): void {
  layer.hidden = !ui.cropping;
  if (ui.cropping) drawRect();
  drawMark();
}

/** Where the effect overlays have to sit, in the coordinate space of `host`. */
export interface FrameGeometry {
  /** The display rectangle of what an export would contain: the crop when one is set, the
   *  whole letterboxed frame otherwise. drawtext and vignette both run on that region. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Display pixels per source pixel, for the one setting measured in source pixels: blur.
   *  The horizontal scale, since a blur is a single radius and anamorphic footage has two. */
  scale: number;
}

/** Null while there is no media, or before the element has been laid out. */
export function frameGeometry(host: HTMLElement): FrameGeometry | null {
  const box = contentBox(host);
  if (!box) return null;

  const crop = edit.crop;
  if (!crop) {
    return { left: box.left, top: box.top, width: box.width, height: box.height, scale: box.scaleX };
  }
  return {
    left: box.left + crop.x * box.scaleX,
    top: box.top + crop.y * box.scaleY,
    width: crop.w * box.scaleX,
    height: crop.h * box.scaleY,
    scale: box.scaleX,
  };
}

function buildMark(): void {
  const stage = layer.parentElement;
  if (!stage) throw new Error('FlipperClipper: #crop-layer has no stage to sit in');

  markLayer = document.createElement('div');
  markLayer.id = 'crop-mark';
  Object.assign(markLayer.style, {
    position: 'absolute',
    inset: '0',
    pointerEvents: 'none',
    zIndex: '1',
  });

  markShade = document.createElement('div');
  Object.assign(markShade.style, {
    position: 'absolute',
    boxShadow: '0 0 0 9999px var(--shade)',
    opacity: '0.5',
  });

  markOutline = document.createElement('div');
  Object.assign(markOutline.style, {
    position: 'absolute',
    border: '1px solid var(--fg-dim)',
  });

  markLabel = document.createElement('span');
  Object.assign(markLabel.style, {
    position: 'absolute',
    left: '6px',
    bottom: '6px',
    padding: '2px 6px',
    border: '1px solid var(--line)',
    borderRadius: 'var(--radius)',
    background: 'var(--float)',
    color: 'var(--fg-dim)',
    fontSize: '11px',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  });

  markOutline.append(markLabel);
  markLayer.append(markShade, markOutline);
  stage.append(markLayer);
}

function drawMark(): void {
  const crop = edit.crop;
  const show = crop !== null && edit.media !== null && !ui.cropping;
  // Unhidden before measuring: display:none reports a zero rect.
  markLayer.hidden = !show;
  if (!crop || !show) return;

  const box = contentBox(markLayer);
  if (!box) return;

  const geometry = {
    left: `${box.left + crop.x * box.scaleX}px`,
    top: `${box.top + crop.y * box.scaleY}px`,
    width: `${crop.w * box.scaleX}px`,
    height: `${crop.h * box.scaleY}px`,
  };
  Object.assign(markShade.style, geometry);
  Object.assign(markOutline.style, geometry);

  markLabel.textContent = `${Math.round(crop.w)} x ${Math.round(crop.h)}`;
}

function buildAspectChips(): void {
  const chips = ASPECTS.map((option, index) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = option.label;
    chip.dataset.index = String(index);
    chip.addEventListener('click', () => {
      aspect = option.value;
      if (aspect !== null) working = fitAspect(working, aspect);
      markActiveChip();
      drawRect();
    });
    return chip;
  });
  aspectChips.replaceChildren(...chips);
  markActiveChip();
}

function markActiveChip(): void {
  for (const chip of Array.from(aspectChips.children)) {
    const index = Number((chip as HTMLElement).dataset.index);
    chip.classList.toggle('active', ASPECTS[index].value === aspect);
  }
}

function fullFrame(): Rect {
  const media = edit.media;
  if (!media) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: 0, y: 0, w: frameWidth(edit), h: frameHeight(edit) };
}

function coversFrame(r: Rect): boolean {
  const media = edit.media;
  if (!media) return true;
  return r.x <= 1 && r.y <= 1 && r.w >= frameWidth(edit) - 1 && r.h >= frameHeight(edit) - 1;
}

// Letterbox math uses videoWidth/videoHeight - ffprobe's stored dimensions ignore sample
// aspect, so on anamorphic footage every crop comes out offset. The rect itself stays in
// frameWidth(edit)/height, which is the space ffmpeg's crop filter takes.
function contentBox(host: HTMLElement): Box | null {
  const media = edit.media;
  if (!media || frameWidth(edit) <= 0 || frameHeight(edit) <= 0) return null;

  const video = videoElement();
  const layerRect = host.getBoundingClientRect();
  const stage = video.parentElement;
  const stageRect = stage ? stage.getBoundingClientRect() : layerRect;
  if (stageRect.width <= 0 || stageRect.height <= 0) return null;

  // Both are 0 until metadata arrives, and crop mode can be entered in that window.
  const decodedWidth = video.videoWidth > 0 ? video.videoWidth : frameWidth(edit);
  const decodedHeight = video.videoHeight > 0 ? video.videoHeight : frameHeight(edit);
  // The turn is a CSS transform on the element, so its own rect is the box AFTER the transform
  // and tells us nothing about where the picture inside it landed. The picture is worked out
  // from the stage and the turned aspect instead, which is true however the turn is achieved.
  const shownWidth = isTurned(edit.orientation) ? decodedHeight : decodedWidth;
  const shownHeight = isTurned(edit.orientation) ? decodedWidth : decodedHeight;

  const fit = Math.min(stageRect.width / shownWidth, stageRect.height / shownHeight);
  const width = shownWidth * fit;
  const height = shownHeight * fit;

  return {
    left: stageRect.left - layerRect.left + (stageRect.width - width) / 2,
    top: stageRect.top - layerRect.top + (stageRect.height - height) / 2,
    width,
    height,
    scaleX: width / frameWidth(edit),
    scaleY: height / frameHeight(edit),
  };
}

function drawRect(): void {
  const box = contentBox(layer);
  if (!box) return;

  rectEl.style.left = `${box.left + working.x * box.scaleX}px`;
  rectEl.style.top = `${box.top + working.y * box.scaleY}px`;
  rectEl.style.width = `${working.w * box.scaleX}px`;
  rectEl.style.height = `${working.h * box.scaleY}px`;

  sizeLabel.textContent = `${Math.round(working.w)} x ${Math.round(working.h)}`;
}

function onPointerDown(e: PointerEvent): void {
  const box = contentBox(layer);
  if (!box || !edit.media) return;

  const target = e.target as HTMLElement;
  dragHandle = target.dataset.handle ?? 'move';
  dragStartRect = { ...working };
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  dragScaleX = box.scaleX;
  dragScaleY = box.scaleY;

  rectEl.setPointerCapture(e.pointerId);
  e.preventDefault();
  e.stopPropagation();
}

function onPointerMove(e: PointerEvent): void {
  if (!dragHandle || !edit.media) return;
  const dx = (e.clientX - dragStartX) / dragScaleX;
  const dy = (e.clientY - dragStartY) / dragScaleY;

  working = dragHandle === 'move' ? moveBy(dx, dy) : resizeBy(dragHandle, dx, dy);
  drawRect();
}

function onPointerUp(e: PointerEvent): void {
  if (!dragHandle) return;
  dragHandle = null;
  if (rectEl.hasPointerCapture(e.pointerId)) rectEl.releasePointerCapture(e.pointerId);
}

function moveBy(dx: number, dy: number): Rect {
  const media = edit.media;
  if (!media) return working;
  return {
    x: clamp(dragStartRect.x + dx, 0, frameWidth(edit) - dragStartRect.w),
    y: clamp(dragStartRect.y + dy, 0, frameHeight(edit) - dragStartRect.h),
    w: dragStartRect.w,
    h: dragStartRect.h,
  };
}

function resizeBy(handle: string, dx: number, dy: number): Rect {
  const media = edit.media;
  if (!media) return working;

  const west = handle.includes('w');
  const east = handle.includes('e');
  const north = handle.includes('n');
  const south = handle.includes('s');
  const start = dragStartRect;

  if (aspect === null) {
    let x = start.x;
    let y = start.y;
    let w = start.w;
    let h = start.h;

    if (west) {
      x = start.x + dx;
      w = start.w - dx;
    }
    if (east) w = start.w + dx;
    if (north) {
      y = start.y + dy;
      h = start.h - dy;
    }
    if (south) h = start.h + dy;

    if (w < MIN_SIZE) {
      if (west) x = start.x + start.w - MIN_SIZE;
      w = MIN_SIZE;
    }
    if (h < MIN_SIZE) {
      if (north) y = start.y + start.h - MIN_SIZE;
      h = MIN_SIZE;
    }

    if (x < 0) {
      w += x;
      x = 0;
    }
    if (y < 0) {
      h += y;
      y = 0;
    }
    if (x + w > frameWidth(edit)) w = frameWidth(edit) - x;
    if (y + h > frameHeight(edit)) h = frameHeight(edit) - y;

    return { x, y, w: Math.max(MIN_SIZE, w), h: Math.max(MIN_SIZE, h) };
  }

  const anchorX = west ? start.x + start.w : start.x;
  const anchorY = north ? start.y + start.h : start.y;
  const availableW = west ? anchorX : frameWidth(edit) - anchorX;
  const availableH = north ? anchorY : frameHeight(edit) - anchorY;

  let w: number;
  let h: number;
  let x: number;
  let y: number;

  if (!west && !east) {
    h = clamp(north ? start.h - dy : start.h + dy, MIN_SIZE, availableH);
    w = h * aspect;
    if (w > frameWidth(edit)) {
      w = frameWidth(edit);
      h = w / aspect;
    }
    x = clamp(start.x + start.w / 2 - w / 2, 0, frameWidth(edit) - w);
    y = north ? anchorY - h : anchorY;
  } else if (!north && !south) {
    w = clamp(west ? start.w - dx : start.w + dx, MIN_SIZE, availableW);
    h = w / aspect;
    if (h > frameHeight(edit)) {
      h = frameHeight(edit);
      w = h * aspect;
    }
    y = clamp(start.y + start.h / 2 - h / 2, 0, frameHeight(edit) - h);
    x = west ? anchorX - w : anchorX;
  } else {
    w = clamp(west ? start.w - dx : start.w + dx, MIN_SIZE, availableW);
    h = w / aspect;
    if (h > availableH) {
      h = availableH;
      w = h * aspect;
    }
    x = west ? anchorX - w : anchorX;
    y = north ? anchorY - h : anchorY;
  }

  return { x, y, w: Math.max(MIN_SIZE, w), h: Math.max(MIN_SIZE, h) };
}

function fitAspect(r: Rect, ratio: number): Rect {
  const media = edit.media;
  if (!media) return r;

  let w = r.w;
  let h = r.h;
  if (w / h > ratio) w = h * ratio;
  else h = w / ratio;

  const shrink = Math.min(1, frameWidth(edit) / w, frameHeight(edit) / h);
  w *= shrink;
  h *= shrink;

  return {
    x: clamp(r.x + r.w / 2 - w / 2, 0, frameWidth(edit) - w),
    y: clamp(r.y + r.h / 2 - h / 2, 0, frameHeight(edit) - h),
    w,
    h,
  };
}

function clamp(value: number, low: number, high: number): number {
  if (high < low) return low;
  return Math.min(Math.max(value, low), high);
}
