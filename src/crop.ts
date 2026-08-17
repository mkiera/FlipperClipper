/**
 * Crop mode: a draggable rectangle over the video with eight resize handles.
 *
 * The rectangle is stored in SOURCE pixels because that is what ffmpeg's crop
 * filter wants and what types.ts documents. Everything the user touches is in
 * displayed pixels, and the only bridge between the two is contentBox() below.
 *
 * That bridge is the part worth being careful about: the <video> element is
 * object-fit: contain, so on any clip whose aspect ratio differs from the
 * stage's there are letterbox bars inside the element's own box. Mapping
 * against the element rect instead of the real content rect puts every crop off
 * by the size of those bars, and the error is invisible until export.
 */

import { edit, patchEdit, patchUi, subscribe, ui } from './state';
import { videoElement } from './player';
import type { Rect } from './types';

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
  /**
   * Displayed pixels per source pixel, kept per axis: a source with
   * non-square pixels is rendered wider or taller than its stored dimensions,
   * so one shared factor cannot describe both directions.
   */
  scaleX: number;
  scaleY: number;
}

const ASPECTS: { label: string; value: number | null }[] = [
  { label: 'Free', value: null },
  { label: '16:9', value: 16 / 9 },
  { label: '9:16', value: 9 / 16 },
  { label: '1:1', value: 1 },
];

/** Source pixels. Small enough to crop hard, large enough to grab back. */
const MIN_SIZE = 16;

let layer!: HTMLElement;
let rectEl!: HTMLElement;
let sizeLabel!: HTMLElement;
let aspectChips!: HTMLElement;

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
  if (!found) throw new Error(`QuickClip: index.html is missing #${id}`);
  return found as T;
}

export function initCrop(): void {
  layer = el('crop-layer');
  rectEl = el('crop-rect');
  sizeLabel = el('crop-size');
  aspectChips = el('crop-aspects');

  buildAspectChips();

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

  // The stage grows and shrinks with the window, and the letterbox bars grow
  // with it, so the mapping has to be recomputed rather than cached.
  new ResizeObserver(() => {
    if (ui.cropping) drawRect();
  }).observe(videoElement());

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
  // A rectangle that still covers the whole frame is not a crop, and recording
  // it as one would cost the user the lossless trim path for no benefit.
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
  return { x: 0, y: 0, w: media.width, h: media.height };
}

function coversFrame(r: Rect): boolean {
  const media = edit.media;
  if (!media) return true;
  return r.x <= 1 && r.y <= 1 && r.w >= media.width - 1 && r.h >= media.height - 1;
}

/**
 * The video's real content rectangle, in coordinates local to the crop layer.
 *
 * The shape of that rectangle has to come from videoWidth/videoHeight, not
 * from media.width/height: ffprobe reports the dimensions the frames are
 * stored at (swapped for a rotation flag, but never adjusted for
 * sample_aspect_ratio), while the element lays the frame out at its display
 * aspect ratio with the sample aspect applied. On anamorphic footage - a
 * 720x480 SAR 32:27 DVD rip, most AVCHD camcorders - the two disagree, and
 * fitting the letterbox with ffprobe's numbers gets both the size and the
 * centring wrong, so every crop is quietly offset with nothing to show for it
 * until the user watches the export.
 *
 * media.width/height stay the coordinate space the crop rect is expressed in,
 * because that is what ffmpeg's crop filter takes and it must not follow the
 * preview when the preview is running off a downscaled proxy.
 */
function contentBox(): Box | null {
  const media = edit.media;
  if (!media || media.width <= 0 || media.height <= 0) return null;

  const video = videoElement();
  const videoRect = video.getBoundingClientRect();
  const layerRect = layer.getBoundingClientRect();
  if (videoRect.width <= 0 || videoRect.height <= 0) return null;

  // Both are 0 until the element has metadata, and crop mode can be entered in
  // that window; the stored dimensions are the better guess than a divide by
  // zero, and the ResizeObserver redraws with the real ones soon after.
  const shownWidth = video.videoWidth > 0 ? video.videoWidth : media.width;
  const shownHeight = video.videoHeight > 0 ? video.videoHeight : media.height;

  const fit = Math.min(videoRect.width / shownWidth, videoRect.height / shownHeight);
  const width = shownWidth * fit;
  const height = shownHeight * fit;

  return {
    left: videoRect.left - layerRect.left + (videoRect.width - width) / 2,
    top: videoRect.top - layerRect.top + (videoRect.height - height) / 2,
    width,
    height,
    scaleX: width / media.width,
    scaleY: height / media.height,
  };
}

function drawRect(): void {
  const box = contentBox();
  if (!box) return;

  rectEl.style.left = `${box.left + working.x * box.scaleX}px`;
  rectEl.style.top = `${box.top + working.y * box.scaleY}px`;
  rectEl.style.width = `${working.w * box.scaleX}px`;
  rectEl.style.height = `${working.h * box.scaleY}px`;

  sizeLabel.textContent = `${Math.round(working.w)} x ${Math.round(working.h)}`;
}

function onPointerDown(e: PointerEvent): void {
  const box = contentBox();
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
    x: clamp(dragStartRect.x + dx, 0, media.width - dragStartRect.w),
    y: clamp(dragStartRect.y + dy, 0, media.height - dragStartRect.h),
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

    // Pin the edge being dragged instead of letting the rectangle flip through
    // itself, which reads as the handle jumping to the far side mid-drag.
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
    if (x + w > media.width) w = media.width - x;
    if (y + h > media.height) h = media.height - y;

    return { x, y, w: Math.max(MIN_SIZE, w), h: Math.max(MIN_SIZE, h) };
  }

  // With an aspect locked, the edge opposite the handle is the anchor and the
  // rectangle can only grow into the space between that anchor and the frame
  // edge - which is what keeps a 16:9 drag from silently leaving the frame.
  const anchorX = west ? start.x + start.w : start.x;
  const anchorY = north ? start.y + start.h : start.y;
  const availableW = west ? anchorX : media.width - anchorX;
  const availableH = north ? anchorY : media.height - anchorY;

  let w: number;
  let h: number;
  let x: number;
  let y: number;

  if (!west && !east) {
    h = clamp(north ? start.h - dy : start.h + dy, MIN_SIZE, availableH);
    w = h * aspect;
    if (w > media.width) {
      w = media.width;
      h = w / aspect;
    }
    x = clamp(start.x + start.w / 2 - w / 2, 0, media.width - w);
    y = north ? anchorY - h : anchorY;
  } else if (!north && !south) {
    w = clamp(west ? start.w - dx : start.w + dx, MIN_SIZE, availableW);
    h = w / aspect;
    if (h > media.height) {
      h = media.height;
      w = h * aspect;
    }
    y = clamp(start.y + start.h / 2 - h / 2, 0, media.height - h);
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

/** Reshapes a rectangle to an aspect ratio around its own centre. */
function fitAspect(r: Rect, ratio: number): Rect {
  const media = edit.media;
  if (!media) return r;

  let w = r.w;
  let h = r.h;
  if (w / h > ratio) w = h * ratio;
  else h = w / ratio;

  const shrink = Math.min(1, media.width / w, media.height / h);
  w *= shrink;
  h *= shrink;

  return {
    x: clamp(r.x + r.w / 2 - w / 2, 0, media.width - w),
    y: clamp(r.y + r.h / 2 - h / 2, 0, media.height - h),
    w,
    h,
  };
}

function clamp(value: number, low: number, high: number): number {
  if (high < low) return low;
  return Math.min(Math.max(value, low), high);
}
