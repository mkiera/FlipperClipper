/**
 * The scrub strip: filmstrip background, shaded regions outside the trim,
 * in/out bracket handles and the playhead.
 *
 * Positions are written as percentages rather than pixels so that a window
 * resize needs no recalculation at all - the browser reflows the strip and
 * every marker keeps sitting on the right frame.
 */

import { edit, patchEdit, subscribe, ui } from './state';
import { currentTime, onTime, seek } from './player';

type Drag = 'in' | 'out' | 'scrub';

let track!: HTMLElement;
let strip!: HTMLElement;
let shadeLeft!: HTMLElement;
let shadeRight!: HTMLElement;
let inHandle!: HTMLElement;
let outHandle!: HTMLElement;
let playhead!: HTMLElement;

let drag: Drag | null = null;
/** Pointer x minus the grabbed bracket's own x, in pixels. Zero for a scrub. */
let grabOffset = 0;
let renderedStrip: string[] | null = null;

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`QuickClip: index.html is missing #${id}`);
  return found as T;
}

export function initTimeline(): void {
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

  subscribe(render);
  onTime(positionPlayhead);
  render();
}

/**
 * The smallest trim the handles will let you make. One frame is the honest
 * lower bound, but on a 60 fps clip that is 16 ms of pointer travel, which is
 * not a range anyone can actually hit, so 50 ms is the practical floor.
 */
function minRange(): number {
  const fps = edit.media?.fps ?? 0;
  return Math.max(fps > 0 ? 1 / fps : 0.04, 0.05);
}

function timeAt(clientX: number): number {
  const media = edit.media;
  if (!media) return 0;
  const box = track.getBoundingClientRect();
  if (box.width <= 0) return 0;
  const fraction = (clientX - box.left) / box.width;
  return clamp(fraction * media.duration, 0, media.duration);
}

function onPointerDown(e: PointerEvent): void {
  if (!edit.media) return;
  const target = e.target as HTMLElement;

  if (inHandle.contains(target)) drag = 'in';
  else if (outHandle.contains(target)) drag = 'out';
  else drag = 'scrub';

  // A bracket is drawn 3px wide but grabbed through a 20px box, so a grab
  // taken 10px off the line would otherwise move the trim point by those 10px
  // the instant the button went down, and the user has to drag it back. Held
  // as an offset rather than simply skipping the first apply so that the
  // bracket keeps tracking the cursor exactly for the rest of the drag.
  // A scrub has no such offset: clicking the strip means "go to this frame".
  if (drag === 'scrub') grabOffset = 0;
  else grabOffset = e.clientX - bracketX(drag === 'in' ? inHandle : outHandle);

  track.setPointerCapture(e.pointerId);
  track.classList.add('dragging');
  e.preventDefault();
  applyDrag(e.clientX - grabOffset);
}

/** The centre of a handle's hit box, which is where its bracket is drawn. */
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
}

function applyDrag(clientX: number): void {
  const media = edit.media;
  if (!media || !drag) return;

  const t = timeAt(clientX);
  const gap = minRange();

  if (drag === 'in') patchEdit({ inPoint: clamp(t, 0, edit.outPoint - gap) });
  else if (drag === 'out') patchEdit({ outPoint: clamp(t, edit.inPoint + gap, media.duration) });
  else seek(t);
}

function render(): void {
  const media = edit.media;
  track.classList.toggle('empty', media === null);

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

/**
 * The thumbnails arrive well after the file opens, and rebuilding the <img>
 * list on every state change would restart their decode each time a trim handle
 * moved. Comparing the array identity is enough because state.ts only ever
 * replaces the array, never mutates it.
 */
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
}

function clamp(value: number, low: number, high: number): number {
  if (high < low) return low;
  return Math.min(Math.max(value, low), high);
}
