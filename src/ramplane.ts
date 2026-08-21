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

/** How close a drag has to come to a resting speed before it lands on one, in lane pixels.
 *  Wide enough to catch a deliberate move back to normal, narrow enough that a speed just
 *  either side of it can still be set. */
const SNAP_PIXELS = 7;

/** What the lane can be dragged between. The floor keeps the points reachable; the ceiling is
 *  a share of the window, since the lane grows the timeline at the stage's expense. */
const LANE_MIN = 36;
const LANE_MAX = 220;
const LANE_DEFAULT = 54;
const LANE_WINDOW_SHARE = 0.4;

const LANE_KEY = 'flipperclipper.rampLaneHeight';

/** How long after a tap a second one on the same point still counts as a double tap, and how
 *  far the pointer may have wandered between them. */
const DOUBLE_TAP_MS = 400;
const DOUBLE_TAP_SLOP = 8;

const LOG_MIN = Math.log(RAMP_MIN);
const LOG_SPAN = Math.log(RAMP_MAX) - LOG_MIN;

let lane!: HTMLElement;
let curve!: SVGSVGElement;
let line!: SVGPolylineElement;
let dots!: HTMLElement;
let readout!: HTMLElement;
let toggle!: HTMLButtonElement;
let grip!: HTMLElement;
let unity!: HTMLElement;

/** The point being dragged, or null. Held here rather than in app state: it is gone the
 *  moment the pointer lifts and nothing else needs to render from it. */
let dragging: number | null = null;

/** Where a lane resize started, so the drag measures against its own beginning rather than
 *  against a height it is itself changing. */
let resizing: { y: number; height: number } | null = null;

/** The last press on a point, for spotting the second half of a double tap. */
let lastTap: { index: number; at: number; x: number; y: number } | null = null;

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
  grip = el('tl-ramp-grip');
  unity = el('tl-ramp-unity');

  applyLaneHeight(rememberedLaneHeight());
  grip.addEventListener('pointerdown', onGripPointerDown);
  // The ceiling is a share of the window, so a lane sized on a big screen has to be brought
  // back in on a small one rather than eating the picture it is there to describe.
  window.addEventListener('resize', () => applyLaneHeight(lane.offsetHeight));

  toggle.addEventListener('click', toggleRampLane);

  lane.addEventListener('pointerdown', onLanePointerDown);
  lane.addEventListener('contextmenu', onLaneContextMenu);
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
  return snapped(speedOf(1 - (clientY - box.top) / box.height), box.height);
}

/**
 * A drag that comes close to a resting speed lands on it exactly.
 *
 * Real time is one such speed and is the reason this exists: a curve gets bent away from
 * normal and back, and hitting normal again by eye on a log axis is not something a pointer
 * can do. The slider's own speed is the other, for a clip already being run fast or slow,
 * where unchanged-from-the-slider is the resting point rather than 1x.
 */
function snapped(speed: number, height: number): number {
  const targets = [1];
  if (Math.abs(edit.speed - 1) > 1e-9) targets.push(edit.speed);

  let best = speed;
  let closest = SNAP_PIXELS;
  for (const target of targets) {
    const away = Math.abs(fractionOf(speed) - fractionOf(target)) * height;
    if (away < closest) {
      closest = away;
      best = target;
    }
  }
  return best;
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
  // The grip runs the full width of the lane's top edge, so it would otherwise read as a
  // click on empty lane and drop a point every time the lane was resized.
  if (target === grip) return;
  const index = Number(target.dataset.index ?? -1);

  if (index >= 0) {
    // A second press on a point takes it back out, which is how every curve editor removes one.
    if (isSecondTap(index, e)) {
      lastTap = null;
      patchEdit({ ramp: withoutPoint(edit.ramp, index) });
      return;
    }
    lastTap = { index, at: e.timeStamp, x: e.clientX, y: e.clientY };
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
  if (resizing) {
    // Upwards is taller: the lane is anchored at the bottom of the timeline.
    applyLaneHeight(resizing.height + (resizing.y - e.clientY));
    render();
    e.preventDefault();
    return;
  }
  if (dragging === null) return;
  // Moving the point ends any chance that this press was the first half of a double tap.
  lastTap = null;
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
  if (resizing) {
    resizing = null;
    lane.classList.remove('resizing');
    rememberLaneHeight();
    releaseCapture(e.pointerId);
    return;
  }
  if (dragging === null) return;
  dragging = null;
  releaseCapture(e.pointerId);
  render();
}

function releaseCapture(pointerId: number): void {
  try {
    if (lane.hasPointerCapture(pointerId)) lane.releasePointerCapture(pointerId);
  } catch {
    /* nothing was captured, which is the state this wanted anyway */
  }
}

/**
 * The second press of a double tap, worked out from the clock rather than read off the event.
 *
 * PointerEvent carries no click count to read - `detail` is not the one MouseEvent has - and
 * the dblclick that would carry it never arrives, because this handler cancels pointerdown to
 * stop the drag selecting text, and a cancelled pointerdown suppresses the compatibility mouse
 * events that dblclick is one of.
 */
function isSecondTap(index: number, e: PointerEvent): boolean {
  if (!lastTap || lastTap.index !== index) return false;
  if (e.timeStamp - lastTap.at > DOUBLE_TAP_MS) return false;
  return (
    Math.abs(e.clientX - lastTap.x) <= DOUBLE_TAP_SLOP &&
    Math.abs(e.clientY - lastTap.y) <= DOUBLE_TAP_SLOP
  );
}

/** Right click removes a point too. An 11px dot is a small target to hit twice running, and
 *  a menu the app has no other use for is worth spending on the one destructive action here. */
function onLaneContextMenu(e: MouseEvent): void {
  const index = Number((e.target as HTMLElement).dataset.index ?? -1);
  if (index < 0) return;
  e.preventDefault();
  lastTap = null;
  patchEdit({ ramp: withoutPoint(edit.ramp, index) });
}

/* --- Resizing --- */

function onGripPointerDown(e: PointerEvent): void {
  resizing = { y: e.clientY, height: lane.offsetHeight };
  lane.classList.add('resizing');
  try {
    lane.setPointerCapture(e.pointerId);
  } catch {
    /* the drag works, it is only released early */
  }
  e.preventDefault();
  e.stopPropagation();
}

/** The lane's height, clamped and written where the CSS reads it. The timeline is
 *  `--strip + --ramp-lane` tall, so this grows the row rather than squeezing the filmstrip. */
function applyLaneHeight(px: number): void {
  const ceiling = Math.min(LANE_MAX, Math.round(window.innerHeight * LANE_WINDOW_SHARE));
  const height = Math.round(Math.min(Math.max(px, LANE_MIN), Math.max(ceiling, LANE_MIN)));
  document.documentElement.style.setProperty('--ramp-lane', `${height}px`);
}

function rememberedLaneHeight(): number {
  const raw = Number(localStorage.getItem(LANE_KEY));
  return Number.isFinite(raw) && raw >= LANE_MIN ? raw : LANE_DEFAULT;
}

function rememberLaneHeight(): void {
  localStorage.setItem(LANE_KEY, String(lane.offsetHeight));
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

  unity.style.top = `${yOf(1)}px`;
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
    dot.title = `${speed} here. Drag to move, double click or right click to remove.`;
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
