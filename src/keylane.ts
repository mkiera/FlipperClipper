/**
 * The keyframe channel: one row per redaction and per keyframed effect under the filmstrip, a
 * bar where it acts and a diamond at each keyframe. Inside #tl-track like the speed lane, so
 * it inherits the zoom, the scroll and the playhead.
 *
 * Pressing a diamond jumps the playhead to it and picks it up: dragging moves the keyframe in
 * time. A double tap or a right click removes it. Pressing a redaction's row selects that
 * redaction, and every row press scrubs as usual.
 */

import {
  EFFECT_IDS,
  EFFECT_LABEL,
  effectKeys,
  isKeyed,
  withEffectKeyMoved,
  withoutEffectKey,
} from './effects';
import { initStripWindowResize } from './mixer-window';
import { seek } from './player';
import { withKeyMoved, withoutKey } from './redact';
import { redactItems, selectRedaction, selectedRedaction, updateRedaction } from './redactedit';
import { edit, patchEdit, subscribe } from './state';
import { onZoom, pixelAt, timeAt, trackElement } from './timeline';
import { onSpans } from './valuekeys';

/** One row's height in px. Room for an 11px diamond and the bar behind it. */
const ROW = 16;

const DOUBLE_TAP_MS = 400;
const DOUBLE_TAP_SLOP = 8;

/** What a row shows and how its keyframes change. `row` names it for the pointer handlers:
 *  "r<id>" for a redaction, the effect id for an effect. */
interface LaneRow {
  row: string;
  name: string;
  keys: { t: number; on: boolean }[];
  spans: [number, number][];
  selected: boolean;
  select?: () => void;
  /** Moves keyframe `index` to `t` and returns where it landed. */
  move: (index: number, t: number) => number;
  remove: (index: number) => void;
}

let lane!: HTMLElement;
let resizeWindow: ((height: number) => void) | null = null;
let dragging: { row: string; index: number } | null = null;
let lastTap: { row: string; index: number; at: number; x: number } | null = null;

export function initKeyLane(): void {
  const found = document.getElementById('tl-keys');
  if (!found) throw new Error('FlipperClipper: index.html is missing #tl-keys');
  lane = found;
  resizeWindow = initStripWindowResize();

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

function laneRows(duration: number): LaneRow[] {
  const rows: LaneRow[] = [];
  const effects = edit.effects;
  for (const id of EFFECT_IDS) {
    if (id === 'redact') {
      if (!effects.on.redact) continue;
      const selected = selectedRedaction();
      redactItems().forEach((item, n) => {
        rows.push({
          row: `r${item.id}`,
          name: `Redact ${n + 1}`,
          keys: item.keys,
          spans:
            item.keys.length === 0 ? (item.on ? [[0, duration]] : []) : onSpans(item.keys, duration),
          selected: item.id === selected?.id,
          select: () => selectRedaction(item.id),
          move: (index, t) => {
            const current = redactItems().find((it) => it.id === item.id);
            if (!current) return index;
            const moved = withKeyMoved(current, index, t);
            updateRedaction(item.id, () => moved.item);
            return moved.index;
          },
          remove: (index) => updateRedaction(item.id, (it) => withoutKey(it, index)),
        });
      });
      continue;
    }
    if (!isKeyed(id) || !effects.on[id]) continue;
    const keys = effectKeys(effects, id);
    if (keys.length === 0) continue;
    rows.push({
      row: id,
      name: EFFECT_LABEL[id],
      keys,
      spans: onSpans(keys, duration),
      selected: false,
      move: (index, t) => {
        const moved = withEffectKeyMoved(edit.effects, id, index, t);
        patchEdit({ effects: moved.effects });
        return moved.index;
      },
      remove: (index) => patchEdit({ effects: withoutEffectKey(edit.effects, id, index) }),
    });
  }
  return rows;
}

function rowByName(row: string): LaneRow | undefined {
  const duration = edit.media?.duration ?? 0;
  return laneRows(duration).find((r) => r.row === row);
}

function keyTarget(target: EventTarget | null): { row: string; index: number } | null {
  const el = target as HTMLElement | null;
  if (!el?.dataset || el.dataset.index === undefined || el.dataset.row === undefined) return null;
  return { row: el.dataset.row, index: Number(el.dataset.index) };
}

function onPointerDown(e: PointerEvent): void {
  const hit = keyTarget(e.target);
  if (!hit) {
    // A press on a row picks that redaction and falls through to the track's scrub.
    const rowEl = (e.target as HTMLElement).closest('.tl-key-row') as HTMLElement | null;
    if (rowEl?.dataset.row) rowByName(rowEl.dataset.row)?.select?.();
    return;
  }
  const row = rowByName(hit.row);
  const key = row?.keys[hit.index];
  if (!row || !key) return;

  if (
    lastTap &&
    lastTap.row === hit.row &&
    lastTap.index === hit.index &&
    e.timeStamp - lastTap.at <= DOUBLE_TAP_MS &&
    Math.abs(e.clientX - lastTap.x) <= DOUBLE_TAP_SLOP
  ) {
    lastTap = null;
    row.remove(hit.index);
  } else {
    lastTap = { ...hit, at: e.timeStamp, x: e.clientX };
    row.select?.();
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
  const row = rowByName(dragging.row);
  if (!row) return;
  const t = timeAt(e.clientX);
  if (Math.abs((row.keys[dragging.index]?.t ?? t) - t) < 1e-6) return;
  lastTap = null;
  const index = row.move(dragging.index, t);
  dragging = { row: dragging.row, index };
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
  rowByName(hit.row)?.remove(hit.index);
}

function render(): void {
  const media = edit.media;
  const rows = media ? laneRows(media.duration) : [];
  const open = media !== null && rows.length > 0;
  // The window grows by the lane, so the video keeps its size and place.
  resizeWindow?.(open ? rows.length * ROW + 4 : 0);
  lane.hidden = !open;
  document.getElementById('timeline')?.classList.toggle('has-keys', open);
  if (!open || !media) return;

  document.documentElement.style.setProperty('--key-lane', `${rows.length * ROW + 4}px`);

  const els = rows.map((row) => {
    const el = document.createElement('div');
    el.className = 'tl-key-row';
    el.classList.toggle('selected', row.selected);
    el.dataset.row = row.row;
    el.title = row.name;

    const name = document.createElement('span');
    name.className = 'tl-key-name';
    name.textContent = row.name;
    el.append(name);

    for (const [start, end] of row.spans) {
      const bar = document.createElement('span');
      bar.className = 'tl-key-span';
      bar.style.left = `${pixelAt(start)}px`;
      bar.style.width = `${Math.max(1, pixelAt(end) - pixelAt(start))}px`;
      el.append(bar);
    }

    row.keys.forEach((key, index) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'tl-key';
      dot.classList.toggle('off', !key.on);
      dot.dataset.row = row.row;
      dot.dataset.index = String(index);
      dot.style.left = `${pixelAt(key.t)}px`;
      const state = key.on ? 'on' : 'off';
      dot.title = `${row.name} keyframe at ${key.t.toFixed(2)}s, ${state}. Click to jump, drag to move, double click or right click to remove.`;
      dot.setAttribute('aria-label', `${row.name} keyframe at ${key.t.toFixed(2)} seconds, ${state}`);
      el.append(dot);
    });
    return el;
  });
  lane.replaceChildren(...els);
}
