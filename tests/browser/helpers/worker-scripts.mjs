// The URL each worker starts from, as the page under test computes it.
//
// `assets/workers/scripts.js` (generated) names every worker entry's source
// and bundle; `assets/js/workers/worker-script.js` decides which one a page
// starts from by its address: the source on this machine's own names, the
// bundle anywhere else (a `.localhost` name such as `deployed.localhost`, the
// `CELLUCID_BROWSER_TEST_APP_HOST` of a run). A spec that waits for or routes a
// worker's script asks here, so it names the exact file in either mode.

import { readFileSync } from 'node:fs';

import { startsFromBundles } from '../../../assets/js/workers/worker-script.js';
import { APP_ORIGIN } from './origins.mjs';

const SCRIPTS = readFileSync(new URL('../../../assets/workers/scripts.js', import.meta.url), 'utf8');

/** Each entry's source and bundle path, by entry name (`decodeWorker`, …). */
export const WORKER_SCRIPTS = new Map(
  [...SCRIPTS.matchAll(
    /export const (\w+)Script = \(\) => workerScript\(import\.meta\.url, '\.\.\/([^']+)', '\.\/([^']+)'\);/g,
  )].map(([, name, source, bundle]) => [name, Object.freeze({
    source: `/assets/${source}`,
    bundle: `/assets/workers/${bundle}`,
  })]),
);

/**
 * The path a page at `origin` starts the worker entry `name` from.
 *
 * @param {string} name
 * @param {string} [origin]
 * @returns {string}
 */
export function workerScriptPath(name, origin = APP_ORIGIN) {
  const entry = WORKER_SCRIPTS.get(name);
  if (entry === undefined) throw new TypeError(`No worker entry is named ${JSON.stringify(name)}.`);
  return startsFromBundles({ location: new URL(origin) }) ? entry.bundle : entry.source;
}

/**
 * A pattern matching exactly the URL of that script (no query: worker scripts
 * are not in the import map).
 *
 * @param {string} name
 * @param {string} [origin]
 * @returns {RegExp}
 */
export function workerScriptPattern(name, origin = APP_ORIGIN) {
  const path = workerScriptPath(name, origin).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`${path}$`);
}
