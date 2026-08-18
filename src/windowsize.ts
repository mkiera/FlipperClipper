/**
 * The window's smallest usable size, worked out from the control row instead of written down.
 *
 * A number in tauri.conf.json is right only until the next button lands in the row, and the
 * row is the one part of the layout that cannot shrink - everything else just gets smaller.
 * So the row is measured at its widest and the window is told never to go below it.
 *
 * The measurement is clamped to the display: on a screen too narrow to hold the row there is
 * no minimum that helps, and a window wider than the monitor is worse than a wrapped row.
 */

import { setMinWindowSize } from './ipc';

/** The stage takes whatever is left, so this is only the control row, the timeline and enough
 *  picture to be worth looking at. */
const MIN_HEIGHT = 520;

/** Left clear at the sides, for the window frame and a margin of politeness. */
const SCREEN_MARGIN = 64;

/** Below this the app is unusable whatever the row says. */
const FLOOR = 640;

/** Slack on the measurement. The format dropdown is sized by its longest option, and the audio
 *  list is not quite the width of the video one, so the row has a few pixels of play in it
 *  depending on when the measurement runs. Measured at 6px; this covers it and rounding. */
const MARGIN = 12;

/** Every control that is hidden in some states but has to be counted anyway. */
const SOMETIMES_HIDDEN = [
  'mute-btn',
  'normalize-btn',
  'volume-group',
  'res-select',
  'bitrate-mode',
  'effects-badge',
  'size-estimate',
];

let applied = 0;

/** What was asked for, for the dev readout to show. Zero until it has run. */
export function appliedMinWidth(): number {
  return applied;
}

export async function applyMinWindowSize(): Promise<void> {
  // Every width here is a text measurement, and Outfit is a local file that still arrives
  // asynchronously - measuring before it lands sizes the row in the fallback font.
  try {
    await document.fonts.ready;
  } catch {
    /* an older engine still measures, just possibly a moment early */
  }

  const controls = document.getElementById('controls');
  if (!controls) return;

  const needed = widestControlRow(controls) + MARGIN;
  const room = Math.max(window.screen.availWidth - SCREEN_MARGIN, FLOOR);
  applied = Math.max(Math.min(needed, room), FLOOR);

  try {
    await setMinWindowSize(applied, MIN_HEIGHT);
  } catch {
    /* the window keeps whatever tauri.conf.json gave it */
  }
}

/**
 * The row at its widest: every optional control showing, the size estimate at its longest,
 * and an export running - the progress bar is wider than the button it replaces.
 *
 * Everything is put back before returning. None of it is ever seen: the browser paints at the
 * end of a task, and this whole function is one synchronous run.
 */
function widestControlRow(controls: HTMLElement): number {
  const undo: (() => void)[] = [];

  const reveal = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    const was = el.hidden;
    el.hidden = false;
    undo.push(() => {
      el.hidden = was;
    });
  };
  const conceal = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    const was = el.hidden;
    el.hidden = true;
    undo.push(() => {
      el.hidden = was;
    });
  };
  const write = (id: string, value: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    const was = el.textContent;
    el.textContent = value;
    undo.push(() => {
      el.textContent = was;
    });
  };

  // Laid out on one line at its natural size, so nothing is squeezed by wrapping: a shrunken
  // control would report less than it needs and the minimum would come out too small.
  const wrap = controls.style.flexWrap;
  const width = controls.style.width;
  controls.style.flexWrap = 'nowrap';
  controls.style.width = 'max-content';
  undo.push(() => {
    controls.style.flexWrap = wrap;
    controls.style.width = width;
  });

  for (const id of SOMETIMES_HIDDEN) reveal(id);
  write('effects-badge', '8');
  write('size-estimate', 'about 10000 MB');
  conceal('export-btn');
  reveal('export-running');

  // The two are mutually exclusive - a size target works out its own bitrate - so the widest
  // is whichever of them is wider, never the pair.
  conceal('bitrate-kbps');
  reveal('fit-mb');
  const withTarget = controls.getBoundingClientRect().width;

  conceal('fit-mb');
  reveal('bitrate-kbps');
  const withBitrate = controls.getBoundingClientRect().width;

  for (const step of undo.reverse()) step();
  return Math.ceil(Math.max(withTarget, withBitrate));
}
