import { applyUpdate, checkForUpdate, onUpdateProgress } from './ipc';
import { settings } from './state';
import { type UpdateInfo } from './types';

const CHECK_COOLDOWN_MS = 60 * 60 * 1000;

const LAST_CHECK_KEY = 'flipperclipper.lastUpdateCheck';

const CHECK_DELAY_MS = 2000;

/** How often the app looks again while it stays open. A clip gets edited over an afternoon and
 *  the app is rarely restarted, so a check that only ran at launch reached almost nobody. */
const RECHECK_MS = 60 * 60 * 1000;

const STYLE_ID = 'fc-updater-style';

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
/* A refusal is a whole sentence; ellipsising it tells the user nothing. */
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
let unlistenProgress: (() => void) | null = null;

/** The version the user waved away. A later release is a new offer and shows again. */
let dismissedVersion: string | null = null;

export function initUpdater(): void {
  window.setTimeout(() => {
    void check();
  }, CHECK_DELAY_MS);
  window.setInterval(() => void check(), RECHECK_MS);
}

async function check(): Promise<void> {
  // The Rust command answers the Settings button too, so the setting is read here instead:
  // switching the automatic check off must not make the button claim the build is current.
  if (!settings.autoCheckUpdates) return;
  if (!cooldownElapsed()) return;

  // Recorded before the request: a machine offline at every launch would re-check at every launch.
  const previous = stamp(Date.now());

  try {
    const info = await checkForUpdate();
    if (info) showUpdate(info);
  } catch {
    // A check that never reached GitHub has not used its turn. Without this an offline launch
    // burnt the whole hour, and with the recheck timer that meant one lost check per hour.
    stamp(previous);
  }
}

/** Writes the cooldown mark and returns what was there before, so a failure can put it back. */
function stamp(at: number | null): number | null {
  try {
    const had = localStorage.getItem(LAST_CHECK_KEY);
    if (at === null) localStorage.removeItem(LAST_CHECK_KEY);
    else localStorage.setItem(LAST_CHECK_KEY, String(at));
    return had === null ? null : Number(had);
  } catch {
    /* losing the cooldown is not a reason to skip the check */
    return null;
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

  // Phrased as "not inside the window" so a future or non-numeric stamp reads as due.
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

/** Put the offer on screen. Settings calls this too, so a check the user asked for lands
 *  somewhere that survives closing the panel. */
export function showUpdate(info: UpdateInfo, asked = false): void {
  // A dismissal silences the automatic offer, never an answer the user went and asked for.
  if (!asked && info.version === dismissedVersion) return;
  if (pill) {
    // A newer release than the one already on offer replaces it rather than queueing behind it.
    pill.remove();
    pill = null;
  }
  showPill(info);
}

function showPill(info: UpdateInfo): void {
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
    dismissedVersion = info.version;
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
    // Normally does not return: the Rust side spawns the installer and exits the app.
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
    // The Rust side refuses some updates for a reason the user can act on, so its own words go on the pill.
    const message = messageOf(error);
    label.textContent = message;
    pill?.classList.add('fc-update-failed');
    if (pill) pill.title = message;
  }
}

function messageOf(error: unknown): string {
  if (typeof error === 'string' && error.trim() !== '') return error;
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return 'Update failed';
}
