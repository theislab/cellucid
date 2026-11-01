/**
 * @fileoverview Whether this tab left the phone panel open or as its peek bar
 * (`ui/modules/sidebar-controls.js`), for the next load of the tab, which
 * `ui/core/viewport-init.js` reads before the stylesheet applies. Kept in
 * session storage (per tab), never in the address.
 *
 * @module ui/core/phone-sheet-memory
 */

/** The session-storage key `viewport-init.js` reads. */
const PHONE_SHEET_KEY = 'cellucid:phone-sheet';

/**
 * Remember the phone panel's state; a browser that keeps nothing for the tab
 * starts with the peek bar.
 *
 * @param {Window} ownerWindow
 * @param {'open'|'peek'} state
 */
export function rememberPhoneSheet(ownerWindow, state) {
  try {
    ownerWindow.sessionStorage.setItem(PHONE_SHEET_KEY, state);
  } catch {
    // Nothing is kept: the next load starts with the peek bar.
  }
}
