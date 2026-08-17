/**
 * Every keyboard shortcut, in one listener on the document.
 *
 * Keeping them here rather than next to the controls they drive means the list
 * of keys the app claims can be read in one place, which is the only way to
 * notice that two of them collide.
 */

import { beginExport, closeExportPopover, dismissToast } from './controls';
import { cancelCrop, confirmCrop, enterCrop, isCropping } from './crop';
import { currentTime, pause, seek, stepFrames, stepSeconds, togglePlay } from './player';
import { edit, patchEdit } from './state';

export interface ShortcutDeps {
  /** Ctrl+O. Owned by main.ts because opening is an app-level flow. */
  openFile: () => void;
}

export function initShortcuts(deps: ShortcutDeps): void {
  document.addEventListener('keydown', (e) => handleKey(e, deps));
}

/**
 * Typing in the quality dropdown or the lossless checkbox must not also scrub
 * the video. Space in particular is both "play/pause" and "activate the focused
 * control", and the focused control has to win or the app feels possessed.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el.isContentEditable;
}

function handleKey(e: KeyboardEvent, deps: ShortcutDeps): void {
  if (e.altKey) return;

  if (e.ctrlKey || e.metaKey) {
    const key = e.key.toLowerCase();
    if (key === 'o') {
      e.preventDefault();
      deps.openFile();
    } else if (key === 'e') {
      e.preventDefault();
      beginExport();
    }
    return;
  }

  if (isTypingTarget(e.target)) {
    // Escape still has to work from inside the popover, otherwise the only way
    // out of it is a mouse click.
    if (e.key === 'Escape') {
      e.preventDefault();
      escape();
    }
    return;
  }

  // A button that already has focus handles Space and Enter itself; claiming
  // them here would fire the button and the shortcut on one press.
  const onButton = (e.target as HTMLElement | null)?.tagName === 'BUTTON';

  switch (e.key) {
    case ' ':
      if (onButton) return;
      e.preventDefault();
      togglePlay();
      break;

    case 'Enter':
      if (onButton) return;
      if (isCropping()) {
        e.preventDefault();
        confirmCrop();
      }
      break;

    case 'Escape':
      e.preventDefault();
      escape();
      break;

    case 'ArrowLeft':
      e.preventDefault();
      if (e.shiftKey) stepSeconds(-1);
      else stepFrames(-1);
      break;

    case 'ArrowRight':
      e.preventDefault();
      if (e.shiftKey) stepSeconds(1);
      else stepFrames(1);
      break;

    case 'Home':
      e.preventDefault();
      seek(edit.inPoint);
      break;

    case 'End':
      e.preventDefault();
      pause();
      seek(edit.outPoint);
      break;

    case 'i':
    case 'I':
      e.preventDefault();
      setIn();
      break;

    case 'o':
    case 'O':
      e.preventDefault();
      setOut();
      break;

    case 'm':
    case 'M':
      e.preventDefault();
      if (edit.media?.hasAudio) patchEdit({ mute: !edit.mute });
      break;

    case 'c':
    case 'C':
      e.preventDefault();
      if (isCropping()) confirmCrop();
      else enterCrop();
      break;

    default:
      break;
  }
}

function escape(): void {
  if (isCropping()) {
    cancelCrop();
    return;
  }
  if (closeExportPopover()) return;
  dismissToast();
}

/** The same minimum range the timeline handles enforce. */
function minRange(): number {
  const fps = edit.media?.fps ?? 0;
  return Math.max(fps > 0 ? 1 / fps : 0.04, 0.05);
}

function setIn(): void {
  const media = edit.media;
  if (!media) return;
  const t = Math.min(currentTime(), edit.outPoint - minRange());
  patchEdit({ inPoint: Math.max(0, t) });
}

function setOut(): void {
  const media = edit.media;
  if (!media) return;
  const t = Math.max(currentTime(), edit.inPoint + minRange());
  patchEdit({ outPoint: Math.min(media.duration, t) });
}
