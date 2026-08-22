/**
 * Handing the keyboard back after a click.
 *
 * Every shortcut in this app is a bare key, so a control that keeps focus after being clicked
 * takes the whole keyboard with it: Space presses the zoom button again instead of playing, and
 * the format dropdown reopens instead. The browser focuses a clicked control on purpose, for the
 * case where the next keystroke is meant for it. That case is Tab, not the mouse.
 *
 * So focus is released only when the pointer put it there. Tab to a button and press Enter and
 * focus stays where the user parked it, because a keyboard activation raises no pointer event.
 *
 * Text fields are the exception the whole thing turns on. Clicking a number box is how the user
 * asks to type in it, so those keep focus and shortcuts.ts goes on ignoring keys aimed at them.
 */

/** Inputs that are pressed or dragged rather than typed into. A slider releases, a number box
 *  does not. Colour is left out: blurring it while the native picker is open fights the dialog. */
const PRESSED_INPUTS = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'reset']);

let lastWasPointer = false;

export function initFocusRelease(): void {
  // Capture, so keyboardDriven() is already right by the time a click handler asks.
  document.addEventListener('pointerdown', () => void (lastWasPointer = true), true);
  document.addEventListener('keydown', () => void (lastWasPointer = false), true);

  // pointerup rather than click, because a drag that leaves the control never produces a click
  // and a ramp dot dragged across the lane would otherwise keep focus. Blurring here does not
  // cancel the click: the browser dispatches it to the element whether or not it holds focus.
  document.addEventListener('pointerup', releaseFocus);

  // A dropdown cannot be released on the click that opens it, so the pick is what lets go.
  document.addEventListener('change', (e) => {
    if (!lastWasPointer) return;
    const el = e.target as HTMLElement | null;
    if (el?.tagName === 'SELECT') el.blur();
  });
}

function releaseFocus(): void {
  const el = document.activeElement as HTMLElement | null;
  if (!el?.tagName) return;
  if (el.tagName === 'BUTTON') el.blur();
  else if (el.tagName === 'INPUT' && PRESSED_INPUTS.has((el as HTMLInputElement).type)) el.blur();
}

/** Whether the user got here with the keyboard. A dialog that returns focus to the button that
 *  opened it helps someone on Tab and hijacks the next Space for everyone else. */
export function keyboardDriven(): boolean {
  return !lastWasPointer;
}

/** Give the keyboard back now, for a control that holds focus without a pointer release of its
 *  own. A select dismissed with Escape rather than a pick is the one that reaches this. */
export function releaseNow(el: EventTarget | null): void {
  (el as HTMLElement | null)?.blur?.();
}
