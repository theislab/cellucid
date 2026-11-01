/**
 * @fileoverview Removing a highlight page or group is undoable: the removal
 * happens at once (no confirmation in the way) and a notification offers
 * Undo while it shows, putting back the very page or group -- its cell
 * lists, its place, its id, so analyses naming it find it again.
 *
 * One helper for both removals (`highlight-pages-ui.js`,
 * `highlight-summary-ui.js`).
 *
 * @module ui/modules/highlight/undo-removal
 */

import { getNotificationCenter } from '../../../notification-center.js';

/** How long the Undo stays offered. */
const UNDO_OFFERED_MS = 8000;

/**
 * Remove something and offer to put it back.
 *
 * @param {Object} options
 * @param {Object|null} options.record - What the removal takes away (the state's
 *   `highlightPageRecord` / `highlightGroupRecord`), taken just before it
 * @param {() => boolean} options.remove - The removal; false when nothing was removed
 * @param {(record: Object) => boolean} options.restore - Put `record` back; false when it no longer can
 * @param {string} options.removed - What was removed, as the notification says it
 * @returns {boolean} Whether it was removed
 */
export function removeWithUndo({ record, remove, restore, removed }) {
  if (record === null || !remove()) return false;
  const notifications = getNotificationCenter();
  notifications.show({
    type: 'info',
    category: 'highlight',
    message: `${removed} removed.`,
    duration: UNDO_OFFERED_MS,
    action: {
      label: 'Undo',
      run: () => {
        if (!restore(record)) {
          notifications.warning(`${removed} could not be put back: the open cells or the pages changed since.`, { category: 'highlight' });
        }
      }
    }
  });
  return true;
}
