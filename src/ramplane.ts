/**
 * The speed channel: a second lane under the filmstrip, showing what the clip runs at across
 * its length and letting that be bent.
 *
 * It lives inside #tl-track rather than beside it, so the zoom width, the horizontal scroll,
 * the trim shades and the playhead are all inherited instead of mirrored. The only thing it
 * has to be told about is the zoom, which is local to timeline.ts and changes no app state.
 *
 * Speed runs up the lane on a log scale. Speed is multiplicative - half speed and double speed
 * are the same size of change in opposite directions - and on a log axis 1x lands exactly
 * halfway up the 0.05x to 20x range, which is where the eye expects "unchanged" to be.
 */

import {
  RAMP_MAX,
  RAMP_MIN,
  clampSpeed,
  multiplierAt,
  withPointAt,
  withPointMoved,
  withoutPoint,
} from './ramp';
import { edit, patchEdit, patchUi, subscribe, ui } from './state';
import { onZoom, pixelAt, timeAt, trackElement } from './timeline';

/** How finely the curve is drawn. One sample every few pixels is smooth enough for a
 *  logarithm and cheap enough to redraw on every pointer move. */
const SAMPLE_PIXELS = 4;

const LOG_MIN = Math.log(RAMP_MIN);
const LOG_SPAN = Math.log(RAMP_MAX) - LOG_MIN;

let lane!: HTMLElement;
let curve!: SVGSVGElement;
let line!: SVGPolylineElement;
let dots!: HTMLElement;
let readout!: HTMLElement;
let toggle!: HTMLButtonElement;

/** The point being dragged, or null. Held here rather than in app state: it is gone the
 *  moment the pointer lifts and nothing else needs to render from it. */
let dragging: number | null = null;

function el<T extends Element>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`FlipperClipper: index.html is missing #${id}`);
  return found as unknown as T;
}

export function initRampLane(): void {
  lane = el('tl-ramp');
  curve = el('tl-ramp-curve');
  line = el('tl-ramp-line');
  dots = el('tl-ramp-points');
  readout = el('tl-ramp-readout');
  toggle = el('tl-ramp-btn');

  toggle.addEventListener('click', toggleRampLane);

  lane.addEventListener('pointerdown', onLanePointerDown);
  lane.addEventListener('pointermove', onPointerMove);
  lane.addEventListener('pointerup', endDrag);
  lane.addEventListener('pointercancel', endDrag);
  // A wheel over the lane should zoom the timeline, the way it does over the strip. The track
  // listener sits on an ancestor, so letting the event through is all it takes.

  new ResizeObserver(render).observe(trackElement());
  onZoom(render);
  subscribe(render);
  render();
}

export function toggleRampLane(): void {
  if (!edit.media) return;
  patchUi({ rampOpen: !ui.rampOpen });
}

export function closeRampLane(): boolean {
  if (!ui.rampOpen) return false;
  patchUi({ rampOpen: false });
  return true;
}

/* --- Geometry --- */

/** Speed to a fraction of the lane's height, 0 at the bottom. */
function fractionOf(speed: number): number {
  const clamped = Math.min(Math.max(speed, RAMP_MIN), RAMP_MAX);
  return (Math.log(clamped) - LOG_MIN) / LOG_SPAN;
}

/** The inverse, for turning a drag back into a speed. */
function speedOf(fraction: number): number {
  return Math.exp(LOG_MIN + Math.min(Math.max(fraction, 0), 1) * LOG_SPAN);
}

function laneHeight(): number {
  return lane.clientHeight || 1;
}

function yOf(speed: number): number {
  return (1 - fractionOf(speed)) * laneHeight();
}

function speedAtY(clientY: number): number {
  const box = lane.getBoundingClientRect();
  if (box.height <= 0) return 1;
  return speedOf(1 - (clientY - box.top) / box.height);
}

/** What the clip actually runs at, which is the slider with the curve folded in. The lane
 *  works in this rather than in multipliers: a number the user can read off the picture. */
function effectiveAt(t: number): number {
  return edit.speed * multiplierAt(edit.ramp, t);
}

/** The multiplier that would make the clip run at `speed` here. Stored rather than the speed
 *  itself, so moving the slider afterwards bends the whole curve with it. */
function multiplierFor(speed: number): number {
  const base = edit.speed > 0 ? edit.speed : 1;
  return clampSpeed(speed / base);
}

/* --- Pointer --- */

function onLanePointerDown(e: PointerEvent): void {
  if (!edit.media) return;
  const target = e.target as HTMLElement;
  const index = Number(target.dataset.index ?? -1);

  if (index >= 0) {
    // A second click on a point takes it back out, which is how every curve editor removes one.
    if (e.detail > 1) {
      patchEdit({ ramp: withoutPoint(edit.ramp, index) });
      return;
    }
    dragging = index;
  } else {
    // Landing on empty lane drops a point where the pointer is and picks it straight up, so
    // one gesture both adds and places it.
    const t = timeAt(e.clientX);
    const next = withPointAt(edit.ramp, t, multiplierFor(speedAtY(e.clientY)));
    dragging = next.findIndex((p) => Math.abs(p.t - t) < 1e-9);
    patchEdit({ ramp: next });
  }

  // A capture the browser will not grant is not worth losing the drag over: without it the
  // move events still arrive, they just stop once the pointer leaves the lane.
  try {
    lane.setPointerCapture(e.pointerId);
  } catch {
    /* the drag works, it is only released early */
  }
  e.preventDefault();
  // The track below turns a press into a scrub, which would drag the playhead with the point.
  e.stopPropagation();
}

function onPointerMove(e: PointerEvent): void {
  if (dragging === null) return;
  const moved = withPointMoved(
    edit.ramp,
    dragging,
    timeAt(e.clientX),
    multiplierFor(speedAtY(e.clientY)),
  );
  patchEdit({ ramp: moved });
  e.preventDefault();
}

function endDrag(e: PointerEvent): void {
  if (dragging === null) return;
  dragging = null;
  try {
    if (lane.hasPointerCapture(e.pointerId)) lane.releasePointerCapture(e.pointerId);
  } catch {
    /* nothing was captured, which is the state this wanted anyway */
  }
  render();
}

/* --- Rendering --- */

function render(): void {
  const open = ui.rampOpen && edit.media !== null;
  lane.hidden = !open;
  toggle.classList.toggle('active', open);
  toggle.disabled = edit.media === null;
  // The timeline is taller while the lane is showing, and the strip gives up the difference.
  document.getElementById('timeline')?.classList.toggle('has-ramp', open);
  if (!open) return;

  drawCurve();
  drawPoints();
}

function drawCurve(): void {
  const media = edit.media;
  const width = trackElement().clientWidth;
  const height = laneHeight();
  if (!media || width <= 0) return;

  curve.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const steps = Math.max(2, Math.ceil(width / SAMPLE_PIXELS));
  const coords: string[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = (i / steps) * media.duration;
    coords.push(`${((i / steps) * width).toFixed(1)},${yOf(effectiveAt(t)).toFixed(1)}`);
  }
  line.setAttribute('points', coords.join(' '));
}

function drawPoints(): void {
  // Rebuilt rather than updated: a drag changes how many there are as often as where they sit,
  // and the handles carry no state of their own that a rebuild would lose.
  const made = edit.ramp.map((point, index) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'tl-ramp-dot';
    dot.dataset.index = String(index);
    dot.style.left = `${pixelAt(point.t)}px`;
    dot.style.top = `${yOf(edit.speed * point.speed)}px`;
    const speed = fmtSpeed(edit.speed * point.speed);
    dot.title = `${speed} here. Drag to move, double click to remove.`;
    dot.setAttribute('aria-label', `Speed point at ${point.t.toFixed(2)} seconds, ${speed}`);
    return dot;
  });
  dots.replaceChildren(...made);

  const point = dragging === null ? null : edit.ramp[dragging];
  readout.hidden = point === undefined || point === null;
  if (point) {
    readout.textContent = fmtSpeed(edit.speed * point.speed);
    readout.style.left = `${pixelAt(point.t)}px`;
    readout.style.top = `${yOf(edit.speed * point.speed)}px`;
  }
}

function fmtSpeed(speed: number): string {
  const rounded = speed >= 10 ? speed.toFixed(0) : speed >= 1 ? speed.toFixed(2) : speed.toFixed(3);
  return `${Number(rounded)}x`;
}
