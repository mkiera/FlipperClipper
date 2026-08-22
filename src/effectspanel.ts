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
  appliesToAudioOnly,
  defaultEffects,
  effectSummary,
  enabledIds,
  withSetting,
  withSwitch,
} from './effects';
import { edit, patchEdit, patchUi, subscribe, ui } from './state';
import { isTurned } from './types';
import type { EffectId, EffectSettings, Orientation, TextAnchorX, TextAnchorY } from './types';

const ANCHORS_X: TextAnchorX[] = ['left', 'center', 'right'];
const ANCHORS_Y: TextAnchorY[] = ['top', 'middle', 'bottom'];

let panel!: HTMLElement;
let list!: HTMLElement;
let countLabel!: HTMLElement;

/** More than one row can be open: they are short, and comparing two dials is the usual reason
 *  to open a second one. */
const expanded = new Set<EffectId>();

/** Every control registers how to refresh itself, so render() never rebuilds the DOM. */
const updaters: (() => void)[] = [];

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
  patchEdit({ orientation, ...(swapped && edit.crop ? { crop: null } : {}) });
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
    patchEdit({ effects: withSwitch(edit.effects, id, box.checked) });
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
    render();
  });

  head.append(label, opener);

  const body = document.createElement('div');
  body.className = 'fx-body';
  body.append(...buildBody(id));

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
    case 'brightness':
      return [multiplier('Amount', 'brightness')];
    case 'contrast':
      return [multiplier('Amount', 'contrast')];
    case 'saturation':
      return [multiplier('Amount', 'saturation')];
    case 'hue':
      return [
        slider({
          label: 'Rotation',
          ...EFFECT_RANGE.hue,
          read: () => edit.effects.settings.hue.degrees,
          show: (v) => `${v > 0 ? '+' : ''}${Math.round(v)}°`,
          write: (v) => setSetting('hue', { degrees: v }),
        }),
      ];
    case 'blur':
      return [
        slider({
          label: 'Strength',
          ...EFFECT_RANGE.blur,
          read: () => edit.effects.settings.blur.sigma,
          show: (v) => `${v} px`,
          write: (v) => setSetting('blur', { sigma: v }),
        }),
      ];
    case 'vignette':
      return [
        slider({
          label: 'Strength',
          ...EFFECT_RANGE.vignette,
          read: () => edit.effects.settings.vignette.amount,
          show: (v) => `${Math.round(v * 100)}%`,
          write: (v) => setSetting('vignette', { amount: v }),
        }),
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
    case 'text':
      return buildTextBody();
  }
}

function multiplier(label: string, id: 'brightness' | 'contrast' | 'saturation'): HTMLElement {
  return slider({
    label,
    ...EFFECT_RANGE[id],
    read: () => edit.effects.settings[id].amount,
    show: (v) => {
      const delta = Math.round((v - 1) * 100);
      return `${delta > 0 ? '+' : ''}${delta}%`;
    },
    write: (v) => setSetting(id, { amount: v }),
  });
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
    slider({
      label: 'Opacity',
      ...EFFECT_RANGE.textOpacity,
      read: () => edit.effects.settings.text.opacity,
      show: (v) => `${Math.round(v * 100)}%`,
      write: (v) => setSetting('text', { opacity: v }),
    }),
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
}

function slider(spec: SliderSpec): HTMLElement {
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

  input.addEventListener('input', () => spec.write(Number(input.value)));

  row.append(label, input, value);
  updaters.push(() => {
    const current = spec.read();
    if (document.activeElement !== input) input.value = String(current);
    value.textContent = spec.show(current);
  });
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
