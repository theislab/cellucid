/**
 * @fileoverview The one place the app tells a person that volumetric smoke
 * cannot run on their device.
 *
 * Both a direct choice of `Volumetric smoke cloud` and a restored session that
 * stores it end here, so the wording is the same wherever it is met. The
 * headline is plain language from `smoke-capabilities.js`; the missing WebGL
 * capability goes to the console for bug reports, not into the headline.
 *
 * @module app/ui/modules/smoke-availability
 */

import { getNotificationCenter } from '../../notification-center.js';

export const SMOKE_UNAVAILABLE_TITLE = 'Volumetric smoke unavailable';

/**
 * @param {{supported: false, message: string, detail: string}} support
 */
export function reportSmokeUnavailable(support) {
  if (
    support === null
    || typeof support !== 'object'
    || support.supported !== false
    || typeof support.message !== 'string'
    || typeof support.detail !== 'string'
  ) {
    throw new TypeError('Smoke unavailability requires one unsupported capability report.');
  }
  console.info(`[Smoke] Unavailable on this device: ${support.detail}`);
  getNotificationCenter().warning(support.message, {
    category: 'rendering',
    title: SMOKE_UNAVAILABLE_TITLE,
  });
}
