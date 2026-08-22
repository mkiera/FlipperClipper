/**
 * What the effects look like on the preview.
 *
 * Three of them cannot be expressed as a CSS filter on the <video>, so they are drawn as
 * layers over it, stacked in the order the export applies them: vignette, then text, then the
 * fade shade over both. Each layer is positioned on the region the export would actually
 * contain, which is the crop rectangle when there is one - drawtext and vignette run after the
 * crop filter, so text pinned to "bottom left" belongs at the bottom left of the crop.
 *
 * A CSS filter or an overlay drops the video off the GPU's overlay plane onto the compositor's
 * own colour conversion, which shifts the picture slightly. That is unavoidable here and the
 * reason nothing is drawn, and no filter is set, while every effect is switched off.
 */

import { frameGeometry } from './crop';
import { blurPixels, cssFilterFor, hasEffect, rgba } from './effects';
import { currentTime, onTime, videoElement } from './player';
import { edit, subscribe } from './state';
import { outputDuration } from './types';

/** The margin drawtext leaves, as a fraction of frame height. Kept in step with ffmpeg.rs. */
const TEXT_MARGIN = 0.04;

/** The plate's border width around the text, as a fraction of frame height. */
const TEXT_PAD = 0.012;

/** Arial, because ffmpeg is handed arial.ttf: the two rasterise differently but they are at
 *  least the same typeface at the same nominal size. */
const TEXT_FONT = 'Arial, sans-serif';

let layer!: HTMLElement;
/** The layer's offset parent. Measuring against the layer itself would be circular: its own
 *  left is what the measurement sets, so every render after the first would drift by it. */
let stage!: HTMLElement;
let vignette!: HTMLElement;
let textLayer!: HTMLElement;
let textSpan!: HTMLElement;
let fadeShade!: HTMLElement;
let blurAmount!: SVGFEGaussianBlurElement;

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`FlipperClipper: index.html is missing #${id}`);
  return found as T;
}

export function initOverlay(): void {
  layer = el('fx-overlay');
  const host = layer.parentElement;
  if (!host) throw new Error('FlipperClipper: #fx-overlay has no stage to sit in');
  stage = host;
  vignette = el('fx-vignette');
  textLayer = el('fx-text');
  textSpan = el('fx-text-span');
  fadeShade = el('fx-fade');
  blurAmount = el<HTMLElement>('fx-blur-amount') as unknown as SVGFEGaussianBlurElement;

  const video = videoElement();
  new ResizeObserver(render).observe(video);
  // Before metadata arrives the element reports no dimensions, so the geometry is wrong.
  video.addEventListener('loadedmetadata', render);

  subscribe(render);
  // Per presented frame, so the fade tracks the playhead without re-laying out the rest.
  onTime(renderFade);
  render();
}

export function render(): void {
  const video = videoElement();
  const effects = edit.effects;

  applyTurn(video);

  const geometry = edit.media ? frameGeometry(stage) : null;
  const scale = geometry?.scale ?? 1;
  // Set before the filter is applied, so the first blurred frame is drawn at the right radius.
  blurAmount.setAttribute('stdDeviation', blurPixels(effects, scale).toFixed(2));
  const filter = cssFilterFor(effects, scale);
  if (video.style.filter !== filter) video.style.filter = filter;

  const drawsText = hasEffect(effects, 'text');
  const drawsVignette = hasEffect(effects, 'vignette');
  const drawsFade = hasEffect(effects, 'fade');

  layer.hidden = !geometry || !(drawsText || drawsVignette || drawsFade);
  if (!geometry || layer.hidden) return;

  Object.assign(layer.style, {
    left: `${geometry.left}px`,
    top: `${geometry.top}px`,
    width: `${geometry.width}px`,
    height: `${geometry.height}px`,
  });

  vignette.hidden = !drawsVignette;
  if (drawsVignette) {
    const strength = effects.settings.vignette.amount;
    // An approximation of ffmpeg's lens falloff, which is a cosine law rather than a gradient
    // stop. Close enough to place the effect; the exported file is the real answer.
    vignette.style.background = `radial-gradient(ellipse at center, rgba(0,0,0,0) 35%, rgba(0,0,0,${(
      strength * 0.95
    ).toFixed(2)}) 100%)`;
  }

  textLayer.hidden = !drawsText;
  if (drawsText) renderText(geometry.height);

  fadeShade.hidden = !drawsFade;
  renderFade();
}

/**
 * The turn, as a CSS transform on the <video>.
 *
 * A quarter turn needs the element sized to the stage's OTHER way round before it is rotated,
 * or the transform spins a stage-shaped box and the picture inside it hangs off the top and
 * bottom. Sized H by W and turned, it lands back on exactly W by H.
 *
 * crop.ts does not read this. It works the picture out from the stage and the turned aspect,
 * because a transformed element's own rect is the box after the transform and says nothing
 * about where the picture inside it went.
 */
function applyTurn(video: HTMLVideoElement): void {
  const { rotate, flipH, flipV } = edit.orientation;
  const turned = rotate === 90 || rotate === 270;

  if (!turned) {
    video.style.removeProperty('width');
    video.style.removeProperty('height');
    video.style.removeProperty('left');
    video.style.removeProperty('top');
    video.style.removeProperty('position');
  } else {
    const box = stage.getBoundingClientRect();
    Object.assign(video.style, {
      position: 'absolute',
      width: `${box.height}px`,
      height: `${box.width}px`,
      left: `${(box.width - box.height) / 2}px`,
      top: `${(box.height - box.width) / 2}px`,
    });
  }

  const parts: string[] = [];
  if (rotate !== 0) parts.push(`rotate(${rotate}deg)`);
  // After the rotate in the transform list, which applies it in the turned frame - the same
  // order hflip and vflip sit in after transpose in the export chain.
  if (flipH) parts.push('scaleX(-1)');
  if (flipV) parts.push('scaleY(-1)');
  const transform = parts.length > 0 ? parts.join(' ') : '';
  if (video.style.transform !== transform) video.style.transform = transform;
}

function renderText(frameHeight: number): void {
  const text = edit.effects.settings.text;

  Object.assign(textLayer.style, {
    justifyContent: text.anchorX === 'left' ? 'flex-start' : text.anchorX === 'right' ? 'flex-end' : 'center',
    alignItems: text.anchorY === 'top' ? 'flex-start' : text.anchorY === 'bottom' ? 'flex-end' : 'center',
    padding: `${frameHeight * TEXT_MARGIN}px`,
  });

  textSpan.textContent = text.text;
  Object.assign(textSpan.style, {
    fontFamily: TEXT_FONT,
    fontSize: `${frameHeight * text.size}px`,
    color: rgba(text.color, text.opacity),
    background: text.boxed ? 'rgba(0, 0, 0, 0.45)' : 'transparent',
    padding: text.boxed ? `${frameHeight * TEXT_PAD}px` : '0',
  });
}

/**
 * The fade is the one effect that changes with the playhead, so it is redrawn per presented
 * frame rather than per state change. Everything is in output time - the timeline the finished
 * clip has, after the trim and the speed change - because that is what ffmpeg's fade sees.
 */
function renderFade(): void {
  if (fadeShade.hidden) return;

  const { inSeconds, outSeconds } = edit.effects.settings.fade;
  const total = outputDuration(edit);
  if (total <= 0) {
    fadeShade.style.opacity = '0';
    return;
  }

  // A reversed clip plays from the out point back, so its output position counts the other way.
  const t = currentTime();
  const raw = edit.reverse ? edit.outPoint - t : t - edit.inPoint;
  const position = Math.min(Math.max(raw / edit.speed, 0), total);

  let visible = 1;
  if (inSeconds > 0 && position < inSeconds) visible = Math.min(visible, position / inSeconds);
  if (outSeconds > 0 && position > total - outSeconds) {
    visible = Math.min(visible, (total - position) / outSeconds);
  }

  fadeShade.style.opacity = String(1 - Math.min(Math.max(visible, 0), 1));
}
