/**
 * @fileoverview Session entry point: the page's session files
 * (`session-serializer.js`, format 4 `history-file.js`).
 *
 * @module session
 */

import { SessionSerializer } from './session-serializer.js';

export { SAVE_DEFAULTS, SHARE_DEFAULTS, STATE_DEFAULTS } from './share-scope.js';

/**
 * Create the page's session files owner.
 *
 * @param {{
 *   state: import('../state/core/data-state.js').DataState,
 *   dataSourceManager: object|null,
 *   getHistory: () => (object|null),
 *   dispatcher: {idle: () => Promise<void>},
 * }} options
 * @returns {SessionSerializer}
 */
export function createSessionSerializer(options) {
  return new SessionSerializer(options);
}
