/**
 * @fileoverview What a worker's `error` event says went wrong, in words a
 * notice can carry after "… worker failed: ".
 *
 * An error the worker's own code raised arrives as an `ErrorEvent` with its
 * message. A script that could not be loaded (the network is gone, the
 * server no longer has it, a module of its graph failed) arrives as a plain
 * `Event`, with no message in any engine: it is said so, and that this
 * browser is offline when it is, never as an unknown error. Measured: a
 * spatial-tree worker started after the browser went offline reported
 * "Background spatial index worker failed: unknown error" (Web contracts
 * run 41213981681).
 *
 * Kept apart from `worker-script.js`, which the kept-store and kept-index
 * revision digests guard (`tests/transcode-cache-contract.test.mjs`,
 * `tests/kept-column-index-contract.test.mjs`): wording is not what a kept
 * store holds.
 *
 * @module workers/worker-failure
 */

/**
 * @param {Event|ErrorEvent|null|undefined} event
 * @param {{ navigator?: { onLine?: boolean } }} [scope]
 * @returns {string}
 */
export function workerFailureReason(event, scope = globalThis) {
  const message = typeof event?.message === 'string' ? event.message.trim() : '';
  if (message.length > 0) return message;
  return scope.navigator?.onLine === false
    ? 'its code could not be loaded: this browser is offline'
    : 'its code could not be loaded';
}
