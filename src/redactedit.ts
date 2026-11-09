/**
 * The redaction being edited, and the one way every view changes a redaction, so the panel,
 * the boxes on the picture and the timeline lane cannot drift apart.
 */

import { withSetting } from './effects';
import { currentTime } from './player';
import { REDACT_MAX_ITEMS, newRedaction } from './redact';
import { edit, patchEdit, patchUi, ui } from './state';
import type { RedactItem } from './types';

export function redactItems(): RedactItem[] {
  return edit.effects.settings.redact.items;
}

/** The selected redaction, falling back to the first when the selection is gone. */
export function selectedRedaction(): RedactItem | null {
  const items = redactItems();
  return items.find((item) => item.id === ui.redactSelected) ?? items[0] ?? null;
}

export function selectRedaction(id: number): void {
  if (ui.redactSelected !== id) patchUi({ redactSelected: id });
}

/** Half a frame: a keyframe this close to the playhead is the one at the playhead. */
export function keyTolerance(): number {
  const fps = edit.media?.fps ?? 0;
  return fps > 0 ? 0.5 / fps : 1 / 60;
}

export function playheadTime(): number {
  return currentTime();
}

export function updateRedaction(id: number, change: (item: RedactItem) => RedactItem): void {
  const items = redactItems().map((item) => (item.id === id ? change(item) : item));
  patchEdit({ effects: withSetting(edit.effects, 'redact', { items }) });
}

export function addRedaction(): void {
  const items = redactItems();
  if (items.length >= REDACT_MAX_ITEMS) return;
  const item = newRedaction(items);
  patchEdit({ effects: withSetting(edit.effects, 'redact', { items: [...items, item] }) });
  patchUi({ redactSelected: item.id });
}

export function removeRedaction(id: number): void {
  const items = redactItems().filter((item) => item.id !== id);
  patchEdit({ effects: withSetting(edit.effects, 'redact', { items }) });
  if (items.length > 0 && ui.redactSelected === id) patchUi({ redactSelected: items[0].id });
}
