/**
 * The clip channel: one block per clip across the top of the timeline, shown once there is
 * more than one. Inside #tl-track like the other lanes, so it shares the zoom, the scroll and
 * the playhead.
 *
 * Dragging a block moves the clip to where it is dropped. A click scrubs like the track does.
 * The cross on a block removes that clip.
 */

import { showToast } from './controls';
import { initStripWindowResize } from './mixer-window';
import { currentTime, pause, seek } from './player';
import {
  clipLength,
  clipStarts,
  fileName,
  locate,
  MAX_CLIPS,
  moveClip,
  removeClip,
  splitAt,
} from './sequence';
import { edit, setClips, subscribe } from './state';
import { onZoom, pixelAt, timeAt, trackElement } from './timeline';

/** The lane's height in px: room for an 11px label. */
const LANE = 22;

/** Narrower than this, a block shows no cross. */
const MIN_REMOVE_WIDTH = 30;

/** Further than this and a press on a block is a drag rather than a click. */
const DRAG_SLOP = 5;

interface Drag {
  index: number;
  startX: number;
  pointerId: number;
  moving: boolean;
  /** Where the clip would land if dropped now. */
  to: number;
}

let lane!: HTMLElement;
let marker!: HTMLElement;
let resizeWindow: ((height: number) => void) | null = null;
let drag: Drag | null = null;

export interface ClipLaneDeps {
  addClips: () => void;
}

export function initClipLane(deps: ClipLaneDeps): void {
  lane = el('tl-clips');
  resizeWindow = initStripWindowResize();
  marker = document.createElement('div');
  marker.className = 'tl-clip-marker';

  el('tl-add-clip').addEventListener('click', () => deps.addClips());
  el('tl-split').addEventListener('click', () => splitAtPlayhead());

  lane.addEventListener('pointerdown', onPointerDown);
  lane.addEventListener('pointermove', onPointerMove);
  lane.addEventListener('pointerup', endDrag);
  lane.addEventListener('pointercancel', cancelDrag);

  new ResizeObserver(render).observe(trackElement());
  onZoom(render);
  subscribe(render);
  render();
}

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`FlipperClipper: index.html is missing #${id}`);
  return found as T;
}

/** X, and the split button. */
export function splitAtPlayhead(): void {
  if (!edit.media) return;
  if (edit.clips.length >= MAX_CLIPS) {
    showToast(`The timeline holds up to ${MAX_CLIPS} clips.`);
    return;
  }
  const split = splitAt(edit.clips, currentTime());
  if (!split) {
    showToast('Move the playhead further from the edge of the clip to split it there.');
    return;
  }
  setClips(split);
}

/** Delete: the clip under the playhead. */
export function removeClipAtPlayhead(): boolean {
  if (edit.clips.length <= 1) return false;
  const hit = locate(edit.clips, currentTime());
  if (!hit) return false;
  return removeAt(hit.index);
}

function removeAt(index: number): boolean {
  const next = removeClip(edit.clips, index);
  if (!next) return false;
  pause();
  setClips(next);
  return true;
}

function blockAt(target: EventTarget | null): HTMLElement | null {
  return (target as HTMLElement | null)?.closest?.('.tl-clip') as HTMLElement | null;
}

function onPointerDown(e: PointerEvent): void {
  const target = e.target as HTMLElement;
  const remove = target.closest('.tl-clip-remove') as HTMLElement | null;
  const block = blockAt(target);
  // The track below turns a press into a scrub, which would fight the drag.
  e.stopPropagation();
  e.preventDefault();
  if (remove?.dataset.index !== undefined) {
    removeAt(Number(remove.dataset.index));
    return;
  }
  if (!block?.dataset.index) return;
  const index = Number(block.dataset.index);
  drag = { index, startX: e.clientX, pointerId: e.pointerId, moving: false, to: index };
  try {
    lane.setPointerCapture(e.pointerId);
  } catch {
    /* the drag still works while the pointer stays over the lane */
  }
}

function onPointerMove(e: PointerEvent): void {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const dx = e.clientX - drag.startX;
  if (!drag.moving && Math.abs(dx) < DRAG_SLOP) return;
  if (!drag.moving) {
    drag.moving = true;
    pause();
  }
  drag.to = dropIndex(e.clientX, drag.index);
  const block = lane.querySelector<HTMLElement>(`.tl-clip[data-index="${drag.index}"]`);
  if (block) {
    block.classList.add('dragging');
    block.style.transform = `translateX(${dx}px)`;
  }
  placeMarker(drag.index, drag.to);
}

/** Where a dragged clip lands: before the first of the others whose middle is right of the
 *  pointer. */
function dropIndex(clientX: number, from: number): number {
  const box = trackElement().getBoundingClientRect();
  const x = clientX - box.left;
  const starts = clipStarts(edit.clips);
  let to = 0;
  edit.clips.forEach((clip, index) => {
    if (index === from) return;
    const middle = pixelAt(starts[index] + clipLength(clip) / 2);
    if (x > middle) to += 1;
  });
  return to;
}

function placeMarker(from: number, to: number): void {
  const others = edit.clips.map((_, index) => index).filter((index) => index !== from);
  const starts = clipStarts(edit.clips);
  const total = starts.length > 0 ? starts[starts.length - 1] + clipLength(edit.clips[edit.clips.length - 1]) : 0;
  const before = others[to];
  const t = before === undefined ? total : starts[before];
  marker.style.left = `${pixelAt(t)}px`;
  if (!marker.isConnected) lane.append(marker);
}

function endDrag(e: PointerEvent): void {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const finished = drag;
  drag = null;
  release(e.pointerId);
  if (!finished.moving) {
    seek(timeAt(e.clientX));
    render();
    return;
  }
  const next = moveClip(edit.clips, finished.index, finished.to);
  if (next) setClips(next);
  else render();
}

function cancelDrag(e: PointerEvent): void {
  if (!drag) return;
  drag = null;
  release(e.pointerId);
  render();
}

function release(pointerId: number): void {
  try {
    if (lane.hasPointerCapture(pointerId)) lane.releasePointerCapture(pointerId);
  } catch {
    /* nothing was captured */
  }
}

function render(): void {
  const media = edit.media;
  const open = media !== null && edit.clips.length > 1;
  // The window grows by the lane, so the video keeps its size and place.
  resizeWindow?.(open ? LANE : 0);
  lane.hidden = !open;
  document.getElementById('timeline')?.classList.toggle('has-clips', open);
  el('tl-split').toggleAttribute('disabled', media === null);
  if (!open) {
    lane.replaceChildren();
    return;
  }
  if (drag?.moving) return;

  const starts = clipStarts(edit.clips);
  const blocks = edit.clips.map((clip, index) => {
    const block = document.createElement('div');
    block.className = 'tl-clip';
    block.dataset.index = String(index);
    const left = pixelAt(starts[index]);
    const width = Math.max(2, pixelAt(starts[index] + clipLength(clip)) - left);
    block.style.left = `${left}px`;
    block.style.width = `${width}px`;
    const name = fileName(clip.media.path);
    const seconds = clipLength(clip);
    block.title = `${name}, ${formatLength(seconds)}. Drag to move this clip.`;

    const label = document.createElement('span');
    label.className = 'tl-clip-name';
    label.textContent = `${index + 1}. ${name}`;
    block.append(label);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'tl-clip-remove';
    remove.dataset.index = String(index);
    remove.title = 'Remove this clip (Delete removes the one under the playhead)';
    remove.setAttribute('aria-label', `Remove clip ${index + 1}, ${name}`);
    remove.innerHTML =
      '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.4 3.3 3.6 3.6 3.6-3.6 1.1 1.1L9.1 8l3.6 3.6-1.1 1.1L8 9.1l-3.6 3.6-1.1-1.1L6.9 8 3.3 4.4z" /></svg>';
    // A block too narrow for its cross is still removed with Delete.
    if (width >= MIN_REMOVE_WIDTH) block.append(remove);
    return block;
  });
  lane.replaceChildren(...blocks);
}

function formatLength(seconds: number): string {
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
}
