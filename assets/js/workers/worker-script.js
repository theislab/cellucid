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

import { createListenerSet } from '../utils/listener-set.js';

/**
 * Host names of this machine, as `URL.hostname` spells them. The page's own
 * code follows the same rule (index.html's boot script, written from this set
 * by `scripts/generate-web-asset-inventory.mjs`): sources here, the page
 * bundle (`assets/page/`) anywhere else.
 */
export const THIS_MACHINE_HOSTS = Object.freeze(['localhost', '127.0.0.1', '[::1]']);
const THIS_MACHINE = new Set(THIS_MACHINE_HOSTS);

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

const failureListeners = createListenerSet('a worker\'s script failing');

/**
 * Hear about every worker of this thread whose script fails to load or run
 * (`startWorker`). The page uses it to ask whether the site was updated under
 * it (`app/app-code.js`).
 *
 * @param {(event: Event) => void} listener
 * @returns {() => void} removes the listener
 */
export function onWorkerScriptFailure(listener) {
  return failureListeners.add(listener);
}

/**
 * What this thread hands to every worker it starts, by key: each a function
 * read at the worker's start (`startWorker`), whose value (plain data; none
 * when undefined) the worker reads back with `handedByStarter` as its first
 * modules run -- before a message could reach it.
 * @type {Map<string, () => unknown>}
 */
const handed = new Map();

/** Begins the fragment of a worker's address that holds what it was handed. */
const HANDED_MARK = '#handed=';

/**
 * Hand `read()` to every worker this thread starts from now on, under
 * `key`: what it returns when the worker starts, when that is not
 * undefined. One reader a key (`utils/machine.js`: the machine's held
 * measures, which a worker's plans must begin with).
 *
 * It travels in the fragment of the worker's address
 * (`self.location.hash`), which the worker's scope holds before its first
 * message and no request for its script carries: the same script is asked
 * for, at the same address, as without it, and the worker keeps the name
 * its caller gave it. A worker handed nothing is started at its script's
 * address as it is.
 *
 * @param {string} key
 * @param {() => unknown} read
 */
export function handToWorkers(key, read) {
  if (typeof key !== 'string' || key === '') throw new TypeError('What is handed to workers has a key.');
  if (typeof read !== 'function') throw new TypeError('What is handed to workers is read when one starts: a function.');
  handed.set(key, read);
}

/**
 * What the thread that started this worker handed it under `key`
 * (`handToWorkers`), or undefined: nothing, or this is no worker (a page's
 * fragment is whatever its link said, and is never read).
 *
 * @param {string} key
 * @param {typeof globalThis} [scope]
 * @returns {unknown}
 */
export function handedByStarter(key, scope = globalThis) {
  const Scope = scope.DedicatedWorkerGlobalScope;
  if (typeof Scope !== 'function' || !(scope instanceof Scope)) return undefined;
  const fragment = scope.location?.hash;
  if (typeof fragment !== 'string' || !fragment.startsWith(HANDED_MARK)) return undefined;
  const record = JSON.parse(decodeURIComponent(fragment.slice(HANDED_MARK.length)));
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** `script` with what this thread hands its workers (`handToWorkers`) as its fragment; `script` itself when it hands nothing. */
function withHanded(script) {
  const record = {};
  for (const [key, read] of handed) {
    const value = read();
    if (value !== undefined) record[key] = value;
  }
  if (Object.keys(record).length === 0) return script;
  const address = new URL(script);
  address.hash = `${HANDED_MARK}${encodeURIComponent(JSON.stringify(record))}`;
  return address;
}

/**
 * Start a worker from `script` (an entry of `assets/workers/scripts.js`). Every entry is an
 * ES module, so `options.type` is `'module'`. The worker is handed what this
 * thread hands its workers (`handToWorkers`).
 *
 * @param {URL} script
 * @param {WorkerOptions} options
 * @returns {Worker}
 */
export function startWorker(script, options) {
  const worker = new globalThis.Worker(withHanded(script), options);
  worker.addEventListener('error', event => {
    failureListeners.notify(event);
  });
  return worker;
}
