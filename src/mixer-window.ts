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
