/**
 * A size readout for picking window minimums by hand. Development only - main.ts loads it
 * behind `import.meta.env.DEV`, so Rollup drops the whole module from a production build.
 *
 * The width it reports is the window's INNER width, which is the same number tauri.conf.json's
 * `minWidth` takes, so whatever it reads when the layout is comfortable can be copied straight
 * into the config.
 */

import { subscribe } from './state';
import { appliedMinWidth } from './windowsize';

let readout: HTMLElement | null = null;

export function initSizeReadout(): void {
  readout = document.createElement('div');
  readout.id = 'dev-size';
  Object.assign(readout.style, {
    position: 'fixed',
    top: '8px',
    left: '8px',
    zIndex: '999',
    padding: '6px 10px',
    borderRadius: '8px',
    border: '1px solid rgba(255,255,255,0.25)',
    background: 'rgba(0,0,0,0.78)',
    color: '#fff',
    font: '12px/1.45 Consolas, "Cascadia Mono", monospace',
    whiteSpace: 'pre',
    pointerEvents: 'none',
  });
  document.body.appendChild(readout);

  window.addEventListener('resize', draw);
  // What each group needs depends on what is showing, and that changes with the edit.
  subscribe(draw);
  draw();
}

/** What one group needs on its own line, at the size it is currently showing. */
function groupNeed(group: HTMLElement): number {
  const gap = parseFloat(getComputedStyle(group).columnGap) || 0;
  const shown = [...group.children].filter(
    (el) => !(el as HTMLElement).hidden && getComputedStyle(el).display !== 'none',
  );
  const sum = shown.reduce((total, el) => total + el.getBoundingClientRect().width, 0);
  return Math.ceil(sum + gap * Math.max(shown.length - 1, 0));
}

function draw(): void {
  if (!readout) return;
  const controls = document.getElementById('controls');
  if (!controls) return;

  const groups = [...controls.querySelectorAll<HTMLElement>('.control-group')];
  const padding =
    parseFloat(getComputedStyle(controls).paddingLeft) +
    parseFloat(getComputedStyle(controls).paddingRight);

  // Two lines is a designed state, not a fault, so the readout counts them rather than judging
  // them. Compared by offsetTop: a group on the second line sits lower than the one before it.
  const tops = new Set(groups.map((group) => group.offsetTop));
  const lines = Math.max(tops.size, 1);

  const needs = groups.map((group) => groupNeed(group) + padding);
  const onOneLine = Math.ceil(controls.scrollWidth);

  readout.textContent =
    `${window.innerWidth} x ${window.innerHeight}\n` +
    `controls: ${lines} line${lines === 1 ? '' : 's'}\n` +
    `groups need: ${needs.join(' / ')}\n` +
    `one line at: ${onOneLine}\n` +
    `min applied: ${appliedMinWidth() || 'pending'}`;
  // Amber while the groups are stacked, so the two states are told apart at a glance.
  readout.style.borderColor = lines === 1 ? 'rgba(107,197,210,0.8)' : 'rgba(240,180,90,0.9)';
}
