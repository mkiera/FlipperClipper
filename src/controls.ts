import {
  cancelExport,
  copyFileToClipboard,
  estimateExportSize,
  ffmpegStatus,
  installFfmpeg,
  onExportDone,
  onExportError,
  onExportProgress,
  pickExportTarget,
  revealInExplorer,
  startExport,
} from './ipc';
import {
  edit,
  patchEdit,
  patchUi,
  rememberQuality,
  rememberTargetMb,
  settings,
  subscribe,
  ui,
} from './state';
import { currentTime, onTime, togglePlay } from './player';
import { toggleCrop } from './crop';
import {
  AUDIO_FORMATS,
  OUTPUT_HEIGHTS,
  VIDEO_FORMATS,
  VIDEO_KBPS_MAX,
  VIDEO_KBPS_MIN,
  defaultFormatFor,
  losslessEligible,
  outputDuration,
  shortEdge,
  type ExportFormat,
  type ExportJob,
  type QualityPreset,
} from './types';

const TOAST_MS = 9000;

// The slider's travel in log2(speed): -2 is 0.25x, 3 is 8x.
const SPEED_SLIDER_MIN = -2;
const SPEED_SLIDER_MAX = 3;

const SPEED_MIN = 0.05;
const SPEED_MAX = 20;

// ffmpeg buffers every decoded frame to reverse a clip, so long ones eat memory.
const REVERSE_WARN_SECONDS = 30;
let reverseWarned = false;

const ESTIMATE_DEBOUNCE_MS = 250;

const DEFAULT_MANUAL_KBPS = 4000;
let manualKbps = DEFAULT_MANUAL_KBPS;

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
let resSelect!: HTMLSelectElement;
let bitrateMode!: HTMLSelectElement;
let bitrateInput!: HTMLInputElement;
let estimateLabel!: HTMLElement;
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

let estimateTimer = 0;
// Bumped per request, so a slow answer cannot overwrite a newer one.
let estimateToken = 0;
let estimateKey = '';

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
  resSelect = el<HTMLSelectElement>('res-select');
  bitrateMode = el<HTMLSelectElement>('bitrate-mode');
  bitrateInput = el<HTMLInputElement>('bitrate-kbps');
  estimateLabel = el('size-estimate');
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

  speedInput.title = 'Speed, 0.05 to 20. The preview tops out at 16x; export uses the exact value.';

  openBtn.addEventListener('click', () => deps.openFile());
  playBtn.addEventListener('click', togglePlay);
  cropBtn.addEventListener('click', toggleCrop);
  muteBtn.addEventListener('click', () => patchEdit({ mute: !edit.mute }));
  reverseBtn.addEventListener('click', toggleReverse);
  audioOnlyBtn.addEventListener('click', toggleAudioOnly);

  speedSlider.addEventListener('input', () => {
    // Two decimals, or a notch reads 1.5 and exports 1.50006.
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
    // The bounds export.rs validates, enforced here so a typo is fixed at the input.
    const clamped = Number.isFinite(raw) ? clamp(raw, 0.5, 10_000) : settings.defaultTargetMb;
    fitMbInput.value = String(clamped);
    rememberTargetMb(clamped);
    patchEdit({ targetMb: clamped });
  });

  resSelect.addEventListener('change', () => {
    const raw = resSelect.value;
    patchEdit({ outputHeight: raw === 'auto' ? null : Number(raw) });
  });

  bitrateMode.addEventListener('change', () => {
    patchEdit({ videoKbps: bitrateMode.value === 'manual' ? manualKbps : null });
  });

  bitrateInput.addEventListener('change', () => {
    const raw = Number(bitrateInput.value);
    const clamped = Number.isFinite(raw)
      ? Math.round(clamp(raw, VIDEO_KBPS_MIN, VIDEO_KBPS_MAX))
      : manualKbps;
    bitrateInput.value = String(clamped);
    manualKbps = clamped;
    patchEdit({ videoKbps: clamped });
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

/* --- Rendering --- */

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

// gif, wav and flac have no rate control, so export.rs refuses a size target.
function fitAllowed(format: ExportFormat): boolean {
  return format !== 'gif' && format !== 'wav' && format !== 'flac';
}

function render(): void {
  const hasMedia = edit.media !== null;
  const hasAudio = edit.media?.hasAudio ?? false;

  // Corrected here, not in the handlers: loadMedia can arrive holding a remembered 'fit'.
  if (edit.quality === 'fit' && !fitAllowed(edit.format)) {
    patchEdit({ quality: settings.defaultQuality === 'fit' ? 'balanced' : settings.defaultQuality });
    return;
  }

  if (edit.quality === 'fit' && edit.videoKbps !== null) {
    patchEdit({ videoKbps: null });
    return;
  }

  const edge = shortEdge(edit);
  if (edit.outputHeight !== null && edge !== null && edit.outputHeight > edge) {
    patchEdit({ outputHeight: null });
    return;
  }

  playBtn.disabled = !hasMedia;
  playBtn.classList.toggle('is-playing', ui.playing);
  playBtn.setAttribute('aria-label', ui.playing ? 'Pause' : 'Play');

  speedSlider.disabled = !hasMedia;
  speedInput.disabled = !hasMedia;
  speedSlider.value = String(clamp(Math.log2(edit.speed), SPEED_SLIDER_MIN, SPEED_SLIDER_MAX));
  if (document.activeElement !== speedInput) speedInput.value = String(edit.speed);

  reverseBtn.disabled = !hasMedia;
  reverseBtn.classList.toggle('active', edit.reverse);

  cropBtn.disabled = !hasMedia;
  cropBtn.classList.toggle('active', ui.cropping || edit.crop !== null);

  muteBtn.hidden = hasMedia && !hasAudio;
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

  resSelect.hidden = edit.audioOnly;
  resSelect.disabled = !hasMedia || ui.exporting;
  for (const height of OUTPUT_HEIGHTS) {
    const option = resSelect.querySelector<HTMLOptionElement>(`option[value="${height}"]`);
    if (option) option.disabled = edge !== null && height > edge;
  }
  resSelect.value = edit.outputHeight === null ? 'auto' : String(edit.outputHeight);

  const fitOwnsRate = edit.quality === 'fit';
  bitrateMode.hidden = edit.audioOnly;
  bitrateMode.disabled = !hasMedia || ui.exporting || fitOwnsRate;
  bitrateMode.value = edit.videoKbps === null ? 'auto' : 'manual';
  bitrateMode.title = fitOwnsRate
    ? 'Fit under… works out the bitrate itself.'
    : 'Video bitrate. Auto lets the quality setting decide.';

  bitrateInput.hidden = edit.audioOnly || edit.videoKbps === null;
  bitrateInput.disabled = ui.exporting;
  if (document.activeElement !== bitrateInput && edit.videoKbps !== null) {
    bitrateInput.value = String(edit.videoKbps);
  }

  scheduleEstimate();

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

function formatTime(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  const whole = Math.floor(rest);
  const tenths = Math.floor((rest - whole) * 10);
  return `${minutes}:${String(whole).padStart(2, '0')}.${tenths}`;
}

/* --- Size estimate --- */

// Only what the estimate depends on: export progress re-renders several times a second.
function estimateSignature(): string {
  const crop = edit.crop;
  return [
    edit.media?.path ?? '',
    edit.inPoint,
    edit.outPoint,
    edit.speed,
    crop ? `${crop.x},${crop.y},${crop.w},${crop.h}` : '',
    edit.mute,
    edit.reverse,
    edit.volume,
    edit.format,
    edit.audioOnly,
    edit.quality,
    edit.targetMb,
    edit.outputHeight,
    edit.videoKbps,
    edit.lossless,
  ].join('|');
}

function scheduleEstimate(): void {
  const signature = estimateSignature();
  if (signature === estimateKey) return;
  estimateKey = signature;

  window.clearTimeout(estimateTimer);
  if (!edit.media) {
    estimateToken += 1;
    estimateLabel.hidden = true;
    return;
  }
  estimateTimer = window.setTimeout(() => void refreshEstimate(), ESTIMATE_DEBOUNCE_MS);
}

async function refreshEstimate(): Promise<void> {
  const media = edit.media;
  if (!media) return;

  const token = (estimateToken += 1);
  let bytes: number | null;
  try {
    bytes = await estimateExportSize(buildJob(media.path, defaultOutputPath(media.path)), media);
  } catch {
    bytes = null;
  }
  if (token !== estimateToken) return;

  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) {
    estimateLabel.hidden = true;
    return;
  }
  estimateLabel.textContent = approximateSize(bytes);
  estimateLabel.hidden = false;
}

function approximateSize(bytes: number): string {
  const mb = Math.max(bytes / 1_000_000, 0.05);
  return mb < 10 ? `about ${mb.toFixed(1)} MB` : `about ${Math.round(mb)} MB`;
}

/* --- Export --- */

export function beginExport(): void {
  if (!edit.media || ui.exporting || !ui.ffmpegAvailable) return;

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

export function closeExportPopover(): boolean {
  if (popover.hidden) return false;
  closePopover();
  return true;
}

function buildJob(input: string, output: string): ExportJob {
  return {
    input,
    output,
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
    outputHeight: edit.audioOnly ? null : edit.outputHeight,
    videoKbps: edit.audioOnly || edit.quality === 'fit' ? null : edit.videoKbps,
    lossless: edit.lossless && losslessEligible(edit),
  };
}

async function runExport(): Promise<void> {
  const media = edit.media;
  if (!media || ui.exporting) return;

  if (!(await ffmpegReady())) return;

  const target = await pickExportTarget(defaultOutputPath(media.path));
  if (!target) return;

  patchUi({ exporting: true, exportPercent: 0 });
  try {
    await startExport(buildJob(media.path, target));
  } catch (error) {
    patchUi({ exporting: false, exportPercent: 0 });
    showToast(describe(error), [], true);
  }
}

// Asked again per export: the startup verdict has been seen to go stale both ways.
async function ffmpegReady(): Promise<boolean> {
  let available = false;
  try {
    available = (await ffmpegStatus()).available;
  } catch {
    available = false;
  }

  patchUi({ ffmpegAvailable: available });
  if (available) {
    hideBanner('ffmpeg');
    return true;
  }

  showFfmpegBanner();
  return false;
}

// A cancel emits neither export-done nor export-error, so nothing else clears ui.exporting.
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
    { label: 'Open another…', run: () => deps.openFile() },
  ]);
}

function reportFailure(error: unknown): void {
  showToast(describe(error), [], true);
}

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

/* --- Banners and toast --- */

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

function bannerShowing(key: string): boolean {
  return banners.querySelector(`[data-key="${key}"]`) !== null;
}

export function showFfmpegBanner(onInstalled: () => void = () => {}): void {
  // Re-raising rebuilds the button, losing the disabled flag that blocks a second install.
  if (bannerShowing('ffmpeg')) return;

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
