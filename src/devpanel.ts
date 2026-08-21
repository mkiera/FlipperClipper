/**
 * The debug panel: Ctrl+Shift+D.
 *
 * It ships in release builds on purpose. Its job is to turn "it did not work" into something
 * answerable without the machine in front of you, and the machine it needs to answer for is
 * always someone else's. Nothing here is reachable by accident: no button opens it and no menu
 * lists it.
 *
 * Everything is read when the panel opens rather than held from startup. A report that says
 * FFmpeg is missing when it was installed ten minutes ago is worse than no report.
 */

import { appVersion, debugReport, runDiagnostic } from './ipc';
import { buildInfo } from './settings';
import { subscribe } from './state';
import { appliedMinWidth } from './windowsize';
import type { DebugReport, ToolReport } from './types';

/** The most recent thing that went wrong, for the panel to report. Held here rather than in
 *  app state: nothing renders from it, and it has to survive the toast that showed it. */
let lastError: string | null = null;

let panel!: HTMLElement;
let systemOut!: HTMLElement;
let toolsOut!: HTMLElement;
let testOut!: HTMLElement;
let errorOut!: HTMLElement;
let sizeOut!: HTMLElement;
let testBtn!: HTMLButtonElement;
let copyBtn!: HTMLButtonElement;
let overlayToggle!: HTMLInputElement;

let overlay: HTMLElement | null = null;

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`FlipperClipper: index.html is missing #${id}`);
  return found as T;
}

export function initDevPanel(): void {
  panel = el('debug-panel');
  systemOut = el('debug-system');
  toolsOut = el('debug-tools');
  testOut = el('debug-test-result');
  errorOut = el('debug-last-error');
  sizeOut = el('debug-size');
  testBtn = el<HTMLButtonElement>('debug-run-test');
  copyBtn = el<HTMLButtonElement>('debug-copy');
  overlayToggle = el<HTMLInputElement>('debug-overlay-toggle');

  el('debug-close').addEventListener('click', closeDevPanel);
  el('debug-close-btn').addEventListener('click', closeDevPanel);
  testBtn.addEventListener('click', () => void runTest());
  copyBtn.addEventListener('click', () => void copyReport());
  overlayToggle.addEventListener('change', () => setOverlay(overlayToggle.checked));

  // A click on the backdrop, not the panel, closes it - the same as the other modals.
  panel.addEventListener('click', (e) => {
    if (e.target === panel) closeDevPanel();
  });

  document.addEventListener('keydown', (e) => {
    // e.key is 'D' rather than 'd' because shift is held.
    if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
      e.preventDefault();
      toggleDevPanel();
    }
  });

  window.addEventListener('resize', drawSize);
  // The row's width depends on what is showing, and that changes with the edit.
  subscribe(drawSize);
}

export function toggleDevPanel(): void {
  if (panel.hidden) openDevPanel();
  else closeDevPanel();
}

export function openDevPanel(): void {
  panel.hidden = false;
  drawSize();
  void loadReport();
}

export function closeDevPanel(): boolean {
  if (panel.hidden) return false;
  panel.hidden = true;
  return true;
}

/** Called from wherever an error is shown to the user, so the panel can report the last one. */
export function recordError(message: string): void {
  lastError = `[${new Date().toLocaleTimeString()}] ${message}`;
}

/* --- The report --- */

async function loadReport(): Promise<void> {
  systemOut.textContent = 'Reading...';
  toolsOut.textContent = 'Reading...';
  errorOut.textContent = lastError ?? 'Nothing recorded this session';

  let report: DebugReport | null = null;
  try {
    report = await debugReport();
  } catch (e) {
    // Both boxes, not just the one that failed: an empty .debug-out is hidden by CSS, which
    // would leave the heading standing over nothing.
    systemOut.textContent = `Could not read the report: ${describe(e)}`;
    toolsOut.textContent = 'Unavailable while the report cannot be read.';
    return;
  }

  systemOut.textContent = describeSystem(report, await version(report));
  toolsOut.textContent = describeTools(report);
}

/** The packaged version, falling back to what the report carried if the call fails. */
async function version(report: DebugReport): Promise<string> {
  try {
    return await appVersion();
  } catch {
    return report.appVersion;
  }
}

function describeSystem(report: DebugReport, appVer: string): string {
  const info = buildInfo();
  // The user agent carries the Windows build and the WebView2 version, both of which the
  // browser knows more precisely than Rust does.
  const agent = navigator.userAgent;
  const windows = /Windows NT ([\d.]+)/.exec(agent)?.[1];
  const webview = /Edg\/([\d.]+)/.exec(agent)?.[1] ?? /Chrome\/([\d.]+)/.exec(agent)?.[1];

  return [
    `App:       ${appVer}`,
    `Commit:    ${info.sha ? info.sha.slice(0, 7) : 'unknown'}`,
    `Built:     ${info.builtAt ? info.builtAt.slice(0, 19).replace('T', ' ') : 'unknown'}`,
    `OS:        ${report.osFamily}${windows ? ` NT ${windows}` : ''} (${report.arch})`,
    `WebView2:  ${webview ?? 'unknown'}`,
    `Tauri:     ${report.tauriVersion}`,
    `Config:    ${report.configDir ?? 'unknown'}`,
    `Temp:      ${report.tempDir}`,
  ].join('\n');
}

function describeTools(report: DebugReport): string {
  return [
    `Encoder:   ${report.encoder}`,
    '',
    tool('ffmpeg', report.ffmpeg),
    '',
    tool('ffprobe', report.ffprobe),
  ].join('\n');
}

function tool(name: string, found: ToolReport): string {
  if (!found.found) return `${name}:    NOT FOUND on PATH or in any known install folder`;
  return [`${name}:`, `  ${found.version ?? 'version unknown'}`, `  ${found.path ?? ''}`.trimEnd()]
    .join('\n');
}

/* --- The diagnostic --- */

async function runTest(): Promise<void> {
  testBtn.disabled = true;
  testOut.textContent = 'Making a test clip and exporting it...';
  try {
    const result = await runDiagnostic();
    const took = `${(result.millis / 1000).toFixed(1)}s`;
    testOut.textContent = result.success
      ? `PASS in ${took}\n${result.message}`
      : `FAIL in ${took}\n${result.message}\n\n${result.detail}`;
  } catch (e) {
    testOut.textContent = `FAIL\nThe diagnostic could not be started: ${describe(e)}`;
  } finally {
    testBtn.disabled = false;
  }
}

/* --- The window size readout --- */

/**
 * What the control row needs against what the window gives it. Lives here rather than in its
 * own dev-only module so it ships with the panel: the sizes that matter are the ones on other
 * people's screens, which is exactly where a development-only overlay is not.
 */
function sizeReport(): string {
  const controls = document.getElementById('controls');
  if (!controls) return 'No control row';

  const groups = [...controls.querySelectorAll<HTMLElement>('.control-group')];
  const style = getComputedStyle(controls);
  const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const gap = parseFloat(style.columnGap) || 0;

  const needs = groups.map((group) => {
    const shown = [...group.children].filter(
      (child) => !(child as HTMLElement).hidden && getComputedStyle(child).display !== 'none',
    );
    const sum = shown.reduce((total, child) => total + child.getBoundingClientRect().width, 0);
    return Math.ceil(sum + gap * Math.max(shown.length - 1, 0) + padding);
  });

  // Two lines is a designed state, not a fault, so this counts them rather than judging them.
  const lines = new Set(groups.map((group) => group.offsetTop)).size;

  return [
    `Window:    ${window.innerWidth} x ${window.innerHeight} @ ${window.devicePixelRatio}x`,
    `Screen:    ${window.screen.availWidth} x ${window.screen.availHeight} available`,
    `Min asked: ${appliedMinWidth() || 'pending'}`,
    `Rows:      ${Math.max(lines, 1)}`,
    `Groups:    ${needs.length > 0 ? needs.join(' / ') : 'none'}`,
  ].join('\n');
}

function drawSize(): void {
  if (!panel.hidden) sizeOut.textContent = sizeReport();
  if (overlay) overlay.textContent = sizeReport();
}

function setOverlay(on: boolean): void {
  if (!on) {
    overlay?.remove();
    overlay = null;
    return;
  }
  if (overlay) return;

  overlay = document.createElement('div');
  overlay.id = 'debug-overlay';
  Object.assign(overlay.style, {
    position: 'fixed',
    top: '8px',
    left: '8px',
    zIndex: '80',
    padding: '6px 10px',
    borderRadius: '8px',
    border: '1px solid rgba(107, 197, 210, 0.8)',
    background: 'rgba(0, 0, 0, 0.78)',
    color: '#fff',
    font: '12px/1.45 Consolas, "Cascadia Mono", monospace',
    whiteSpace: 'pre',
    pointerEvents: 'none',
  });
  document.body.appendChild(overlay);
  drawSize();
}

/* --- Copying --- */

async function copyReport(): Promise<void> {
  const text = [
    '=== FlipperClipper debug report ===',
    '',
    '--- System ---',
    systemOut.textContent ?? '',
    '',
    '--- Tools ---',
    toolsOut.textContent ?? '',
    '',
    '--- Window ---',
    sizeOut.textContent ?? '',
    '',
    '--- Diagnostic ---',
    testOut.textContent || 'Not run',
    '',
    '--- Last error ---',
    errorOut.textContent ?? '',
  ].join('\n');

  const was = copyBtn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    copyBtn.textContent = 'Copied';
  } catch {
    copyBtn.textContent = 'Could not copy';
  }
  window.setTimeout(() => {
    copyBtn.textContent = was;
  }, 1400);
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
