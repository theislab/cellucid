/**
 * Which cells an opening keeps: a subsample request resolved against the
 * store, on the reader worker, before the dataset is read
 * (`AnnDataReader.open`). What it reads is only what the method needs: the
 * cell count from metadata; a stratified subsample the field's codes; a
 * spatial one the embedding's columns; nothing else.
 *
 * ## Requests (sent by the page; checked by `requireCellSubsetRequest`, `../cell-subset-policy.js`)
 *
 * - `{mode: 'auto'}` — every cell, unless the dataset does not fit this
 *   device (`autoFit`): then a `blocks` subsample sized to fit, aligned to
 *   the storage so the cells left out are never read (a priority-ordered
 *   file: `uniform` under its seed, a prefix of every array), with
 *   `autoFit` saying why.
 * - `{mode: 'all', order?}` — every cell, whatever it costs (`order`: the
 *   cell order they were open in, when read again: `geneSampleOf`).
 * - `{mode: 'subsample', method, fraction | k, seed, ...}` — a subsample by
 *   the specification (`../subsample.js`). A parameter left out takes its
 *   default: `blockSize` a rung of the file's ladder (`blockRung`: the
 *   storage's block doubled to what the link reads in a round trip, or the
 *   rung of a gene index kept here; recorded in the spec),
 *   `gridSize` 32, `allocation` proportional, `minPerCategory` 0, the
 *   embedding's first two columns. `fraction` becomes a count by
 *   `countFromFraction`; a size of every cell is every cell, and any other
 *   is kept exactly, never raised: a size under `FEWEST_OPEN_CELLS` (a
 *   count, or a share that rounds to it) is refused with the reason the
 *   control and the link give. Unless `strict`, a method whose field or embedding the
 *   dataset lacks opens the file's default method (`defaultSubsampleMethod`)
 *   at the same size and seed, and says so (`note`): the tab's request meets
 *   datasets it was not chosen for.
 * - `{mode: 'kept', spec, kept, autoFit?, reproduced?, order?}` — exactly the cells a session recorded
 *   (or the open cells read again: `autoFit` and a `reproduced` false carry over)
 *   (`kept`, ascending), checked against the dataset's cell count. Whether
 *   `spec` still gives the same cells is reported (`reproduced`), never
 *   required: the recorded set is the truth. `order`: the cell order a
 *   share opened in (`geneSampleOf`), the same again.
 * - `{mode: 'prefix', spec, k, order?, autoFit?}` — the first `k` cells of
 *   the subsample `spec` in the order it opens in (`prefixStep`): a step of
 *   a progressive opening growing a share in its order.
 * - `{mode: 'chunks', spec, chunks: {rows, seed, cells}, autoFit?}` — the
 *   share's cells in the first chunks of a seeded chunk order (`chunkStep`):
 *   a step of a share growing from few chunks.
 *
 * Any request may name its gene sample (`genes`: `'all'`, or a count of
 * open cells); left out, it is fitted (`geneSampleOf`).
 *
 * ## Auto-fit (`autoFit`)
 *
 * A dataset fits when, at every cell, both hold:
 *
 * - the per-cell working set (`CELL_WORKING_SET_BYTES` a cell,
 *   `memory-budget.js`) fits the memory allowance (half the device);
 * - the gene indexes every open cell holds (`columnIndexResidentBytes`: a
 *   cell-major sparse matrix's stored values, a dense one's every value) --
 *   each modality's `X`, and the root expression matrix unless its genes
 *   are read for a gene sample -- fit the `columnIndex` share of what that
 *   working set leaves of the allowance: the working set and the caches
 *   divide one allowance, never each the whole of it.
 *
 * Otherwise the largest `k` for which both hold is opened (the method: see
 * `{mode: 'auto'}` above). What a gene costs never sizes the map: a matrix
 * stored cell by cell (CSR, or dense in row chunks) has its genes read for
 * a **gene sample** of the open cells, sized by the first gene's time over
 * the measured link (`geneTimeFit`, `GENE_READ_TARGET_MS`) and by its gene
 * index's memory (`geneIndexFit`): see `geneSampleOf`. WebGL reports no
 * limit on buffer sizes, so the GPU adds no bound here; an allocation the
 * GPU refuses is reported where it happens.
 *
 * @module data/anndata/subsample-plan
 */

import { isArrayNode, isGroup } from '../../formats/store.js';
import { attributeValue, child, elementBytes, encodingType, valueKind } from './elements.js';
import { readRowSlabs, readStored } from './values.js';
import { readNullableValues } from './dataframe.js';
import { bestGuessOrder, compareCodePoints, defaultExpression, expressionRuleInputs, vectorFieldKeys } from '../data-mapping.js';
import { columnIndexResidentBytes, geneLayoutOf, readInWholeChunks, readsThroughRowIndex } from './matrix-access.js';
import { CELL_WORKING_SET_BYTES, RESIDENCY_SHARES, memoryAllowanceBytes, residencyBudgetBytes } from '../memory-budget.js';
import {
  DEFAULT_GRID_SIZE,
  DEFAULT_SUBSAMPLE_SEED,
  FEWEST_OPEN_CELLS,
  FEWEST_OPEN_CELLS_REASON,
  STRATIFIED_ALLOCATIONS,
  SUBSAMPLE_METHODS,
  countFromFraction,
  countFromShare,
  createSubsampleCache,
  priorityOrder,
  requireSubsampleSpec,
} from '../subsample.js';
import { createCellIdentity } from '../cell-identity.js';
import { readPriorityLayout } from './priority-layout.js';
import { formatCountOf, formatPercent } from '../../utils/format-units.js';
import { chunkMajorOrder, decodingRate } from './progressive-open.js';
import { geneSampleRequestOf } from '../cell-subset-policy.js';
import { allocateTypedArray } from '../sparse-column-index.js';
import { sortUint32 } from '../../utils/radix-order.js';
import { noteRunsOf } from './views/cell-subset.js';
import { REMOTE_POLICY } from '../../formats/io/byte-source.js';
import { loadedRoundTripMs } from '../../formats/io/link.js';
import { measureOf } from '../../utils/machine.js';
import { DataSourceErrorCode, explainedFailure } from '../data-source.js';

/**
 * A subsample this dataset cannot be read with (a field or an embedding it
 * lacks, a column past its width): a refusal of the request, written for the
 * person, and settled (asking again meets it again), never a fault of the
 * link (`dataset-connections.js` `classifyDataSourceFailure`).
 */
function subsampleRefused(message) {
  return explainedFailure(message, DataSourceErrorCode.UNSUPPORTED);
}

/** Chunks of the dominant cell-major array one block of `blocks` spans (see `defaultBlockSize`). */
const BLOCK_CHUNKS = 4;

/**
 * The bytes of the dominant array one block of `blocks` fills when that
 * array is read byte by byte (stored in one piece, or in chunks read in
 * part): what one request is taken to be worth on a web host before its
 * link is measured (`REMOTE_POLICY.mergeGapBytes`). A constant, never the
 * link as measured: a file's default sample is a property of the file, the
 * same cells whenever, wherever and however it is opened (a merge gap
 * measured from one read's timing would give the same file other blocks
 * from one opening to the next), and a larger share of the same
 * request keeps every cell of a smaller one.
 */
const BYTE_READ_BLOCK_BYTES = REMOTE_POLICY.mergeGapBytes;

/** The cell count of a store root, from metadata: `X`'s rows, else the obs index's length. */
export function storeCellCount(root) {
  const X = child(root, 'X');
  if (X !== null) {
    if (isArrayNode(X)) return X.shape[0];
    const shape = attributeValue(X, 'shape');
    if (Array.isArray(shape)) return Number(shape[0]);
  }
  const obs = child(root, 'obs');
  const indexKey = attributeValue(obs, '_index');
  const index = typeof indexKey === 'string' ? child(obs, indexKey) : null;
  if (isArrayNode(index)) return index.shape[0];
  throw new Error('The cell count of this dataset cannot be read from its metadata');
}

/**
 * The expression matrix an opening reads genes from by default, as a path
 * below the store root (`X`, `raw/X`, `layers/<name>`), or null when the
 * store has none: the launch default the file names
 * (`uns['cellucid']['defaults']['expression']`), else the default
 * expression rule (`defaultExpression`, `expressionRuleInputs`: `raw.X`
 * when it holds more genes than `X` or `X` is scaled). What a gene costs,
 * and so how many cells an opening fits and how its blocks align, is the
 * cost of this matrix: pricing `X` while genes are read from `raw.X`
 * would open every cell of a file whose first gene then reads the whole of
 * `raw.X`.
 *
 * @param {Object} root - The stored root (never a subsample's view)
 * @param {{launch?: unknown, read?: (region: [[number, number], [number, number]]) => Promise<ArrayLike<number>>}} [options] -
 *   `launch`: the file's launch default, when it names one; `read`: the
 *   region read of `X` the reader shares with its probes (`regionReader`)
 * @returns {Promise<string|null>}
 */
export async function defaultExpressionPath(root, { launch = null, read = null } = {}) {
  if (typeof launch === 'string' && launch !== '' && child(root, launch) !== null) return launch;
  const X = child(root, 'X');
  const rawX = child(child(root, 'raw'), 'X');
  const shapeOf = node => (isArrayNode(node) ? node.shape : attributeValue(node, 'shape'));
  const layers = child(root, 'layers');
  const layerNames = isGroup(layers) ? layers.keys() : [];
  const inputs = await expressionRuleInputs({
    X: X === null ? null : {
      dense: isArrayNode(X),
      floating: isArrayNode(X) && X.dtype?.kind === 'float',
      shape: shapeOf(X) ?? [],
      chunks: isArrayNode(X) && Array.isArray(X.chunks) ? X.chunks : null,
    },
    rawX: rawX === null ? null : { shape: shapeOf(rawX) ?? [] },
    read: read ?? (region => X.read(region)),
  });
  const { expression } = defaultExpression({ ...inputs, layers: layerNames });
  if (expression === null) return null;
  if (expression === 'X') return 'X';
  if (expression === 'raw') return 'raw/X';
  return `layers/${expression.slice('layer:'.length)}`;
}

/**
 * The expression matrix at `path` below `root` (`defaultExpressionPath`;
 * `X` by default) described for cost: its layout and stored values. `path`
 * may name the matrix node itself (a neighbor graph's rows are priced as a
 * matrix's: `AnnDataReader._graphReadPlan`).
 */
function matrixOf(root, nObs, path = 'X') {
  const X = path === null ? null : typeof path === 'string' ? child(root, path) : path;
  if (X === null) return null;
  if (isArrayNode(X)) return { layout: 'dense', node: X, nVars: X.shape[1] ?? 1, nnz: nObs * (X.shape[1] ?? 1) };
  const encoding = encodingType(X);
  const shape = attributeValue(X, 'shape');
  const indices = child(X, 'indices');
  if (!Array.isArray(shape) || !isArrayNode(indices)) return null;
  return {
    layout: encoding === 'csr_matrix' ? 'csr' : encoding === 'csc_matrix' ? 'csc' : 'other',
    node: X,
    nVars: Number(shape[1]),
    nnz: indices.shape[0],
  };
}

/** How a person reads an expression matrix's path (`raw/X` is `raw.X`, `layers/counts` is `layers['counts']`). */
function matrixLabel(path) {
  if (path === 'raw/X') return 'raw.X';
  if (typeof path === 'string' && path.startsWith('layers/')) return `layers['${path.slice('layers/'.length)}']`;
  return path ?? 'X';
}

/**
 * The block size `blocks` uses unless given: a run of cells spanning about
 * `BLOCK_CHUNKS` chunks of the dominant cell-major array, so the chunk a
 * block shares with its neighbor at each end costs at most about a
 * `1 / BLOCK_CHUNKS` more. The dominant array is the expression matrix
 * genes are read from (`expression`, `defaultExpressionPath`: `X`, or
 * `raw.X` when the default rule reads raw) when it is cell-major (a CSR
 * matrix's index chunks, as cells by the mean stored values per cell; a
 * dense one's chunk rows), else the widest dense `obsm` array.
 * An array read byte by byte (stored in one piece, or in chunks read in
 * part: `partialChunks`) has no chunk to align to: a block is then the
 * cells whose bytes fill `BYTE_READ_BLOCK_BYTES`. The layout alone decides
 * it, never the link.
 *
 * @param {Object} root
 * @param {number} nObs
 * @param {string|null} [expression] - The expression matrix's path below `root`
 * @returns {number}
 */
export function defaultBlockSize(root, nObs, expression = 'X') {
  const matrix = matrixOf(root, nObs, expression);
  const chunkRowsOf = array => (Array.isArray(array?.chunks) && array.partialChunks !== true ? Number(array.chunks[0]) : null);
  const byGap = rowBytes => Math.max(1, Math.ceil(BYTE_READ_BLOCK_BYTES / Math.max(1, rowBytes)));
  if (matrix?.layout === 'csr' && nObs > 0 && matrix.nnz > 0) {
    const indices = child(matrix.node, 'indices');
    const perCell = matrix.nnz / nObs;
    const chunk = chunkRowsOf(indices);
    if (chunk === null) return byGap(perCell * elementBytes(indices));
    return Math.max(1, Math.round(BLOCK_CHUNKS * chunk / perCell));
  }
  if (matrix?.layout === 'dense') {
    const chunk = chunkRowsOf(matrix.node);
    if (chunk === null) return byGap(matrix.nVars * elementBytes(matrix.node));
    return chunk * BLOCK_CHUNKS;
  }
  const obsm = child(root, 'obsm');
  let widest = null;
  if (isGroup(obsm)) {
    for (const key of obsm.keys()) {
      const node = obsm.get(key);
      if (isArrayNode(node) && node.shape[0] === nObs && (widest === null || (node.shape[1] ?? 1) > (widest.shape[1] ?? 1))) widest = node;
    }
  }
  if (widest === null) return 1;
  const chunk = chunkRowsOf(widest);
  return chunk === null ? byGap((widest.shape[1] ?? 1) * elementBytes(widest)) : chunk * BLOCK_CHUNKS;
}

/**
 * The per-cell arrays an opening reads most of, as what a share of cells
 * costs of each (`cellShareReadShare`): the expression matrix genes are read
 * from (`expression`) when it is cell-major (a CSR matrix's `indices` and
 * `data`, a stored chunk holding `chunk / (values a cell)` cells; a dense
 * one's chunk rows) and every dense `obsm` array (the embedding is the
 * first view), each with its decoded bytes (its weight) and the cells one of
 * its stored chunks holds (`rows`; null for an array read byte by byte:
 * stored in one piece, or in chunks read in part, which costs about the
 * share of its bytes). A gene-major matrix (CSC, a Cellucid-ready file's)
 * is read a gene at a time, at the cost of the gene's own values whatever
 * the share: not counted. Plain data, posted to the page with the open
 * cells, so the control prices a share before it is applied.
 *
 * @param {Object} root
 * @param {number} nObs
 * @param {string|null} [expression]
 * @returns {Array<{rows: number|null, bytes: number}>}
 */
export function cellReadLayout(root, nObs, expression = 'X') {
  if (!(nObs > 0)) return [];
  const chunkRowsOf = array => (Array.isArray(array?.chunks) && array.chunks.length > 0 && array.partialChunks !== true ? Number(array.chunks[0]) : null);
  const bytesOf = array => array.shape.reduce((product, extent) => product * extent, 1) * (elementBytes(array) || 8);
  const layout = [];
  const matrix = matrixOf(root, nObs, expression);
  if (matrix?.layout === 'csr' && matrix.nnz > 0) {
    const perCell = matrix.nnz / nObs;
    for (const name of ['indices', 'data']) {
      const array = child(matrix.node, name);
      if (!isArrayNode(array)) continue;
      const chunk = chunkRowsOf(array);
      layout.push({ rows: chunk === null ? null : Math.max(1, chunk / perCell), bytes: bytesOf(array) });
    }
  } else if (matrix?.layout === 'dense' && matrix.node.shape[0] === nObs) {
    layout.push({ rows: chunkRowsOf(matrix.node), bytes: bytesOf(matrix.node) });
  }
  const obsm = child(root, 'obsm');
  if (isGroup(obsm)) {
    for (const key of obsm.keys()) {
      const node = obsm.get(key);
      if (isArrayNode(node) && node.shape[0] === nObs) layout.push({ rows: chunkRowsOf(node), bytes: bytesOf(node) });
    }
  }
  return layout;
}

/**
 * The share of the per-cell arrays' stored bytes (`cellReadLayout`) that
 * opening a share `fraction` of the cells by `method` reads, about: what the
 * Cells to open control says before a share is applied. The cells of a
 * scattered method (`uniform`, `stratified`, `spatial`: a representative
 * sample lies throughout the file) are independent of the file's order, so
 * a stored chunk of `c` cells holds one of them with probability
 * `1 - (1 - fraction)^c` and is then read whole (a 1% uniform share of a
 * file in chunks of 1,000 cells reads every chunk: 99.996%); `blocks` keeps
 * runs of cells spanning whole chunks (`defaultBlockSize`) and `priority` a
 * priority-ordered file's first rows: about their share. An array read byte
 * by byte costs the share of its bytes whatever the method.
 *
 * @param {Array<{rows: number|null, bytes: number}>|null} layout
 * @param {number} fraction - Open cells over every cell, in [0, 1]
 * @param {string} method
 * @returns {number|null} The share read, in [0, 1]; null when the layout says nothing
 */
export function cellShareReadShare(layout, fraction, method) {
  if (!Array.isArray(layout) || layout.length === 0 || !(fraction >= 0)) return null;
  const share = Math.min(1, fraction);
  const scattered = method === 'uniform' || method === 'stratified' || method === 'spatial';
  let read = 0;
  let total = 0;
  for (const { rows, bytes } of layout) {
    if (!(bytes > 0)) continue;
    total += bytes;
    read += bytes * (scattered && rows !== null ? 1 - (1 - share) ** rows : share);
  }
  return total > 0 ? read / total : null;
}

/**
 * How long the first gene of an opening may take, when the matrix is stored
 * cell by cell (CSR, or dense in row chunks) and read over a measured link:
 * about 20 s. A response-time target for an explicit request whose progress
 * is shown, not a platform limit: people keep their attention on a task for
 * about 10 s without feedback (Nielsen 1993; Miller 1968) and wait about
 * twice that with a progress line; past it the read looks endless. The
 * share is the person's to raise (the subsample control, Open all cells);
 * genes then take longer, as the notice says.
 */
export const GENE_READ_TARGET_MS = 20_000;

/**
 * The share of the gene time the gene sample is priced to fill
 * (`geneSampleOf`): half, so the first gene is drawn within the attention
 * span the target's note gives (about 10 s), and the rest of the gene time
 * reads genes for more cells, sized by what the first gene took
 * (`DataState.topUpGeneSample`), not by a price made before the link was
 * measured: on a first visit to a host the price rests on its early, small
 * reads, which measure a fraction of its rate (measured: 23_decisions_partial_reading.md).
 */
export const FIRST_GENE_SHARE = 1 / 2;

/**
 * File rows to price (`rowChunks`, `firstGeneReadCost`): ascending rows, or
 * their runs, `[starts[r], ends[r])` ascending and apart -- a `blocks` order
 * is priced a block at a time, never a row (`subsampleBlockRuns`).
 *
 * @typedef {Uint32Array|Float64Array|{count: number, starts: ArrayLike<number>, ends: ArrayLike<number>}} PricedRows
 */

/**
 * Each span of consecutive rows of `rows` (`PricedRows`), ascending:
 * `visit(first, last)`, both included. `adds(row)`, when given, says
 * whether a row can add to what the visits found so far; it never turns
 * true again for later rows until a visit (it holds for a prefix of the
 * rows after each visit's last), and rows it rules out are passed over in
 * one binary search, not visited: `rowChunks` passes over the rows whose
 * elements lie in chunks already counted (visiting every single-row span of
 * a large uniform share at each step of the gene sample's fit takes
 * seconds of an opening: measured, 23_decisions_partial_reading.md).
 */
function forEachRowSpan(rows, visit, adds = null) {
  if (ArrayBuffer.isView(rows)) {
    for (let i = 0; i < rows.length;) {
      if (adds !== null && !adds(rows[i])) {
        let lo = i + 1;
        let hi = rows.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (adds(rows[mid])) hi = mid;
          else lo = mid + 1;
        }
        i = lo;
        if (i >= rows.length) break;
      }
      let next = i + 1;
      while (next < rows.length && rows[next] === rows[next - 1] + 1) next++;
      visit(rows[i], rows[next - 1]);
      i = next;
    }
    return;
  }
  for (let r = 0; r < rows.count; r++) if (rows.ends[r] > rows.starts[r]) visit(rows.starts[r], rows.ends[r] - 1);
}

/** How many rows `rows` (`PricedRows`) holds. */
function rowCountOf(rows) {
  if (ArrayBuffer.isView(rows)) return rows.length;
  let count = 0;
  for (let r = 0; r < rows.count; r++) count += Math.max(0, rows.ends[r] - rows.starts[r]);
  return count;
}

/** Rows `[from, to)` as `PricedRows`: one run. */
function rowRun(from, to) {
  return { count: to > from ? 1 : 0, starts: [from], ends: [to] };
}

/**
 * The rows of `outer` (runs) that `inner` (runs within it: a smaller
 * `blocks` subsample of the same order is nested in a larger one) leaves.
 */
function runsWithout(outer, inner) {
  const starts = [];
  const ends = [];
  let i = 0;
  for (let r = 0; r < outer.count; r++) {
    let from = outer.starts[r];
    const to = outer.ends[r];
    while (i < inner.count && inner.ends[i] <= from) i++;
    for (let j = i; j < inner.count && inner.starts[j] < to; j++) {
      if (inner.starts[j] > from) {
        starts.push(from);
        ends.push(inner.starts[j]);
      }
      from = Math.max(from, inner.ends[j]);
    }
    if (from < to) {
      starts.push(from);
      ends.push(to);
    }
  }
  return { count: starts.length, starts, ends };
}

/**
 * The stored chunks of a cell-major array that rows `rows` (file rows,
 * ascending, `PricedRows`) lie in and would be fetched, and the runs of
 * consecutive such chunks they make (each run one request: the byte reader
 * joins adjacent chunks). `elementOf(row)`: where the row's elements start,
 * about; the row ends where the next starts, and `extra` elements after (a
 * pointer array's next pointer). A chunk `held(band)` says this browser holds
 * (kept from an earlier reading, `io/kept-parts.js`) costs nothing and
 * parts the runs around it: `kept` counts those. `held` names stored
 * chunks along the first dimension (`heldChunkBands`), each `unitsPerBand`
 * of the units counted here: 1 when a read fetches whole stored chunks;
 * the stored chunk's elements when a read fetches only its rows' bytes
 * (`partialChunks`, priced per element: `chunkElements` 1). `elementOf`
 * never decreases (a row starts where the one before it ends). `touched`,
 * when given, receives the runs of stored chunks (bands) the rows lie in,
 * `[first, last]`, ascending. `gapUnits`: the units between two fetched
 * ones the byte reader fetches with them rather than making another request
 * (the link's merge gap, `link.js` `mergeGapBytes`, in units): they cost
 * their bytes (counted in `chunks`, and in `gaps`: fetched, never decoded)
 * and no run, as a read of scattered rows fetches them (a scattered share
 * priced without them is priced far below what is read: measured,
 * 23_decisions_partial_reading.md).
 */
export function rowChunks(rows, elementOf, chunkElements, extra = 0, held = null, unitsPerBand = 1, touched = null, gapUnits = 0) {
  let chunks = 0;
  let runs = 0;
  let kept = 0;
  let last = -2;
  let lastFetched = -2;
  let lastKept = -2;
  let gaps = 0;
  // Consecutive rows are priced as one span: `elementOf` is monotone, so
  // rows r..s hold [elementOf(r), elementOf(s + 1)), and the chunks it
  // touches are exactly those of its rows. Two calls a run of rows, not two
  // a row: the gene sample's fit prices up to every row of the file about
  // log2(n) times (measured: 23_decisions_partial_reading.md); given as runs,
  // not even a step a row.
  forEachRowSpan(rows, (firstRow, lastRow) => {
    const start = elementOf(firstRow);
    const end = elementOf(lastRow + 1) + extra;
    if (end <= start) return;
    let first = Math.floor(start / chunkElements);
    const stop = Math.floor((end - 1) / chunkElements);
    if (first <= last) first = last + 1;
    if (stop < first) return;
    // The stored chunks (`held`'s bands) the span reads, for the index
    // reads that find them (`chunkIndexReads`).
    if (touched !== null) {
      const from = Math.floor(first / unitsPerBand);
      const to = Math.floor(stop / unitsPerBand);
      if (touched.length > 0 && touched[touched.length - 1][1] >= from - 1) touched[touched.length - 1][1] = Math.max(touched[touched.length - 1][1], to);
      else touched.push([from, to]);
    }
    // The span's units, a stored chunk (`held`'s band) at a time: one
    // step for the span when nothing is held, never one a unit (a raw
    // array's units are its elements: billions over a large matrix).
    for (let unit = first; unit <= stop;) {
      const band = held === null ? -1 : Math.floor(unit / unitsPerBand);
      const bandEnd = held === null ? stop : Math.min(stop, (band + 1) * unitsPerBand - 1);
      if (held !== null && held(band)) {
        kept += bandEnd - unit + 1;
        lastKept = bandEnd;
      } else {
        const gap = unit - lastFetched - 1;
        // A gap the reader fetches through (nothing held in it): its bytes, no request.
        if (gap > 0 && lastFetched >= 0 && gap <= gapUnits && lastKept < lastFetched) {
          chunks += gap;
          gaps += gap;
        } else if (gap !== 0) runs++;
        chunks += bandEnd - unit + 1;
        lastFetched = bandEnd;
      }
      unit = bandEnd + 1;
    }
    last = stop;
  }, row => elementOf(row + 1) + extra > (last + 1) * chunkElements);
  return { chunks, runs, kept, gaps };
}

/** The bands of chunks of `array` this browser holds now (`heldChunkBands`), or null when it cannot tell. */
async function heldBandsOf(array, readOptions) {
  if (typeof array.heldChunkBands !== 'function') return null;
  try {
    return await array.heldChunkBands(readOptions);
  } catch {
    return null;
  }
}

/** What reading some chunk bands of `array` reads of its chunk index first (`chunkIndexReads`), or null when its index is known. */
async function indexReadsOf(array, readOptions) {
  if (typeof array.chunkIndexReads !== 'function') return null;
  try {
    return await array.chunkIndexReads(readOptions);
  } catch {
    return null;
  }
}

/**
 * The dependent steps of two reads made side by side (`firstGeneReadCost`'s
 * `steps`), aligned at their last: the reads of each step together.
 */
function withLastStep(a, b) {
  const longer = a.length >= b.length ? a.slice() : b.slice();
  const shorter = a.length >= b.length ? b : a;
  const offset = longer.length - shorter.length;
  shorter.forEach((count, i) => { longer[offset + i] += count; });
  return longer;
}

/** Stored bytes of one element of `array`, from its whole stored size (no request); its decoded size when the store cannot say. */
async function storedBytesPerElement(array, readOptions) {
  const length = array.shape.reduce((product, extent) => product * extent, 1);
  if (length === 0) return 0;
  try {
    const stored = await array.storedBytes(undefined, readOptions);
    if (Number.isFinite(stored) && stored > 0) return stored / length;
  } catch {
    // A store that cannot say without reading: the decoded size bounds it.
  }
  return elementBytes(array);
}

/**
 * What the first gene of the expression matrix (`expression`: `X` unless
 * the default rule reads another; or a cell-major matrix node itself, as a
 * neighbor graph's rows are priced) read through its gene index costs for the
 * cells an opening keeps, from the layout alone (no pointer is read): the
 * arrays the first gene reads -- a CSR matrix's pointers of the kept rows
 * and their indices, and their values unless they are read per gene by
 * range (`valuesOnDemand`, a data array stored raw: compressed chunks are
 * read whole, and the first gene's entries lie in nearly all of them); a
 * dense one's kept rows -- as the stored chunks the
 * rows lie in (each row taken to hold the mean stored values) and the
 * requests those chunks make. A chunk this browser holds already (kept
 * from an earlier reading of the same version of the file,
 * `io/kept-parts.js`) is read from this machine's disk: it costs no
 * request and no transfer (`keptBytes`: what those chunks hold). Null for
 * a matrix whose genes are read without such a pass (gene-major: CSC,
 * dense read by gene strip, `geneLayoutOf`).
 *
 * The index the first gene finds its chunks through is priced too: the
 * chunk-index reads not done yet (`chunkIndexReads`: an HDF5 chunk B-tree's
 * level-1 nodes and leaves, a sharded Zarr array's shard indexes) are
 * requests of their own, each counted once, and their levels dependent
 * round trips (`steps`), as is a CSR matrix's pointer read before its
 * entries (on a large CELLxGENE atlas most of the first gene's requests
 * are chunk B-tree nodes in five dependent steps: measured,
 * 23_decisions_partial_reading.md).
 *
 * @returns {Promise<(((rows: PricedRows) => {bytes: number, requests: number, keptBytes: number, decodedBytes: number, steps: number[]}) & {values: (rows: PricedRows) => Object})|null>}
 */
export async function firstGeneReadCost(root, nObs, { valuesOnDemand, decodedChunkBytes, columnIndexBytes = residencyBudgetBytes('columnIndex'), readOptions = {}, expression = 'X', mergeGapBytes = 0 }) {
  const matrix = matrixOf(root, nObs, expression);
  if (matrix === null || nObs === 0) return null;
  const chunkOf = array => (Array.isArray(array.chunks) && array.chunks.length > 0 && array.partialChunks !== true ? Number(array.chunks[0]) : 1);
  // A raw array (`partialChunks`) is priced per element, and what this
  // browser holds of it is told per stored chunk (`heldChunkBands`): the
  // stored chunk's elements to a band.
  const unitsPerBandOf = array => (Array.isArray(array.chunks) && array.chunks.length > 0 && array.partialChunks === true ? Number(array.chunks[0]) : 1);
  const parts = [];
  // A raw data array whose values are read per gene by range: each gene
  // reads its own entries in the rows, a request for each stretch of the
  // file one fetch joins (`BYTE_READ_BLOCK_BYTES`) that holds any.
  let byRange = null;
  if (matrix.layout === 'csr') {
    if (matrix.nnz === 0) return null;
    const perRow = matrix.nnz / nObs;
    const entryOf = row => Math.min(matrix.nnz, Math.round(row * perRow));
    // Values read per gene (`valuesOnDemand`) are read by range only from a
    // data array stored raw (`partialChunks`); a compressed one is read in
    // whole chunks, and a gene's entries lie in nearly every chunk of the
    // rows read, so the first gene reads them all (twice the indices alone:
    // measured, 23_decisions_partial_reading.md).
    const data = child(matrix.node, 'data');
    const valuesByRange = valuesOnDemand && isArrayNode(data) && data.partialChunks === true;
    const arrays = [child(matrix.node, 'indices'), ...(valuesByRange ? [] : [data])];
    if (valuesByRange) {
      const [bytes, held] = await Promise.all([storedBytesPerElement(data, readOptions), heldBandsOf(data, readOptions)]);
      byRange = { elementOf: entryOf, bytes, decoded: elementBytes(data), perGene: 1 / Math.max(1, matrix.nVars), held, unitsPerBand: unitsPerBandOf(data) };
    }
    if (!arrays.every(isArrayNode)) return null;
    const indptr = child(matrix.node, 'indptr');
    // Each array's stored size and held chunks at once: each may read its
    // chunk index (a round trip of the opening each, one after another).
    const priced = [...arrays, ...(isArrayNode(indptr) ? [indptr] : [])];
    const sizes = await Promise.all(priced.map(array => Promise.all([storedBytesPerElement(array, readOptions), heldBandsOf(array, readOptions), indexReadsOf(array, readOptions)])));
    priced.forEach((array, i) => {
      const [bytes, held, indexReads] = sizes[i];
      const common = { chunk: chunkOf(array), unitsPerBand: unitsPerBandOf(array), bytes, decoded: elementBytes(array), held, indexReads };
      parts.push(array === indptr ? { elementOf: row => row, ...common, pointers: true } : { elementOf: entryOf, ...common, values: array === data });
    });
  } else if (matrix.layout === 'dense') {
    if (geneLayoutOf(matrix.node, { nObs, nVars: matrix.nVars, decodedChunkBytes, columnIndexBytes }) === 'dense-strips') return null;
    const chunks = Array.isArray(matrix.node.chunks) ? matrix.node.chunks : null;
    const width = matrix.nVars;
    const [bytes, held, indexReads] = await Promise.all([
      storedBytesPerElement(matrix.node, readOptions),
      chunks === null ? null : heldBandsOf(matrix.node, readOptions),
      chunks === null ? null : indexReadsOf(matrix.node, readOptions),
    ]);
    parts.push({ elementOf: row => row * width, chunk: chunks === null ? 1 : chunks[0] * width, bytes, decoded: elementBytes(matrix.node), held, indexReads, values: true });
  } else {
    return null;
  }
  // Each read's dependent round trips before its chunks: the chunk index
  // levels it reads (`chunkIndexReads`), and a CSR matrix's pointers before
  // its entries (where they lie is in the pointers), as the floor model
  // prices a step (`scripts/efficiency-floor/floor.mjs`).
  const price = (rows, priced) => {
    let bytes = 0;
    let requests = 0;
    let keptBytes = 0;
    let decodedBytes = 0;
    // Requests by dependent step: the pointers' index levels and their
    // chunks, then the entries' index levels and their chunks (the arrays
    // of one stage read side by side, level for level from their chunks).
    const pointerSteps = [];
    const entrySteps = [];
    const alignEnd = (steps, add) => {
      const offset = steps.length - add.length;
      if (offset < 0) steps.unshift(...new Array(-offset).fill(0));
      const at = Math.max(0, offset);
      add.forEach((count, i) => { steps[at + i] += count; });
    };
    for (const part of priced) {
      const touched = part.indexReads === null ? null : [];
      // A pointer array is read at each kept row and the next (its pointer ends the row).
      // The units of a gap the reader fetches through (`mergeGapBytes`): a
      // stored chunk's bytes each, or an element's of a raw array.
      const unitBytes = (part.unitsPerBand ?? 1) > 1 ? part.bytes : part.chunk * part.bytes;
      const gapUnits = mergeGapBytes > 0 && unitBytes > 0 ? Math.floor(mergeGapBytes / unitBytes) : 0;
      const { chunks, runs, kept, gaps } = rowChunks(rows, part.elementOf, part.chunk, part.pointers ? 1 : 0, part.held, part.unitsPerBand ?? 1, touched, gapUnits);
      bytes += chunks * part.chunk * part.bytes;
      keptBytes += kept * part.chunk * part.bytes;
      // Every chunk read is decoded, a kept one too (read from this machine's disk).
      decodedBytes += (chunks - gaps + kept) * part.chunk * part.decoded;
      const index = touched === null || touched.length === 0 ? { nodes: 0, steps: [] } : part.indexReads(touched);
      requests += runs + index.nodes;
      alignEnd(part.pointers ? pointerSteps : entrySteps, [...index.steps, runs]);
    }
    const steps = [...pointerSteps, ...entrySteps].filter(count => count > 0);
    return { bytes, requests, keptBytes, decodedBytes, steps };
  };
  // One gene's values by range in `rows` (a raw data array): over each run
  // of consecutive rows, the mean gene's entries (a `1 / nVars` share of
  // theirs) fall in the run's fetch stretches, and each stretch holding
  // any is a request (the expected count of stretches hit) of those entries.
  // Entries in a stored chunk this browser holds (`held`, kept from an
  // earlier reading) are read from this machine's disk: no request, no
  // transfer (`keptBytes`), as for the arrays read in whole chunks.
  const priceByRange = rows => {
    let requests = 0;
    let fetched = 0;
    let keptEntries = 0;
    const ask = span => {
      const hits = span * byRange.perGene;
      const stretches = Math.max(1, Math.ceil(span * byRange.bytes / BYTE_READ_BLOCK_BYTES));
      requests += stretches * (1 - Math.exp(-hits / stretches));
      fetched += hits;
    };
    forEachRowSpan(rows, (firstRow, lastRow) => {
      const from = byRange.elementOf(firstRow);
      const to = byRange.elementOf(lastRow + 1);
      if (to <= from) return;
      if (byRange.held === null) {
        ask(to - from);
        return;
      }
      // The span a stored chunk at a time: held stretches kept, the others fetched together.
      let unheld = 0;
      for (let at = from; at < to;) {
        const band = Math.floor(at / byRange.unitsPerBand);
        const end = Math.min(to, (band + 1) * byRange.unitsPerBand);
        if (byRange.held(band)) {
          if (unheld > 0) ask(unheld);
          unheld = 0;
          keptEntries += (end - at) * byRange.perGene;
        } else {
          unheld += end - at;
        }
        at = end;
      }
      if (unheld > 0) ask(unheld);
    });
    return {
      bytes: fetched * byRange.bytes,
      requests: Math.ceil(requests),
      keptBytes: keptEntries * byRange.bytes,
      decodedBytes: (fetched + keptEntries) * byRange.decoded,
      steps: requests > 0 ? [Math.ceil(requests)] : [],
    };
  };
  const withValues = (read, values) => ({
    bytes: read.bytes + values.bytes,
    requests: read.requests + values.requests,
    keptBytes: read.keptBytes + values.keptBytes,
    decodedBytes: read.decodedBytes + values.decodedBytes,
    steps: withLastStep(read.steps, values.steps),
  });
  const cost = rows => (byRange === null ? price(rows, parts) : withValues(price(rows, parts), priceByRange(rows)));
  // The values of rows whose gene index is kept without them (`structure`
  // runs, `kept-column-index.js`): every gene reads them from the file --
  // the value chunks those rows lie in, where values are read in whole
  // chunks; read by range, a gene's own entries in them.
  const valueParts = parts.filter(part => part.values === true);
  cost.values = rows => (byRange === null ? price(rows, valueParts) : priceByRange(rows));
  // Stored bytes a row holds across the arrays read, on average (what one
  // more cell of a sample costs to transfer).
  cost.bytesPerRow = parts.reduce((sum, part) => sum + part.bytes * (part.elementOf(nObs) - part.elementOf(0)), 0) / nObs;
  return cost;
}

/**
 * The block size of a `blocks` order whose size nobody named: the cell
 * order every cell of a file in its own order opens in when genes are read
 * for a sample of them (`cellOrder`), and a `blocks` subsample asked for
 * without a `blockSize` (`specOf`, `{mode: 'auto'}`). The gene sample is
 * then its first blocks, each block a request (or a few: the arrays the
 * first gene reads, `firstGeneReadCost`) of whole stored chunks.
 *
 * **One ladder.** The size is a rung of the file's ladder
 * (`blockSizeLadder`): the storage's block (`defaultBlockSize`, aligned to
 * its chunks) doubled `j` times, so a larger block holds whole smaller ones
 * and every rung stays chunk-aligned. Which rung is chosen depends on what
 * this browser keeps and on the link; the cells it gives do not depend on
 * anything else, and the rung is recorded with them (the subsample's
 * `blockSize`, the opening's `cellOrder`): a session, a link carrying the
 * subsample, Python's and R's `subsample_cells` reproduce the cells from it.
 *
 * **A revisit keeps its rung.** A gene index kept in this browser under a
 * rung's order (`keptIndexRows`) chooses that rung, whatever the link
 * measures now: its cells cost the first gene nothing, and another rung
 * would open other cells and read them again (an atlas reopened in other
 * blocks than its first visit's reads its first gene again, more than the
 * first visit did: measured, 23_decisions_partial_reading.md). Of several
 * kept, the one holding the most cells.
 *
 * **A first visit chooses by request economics.** A block too small to
 * fill its round trip makes the sample request-bound: a block of `b` cells
 * takes `requests` round trips shared by `running` requests at once, and
 * `b` cells' bytes at the link's rate, so below
 * `b* = requests x roundTripBytes / (running x bytesPerRow)` the round
 * trips bind and every halving of `b` halves the cells read in the gene
 * time; above it, bytes bind and a larger `b` reads no more cells, only in
 * fewer, coarser blocks. So the size is the lowest rung at or past `b*`:
 * the most cells in the gene time, in the finest blocks that read them.
 * What the opening measured of the rate is a lower bound: its structure
 * reads are a few requests on connections just made, each delivering at
 * what TCP slow start lets one connection carry, while a gene read keeps
 * dozens of connections busy (a large CELLxGENE atlas measures a small
 * fraction of its rate at its first resolve, its delivery taken for a full
 * link: measured, 23_decisions_partial_reading.md). So the rate is the higher of it and the
 * seed (`seedBytesPerMs`): the rate the host sustained on earlier visits
 * (`host-link-memory.js`) or this browser's own downlink measured on the
 * page's assets (`pageDownlinkBytesPerMs`). An overestimate costs
 * no time (a larger block reads each cell's bytes once, fewer round trips),
 * only coarseness; an underestimate halves the cells per halving. The
 * category shares of the sample against the whole (total variation
 * distance) show that on files whose rows are mixed the block size changes
 * nothing at a given count of cells, so more cells is pure gain; on a file
 * sorted by donor larger blocks at the same count are coarser, but at the
 * same count of blocks -- the same round trips -- they are as good or
 * better (measured: 23_decisions_partial_reading.md). Without a measured
 * link, the storage's block.
 *
 * The rung a share's spread cells open in (`geneSampleOf`, `cellOrder`) is
 * chosen alike; the gene index it looks for is the one kept under the
 * share's order at each rung (`keptOrder(size)`: the order's specification,
 * `openOrderSpecOf`; every cell's `blocks` order unless given).
 *
 * @param {Object} root
 * @param {number} nObs
 * @param {{seed?: number, link?: Object|null, seedBytesPerMs?: number|null, valuesOnDemand: boolean, decodedChunkBytes: number,
 *   readOptions?: Object, expression?: string|null, columnIndexBytes?: number, keptIndexRows?: Function|null,
 *   keptOrder?: (size: number) => Object}} context
 * @returns {Promise<number>}
 */
export async function blockRung(root, nObs, { seed = DEFAULT_SUBSAMPLE_SEED, link = null, seedBytesPerMs = null, valuesOnDemand, decodedChunkBytes, readOptions = {}, expression = 'X', columnIndexBytes, keptIndexRows = null,
  keptOrder = size => ({ method: 'blocks', seed, blockSize: size, nObs, k: nObs }) }) {
  const ladder = blockSizeLadder(root, nObs, expression);
  const matrix = sampledMatrixOf(root, nObs, { expression, decodedChunkBytes });
  if (keptIndexRows !== null && matrix !== null) {
    let kept = { size: null, rows: 0 };
    for (const size of ladder) {
      const { rows } = await keptIndexRows(keptOrder(size), [nObs, matrix.nVars]).catch(() => ({ rows: 0 }));
      if (rows > kept.rows) kept = { size, rows };
    }
    if (kept.size !== null) return kept.size;
  }
  const base = ladder[0];
  if (!linkPriced(link)) return base;
  const cost = await firstGeneReadCost(root, nObs, { valuesOnDemand, decodedChunkBytes, readOptions, expression, ...(columnIndexBytes === undefined ? {} : { columnIndexBytes }) });
  if (cost === null || !(cost.bytesPerRow > 0)) return base;
  // The requests one block makes: a block in the middle of the file.
  const at = Math.max(0, Math.min(nObs - base, Math.floor(nObs / 2)));
  const { requests } = cost(rowRun(at, Math.min(nObs, at + base)));
  const running = Math.max(1, link.shapingConcurrency ?? link.concurrency ?? 1);
  // The link's rate is a lower bound here (module doc): the seed raises it.
  const rate = Math.max(link.bytesPerMs, seedBytesPerMs > 0 ? seedBytesPerMs : 0);
  // `b*` in rungs of the storage's block: requests per block don't grow with it (whole chunks, one run each).
  const needed = Math.max(1, requests) * loadedRoundTripMs(link) * rate / (running * cost.bytesPerRow);
  return ladder.find(size => size >= needed) ?? ladder.at(-1);
}

/**
 * The block sizes a file's `blocks` orders take when nobody names one
 * (`blockRung`): the storage's block (`defaultBlockSize`) and each of its
 * doublings up to the cell count, smallest first. A rung holds whole
 * blocks of every rung below it, each aligned to the storage's chunks.
 *
 * @param {Object} root
 * @param {number} nObs
 * @param {string|null} [expression]
 * @returns {number[]}
 */
export function blockSizeLadder(root, nObs, expression = 'X') {
  const ladder = [defaultBlockSize(root, nObs, expression)];
  while (ladder.at(-1) * 2 <= nObs) ladder.push(ladder.at(-1) * 2);
  return ladder;
}

/**
 * The time `cost` (`{bytes, requests, steps}`) takes over `link` (a
 * measured `LinkMeter` snapshot): whichever binds, a round trip per wave of
 * the requests that really run at once (`shapingConcurrency`: six a host
 * over HTTP/1.1, each mirror its own) in each dependent step -- `steps`,
 * the requests of each read that must end before the next is known (index
 * levels, pointers before entries: the floor model's `floorOf`; one step of
 * every request without them) -- or a round trip a step and the bytes at
 * the measured rate (bytes flow while other requests wait for their first).
 * A round trip is the link's under load (`loadedRoundTripMs`), not its
 * shortest: priced at the shortest, a read of many requests at once comes
 * out far below its time (measured: 23_decisions_partial_reading.md).
 */
export function linkReadMs({ bytes, requests, steps = null }, link) {
  const running = Math.max(1, link.shapingConcurrency ?? link.concurrency ?? 1);
  // A host whose request budget binds lets one request through per its
  // interval (`requestCostMs`, `hosts.js`), however fast it answers.
  const budgetMs = Math.max(1, requests) * (link.requestCostMs ?? 0);
  // Each dependent step (an index level, pointers before entries) is a
  // wave of round trips the next waits for; the bytes pass after the steps
  // before the last.
  const waves = steps === null || steps.length === 0
    ? [Math.max(1, requests)]
    : steps;
  // A request under load takes longer than the shortest seen (`loadedRoundTripMs`).
  const roundTripMs = loadedRoundTripMs(link);
  let turnsMs = 0;
  for (const count of waves) turnsMs += Math.ceil(Math.max(1, count) / running) * roundTripMs;
  return Math.max(turnsMs, waves.length * roundTripMs + bytes / link.bytesPerMs, budgetMs);
}

/**
 * The time a first gene's read (`firstGeneReadCost`) takes here: over the
 * link (`linkReadMs`) or decoding its chunks, whichever is longer -- chunks
 * decode as they arrive, a kept one as it is read from disk
 * (`decodedBytes` at the rate chunks are measured to decode here, every
 * decoder together: `decodingRate`); the link's alone before any chunk is
 * decoded. The one cost model the gene sample is fitted by and its growth
 * priced by (`geneTimeFit`, `AnnDataReader.geneSampleCost`).
 *
 * @param {{bytes: number, requests: number, decodedBytes?: number}} cost
 * @param {Object} link - A measured link (`linkPriced`)
 * @param {number|null} [decodeBytesPerMs]
 * @returns {number}
 */
export function geneReadMs(cost, link, decodeBytesPerMs = decodingRate()) {
  return Math.max(linkReadMs(cost, link), decodeMs(cost, decodeBytesPerMs));
}

/** The time decoding a read's chunks takes here (`geneReadMs`): none before any chunk is measured to decode. */
function decodeMs(cost, decodeBytesPerMs) {
  return decodeBytesPerMs > 0 && cost.decodedBytes > 0 ? cost.decodedBytes / decodeBytesPerMs : 0;
}

/** Whether a link snapshot is measured enough to price a read (a round trip and a rate). */
export function linkPriced(link) {
  return link !== null && link !== undefined && link.bytesPerMs > 0 && Number.isFinite(link.latencyMs) && link.latencyMs >= 0;
}

/**
 * The largest count of the first open cells, at most `upper`, whose first
 * gene is read within `targetMs` over `link` (`firstGeneReadCost`,
 * `linkReadMs`), or null when all `upper` are: the gene sample's time fit
 * (`geneSampleOf`). `rowsAt(k)`: the file rows (ascending) the first gene
 * must read for the first `k` open cells (`rows`), and how many of them are
 * left out because a gene index of them is kept in this browser
 * (`indexed`: the first open cells, `kept-column-index.js`
 * `keptIndexPrefix`). What this browser keeps of the file costs nothing
 * (`firstGeneReadCost`): on a later visit genes are read for more cells
 * within the target, and `kept` says how many cells' index and how many
 * bytes were kept (null when nothing was).
 *
 * **A link with no price.** A link read over the network (not read ahead:
 * `readsAhead`) on which no rate is measured yet nor remembered
 * (`linkPriced` false: a later visit whose opening read all it needed from
 * what this browser keeps, or only checked the file's version, its host's
 * speed forgotten or never kept) cannot price a cell read from the file.
 * (A link whose requests all ended within the clock's resolution -- busy,
 * no round trip measured: `busyMs`, `latencyMs` -- is faster than can be
 * priced, and no time binds it.) Such a cell is never
 * taken as free: the sample is the cells that cost the first gene no
 * request and no byte (those whose gene index or chunks are kept here),
 * at least `FEWEST_OPEN_CELLS`, and `neededMs` and `sampleMs` are null (not
 * known). The first gene then measures the link, and the page's top-up
 * reads genes for more cells within the gene time
 * (`DataState.topUpGeneSample`). Priced as free, a revisit with nothing
 * measured would take the gene index's memory fit, and its first gene would
 * read far more than the first visit's (measured:
 * 23_decisions_partial_reading.md).
 *
 * **A later visit answers from what it kept.** When the cells whose gene
 * index is kept here lead the open order (`breaks`: the kept runs' ends
 * from the first open cell), the first gene is read for them alone, the
 * kept runs ending within the count the target prices: no new cell, so
 * coming back is never slower than the first visit (a revisit priced at
 * the remembered rate would read thousands of new cells with its first
 * gene: measured, 23_decisions_partial_reading.md). The
 * count priced is returned as `growTo` (null over a link with no price):
 * the page's top-up reads genes for those cells first, in the background,
 * then grows on by what its reads take (`DataState.topUpGeneSample`).
 *
 * @returns {Promise<{cells: number, limit: 'geneTime', budgetMs: number, neededMs: number|null, sampleMs: number|null, neededCells: number,
 *   layout: 'csr'|'dense-rows'|'dense-wide-strips', matrix: string, kept: {cells: number, bytes: number}|null, bytes: number, requests: number,
 *   growTo: number|null}|null>}
 */
export async function geneTimeFit(root, nObs, upper, { link, targetMs, valuesOnDemand, decodedChunkBytes, columnIndexBytes = residencyBudgetBytes('columnIndex'), rowsAt, readOptions = {}, expression = 'X', decodeBytesPerMs = decodingRate(), breaks = [], ceiling = { bytes: Infinity, requests: Infinity } }) {
  // A link read over the network with nothing measured nor remembered (doc above).
  const unpriced = link !== null && link !== undefined && link.readsAhead !== true && !linkPriced(link) && !(link.busyMs > 0 && !Number.isFinite(link.latencyMs));
  if ((!unpriced && !linkPriced(link)) || !(targetMs > 0) || upper <= FEWEST_OPEN_CELLS) return null;
  // Priced as the byte reader fetches: through the gaps the link's merge gap spans.
  const cost = await firstGeneReadCost(root, nObs, { valuesOnDemand, decodedChunkBytes, columnIndexBytes, readOptions, expression, mergeGapBytes: link.mergeGapBytes ?? 0 });
  if (cost === null) return null;
  const costAt = async k => {
    const { rows, indexed, valueRows = null } = await rowsAt(k);
    const read = cost(rows);
    if (valueRows === null || rowCountOf(valueRows) === 0) return { ...read, indexed };
    // The kept rows' values, read beside the rest in the same burst.
    const values = cost.values(valueRows);
    return {
      bytes: read.bytes + values.bytes,
      requests: read.requests + values.requests,
      keptBytes: read.keptBytes + values.keptBytes,
      decodedBytes: read.decodedBytes + values.decodedBytes,
      steps: withLastStep(read.steps, values.steps),
      indexed,
    };
  };
  // Over a link with no price, a read that fetches nothing takes what
  // decoding the kept chunks takes, and one that fetches anything is not
  // known (Infinity: never within the target).
  const msOf = priced => (unpriced
    ? (priced.bytes > 0 || priced.requests > 0 ? Infinity : decodeMs(priced, decodeBytesPerMs))
    : geneReadMs(priced, link, decodeBytesPerMs));
  const timeAt = async k => msOf(await costAt(k));
  // Within the time and, when given, within `ceiling`'s bytes and requests.
  const bounded = Number.isFinite(ceiling.bytes) || Number.isFinite(ceiling.requests);
  const fitsAt = async k => {
    const cost = await costAt(k);
    return msOf(cost) <= targetMs && cost.bytes <= ceiling.bytes && cost.requests <= ceiling.requests;
  };
  const neededMs = await timeAt(upper);
  // Every open cell within the target: no sample, unless cells kept here
  // lead the open order and others are not kept -- those answer first (doc
  // above), and the rest is the count priced. A kept run reaching to the
  // last open cell or past it holds every one.
  const allFit = neededMs <= targetMs && (!bounded || await fitsAt(upper));
  if (allFit && (breaks.some(end => end >= upper) || !breaks.some(end => end > 0 && end < upper))) return null;
  // The time rises with the cells between the rows where kept runs end
  // (`breaks`: a sample takes the runs ending within it) and drops at each:
  // the largest count within the target is in the highest stretch whose
  // first count is, found by halving there.
  const starts = [FEWEST_OPEN_CELLS, ...breaks.filter(end => end > FEWEST_OPEN_CELLS && end < upper)].sort((a, b) => a - b);
  let low = allFit ? upper : FEWEST_OPEN_CELLS;
  for (let s = allFit ? -1 : starts.length - 1; s >= 0; s--) {
    const from = starts[s];
    const to = (s + 1 < starts.length ? starts[s + 1] : upper) - 1;
    if (s > 0 && !await fitsAt(from)) continue;
    low = from;
    let high = to;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (await fitsAt(mid)) low = mid;
      else high = mid - 1;
    }
    break;
  }
  // The layout as `geneReadCost` names it (the notice says why from it),
  // and the matrix it is of.
  const { node, nVars } = matrixOf(root, nObs, expression);
  const layout = geneLayoutOf(node, { nObs, nVars, decodedChunkBytes, columnIndexBytes });
  // A later visit answers its first gene from the cells kept here (doc
  // above): the kept runs ending within the count priced, no new cell; the
  // count priced is what the page's top-up reads first (`growTo`).
  const keptEnd = breaks.filter(end => end > 0 && end <= low).reduce((a, b) => Math.max(a, b), 0);
  const growTo = keptEnd > 0 && keptEnd < low && !unpriced ? low : null;
  const cells = keptEnd > 0 ? keptEnd : low;
  const chosen = await costAt(cells);
  const kept = chosen.indexed > 0 || chosen.keptBytes > 0 ? { cells: chosen.indexed, bytes: chosen.keptBytes } : null;
  // Times a link with no price cannot tell: not known (null).
  const known = ms => (Number.isFinite(ms) ? ms : null);
  return { cells, limit: 'geneTime', budgetMs: targetMs, neededMs: known(neededMs), sampleMs: known(msOf(chosen)), neededCells: upper, layout, matrix: matrixLabel(expression), kept, bytes: chosen.bytes, requests: chosen.requests, growTo };
}

/**
 * What the gene index of one expression matrix holds in memory once built
 * (`columnIndexResidentBytes`), as a part that does not depend on the cells
 * (`base`, its genes) and a part per cell of the dataset (`perCell`; a
 * modality measuring some of the cells keeps that share of them per cell),
 * or null when its genes are read without an index (CSC, dense read by gene
 * strip: `geneLayoutOf`, decided with `layoutBytes` of index budget).
 */
function indexBytesOf(matrix, nCells, nObs, { valuesOnDemand, decodedChunkBytes, layoutBytes }) {
  if (matrix === null || nCells === 0 || nObs === 0) return null;
  if (matrix.layout === 'csr') {
    // Values in chunks read whole are bought with the first gene (`buysValues`) and held beside the positions.
    const valuesBought = valuesOnDemand && readInWholeChunks(child(matrix.node, 'data'));
    const base = columnIndexResidentBytes({ layout: 'sparse', nnz: 0, nObs: 0, nVars: matrix.nVars, valuesOnDemand, valuesBought });
    const bytes = columnIndexResidentBytes({ layout: 'sparse', nnz: matrix.nnz, nObs: nCells, nVars: matrix.nVars, valuesOnDemand, valuesBought });
    return { base, perCell: (bytes - base) / nObs, bytes };
  }
  // A dense matrix read by gene strip has no index (`geneLayoutOf`).
  if (matrix.layout === 'dense' && geneLayoutOf(matrix.node, { nObs: nCells, nVars: matrix.nVars, decodedChunkBytes, columnIndexBytes: layoutBytes }) !== 'dense-strips') {
    const bytes = columnIndexResidentBytes({ layout: 'dense', nObs: nCells, nVars: matrix.nVars });
    return { base: 0, perCell: bytes / nObs, bytes };
  }
  return null;
}

/**
 * The root expression matrix (`expression`) when its genes are read for a
 * gene sample: indexed in segments over the open rows, so a gene is read for
 * the first open cells only (`reader/gene-segments.js`, `_indexedInSegments`): a matrix
 * read through a row index (`readsThroughRowIndex`: CSR, dense in row
 * chunks or in strips indexed whole) that is the dataset's own, not a
 * modality's presented at the root. Null for any other.
 */
function sampledMatrixOf(root, nObs, { expression, decodedChunkBytes }) {
  const matrix = matrixOf(root, nObs, expression);
  if (matrix === null || matrix.layout === 'csc' || matrix.layout === 'other' || nObs === 0) return null;
  if (matrix.node.path.replace(/^\/+/, '').startsWith('mod/')) return null;
  return readsThroughRowIndex(matrix.node, { nObs, nVars: matrix.nVars, decodedChunkBytes }) ? matrix : null;
}

/**
 * The largest cell count whose open cells fit this device, or null when
 * every cell fits: the map's fit, of the per-cell working set and the gene
 * indexes the open cells hold whatever genes are read for (each modality's
 * `X`, and a root expression matrix not read for a gene sample:
 * `sampledMatrixOf`). The root expression matrix of a gene sample is
 * weighed by its own fit (`geneIndexFit`): its index holds the sample's
 * cells, not the open ones.
 *
 * @param {Object} root
 * @param {number} nObs
 * @param {{valuesOnDemand: boolean, decodedChunkBytes: number, allowanceBytes?: number, columnIndexBytes?: number|null, expression?: string|null}} context -
 *   `columnIndexBytes`: a fixed gene-index budget; by default the
 *   `columnIndex` share of what the working set of the cells opened leaves
 *   of `allowanceBytes`
 * @returns {{k: number, limit: 'cells'|'columnIndex', budgetBytes: number, neededBytes: number}|null}
 */
export function autoFitCount(root, nObs, { valuesOnDemand, decodedChunkBytes, allowanceBytes = memoryAllowanceBytes(), columnIndexBytes = null, expression = 'X' }) {
  if (nObs === 0) return null;
  const limits = [];
  const cellBytes = nObs * CELL_WORKING_SET_BYTES;
  if (cellBytes > allowanceBytes) {
    limits.push({ k: Math.floor(allowanceBytes / CELL_WORKING_SET_BYTES), limit: 'cells', budgetBytes: allowanceBytes, neededBytes: cellBytes });
  }
  // The gene index may use its share of what the working set of the cells
  // opened leaves of the allowance (`memory-budget.js`).
  const share = RESIDENCY_SHARES.columnIndex;
  const indexBudgetAt = cells => columnIndexBytes ?? Math.floor(Math.max(0, allowanceBytes - cells * CELL_WORKING_SET_BYTES) * share);
  // A dense matrix's layout is decided as it would be with every cell that fits open.
  const layoutBytes = indexBudgetAt(Math.min(nObs, Math.floor(allowanceBytes / CELL_WORKING_SET_BYTES)));
  // Every expression index the open cells hold: the root's expression
  // matrix unless its genes are read for a gene sample, and each modality's
  // X. A matrix presented twice (a default modality's X at the root) counts
  // once.
  const sampled = sampledMatrixOf(root, nObs, { expression, decodedChunkBytes });
  const matrices = sampled === null ? [{ group: root, nCells: nObs, path: expression }] : [];
  for (const modality of Array.isArray(root.modalities) ? root.modalities : []) {
    matrices.push({ group: child(child(root, 'mod'), modality.name), nCells: modality.nCells, path: 'X' });
  }
  const seen = new Set();
  let fixed = 0;
  let perCell = 0;
  let indexBytes = 0;
  for (const { group, nCells, path } of matrices) {
    const matrix = group === null ? null : matrixOf(group, nCells, path);
    if (matrix === null || seen.has(matrix.node.path)) continue;
    seen.add(matrix.node.path);
    const cost = indexBytesOf(matrix, nCells, nObs, { valuesOnDemand, decodedChunkBytes, layoutBytes });
    if (cost === null) continue;
    indexBytes += cost.bytes;
    fixed += cost.base;
    perCell += cost.perCell;
  }
  if (indexBytes > indexBudgetAt(nObs) && perCell > 0) {
    // fixed + perCell·k <= share · (allowance − CELL_WORKING_SET_BYTES·k), or a fixed budget.
    const k = columnIndexBytes !== null
      ? Math.floor((columnIndexBytes - fixed) / perCell)
      : Math.floor((share * allowanceBytes - fixed) / (perCell + share * CELL_WORKING_SET_BYTES));
    limits.push({ k, limit: 'columnIndex', budgetBytes: indexBudgetAt(Math.max(0, k)), neededBytes: indexBytes });
  }
  if (limits.length === 0) return null;
  const tightest = limits.reduce((a, b) => (b.k < a.k ? b : a));
  // At least the fewest cells the viewer draws (`FEWEST_OPEN_CELLS`); a
  // dataset of no more than that opens whole.
  if (nObs <= FEWEST_OPEN_CELLS) return null;
  return { ...tightest, k: Math.max(FEWEST_OPEN_CELLS, Math.min(nObs - 1, tightest.k)) };
}

/**
 * The largest count of the first open cells whose gene index of the root
 * expression matrix (`expression`, `sampledMatrixOf`) fits the
 * `columnIndex` share of what the working set of the `nOpen` open cells
 * leaves of the allowance (or a fixed `columnIndexBytes`), or null when
 * every open cell's does: the gene sample's memory fit (`geneSampleOf`).
 *
 * @returns {{cells: number, limit: 'columnIndex', budgetBytes: number, neededBytes: number, neededCells: number, layout: string, matrix: string}|null}
 */
export function geneIndexFit(root, nObs, nOpen, { valuesOnDemand, decodedChunkBytes, allowanceBytes = memoryAllowanceBytes(), columnIndexBytes = null, expression = 'X' }) {
  const matrix = sampledMatrixOf(root, nObs, { expression, decodedChunkBytes });
  if (matrix === null || nOpen === 0) return null;
  const budget = columnIndexBytes ?? Math.floor(Math.max(0, allowanceBytes - nOpen * CELL_WORKING_SET_BYTES) * RESIDENCY_SHARES.columnIndex);
  const cost = indexBytesOf(matrix, nObs, nObs, { valuesOnDemand, decodedChunkBytes, layoutBytes: budget });
  if (cost === null || cost.perCell <= 0) return null;
  const needed = cost.base + cost.perCell * nOpen;
  if (needed <= budget) return null;
  const cells = Math.max(1, Math.min(nOpen - 1, Math.floor((budget - cost.base) / cost.perCell)));
  const layout = geneLayoutOf(matrix.node, { nObs, nVars: matrix.nVars, decodedChunkBytes, columnIndexBytes: budget });
  return { cells, limit: 'columnIndex', budgetBytes: budget, neededBytes: needed, neededCells: nOpen, layout, matrix: matrixLabel(expression) };
}

/**
 * A field's strata, read whole: a categorical field's codes and category
 * count; a column of text (AnnData's `string-array` and
 * `nullable-string-array`, a Loom column attribute) made categories in
 * code-point order, as the specification says of plain values (Python's
 * pandas `Categorical`), a missing value in none (code -1).
 */
async function readCodes(root, field, readOptions) {
  // The column's parts load with it (`formats/store.js`, `Group.load`).
  await root.load([`obs/${field}`], readOptions);
  const column = child(child(root, 'obs'), field);
  if (column === null) throw subsampleRefused(`A stratified subsample needs the obs field '${field}', which this dataset does not have.`);
  if (isGroup(column) && encodingType(column) === 'categorical') {
    const codesNode = column.get('codes');
    const categories = column.get('categories');
    const codes = await readStored(codesNode, 0, codesNode.shape[0], `obs['${field}'] codes`, readOptions);
    // Signed or unsigned codes of up to 32 bits are kept as read; 64-bit ones narrowed.
    if (ArrayBuffer.isView(codes) && !(codes instanceof BigInt64Array) && !(codes instanceof BigUint64Array)) return { codes, nCategories: categories.shape[0] };
    const narrowed = allocateTypedArray(Int32Array, codes.length, `obs['${field}'] codes`);
    for (let i = 0; i < codes.length; i++) narrowed[i] = Number(codes[i]);
    return { codes: narrowed, nCategories: categories.shape[0] };
  }
  let values = null;
  if (isArrayNode(column) && valueKind(column) === 'string') {
    values = await readStored(column, 0, column.shape[0], `obs['${field}']`, readOptions);
  } else if (isGroup(column) && encodingType(column) === 'nullable-string-array') {
    values = (await readNullableValues(column, field, 'nullable-string-array', 'AnnData', null, null, readOptions)).values;
  }
  if (values === null) throw subsampleRefused(`A stratified subsample needs a categorical or text field; obs['${field}'] is neither.`);
  const present = new Set();
  for (const value of values) if (value !== null && value !== undefined) present.add(String(value));
  const categories = [...present].sort(compareCodePoints);
  const codeOf = new Map(categories.map((category, code) => [category, code]));
  const codes = allocateTypedArray(Int32Array, values.length, `obs['${field}'] codes`);
  for (let i = 0; i < values.length; i++) codes[i] = values[i] === null || values[i] === undefined ? -1 : codeOf.get(String(values[i]));
  return { codes, nCategories: categories.length };
}

/** Columns of an obsm embedding as row-major float32, read whole. */
async function readEmbeddingColumns(root, key, columns, readOptions) {
  const array = child(child(root, 'obsm'), key);
  if (!isArrayNode(array)) throw subsampleRefused(`A spatial subsample needs the embedding obsm['${key}'], which this dataset does not have as a dense array.`);
  if (!['float', 'int', 'uint'].includes(valueKind(array))) throw subsampleRefused(`A spatial subsample needs numeric coordinates; obsm['${key}'] is not numeric.`);
  const width = array.shape[1] ?? 1;
  for (const column of columns) {
    if (column >= width) throw subsampleRefused(`A spatial subsample reads column ${column} of obsm['${key}'], which has ${formatCountOf(width, 'column')}.`);
  }
  const n = array.shape[0];
  const out = allocateTypedArray(Float32Array, n * columns.length, `obsm['${key}']`);
  const from = Math.min(...columns);
  const to = Math.max(...columns) + 1;
  const options = array.shape.length === 1 ? readOptions : { ...readOptions, columns: [from, to] };
  for await (const slab of readRowSlabs(array, 0, n, options)) {
    const block = slab.values;
    const blockWidth = array.shape.length === 1 ? 1 : to - from;
    for (let row = slab.rowStart; row < slab.rowEnd; row++) {
      columns.forEach((column, c) => {
        out[row * columns.length + c] = Number(block[(row - slab.rowStart) * blockWidth + column - from]);
      });
    }
  }
  return out;
}

/** The embedding a spatial subsample uses unless one is named: the best-ranked usable array of two columns or more. */
function defaultEmbedding(root, nObs) {
  const obsm = child(root, 'obsm');
  if (!isGroup(obsm)) return null;
  const keys = obsm.keys();
  // The one ranked order embeddings are chosen by (`bestGuessOrder`, as the
  // data mapping's defaults): a dense numeric array of two columns or more,
  // one row per cell, never a vector field drawn on another array.
  const vectorKeys = vectorFieldKeys(keys);
  const usable = keys.filter(key => {
    if (vectorKeys.has(key)) return false;
    const node = obsm.get(key);
    return isArrayNode(node) && node.shape[0] === nObs && node.shape.length === 2 && node.shape[1] >= 2
      && ['float', 'int', 'uint'].includes(valueKind(node));
  });
  return bestGuessOrder(usable)[0] ?? null;
}

/**
 * A subsample request's specification, complete: every default filled in
 * from the store.
 */
function specOf(request, root, nObs, expression = 'X') {
  const method = request.method;
  if (!SUBSAMPLE_METHODS.includes(method)) throw new RangeError(`Unknown subsample method '${String(method)}'`);
  let k;
  if (request.k !== undefined && request.k !== null) k = request.k;
  else if (request.percent !== undefined && request.percent !== null) k = countFromShare(request.percent, nObs, { percent: true });
  else if (request.fraction !== undefined && request.fraction !== null) k = countFromFraction(request.fraction, nObs);
  else throw new TypeError('A subsample request names its size: k, percent or fraction');
  if (!Number.isSafeInteger(k) || k < 1) throw new RangeError(`A subsample keeps at least one cell; ${String(k)} was asked for`);
  if (k >= nObs) return null;
  // Never raised to the fewest cells the viewer draws: refused, in the
  // control's words (`describeShare`), whether a count or a share asked
  // for it.
  if (k < FEWEST_OPEN_CELLS) {
    const share = request.k !== undefined && request.k !== null
      ? formatCountOf(k, 'cell')
      : `${request.percent !== undefined && request.percent !== null ? formatPercent(Number(request.percent), { figures: 6 }) : String(request.fraction)} of ${formatCountOf(nObs, 'cell')} (${formatCountOf(k, 'cell')})`;
    throw new RangeError(`A subsample of ${share} cannot open: ${FEWEST_OPEN_CELLS_REASON}, so at least ${formatCountOf(FEWEST_OPEN_CELLS, 'cell')} open.`);
  }
  const spec = { method, nObs, k, seed: request.seed ?? DEFAULT_SUBSAMPLE_SEED };
  // A `blocks` size left out is the ladder's rung, chosen before (`blockRung`).
  if (method === 'blocks') spec.blockSize = request.blockSize;
  if (method === 'stratified') {
    if (typeof request.field !== 'string' || request.field === '') throw new TypeError('A stratified subsample names its categorical obs field');
    spec.field = request.field;
    spec.allocation = request.allocation ?? 'proportional';
    if (!STRATIFIED_ALLOCATIONS.includes(spec.allocation)) throw new RangeError(`Unknown allocation '${String(spec.allocation)}'`);
    spec.minPerCategory = request.minPerCategory ?? 0;
  }
  if (method === 'spatial') {
    const embedding = request.embedding ?? defaultEmbedding(root, nObs);
    if (embedding === null) throw subsampleRefused('A spatial subsample needs an embedding, and this dataset has no two-dimensional one.');
    spec.embedding = embedding;
    spec.columns = request.columns ?? [0, 1];
    spec.gridSize = request.gridSize ?? DEFAULT_GRID_SIZE;
  }
  return requireSubsampleSpec(spec);
}

/**
 * The kept cells of a specification, reading what its method needs.
 *
 * Selected through `cache` (`subsample.js` `createSubsampleCache`): an
 * opening's cache selects every size of one subsample from one rank pass
 * (a growth's steps), and a `stratified` or `spatial` size its strata
 * already hold reads no field or embedding again.
 *
 * @param {Object} root
 * @param {Readonly<import('../subsample.js').SubsampleSpec>} spec
 * @param {Object} readOptions
 * @param {(() => Promise<Uint32Array>)|null} [fileOrder] - A priority-ordered file's row order
 * @param {ReturnType<typeof import('../subsample.js').createSubsampleCache>} [cache]
 * @returns {Promise<Uint32Array|null>}
 */
export async function keptCellsOf(root, spec, readOptions = {}, fileOrder = null, cache = createSubsampleCache()) {
  // Per-cell inputs are read in file order and put in original order: the
  // specification is over original positions, whatever order a file keeps.
  const original = async (values, width) => {
    if (fileOrder === null) return values;
    const out = allocateTypedArray(values.constructor, values.length, 'Per-cell values in original order');
    const order = await fileOrder();
    for (let row = 0; row < order.length; row++) {
      for (let c = 0; c < width; c++) out[order[row] * width + c] = values[row * width + c];
    }
    return out;
  };
  switch (spec.method) {
    case 'uniform': return cache.uniform(spec.nObs, spec.k, spec.seed);
    case 'blocks': return cache.blocks(spec.nObs, spec.k, spec.seed, spec.blockSize);
    case 'stratified': {
      const name = `stratified:${spec.nObs}:${spec.seed}:${spec.field}`;
      const held = cache.heldStrata(name, spec.k, spec.allocation, spec.minPerCategory);
      if (held !== null) return held;
      const { codes, nCategories } = await readCodes(root, spec.field, readOptions);
      return cache.stratified(name, await original(codes, 1), nCategories, spec.k, spec.seed, { allocation: spec.allocation, minPerCategory: spec.minPerCategory });
    }
    case 'spatial': {
      const name = `spatial:${spec.nObs}:${spec.seed}:${spec.embedding}:${spec.columns.join(',')}:${spec.gridSize}`;
      const held = cache.heldStrata(name, spec.k, 'balanced', 0);
      if (held !== null) return held;
      const coordinates = await readEmbeddingColumns(root, spec.embedding, spec.columns, readOptions);
      return cache.spatial(name, await original(coordinates, spec.columns.length), spec.columns.length, spec.k, spec.seed, { gridSize: spec.gridSize });
    }
    default: throw new RangeError(`Unknown subsample method '${String(spec.method)}'`);
  }
}

/**
 * What an opening keeps (see the module comment).
 *
 * @typedef {Object} CellSubsetResolution
 * @property {number} nObs - Cells in the file
 * @property {Uint32Array|null} kept - Ascending original positions; null: every cell
 * @property {Readonly<import('../subsample.js').SubsampleSpec>|null} spec
 * @property {{k: number, limit: 'cells'|'columnIndex', budgetBytes: number, neededBytes: number}|null} autoFit -
 *   Why fewer cells than asked are open: the map's fit (`autoFitCount`)
 * @property {GeneSample|null} genes - The open cells genes are read for (`geneSampleOf`); null: every open cell
 * @property {Readonly<CellOrder>|null} cellOrder - Every cell of a file in its own order, or a share spread
 *   through it, opened in the priority order of its default subsample (a share's cells filtered), so the
 *   gene sample is the first blocks of it (`geneSampleOf`); else null
 * @property {{cells: number, target: number}|undefined} part - A step of a share growing in its order
 *   (`prefixStep`): its first `cells` of the share's `target`
 * @property {boolean|null} reproduced - A restored set: whether its specification gives it again
 * @property {string|null} note - What became of a tab's request this dataset could not take as asked, and
 *   why a priority order the file records is not used (`readPriorityLayout`'s notice)
 * @property {Uint32Array|null} fileRows - The file row of each open cell, in open order; null: every row
 * @property {Uint32Array|null} openOrder - Original position of each open cell, in open order
 *   (a subsample's priority order, `priorityOrder`); null when open cell `i` is `kept[i]` (or `i`),
 *   or while `openOrderRead` reads it
 * @property {Promise<Uint32Array>|undefined} openOrderRead - A priority-ordered file opened whole, or
 *   as its first k rows: the read of the open cells' original positions, issued with the rest of
 *   opening; the reader settles it into `openOrder` before the open finishes
 * @property {number|null} prefix - k when the open cells are file rows [0, k)
 * @property {number|null} prioritySeed - A priority-ordered file's seed, else null
 * @property {boolean} ordered - Whether open order is a priority order (`placeInFile`)
 */

/**
 * Resolve a request against a store root.
 *
 * @param {Object} root
 * @param {Object|null} request
 * @param {{valuesOnDemand: boolean, decodedChunkBytes: number, readOptions?: Object,
 *   budgets?: {allowanceBytes?: number, columnIndexBytes?: number}, link?: Object|null, geneTargetMs?: number,
 *   keptIndexRows?: ((spec: Object|null, shape: number[]) => Promise<{rows: number, ends?: number[], values: boolean}>)|null, expression?: string|null}} context - `budgets`:
 *   the device's budgets (`memory-budget.js`) unless given; `link`: the link to the store as measured
 *   (a `LinkMeter` snapshot), which the gene sample prices a cell-major matrix's first gene at
 *   (`geneTimeFit`, within `geneTargetMs`, `GENE_READ_TARGET_MS` unless given); `keptIndexRows(spec, shape)`:
 *   how many of the first open cells in the priority order of `spec`'s method and settings (null: file
 *   order) have their gene index of the expression matrix (of `shape`) kept in this browser
 *   (`kept-column-index.js` `keptIndexPrefix`); `expression`: the matrix genes are read from
 *   (`defaultExpressionPath`); `subsampleCache`: the opening's (`subsample.js` `createSubsampleCache`,
 *   held by the reader), so each size of one subsample it resolves (a growth's steps, Apply) ranks no
 *   cell again; a cache of this resolution alone unless given
 * @returns {Promise<CellSubsetResolution>}
 */
export async function resolveCellSubset(root, request, context) {
  const nObs = storeCellCount(root);
  const cache = context.subsampleCache ?? createSubsampleCache();
  const resolving = { ...context, subsampleCache: cache };
  // A record that does not describe the file's cells is no layout: the file
  // is read as one Cellucid did not write, and its notice says why.
  const { layout: priority, notice } = await readPriorityLayout(root, nObs, context.readOptions ?? {});
  let order = null;
  // Every row's original position, computed from the seed and checked
  // against the stored column's first rows (`priority-layout.js`): every
  // cell in the rank order of the file's seed, so its uniform subsamples
  // under that seed are taken from it as prefixes, nothing ranked again.
  const fileOrder = priority === null ? null : () => (order ??= priority.order().then(positions => {
    cache.adoptRankOrder(nObs, priority.seed, positions);
    return positions;
  }));
  const resolution = await resolveInOriginalSpace(root, request, nObs, priority, fileOrder, resolving);
  const note = [notice, resolution.note].filter(text => text !== null).join('. ') || null;
  const placed = { ...resolution, note, ...await placeInFile(resolution, nObs, priority, fileOrder, cache) };
  // A step of a subsample grown from few chunks is not in priority order:
  // genes are read for its cells once it is (the last step, `kept`).
  if (request?.mode === 'chunks') return chunkStep({ ...placed, genes: null, cellOrder: null }, request.chunks, priority);
  return geneSampleOf(root, nObs, placed, request, priority, resolving);
}

/**
 * Which open cells a gene is read for (`genes`), and how many.
 *
 * The map of an opening and its genes cost per cell on very different
 * scales: a cell on the map is a few bytes of positions and codes; a gene of
 * a matrix read through a row index (CSR, or dense in row chunks: every
 * gene spread over every cell's row, `sampledMatrixOf`) costs the cell's
 * whole row to read once and its entries to keep in the gene index. So the
 * map opens every cell the device holds (`autoFitCount`) and a gene is read
 * for the **gene sample**: the first `cells` open cells in priority order,
 * the most whose first gene is read within half of `geneTargetMs`
 * (`FIRST_GENE_SHARE`) over the measured link (`geneTimeFit`, the one cost
 * model) and whose gene index fits the memory the open cells leave
 * (`geneIndexFit`), whichever is fewer; the fit's budget is the whole
 * `geneTargetMs`, whose rest the page fills with more cells once the first
 * gene measured the link (`DataState.topUpGeneSample`). The
 * other open cells have no gene value until they are read
 * (`AnnDataReader.growGeneSample`). Every gene of every such matrix is read
 * for the same cells, and a sample grown later is a larger prefix: nothing
 * read is read again. A gene-major matrix (CSC, dense in gene strips, a
 * Cellucid-ready file) reads a gene for every open cell at the cost of its
 * own values: no sample; nor when every open cell fits.
 *
 * **The file's order.** The gene sample is the first open cells, so open
 * order decides what it reads. Every cell of a file in its own order opens
 * in the priority order of the file's default subsample (`cellOrder`:
 * `blocks` at a rung of the file's ladder, `blockRung`, the default seed),
 * so the gene sample of `m` cells is exactly that subsample of `m` cells --
 * whole blocks of the storage, read with no chunk wasted. A share whose
 * cells lie spread through such a file (`uniform`, `stratified`,
 * `spatial`: not whole blocks) opens in the same order, its cells filtered
 * (`shareInCellOrder`): its gene sample is its cells inside the blocks
 * every cell's sample reads first -- a subset of the same reads, so its
 * bytes and time stay within every cell's (its requests may still number
 * more where its cells reach past every cell's blocks; the sample is held
 * to the whole by the `wholeSampleCost` ceiling). In its
 * own priority order each of its first cells lies in a chunk of its own: a
 * uniform share's sample is a tiny fraction of every cell's in the same
 * time (measured: 23_decisions_partial_reading.md). Its cells are exactly as asked (sessions, links and Python's and
 * R's `subsample_cells` give the same set); only their order differs, and
 * the order's rung is recorded beside them (`cellOrder`; a request reading
 * them again names it: `order`). A `blocks` share keeps its own order (its
 * first cells are whole blocks already), a priority-ordered file its file
 * order (`placeInFile`). As for every cell, a share whose every open cell
 * is read anyway (no sample, no order asked for, nothing kept under it)
 * keeps its own priority order. A gene index kept on an earlier visit
 * under the same order counts (`keptIndexRows`).
 *
 * The request may name the sample (`genes`): `'all'` (every open cell, a
 * person's choice), a count (a session's: `fit` null), or a fitted sample
 * carried (`{cells, fit}`, `geneSampleRequestOf`: a progressive opening's
 * steps, the open cells read again: the same count and its fit); a request
 * reading the same cells again names their order too (`order`). Left out,
 * the sample is fitted (`fit` says why it is smaller). A `prefix` request
 * (a step of a share growing in its order, `progressive-open.js`) opens the
 * first `k` cells of that order (`prefixStep`).
 *
 * @typedef {Object} GeneSample
 * @property {number} cells - Genes are read for open cells `[0, cells)`
 * @property {number} of - The open cells
 * @property {Object|null} fit - `geneTimeFit`'s or `geneIndexFit`'s result (the fewer cells), or the one a carried sample was made by; null when a count was chosen
 *
 * @typedef {Object} CellOrder
 * @property {'blocks'} method
 * @property {number} seed
 * @property {number} blockSize
 */
async function geneSampleOf(root, nObs, placed, request, priority, { valuesOnDemand, decodedChunkBytes, readOptions = {}, budgets = {}, link = null, seedBytesPerMs = null, geneTargetMs = GENE_READ_TARGET_MS, keptIndexRows = null, expression = 'X', decodeBytesPerMs = decodingRate(), held = null, subsampleCache, geneSamplesSeen = null }) {
  // A step of a share growing in its order (`prefix`): its first `k` cells.
  const cut = opening => (request?.mode === 'prefix' ? prefixStep(opening, request.k) : opening);
  const none = { ...placed, genes: null, cellOrder: null };
  // The same cells opened before by an opening of these bytes (a share
  // lowered and raised back, Apply of a share open before), when the
  // request names neither sample nor order (`seenGeneSampleOf`): their
  // order (a gene index kept under it is found), and a person's count or
  // every cell read as they were. A sample the gene time sized is fitted
  // again over the link as measured now, but never to fewer cells than were
  // read (`seenFitted`, below), nor to every cell when the gene time read
  // fewer: fitted afresh alone, a large store's sample of millions of cells
  // could become every cell, and reused alone, an opening's sample of a few
  // dozen cells (sized on the link's first small reads, its top-up cut short
  // by the share change) would come back as a few dozen where the measured
  // link reads thousands.
  const seen = request?.genes == null && request?.order === undefined && request?.mode !== 'prefix'
    ? seenGeneSampleOf(geneSamplesSeen, placed)
    : null;
  const seenFitted = seen?.genes?.fit != null ? seen.genes : null;
  const order = request?.order ?? seen?.cellOrder ?? undefined;
  const asked = requireGeneSampleRequest(request?.genes ?? (seen === null || seenFitted !== null ? null : geneSampleRequestOf(seen.genes)));
  const matrix = sampledMatrixOf(root, nObs, { expression, decodedChunkBytes });
  if (matrix === null || (placed.kept === null ? nObs : placed.kept.length) < 1) return cut(none);
  const inOwnOrder = placed.kept === null && priority === null;
  // A share spread through a file in its own order (module doc above).
  const spread = placed.kept !== null && priority === null && placed.spec?.method !== 'blocks';
  if (!inOwnOrder && !spread && placed.ordered !== true) return cut(none);
  const cellOrder = inOwnOrder || spread
    ? requireCellOrder(order ?? {
      method: 'blocks',
      seed: DEFAULT_SUBSAMPLE_SEED,
      blockSize: await blockRung(root, nObs, {
        link, seedBytesPerMs, valuesOnDemand, decodedChunkBytes, readOptions, expression, columnIndexBytes: budgets.columnIndexBytes, keptIndexRows,
        // A share looks for a gene index kept under its own order at each rung.
        ...(spread ? { keptOrder: size => openOrderSpecOf({ nObs, spec: placed.spec, cellOrder: { method: 'blocks', seed: DEFAULT_SUBSAMPLE_SEED, blockSize: size }, fileRows: placed.fileRows }) } : {}),
      }),
    })
    : null;
  // Every cell's order is made only when a sample needs it (below); a
  // share's now, its open cells' rows are what the sample is priced on.
  const opening = cut(spread ? { ...placed, ...shareInCellOrder(placed, cellOrder) } : placed);
  const nOpen = opening.kept === null ? nObs : opening.kept.length;
  // The order a gene index kept in this browser is filed under (`orderKey`):
  // the subsample's (in its cell order), the cell order's, or file order.
  const orderSpec = openOrderSpecOf({ nObs, spec: opening.spec, cellOrder, fileRows: inOwnOrder ? null : opening.fileRows });
  // How many of the first open cells (in this order) have their gene index
  // kept in this browser (`kept-column-index.js` `keptIndexPrefix`): they
  // cost a gene nothing.
  const keptIndex = keptIndexRows === null ? { rows: 0, ends: [], values: true } : await keptIndexRows(orderSpec, [nObs, matrix.nVars]).catch(() => ({ rows: 0, ends: [], values: true }));
  const indexedRows = keptIndex.rows;
  // A sample of `k` open cells takes the kept runs ending within it, from
  // row 0 (`keptIndexPrefix` `ends`): the rows of a run reaching past it are
  // read again.
  const ends = keptIndex.ends ?? (indexedRows > 0 ? [indexedRows] : []);
  const indexedWithin = k => {
    let indexed = 0;
    for (const end of ends) if (end <= k) indexed = end;
    return indexed;
  };
  let cells;
  let fit = null;
  if (asked === 'all') cells = nOpen;
  else if (asked !== null) {
    // A count chosen, or a sample fitted before and carried: its fit stands.
    cells = Math.min(asked.cells, nOpen);
    fit = asked.fit;
  }
  else {
    // The first k open cells' rows (in every cell's order, its `blocks`
    // subsample of k as runs: a step a block, not a cell).
    const rowsOf = prefixRowsOf(inOwnOrder ? null : opening.fileRows, nObs, inOwnOrder ? cellOrder : null, subsampleCache);
    const rowsAt = async k => {
      const indexed = indexedWithin(k);
      if (indexed === 0) return { rows: rowsOf(k), indexed };
      // The first open cells (priority order) whose gene index is kept here
      // are not read for it, but their values are when the kept runs lack
      // them (`valueRows`, their file rows).
      return { rows: rowsOf(k, indexed), indexed, valueRows: keptIndex.values ? null : rowsOf(indexed) };
    };
    const columnIndexBytes = budgets.columnIndexBytes;
    const fitOptions = {
      link,
      targetMs: geneTargetMs * FIRST_GENE_SHARE,
      valuesOnDemand,
      decodedChunkBytes,
      ...(columnIndexBytes === undefined ? {} : { columnIndexBytes }),
      readOptions,
      expression,
      decodeBytesPerMs,
    };
    // A share's sample never transfers more bytes, nor makes more requests,
    // than every cell's would in the same time (`wholeSampleCost`): in the
    // file's cell order its rows lie in every cell's first blocks, and the
    // ceiling holds it there whatever the order (a priority-ordered file's,
    // a `blocks` share's) and however few bytes a block of it holds.
    const ceiling = inOwnOrder ? null : await wholeSampleCost(root, nObs, priority, { ...fitOptions, seedBytesPerMs, subsampleCache, seen: priority === null ? seenGeneSampleOf(geneSamplesSeen, { kept: null }) : null });
    const priced = await geneTimeFit(root, nObs, nOpen, {
      ...(ceiling === null ? {} : { ceiling }),
      link,
      targetMs: geneTargetMs * FIRST_GENE_SHARE,
      valuesOnDemand,
      decodedChunkBytes,
      // The same gene-index budget the memory fit weighs (`geneLayoutOf`).
      ...(columnIndexBytes === undefined ? {} : { columnIndexBytes }),
      readOptions,
      expression,
      rowsAt,
      decodeBytesPerMs,
      breaks: ends,
    });
    // Its budget is the whole gene time, which the page fills after the first gene.
    const time = priced === null ? null : { ...priced, budgetMs: geneTargetMs };
    const memory = geneIndexFit(root, nObs, nOpen, { valuesOnDemand, decodedChunkBytes, ...budgets, expression });
    fit = [time, memory].filter(limit => limit !== null).reduce((a, b) => (a === null || b.cells < a.cells ? b : a), null);
    cells = fit?.cells ?? nOpen;
    if (seenFitted !== null && (cells >= nOpen || seenFitted.cells > cells)) {
      cells = Math.min(seenFitted.cells, nOpen);
      fit = seenFitted.fit;
    }
  }
  // A store holding the matrix rows of its first rows only (`held`: a
  // matrix read after its map, `transcode/matrix-market.js`): the sample
  // ends where they do; the rest of the open cells have no gene value until
  // more of the matrix is read (`fit.limit` 'stream').
  if (held !== null) {
    const heldOpen = heldPrefix(inOwnOrder ? null : opening.fileRows ?? null, nOpen, held.rows);
    if (heldOpen < cells) {
      fit = {
        cells: heldOpen,
        limit: 'stream',
        fitCells: Math.min(nOpen, held.fitCells ?? nOpen),
        matrixBytes: held.bytes ?? null,
        matrix: matrixLabel(expression),
        layout: null,
      };
      cells = heldOpen;
    }
  }
  // Every open cell's genes are read: no sample. The cell order stays when
  // a request names it (the open cells read again: what was read stays) or
  // a gene index is kept in this browser under it (a later visit: the cells
  // it holds cost nothing only in this order; in file order every gene
  // would read the whole matrix again). Else every cell opens in file
  // order, and a share in its own priority order.
  if (cells >= nOpen && (cellOrder === null || (order === undefined && indexedRows === 0))) return cut(none);
  if (!inOwnOrder) return { ...opening, cellOrder, genes: cells >= nOpen ? null : Object.freeze({ cells, of: nOpen, fit }) };
  // Every cell in the order, made here and timed with the runs of rows its
  // reads are planned by (`blockOrderRuns`): one pass over the open cells,
  // which prices every other pass the order adds to the opening
  // (`orderOpeningMs`), the chunks read being the same.
  const started = performance.now();
  const ordered = { ...opening, ...wholeInOrder(cellOrder, nObs, subsampleCache) };
  // The machine's `orderMadeMs` (`utils/machine.js`): timed, it follows how
  // busy the machine is (a pass of a few thousand cells stalled for tens of
  // milliseconds can outweigh a sample's priced saving of a tenth of a second).
  const orderMs = orderOpeningMs(measureOf('orderMadeMs', () => performance.now() - started));
  // A sample fitted to the first gene's time pays for the order only when
  // it brings that gene sooner than every cell's by more than the order
  // costs (`orderPays`); else every cell opens in file order, and its
  // genes are read for every cell (a sample in file order
  // would be its first rows, not a sample of it). The order stays when it
  // was asked for, kept genes are filed under it, or the sample bounds
  // memory (`geneIndexFit`), not time.
  if (order === undefined && indexedRows === 0 && fit?.limit === 'geneTime' && !orderPays(fit, orderMs)) return cut(none);
  return { ...ordered, cellOrder, genes: cells >= nOpen ? null : Object.freeze({ cells, of: nOpen, fit }) };
}

/**
 * Passes over the open cells that opening every cell in a `blocks` order
 * makes and an opening in file order does not, each about as long as
 * making the order (its open order made, copied into the reply
 * (`anndata-reader-worker.js` `cellSubsetOf`) and checked by the page's
 * cell identity (`cell-identity.js` `createCellIdentity`); the first view's
 * two arrays, its embedding and its field's codes, each gathered into the
 * view and scattered to its rows (`cell-subset.js` `readInSourceOrder`,
 * `values.js` `scatterRows`) where file order reads them in place). Counted
 * from the opening's path (measured: 23_decisions_partial_reading.md).
 */
export const ORDER_OPENING_PASSES = 7;

/**
 * What opening every cell in a `blocks` order costs the first picture more
 * than file order, from the time making the order took (`orderMadeMs`, one
 * pass over the open cells, measured as the opening makes it): every pass
 * it adds (`ORDER_OPENING_PASSES`) end to end, reader, reply and page. What
 * the order shares with file order -- the pricing that chose it, the
 * embedding's transform and coordinates, its cell-order sums, the page's
 * placement and drawing -- is not counted: an opening in either order pays
 * it.
 *
 * @param {number} orderMadeMs
 * @returns {number}
 */
export function orderOpeningMs(orderMadeMs) {
  return ORDER_OPENING_PASSES * orderMadeMs;
}

/**
 * Whether a gene sample fitted to the first gene's time (`geneTimeFit`:
 * every cell's first gene `neededMs`, the sample's `sampleMs`, as priced)
 * saves more than opening every cell in its order costs (`orderMs`,
 * `orderOpeningMs`: the opening end to end, not only the order made): a
 * sample of nearly every cell of a large file over a local web host saves
 * tens of milliseconds where the order costs the opening hundreds. Over a link with
 * no price (`neededMs` null: nothing measured nor remembered) every cell's
 * first gene could take any time: the order pays, its sample being what
 * holds that read to what costs nothing.
 *
 * @param {{neededMs: number|null, sampleMs: number|null}} fit
 * @param {number} orderMs
 * @returns {boolean}
 */
export function orderPays({ neededMs, sampleMs }, orderMs) {
  if (neededMs === null) return true;
  return Number.isFinite(neededMs) && Number.isFinite(sampleMs) && neededMs - sampleMs > orderMs;
}

/**
 * The bytes and requests the first gene of every cell of the file would
 * make for its own gene sample in the same time (`geneTimeFit` over the
 * order every cell opens in: the file's ladder rung, `blockRung`, or a
 * priority-ordered file's first rows), or Infinity for both when every
 * cell's first gene fits that time (a share's rows are among every cell's:
 * it reads no more). What a share's gene sample may make at most
 * (`geneSampleOf`): a share never costs more than the whole (a share's
 * cells reach past every cell's blocks while its bytes are fewer, so its
 * requests can number more: measured, 23_decisions_partial_reading.md). The page's
 * top-up holds a share's sample to it too, at the whole gene time over the
 * link measured after the first gene (`AnnDataReader.geneSampleCost`
 * `geneTime`). `priority`: the file's priority layout (only whether there
 * is one matters: its first rows are every cell's order), or null. `seen`:
 * every cell as an opening of these bytes opened it before
 * (`seenGeneSampleOf`): the sample its first gene was fitted to, in its
 * order, is the whole's, not one priced again over the link as measured
 * this moment (a share chosen after every cell was open).
 *
 * @returns {Promise<{bytes: number, requests: number}>}
 */
export async function wholeSampleCost(root, nObs, priority, { seedBytesPerMs, subsampleCache, seen = null, ...fitOptions }) {
  const none = { bytes: Infinity, requests: Infinity };
  if (!linkPriced(fitOptions.link)) return none;
  const fitted = seen?.genes?.fit?.limit === 'geneTime' && seen.cellOrder !== null ? seen.genes.fit : null;
  if (fitted !== null) {
    const cost = await firstGeneReadCost(root, nObs, { ...fitOptions, mergeGapBytes: fitOptions.link.mergeGapBytes ?? 0 });
    if (cost === null) return none;
    const read = cost(prefixRowsOf(null, nObs, seen.cellOrder, subsampleCache)(fitted.cells));
    return { bytes: read.bytes, requests: read.requests };
  }
  const order = priority !== null ? null : {
    method: 'blocks',
    seed: DEFAULT_SUBSAMPLE_SEED,
    blockSize: await blockRung(root, nObs, { ...fitOptions, seedBytesPerMs }),
  };
  const rowsOf = prefixRowsOf(null, nObs, order, subsampleCache);
  const whole = await geneTimeFit(root, nObs, nObs, { ...fitOptions, rowsAt: async k => ({ rows: rowsOf(k), indexed: 0 }) });
  return whole === null ? none : { bytes: whole.bytes, requests: whole.requests };
}

/**
 * How many open cells, from the first, lie in store rows `[0, rows)`: the
 * open cells whose matrix rows a store holding only its first rows has
 * (`geneSampleOf`'s `held`). `fileRows`: the open cells' rows, in open
 * order (null: open cell `i` is row `i`).
 *
 * @param {ArrayLike<number>|null} fileRows
 * @param {number} nOpen
 * @param {number} rows
 * @returns {number}
 */
export function heldPrefix(fileRows, nOpen, rows) {
  if (fileRows === null) return Math.min(nOpen, rows);
  let open = 0;
  while (open < nOpen && fileRows[open] < rows) open++;
  return open;
}

/**
 * What names an opening's cells among the openings of one store (the
 * key `seenGeneSampleOf` finds them by): every cell, or a share's
 * specification when it gives exactly its cells; null for cells no
 * specification gives (a session's recorded set, a step grown from few
 * chunks).
 *
 * @param {{kept: Uint32Array|null, spec?: Object|null, reproduced?: Object|boolean|null, chunks?: Object|null}} cells
 * @returns {string|null}
 */
function cellsKeyOf({ kept, spec = null, reproduced = null, chunks = null }) {
  if (kept === null) return 'all';
  if (spec === null || reproduced === false || chunks != null) return null;
  return JSON.stringify(Object.keys(spec).sort().map(key => [key, spec[key]]));
}

/**
 * Note the cells an opening of a store opened and the gene sample it read
 * them for (`AnnDataReader` `_geneSamplesSeen`, carried from one opening of
 * the same bytes to the next): its cell order, and its sample as it is
 * when the opening is replaced -- fitted, grown to fill the gene time (its
 * fit kept), a person's count, or null (every open cell's genes read).
 *
 * @param {Map<string, Object>} seen
 * @param {{kept: Uint32Array|null, nObs: number, spec?: Object|null, cellOrder?: Object|null, genes?: Object|null}} subset
 */
export function noteGeneSampleSeen(seen, subset) {
  const key = cellsKeyOf(subset);
  if (key === null) return;
  const genes = subset.genes ?? null;
  // A matrix still arriving (`fit.limit` 'stream') is weighed again against the rows its store holds.
  if (genes?.fit?.limit === 'stream') return;
  seen.set(key, Object.freeze({ of: subset.kept === null ? subset.nObs : subset.kept.length, cellOrder: subset.cellOrder ?? null, genes }));
}

/**
 * The cell order and gene sample an earlier opening of the same store
 * read the same cells in (`noteGeneSampleSeen`), or null.
 *
 * @param {Map<string, Object>|null} seen
 * @param {Object} placed - Its cells, as resolved
 */
function seenGeneSampleOf(seen, placed) {
  const key = seen === null ? null : cellsKeyOf(placed);
  const found = key === null ? null : seen.get(key) ?? null;
  const nOpen = placed.kept === null ? null : placed.kept.length;
  return found !== null && (nOpen === null || found.of === nOpen) ? found : null;
}

/**
 * A request's gene sample (`geneSampleOf`): null (fitted), `'all'`, a count
 * of at least one cell (chosen: a person's, a session's), or a sample fitted
 * before, carried (`{cells, fit}`, `cell-subset-policy.js` `geneSampleRequestOf`), returned as
 * `{cells, fit}` for both of the last two (`fit` null for a chosen count).
 */
function requireGeneSampleRequest(genes) {
  if (genes === undefined || genes === null) return null;
  if (genes === 'all') return 'all';
  if (Number.isSafeInteger(genes) && genes >= 1) return { cells: genes, fit: null };
  if (genes !== null && typeof genes === 'object' && Number.isSafeInteger(genes.cells) && genes.cells >= 1
    && genes.fit !== null && typeof genes.fit === 'object' && typeof genes.fit.limit === 'string') {
    return { cells: genes.cells, fit: genes.fit };
  }
  throw new TypeError(`A gene sample is 'all', a count of open cells or a fitted sample {cells, fit}, not ${String(genes)}`);
}

/** A cell order (`CellOrder`), checked and frozen. */
export function requireCellOrder(order) {
  if (order === null || typeof order !== 'object' || order.method !== 'blocks') {
    throw new TypeError('A cell order is the priority order of a blocks subsample: {method: \'blocks\', seed, blockSize}');
  }
  const { seed, blockSize } = order;
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError(`A cell order's seed is a uint32, not ${String(seed)}`);
  if (!Number.isSafeInteger(blockSize) || blockSize < 1) throw new RangeError(`A cell order's block size is a positive count, not ${String(blockSize)}`);
  return Object.freeze({ method: 'blocks', seed, blockSize });
}

/**
 * The file rows of open cells `[from, k)` (`PricedRows`, ascending), for an
 * opening whose open cell `i` is file row `fileRows[i]` (null: row `i`), or
 * that opened every cell of a file in a `blocks` cell order (`cellOrder`:
 * open cells `[0, k)` are its subsample of k, so `[from, k)` is that of k
 * without that of `from`, as runs, a step a block). Otherwise those cells'
 * rows in row order. What the first
 * gene reads for them (`firstGeneReadCost`), as the gene sample is fitted
 * and grown (`AnnDataReader.geneSampleCost`). The cell order's subsamples
 * are taken from `cache`'s blocks in rank order (the opening's, `subsample.js`
 * `createSubsampleCache`): the fit's many counts rank no block again.
 *
 * @param {Uint32Array|null} fileRows
 * @param {number} nFile - Rows of the file
 * @param {Readonly<CellOrder>|null} [cellOrder]
 * @param {ReturnType<typeof import('../subsample.js').createSubsampleCache>} [cache]
 * @returns {(k: number, from?: number) => PricedRows}
 */
export function prefixRowsOf(fileRows, nFile, cellOrder = null, cache = createSubsampleCache()) {
  if (cellOrder !== null) {
    const runsOf = k => (k >= nFile ? rowRun(0, nFile) : k <= 0 ? rowRun(0, 0) : cache.blockRuns(nFile, k, cellOrder.seed, cellOrder.blockSize));
    // The subsample of `from` lies within that of k (nested).
    return (k, from = 0) => (from <= 0 ? runsOf(k) : runsWithout(runsOf(k), runsOf(from)));
  }
  if (fileRows === null) return (k, from = 0) => rowRun(from, k);
  // Each count asked reads only its own cells' rows, in sequence, and puts
  // them in row order: as a bit each in a table of the file's rows read
  // back word by word (a word holds 32 rows), or, for cells fewer than
  // those words, by sorting them. A pass over every open cell in row order
  // for each of the fit's two dozen counts reads rows out of sequence
  // (measured: 23_decisions_partial_reading.md).
  let words = null;
  return (k, from = 0) => {
    const count = Math.max(0, k - from);
    const rows = allocateTypedArray(Uint32Array, count, 'Gene sample rows');
    if (count === 0) return rows;
    if (count < (nFile >>> 5)) {
      rows.set(fileRows.subarray(from, k));
      return sortUint32(rows);
    }
    words ??= allocateTypedArray(Uint32Array, (nFile >>> 5) + 1, 'Gene sample row bits');
    words.fill(0);
    for (let i = from; i < k; i++) {
      const row = fileRows[i];
      words[row >>> 5] |= 1 << (row & 31);
    }
    let at = 0;
    for (let w = 0; w < words.length && at < count; w++) {
      for (let bits = words[w]; bits !== 0; bits &= bits - 1) rows[at++] = w * 32 + (31 - Math.clz32(bits & -bits));
    }
    return rows;
  };
}

/**
 * Every cell of a file in its own order, opened in `order`: the priority
 * order of the `blocks` subsample of every cell (`priorityOrder`), so open
 * cells `[0, m)` are that subsample of `m` cells. Placed as `placeInFile`
 * places a subsample (file row = original position).
 */
function wholeInOrder(order, nObs, cache) {
  const openOrder = cache.blocksPriorityOrder(nObs, order.seed, order.blockSize);
  // Its runs, a block at a time (`blockOrderRuns`), for the open cells' rows.
  noteRunsOf(openOrder, blockOrderRuns(openOrder, nObs, order.blockSize));
  return { fileRows: openOrder, openOrder, prefix: null, prioritySeed: null, levels: null, ordered: true };
}

/**
 * The runs of every cell in a `blocks` order (`runsOfPositions`'s, exactly),
 * found a block at a time: the order is whole blocks of `blockSize` rows
 * (the file's last block shorter), each in file order, so a run can only
 * end where a block does -- one look per block, not one per cell (10M cells
 * in 306 blocks: 306 looks).
 *
 * @param {Uint32Array} openOrder - `blocksPriorityOrder(nObs, seed, blockSize)`
 * @param {number} nObs
 * @param {number} blockSize
 * @returns {import('./views/cell-subset.js').Runs}
 */
export function blockOrderRuns(openOrder, nObs, blockSize) {
  const blocks = Math.ceil(nObs / blockSize);
  const Positions = nObs <= 0xffffffff ? Uint32Array : Float64Array;
  const starts = new Positions(blocks);
  const ends = new Positions(blocks);
  const offsets = new Positions(blocks + 1);
  let count = 0;
  for (let at = 0; at < openOrder.length;) {
    const start = openOrder[at];
    const end = Math.min(start + blockSize, nObs);
    if (count > 0 && ends[count - 1] === start) ends[count - 1] = end;
    else {
      starts[count] = start;
      ends[count] = end;
      offsets[count] = at;
      count++;
    }
    at += end - start;
  }
  offsets[count] = openOrder.length;
  return { count, starts: starts.subarray(0, count), ends: ends.subarray(0, count), offsets: offsets.subarray(0, count + 1) };
}

/**
 * A share of a file in its own order opened in the file's cell order
 * (`order`, `geneSampleOf`): its cells (`placed.kept`) in the priority order
 * of the `blocks` subsample of every cell, the share filtered -- whole
 * blocks in their rank order, each block's share cells in file order
 * (`priorityOrder` of the cell order's `blocks` over the share's cells), so
 * its first `m` cells lie in the first blocks every cell's order reads.
 */
function shareInCellOrder(placed, order) {
  const openOrder = priorityOrder({ method: 'blocks', seed: order.seed, blockSize: order.blockSize }, placed.kept);
  return { fileRows: openOrder, openOrder, prefix: null, prioritySeed: null, levels: null, ordered: true };
}

/**
 * A step of a share growing in the order it opens in (a `prefix` request,
 * `progressive-open.js`): its first `cells` open cells, in that order. The
 * share's larger steps and the share itself open the same first cells, so
 * each step grows the one before in place (`anndata-file-source.js`
 * `sharedOpenCells`) and its gene sample is theirs. Its cells are the
 * share's in the blocks (or, on a priority-ordered file, the rows) read so
 * far, not a sample of the share of their count: the specification recorded
 * with them is the share's of their count, which does not give them again
 * (`reproduced` false: a session saved on them opens exactly them, in the
 * same order: `order`), and `part` says how far the share is.
 */
function prefixStep(placed, cells) {
  const target = placed.kept?.length ?? 0;
  if (placed.kept === null || placed.openOrder === null) throw new Error('Only a share opened in its order grows by its first cells.');
  if (!Number.isSafeInteger(cells) || cells < FEWEST_OPEN_CELLS || cells > target) {
    throw new RangeError(`A step of ${formatCountOf(target, 'cell')} opens ${FEWEST_OPEN_CELLS} to ${target} of them, not ${cells}.`);
  }
  const open = placed.openOrder.slice(0, cells);
  const fileRows = placed.fileRows === placed.openOrder ? open : placed.fileRows.slice(0, cells);
  return {
    ...placed,
    kept: open.slice().sort(),
    spec: Object.freeze({ ...placed.spec, k: cells }),
    reproduced: false,
    openOrder: open,
    fileRows,
    prefix: null,
    part: Object.freeze({ cells, target }),
  };
}

/**
 * The specification of the order an opening's cells are open in, as the
 * gene index kept in this browser files it (`kept-column-index.js`
 * `orderKey`): a share's (`spec`, with the cell order it opens in when a
 * file in its own order opened it in one: `cellOrder`), every cell's cell
 * order (`{method: 'blocks', seed, blockSize}` of every cell), or null for
 * file order.
 *
 * @param {{nObs: number, spec?: Object|null, cellOrder?: Readonly<CellOrder>|null, fileRows?: Uint32Array|null}} opening
 * @returns {Object|null}
 */
export function openOrderSpecOf({ nObs, spec = null, cellOrder = null, fileRows = null }) {
  if (spec === null) return cellOrder === null ? null : { ...cellOrder, nObs, k: nObs };
  if (fileRows === null) return null;
  return cellOrder === null ? spec : { ...spec, cellOrder: { seed: cellOrder.seed, blockSize: cellOrder.blockSize } };
}

/**
 * A step of a subsample grown from few chunks (`progressive-open.js`,
 * `chunkMajorOrder`): of `placed` (the subsample, in priority order), the
 * first `cells` cells in chunk order -- the kept cells of the chunks read
 * so far -- opened in that order. They are not a sample of the subsample
 * (`ordered` false); the specification recorded with them is the
 * subsample's of their count, which does not give them again
 * (`reproduced` false: a session saved on them opens exactly them).
 */
function chunkStep(placed, chunks, priority) {
  if (priority !== null || placed.kept === null || placed.openOrder === null) {
    throw new Error('Only a subsample of a file in its own order grows from few chunks.');
  }
  const { order } = chunkMajorOrder(placed.openOrder, chunks.rows, chunks.seed);
  const cells = chunks.cells;
  if (!Number.isSafeInteger(cells) || cells < 1 || cells > order.length) {
    throw new RangeError(`A step of ${formatCountOf(order.length, 'cell')} opens 1 to ${order.length} of them, not ${cells}.`);
  }
  const open = order.slice(0, cells);
  const kept = open.slice().sort();
  return {
    ...placed,
    kept,
    spec: Object.freeze({ ...placed.spec, k: cells }),
    reproduced: false,
    openOrder: open,
    fileRows: open,
    ordered: false,
    chunks: Object.freeze({ rows: chunks.rows, seed: chunks.seed, cells, target: order.length }),
  };
}

/**
 * Where a resolution's cells are in the file, and the order they are
 * opened in. A subsample of a file in its own order opens in its
 * **priority order** (`priorityOrder`): its first `m` cells are a sample at
 * every `m`, so an opening read in parts, a column index built in parts, or
 * a larger subsample of the same method and seed, appends to what is open
 * (a share spread through the file is then put in the file's cell order
 * when its genes are read for a sample, `geneSampleOf`). A subsample of a
 * priority-ordered file opens in file order: the first `k` rows when they
 * are its cells (uniform under the file's seed), else its cells by file
 * row -- a uniform sample of them at every `m`, in the file's first rows.
 *
 * `fileRows`, the file row of each open cell in open order (null: every
 * row, in file order); `openOrder`, the original position of each open cell
 * in open order (null: open cell `i` is original position `kept[i]`, or `i`);
 * `prefix`, the count when the open cells are file rows `[0, prefix)` (a
 * uniform subsample under a priority-ordered file's seed), else null.
 * `ordered`: whether open order is a priority order, so that any run of
 * consecutive open cells is a sample (every subsample's is; a priority-ordered
 * file's file order is, opened whole or by a share). A subsample `cache` selected is put
 * in priority order as a prefix of its ranked items (`SubsampleCache.priorityOrder`).
 */
async function placeInFile(resolution, nObs, priority, fileOrder, cache) {
  const { kept, spec } = resolution;
  if (priority === null) {
    if (kept === null) return { fileRows: null, openOrder: null, prefix: null, prioritySeed: null, levels: null, ordered: false };
    const openOrder = cache.priorityOrder(spec, kept);
    return { fileRows: openOrder, openOrder, prefix: null, prioritySeed: null, levels: null, ordered: true };
  }
  // Every cell open, or the k lowest ranks (the first k rows): which rows
  // to read needs no original position, and the positions are the seed's
  // order (`priorityPositions`), computed beside the rest of opening
  // (`openOrderRead`, settled before the open finishes) and checked against
  // the stored column's first rows, read once with the record.
  if (kept === null) {
    return { fileRows: null, openOrder: null, openOrderRead: fileOrder(), prefix: null, prioritySeed: priority.seed, levels: priority.levels, ordered: true };
  }
  const k = kept.length;
  // The first k rows are the cells only when they are exactly the cells the
  // specification keeps: resolved from it, or a recorded set it gives again
  // (`reproduced` not false). A recorded set it does not give (a session
  // saved on a chunk step, or on another version of the file) is placed by
  // each cell's row below, never taken for the first rows.
  if (spec?.method === 'uniform' && spec.seed === priority.seed && resolution.reproduced !== false) {
    // Their order is the seed's (the kept cells by rank); the stored
    // column's first rows, read once with the record (never again on a
    // resize), must be the first of them.
    const openOrder = cache.priorityOrder(spec, kept);
    const stored = priority.firstRows ?? new Uint32Array(0);
    for (let i = 0; i < Math.min(k, stored.length); i++) {
      if (stored[i] !== openOrder[i]) {
        throw new Error(`This file's row ${i} is not the cell its priority seed keeps there; the file is damaged`);
      }
    }
    const openOrderRead = Promise.resolve(openOrder);
    const fileRows = allocateTypedArray(Uint32Array, k, 'File rows');
    for (let i = 0; i < k; i++) fileRows[i] = i;
    return { fileRows, openOrder: null, openOrderRead, prefix: k, prioritySeed: priority.seed, levels: priority.levels, ordered: true };
  }
  // Any other share opens in file order: its cells by file row. The file's
  // rows are in its seed's rank order, so the first `m` open cells are a
  // uniform sample of the share at every `m`, and they lie in the file's
  // first rows: the rows every cell's first view and gene sample read first
  // (its own priority order put each of its first cells in a chunk of its
  // own, through the whole file).
  const order = await fileOrder();
  const rowOf = allocateTypedArray(Uint32Array, nObs, 'File rows');
  for (let row = 0; row < nObs; row++) rowOf[order[row]] = row;
  const fileRows = allocateTypedArray(Uint32Array, k, 'File rows');
  for (let i = 0; i < k; i++) fileRows[i] = rowOf[kept[i]];
  fileRows.sort();
  const openOrder = allocateTypedArray(Uint32Array, k, 'Open order');
  for (let i = 0; i < k; i++) openOrder[i] = order[fileRows[i]];
  return { fileRows, openOrder, prefix: null, prioritySeed: priority.seed, levels: priority.levels, ordered: true };
}

/**
 * The method a request that names none takes, by the file: a
 * priority-ordered file `uniform` under its own seed (its subsamples are
 * prefixes of every array, `priority-layout.js`); any other file `blocks`
 * aligned to its storage (`defaultBlockSize`). The one rule for the
 * control, links, auto-fit and sessions: each leaves the method (and the
 * seed) unset when the person did not name one.
 *
 * @param {Object|null} priority
 * @returns {'uniform'|'blocks'}
 */
export function defaultSubsampleMethod(priority) {
  return priority === null ? 'blocks' : 'uniform';
}

/** A request resolved over original positions (`resolveCellSubset`). */
async function resolveInOriginalSpace(root, request, nObs, priority, fileOrder, { valuesOnDemand, decodedChunkBytes, readOptions = {}, budgets = {}, expression = 'X', subsampleCache, link = null, seedBytesPerMs = null, keptIndexRows = null }) {
  // A `blocks` order nobody named the size of: the rung of the file's
  // ladder the link and what this browser keeps choose (`blockRung`), the
  // same one every cell of the file would open in, recorded in the spec.
  const rungOf = seed => blockRung(root, nObs, { seed, link, seedBytesPerMs, valuesOnDemand, decodedChunkBytes, readOptions, expression, columnIndexBytes: budgets.columnIndexBytes, keptIndexRows });
  // A priority-ordered file's seed is the default: its uniform subsamples are prefixes.
  const defaultSeed = priority?.seed ?? DEFAULT_SUBSAMPLE_SEED;
  const all = { nObs, kept: null, spec: null, autoFit: null, reproduced: null, note: null };
  const mode = request?.mode ?? 'all';
  if (mode === 'all') return all;
  if (mode === 'auto') {
    // The map's fit (`autoFitCount`): the cells' working set and the gene
    // indexes every open cell holds. What a gene costs sizes the gene sample
    // (`geneSampleOf`), never the map.
    const memory = autoFitCount(root, nObs, { valuesOnDemand, decodedChunkBytes, ...budgets, expression });
    if (memory === null) return all;
    // Whole blocks aligned to the storage: the cells left out are never
    // read. A uniform subsample's cells lie in most chunks of a row-chunked
    // array (a few cells a chunk: a 10% share touches nearly half of X's
    // chunks), so its genes would read most of the matrix.
    // A priority-ordered file: uniform under its seed, a prefix of every array.
    const spec = requireSubsampleSpec(priority !== null
      ? { method: 'uniform', nObs, k: memory.k, seed: priority.seed }
      : { method: 'blocks', nObs, k: memory.k, seed: DEFAULT_SUBSAMPLE_SEED, blockSize: await rungOf(DEFAULT_SUBSAMPLE_SEED) });
    return { nObs, kept: await keptCellsOf(root, spec, readOptions, fileOrder, subsampleCache), spec, autoFit: memory, reproduced: null, note: null };
  }
  if (mode === 'subsample') {
    // The tab's request (`strict` false) meets datasets it was not made
    // for: one without its field or embedding opens a subsample of the
    // file's default method (`defaultSubsampleMethod`) at the same size and
    // seed, and says so (`note`).
    let note = null;
    let resolved = request;
    if (request.strict !== true) {
      const missing = request.method === 'stratified'
        ? (child(child(root, 'obs'), request.field ?? '') === null ? `the field '${request.field}'` : null)
        : request.method === 'spatial'
          ? ((request.embedding === undefined ? defaultEmbedding(root, nObs) : child(child(root, 'obsm'), request.embedding)) === null
            ? (request.embedding === undefined ? 'a two-dimensional embedding' : `the embedding '${request.embedding}'`)
            : null)
          : null;
      if (missing !== null) {
        note = `This dataset has no ${missing.replace(/^the /, '')}, so its subsample is its default method instead of ${request.method}`;
        resolved = { mode: 'subsample', k: request.k, percent: request.percent, fraction: request.fraction, seed: request.seed };
      }
    }
    const method = resolved.method ?? defaultSubsampleMethod(priority);
    const seed = resolved.seed ?? defaultSeed;
    const blockSize = method === 'blocks' ? resolved.blockSize ?? await rungOf(seed) : undefined;
    const spec = specOf({ ...resolved, method, seed, ...(blockSize === undefined ? {} : { blockSize }) }, root, nObs, expression);
    if (spec === null) return all;
    return { nObs, kept: await keptCellsOf(root, spec, readOptions, fileOrder, subsampleCache), spec, autoFit: null, reproduced: null, note };
  }
  if (mode === 'chunks' || mode === 'prefix') {
    // A subsample grown from few chunks, or in its order: the subsample
    // here, its step's cells taken by `chunkStep` or `prefixStep`.
    const spec = requireSubsampleSpec(request.spec);
    if (spec.nObs !== nObs) throw new Error(`A subsample of ${formatCountOf(spec.nObs, 'cell')} is not of this dataset of ${formatCountOf(nObs, 'cell')}`);
    return { nObs, kept: await keptCellsOf(root, spec, readOptions, fileOrder, subsampleCache), spec, autoFit: request.autoFit ?? null, reproduced: null, note: null };
  }
  if (mode === 'kept') {
    const spec = requireSubsampleSpec(request.spec);
    if (spec.nObs !== nObs) {
      throw new Error(
        `The saved subsample is of ${formatCountOf(spec.nObs, 'cell')}, and this dataset has ${formatCountOf(nObs, 'cell')}: it is not the dataset the session was saved on`
      );
    }
    const identity = createCellIdentity({ nObs, kept: request.kept });
    if (identity.n !== spec.k) throw new Error(`The saved subsample lists ${formatCountOf(identity.n, 'cell')}, and its specification ${spec.k}`);
    let reproduced = null;
    let again = null;
    try {
      again = await keptCellsOf(root, spec, readOptions, fileOrder, subsampleCache);
      reproduced = again !== null && again.length === identity.kept.length && again.every((p, i) => p === identity.kept[i]);
    } catch {
      // A field or embedding the specification read is gone: the recorded
      // cells stand; only that they are reproducible is unknown.
      reproduced = false;
    }
    // The same cells opened again (a page restored from the back/forward
    // cache, a canceled reading undone) keep what they were: fitted to the
    // device, or not reproducible by their specification.
    if (request.reproduced === false) reproduced = false;
    // Cells their specification gives again are its selection (`again`, the
    // same positions): their priority order is then the prefix of what was
    // ranked for it (`placeInFile`), not sorted again.
    return { nObs, kept: reproduced ? again : identity.kept, spec, autoFit: request.autoFit ?? null, reproduced, note: null };
  }
  throw new TypeError(`Unknown cell subset request mode '${String(mode)}'`);
}

