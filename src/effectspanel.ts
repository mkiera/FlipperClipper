/**
 * The Quick Effects tab: one row per effect, switched on and off without losing its settings,
 * opening onto its own dials.
 *
 * The rows are built once and then only updated. Rebuilding them on every state change would
 * take the caret out of the text box mid-word and shut whatever the user had open.
 */

import {
  EFFECT_HINT,
  EFFECT_IDS,
  EFFECT_LABEL,
  EFFECT_RANGE,
  REDACT_MODES,
  REDACT_MODE_LABEL,
  appliesToAudioOnly,
  defaultEffects,
  dialAt,
  effectKeys,
  effectSummary,
  enabledIds,
  isKeyed,
  withDial,
  withEffectKeyToggled,
  withSetting,
  withSwitch,
} from './effects';
import { onTime } from './player';
import { REDACT_MAX_ITEMS, keyIndexAt, stateAt, withEdit, withKeyToggled } from './redact';
import {
  addRedaction,
  keyTolerance,
  playheadTime,
  redactItems,
  removeRedaction,
  selectRedaction,
  selectedRedaction,
  updateRedaction,
} from './redactedit';
import { edit, patchEdit, patchUi, refresh, subscribe, ui } from './state';
import {
  DISTORT_FROM,
  DISTORT_TO,
  LENS_FOV_MAX,
  LENS_FOV_MIN,
  LENS_PROJECTIONS,
  LENS_SIZES,
  SOURCE_FOV_MAX,
  SOURCE_FOV_MIN,
  fovRange,
  lensOutputSize,
  maxLensField,
  viewRise,
} from './lens';
import { circleUnfitted, fittedCircle, isFitting, movedCircle, setFitting, setLens } from './lensview';
import { frameWidth, isTurned } from './types';
import type {
  EffectId,
  EffectSettings,
  KeyedEffectId,
  Orientation,
  RedactItem,
  LensState,
  TextAnchorX,
  TextAnchorY,
} from './types';
import { valueKeyIndexAt } from './valuekeys';

const ANCHORS_X: TextAnchorX[] = ['left', 'center', 'right'];
const ANCHORS_Y: TextAnchorY[] = ['top', 'middle', 'bottom'];

let panel!: HTMLElement;
let list!: HTMLElement;
let countLabel!: HTMLElement;

/** More than one row can be open: they are short, and comparing two dials is the usual reason
 *  to open a second one. */
const expanded = new Set<EffectId>();

/** Whether an effect's row is open, for the stage's own controls of that effect. */
export function isEffectRowOpen(id: EffectId): boolean {
  return expanded.has(id);
}

/** Every control registers how to refresh itself, so render() never rebuilds the DOM. */
const updaters: (() => void)[] = [];

/** The controls that show the playhead's moment, refreshed as it moves too. */
const timeUpdaters: (() => void)[] = [];

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`FlipperClipper: index.html is missing #${id}`);
  return found as T;
}

export function initEffectsPanel(): void {
  panel = el('effects-panel');
  list = el('fx-list');
  countLabel = el('fx-count');

  el('fx-close').addEventListener('click', closeEffectsPanel);
  el('fx-reset').addEventListener('click', () => {
    patchEdit({ effects: defaultEffects() });
  });

  buildOrientation();
  list.replaceChildren(...EFFECT_IDS.map(buildRow));

  subscribe(render);
  onTime(() => {
    if (!ui.effectsOpen) return;
    for (const update of timeUpdaters) update();
  });
  render();
}

export function toggleEffectsPanel(): void {
  if (!edit.media) return;
  patchUi({ effectsOpen: !ui.effectsOpen });
}

export function closeEffectsPanel(): boolean {
  if (!ui.effectsOpen) return false;
  patchUi({ effectsOpen: false });
  return true;
}

/* --- Orientation --- */

/**
 * Turning the frame, above the effect rows. Not one of them: it changes the shape of the
 * frame rather than its pixels, everything downstream is measured in the turned frame, and it
 * has no strength to switch on and off.
 */
function buildOrientation(): void {
  const host = el('fx-orientation');

  const turn = (by: number) => () => {
    const rotate = (((edit.orientation.rotate + by) % 360) + 360) % 360;
    setOrientation({ rotate: rotate as Orientation['rotate'] });
  };

  const buttons: HTMLButtonElement[] = [
    chip('rotate-left', 'Turn left', turn(-90)),
    chip('rotate-right', 'Turn right', turn(90)),
    chip('flip-h', 'Mirror', () => setOrientation({ flipH: !edit.orientation.flipH })),
    chip('flip-v', 'Flip', () => setOrientation({ flipV: !edit.orientation.flipV })),
  ];
  host.replaceChildren(...buttons);

  const label = document.createElement('span');
  label.className = 'fx-summary';
  host.append(label);

  updaters.push(() => {
    const { rotate, flipH, flipV } = edit.orientation;
    buttons[2].classList.toggle('active', flipH);
    buttons[3].classList.toggle('active', flipV);
    const parts: string[] = [];
    if (rotate !== 0) parts.push(`${rotate} degrees`);
    if (flipH) parts.push('mirrored');
    if (flipV) parts.push('flipped');
    label.textContent = parts.length > 0 ? parts.join(', ') : 'Upright';
  });
}

function chip(name: string, title: string, run: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `icon-btn small fx-turn fx-turn-${name}`;
  button.title = title;
  button.setAttribute('aria-label', title);
  button.addEventListener('click', run);
  return button;
}

/** A turn moves every coordinate the crop was drawn in, so the crop goes with it rather than
 *  landing somewhere the user never chose. Ctrl+Z puts both back together. */
function setOrientation(patch: Partial<Orientation>): void {
  const orientation = { ...edit.orientation, ...patch };
  const swapped = isTurned(orientation) !== isTurned(edit.orientation);
  patchEdit({
    orientation,
    ...(swapped && edit.crop ? { crop: null } : {}),
    // The lens circle stays on the same part of the picture.
    ...(edit.effects.settings.distortion.r > 0
      ? { effects: withSetting(edit.effects, 'distortion', movedCircle(edit.effects.settings.distortion, edit.orientation, orientation)) }
      : {}),
  });
}

/* --- Rows --- */

function buildRow(id: EffectId): HTMLElement {
  const row = document.createElement('div');
  row.className = 'fx-row';
  row.dataset.id = id;

  const head = document.createElement('div');
  head.className = 'fx-head';

  const label = document.createElement('label');
  label.className = 'switch';
  label.title = `Turn ${EFFECT_LABEL[id]} on or off. Its settings are kept either way.`;
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.setAttribute('aria-label', EFFECT_LABEL[id]);
  const track = document.createElement('span');
  track.className = 'switch-track';
  label.append(box, track);
  box.addEventListener('change', () => {
    // Switching an effect on is nearly always followed by reaching for its dial.
    if (box.checked) expanded.add(id);
    let effects = withSwitch(edit.effects, id, box.checked);
    // A lens circle starts as the round picture found in the frame on show, once there is one.
    if (id === 'distortion' && box.checked && circleUnfitted(effects.settings.distortion, edit.orientation)) {
      effects = withSetting(effects, 'distortion', fittedCircle(edit.orientation));
    }
    patchEdit({ effects });
  });

  const opener = document.createElement('button');
  opener.type = 'button';
  opener.className = 'fx-open';
  const name = document.createElement('span');
  name.className = 'fx-name';
  name.textContent = EFFECT_LABEL[id];
  const summary = document.createElement('span');
  summary.className = 'fx-summary';
  const chevron = document.createElement('span');
  chevron.className = 'fx-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.textContent = '›';
  opener.append(name, summary, chevron);
  opener.addEventListener('click', () => {
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    // Through the state's listeners: an open Distortion row hands the picture its controls.
    refresh();
  });

  head.append(label, opener);

  const body = document.createElement('div');
  body.className = 'fx-body';
  body.append(...buildBody(id));
  if (isKeyed(id)) body.append(buildKeyLine(id));

  const hint = document.createElement('p');
  hint.className = 'fx-hint';
  hint.textContent = EFFECT_HINT[id];
  body.append(hint);

  row.append(head, body);

  updaters.push(() => {
    const on = edit.effects.on[id];
    box.checked = on;
    row.classList.toggle('on', on);
    // Still switchable, just marked as having nothing to act on in this export.
    row.classList.toggle('inert', edit.audioOnly && !appliesToAudioOnly(id));
    summary.textContent = effectSummary(edit.effects, id);
    const open = expanded.has(id);
    body.hidden = !open;
    opener.setAttribute('aria-expanded', String(open));
    row.classList.toggle('open', open);
  });

  return row;
}

function buildBody(id: EffectId): HTMLElement[] {
  switch (id) {
    case 'distortion':
      return buildDistortionBody();
    case 'brightness':
      return [multiplier('Amount', 'brightness')];
    case 'contrast':
      return [multiplier('Amount', 'contrast')];
    case 'saturation':
      return [multiplier('Amount', 'saturation')];
    case 'hue':
      return [
        dialSlider('hue', 'Rotation', EFFECT_RANGE.hue, (v) => `${v > 0 ? '+' : ''}${Math.round(v)}°`),
      ];
    case 'blur':
      return [dialSlider('blur', 'Strength', EFFECT_RANGE.blur, (v) => `${Math.round(v * 10) / 10} px`)];
    case 'vignette':
      return [
        dialSlider('vignette', 'Strength', EFFECT_RANGE.vignette, (v) => `${Math.round(v * 100)}%`),
      ];
    case 'fade':
      return [
        slider({
          label: 'Fade in',
          ...EFFECT_RANGE.fade,
          read: () => edit.effects.settings.fade.inSeconds,
          show: (v) => `${v.toFixed(1)}s`,
          write: (v) => setSetting('fade', { inSeconds: v }),
        }),
        slider({
          label: 'Fade out',
          ...EFFECT_RANGE.fade,
          read: () => edit.effects.settings.fade.outSeconds,
          show: (v) => `${v.toFixed(1)}s`,
          write: (v) => setSetting('fade', { outSeconds: v }),
        }),
      ];
    case 'redact':
      return buildRedactBody();
    case 'text':
      return buildTextBody();
  }
}

/* --- Distortion --- */

const ASPECTS: { label: string; value: number }[] = [
  { label: '16:9', value: 16 / 9 },
  { label: '4:3', value: 4 / 3 },
  { label: '1:1', value: 1 },
  { label: '9:16', value: 9 / 16 },
];

function lens(): LensState {
  return edit.effects.settings.distortion;
}

function chipGroup<T>(name: string, options: { label: string; value: T }[], pick: (value: T) => void, current: () => T): HTMLElement {
  const group = document.createElement('div');
  group.className = 'chips fx-modes';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', name);
  const chips = options.map((option) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.textContent = option.label;
    button.addEventListener('click', () => pick(option.value));
    group.append(button);
    return { button, option };
  });
  updaters.push(() => {
    for (const { button, option } of chips) {
      const on = option.value === current();
      button.classList.toggle('active', on);
      button.setAttribute('aria-pressed', String(on));
    }
  });
  return group;
}

function selectOf(name: string, options: { label: string; value: string }[], pick: (value: string) => void, current: () => string): HTMLSelectElement {
  const select = document.createElement('select');
  select.setAttribute('aria-label', name);
  select.title = name;
  select.replaceChildren(...options.map((o) => new Option(o.label, o.value)));
  select.addEventListener('change', () => pick(select.value));
  updaters.push(() => {
    if (select.value !== current()) select.value = current();
  });
  return select;
}

function buildDistortionBody(): HTMLElement[] {
  const from = chipGroup('Source', DISTORT_FROM, (value) => {
    // Each source reads the aim differently, so the view starts over looking straight ahead.
    setLens({ from: value, pan: 0, tilt: 0, roll: 0 });
  }, () => lens().from);

  const projection = selectOf(
    'Lens type. Most fisheye and all-sky lenses are equidistant.',
    LENS_PROJECTIONS,
    (value) => {
      const projection = value as LensState['projection'];
      setLens({ projection, lensFov: Math.min(maxLensField(projection), lens().lensFov) });
    },
    () => lens().projection,
  );
  const facing = selectOf(
    'Which way the camera points. Up keeps the sky above the horizon, for an all-sky camera.',
    [
      { label: 'Camera faces up', value: 'up' },
      { label: 'Camera faces forward', value: 'forward' },
    ],
    (value) => setLens({ facing: value === 'forward' ? 'forward' : 'up', pan: 0, tilt: 0, roll: 0 }),
    () => lens().facing,
  );
  const fit = document.createElement('button');
  fit.type = 'button';
  fit.className = 'btn';
  fit.textContent = 'Fit lens circle';
  fit.title = 'Show the source picture, and drag the ring onto the edge of the round picture';
  fit.addEventListener('click', () => setFitting(!isFitting()));
  updaters.push(() => {
    const on = isFitting();
    fit.classList.toggle('active', on);
    fit.setAttribute('aria-pressed', String(on));
  });
  const fisheyeLine = document.createElement('div');
  fisheyeLine.className = 'fx-line fx-fill';
  fisheyeLine.append(projection, facing);
  const lensField = slider({
    label: 'Lens field',
    min: LENS_FOV_MIN,
    max: LENS_FOV_MAX,
    step: 1,
    read: () => lens().lensFov,
    show: (v) => `${Math.round(v)}°`,
    write: (v) => setLens({ lensFov: Math.min(maxLensField(lens().projection), v) }),
  });
  const fitLine = document.createElement('div');
  fitLine.className = 'fx-line';
  fitLine.append(fit);

  const sourceField = slider({
    label: 'Source field',
    min: SOURCE_FOV_MIN,
    max: SOURCE_FOV_MAX,
    step: 1,
    read: () => lens().sourceFov,
    show: (v) => `${Math.round(v)}°`,
    write: (v) => setLens({ sourceFov: v }),
  });

  const to = selectOf(
    'Output view',
    DISTORT_TO,
    (value) => {
      const next = value as LensState['to'];
      const range = fovRange(next);
      setLens({ to: next, fov: Math.min(range.max, Math.max(range.min, lens().fov)) });
    },
    () => lens().to,
  );
  const toLine = labelled('Into', to);
  to.classList.add('fx-wide');

  const field = slider({
    label: 'Field',
    min: 5,
    max: 360,
    step: 1,
    read: () => lens().fov,
    show: (v) => `${Math.round(v)}°`,
    write: (v) => {
      const range = fovRange(lens().to);
      setLens({ fov: Math.min(range.max, Math.max(range.min, v)) });
    },
  });
  const turn = slider({
    label: 'Turn',
    min: -180,
    max: 180,
    step: 1,
    read: () => lens().roll,
    show: (v) => `${Math.round(v)}°`,
    write: (v) => setLens({ roll: v }),
    snap: 0,
  });
  const rise = slider({
    label: 'Rise',
    min: -1,
    max: 1,
    step: 0.01,
    read: () => viewRise(lens()),
    show: (v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`,
    write: (v) => setLens({ rise: viewRise({ ...lens(), rise: v }) }),
    snap: 0,
  });
  rise.title = 'Moves the frame up or down without tilting it, so upright things stay upright.';
  const fill = slider({
    label: 'Fill',
    min: 0,
    max: 1,
    step: 0.01,
    read: () => lens().fill || 0,
    show: (v) => `${Math.round(v * 100)}%`,
    write: (v) => setLens({ fill: v }),
    snap: 0,
  });
  fill.title = 'Stretches the picture over the part the lens never saw, so less of the view is black.';

  const aspect = chipGroup('Shape', ASPECTS, (value) => setLens({ aspect: value }), () => lens().aspect);
  const size = document.createElement('select');
  size.setAttribute('aria-label', 'Output size');
  size.title = 'Output size';
  const detail = new Option('Source detail', '');
  size.replaceChildren(detail, ...LENS_SIZES.map((s) => new Option(`${s}p`, String(s))));
  size.addEventListener('change', () => setLens({ size: size.value === '' ? null : Number(size.value) }));
  const outLine = document.createElement('div');
  outLine.className = 'fx-line fx-fill';
  size.classList.add('fx-wide');
  outLine.append(aspect);

  updaters.push(() => {
    const l = lens();
    const fisheye = l.from === 'fisheye';
    fisheyeLine.hidden = !fisheye;
    lensField.hidden = !fisheye;
    fitLine.hidden = !fisheye;
    sourceField.hidden = l.from !== 'normal';
    fill.hidden = !fisheye;
    const riseInput = rise.querySelector('input');
    if (riseInput) {
      const most = viewRise({ ...l, rise: 1 });
      riseInput.min = String(-most);
      riseInput.max = String(most);
      riseInput.disabled = most === 0;
      if (document.activeElement !== riseInput) riseInput.value = String(viewRise(l));
    }
    const lensInput = lensField.querySelector('input');
    if (lensInput) lensInput.max = String(maxLensField(l.projection));
    const range = fovRange(l.to);
    const input = field.querySelector('input');
    if (input) {
      input.min = String(range.min);
      input.max = String(range.max);
    }
    const native = lensOutputSize({ ...l, size: null }, frameWidth(edit));
    detail.textContent = `Source detail (${native.w} x ${native.h})`;
    const value = l.size === null ? '' : String(l.size);
    if (size.value !== value) size.value = value;
  });

  return [from, fisheyeLine, lensField, fitLine, sourceField, toLine, field, turn, rise, fill, outLine, size];
}

function buildRedactBody(): HTMLElement[] {
  const regions = document.createElement('div');
  regions.className = 'chips fx-modes';
  regions.setAttribute('role', 'group');
  regions.setAttribute('aria-label', 'Redactions');
  let regionsKey = '';

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'chip';
  add.textContent = '+';
  add.title = 'Add a redaction';
  add.setAttribute('aria-label', 'Add a redaction');
  add.addEventListener('click', addRedaction);

  const modes = document.createElement('div');
  modes.className = 'chips fx-modes';
  modes.setAttribute('role', 'group');
  modes.setAttribute('aria-label', 'Redact style');
  const modeChips = REDACT_MODES.map((mode) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.textContent = REDACT_MODE_LABEL[mode];
    button.addEventListener('click', () => editSelected((item) => ({ ...item, mode })));
    modes.append(button);
    return { button, mode };
  });

  const strength = slider({
    label: 'Strength',
    ...EFFECT_RANGE.redact,
    read: () => selectedRedaction()?.strength ?? 16,
    show: (v) => `${Math.round(v)} px`,
    write: (v) => editSelected((item) => ({ ...item, strength: v })),
  });

  const visible = document.createElement('label');
  visible.className = 'fx-check';
  visible.title = 'Show or hide this redaction from the playhead on. With keyframes, this sets a keyframe here.';
  const visibleBox = document.createElement('input');
  visibleBox.type = 'checkbox';
  const visibleText = document.createElement('span');
  visibleText.textContent = 'Visible';
  visible.append(visibleBox, visibleText);
  visibleBox.addEventListener('change', () => {
    const t = playheadTime();
    editSelected((item) => withEdit(item, t, { on: visibleBox.checked }, keyTolerance()));
  });

  const keyButton = document.createElement('button');
  keyButton.type = 'button';
  keyButton.className = 'btn fx-key';
  keyButton.addEventListener('click', () => {
    const t = playheadTime();
    editSelected((item) => withKeyToggled(item, t, keyTolerance()));
  });

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn';
  remove.textContent = 'Remove';
  remove.title = 'Remove this redaction';
  remove.addEventListener('click', () => {
    const item = selectedRedaction();
    if (item) removeRedaction(item.id);
  });

  const actions = document.createElement('div');
  actions.className = 'fx-line fx-redact-actions';
  actions.append(visible, keyButton, remove);

  const update = () => {
    const items = redactItems();
    const selected = selectedRedaction();
    const key = items.map((item) => item.id).join(',') + '|' + (selected?.id ?? '');
    if (key !== regionsKey) {
      regionsKey = key;
      const chips = items.map((item, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'chip';
        button.textContent = String(index + 1);
        button.title = `Redaction ${index + 1}`;
        button.setAttribute('aria-label', `Redaction ${index + 1}`);
        button.classList.toggle('active', item.id === selected?.id);
        button.setAttribute('aria-pressed', String(item.id === selected?.id));
        button.addEventListener('click', () => selectRedaction(item.id));
        return button;
      });
      regions.replaceChildren(...chips, add);
    }
    add.disabled = items.length >= REDACT_MAX_ITEMS;

    const has = selected !== null;
    modes.hidden = !has;
    actions.hidden = !has;
    strength.hidden = !has || selected.mode === 'box';
    if (!selected) return;
    for (const chip of modeChips) {
      chip.button.classList.toggle('active', chip.mode === selected.mode);
      chip.button.setAttribute('aria-pressed', String(chip.mode === selected.mode));
    }
    const t = playheadTime();
    visibleBox.checked = stateAt(selected, t).on;
    const onKey = keyIndexAt(selected, t, keyTolerance()) >= 0;
    keyButton.textContent = onKey ? '◆ Remove keyframe' : '◇ Add keyframe';
    keyButton.title = onKey
      ? 'Remove the keyframe at the playhead'
      : 'Add a keyframe at the playhead. Then move the playhead and move the box to animate it.';
  };
  updaters.push(update);
  // The keyframe button and the Visible box describe the playhead, so they follow it.
  onTime(() => {
    if (ui.effectsOpen) update();
  });

  return [regions, modes, strength, actions];
}

function editSelected(change: (item: RedactItem) => RedactItem): void {
  const item = selectedRedaction();
  if (item) updateRedaction(item.id, change);
}

function multiplier(label: string, id: 'brightness' | 'contrast' | 'saturation'): HTMLElement {
  return dialSlider(id, label, EFFECT_RANGE[id], (v) => {
    const delta = Math.round((v - 1) * 100);
    return `${delta > 0 ? '+' : ''}${delta}%`;
  });
}

/** The dial a keyframe holds. It shows the value at the playhead, and moving it with
 *  keyframes set changes the keyframe there or adds one. */
function dialSlider(
  id: KeyedEffectId,
  label: string,
  range: { min: number; max: number; step: number },
  show: (value: number) => string,
): HTMLElement {
  return slider(
    {
      label,
      ...range,
      read: () => dialAt(edit.effects, id, playheadTime()).v,
      show,
      write: (v) =>
        patchEdit({ effects: withDial(edit.effects, id, playheadTime(), { v }, keyTolerance()) }),
    },
    true,
  );
}

/** The keyframe button, and once there are keyframes, whether the effect is on from here. */
function buildKeyLine(id: KeyedEffectId): HTMLElement {
  const active = document.createElement('label');
  active.className = 'fx-check';
  active.title = 'Turn this effect on or off from the playhead on. This sets a keyframe here.';
  const activeBox = document.createElement('input');
  activeBox.type = 'checkbox';
  const activeText = document.createElement('span');
  activeText.textContent = 'On here';
  active.append(activeBox, activeText);
  activeBox.addEventListener('change', () => {
    patchEdit({
      effects: withDial(edit.effects, id, playheadTime(), { on: activeBox.checked }, keyTolerance()),
    });
  });

  const keyButton = document.createElement('button');
  keyButton.type = 'button';
  keyButton.className = 'btn fx-key';
  keyButton.addEventListener('click', () => {
    patchEdit({ effects: withEffectKeyToggled(edit.effects, id, playheadTime(), keyTolerance()) });
  });

  const line = document.createElement('div');
  line.className = 'fx-line fx-redact-actions';
  line.append(active, keyButton);

  const update = () => {
    const keys = effectKeys(edit.effects, id);
    const t = playheadTime();
    active.hidden = keys.length === 0;
    activeBox.checked = dialAt(edit.effects, id, t).on;
    const onKey = valueKeyIndexAt(keys, t, keyTolerance()) >= 0;
    keyButton.textContent = onKey ? '◆ Remove keyframe' : '◇ Add keyframe';
    keyButton.title = onKey
      ? 'Remove the keyframe at the playhead'
      : 'Add a keyframe at the playhead. Then move the playhead and change the setting to animate it.';
  };
  updaters.push(update);
  timeUpdaters.push(update);
  return line;
}

function buildTextBody(): HTMLElement[] {
  const area = document.createElement('textarea');
  area.className = 'fx-textarea';
  area.rows = 2;
  area.spellcheck = false;
  area.setAttribute('aria-label', 'Overlay text');
  area.placeholder = 'Type the words to draw';
  area.addEventListener('input', () => setSetting('text', { text: area.value }));
  updaters.push(() => {
    // Left alone while it has the caret, the same as the speed and volume inputs.
    if (document.activeElement !== area) area.value = edit.effects.settings.text.text;
  });

  const grid = document.createElement('div');
  grid.className = 'fx-anchors';
  grid.setAttribute('role', 'group');
  grid.setAttribute('aria-label', 'Text position');
  const cells: { button: HTMLButtonElement; x: TextAnchorX; y: TextAnchorY }[] = [];
  for (const y of ANCHORS_Y) {
    for (const x of ANCHORS_X) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'fx-anchor';
      button.title = `${y} ${x}`;
      button.setAttribute('aria-label', `${y} ${x}`);
      button.addEventListener('click', () => setSetting('text', { anchorX: x, anchorY: y }));
      grid.append(button);
      cells.push({ button, x, y });
    }
  }
  updaters.push(() => {
    const text = edit.effects.settings.text;
    for (const cell of cells) {
      cell.button.classList.toggle('active', cell.x === text.anchorX && cell.y === text.anchorY);
    }
  });

  const colour = document.createElement('input');
  colour.type = 'color';
  colour.className = 'fx-color';
  colour.setAttribute('aria-label', 'Text colour');
  colour.addEventListener('input', () => setSetting('text', { color: colour.value }));
  updaters.push(() => {
    if (document.activeElement !== colour) colour.value = edit.effects.settings.text.color;
  });

  const plate = document.createElement('label');
  plate.className = 'fx-check';
  const plateBox = document.createElement('input');
  plateBox.type = 'checkbox';
  const plateText = document.createElement('span');
  plateText.textContent = 'Dark plate behind';
  plate.append(plateBox, plateText);
  plateBox.addEventListener('change', () => setSetting('text', { boxed: plateBox.checked }));
  updaters.push(() => {
    plateBox.checked = edit.effects.settings.text.boxed;
  });

  const trailer = document.createElement('div');
  trailer.className = 'fx-line';
  trailer.append(labelled('Position', grid), labelled('Colour', colour));

  return [
    area,
    slider({
      label: 'Size',
      ...EFFECT_RANGE.textSize,
      read: () => edit.effects.settings.text.size,
      show: (v) => `${Math.round(v * 100)}% of height`,
      write: (v) => setSetting('text', { size: v }),
    }),
    dialSlider('text', 'Opacity', EFFECT_RANGE.textOpacity, (v) => `${Math.round(v * 100)}%`),
    trailer,
    plate,
  ];
}

function labelled(text: string, control: HTMLElement): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'fx-labelled';
  const label = document.createElement('span');
  label.className = 'fx-sublabel';
  label.textContent = text;
  wrap.append(label, control);
  return wrap;
}

interface SliderSpec {
  label: string;
  min: number;
  max: number;
  step: number;
  read: () => number;
  show: (value: number) => string;
  write: (value: number) => void;
  /** A value a dragged thumb settles on when it comes near. */
  snap?: number;
}

function slider(spec: SliderSpec, followsPlayhead = false): HTMLElement {
  const row = document.createElement('div');
  row.className = 'fx-slider';

  const label = document.createElement('span');
  label.className = 'fx-sublabel';
  label.textContent = spec.label;

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(spec.min);
  input.max = String(spec.max);
  input.step = String(spec.step);
  input.setAttribute('aria-label', spec.label);

  const value = document.createElement('span');
  value.className = 'fx-value';

  // Only a dragged thumb snaps: an arrow key's one step from the snap point must not undo itself.
  let dragging = false;
  input.addEventListener('pointerdown', () => (dragging = true));
  for (const type of ['pointerup', 'pointercancel']) window.addEventListener(type, () => (dragging = false));
  input.addEventListener('keydown', () => (dragging = false));
  input.addEventListener('input', () => {
    let v = Number(input.value);
    // A detent about three pixels of thumb travel wide each side, whatever the slider's length.
    const zone = (Number(input.max) - Number(input.min)) * (input.clientWidth > 0 ? 3 / input.clientWidth : 0.02);
    if (dragging && spec.snap !== undefined && Math.abs(v - spec.snap) <= zone) {
      v = spec.snap;
      input.value = String(v);
    }
    spec.write(v);
  });

  row.append(label, input, value);
  const update = () => {
    const current = spec.read();
    if (document.activeElement !== input) input.value = String(current);
    value.textContent = spec.show(current);
  };
  updaters.push(update);
  if (followsPlayhead) timeUpdaters.push(update);
  return row;
}

function setSetting<K extends EffectId>(id: K, patch: Partial<EffectSettings[K]>): void {
  patchEdit({ effects: withSetting(edit.effects, id, patch) });
}

/* --- Rendering --- */

function render(): void {
  const open = ui.effectsOpen && edit.media !== null;
  panel.hidden = !open;
  if (!open) return;

  const count = enabledIds(edit.effects).length;
  countLabel.textContent = edit.audioOnly
    ? 'Audio only - the fade is the only one that applies'
    : count === 0
      ? 'None applied'
      : `${count} applied`;
  countLabel.classList.toggle('some', !edit.audioOnly && count > 0);

  for (const update of updaters) update();
}
