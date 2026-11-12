/**
 * One lifetime rule for the app's worker pools: workers that have had
 * nothing to do for `WORKER_IDLE_MS` are ended, and started again when work
 * comes. A worker is a JavaScript engine of its own (tens of MB each, and a
 * figure-export worker holds WebGL contexts the browser caps), so a pool
 * that kept its workers for the page's life held them for nothing between
 * actions. The decode workers (`formats/io/decode-pool.js`), the analysis
 * pool (`app/analysis/compute/worker-pool.js`), the plot raster workers
 * (`app/analysis/plots/point-layer.js`) and the figure-export worker follow
 * it.
 *
 * Each pool registers here (`registerIdleWorkers`) and says when it became
 * idle (`idle()`); a page hidden or frozen ends every idle worker of every
 * pool at once (`retireIdleWorkers`, `app/page-memory.js`).
 *
 * @module workers/idle-retirement
 */

import { debounce } from '../utils/debounce.js';

/**
 * How long idle workers are kept (a scheduling choice): the work of one
 * action (a gene's chunks, an analysis's runs, a plot's boxes, an export's
 * passes) follows itself within it, so it pays start-up once.
 */
export const WORKER_IDLE_MS = 10_000;

/** @type {Set<{retire: () => void}>} */
const pools = new Set();

/**
 * Count one pool under the rule. `retire()` ends its workers that have
 * nothing to do (never one at work: work under way finishes, and a worker
 * is started again for the next).
 *
 * @param {() => void} retire
 * @returns {{idle: () => void, dispose: () => void}} - `idle()`: the pool
 *   has nothing to do now (its workers end once it has had nothing for
 *   `WORKER_IDLE_MS`); `dispose()`: stop counting it
 */
export function registerIdleWorkers(retire) {
  if (typeof retire !== 'function') throw new TypeError('A pool retires its idle workers with a function.');
  // Its workers end once it has had nothing to do for `WORKER_IDLE_MS`.
  const retireWhenIdle = debounce(retire, WORKER_IDLE_MS, { unref: true });
  const pool = {
    retire() {
      retireWhenIdle.cancel();
      retire();
    },
  };
  pools.add(pool);
  return {
    idle() {
      retireWhenIdle();
    },
    dispose() {
      retireWhenIdle.cancel();
      pools.delete(pool);
    },
  };
}

/** End every idle worker of every pool now (the page is hidden or frozen). */
export function retireIdleWorkers() {
  for (const pool of [...pools]) pool.retire();
}
