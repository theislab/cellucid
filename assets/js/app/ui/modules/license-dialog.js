/**
 * @fileoverview The license dialog (BSD 3-Clause), opened from the sidebar
 * footer's license link: an app dialog (`components/app-dialog.js`).
 *
 * @module ui/modules/license-dialog
 */

import { wireAppDialog } from '../components/app-dialog.js';

/**
 * @param {{ownerDocument?: Document}} [options]
 * @returns {{open: () => void, destroy: () => void}}
 */
export function initLicenseDialog({ ownerDocument = document } = {}) {
  const dialog = ownerDocument.getElementById('license-modal');
  const link = ownerDocument.getElementById('license-link');
  const closeButton = ownerDocument.getElementById('license-close-btn');
  if (dialog === null || link === null || closeButton === null) {
    throw new TypeError('The license dialog requires #license-modal, #license-link and #license-close-btn.');
  }
  const owner = wireAppDialog(dialog);
  const controller = new AbortController();
  link.addEventListener('click', event => {
    event.preventDefault();
    // The link is the opener: a mouse click does not focus a link in every
    // engine, so it is named rather than read from the focused element.
    owner.open(link, { focus: closeButton });
  }, { signal: controller.signal });
  return {
    open() {
      owner.open(link, { focus: closeButton });
    },
    destroy() {
      controller.abort();
      owner.destroy();
    },
  };
}
