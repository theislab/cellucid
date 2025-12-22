/**
 * @fileoverview App-layer re-export for shared debug utilities.
 *
 * App code should continue importing from `app/utils/debug.js` to keep imports
 * consistent with the refactoring plan, while lower layers (data/rendering)
 * import from `assets/js/utils/debug.js`.
 *
 * @module utils/debug
 */

export { debug, startTiming } from '../../utils/debug.js';
