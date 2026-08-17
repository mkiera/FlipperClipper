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
import { edit, patchEdit, patchUi, rememberQuality, rememberTargetMb, subscribe, ui } from './state';
import { currentTime, onTime, togglePlay } from './player';
import { toggleCrop } from './crop';
import {
  AUDIO_FORMATS,
  VIDEO_FORMATS,
  defaultFormatFor,
  losslessEligible,
  outputDuration,
  type ExportFormat,
  type ExportJob,
  type QualityPreset,
} from './types';

/** How long a success toast stays up. Errors ignore this and wait to be closed. */
const TOAST_MS = 9000;

/** The slider's travel in log2(speed): 0.25x to 8x, with 1x at log2 = 0. */
const SPEED_SLIDER_MIN = -2;
const SPEED_SLIDER_MAX = 3;

/** The range the number input and the Rust validator agree on. */
const SPEED_MIN = 0.05;
const SPEED_MAX = 20;

/**
 * Reversing makes ffmpeg hold every decoded frame of the clip in memory before
 * it can write the first output frame; past about half a minute of output that
 * is gigabytes, and the only symptom is an export that crawls or dies. Warned
 * once per session rather than every toggle, because the second warning teaches
 * nothing the first did not.
 */
const REVERSE_WARN_SECONDS = 30;
let reverseWarned = false;

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

export interface ControlsDeps {
  /** Same flow as Ctrl+O. Owned by main.ts because opening is an app-level flow. */
  openFile: () => void;
}

let deps!: ControlsDeps;

let openBtn!: HTMLButtonElement;
let playBtn!: HTMLButtonElement;
let timeLabel!: HTMLElement;
let speedSlider!: HTMLInputElement;
let speedInput!: HTMLInputElement;
let reverseBtn!: HTMLButtonElement;
let cropBtn!: HTMLButtonElement;
let muteBtn!: HTMLButtonElement;
let volumeGroup!: HTMLElement;
let volumeSlider!: HTMLInputElement;
let volumeReadout!: HTMLElement;
let audioOnlyBtn!: HTMLButtonElement;
let formatSelect!: HTMLSelectElement;
let qualitySelect!: HTMLSelectElement;
let fitMbInput!: HTMLInputElement;
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

/** Which list the format dropdown currently holds, so it is only rebuilt on a switch. */
let formatListIsAudio: boolean | null = null;

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`FlipperClipper: index.html is missing #${id}`);
  return found as T;
}

export function initControls(controlsDeps: ControlsDeps): void {
  deps = controlsDeps;

  openBtn = el<HTMLButtonElement>('open-btn');
  playBtn = el<HTMLButtonElement>('play-btn');
  timeLabel = el('time');
  speedSlider = el<HTMLInputElement>('speed-slider');
  speedInput = el<HTMLInputElement>('speed-input');
  reverseBtn = el<HTMLButtonElement>('reverse-btn');
  cropBtn = el<HTMLButtonElement>('crop-btn');
  muteBtn = el<HTMLButtonElement>('mute-btn');
  volumeGroup = el('volume-group');
  volumeSlider = el<HTMLInputElement>('volume-slider');
  volumeReadout = el('volume-readout');
  audioOnlyBtn = el<HTMLButtonElement>('audio-only-btn');
  formatSelect = el<HTMLSelectElement>('format-select');
  qualitySelect = el<HTMLSelectElement>('quality-select');
  fitMbInput = el<HTMLInputElement>('fit-mb');
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

  // The webview previews speed through playbackRate, which Chromium refuses to
  // set above 16 - the export pipeline has no such cap, so the input has to say
  // which half of the app the extreme values reach.
  speedInput.title = 'Speed, 0.05 to 20. The preview tops out at 16x; export uses the exact value.';

  openBtn.addEventListener('click', () => deps.openFile());
  playBtn.addEventListener('click', togglePlay);
  cropBtn.addEventListener('click', toggleCrop);
  muteBtn.addEventListener('click', () => patchEdit({ mute: !edit.mute }));
  reverseBtn.addEventListener('click', toggleReverse);
  audioOnlyBtn.addEventListener('click', toggleAudioOnly);

  speedSlider.addEventListener('input', () => {
    // Two decimals is what the notches need to land exactly: 2^0.585 comes out
    // as 1.50006, and a chip that reads 1.5 but exports 1.50006 would make
    // lossless-adjacent comparisons of durations look wrong by a frame.
    const speed = Math.round(2 ** Number(speedSlider.value) * 100) / 100;
    patchEdit({ speed });
  });

  speedInput.addEventListener('change', () => {
    const raw = Number(speedInput.value);
    if (!Number.isFinite(raw) || raw === 0) {
      speedInput.value = String(edit.speed);
      return;
    }
    const speed = clamp(raw, SPEED_MIN, SPEED_MAX);
    // The render-time sync skips the input while it still has focus, so a
    // clamped entry would keep showing the out-of-range number the user typed.
    if (speed !== raw) speedInput.value = String(speed);
    patchEdit({ speed });
  });

  volumeSlider.addEventListener('input', () => {
    patchEdit({ volume: Number(volumeSlider.value) / 100 });
  });

  formatSelect.addEventListener('change', () => {
    patchEdit({ format: formatSelect.value as ExportFormat });
  });

  qualitySelect.addEventListener('change', () => {
    const quality = qualitySelect.value as QualityPreset;
    rememberQuality(quality);
    patchEdit({ quality });
  });

  fitMbInput.addEventListener('change', () => {
    const raw = Number(fitMbInput.value);
    // Same bounds the Rust side validates, enforced here so a typo is corrected
    // at the input instead of surfacing as a refusal at export time.
    const clamped = Number.isFinite(raw) ? clamp(raw, 0.5, 10_000) : 10;
    fitMbInput.value = String(clamped);
    rememberTargetMb(clamped);
    patchEdit({ targetMb: clamped });
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

/**
 * Exported because R in shortcuts.ts must come through here too: the memory
 * warning lives with the toggle, not with any one way of reaching it.
 */
export function toggleReverse(): void {
  if (!edit.media) return;
  const reverse = !edit.reverse;
  patchEdit({ reverse });
  if (reverse && !reverseWarned && outputDuration(edit) > REVERSE_WARN_SECONDS) {
    reverseWarned = true;
    showToast("Reversing buffers the whole clip in ffmpeg's memory - long clips can need gigabytes.");
  }
}

function toggleAudioOnly(): void {
  if (edit.audioOnly) {
    // Coming back to video with an audio format still selected would leave the
    // dropdown pointing at an entry that no longer exists in it, so the format
    // falls back to the opened file's own container.
    const format = (AUDIO_FORMATS as string[]).includes(edit.format)
      ? defaultFormatFor(edit.media?.path ?? '')
      : edit.format;
    patchEdit({ audioOnly: false, format });
  } else {
    const format: ExportFormat = (AUDIO_FORMATS as string[]).includes(edit.format)
      ? edit.format
      : 'm4a';
    patchEdit({ audioOnly: true, format });
  }
}

/* --------------------------------------------------------------------------
 * Rendering
 * ----------------------------------------------------------------------- */

function rebuildFormatOptions(): void {
  if (formatListIsAudio === edit.audioOnly) return;
  formatListIsAudio = edit.audioOnly;

  const formats: ExportFormat[] = edit.audioOnly ? AUDIO_FORMATS : VIDEO_FORMATS;
  const options = formats.map((format) => {
    const option = document.createElement('option');
    option.value = format;
    option.textContent = format.toUpperCase();
    return option;
  });
  formatSelect.replaceChildren(...options);
}

/** Formats whose fit is refused by export.rs: gif has no rate control worth the name, wav/flac have no rate control at all. */
function fitAllowed(format: ExportFormat): boolean {
  return format !== 'gif' && format !== 'wav' && format !== 'flac';
}

function render(): void {
  const hasMedia = edit.media !== null;
  const hasAudio = edit.media?.hasAudio ?? false;

  // The one combination the dropdowns can reach that export.rs would refuse:
  // 'fit' with a format that cannot hit a byte target. Corrected here rather
  // than in each format-changing handler because opening a .gif with a
  // remembered 'fit' arrives through loadMedia and touches no handler at all.
  // patchEdit inside a render re-enters notify once and then the condition is
  // false, so this cannot loop.
  if (edit.quality === 'fit' && !fitAllowed(edit.format)) {
    patchEdit({ quality: 'balanced' });
    return;
  }

  playBtn.disabled = !hasMedia;
  playBtn.classList.toggle('is-playing', ui.playing);
  playBtn.setAttribute('aria-label', ui.playing ? 'Pause' : 'Play');

  speedSlider.disabled = !hasMedia;
  speedInput.disabled = !hasMedia;
  // The slider covers 0.25..8; a typed 0.05 or 20 pins it to its end while the
  // real value stands in the number input beside it.
  speedSlider.value = String(clamp(Math.log2(edit.speed), SPEED_SLIDER_MIN, SPEED_SLIDER_MAX));
  // Left alone while being typed in, or every keystroke would be rewritten
  // under the cursor by the render its own change causes.
  if (document.activeElement !== speedInput) speedInput.value = String(edit.speed);

  reverseBtn.disabled = !hasMedia;
  reverseBtn.classList.toggle('active', edit.reverse);

  cropBtn.disabled = !hasMedia;
  cropBtn.classList.toggle('active', ui.cropping || edit.crop !== null);

  muteBtn.hidden = hasMedia && !hasAudio;
  // Mute and audio-only exclude each other: an export that is only the audio
  // track with the audio track muted is a file of silence nobody asked for.
  muteBtn.disabled = !hasMedia || edit.audioOnly;
  muteBtn.classList.toggle('is-muted', edit.mute);
  muteBtn.classList.toggle('active', edit.mute);

  volumeGroup.hidden = hasMedia && !hasAudio;
  volumeSlider.disabled = !hasMedia || edit.mute;
  volumeSlider.value = String(Math.round(edit.volume * 100));
  volumeReadout.textContent = `${Math.round(edit.volume * 100)}%`;

  audioOnlyBtn.disabled = !hasMedia || !hasAudio || edit.mute;
  audioOnlyBtn.classList.toggle('active', edit.audioOnly);

  rebuildFormatOptions();
  formatSelect.value = edit.format;
  formatSelect.disabled = !hasMedia || ui.exporting;

  const fitOption = qualitySelect.querySelector<HTMLOptionElement>('option[value="fit"]');
  if (fitOption) fitOption.disabled = !fitAllowed(edit.format);
  qualitySelect.value = edit.quality;
  qualitySelect.disabled = ui.exporting;

  fitMbInput.hidden = edit.quality !== 'fit';
  fitMbInput.disabled = ui.exporting;
  if (document.activeElement !== fitMbInput) fitMbInput.value = String(edit.targetMb);

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
  if (losslessEligible(edit)) {
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
    reverse: edit.reverse,
    volume: edit.volume,
    format: edit.format,
    quality: edit.quality,
    targetMb: edit.quality === 'fit' ? edit.targetMb : null,
    // Belt and braces: the checkbox is only reachable while the edit is
    // eligible, but the edit can change between opening the popover and
    // getting through the save dialog.
    lossless: edit.lossless && losslessEligible(edit),
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
    // The natural next act is the next clip, and before this existed the only
    // routes there were a keyboard shortcut or dropping a file - neither of
    // which anything on screen advertised once a video was open.
    { label: 'Open another…', run: () => deps.openFile() },
  ]);
}

function reportFailure(error: unknown): void {
  showToast(describe(error), [], true);
}

/**
 * Beside the source, same stem, so it lands where the user is already looking.
 * The extension follows the chosen format - it is also what pickExportTarget
 * derives the save dialog's filter from.
 */
function defaultOutputPath(input: string): string {
  const cut = Math.max(input.lastIndexOf('\\'), input.lastIndexOf('/'));
  const directory = cut >= 0 ? input.slice(0, cut + 1) : '';
  const file = cut >= 0 ? input.slice(cut + 1) : input;
  const dot = file.lastIndexOf('.');
  const stem = dot > 0 ? file.slice(0, dot) : file;
  return `${directory}${stem}_clip.${edit.format}`;
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
