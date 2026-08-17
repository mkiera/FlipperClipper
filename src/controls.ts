/**
 * The control row, the export flow, and the two bits of transient chrome that
 * do not belong to any one control: banners along the top and a toast at the
 * bottom.
 */

import {
  cancelExport,
  copyFileToClipboard,
  installFfmpeg,
  onExportDone,
  onExportError,
  onExportProgress,
  pickExportTarget,
  revealInExplorer,
  startExport,
} from './ipc';
import { edit, patchEdit, patchUi, subscribe, ui } from './state';
import { currentTime, onTime, togglePlay } from './player';
import { toggleCrop } from './crop';
import { isTrimOnly, outputDuration, type ExportJob, type QualityPreset } from './types';

const SPEEDS: number[] = [0.25, 0.5, 1, 1.5, 2, 4];

/** How long a success toast stays up. Errors ignore this and wait to be closed. */
const TOAST_MS = 9000;

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface BannerOptions {
  message: string;
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
  dismissible?: boolean;
}

let playBtn!: HTMLButtonElement;
let timeLabel!: HTMLElement;
let speedChips!: HTMLElement;
let cropBtn!: HTMLButtonElement;
let muteBtn!: HTMLButtonElement;
let qualitySelect!: HTMLSelectElement;
let exportBtn!: HTMLButtonElement;
let exportRunning!: HTMLElement;
let exportFill!: HTMLElement;
let exportText!: HTMLElement;
let popover!: HTMLElement;
let losslessBox!: HTMLInputElement;
let banners!: HTMLElement;
let toast!: HTMLElement;
let toastMsg!: HTMLElement;
let toastActions!: HTMLElement;

let toastTimer = 0;

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`QuickClip: index.html is missing #${id}`);
  return found as T;
}

export function initControls(): void {
  playBtn = el<HTMLButtonElement>('play');
  timeLabel = el('time');
  speedChips = el('speed-chips');
  cropBtn = el<HTMLButtonElement>('crop-btn');
  muteBtn = el<HTMLButtonElement>('mute-btn');
  qualitySelect = el<HTMLSelectElement>('quality');
  exportBtn = el<HTMLButtonElement>('export-btn');
  exportRunning = el('export-running');
  exportFill = el('export-fill');
  exportText = el('export-text');
  popover = el('export-popover');
  losslessBox = el<HTMLInputElement>('lossless');
  banners = el('banners');
  toast = el('toast');
  toastMsg = el('toast-msg');
  toastActions = el('toast-actions');

  buildSpeedChips();

  playBtn.addEventListener('click', togglePlay);
  cropBtn.addEventListener('click', toggleCrop);
  muteBtn.addEventListener('click', () => patchEdit({ mute: !edit.mute }));

  qualitySelect.value = edit.quality;
  qualitySelect.addEventListener('change', () => {
    patchEdit({ quality: qualitySelect.value as QualityPreset });
  });

  exportBtn.addEventListener('click', beginExport);
  el('export-cancel').addEventListener('click', cancelRunningExport);

  el('popover-cancel').addEventListener('click', closePopover);
  el('popover-go').addEventListener('click', () => {
    patchEdit({ lossless: losslessBox.checked });
    closePopover();
    void runExport();
  });

  el('toast-close').addEventListener('click', dismissToast);

  // A click anywhere else is the normal way people dismiss a popover, and
  // without this it survives until the next Escape, floating over the timeline.
  document.addEventListener('pointerdown', (e) => {
    if (popover.hidden) return;
    const target = e.target as Node;
    if (!popover.contains(target) && !exportBtn.contains(target)) closePopover();
  });

  void onExportProgress((p) => patchUi({ exportPercent: clamp01(p.percent) }));
  void onExportDone(onExportFinished);
  void onExportError((message) => {
    patchUi({ exporting: false, exportPercent: 0 });
    showToast(message, [], true);
  });

  subscribe(render);
  onTime(renderTime);
  render();
}

/* --------------------------------------------------------------------------
 * Rendering
 * ----------------------------------------------------------------------- */

function buildSpeedChips(): void {
  const chips = SPEEDS.map((speed) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = String(speed);
    chip.title = `${speed}x speed`;
    chip.dataset.speed = String(speed);
    chip.addEventListener('click', () => patchEdit({ speed }));
    return chip;
  });
  speedChips.replaceChildren(...chips);
}

function render(): void {
  const hasMedia = edit.media !== null;

  playBtn.disabled = !hasMedia;
  playBtn.classList.toggle('is-playing', ui.playing);
  playBtn.setAttribute('aria-label', ui.playing ? 'Pause' : 'Play');

  for (const chip of Array.from(speedChips.children)) {
    const speed = Number((chip as HTMLElement).dataset.speed);
    chip.classList.toggle('active', speed === edit.speed);
    (chip as HTMLButtonElement).disabled = !hasMedia;
  }

  cropBtn.disabled = !hasMedia;
  cropBtn.classList.toggle('active', ui.cropping || edit.crop !== null);

  const hasAudio = edit.media?.hasAudio ?? false;
  muteBtn.hidden = hasMedia && !hasAudio;
  muteBtn.disabled = !hasMedia;
  muteBtn.classList.toggle('is-muted', edit.mute);
  muteBtn.classList.toggle('active', edit.mute);
  const muteLabel = muteBtn.querySelector('.btn-label');
  if (muteLabel) muteLabel.textContent = edit.mute ? 'Muted' : 'Sound';

  qualitySelect.value = edit.quality;
  qualitySelect.disabled = ui.exporting;

  exportBtn.hidden = ui.exporting;
  exportBtn.disabled = !hasMedia || !ui.ffmpegAvailable;
  exportRunning.hidden = !ui.exporting;

  const percent = Math.round(ui.exportPercent * 100);
  exportFill.style.width = `${percent}%`;
  exportText.textContent = `${percent}%`;

  renderTime(currentTime());
}

function renderTime(t: number): void {
  const total = outputDuration(edit);
  const position = edit.speed > 0 ? (t - edit.inPoint) / edit.speed : 0;
  timeLabel.textContent = `${formatTime(clamp(position, 0, total))} / ${formatTime(total)}`;
}

/**
 * m:ss.d - one decimal is what you need to judge a frame-accurate trim, and a
 * second decimal just makes the readout twitch.
 */
function formatTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  const whole = Math.floor(rest);
  const tenths = Math.floor((rest - whole) * 10);
  return `${minutes}:${String(whole).padStart(2, '0')}.${tenths}`;
}

/* --------------------------------------------------------------------------
 * Export
 * ----------------------------------------------------------------------- */

export function beginExport(): void {
  if (!edit.media || ui.exporting || !ui.ffmpegAvailable) return;

  // The lossless question only has an answer when a stream copy would actually
  // produce the asked-for clip, so for every other edit the popover would be a
  // dialog with nothing in it.
  if (isTrimOnly(edit)) {
    losslessBox.checked = edit.lossless;
    popover.hidden = false;
    losslessBox.focus();
    return;
  }

  void runExport();
}

function closePopover(): void {
  popover.hidden = true;
}

/** Returns whether there was a popover to close, which Escape needs to know. */
export function closeExportPopover(): boolean {
  if (popover.hidden) return false;
  closePopover();
  return true;
}

async function runExport(): Promise<void> {
  const media = edit.media;
  if (!media || ui.exporting) return;

  const target = await pickExportTarget(defaultOutputPath(media.path));
  if (!target) return;

  const job: ExportJob = {
    input: media.path,
    output: target,
    inPoint: edit.inPoint,
    outPoint: edit.outPoint,
    speed: edit.speed,
    crop: edit.crop,
    mute: edit.mute,
    quality: edit.quality,
    // Belt and braces: the checkbox is only reachable while the edit is
    // trim-only, but the edit can change between opening the popover and
    // getting through the save dialog.
    lossless: edit.lossless && isTrimOnly(edit),
  };

  patchUi({ exporting: true, exportPercent: 0 });
  try {
    await startExport(job);
  } catch (error) {
    patchUi({ exporting: false, exportPercent: 0 });
    showToast(describe(error), [], true);
  }
}

/**
 * A cancelled export is the one ending that reports nothing: the Rust side
 * kills ffmpeg, deletes the half-written file and returns without emitting
 * export-done or export-error, because neither is true of a job the user
 * called off. The two listeners that clear ui.exporting therefore never fire,
 * and nothing else clears it - not even opening another file - so the flag has
 * to be dropped here or the progress row stays frozen, Export stays hidden and
 * the quality select stays disabled until the app is restarted.
 */
function cancelRunningExport(): void {
  if (!ui.exporting) return;
  patchUi({ exporting: false, exportPercent: 0 });
  void cancelExport().catch(reportFailure);
}

function onExportFinished(outputPath: string): void {
  patchUi({ exporting: false, exportPercent: 0 });
  showToast(`Exported ${baseName(outputPath)}`, [
    { label: 'Reveal', run: () => void revealInExplorer(outputPath).catch(reportFailure) },
    { label: 'Copy file', run: () => void copyFileToClipboard(outputPath).catch(reportFailure) },
  ]);
}

function reportFailure(error: unknown): void {
  showToast(describe(error), [], true);
}

/** Beside the source, same stem, so it lands where the user is already looking. */
function defaultOutputPath(input: string): string {
  const cut = Math.max(input.lastIndexOf('\\'), input.lastIndexOf('/'));
  const directory = cut >= 0 ? input.slice(0, cut + 1) : '';
  const file = cut >= 0 ? input.slice(cut + 1) : input;
  const dot = file.lastIndexOf('.');
  const stem = dot > 0 ? file.slice(0, dot) : file;
  return `${directory}${stem}_clip.mp4`;
}

function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return cut >= 0 ? path.slice(cut + 1) : path;
}

/* --------------------------------------------------------------------------
 * Banners and toast
 * ----------------------------------------------------------------------- */

export function showBanner(key: string, options: BannerOptions): void {
  hideBanner(key);

  const banner = document.createElement('div');
  banner.className = 'banner';
  banner.dataset.key = key;

  const message = document.createElement('span');
  message.className = 'banner-msg';
  message.textContent = options.message;
  banner.appendChild(message);

  if (options.actionLabel && options.onAction) {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'btn';
    action.textContent = options.actionLabel;
    action.addEventListener('click', () => {
      action.disabled = true;
      void Promise.resolve(options.onAction?.()).finally(() => {
        action.disabled = false;
      });
    });
    banner.appendChild(action);
  }

  if (options.dismissible) {
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'icon-btn small';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = 'x';
    close.addEventListener('click', () => hideBanner(key));
    banner.appendChild(close);
  }

  banners.appendChild(banner);
}

export function hideBanner(key: string): void {
  const existing = banners.querySelector(`[data-key="${key}"]`);
  if (existing) existing.remove();
}

/** The FFmpeg banner, with the one-click install the plan calls for. */
export function showFfmpegBanner(onInstalled: () => void): void {
  showBanner('ffmpeg', {
    message: 'FFmpeg is required for exporting.',
    actionLabel: 'Install it',
    onAction: async () => {
      try {
        await installFfmpeg();
        hideBanner('ffmpeg');
        patchUi({ ffmpegAvailable: true });
        onInstalled();
      } catch (error) {
        showToast(describe(error), [], true);
      }
    },
  });
}

export function showToast(message: string, actions: ToastAction[] = [], persist = false): void {
  window.clearTimeout(toastTimer);

  toastMsg.textContent = message;
  toast.classList.toggle('error', persist);

  const buttons = actions.map((action) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn';
    button.textContent = action.label;
    button.addEventListener('click', action.run);
    return button;
  });
  toastActions.replaceChildren(...buttons);

  toast.hidden = false;
  if (!persist) toastTimer = window.setTimeout(dismissToast, TOAST_MS);
}

/** Returns whether there was anything to dismiss, which Escape needs to know. */
export function dismissToast(): boolean {
  if (toast.hidden) return false;
  window.clearTimeout(toastTimer);
  toast.hidden = true;
  return true;
}

export function describe(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

function clamp(value: number, low: number, high: number): number {
  if (high < low) return low;
  return Math.min(Math.max(value, low), high);
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
