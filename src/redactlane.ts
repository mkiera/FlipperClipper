/**
 * The redaction channel: one row per redaction under the filmstrip, a bar where it shows and a
 * diamond at each keyframe. Inside #tl-track like the speed lane, so it inherits the zoom, the
 * scroll and the playhead.
 *
 * Pressing a diamond jumps the playhead to it and picks it up: dragging moves the keyframe in
 * time. A double tap or a right click removes it. Pressing a row selects that redaction and
 * scrubs as usual.
 */

import { seek } from './player';
import { withKeyMoved, withoutKey } from './redact';
import { redactItems, selectRedaction, selectedRedaction, updateRedaction } from './redactedit';
import { edit, subscribe } from './state';
import { onZoom, pixelAt, timeAt, trackElement } from './timeline';
import type { RedactItem } from './types';

/** One row's height in px. Room for an 11px diamond and the bar behind it. */
const ROW = 16;

const DOUBLE_TAP_MS = 400;
const DOUBLE_TAP_SLOP = 8;

let lane!: HTMLElement;
let dragging: { id: number; index: number } | null = null;
let lastTap: { id: number; index: number; at: number; x: number } | null = null;

export function initRedactLane(): void {
  const found = document.getElementById('tl-redact');
  if (!found) throw new Error('FlipperClipper: index.html is missing #tl-redact');
  lane = found;

  lane.addEventListener('pointerdown', onPointerDown);
  lane.addEventListener('pointermove', onPointerMove);
  lane.addEventListener('pointerup', endDrag);
  lane.addEventListener('pointercancel', endDrag);
  lane.addEventListener('contextmenu', onContextMenu);

  new ResizeObserver(render).observe(trackElement());
  onZoom(render);
  subscribe(render);
  render();
}

function keyTarget(target: EventTarget | null): { id: number; index: number } | null {
  const el = target as HTMLElement | null;
  if (!el?.dataset || el.dataset.index === undefined) return null;
  return { id: Number(el.dataset.id), index: Number(el.dataset.index) };
}

function itemById(id: number): RedactItem | undefined {
  return redactItems().find((item) => item.id === id);
}

function onPointerDown(e: PointerEvent): void {
  const hit = keyTarget(e.target);
  if (!hit) {
    // A press on a row picks that redaction and falls through to the track's scrub.
    const row = (e.target as HTMLElement).closest('.tl-redact-row') as HTMLElement | null;
    if (row) selectRedaction(Number(row.dataset.id));
    return;
  }
  const item = itemById(hit.id);
  const key = item?.keys[hit.index];
  if (!item || !key) return;

  if (
    lastTap &&
    lastTap.id === hit.id &&
    lastTap.index === hit.index &&
    e.timeStamp - lastTap.at <= DOUBLE_TAP_MS &&
    Math.abs(e.clientX - lastTap.x) <= DOUBLE_TAP_SLOP
  ) {
    lastTap = null;
    updateRedaction(hit.id, (it) => withoutKey(it, hit.index));
  } else {
    lastTap = { ...hit, at: e.timeStamp, x: e.clientX };
    selectRedaction(hit.id);
    seek(key.t);
    dragging = hit;
    try {
      lane.setPointerCapture(e.pointerId);
    } catch {
      /* the drag works, it is only released early */
    }
  }
  e.preventDefault();
  // The track below turns a press into a scrub, which would drag the playhead off the key.
  e.stopPropagation();
}

function onPointerMove(e: PointerEvent): void {
  if (!dragging) return;
  const item = itemById(dragging.id);
  if (!item) return;
  const t = timeAt(e.clientX);
  if (Math.abs((item.keys[dragging.index]?.t ?? t) - t) < 1e-6) return;
  lastTap = null;
  const moved = withKeyMoved(item, dragging.index, t);
  dragging = { id: dragging.id, index: moved.index };
  updateRedaction(item.id, () => moved.item);
  seek(t);
  e.preventDefault();
}

function endDrag(e: PointerEvent): void {
  if (!dragging) return;
  dragging = null;
  try {
    if (lane.hasPointerCapture(e.pointerId)) lane.releasePointerCapture(e.pointerId);
  } catch {
    /* nothing was captured */
  }
}

function onContextMenu(e: MouseEvent): void {
  const hit = keyTarget(e.target);
  if (!hit) return;
  e.preventDefault();
  lastTap = null;
  updateRedaction(hit.id, (it) => withoutKey(it, hit.index));
}

/** The stretches of source time where the redaction shows. */
function shownSpans(item: RedactItem, duration: number): [number, number][] {
  if (item.keys.length === 0) return item.on ? [[0, duration]] : [];
  const spans: [number, number][] = [];
  const edges = [0, ...item.keys.map((key) => key.t), duration];
  for (let i = 0; i < edges.length - 1; i += 1) {
    // Before the first keyframe the first one holds; after that each keyframe rules until
    // the next.
    const key = item.keys[Math.max(0, i - 1)];
    const start = Math.min(Math.max(edges[i], 0), duration);
    const end = Math.min(Math.max(edges[i + 1], 0), duration);
    if (key.on && end > start) spans.push([start, end]);
  }
  return spans;
}

function render(): void {
  const media = edit.media;
  const items = redactItems();
  const open = media !== null && edit.effects.on.redact && items.length > 0;
  lane.hidden = !open;
  document.getElementById('timeline')?.classList.toggle('has-redact', open);
  if (!open || !media) return;

  document.documentElement.style.setProperty('--redact-lane', `${items.length * ROW + 4}px`);
  const selected = selectedRedaction();

  const rows = items.map((item, row) => {
    const el = document.createElement('div');
    el.className = 'tl-redact-row';
    el.classList.toggle('selected', item.id === selected?.id);
    el.dataset.id = String(item.id);
    el.title = `Redaction ${row + 1}`;

    for (const [start, end] of shownSpans(item, media.duration)) {
      const bar = document.createElement('span');
      bar.className = 'tl-redact-span';
      bar.style.left = `${pixelAt(start)}px`;
      bar.style.width = `${Math.max(1, pixelAt(end) - pixelAt(start))}px`;
      el.append(bar);
    }

    item.keys.forEach((key, index) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'tl-redact-key';
      dot.classList.toggle('off', !key.on);
      dot.dataset.id = String(item.id);
      dot.dataset.index = String(index);
      dot.style.left = `${pixelAt(key.t)}px`;
      const state = key.on ? 'visible' : 'hidden';
      dot.title = `Keyframe at ${key.t.toFixed(2)}s, ${state}. Click to jump, drag to move, double click or right click to remove.`;
      dot.setAttribute('aria-label', `Redaction ${row + 1} keyframe at ${key.t.toFixed(2)} seconds, ${state}`);
      el.append(dot);
    });
    return el;
  });
  lane.replaceChildren(...rows);
}
