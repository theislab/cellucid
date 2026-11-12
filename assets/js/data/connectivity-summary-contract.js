/**
 * The summary of one neighbor graph read from an AnnData file (its
 * `obsp` matrix), as the AnnData adapter publishes it: `{n_cells, n_edges,
 * max_neighbors}`, with both counts null until the edges are first read
 * (counting them reads the whole graph), and the edges
 * (`validateConnectivityEdgeData`) the renderer and the analyses use, whose
 * cell indices are uint32. Absence is exact null.
 *
 * @module data/connectivity-summary-contract
 */

import { isPlainRecord, requireExactKeys } from '../utils/exact-record.js';


const UINT32_CELL_CAPACITY = 0x1_0000_0000;

const KEYS = Object.freeze([
  'n_cells',
  'n_edges',
  'max_neighbors',
]);

/**
 * Whether a summary defers its edge counts: a graph is counted when its edges
 * are first read, not when the file opens (counting reads the whole graph).
 * Both counts are null then.
 *
 * @param {Object} summary
 * @returns {boolean}
 */
export function isDeferredConnectivitySummary(summary) {
  return summary?.n_edges === null && summary?.max_neighbors === null;
}

/**
 * Validate one graph summary. Absence is exact null.
 *
 * @param {unknown} summary
 * @returns {Object|null}
 */
export function validateConnectivitySummary(summary) {
  if (summary === null) return null;
  const label = 'connectivity summary';
  requireExactKeys(summary, KEYS, label);
  if (
    !Number.isSafeInteger(summary.n_cells) ||
    summary.n_cells <= 0 ||
    summary.n_cells > UINT32_CELL_CAPACITY
  ) {
    throw new Error(
      `Invalid ${label}: n_cells must be a positive safe integer within the uint32 cell axis`
    );
  }
  if (isDeferredConnectivitySummary(summary)) return summary;
  if (!Number.isSafeInteger(summary.n_edges) || summary.n_edges < 0) {
    throw new Error(
      `Invalid ${label}: n_edges must be a non-negative safe integer`
    );
  }

  const maximumEdges =
    BigInt(summary.n_cells) * BigInt(summary.n_cells - 1) / 2n;
  if (BigInt(summary.n_edges) > maximumEdges) {
    throw new Error(
      `Invalid ${label}: n_edges exceeds the unique undirected cell-pair bound`
    );
  }

  const maximumNeighbors = Math.min(
    summary.n_cells - 1,
    summary.n_edges
  );
  if (
    !Number.isSafeInteger(summary.max_neighbors) ||
    summary.max_neighbors < 0 ||
    summary.max_neighbors > maximumNeighbors ||
    (
      (summary.n_edges === 0) !==
      (summary.max_neighbors === 0)
    )
  ) {
    throw new Error(
      `Invalid ${label}: max_neighbors is inconsistent with the cell and edge bounds`
    );
  }
  return summary;
}

/**
 * Check one edge payload (`ConnectivityEdges`, `data/connectivity-edges.js`)
 * against its graph summary before it reaches rendering or the k-NN tool:
 * its arrays, their lengths and its counts. The edges themselves (bounds,
 * order, uniqueness, symmetry, weights, the largest degree) were checked by
 * the reader worker as it built them from the matrix, so the page never
 * walks them again.
 *
 * @param {unknown} edgeData
 * @param {Object} summary
 * @returns {Object}
 */
export function validateConnectivityEdgeData(edgeData, summary) {
  if (!isPlainRecord(edgeData)) {
    throw new TypeError(
      'Invalid connectivity edge payload: expected an object'
    );
  }
  requireExactKeys(
    edgeData,
    [
      'forwardOffsets',
      'partners',
      'strengths',
      'maxWeight',
      'nCells',
      'nEdges',
      'maxNeighbors',
    ],
    'connectivity edge payload'
  );
  if (
    !(edgeData.forwardOffsets instanceof Uint32Array) ||
    !(edgeData.partners instanceof Uint32Array) ||
    !(edgeData.strengths instanceof Float32Array)
  ) {
    throw new TypeError(
      'Invalid connectivity edge payload: offsets and partners must be Uint32Array values, strengths a Float32Array'
    );
  }
  // A deferred summary is the payload's own: the counts are checked against
  // the edges themselves below.
  const deferred = isDeferredConnectivitySummary(summary);
  const nEdges = deferred ? edgeData.nEdges : summary.n_edges;
  const maxNeighbors = deferred ? edgeData.maxNeighbors : summary.max_neighbors;
  if (
    !Number.isSafeInteger(nEdges) ||
    nEdges < 0 ||
    edgeData.nCells !== summary.n_cells ||
    edgeData.nEdges !== nEdges ||
    edgeData.maxNeighbors !== maxNeighbors ||
    !Number.isSafeInteger(maxNeighbors) ||
    maxNeighbors < 0 ||
    maxNeighbors > Math.min(summary.n_cells - 1, nEdges) ||
    (nEdges === 0) !== (maxNeighbors === 0) ||
    !(edgeData.maxWeight >= 0 && Number.isFinite(edgeData.maxWeight)) ||
    (nEdges === 0) !== (edgeData.maxWeight === 0)
  ) {
    throw new Error(
      'Invalid connectivity edge payload: its counts must exactly match the graph summary'
    );
  }
  // Partners and strengths are sized by the stored entries before the walk
  // (`ConnectivityEdges`): at least one an edge.
  if (
    edgeData.partners.length < nEdges ||
    edgeData.strengths.length < nEdges ||
    edgeData.forwardOffsets.length !== summary.n_cells + 1 ||
    edgeData.forwardOffsets[summary.n_cells] !== nEdges
  ) {
    throw new Error(
      'Invalid connectivity edge payload: array lengths must match n_edges (a partner and a strength an edge) and n_cells + 1'
    );
  }
  return edgeData;
}
