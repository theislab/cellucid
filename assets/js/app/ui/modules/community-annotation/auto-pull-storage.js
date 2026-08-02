/**
 * @fileoverview Durable storage for the automatic-pull preference.
 *
 * The preference is written by the connection wizard and read by the controls'
 * scheduler. Both go through here so there is exactly one storage key: two
 * copies of the key would split one user's preference into two buckets that
 * silently disagree.
 *
 * Absent `localStorage` is a failure, not an empty preference set — a caller
 * that cannot persist the choice must say so rather than appear to save it.
 *
 * @module ui/modules/community-annotation/auto-pull-storage
 */

import {
  parseAutoPullPreferences,
  serializeAutoPullPreferences,
} from '../../../community-annotations/auto-pull-preferences.js';

export const AUTO_PULL_STORAGE_KEY =
  'cellucid:community-annotations:auto-pull:v1';

export function readAutoPullPreferences() {
  if (typeof localStorage === 'undefined') {
    throw new Error('Auto-pull preferences require localStorage');
  }
  return parseAutoPullPreferences(
    localStorage.getItem(AUTO_PULL_STORAGE_KEY)
  );
}

export function writeAutoPullPreferences(prefs) {
  if (typeof localStorage === 'undefined') {
    throw new Error('Auto-pull preferences require localStorage');
  }
  localStorage.setItem(
    AUTO_PULL_STORAGE_KEY,
    serializeAutoPullPreferences(prefs)
  );
}
