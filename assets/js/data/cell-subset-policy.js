/**
 * Which cells the datasets opened in this tab open with: the request every
 * opening sends the reader worker (`anndata/subsample-plan.js`,
 * `CellSubsetRequest`).
 *
 * - **The tab's request** applies to every dataset opened next in this tab:
 *   `{mode: 'auto'}` (every cell, unless the dataset does not fit this
 *   device), `{mode: 'all'}`, or a subsample by fraction
 *   (`{mode: 'subsample', method, fraction, seed, …}`). It is set by the
 *   Session accordion's subsample control and lives as long as the tab;
 *   a subsample chosen there is written to the address as its specification
 *   (`app/subsample-url.js`), never its cells; sessions carry the cells.
 * - **The next opening's request** overrides it once: the subsample a link
 *   names (`app/main.js`). The opening that takes it
 *   (`takeCellSubsetRequest`) clears it, whether it succeeds or not.
 * - The open dataset read again with other cells (Apply, Open all, a
 *   session's exact cells, a progressive opening's steps) is given its
 *   request by its caller (`AnnDataFileSource.reopenCells`), never through
 *   this module: a reading cancelled, or the earlier cells read back after
 *   one, never takes or overwrites the request of another.
 *
 * @module data/cell-subset-policy
 */

const DEFAULT_REQUEST = Object.freeze({ mode: 'auto' });

let tabRequest = DEFAULT_REQUEST;
let nextRequest = null;
const listeners = new Set();

/**
 * A cell subset request, checked and frozen.
 *
 * @param {Object} request
 * @returns {Readonly<Object>}
 */
export function requireCellSubsetRequest(request) {
  if (request === null || typeof request !== 'object' || !['auto', 'all', 'subsample', 'kept', 'chunks'].includes(request.mode)) {
    throw new TypeError("A cell subset request has a mode of 'auto', 'all', 'subsample', 'kept' or 'chunks'.");
  }
  return Object.freeze({ ...request });
}

/**
 * The request that opens exactly the cells of an opening
 * (`AnnDataReader.cellSubset`, null when nothing is open): every cell, or
 * its kept cells with their specification.
 *
 * @param {{kept: Uint32Array|null, spec?: Object, autoFit?: Object|null, reproduced?: Object|null}|null} subset
 * @returns {Readonly<Object>}
 */
export function requestOfOpenCells(subset) {
  if (subset === null || subset.kept === null) return Object.freeze({ mode: 'all' });
  // A step of a subsample grown from few chunks (`anndata/progressive-open.js`):
  // the same cells in the same order.
  if (subset.chunks != null) {
    return Object.freeze({ mode: 'chunks', spec: { ...subset.spec, k: subset.chunks.target }, autoFit: subset.autoFit ?? null, chunks: { rows: subset.chunks.rows, seed: subset.chunks.seed, cells: subset.chunks.cells } });
  }
  return Object.freeze({ mode: 'kept', spec: subset.spec, kept: subset.kept.slice(), autoFit: subset.autoFit ?? null, reproduced: subset.reproduced ?? null });
}

/** The tab's request (what the control shows). */
export function getTabCellSubsetRequest() {
  return tabRequest;
}

/**
 * Set the tab's request: what datasets opened next in this tab open with.
 *
 * @param {Object} request
 */
export function setTabCellSubsetRequest(request) {
  const checked = requireCellSubsetRequest(request);
  if (checked.mode === 'kept') throw new TypeError('A tab opens datasets by fraction, never by a recorded cell set.');
  tabRequest = checked;
  for (const listener of listeners) listener(tabRequest);
}

/** Be told when the tab's request changes; returns the unsubscribe. */
export function onTabCellSubsetRequest(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Open the next dataset with `request`, once.
 *
 * @param {Object} request
 */
export function setNextCellSubsetRequest(request) {
  nextRequest = requireCellSubsetRequest(request);
}

/** The request of an opening starting now: the next opening's, else the tab's. */
export function takeCellSubsetRequest() {
  const request = nextRequest ?? tabRequest;
  nextRequest = null;
  return request;
}

/** Back to the defaults (tests). */
export function resetCellSubsetRequests() {
  tabRequest = DEFAULT_REQUEST;
  nextRequest = null;
}
