/**
 * The window's smallest usable size, worked out from the control row instead of written down.
 *
 * A number in tauri.conf.json is right only until the next button lands in the row, and the
 * row is the one part of the layout that cannot shrink - everything else just gets smaller.
 *
 * The row is two groups either side of the spacer, and it is built to break between them, so
 * the minimum is the wider GROUP rather than the pair. A window narrower than the pair drops
 * output and export onto a second line, which is a layout the app is meant to have; one
 * narrower than a single group would squeeze controls into each other, which it is not.
 *
 * What the row needs is the floor, not the answer. WANTED is the minimum the app asks for,
 * chosen for how much picture is left above the row rather than for whether the row fits.
 * The measurement stops that choice going too low as controls are added.
 *
 * Both are clamped to the display: a window wider than the monitor is worse than a wrap, so
 * a screen with no room for WANTED gets what it can take, down to what the row needs.
 */

import { setMinWindowSize } from './ipc';

/** The stage takes whatever is left, so this is only the control row, the timeline and enough
 *  picture to be worth looking at. */
const MIN_HEIGHT = 520;

/** Left clear at the sides, for the window frame and a margin of politeness. */
const SCREEN_MARGIN = 64;

/** The minimum the app asks for where the screen has room. The row fits in about 900, so this
 *  is a comfort call: below it the stage is too small to judge an edit in. */
const WANTED = 1100;

/** Below this the app is unusable whatever the row says, and it catches a measurement that
 *  found no groups to measure. */
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

  const style = getComputedStyle(controls);
  const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const needed = Math.max(widestControlGroup(controls) + padding + MARGIN, FLOOR);
  const room = window.screen.availWidth - SCREEN_MARGIN;
  // WANTED where the screen allows it, and never under what the row measured either way.
  applied = Math.max(Math.min(Math.max(needed, WANTED), room), needed);

  try {
    await setMinWindowSize(applied, MIN_HEIGHT);
  } catch {
    /* the window keeps whatever tauri.conf.json gave it */
  }
}

/**
 * The widest group can be at its widest: every optional control showing, the size estimate at
 * its longest, and an export running - the progress bar is wider than the button it replaces.
 *
 * Everything is put back before returning. None of it is ever seen: the browser paints at the
 * end of a task, and this whole function is one synchronous run.
 */
function widestControlGroup(controls: HTMLElement): number {
  const groups = [...controls.querySelectorAll<HTMLElement>('.control-group')];
  if (groups.length === 0) return 0;

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

  // At its natural size, so nothing is squeezed: a group narrow enough to shrink its children
  // would report less than it needs and the minimum would come out too small.
  for (const group of groups) {
    const was = group.style.width;
    group.style.width = 'max-content';
    undo.push(() => {
      group.style.width = was;
    });
  }

  for (const id of SOMETIMES_HIDDEN) reveal(id);
  write('effects-badge', '8');
  write('size-estimate', 'about 10000 MB');
  conceal('export-btn');
  reveal('export-running');

  // The two are mutually exclusive - a size target works out its own bitrate - so the widest
  // is whichever of them is wider, never the pair.
  conceal('bitrate-kbps');
  reveal('fit-mb');
  const withTarget = widestLane(controls, groups);

  conceal('fit-mb');
  reveal('bitrate-kbps');
  const withBitrate = widestLane(controls, groups);

  for (const step of undo.reverse()) step();
  return Math.ceil(Math.max(withTarget, withBitrate));
}

/**
 * The widest line any one group would make. A group ahead of the spacer shares its line with
 * it, and the spacer is entitled to its min-width, so that group's line costs a little more
 * than the group itself.
 */
function widestLane(controls: HTMLElement, groups: HTMLElement[]): number {
  const kids = [...controls.children];
  const spacer = controls.querySelector<HTMLElement>('.spacer');
  const spacerAt = spacer ? kids.indexOf(spacer) : -1;
  const toll = spacer
    ? (parseFloat(getComputedStyle(controls).columnGap) || 0) +
      (parseFloat(getComputedStyle(spacer).minWidth) || 0)
    : 0;

  return Math.max(
    ...groups.map((group) => {
      const shares = spacerAt > kids.indexOf(group);
      return group.getBoundingClientRect().width + (shares ? toll : 0);
    }),
  );
}
