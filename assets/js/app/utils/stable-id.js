/**
 * @fileoverview The one rule for a DOM id kept in a session: a page's control
 * ids, and the pressed-button groups and buttons of its page chrome
 * (`session/history-file.js` `assertPageChrome` reads them from a file,
 * `state-serializer/ui-controls.js` puts them back), so a file the reader
 * accepts never names an id the page then refuses.
 *
 * @module app/utils/stable-id
 */

/** Whether `id` is a stable DOM id: a nonempty string with no white space around it. */
export function isStableId(id) {
  return typeof id === 'string' && id.length > 0 && id === id.trim();
}
