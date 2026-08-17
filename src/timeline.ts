/**
 * The scrub strip: filmstrip background, shaded regions outside the trim,
 * in/out bracket handles, the playhead, and the zoom that makes a two-minute
 * clip trimmable to the frame.
 *
 * Positions inside the track are written as percentages rather than pixels so
 * that a window resize needs no recalculation at all - the browser reflows the
 * strip and every marker keeps sitting on the right frame. Zoom rides on the
 * same idea: the track is simply `zoom * 100%` wide inside a scroll container,
 * so the native horizontal scrollbar is the panning UI and every percentage
 * position stays valid untouched.
 */

import { edit, patchEdit, subscribe, ui } from './state';
import { beginScrub, currentTime, endScrub, onTime, pause, seek } from './player';

type Drag = 'in' | 'out' | 'scrub';

/**
 * Above 50x a 10-minute clip already spreads one second across a third of the
 * viewport, and the 16-frame filmstrip has long since dissolved into blur;
 * more zoom is just more scrollbar.
 */
const ZOOM_MAX = 50;
/** Buttons step coarser than the wheel: they are for "much closer", not nudging. */
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
/** Pointer x minus the grabbed bracket's own x, in pixels. Zero for a scrub. */
let grabOffset = 0;
let renderedStrip: string[] | null = null;

let zoom = 1;
/** The clip the current zoom belongs to; a freshly opened file starts at 1x. */
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

  // Wheel zoom needs preventDefault to stop the container scrolling at the
  // same time, and an addEventListener default of passive:true on wheel would
  // silently ignore that call.
  scroll.addEventListener('wheel', onWheel, { passive: false });

  el('tl-zoom-in').addEventListener('click', () => stepZoom(BUTTON_ZOOM_STEP));
  el('tl-zoom-out').addEventListener('click', () => stepZoom(1 / BUTTON_ZOOM_STEP));
  el('tl-zoom-fit').addEventListener('click', resetZoom);

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

/**
 * The one clientX-to-time conversion. It measures the track itself, not the
 * scroll container: when the strip is zoomed and scrolled, the track's
 * bounding rect has already moved left by the scroll amount, so the fraction
 * along the track is correct with no explicit scrollLeft or zoom arithmetic.
 * Anything that recomputed this from the container's geometry would have to
 * repeat that arithmetic and would drift from this the day one of them changes.
 */
function timeAt(clientX: number): number {
  const media = edit.media;
  if (!media) return 0;
  const box = track.getBoundingClientRect();
  if (box.width <= 0) return 0;
  const fraction = (clientX - box.left) / box.width;
  return clamp(fraction * media.duration, 0, media.duration);
}

/** Where a time sits in track pixels, for scroll positioning only. */
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

/**
 * Zooms so that the time under `anchorClientX` stays under it. The anchor time
 * is read before the track is resized and re-pinned after, which is what makes
 * wheel zoom feel like it dives toward the cursor instead of sliding the strip
 * away from the frame being aimed at.
 */
function setZoom(next: number, anchorClientX: number): void {
  const clamped = clamp(next, 1, ZOOM_MAX);
  if (clamped === zoom) return;

  const anchorTime = timeAt(anchorClientX);
  const anchorOffset = anchorClientX - scroll.getBoundingClientRect().left;

  zoom = clamped;
  track.style.width = `${zoom * 100}%`;
  // The browser clamps scrollLeft into range, so zooming out near an edge
  // needs no explicit bounds handling here.
  scroll.scrollLeft = pixelAt(anchorTime) - anchorOffset;
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
  if (drag === 'scrub') {
    grabOffset = 0;
  } else {
    grabOffset = e.clientX - bracketX(drag === 'in' ? inHandle : outHandle);
    // A running preview fights the handle for the playhead, and the out point
    // is exactly where the pump rewinds to the in point.
    pause();
  }

  // All three drags steer the playhead, so all three take the coalescer's
  // scrub path: sloppy while moving, exact on release.
  beginScrub();

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
  endScrub();
}

/**
 * A bracket drag parks the preview on the frame it is choosing. Done here and
 * not from a state subscription: I and O set a point at the playhead, and
 * reacting to the change would drag the playhead around with them.
 */
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

/**
 * The thumbnails arrive well after the file opens, and rebuilding the <img>
 * list on every state change would restart their decode each time a trim handle
 * moved. Comparing the array identity is enough because state.ts only ever
 * replaces the array, never mutates it.
 *
 * The strip is deliberately NOT regenerated on zoom: 16 frames stretched wide
 * look soft, but re-running ffmpeg per zoom level would thrash the disk for
 * thumbnails that are only ever a rough map of the clip.
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
  if (ui.playing && drag === null) followPlayhead(t);
}

/**
 * Keeps the playhead visible while zoomed in, the way editors do it: when it
 * runs off the visible span, the view jumps so the playhead re-enters with 80%
 * of the viewport of runway ahead of it. Scrolling a little every frame
 * instead would keep the playhead still and make the strip swim underneath it,
 * which reads as the whole timeline drifting.
 */
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
