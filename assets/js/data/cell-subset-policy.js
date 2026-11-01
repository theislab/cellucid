/**
 * Which cells the datasets opened in this tab open with: the request every
 * opening sends the reader worker (`anndata/subsample-plan.js`; its header
 * lists the modes, `requireCellSubsetRequest` below checks them).
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
  if (request === null || typeof request !== 'object' || !['auto', 'all', 'subsample', 'kept', 'chunks', 'prefix'].includes(request.mode)) {
    throw new TypeError("A cell subset request has a mode of 'auto', 'all', 'subsample', 'kept', 'chunks' or 'prefix'.");
  }
  return Object.freeze({ ...request });
}

/**
 * The request's gene sample (`genes`) that reads genes for the same open
 * cells as `sample` (an opening's, `{cells, of, fit}`; null: every open
 * cell): `'all'`, its count when it was chosen, or the count with the fit
 * it was made by (`{cells, fit}`) when it was fitted, so the same cells
 * opened again (a progressive opening's next step and last, the open cells
 * read again) keep the gene time's budget the page fills after the first
 * gene (`DataState.topUpGeneSample`, `fit.limit` 'geneTime'; `subsample-plan.js`
 * `geneSampleOf`). A sample sized to a matrix still arriving (`fit.limit`
 * 'stream') is not carried, neither its fit nor its count: it is null, and
 * the opening fits the sample afresh against the rows its store holds then.
 * Its count is the rows held when it was sized (0 before any arrived),
 * not a choice; carried as one, a count of 0 was refused as a request and a
 * count of the rows held then stayed the sample after the whole matrix had
 * arrived.
 *
 * @param {{cells: number, of?: number, fit?: Object|null}|null} sample
 * @returns {'all'|number|{cells: number, fit: Object}|null} null: fitted by
 *   the opening
 */
export function geneSampleRequestOf(sample) {
  if (sample === null || sample === undefined) return 'all';
  if (sample.fit?.limit === 'stream') return null;
  const fit = sample.fit ?? null;
  return fit === null ? sample.cells : { cells: sample.cells, fit };
}

/**
 * The request that opens exactly the cells of an opening
 * (`AnnDataReader.cellSubset`, null when nothing is open): every cell (in
 * the order they were open in, `cellOrder`), or its kept cells with their
 * specification (and the cell order a share opened in); and genes read for
 * the same open cells (`genes`).
 *
 * @param {{kept: Uint32Array|null, spec?: Object, autoFit?: Object|null, reproduced?: Object|null}|null} subset
 * @returns {Readonly<Object>}
 */
export function requestOfOpenCells(subset) {
  // The cells genes are read for, the same again (`subsample-plan.js`,
  // `genes`); a sample sized to a matrix still arriving after its map is
  // fitted again (`geneSampleRequestOf`), so the share read meanwhile counts.
  const asked = subset?.genes === undefined ? null : geneSampleRequestOf(subset.genes);
  const genes = asked === null ? {} : { genes: asked };
  if (subset === null || subset.kept === null) {
    return Object.freeze({ mode: 'all', ...(subset?.cellOrder == null ? {} : { order: subset.cellOrder }), ...genes });
  }
  // A step of a subsample grown from few chunks (`anndata/progressive-open.js`):
  // the same cells in the same order.
  if (subset.chunks != null) {
    return Object.freeze({ mode: 'chunks', spec: { ...subset.spec, k: subset.chunks.target }, autoFit: subset.autoFit ?? null, chunks: { rows: subset.chunks.rows, seed: subset.chunks.seed, cells: subset.chunks.cells } });
  }
  // A share opened in the file's cell order names it (`subsample-plan.js`
  // `geneSampleOf`): the same cells in the same order, whatever rung the
  // link would choose now.
  const order = subset.cellOrder == null ? {} : { order: subset.cellOrder };
  return Object.freeze({ mode: 'kept', spec: subset.spec, kept: subset.kept.slice(), autoFit: subset.autoFit ?? null, reproduced: subset.reproduced ?? null, ...order, ...genes });
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
