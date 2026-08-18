/**
 * A size readout for picking window minimums by hand. Development only - main.ts loads it
 * behind `import.meta.env.DEV`, so Rollup drops the whole module from a production build.
 *
 * The width it reports is the window's INNER width, which is the same number tauri.conf.json's
 * `minWidth` takes, so whatever it reads when the layout is comfortable can be copied straight
 * into the config.
 */

import { subscribe } from './state';

/** A control row on one line; anything taller has wrapped. */
const ONE_ROW_MAX = 60;

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
  // The row's width depends on what is showing, and that changes with the edit.
  subscribe(draw);
  draw();
}

/**
 * What the control row would need to stay on one line, from its children rather than from a
 * search: the flexible spacer is counted at its minimum, since that is all it is entitled to.
 */
function controlsNeed(controls: HTMLElement): number {
  const style = getComputedStyle(controls);
  const gap = parseFloat(style.columnGap) || 0;
  const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);

  const shown = [...controls.children].filter(
    (el) => !(el as HTMLElement).hidden && getComputedStyle(el).display !== 'none',
  );
  let sum = 0;
  for (const el of shown) {
    sum += el.classList.contains('spacer')
      ? parseFloat(getComputedStyle(el).minWidth) || 0
      : el.getBoundingClientRect().width;
  }
  return Math.ceil(sum + gap * Math.max(shown.length - 1, 0) + padding);
}

function draw(): void {
  if (!readout) return;
  const controls = document.getElementById('controls');
  const rows = controls && controls.offsetHeight > ONE_ROW_MAX ? 2 : 1;
  const need = controls ? controlsNeed(controls) : 0;

  const verdict = rows === 1 ? 'one row' : 'WRAPPED';
  readout.textContent = `${window.innerWidth} x ${window.innerHeight}\ncontrols: ${verdict} (needs ${need})`;
  readout.style.borderColor = rows === 1 ? 'rgba(107,197,210,0.8)' : '#ff6b6b';
}
