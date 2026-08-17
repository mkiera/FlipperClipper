/// <reference types="vite/client" />

/**
 * The settings modal: update channel and release list on one tab, the editing
 * defaults on the other. Settings live on the Rust side as JSON; every control
 * saves the moment it changes, so the panel has no OK button.
 */

import {
  appVersion,
  checkForUpdate,
  getSettings,
  installAlphaBuild,
  installRelease,
  listAlphaBuilds,
  listReleases,
  saveSettings,
} from './ipc';
import { setSettings, settings } from './state';
import {
  AUDIO_FORMATS,
  DEFAULT_SETTINGS,
  VIDEO_FORMATS,
  type AlphaBuild,
  type AppSettings,
  type DefaultFormat,
  type EncoderPreference,
  type QualityPreset,
  type ReleaseInfo,
  type UpdateChannel,
} from './types';

/**
 * What scripts/build_info.mjs stamps into src/generated/build-info.json. Every
 * field is optional there - a working copy without git on PATH gets nulls - so
 * nothing here may be treated as present.
 */
export interface BuildInfo {
  sha: string | null;
  branch: string | null;
  runId: number | null;
  builtAt: string | null;
}

/**
 * That file is generated on every build path but never committed, so a fresh
 * clone that runs `npm run dev` before the stamp script has none. A glob is the
 * one import form that resolves to an empty set instead of failing the bundle
 * when the file is not there.
 */
const BUILD_INFO = import.meta.glob<{ default: Partial<BuildInfo> }>(
  './generated/build-info.json',
  { eager: true },
);

/** The stamped build, or an empty object when nothing was stamped. */
export function buildInfo(): Partial<BuildInfo> {
  return Object.values(BUILD_INFO)[0]?.default ?? {};
}

interface Cached {
  releases: ReleaseInfo[];
  at: number;
}

interface CachedAlpha {
  builds: AlphaBuild[];
  at: number;
}

let runningVersion = '';
/** Cleared once appVersion() settles either way; Install stays disabled until then. */
let versionPending = true;
let selectedVersion: string | null = null;
let installing = false;
let loadingReleases = false;
let listError: string | null = null;
let downgradeArmed = false;

/** Which list is on screen. Alpha is a view, not a saved channel - see selectChannel(). */
let activeChannel: UpdateChannel = DEFAULT_SETTINGS.updateChannel;
let selectedRunId: number | null = null;
let loadingAlpha = false;
let alphaError: string | null = null;
let alphaArmed = false;

const cache = new Map<UpdateChannel, Cached>();
/** Anonymous GitHub allows 60 requests an hour, so this only refills on refresh. */
let alphaCache: CachedAlpha | null = null;

let modal!: HTMLElement;
let openBtn!: HTMLButtonElement;
let closeBtn!: HTMLButtonElement;
let tabUpdates!: HTMLButtonElement;
let tabEditing!: HTMLButtonElement;
let sectionUpdates!: HTMLElement;
let sectionEditing!: HTMLElement;
let autoCheck!: HTMLInputElement;
let channelStable!: HTMLButtonElement;
let channelPrerelease!: HTMLButtonElement;
let channelAlpha!: HTMLButtonElement;
let paneReleases!: HTMLElement;
let paneAlpha!: HTMLElement;
let refreshBtn!: HTMLButtonElement;
let checkedAtLine!: HTMLElement;
let buildLine!: HTMLElement;
let releasesList!: HTMLElement;
let alphaList!: HTMLElement;
let checkBtn!: HTMLButtonElement;
let installBtn!: HTMLButtonElement;
let installAlphaBtn!: HTMLButtonElement;
let note!: HTMLElement;
let formatSelect!: HTMLSelectElement;
let qualitySelect!: HTMLSelectElement;
let targetMbInput!: HTMLInputElement;
let filmstripBox!: HTMLInputElement;
let encoderSelect!: HTMLSelectElement;
let proxyBox!: HTMLInputElement;
let restoreBtn!: HTMLButtonElement;

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`FlipperClipper: index.html is missing #${id}`);
  return found as T;
}

/** Resolves once the saved settings are in state, which openLaunchFile() waits on. */
export function initSettings(): Promise<void> {
  modal = el('settings-modal');
  openBtn = el<HTMLButtonElement>('settings-btn');
  closeBtn = el<HTMLButtonElement>('settings-close');
  tabUpdates = el<HTMLButtonElement>('settings-tab-updates');
  tabEditing = el<HTMLButtonElement>('settings-tab-editing');
  sectionUpdates = el('settings-section-updates');
  sectionEditing = el('settings-section-editing');
  autoCheck = el<HTMLInputElement>('auto-check-toggle');
  channelStable = el<HTMLButtonElement>('channel-stable');
  channelPrerelease = el<HTMLButtonElement>('channel-prerelease');
  channelAlpha = el<HTMLButtonElement>('channel-alpha');
  paneReleases = el('channel-pane-releases');
  paneAlpha = el('channel-pane-alpha');
  refreshBtn = el<HTMLButtonElement>('refresh-releases');
  checkedAtLine = el('releases-checked-at');
  buildLine = el('current-build-line');
  releasesList = el('releases-list');
  alphaList = el('alpha-list');
  checkBtn = el<HTMLButtonElement>('check-updates-btn');
  installBtn = el<HTMLButtonElement>('install-release-btn');
  installAlphaBtn = el<HTMLButtonElement>('install-alpha-btn');
  note = el('settings-note');
  formatSelect = el<HTMLSelectElement>('set-format');
  qualitySelect = el<HTMLSelectElement>('set-quality');
  targetMbInput = el<HTMLInputElement>('set-target-mb');
  filmstripBox = el<HTMLInputElement>('set-filmstrip');
  encoderSelect = el<HTMLSelectElement>('set-encoder');
  proxyBox = el<HTMLInputElement>('set-proxy');
  restoreBtn = el<HTMLButtonElement>('restore-defaults');

  buildFormatOptions();

  openBtn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);
  modal.addEventListener('pointerdown', (e) => {
    if (e.target === modal) close();
  });

  tabUpdates.addEventListener('click', () => showSection('updates'));
  tabEditing.addEventListener('click', () => showSection('editing'));

  channelStable.addEventListener('click', () => selectChannel('stable'));
  channelPrerelease.addEventListener('click', () => selectChannel('prerelease'));
  channelAlpha.addEventListener('click', () => selectChannel('alpha'));
  refreshBtn.addEventListener('click', () => void loadActiveChannel(true));
  checkBtn.addEventListener('click', () => void checkNow());
  installBtn.addEventListener('click', () => void install());
  installAlphaBtn.addEventListener('click', () => void installAlpha());

  autoCheck.addEventListener('change', () => {
    settings.autoCheckUpdates = autoCheck.checked;
    void persist();
  });

  formatSelect.addEventListener('change', () => {
    settings.defaultFormat = formatSelect.value as DefaultFormat;
    void persist();
  });

  qualitySelect.addEventListener('change', () => {
    settings.defaultQuality = qualitySelect.value as QualityPreset;
    void persist();
  });

  targetMbInput.addEventListener('change', () => {
    const raw = Number(targetMbInput.value);
    const clamped = Number.isFinite(raw) ? clamp(raw, 0.5, 10_000) : DEFAULT_SETTINGS.defaultTargetMb;
    targetMbInput.value = String(clamped);
    settings.defaultTargetMb = clamped;
    void persist();
  });

  filmstripBox.addEventListener('change', () => {
    settings.showFilmstrip = filmstripBox.checked;
    void persist();
  });

  encoderSelect.addEventListener('change', () => {
    settings.encoder = encoderSelect.value as EncoderPreference;
    void persist();
  });

  proxyBox.addEventListener('change', () => {
    settings.autoPreviewProxy = proxyBox.checked;
    void persist();
  });

  restoreBtn.addEventListener('click', () => {
    setSettings({ ...DEFAULT_SETTINGS });
    // The channel can have changed with it, so the list and the selection go
    // the same way they do in selectChannel().
    selectedVersion = null;
    downgradeArmed = false;
    clearAlphaSelection();
    applySettings();
    note.textContent = 'Defaults restored.';
    void persist();
    void loadActiveChannel(false);
  });

  // Capture, so the modal answers Escape before shortcuts.ts cancels a crop or
  // dismisses a toast behind it.
  document.addEventListener(
    'keydown',
    (e) => {
      if (modal.hidden) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
      e.stopPropagation();
    },
    true,
  );

  applySettings();
  void loadBuildLine();
  return loadSettings();
}

/** What the rest of the app reads; defaults until the Rust side answers. */
export function appSettings(): AppSettings {
  return settings;
}

/* --------------------------------------------------------------------------
 * Panel
 * ----------------------------------------------------------------------- */

function open(): void {
  modal.hidden = false;
  note.textContent = '';
  closeBtn.focus();
  void loadActiveChannel(false);
}

function close(): void {
  modal.hidden = true;
  downgradeArmed = false;
  alphaArmed = false;
  openBtn.focus();
}

function showSection(section: 'updates' | 'editing'): void {
  const updates = section === 'updates';
  tabUpdates.classList.toggle('active', updates);
  tabEditing.classList.toggle('active', !updates);
  sectionUpdates.hidden = !updates;
  sectionEditing.hidden = updates;
}

async function loadSettings(): Promise<void> {
  try {
    const loaded = await getSettings();
    const merged: AppSettings = { ...DEFAULT_SETTINGS, ...loaded };
    merged.defaultTargetMb = clamp(merged.defaultTargetMb, 0.5, 10_000);
    setSettings(merged);
  } catch {
    // No command on the other side, or an unreadable file. Defaults still work.
    return;
  }
  applySettings();
  if (!modal.hidden) void loadActiveChannel(false);
}

async function persist(): Promise<void> {
  // The controls mutate the shared object in place; this is what tells the rest
  // of the app to re-read it.
  setSettings(settings);
  try {
    await saveSettings(settings);
  } catch (error) {
    note.textContent = `Could not save settings: ${messageOf(error)}`;
  }
}

function applySettings(): void {
  autoCheck.checked = settings.autoCheckUpdates;
  formatSelect.value = settings.defaultFormat;
  qualitySelect.value = settings.defaultQuality;
  targetMbInput.value = String(settings.defaultTargetMb);
  filmstripBox.checked = settings.showFilmstrip;
  encoderSelect.value = settings.encoder;
  proxyBox.checked = settings.autoPreviewProxy;
  activeChannel = settings.updateChannel;
  renderChannelTabs();
}

function buildFormatOptions(): void {
  const source = document.createElement('option');
  source.value = 'source';
  source.textContent = 'Match the source file';

  const video = document.createElement('optgroup');
  video.label = 'Video';
  const audio = document.createElement('optgroup');
  audio.label = 'Audio';

  for (const format of VIDEO_FORMATS) video.appendChild(formatOption(format));
  for (const format of AUDIO_FORMATS) audio.appendChild(formatOption(format));

  formatSelect.replaceChildren(source, video, audio);
}

function formatOption(format: string): HTMLOptionElement {
  const option = document.createElement('option');
  option.value = format;
  option.textContent = format.toUpperCase();
  return option;
}

/* --------------------------------------------------------------------------
 * Releases
 * ----------------------------------------------------------------------- */

function renderChannelTabs(): void {
  channelStable.classList.toggle('active', activeChannel === 'stable');
  channelPrerelease.classList.toggle('active', activeChannel === 'prerelease');
  channelAlpha.classList.toggle('active', activeChannel === 'alpha');
  paneReleases.hidden = activeChannel === 'alpha';
  paneAlpha.hidden = activeChannel !== 'alpha';
}

function selectChannel(channel: UpdateChannel): void {
  if (activeChannel === channel) return;
  activeChannel = channel;
  selectedVersion = null;
  downgradeArmed = false;
  clearAlphaSelection();
  note.textContent = '';
  renderChannelTabs();

  // Looking at branch builds is not subscribing to them, so the saved channel -
  // the one the update check follows - only moves for the two release trains.
  if (channel !== 'alpha') {
    settings.updateChannel = channel;
    void persist();
  }

  void loadActiveChannel(false);
}

function loadActiveChannel(force: boolean): Promise<void> {
  return activeChannel === 'alpha' ? loadAlpha(force) : loadReleases(force);
}

/**
 * The button answers the question it asks: the release list alone never says
 * whether anything on it is newer than what is running.
 */
async function checkNow(): Promise<void> {
  checkBtn.disabled = true;
  note.textContent = 'Checking…';

  let outcome: string;
  try {
    const info = await checkForUpdate();
    outcome = info ? `v${info.version} is available.` : 'This is the newest build.';
  } catch (error) {
    outcome = messageOf(error);
  }
  checkBtn.disabled = false;

  // Last word, so the refreshed list cannot leave the answer off screen.
  await loadReleases(true);
  note.textContent = outcome;
}

async function loadReleases(force: boolean): Promise<void> {
  const channel = activeChannel;
  const cached = cache.get(channel);
  if (cached && !force) {
    listError = null;
    renderReleases();
    return;
  }

  loadingReleases = true;
  listError = null;
  refreshBtn.disabled = true;
  checkBtn.disabled = true;
  renderReleases();

  try {
    const releases = await listReleases(channel);
    cache.set(channel, { releases, at: Date.now() });
  } catch (error) {
    listError = messageOf(error);
  } finally {
    loadingReleases = false;
    refreshBtn.disabled = false;
    checkBtn.disabled = false;
  }

  // The channel can have been switched while the fetch was in flight.
  if (activeChannel === channel) renderReleases();
}

function renderReleases(): void {
  if (activeChannel === 'alpha') return;
  const cached = cache.get(activeChannel);

  checkedAtLine.textContent = cached ? `checked ${relativeTime(cached.at)}` : '';

  if (loadingReleases && !cached) {
    releasesList.replaceChildren(emptyRow('Loading releases…'));
    renderInstallButton();
    return;
  }

  if (!cached) {
    releasesList.replaceChildren(emptyRow(listError ?? 'No releases loaded yet.'));
    renderInstallButton();
    return;
  }

  if (listError) note.textContent = listError;

  if (cached.releases.length === 0) {
    releasesList.replaceChildren(emptyRow('No releases on this channel.'));
    renderInstallButton();
    return;
  }

  releasesList.replaceChildren(...cached.releases.map(releaseRow));
  renderInstallButton();
}

function releaseRow(info: ReleaseInfo): HTMLButtonElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'release-row';
  row.classList.toggle('selected', info.version === selectedVersion);

  const version = document.createElement('span');
  version.className = 'release-version';
  version.textContent = `v${info.version}`;
  row.appendChild(version);

  if (info.prerelease) row.appendChild(badge('Pre-release', 'pre-badge'));
  if (runningVersion !== '' && compareVersions(info.version, runningVersion) === 0) {
    row.appendChild(badge('Running', 'current-badge'));
  }

  const date = document.createElement('span');
  date.className = 'release-date';
  date.textContent = publishedText(info.publishedAt);
  row.appendChild(date);

  row.addEventListener('click', () => {
    selectedVersion = info.version;
    downgradeArmed = false;
    note.textContent = '';
    renderReleases();
  });

  return row;
}

function badge(text: string, className: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = `release-badge ${className}`;
  span.textContent = text;
  return span;
}

function emptyRow(text: string): HTMLElement {
  const div = document.createElement('div');
  div.className = 'releases-empty';
  div.textContent = text;
  return div;
}

function selectedRelease(): ReleaseInfo | null {
  const cached = cache.get(activeChannel);
  return cached?.releases.find((r) => r.version === selectedVersion) ?? null;
}

function renderInstallButton(): void {
  const info = selectedRelease();
  installBtn.disabled = info === null || installing || versionPending;

  if (!info || runningVersion === '') {
    installBtn.textContent = 'Install';
    return;
  }

  const order = compareVersions(info.version, runningVersion);
  installBtn.textContent = order > 0 ? 'Update' : order < 0 ? 'Downgrade' : 'Reinstall';
}

async function install(): Promise<void> {
  const info = selectedRelease();
  if (!info || installing) return;

  // An unreadable running version is not a licence to skip the gate: it could be
  // anything, including newer than the release about to replace it.
  const confirmFirst =
    runningVersion === '' || compareVersions(info.version, runningVersion) < 0;
  if (confirmFirst && !downgradeArmed) {
    downgradeArmed = true;
    note.textContent =
      runningVersion === ''
        ? `The running version could not be read, so v${info.version} may be older than it. Press Install again to replace it.`
        : `v${info.version} is older than the running v${runningVersion}. Press Downgrade again to replace it.`;
    return;
  }

  installing = true;
  downgradeArmed = false;
  renderInstallButton();
  note.textContent = `Downloading ${info.assetName}…`;

  try {
    // Succeeds by not returning: the installer is spawned and the app exits.
    await installRelease(info);
    note.textContent = 'Installing…';
  } catch (error) {
    installing = false;
    note.textContent = messageOf(error);
    renderInstallButton();
  }
}

async function loadBuildLine(): Promise<void> {
  try {
    runningVersion = normalise(await appVersion());
  } catch {
    /* Left unknown; install() asks before replacing a version it cannot read. */
  } finally {
    versionPending = false;
  }

  if (runningVersion !== '') {
    const commit = buildInfo().sha?.slice(0, 7) ?? null;

    buildLine.replaceChildren();
    buildLine.append('Running ');
    const version = document.createElement('b');
    version.textContent = `v${runningVersion}`;
    buildLine.appendChild(version);
    if (commit) buildLine.append(` · commit ${commit}`);
  }

  // Also the render that ungates Install, so it has to run on the failure path.
  renderActiveChannel();
}

/* --------------------------------------------------------------------------
 * Alpha
 * ----------------------------------------------------------------------- */

async function loadAlpha(force: boolean): Promise<void> {
  if (alphaCache && !force) {
    alphaError = null;
    renderAlpha();
    return;
  }

  loadingAlpha = true;
  alphaError = null;
  refreshBtn.disabled = true;
  renderAlpha();

  try {
    alphaCache = {
      builds: await listAlphaBuilds(force, buildInfo().sha ?? null),
      at: Date.now(),
    };
  } catch (error) {
    alphaError = messageOf(error);
  } finally {
    loadingAlpha = false;
    refreshBtn.disabled = false;
  }

  if (activeChannel === 'alpha') renderAlpha();
}

function renderAlpha(): void {
  if (activeChannel !== 'alpha') return;

  checkedAtLine.textContent = alphaCache ? `checked ${relativeTime(alphaCache.at)}` : '';

  if (loadingAlpha && !alphaCache) {
    alphaList.replaceChildren(emptyRow('Loading branch builds…'));
    renderAlphaButton();
    return;
  }

  if (!alphaCache) {
    alphaList.replaceChildren(emptyRow(alphaError ?? 'No branch builds loaded yet.'));
    renderAlphaButton();
    return;
  }

  if (alphaError) note.textContent = alphaError;

  if (alphaCache.builds.length === 0) {
    alphaList.replaceChildren(emptyRow('No branch builds yet.'));
    renderAlphaButton();
    return;
  }

  alphaList.replaceChildren(...alphaCache.builds.map(alphaRow));
  renderAlphaButton();
}

function alphaRow(build: AlphaBuild): HTMLButtonElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'release-row';
  row.classList.toggle('selected', build.runId === selectedRunId);

  const branch = document.createElement('span');
  branch.className = 'alpha-branch';
  branch.textContent = build.branch;
  row.appendChild(branch);

  const sha = document.createElement('span');
  sha.className = 'alpha-sha';
  sha.textContent = build.sha;
  row.appendChild(sha);

  if (build.isCurrent) row.appendChild(badge('Running', 'current-badge'));

  const meta = document.createElement('span');
  meta.className = 'release-date';
  meta.textContent = `run #${build.runNumber} · ${builtText(build.createdAt)}`;
  row.appendChild(meta);

  row.addEventListener('click', () => {
    selectedRunId = build.runId;
    alphaArmed = false;
    note.textContent = '';
    renderAlpha();
  });

  return row;
}

function selectedAlpha(): AlphaBuild | null {
  return alphaCache?.builds.find((build) => build.runId === selectedRunId) ?? null;
}

function renderAlphaButton(): void {
  installAlphaBtn.disabled = selectedAlpha() === null || installing;
}

function clearAlphaSelection(): void {
  selectedRunId = null;
  alphaArmed = false;
}

async function installAlpha(): Promise<void> {
  const build = selectedAlpha();
  if (!build || installing) return;

  // A branch build is not a release, so it always asks before replacing the app.
  if (!alphaArmed) {
    alphaArmed = true;
    note.textContent = `${build.branch} at ${build.sha} is a test build, not a release. Press Install this build again to replace the running app.`;
    return;
  }

  installing = true;
  alphaArmed = false;
  renderAlphaButton();
  note.textContent = `Downloading ${build.artifactName}…`;

  try {
    // Succeeds by not returning: the installer is spawned and the app exits.
    await installAlphaBuild(build);
    note.textContent = 'Installing…';
  } catch (error) {
    installing = false;
    note.textContent = messageOf(error);
    renderAlphaButton();
  }
}

function renderActiveChannel(): void {
  if (activeChannel === 'alpha') renderAlpha();
  else renderReleases();
}

/* --------------------------------------------------------------------------
 * Helpers
 * ----------------------------------------------------------------------- */

function publishedText(iso: string | null): string {
  if (!iso) return 'no publish date';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'no publish date';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Age of a CI run: recent ones are minutes or hours old, old ones get a date. */
function builtText(iso: string | null): string {
  if (!iso) return 'no run date';
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return 'no run date';

  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;

  const days = Math.round(hours / 24);
  if (days <= 30) return `${days} d ago`;
  return new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function relativeTime(at: number): string {
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function normalise(version: string): string {
  return version.trim().replace(/^v/i, '');
}

/**
 * Semver precedence, not string order: 0.10.0 is above 0.9.0, and a pre-release
 * ranks below the plain version it leads to.
 */
function compareVersions(a: string, b: string): number {
  const [aCore, aPre] = splitVersion(a);
  const [bCore, bPre] = splitVersion(b);

  for (let i = 0; i < 3; i += 1) {
    const diff = (aCore[i] ?? 0) - (bCore[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }

  if (aPre === null && bPre === null) return 0;
  if (aPre === null) return 1;
  if (bPre === null) return -1;
  return comparePre(aPre, bPre);
}

function splitVersion(raw: string): [number[], string[] | null] {
  const clean = normalise(raw).split('+')[0];
  const dash = clean.indexOf('-');
  const core = (dash >= 0 ? clean.slice(0, dash) : clean).split('.').map((part) => {
    const value = parseInt(part, 10);
    return Number.isFinite(value) ? value : 0;
  });
  return [core, dash >= 0 ? clean.slice(dash + 1).split('.') : null];
}

function comparePre(a: string[], b: string[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;

    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      const diff = Number(left) - Number(right);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

function messageOf(error: unknown): string {
  if (typeof error === 'string' && error.trim() !== '') return error;
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return 'Something went wrong.';
}
