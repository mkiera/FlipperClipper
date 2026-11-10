/**
 * The effect catalogue, and the two translations every effect needs: one into the export's
 * filter job, one into the CSS the preview wears.
 *
 * The preview is an approximation and is meant to be read as one. CSS applies contrast and
 * saturation across RGB where ffmpeg's `eq` works on luma and chroma separately, so a heavily
 * graded frame differs a little between the window and the file. Blur, brightness and hue do
 * match: the same Gaussian sigma, the same multiply, the same rotation.
 *
 * DOM-free on purpose - effectspanel.ts draws the tab and overlay.ts draws the frame, and both
 * read the catalogue from here.
 */

import type {
  EffectId,
  EffectSettings,
  EffectsJob,
  EffectsState,
  KeyedEffectId,
  RedactMode,
  TextOverlay,
  ValueKey,
} from './types';
import { everShown, newRedaction, toRedactJob } from './redact';
import {
  type ValueState,
  valueAt,
  withValueEdit,
  withValueKeyMoved,
  withValueKeyToggled,
} from './valuekeys';

/** Display order in the tab: the colour dials, then the two that reshape the frame, then the
 *  two that add something to it. */
export const EFFECT_IDS: EffectId[] = [
  'brightness',
  'contrast',
  'saturation',
  'hue',
  'blur',
  'vignette',
  'redact',
  'text',
  'fade',
];

export const EFFECT_LABEL: Record<EffectId, string> = {
  brightness: 'Brightness',
  contrast: 'Contrast',
  saturation: 'Saturation',
  hue: 'Hue shift',
  blur: 'Blur',
  vignette: 'Vignette',
  redact: 'Redact',
  text: 'Text overlay',
  fade: 'Fade in / out',
};

export const EFFECT_HINT: Record<EffectId, string> = {
  brightness: 'Multiplies every pixel, so black stays black.',
  contrast: 'Pushes light and dark away from the midpoint.',
  saturation: 'Zero is black and white, above one is punchier colour.',
  hue: 'Rotates every colour around the wheel.',
  blur: 'Measured on the source frame, so it looks the same at any export size.',
  vignette: 'Darkens the corners.',
  redact:
    'Hides parts of the frame. Drag a box on the picture to move it, or its corners to resize it. Add a keyframe to animate it, then move the playhead and move the box.',
  text: 'Drawn at the export size, over the cropped frame. Keyframes animate its opacity.',
  fade: 'Timed on the finished clip, and the audio fades with the picture.',
};

/** The bounds the sliders travel between. export.rs validates the same numbers. */
export const EFFECT_RANGE = {
  brightness: { min: 0.2, max: 2, step: 0.01 },
  contrast: { min: 0.2, max: 3, step: 0.01 },
  saturation: { min: 0, max: 3, step: 0.01 },
  hue: { min: -180, max: 180, step: 1 },
  blur: { min: 0.5, max: 50, step: 0.5 },
  vignette: { min: 0, max: 1, step: 0.01 },
  redact: { min: 2, max: 100, step: 1 },
  fade: { min: 0, max: 60, step: 0.1 },
  textSize: { min: 0.02, max: 0.3, step: 0.005 },
  textOpacity: { min: 0.1, max: 1, step: 0.05 },
};

/** Switching an effect on has to do something visible, so every default sits off-centre. */
export function defaultEffects(): EffectsState {
  return {
    on: {
      brightness: false,
      contrast: false,
      saturation: false,
      hue: false,
      blur: false,
      vignette: false,
      redact: false,
      text: false,
      fade: false,
    },
    settings: {
      brightness: { amount: 1.2, keys: [] },
      contrast: { amount: 1.25, keys: [] },
      saturation: { amount: 1.3, keys: [] },
      hue: { degrees: 30, keys: [] },
      blur: { sigma: 8, keys: [] },
      vignette: { amount: 0.5, keys: [] },
      redact: { items: [newRedaction([])] },
      text: {
        text: 'Your text',
        size: 0.07,
        color: '#ffffff',
        opacity: 1,
        anchorX: 'center',
        anchorY: 'bottom',
        boxed: true,
        keys: [],
      },
      fade: { inSeconds: 0.5, outSeconds: 0.5 },
    },
  };
}

export function enabledIds(effects: EffectsState): EffectId[] {
  return EFFECT_IDS.filter((id) => effects.on[id]);
}

/** Switched on and doing something somewhere in the clip: text with words to draw, a
 *  redaction that shows, keyframes that turn the effect on at least once. */
export function hasEffect(effects: EffectsState, id: EffectId): boolean {
  if (!effects.on[id]) return false;
  if (id === 'text' && effects.settings.text.text.trim() === '') return false;
  if (id === 'redact') return effects.settings.redact.items.some(everShown);
  if (isKeyed(id)) {
    const keys = effectKeys(effects, id);
    return keys.length === 0 || keys.some((key) => key.on);
  }
  return true;
}

/* --- Keyframed dials --- */

export const KEYED_IDS: KeyedEffectId[] = [
  'brightness',
  'contrast',
  'saturation',
  'hue',
  'blur',
  'vignette',
  'text',
];

export function isKeyed(id: EffectId): id is KeyedEffectId {
  return (KEYED_IDS as EffectId[]).includes(id);
}

/** The dial a keyframe holds. For text that is the opacity. */
export function dialValue(effects: EffectsState, id: KeyedEffectId): number {
  const s = effects.settings;
  switch (id) {
    case 'brightness':
    case 'contrast':
    case 'saturation':
    case 'vignette':
      return s[id].amount;
    case 'hue':
      return s.hue.degrees;
    case 'blur':
      return s.blur.sigma;
    case 'text':
      return s.text.opacity;
  }
}

function withDialValue(effects: EffectsState, id: KeyedEffectId, v: number): EffectsState {
  switch (id) {
    case 'brightness':
    case 'contrast':
    case 'saturation':
    case 'vignette':
      return withSetting(effects, id, { amount: v });
    case 'hue':
      return withSetting(effects, 'hue', { degrees: v });
    case 'blur':
      return withSetting(effects, 'blur', { sigma: v });
    case 'text':
      return withSetting(effects, 'text', { opacity: v });
  }
}

export function effectKeys(effects: EffectsState, id: KeyedEffectId): ValueKey[] {
  return effects.settings[id].keys ?? [];
}

function withKeys(effects: EffectsState, id: KeyedEffectId, keys: ValueKey[]): EffectsState {
  return withSetting(effects, id, { keys } as Partial<EffectSettings[typeof id]>);
}

/** The dial and whether the effect acts, at source time `t`. The switch is not part of it. */
export function dialAt(effects: EffectsState, id: KeyedEffectId, t: number): ValueState {
  return valueAt(effectKeys(effects, id), { v: dialValue(effects, id), on: true }, t);
}

/** Whether the effect acts on the frame at source time `t`. */
export function activeAt(effects: EffectsState, id: KeyedEffectId, t: number): boolean {
  return hasEffect(effects, id) && dialAt(effects, id, t).on;
}

/** A dial moved, or the on box ticked, with the playhead at `t`. Without keyframes the dial
 *  changes for the whole clip; with them the keyframe at the playhead changes, or one is added. */
export function withDial(
  effects: EffectsState,
  id: KeyedEffectId,
  t: number,
  patch: Partial<ValueState>,
  tolerance: number,
): EffectsState {
  const keys = effectKeys(effects, id);
  if (keys.length === 0) {
    return patch.v === undefined ? effects : withDialValue(effects, id, patch.v);
  }
  return withKeys(effects, id, withValueEdit(keys, t, patch, tolerance));
}

export function withEffectKeyToggled(
  effects: EffectsState,
  id: KeyedEffectId,
  t: number,
  tolerance: number,
): EffectsState {
  const keys = effectKeys(effects, id);
  const next = withValueKeyToggled(keys, dialAt(effects, id, t), t, tolerance);
  return withoutLastKey(effects, id, keys, next);
}

export function withoutEffectKey(effects: EffectsState, id: KeyedEffectId, index: number): EffectsState {
  const keys = effectKeys(effects, id);
  if (!keys[index]) return effects;
  return withoutLastKey(effects, id, keys, keys.filter((_, i) => i !== index));
}

/** Removing the last keyframe leaves the dial where that keyframe had it. */
function withoutLastKey(
  effects: EffectsState,
  id: KeyedEffectId,
  before: ValueKey[],
  after: ValueKey[],
): EffectsState {
  const next = withKeys(effects, id, after);
  if (after.length > 0 || before.length !== 1) return next;
  return withDialValue(next, id, before[0].v);
}

export function withEffectKeyMoved(
  effects: EffectsState,
  id: KeyedEffectId,
  index: number,
  t: number,
): { effects: EffectsState; index: number } {
  const moved = withValueKeyMoved(effectKeys(effects, id), index, t);
  return { effects: withKeys(effects, id, moved.keys), index: moved.index };
}

/** The line beside a collapsed row, so the tab reads without opening anything. */
export function effectSummary(effects: EffectsState, id: EffectId): string {
  const s = effects.settings;
  if (isKeyed(id) && id !== 'text') {
    const n = effectKeys(effects, id).length;
    if (n > 0) return n === 1 ? '1 keyframe' : `${n} keyframes`;
  }
  switch (id) {
    case 'brightness':
      return signedPercent(s.brightness.amount);
    case 'contrast':
      return signedPercent(s.contrast.amount);
    case 'saturation':
      return signedPercent(s.saturation.amount);
    case 'hue':
      return `${s.hue.degrees > 0 ? '+' : ''}${Math.round(s.hue.degrees)}°`;
    case 'blur':
      return `${oneDecimal(s.blur.sigma)} px`;
    case 'vignette':
      return `${Math.round(s.vignette.amount * 100)}%`;
    case 'redact': {
      const n = s.redact.items.length;
      if (n === 0) return 'none';
      return n === 1 ? REDACT_MODE_LABEL[s.redact.items[0].mode] : `${n} regions`;
    }
    case 'fade':
      return `${oneDecimal(s.fade.inSeconds)}s in · ${oneDecimal(s.fade.outSeconds)}s out`;
    case 'text': {
      const text = s.text.text.trim().replace(/\s+/g, ' ');
      if (text === '') return 'nothing to draw';
      return text.length > 22 ? `${text.slice(0, 21)}…` : text;
    }
  }
}

export const REDACT_MODES: RedactMode[] = ['blur', 'pixelate', 'box'];

export const REDACT_MODE_LABEL: Record<RedactMode, string> = {
  blur: 'Blur',
  pixelate: 'Pixelate',
  box: 'Black box',
};

/** A multiplier read the way a user thinks of it: 1.2 is "+20%". */
function signedPercent(amount: number): string {
  const delta = Math.round((amount - 1) * 100);
  return `${delta > 0 ? '+' : ''}${delta}%`;
}

function oneDecimal(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** The one effect an audio-only export can still apply. */
export function appliesToAudioOnly(id: EffectId): boolean {
  return id === 'fade';
}

/**
 * Only the switched-on effects reach the export; the rest go over as null. An audio-only
 * export sends nothing but the fade - the others would be silently dropped by the filter
 * chain, and a job that asks for what it cannot get is a worse record of the edit.
 */
export function toEffectsJob(effects: EffectsState, audioOnly: boolean): EffectsJob {
  const s = effects.settings;
  const picture = !audioOnly;
  const sends = (id: KeyedEffectId) => picture && hasEffect(effects, id);
  // With keyframes the dial is the first keyframe's value, so the export's static path and
  // its first frame agree.
  const dial = (id: KeyedEffectId) => (sends(id) ? dialAt(effects, id, -Infinity).v : null);
  const { keys: _textKeys, ...overlay } = s.text;
  const text: TextOverlay | null = sends('text')
    ? { ...overlay, text: s.text.text.trim(), opacity: dialAt(effects, 'text', -Infinity).v }
    : null;
  const keys = Object.fromEntries(
    KEYED_IDS.map((id) => [id, sends(id) ? effectKeys(effects, id).map((key) => ({ ...key })) : []]),
  ) as Record<KeyedEffectId, ValueKey[]>;

  return {
    brightness: dial('brightness'),
    contrast: dial('contrast'),
    saturation: dial('saturation'),
    hue: dial('hue'),
    blur: dial('blur'),
    vignette: dial('vignette'),
    // Both halves of one switch, and a zero-length fade is the same as no fade at all.
    fadeIn: effects.on.fade && s.fade.inSeconds > 0 ? s.fade.inSeconds : null,
    fadeOut: effects.on.fade && s.fade.outSeconds > 0 ? s.fade.outSeconds : null,
    text,
    redact: picture && effects.on.redact ? s.redact.items.filter(everShown).map(toRedactJob) : [],
    keys,
  };
}

/**
 * The CSS the <video> wears, in the order the export applies the same filters.
 *
 * `scale` turns the blur's source-pixel sigma into the display pixels the element is actually
 * drawn at: the preview is a scaled-down frame, so an unscaled sigma would show a far heavier
 * blur than the export produces.
 */
export function cssFilterFor(effects: EffectsState, scale: number, t: number): string {
  const parts: string[] = [];
  const at = (id: KeyedEffectId) => dialAt(effects, id, t).v;
  if (activeAt(effects, 'brightness', t)) parts.push(`brightness(${at('brightness')})`);
  if (activeAt(effects, 'contrast', t)) parts.push(`contrast(${at('contrast')})`);
  if (activeAt(effects, 'saturation', t)) parts.push(`saturate(${at('saturation')})`);
  if (activeAt(effects, 'hue', t)) parts.push(`hue-rotate(${at('hue')}deg)`);
  // Not blur(): that one fades the frame's edge into the stage. #fx-blur is the same Gaussian
  // with the opacity put back, and overlay.ts sets its radius from blurPixels() below.
  if (activeAt(effects, 'blur', t) && scale > 0) parts.push('url(#fx-blur)');
  // 'none' rather than an empty string: any filter value at all, even one that changes
  // nothing, keeps the element on the composited path and off the video overlay plane.
  return parts.length > 0 ? parts.join(' ') : 'none';
}

/** The blur radius in display pixels: a sigma is in source pixels, and the preview draws the
 *  frame scaled down, so an unscaled one would show a far heavier blur than the export. */
export function blurPixels(effects: EffectsState, scale: number, t: number): number {
  return activeAt(effects, 'blur', t) ? dialAt(effects, 'blur', t).v * scale : 0;
}

/** '#rrggbb' plus an alpha, the way CSS wants it. Used for the text and its plate. */
export function rgba(hex: string, alpha: number): string {
  const clean = /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#ffffff';
  const r = parseInt(clean.slice(1, 3), 16);
  const g = parseInt(clean.slice(3, 5), 16);
  const b = parseInt(clean.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** One effect's settings, patched. The switches are copied across untouched. */
export function withSetting<K extends EffectId>(
  effects: EffectsState,
  id: K,
  patch: Partial<EffectSettings[K]>,
): EffectsState {
  return {
    on: { ...effects.on },
    settings: { ...effects.settings, [id]: { ...effects.settings[id], ...patch } },
  };
}

export function withSwitch(effects: EffectsState, id: EffectId, on: boolean): EffectsState {
  return { on: { ...effects.on, [id]: on }, settings: { ...effects.settings } };
}
