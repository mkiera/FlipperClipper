/**
 * The update pill: a corner badge that appears when a newer release exists.
 *
 * The Rust side (src-tauri/src/updater.rs) does the checking, downloading and
 * installing. This file only decides *when* to ask and how quietly to say so.
 *
 * The three commands it needs go through src/ipc.ts like every other command in
 * the app: ipc.ts is the single module that imports @tauri-apps/*, so a change
 * to a command signature has exactly one place to land.
 */

import { applyUpdate, checkForUpdate, onUpdateProgress } from './ipc';
import { type UpdateInfo } from './types';

/** FinFetcher's CHECK_COOLDOWN_SECONDS = 3600, in the units localStorage uses. */
const CHECK_COOLDOWN_MS = 60 * 60 * 1000;

const LAST_CHECK_KEY = 'flipperclipper.lastUpdateCheck';

/**
 * How long after boot the check fires. GitHub is not going anywhere, and the
 * one thing the user is waiting for at startup is a window they can drop a
 * clip into, so the check gets out of the way of the first paint and of the
 * ffprobe that follows a drop.
 */
const CHECK_DELAY_MS = 2000;

const STYLE_ID = 'fc-updater-style';

/**
 * Scoped to `.fc-update-*` and injected from here rather than added to
 * styles.css, so the updater carries its own appearance and cannot collide
 * with the editor's stylesheet. Colours come from the app's custom properties
 * when it defines them, with a dark fallback for when it does not.
 */
const STYLE_TEXT = `
.fc-update-pill {
  position: fixed;
  top: 12px;
  right: 12px;
  z-index: 9999;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 320px;
  padding: 6px 8px 6px 14px;
  border-radius: 999px;
  border: 1px solid var(--border, rgba(127, 127, 127, 0.4));
  background: var(--bg, #1e1e1e);
  color: var(--fg, #f6f6f6);
  font-family: inherit;
  font-size: 13px;
  line-height: 20px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
}
.fc-update-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* A refusal from the Rust side is a whole sentence, and one truncated to
   "FlipperClipper is still exporting a c…" tells the user nothing they can act on. */
.fc-update-failed .fc-update-label {
  white-space: normal;
}
.fc-update-pill button {
  flex: none;
  margin: 0;
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
  box-shadow: none;
  transition: none;
}
.fc-update-action {
  padding: 2px 12px;
  border: none;
  border-radius: 999px;
  background: var(--accent, #396cd8);
  color: #ffffff;
}
.fc-update-action:disabled {
  opacity: 0.6;
  cursor: default;
}
.fc-update-dismiss {
  width: 22px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  opacity: 0.6;
}
.fc-update-dismiss:hover {
  opacity: 1;
}
.fc-update-track {
  flex: 1 1 90px;
  height: 4px;
  border-radius: 2px;
  background: var(--border, rgba(127, 127, 127, 0.4));
  overflow: hidden;
}
.fc-update-fill {
  width: 0%;
  height: 100%;
  border-radius: 2px;
  background: var(--accent, #396cd8);
  transition: width 0.15s linear;
}
`;

let pill: HTMLDivElement | null = null;
/** Spelled out rather than imported, because the name of it lives in @tauri-apps. */
let unlistenProgress: (() => void) | null = null;

export function initUpdater(): void {
  window.setTimeout(() => {
    void check();
  }, CHECK_DELAY_MS);
}

async function check(): Promise<void> {
  if (!cooldownElapsed()) return;

  // Recorded before the request, not after it. A machine that is offline at
  // every launch would otherwise re-check on every launch, and the answer is
  // the same each time.
  try {
    localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
  } catch {
    // Private-mode or a full quota. Losing the cooldown is not a reason to
    // skip the check itself.
  }

  try {
    const info = await checkForUpdate();
    if (info) showPill(info);
  } catch {
    // Offline, rate limited, GitHub having a bad day. None of these are worth
    // interrupting an edit over, and the next launch tries again.
  }
}

function cooldownElapsed(): boolean {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LAST_CHECK_KEY);
  } catch {
    return true;
  }
  if (raw === null) return true;

  // Written as "not inside the cooldown window" so that a stamp in the future
  // and a stamp that is not a number both come out as due. The first is a
  // clock that has since moved back, and the second is a hand-edited or
  // half-written value; being wedged off update checks until either of them
  // resolves itself is worse than one extra request.
  const elapsed = Date.now() - Number(raw);
  return !(elapsed >= 0 && elapsed < CHECK_COOLDOWN_MS);
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE_TEXT;
  document.head.appendChild(style);
}

function showPill(info: UpdateInfo): void {
  if (pill) return;
  ensureStyle();

  pill = document.createElement('div');
  pill.className = 'fc-update-pill';
  pill.title = info.releaseUrl;

  const label = document.createElement('span');
  label.className = 'fc-update-label';
  label.textContent = `v${info.version} available`;

  const track = document.createElement('div');
  track.className = 'fc-update-track';
  track.hidden = true;
  const fill = document.createElement('div');
  fill.className = 'fc-update-fill';
  track.appendChild(fill);

  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'fc-update-action';
  action.textContent = 'Update';

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'fc-update-dismiss';
  dismiss.textContent = '×';
  dismiss.setAttribute('aria-label', 'Dismiss');

  dismiss.addEventListener('click', () => {
    // For this session only. The cooldown stamp is what stops it coming back
    // immediately on the next launch; there is no permanent "skip version",
    // because an update the user actually does not want is one uninstall away
    // and this app holds no state worth protecting.
    pill?.remove();
    pill = null;
  });

  action.addEventListener('click', () => {
    void startUpdate(info, label, action, dismiss, track, fill);
  });

  pill.append(label, track, action, dismiss);
  document.body.appendChild(pill);
}

async function startUpdate(
  info: UpdateInfo,
  label: HTMLElement,
  action: HTMLButtonElement,
  dismiss: HTMLButtonElement,
  track: HTMLElement,
  fill: HTMLElement,
): Promise<void> {
  action.disabled = true;
  action.hidden = true;
  dismiss.hidden = true;
  track.hidden = false;
  fill.style.width = '0%';
  pill?.classList.remove('fc-update-failed');
  label.textContent = 'Downloading…';

  if (!unlistenProgress) {
    unlistenProgress = await onUpdateProgress((fraction) => {
      fill.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
    });
  }

  try {
    // This normally does not return: the Rust side spawns the installer and
    // exits the app, and the installer's [Run] entry starts the new version.
    // Reaching the catch below means the update did not happen.
    await applyUpdate(info);
    label.textContent = 'Installing…';
  } catch (error) {
    unlistenProgress?.();
    unlistenProgress = null;
    track.hidden = true;
    action.hidden = false;
    action.disabled = false;
    action.textContent = 'Retry';
    dismiss.hidden = false;
    // The Rust side refuses some updates for a reason the user can act on — an
    // export still running is the standing example — and "Update failed" would
    // send them straight back to Retry and the same refusal. Its own words go
    // on the pill; the class lets the label wrap, since a sentence does not fit
    // in the ellipsised single line a version number was sized for.
    const message = messageOf(error);
    label.textContent = message;
    pill?.classList.add('fc-update-failed');
    if (pill) pill.title = message;
  }
}

/**
 * A command that returns `Err(String)` rejects with that bare string, which is
 * the case worth reading well. Anything else - a thrown Error, a disconnected
 * bridge - has no wording written for a user, so it falls back to the generic
 * line rather than putting "[object Object]" on the pill.
 */
function messageOf(error: unknown): string {
  if (typeof error === 'string' && error.trim() !== '') return error;
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return 'Update failed';
}
