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
 * - **A change** (`beginCellsChangeOnceSettled` ... `end`): it begins once
 *   no work is under way, in the same turn as it sees none, so no work runs
 *   under it; from its first read until its commit, work about to start
 *   waits (`cellsSteady`), then starts on the cells open after it. A change
 *   that fails leaves the earlier cells, and the work starts on them.
 * - **The open cells in use** (`useOpenCells`): an operation that reads the
 *   open cells over several turns -- saving a session, the notebook's
 *   session request, a cell export -- runs as work once no change is under
 *   way, so a growth step or Apply waits for it and it never sees two sets
 *   of cells. Work never waits for a change while it runs (a change cannot
 *   begin under it), so what it awaits inside may be work too.
 *
 * @module data/open-cells-work
 */

import { awaitWithSignal, throwIfAborted } from '../utils/abort.js';
import { promiseWithResolvers } from '../utils/promise-resolvers.js';

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
    throwIfAborted(signal);
    await awaitWithSignal(Promise.allSettled([...running]), signal);
  }
  throwIfAborted(signal);
}

/** Whether any work on the open cells is under way. */
export function cellWorkRunning() {
  return running.size > 0;
}

/**
 * Run `task` with the open cells in use: once no change of them is under
 * way, as work (`trackCellWork`) until it settles, so no change begins under
 * it (module doc).
 *
 * @template T
 * @param {() => Promise<T>|T} task
 * @param {AbortSignal|null} [signal] - Stops waiting for a change to end
 * @returns {Promise<T>}
 */
export async function useOpenCells(task, signal = null) {
  for (let steady = cellsSteady(); steady !== null; steady = cellsSteady()) {
    throwIfAborted(signal);
    await steady;
  }
  throwIfAborted(signal);
  return trackCellWork(Promise.resolve().then(task));
}

/**
 * Begin changing the open cells once no work on them is under way, in the
 * same turn as none is seen: work about to start waits until `end`. One
 * change at a time (their caller runs them one after another); rejects with
 * `signal`'s reason when it aborts first.
 *
 * @param {AbortSignal|null} [signal]
 * @returns {Promise<() => void>} `end`: the change is committed or given up
 */
export async function beginCellsChangeOnceSettled(signal = null) {
  for (;;) {
    await cellWorkSettled(signal);
    if (running.size === 0) return beginCellsChange();
  }
}

/**
 * Begin changing the open cells: work about to start waits until `end`.
 * One change at a time (their caller runs them one after another).
 *
 * @returns {() => void} `end`: the change is committed or given up
 */
export function beginCellsChange() {
  if (change !== null) throw new Error('The open cells are already being changed.');
  const { promise, resolve: release } = promiseWithResolvers();
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
