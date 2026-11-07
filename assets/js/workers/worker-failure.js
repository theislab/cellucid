/**
 * @fileoverview What a worker's `error` event says went wrong, in words a
 * notice can carry after "… worker failed: ".
 *
 * An error the worker's own code raised arrives as an `ErrorEvent` with its
 * message. A script that could not be loaded (the network is gone, the
 * server no longer has it, a module of its graph failed, the browser could
 * not start one more thread) arrives as a plain `Event`, with no message in
 * any engine: it is said so, and that this browser is offline when it is,
 * never as an unknown error. Measured: a spatial-tree worker started after
 * the browser went offline reported "Background spatial index worker
 * failed: unknown error" (Web contracts run 41213981681).
 *
 * The browser says no more than that, so `explainWorkerFailure` asks for
 * the worker's script itself, as the worker did, and names what it gets: no
 * answer and why, the server's status (a page that outlived its deploy asks
 * for a bundle the server no longer has: 404), a type that is not a script,
 * or the script served as it should be, which leaves a module it imports
 * (a worker started from its sources, `worker-script.js`) or the browser's
 * refusal to start another thread. Measured: a reader worker of a dataset
 * opened in a Chromium browser-test run said only "The AnnData reader could
 * not start (its code could not be loaded)", the run's trace gone with its
 * worktree, and nothing told which of those it was (audit of 2026-11-07,
 * `figure-export.spec.mjs`, 1 run in 750).
 *
 * Kept apart from `worker-script.js`, which the kept-store and kept-index
 * revision digests guard (`tests/transcode-cache-contract.test.mjs`,
 * `tests/kept-column-index-contract.test.mjs`): wording is not what a kept
 * store holds. So the address a worker was started from is noted here, by
 * whoever starts it (`noteWorkerScript`).
 *
 * @module workers/worker-failure
 */

/** The address each worker was started from (`noteWorkerScript`). @type {WeakMap<object, URL>} */
const scripts = new WeakMap();

/**
 * @param {Event|ErrorEvent|null|undefined} event
 * @returns {string} what the event itself says, trimmed; empty when nothing
 */
function eventMessage(event) {
  return typeof event?.message === 'string' ? event.message.trim() : '';
}

/**
 * @param {Event|ErrorEvent|null|undefined} event
 * @param {{ navigator?: { onLine?: boolean } }} [scope]
 * @returns {string}
 */
export function workerFailureReason(event, scope = globalThis) {
  const message = eventMessage(event);
  if (message.length > 0) return message;
  return scope.navigator?.onLine === false
    ? 'its code could not be loaded: this browser is offline'
    : 'its code could not be loaded';
}

/**
 * Note the address `worker` was started from, for `explainWorkerFailure`.
 *
 * @template {object} W
 * @param {W} worker
 * @param {URL|string} script
 * @returns {W} the worker
 */
export function noteWorkerScript(worker, script) {
  scripts.set(worker, new URL(script));
  return worker;
}

/**
 * Why `worker` failed, as `workerFailureReason` says it, and, when the
 * browser said nothing (its code could not be loaded), what asking for its
 * script again finds. A worker whose address was not noted, or a browser
 * that is offline, is said as `workerFailureReason` says it.
 *
 * @param {object|null} worker
 * @param {Event|ErrorEvent|null|undefined} event
 * @param {{ navigator?: { onLine?: boolean }, fetch?: typeof fetch }} [scope]
 * @returns {Promise<string>}
 */
export async function explainWorkerFailure(worker, event, scope = globalThis) {
  const said = workerFailureReason(event, scope);
  const script = worker === null || worker === undefined ? undefined : scripts.get(worker);
  if (eventMessage(event).length > 0 || scope.navigator?.onLine === false) return said;
  if (script === undefined || typeof scope.fetch !== 'function') return said;
  // Only a script a server answers for can be asked for again (not a
  // module file of Node's tests, a blob or a data address).
  if (script.protocol !== 'http:' && script.protocol !== 'https:') return said;
  // The fragment carries what the worker was handed (`worker-script.js`); no
  // request carries it.
  const address = new URL(script);
  address.hash = '';
  const name = address.pathname;
  let response;
  try {
    response = await scope.fetch(address.href, { cache: 'no-store', credentials: 'same-origin' });
  } catch (error) {
    const why = typeof error?.message === 'string' && error.message.trim() !== '' ? error.message.trim() : String(error);
    return `${said}: ${name} could not be fetched (${why})`;
  }
  // Only the answer's head is read.
  response.body?.cancel?.().catch?.(() => {});
  if (!response.ok) return `${said}: the server answered ${response.status} for ${name}`;
  const type = response.headers?.get?.('content-type') ?? '';
  if (!/\b(?:java|ecma)script\b/i.test(type)) {
    return `${said}: ${name} is served as ${type === '' ? 'no type' : type}, not as a script`;
  }
  return `${said}, though ${name} is served: a module it imports did not load, or this browser could not start another worker`;
}
