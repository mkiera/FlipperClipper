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

import type { EffectId, EffectSettings, EffectsJob, EffectsState, TextOverlay } from './types';

/** Display order in the tab: the colour dials, then the two that reshape the frame, then the
 *  two that add something to it. */
export const EFFECT_IDS: EffectId[] = [
  'brightness',
  'contrast',
  'saturation',
  'hue',
  'blur',
  'vignette',
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
  text: 'Drawn at the export size, over the cropped frame.',
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
      text: false,
      fade: false,
    },
    settings: {
      brightness: { amount: 1.2 },
      contrast: { amount: 1.25 },
      saturation: { amount: 1.3 },
      hue: { degrees: 30 },
      blur: { sigma: 8 },
      vignette: { amount: 0.5 },
      text: {
        text: 'Your text',
        size: 0.07,
        color: '#ffffff',
        opacity: 1,
        anchorX: 'center',
        anchorY: 'bottom',
        boxed: true,
      },
      fade: { inSeconds: 0.5, outSeconds: 0.5 },
    },
  };
}

export function enabledIds(effects: EffectsState): EffectId[] {
  return EFFECT_IDS.filter((id) => effects.on[id]);
}

/** Text is the one effect that can be switched on and still have nothing to draw. */
export function hasEffect(effects: EffectsState, id: EffectId): boolean {
  if (!effects.on[id]) return false;
  if (id === 'text') return effects.settings.text.text.trim() !== '';
  return true;
}

/** The line beside a collapsed row, so the tab reads without opening anything. */
export function effectSummary(effects: EffectsState, id: EffectId): string {
  const s = effects.settings;
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
    case 'fade':
      return `${oneDecimal(s.fade.inSeconds)}s in · ${oneDecimal(s.fade.outSeconds)}s out`;
    case 'text': {
      const text = s.text.text.trim().replace(/\s+/g, ' ');
      if (text === '') return 'nothing to draw';
      return text.length > 22 ? `${text.slice(0, 21)}…` : text;
    }
  }
}

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
  const text: TextOverlay | null =
    picture && hasEffect(effects, 'text') ? { ...s.text, text: s.text.text.trim() } : null;

  return {
    brightness: picture && effects.on.brightness ? s.brightness.amount : null,
    contrast: picture && effects.on.contrast ? s.contrast.amount : null,
    saturation: picture && effects.on.saturation ? s.saturation.amount : null,
    hue: picture && effects.on.hue ? s.hue.degrees : null,
    blur: picture && effects.on.blur ? s.blur.sigma : null,
    vignette: picture && effects.on.vignette ? s.vignette.amount : null,
    // Both halves of one switch, and a zero-length fade is the same as no fade at all.
    fadeIn: effects.on.fade && s.fade.inSeconds > 0 ? s.fade.inSeconds : null,
    fadeOut: effects.on.fade && s.fade.outSeconds > 0 ? s.fade.outSeconds : null,
    text,
  };
}

/**
 * The CSS the <video> wears, in the order the export applies the same filters.
 *
 * `scale` turns the blur's source-pixel sigma into the display pixels the element is actually
 * drawn at: the preview is a scaled-down frame, so an unscaled sigma would show a far heavier
 * blur than the export produces.
 */
export function cssFilterFor(effects: EffectsState, scale: number): string {
  const s = effects.settings;
  const parts: string[] = [];
  if (effects.on.brightness) parts.push(`brightness(${s.brightness.amount})`);
  if (effects.on.contrast) parts.push(`contrast(${s.contrast.amount})`);
  if (effects.on.saturation) parts.push(`saturate(${s.saturation.amount})`);
  if (effects.on.hue) parts.push(`hue-rotate(${s.hue.degrees}deg)`);
  // Not blur(): that one fades the frame's edge into the stage. #fx-blur is the same Gaussian
  // with the opacity put back, and overlay.ts sets its radius from blurPixels() below.
  if (effects.on.blur && scale > 0) parts.push('url(#fx-blur)');
  // 'none' rather than an empty string: any filter value at all, even one that changes
  // nothing, keeps the element on the composited path and off the video overlay plane.
  return parts.length > 0 ? parts.join(' ') : 'none';
}

/** The blur radius in display pixels: a sigma is in source pixels, and the preview draws the
 *  frame scaled down, so an unscaled one would show a far heavier blur than the export. */
export function blurPixels(effects: EffectsState, scale: number): number {
  return effects.on.blur ? effects.settings.blur.sigma * scale : 0;
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
