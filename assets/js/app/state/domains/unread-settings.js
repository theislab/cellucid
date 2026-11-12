/**
 * @fileoverview Saying the saved settings a restore could not use.
 *
 * A saved record of settings (a session's, a dataset's starting view's, a
 * history step's) is read one setting at a time
 * (`state-serializer/ui-controls.js` `readSavedControls`, the Figure export
 * panel's `readSavedFigureExportSettings`): a value this version of Cellucid
 * cannot use keeps the setting as it is shown and never fails the others. The
 * person is told which, in one short line with each reason under Details.
 *
 * @module app/state/domains/unread-settings
 */

import { getNotificationCenter } from '../../notification-center.js';
import { formatCountOf } from '../../../utils/format-units.js';

/**
 * Tell the person which saved settings were not used. Nothing when none.
 *
 * @param {Array<{label: string, reason: string}>} unread
 */
export function reportUnreadSettings(unread) {
  if (!Array.isArray(unread) || unread.length === 0) return;
  const message = `${formatCountOf(unread.length, 'saved setting')} could not be used and ${unread.length === 1 ? 'stays' : 'stay'} as shown`;
  const details = unread.map(({ label, reason }) => `${label}: ${reason}`).join('\n');
  console.warn(`[session] ${message}\n${details}`);
  getNotificationCenter().warning(message, { category: 'session', details });
}
