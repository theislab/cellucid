/**
 * Work that reads or holds the open cells, and the open cells changed in
 * place (`app/open-cells-resize.js`): the one place they meet, so no read
 * of the earlier cells is ever answered by the reader of the new ones.
 *
 * - **Work** (`trackCellWork`): a field or gene load, an embedding's
 *   positions, a vector field, a cancellable job (an analysis run, outlier
 *   quantiles). A change waits until none is under way
 *   (`cellWorkSettled`) before it reads anything: work started on the
 *   earlier cells ends on them (an analysis run's result arrives, and is
 *   then marked stale because the cells changed).
 * - **A change** (`beginCellsChange` ... `end`): from its first read until
 *   its commit, work about to start waits (`cellsSteady`), then starts on
 *   the cells open after it. A change that fails leaves the earlier cells,
 *   and the work starts on them.
 *
 * @module data/open-cells-work
 */

const running = new Set();
let change = null;

/**
 * Count `promise` as work on the open cells until it settles.
 *
 * @template T
 * @param {Promise<T>} promise
 * @returns {Promise<T>} `promise`
 */
export function trackCellWork(promise) {
  const tracked = Promise.resolve(promise);
  running.add(tracked);
  const done = () => running.delete(tracked);
  tracked.then(done, done);
  return promise;
}

/**
 * Resolves once no work on the open cells is under way (work started
 * meanwhile is waited for too); rejects with `signal`'s reason when it
 * aborts first.
 *
 * @param {AbortSignal|null} [signal]
 * @returns {Promise<void>}
 */
export async function cellWorkSettled(signal = null) {
  while (running.size > 0) {
    if (signal?.aborted) throw signal.reason;
    const all = Promise.allSettled([...running]);
    if (signal === null) {
      await all;
      continue;
    }
    await new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      all.then(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      });
    });
  }
  if (signal?.aborted) throw signal.reason;
}

/** Whether any work on the open cells is under way. */
export function cellWorkRunning() {
  return running.size > 0;
}

/**
 * Begin changing the open cells: work about to start waits until `end`.
 * One change at a time (their caller runs them one after another).
 *
 * @returns {() => void} `end`: the change is committed or given up
 */
export function beginCellsChange() {
  if (change !== null) throw new Error('The open cells are already being changed.');
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  const own = { promise };
  change = own;
  return () => {
    if (change !== own) return;
    change = null;
    release();
  };
}

/**
 * Null when the open cells are not being changed; else a promise that
 * resolves when the change ends. Work awaits it (when not null) before it
 * looks at the open cells.
 *
 * @returns {Promise<void>|null}
 */
export function cellsSteady() {
  return change === null ? null : change.promise;
}
