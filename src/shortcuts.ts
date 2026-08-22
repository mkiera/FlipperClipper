import {
  beginExport,
  closeExportPopover,
  dismissToast,
  toggleNormalize,
  toggleReverse,
  showToast,
} from './controls';
import { cancelCrop, confirmCrop, enterCrop, isCropping } from './crop';
import { closeEffectsPanel, toggleEffectsPanel } from './effectspanel';
import { closeRampLane, toggleRampLane } from './ramplane';
import { closeDevPanel } from './devpanel';
import { redo, undo } from './history';
import { currentTime, pause, seek, stepFrames, stepSeconds, togglePlay } from './player';
import { edit, patchEdit } from './state';

export interface ShortcutDeps {
  openFile: () => void;
}

export function initShortcuts(deps: ShortcutDeps): void {
  document.addEventListener('keydown', (e) => handleKey(e, deps));
}

// Space is both play/pause and "activate the focused control", and the control has to win.
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el.isContentEditable;
}

function handleKey(e: KeyboardEvent, deps: ShortcutDeps): void {
  if (e.altKey) return;

  if (e.ctrlKey || e.metaKey) {
    // Ahead of the branch, not after it: a Ctrl shortcut fired from inside the speed box or
    // the overlay textarea would export the clip instead of reaching the field the caret is in.
    if (isTypingTarget(e.target)) return;
    const key = e.key.toLowerCase();
    if (key === 'o') {
      e.preventDefault();
      deps.openFile();
    } else if (key === 'e') {
      e.preventDefault();
      beginExport();
    } else if (key === 'z' && !e.shiftKey) {
      e.preventDefault();
      step(undo, 'Nothing left to undo');
    } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
      // Both spellings: Ctrl+Y is the Windows one and Ctrl+Shift+Z the one every editor took.
      e.preventDefault();
      step(redo, 'Nothing to redo');
    }
    return;
  }

  if (isTypingTarget(e.target)) {
    if (e.key === 'Escape') {
      e.preventDefault();
      escape();
    }
    return;
  }

  // A focused button handles Space and Enter itself; claiming them fires both.
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
      if (edit.media?.hasAudio && !edit.audioOnly) patchEdit({ mute: !edit.mute });
      break;

    case 'r':
    case 'R':
      e.preventDefault();
      toggleReverse();
      break;

    case 'n':
    case 'N':
      e.preventDefault();
      // The same guard the button carries: there is no loudness to normalise without audio.
      if (edit.media?.hasAudio && !edit.mute) toggleNormalize();
      break;

    case 'f':
    case 'F':
      e.preventDefault();
      toggleEffectsPanel();
      break;

    case 's':
    case 'S':
      e.preventDefault();
      toggleRampLane();
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

/** Undo with a word when there is nothing left, rather than a keypress that does nothing and
 *  leaves the user wondering whether the shortcut works at all. */
function step(move: () => boolean, empty: string): void {
  if (!edit.media) return;
  if (!move()) showToast(empty);
}

function escape(): void {
  if (isCropping()) {
    cancelCrop();
    return;
  }
  if (closeDevPanel()) return;
  if (closeExportPopover()) return;
  if (closeEffectsPanel()) return;
  if (closeRampLane()) return;
  dismissToast();
}

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
