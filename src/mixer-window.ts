import { growWindowForMixer, shrinkWindowAfterMixer } from './ipc';


export interface MixerWindowResize {
  open(addedCssHeight: number): Promise<void>;
  close(): Promise<void>;
}

export function initMixerWindowResize(): MixerWindowResize | null {
  if (!('__TAURI_INTERNALS__' in window)) return null;

  let resize: Awaited<ReturnType<typeof growWindowForMixer>> | null = null;
  let revision = 0;

  return {
    async open(addedCssHeight: number): Promise<void> {
      if (resize !== null || addedCssHeight <= 0) return;
      const request = ++revision;
      const result = await growWindowForMixer(addedCssHeight);
      if (request !== revision) {
        if (result.addedHeight > 0) {
          await shrinkWindowAfterMixer(result.addedHeight, result.originalY, result.openedY);
        }
        return;
      }
      resize = result;
    },

    async close(): Promise<void> {
      revision += 1;
      const current = resize;
      resize = null;
      if (current?.addedHeight) {
        await shrinkWindowAfterMixer(current.addedHeight, current.originalY, current.openedY);
      }
    },
  };
}

/** Every caller holding the video area, and its own styles from before the first of them. The
 *  mixer and the keyframe lane can both resize at once, and a second pin of its own would
 *  record the first one's styles as the originals and put them back for good. */
let pins = 0;
let unpinned: { flex: string; height: string } | null = null;

/** Holds the video area at its current height while the window grows or shrinks around a
 *  change below it, so the picture does not jump. Returns the release; the area is let go
 *  when the last holder releases. */
export function pinWorkspace(): () => void {
  const workspace = document.getElementById('workspace');
  if (!workspace) return () => {};
  if (pins === 0) {
    unpinned = { flex: workspace.style.flex, height: workspace.style.height };
    const pixelHeight = workspace.getBoundingClientRect().height;
    workspace.style.flex = `0 0 ${pixelHeight}px`;
    workspace.style.height = `${pixelHeight}px`;
  }
  pins += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pins -= 1;
    if (pins === 0 && unpinned) {
      workspace.style.flex = unpinned.flex;
      workspace.style.height = unpinned.height;
      unpinned = null;
    }
  };
}

export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * The window grown and shrunk to follow a strip whose height changes in steps, such as the
 * keyframe lane gaining a row, so the video keeps its size. The first growth remembers where
 * the window was, and shrinking back to nothing puts it there again.
 */
export function initStripWindowResize(): ((height: number) => void) | null {
  if (!('__TAURI_INTERNALS__' in window)) return null;
  let cssHeight = 0;
  let physical = 0;
  let originalY: number | null = null;
  let openedY: number | null = null;
  let queue = Promise.resolve();
  // One pin for every request still queued: a second pin would record the first one's styles
  // as the originals and put them back for good.
  let release: (() => void) | null = null;
  let pending = 0;

  return (height: number) => {
    const target = Math.max(0, Math.round(height));
    if (target === cssHeight) return;
    const from = cssHeight;
    cssHeight = target;
    release ??= pinWorkspace();
    pending += 1;
    queue = queue
      .then(async () => {
        if (target > from) {
          const grown = await growWindowForMixer(target - from);
          if (from === 0) {
            originalY = grown.originalY;
            openedY = grown.openedY;
          }
          physical += grown.addedHeight;
        } else if (physical > 0) {
          const amount = target === 0 ? physical : Math.round((physical * (from - target)) / from);
          await shrinkWindowAfterMixer(amount, target === 0 ? originalY : null, target === 0 ? openedY : null);
          physical -= amount;
        }
        await nextFrame();
      })
      .catch(() => {
        /* the window keeps its size, and the lane takes its height from the video instead */
      })
      .finally(() => {
        pending -= 1;
        if (pending === 0) {
          release?.();
          release = null;
        }
      });
  };
}
