/**
 * @fileoverview Where a worker's script comes from, and who hears when one
 * does not start.
 *
 * Every worker the app starts, and every module a worker imports by URL, is
 * named in `assets/workers/scripts.js`, which the generator writes beside the
 * bundles (`scripts/generate-web-asset-inventory.mjs`,
 * `scripts/build-worker-bundles.mjs`). Each entry has two addresses:
 *
 * - its **source**, the module under `assets/js/` with its imports, as it is
 *   on disk;
 * - its **bundle**, one self-contained file in `assets/workers/` whose name
 *   is the SHA-256 of its bytes.
 *
 * A page never meets a worker's graph through an import map (no engine gives
 * workers one), so a worker started from its source asks for each import by
 * its plain path, and a host that caches by path can answer one of them from
 * the build before a deploy. A bundle cannot be split that way: it is one
 * request at an address no other build uses. So a page of a deployed site
 * starts every worker from its bundle.
 *
 * A server on this machine (`localhost`, `127.0.0.1`, `[::1]`: a development
 * server on the working tree, the browser-test server, the Python and R
 * packages' servers) serves the files as they are now, and there workers
 * start from their sources. An edit to a worker's code is then live on the
 * next reload, with nothing to build, and the bundles only have to be current
 * when the tree is committed (`--check` refuses a stale one). Outside a
 * browser (Node's tests) there is no page address, and workers start from
 * their sources too.
 *
 * Nothing else differs between the two: the same code runs, from one URL or
 * the other.
 *
 * @module workers/worker-script
 */

/** Host names of this machine, as `URL.hostname` spells them. */
const THIS_MACHINE = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether workers start from their bundles here: anywhere but this machine.
 *
 * @param {{ location?: { hostname?: string } }} [scope]
 * @returns {boolean}
 */
export function startsFromBundles(scope = globalThis) {
  const hostname = scope.location?.hostname;
  return typeof hostname === 'string' && !THIS_MACHINE.has(hostname);
}

/**
 * The URL a worker script (or a module a worker imports) is loaded from.
 *
 * @param {string} base `import.meta.url` of `assets/workers/scripts.js`, or of
 *   the bundle beside it that holds a copy of it
 * @param {string} source the entry's source, relative to `base`
 * @param {string} bundle its bundle, relative to `base`
 * @returns {URL}
 */
export function workerScript(base, source, bundle) {
  return new URL(startsFromBundles() ? bundle : source, base);
}

/** @type {Set<(event: Event) => void>} */
const failureListeners = new Set();

/**
 * Hear about every worker of this thread whose script fails to load or run
 * (`startWorker`). The page uses it to ask whether the site was updated under
 * it (`app/app-code.js`).
 *
 * @param {(event: Event) => void} listener
 * @returns {() => void} removes the listener
 */
export function onWorkerScriptFailure(listener) {
  failureListeners.add(listener);
  return () => failureListeners.delete(listener);
}

/**
 * Start a worker from `script` (an entry of `assets/workers/scripts.js`). Every entry is an
 * ES module, so `options.type` is `'module'`.
 *
 * @param {URL} script
 * @param {WorkerOptions} options
 * @returns {Worker}
 */
export function startWorker(script, options) {
  const worker = new globalThis.Worker(script, options);
  worker.addEventListener('error', event => {
    for (const listener of failureListeners) listener(event);
  });
  return worker;
}
