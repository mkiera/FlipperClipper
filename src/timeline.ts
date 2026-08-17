import { edit, patchEdit, subscribe, ui } from './state';
import { beginScrub, currentTime, endScrub, onTime, pause, seek } from './player';

type Drag = 'in' | 'out' | 'scrub';

const ZOOM_MAX = 50;
const BUTTON_ZOOM_STEP = 1.5;
const WHEEL_ZOOM_STEP = 1.25;

let scroll!: HTMLElement;
let track!: HTMLElement;
let strip!: HTMLElement;
let shadeLeft!: HTMLElement;
let shadeRight!: HTMLElement;
let inHandle!: HTMLElement;
let outHandle!: HTMLElement;
let playhead!: HTMLElement;

let drag: Drag | null = null;
let grabOffset = 0;
let renderedStrip: string[] | null = null;

let zoom = 1;
let zoomedMedia: unknown = null;

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`FlipperClipper: index.html is missing #${id}`);
  return found as T;
}

export function initTimeline(): void {
  scroll = el('tl-scroll');
  track = el('tl-track');
  strip = el('tl-strip');
  shadeLeft = el('tl-shade-left');
  shadeRight = el('tl-shade-right');
  inHandle = el('tl-in');
  outHandle = el('tl-out');
  playhead = el('tl-playhead');

  track.addEventListener('pointerdown', onPointerDown);
  track.addEventListener('pointermove', onPointerMove);
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);

  // wheel listeners default to passive:true, which would ignore the preventDefault.
  scroll.addEventListener('wheel', onWheel, { passive: false });

  el('tl-zoom-in').addEventListener('click', () => stepZoom(BUTTON_ZOOM_STEP));
  el('tl-zoom-out').addEventListener('click', () => stepZoom(1 / BUTTON_ZOOM_STEP));
  el('tl-zoom-fit').addEventListener('click', resetZoom);

  subscribe(render);
  onTime(positionPlayhead);
  render();
}

// One frame is 16 ms on 60 fps footage, which no pointer can hit.
function minRange(): number {
  const fps = edit.media?.fps ?? 0;
  return Math.max(fps > 0 ? 1 / fps : 0.04, 0.05);
}

// Measures the track, not the scroll container: the track's rect already carries the scroll.
function timeAt(clientX: number): number {
  const media = edit.media;
  if (!media) return 0;
  const box = track.getBoundingClientRect();
  if (box.width <= 0) return 0;
  const fraction = (clientX - box.left) / box.width;
  return clamp(fraction * media.duration, 0, media.duration);
}

function pixelAt(t: number): number {
  const media = edit.media;
  if (!media || media.duration <= 0) return 0;
  return (t / media.duration) * track.clientWidth;
}

function onWheel(e: WheelEvent): void {
  if (!edit.media || e.deltaY === 0) return;
  e.preventDefault();
  const factor = e.deltaY < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP;
  setZoom(zoom * factor, e.clientX);
}

function stepZoom(factor: number): void {
  if (!edit.media) return;
  const box = scroll.getBoundingClientRect();
  setZoom(zoom * factor, box.left + box.width / 2);
}

function resetZoom(): void {
  zoom = 1;
  track.style.width = '100%';
  scroll.scrollLeft = 0;
}

function setZoom(next: number, anchorClientX: number): void {
  const clamped = clamp(next, 1, ZOOM_MAX);
  if (clamped === zoom) return;

  const anchorTime = timeAt(anchorClientX);
  const anchorOffset = anchorClientX - scroll.getBoundingClientRect().left;

  zoom = clamped;
  track.style.width = `${zoom * 100}%`;
  scroll.scrollLeft = pixelAt(anchorTime) - anchorOffset;
}

function onPointerDown(e: PointerEvent): void {
  if (!edit.media) return;
  const target = e.target as HTMLElement;

  if (inHandle.contains(target)) drag = 'in';
  else if (outHandle.contains(target)) drag = 'out';
  else drag = 'scrub';

  // 3px bracket, 20px hit box - without the offset the trim jumps on pointerdown.
  if (drag === 'scrub') {
    grabOffset = 0;
  } else {
    grabOffset = e.clientX - bracketX(drag === 'in' ? inHandle : outHandle);
    pause();
  }

  beginScrub();

  track.setPointerCapture(e.pointerId);
  track.classList.add('dragging');
  e.preventDefault();
  applyDrag(e.clientX - grabOffset);
}

function bracketX(handle: HTMLElement): number {
  const box = handle.getBoundingClientRect();
  return box.left + box.width / 2;
}

function onPointerMove(e: PointerEvent): void {
  if (drag) applyDrag(e.clientX - grabOffset);
}

function endDrag(e: PointerEvent): void {
  if (!drag) return;
  drag = null;
  track.classList.remove('dragging');
  if (track.hasPointerCapture(e.pointerId)) track.releasePointerCapture(e.pointerId);
  endScrub();
}

// Not from a state subscription: I and O set a point at the playhead, and would drag it along.
function applyDrag(clientX: number): void {
  const media = edit.media;
  if (!media || !drag) return;

  const t = timeAt(clientX);
  const gap = minRange();

  if (drag === 'in') {
    const inPoint = clamp(t, 0, edit.outPoint - gap);
    patchEdit({ inPoint });
    seek(inPoint);
  } else if (drag === 'out') {
    const outPoint = clamp(t, edit.inPoint + gap, media.duration);
    patchEdit({ outPoint });
    seek(outPoint);
  } else {
    seek(t);
  }
}

function render(): void {
  const media = edit.media;
  track.classList.toggle('empty', media === null);

  if (media !== zoomedMedia) {
    zoomedMedia = media;
    resetZoom();
  }

  if (!media || media.duration <= 0) {
    strip.replaceChildren();
    renderedStrip = null;
    shadeLeft.style.width = '0%';
    shadeRight.style.width = '0%';
    inHandle.style.left = '0%';
    outHandle.style.left = '100%';
    playhead.style.left = '0%';
    return;
  }

  const inPercent = (edit.inPoint / media.duration) * 100;
  const outPercent = (edit.outPoint / media.duration) * 100;

  shadeLeft.style.width = `${inPercent}%`;
  shadeRight.style.width = `${100 - outPercent}%`;
  inHandle.style.left = `${inPercent}%`;
  outHandle.style.left = `${outPercent}%`;

  renderStrip();
  positionPlayhead(currentTime());
}

// Array identity is enough: state.ts replaces the filmstrip array, never mutates it.
function renderStrip(): void {
  if (ui.filmstrip === renderedStrip) return;
  renderedStrip = ui.filmstrip;

  const frames = ui.filmstrip.map((src) => {
    const img = new Image();
    img.src = src;
    img.alt = '';
    img.draggable = false;
    return img;
  });
  strip.replaceChildren(...frames);
}

function positionPlayhead(t: number): void {
  const media = edit.media;
  if (!media || media.duration <= 0) return;
  playhead.style.left = `${(t / media.duration) * 100}%`;
  if (ui.playing && drag === null) followPlayhead(t);
}

function followPlayhead(t: number): void {
  const view = scroll.clientWidth;
  if (view <= 0) return;
  const px = pixelAt(t);
  const left = scroll.scrollLeft;

  if (px > left + view) scroll.scrollLeft = px - view * 0.2;
  else if (px < left) scroll.scrollLeft = px - view * 0.8;
}

function clamp(value: number, low: number, high: number): number {
  if (high < low) return low;
  return Math.min(Math.max(value, low), high);
}
