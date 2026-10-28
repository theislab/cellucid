/**
 * Which cells an opening keeps: a subsample request resolved against the
 * store, on the reader worker, before the dataset is read
 * (`AnnDataReader.open`). What it reads is only what the method needs: the
 * cell count from metadata; a stratified subsample the field's codes; a
 * spatial one the embedding's columns; nothing else.
 *
 * ## Requests (`CellSubsetRequest`, sent by the page)
 *
 * - `{mode: 'auto'}` — every cell, unless the dataset does not fit this
 *   device (`autoFit`): then a `blocks` subsample sized to fit, aligned to
 *   the storage so the cells left out are never read, with `autoFit` saying
 *   why.
 * - `{mode: 'all'}` — every cell, whatever it costs.
 * - `{mode: 'subsample', method, fraction | k, seed, ...}` — a subsample by
 *   the specification (`../subsample.js`). A parameter left out takes its
 *   default: `blockSize` from the storage layout (`defaultBlockSize`),
 *   `gridSize` 32, `allocation` proportional, `minPerCategory` 0, the
 *   embedding's first two columns. `fraction` becomes a count by
 *   `countFromFraction`; a size of every cell is every cell, and any other
 *   is kept exactly (the control and the link do not ask for fewer than
 *   `FEWEST_OPEN_CELLS`; a one-cell opening is refused where its embedding
 *   is drawn). Unless `strict`, a method whose field or embedding the
 *   dataset lacks opens the file's default method (`defaultSubsampleMethod`)
 *   at the same size and seed, and says so (`note`): the tab's request meets
 *   datasets it was not chosen for.
 * - `{mode: 'kept', spec, kept, autoFit?, reproduced?}` — exactly the cells a session recorded
 *   (or the open cells read again: `autoFit` and a `reproduced` false carry over)
 *   (`kept`, ascending), checked against the dataset's cell count. Whether
 *   `spec` still gives the same cells is reported (`reproduced`), never
 *   required: the recorded set is the truth.
 *
 * ## Auto-fit (`autoFit`)
 *
 * A dataset fits when, at every cell, both hold:
 *
 * - the per-cell working set (`CELL_WORKING_SET_BYTES` a cell)
 *   fits the memory allowance (`memory-budget.js`, half the device);
 * - the gene index of `X` (`columnIndexResidentBytes`: a cell-major sparse
 *   matrix's stored values, a dense one's every value), when genes are read
 *   through one, fits the `columnIndex` budget.
 *
 * Otherwise the largest `k` for which both hold is opened (the method: see
 * `{mode: 'auto'}` above). WebGL reports no
 * limit on buffer sizes, so the GPU adds no bound here; an allocation the
 * GPU refuses is reported where it happens.
 *
 * @module data/anndata/subsample-plan
 */

import { isArrayNode, isGroup } from '../../formats/store.js';
import { attributeValue, child, elementBytes, encodingType, valueKind } from './elements.js';
import { readRowSlabs, readStored } from './values.js';
import { readNullableValues } from './dataframe.js';
import { compareCodePoints } from '../data-mapping.js';
import { columnIndexResidentBytes } from './matrix-access.js';
import { memoryAllowanceBytes, residencyBudgetBytes } from '../memory-budget.js';
import {
  DEFAULT_GRID_SIZE,
  DEFAULT_SUBSAMPLE_SEED,
  FEWEST_OPEN_CELLS,
  STRATIFIED_ALLOCATIONS,
  SUBSAMPLE_METHODS,
  countFromFraction,
  countFromShare,
  priorityOrder,
  requireSubsampleSpec,
  subsampleBlocks,
  subsampleSpatial,
  subsampleStratified,
  subsampleUniform,
} from '../subsample.js';
import { createCellIdentity } from '../cell-identity.js';
import { readPriorityLayout } from './priority-layout.js';
import { formatCountOf } from '../../utils/format-units.js';
import { chunkMajorOrder } from './progressive-open.js';
import { allocateTypedArray } from '../sparse-column-index.js';
import { REMOTE_POLICY } from '../../formats/io/byte-source.js';

/**
 * Bytes one cell holds in the page's working set however a dataset is
 * shown, as measured, not modelled: 64.6 bytes of physical memory a cell for
 * the points themselves -- 3D positions and colours in the page and on the
 * GPU with the GPU process's own overhead, visibility, the spatial tree and
 * the draw order levels of detail need, and its permutation -- measured
 * steady at 100,000,000 synthetic 3D cells with levels of detail (renderer
 * and GPU processes together, Chromium on Apple M1 Pro; 53.3 in 2D), rounded
 * up, plus the codes of the field the cells are coloured by (4), one
 * continuous field (4) and its outlier quantile (4). It was 54 (a model that
 * left out the tree, the draw order and the GPU process's overhead), which
 * fitted 148M cells to a 16 GB machine where 125M already swapped while the
 * levels of detail were built.
 */
export const CELL_WORKING_SET_BYTES = 77;

/** Chunks of the dominant cell-major array one block of `blocks` spans (see `defaultBlockSize`). */
const BLOCK_CHUNKS = 4;

/**
 * The bytes of the dominant array one block of `blocks` fills when that
 * array is read byte by byte (stored in one piece, or in chunks read in
 * part): what one request is taken to be worth on a web host before its
 * link is measured (`REMOTE_POLICY.mergeGapBytes`). A constant, never the
 * link as measured: a file's default sample is a property of the file, the
 * same cells whenever, wherever and however it is opened (a merge gap
 * measured from one read's timing gave the same `.h5ad` blocks of 28 to 66
 * cells from one opening to the next), and a larger share of the same
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

/** `X` described for cost: its layout and stored values. */
function matrixOf(root, nObs) {
  const X = child(root, 'X');
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

/**
 * The block size `blocks` uses unless given: a run of cells spanning about
 * `BLOCK_CHUNKS` chunks of the dominant cell-major array, so the chunk a
 * block shares with its neighbour at each end costs at most about a
 * `1 / BLOCK_CHUNKS` more. The dominant array is `X` when it is cell-major
 * (a CSR matrix's index chunks, as cells by the mean stored values per
 * cell; a dense one's chunk rows), else the widest dense `obsm` array.
 * An array read byte by byte (stored in one piece, or in chunks read in
 * part: `partialChunks`) has no chunk to align to: a block is then the
 * cells whose bytes fill `BYTE_READ_BLOCK_BYTES`. The layout alone decides
 * it, never the link.
 *
 * @param {Object} root
 * @param {number} nObs
 * @returns {number}
 */
export function defaultBlockSize(root, nObs) {
  const matrix = matrixOf(root, nObs);
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
 * The largest cell count that fits this device, or null when every cell fits.
 *
 * @param {Object} root
 * @param {number} nObs
 * @param {{valuesOnDemand: boolean, decodedChunkBytes: number, allowanceBytes?: number, columnIndexBytes?: number}} context
 * @returns {{k: number, limit: 'cells'|'columnIndex', budgetBytes: number, neededBytes: number}|null}
 */
export function autoFitCount(root, nObs, { valuesOnDemand, decodedChunkBytes, allowanceBytes = memoryAllowanceBytes(), columnIndexBytes = residencyBudgetBytes('columnIndex') }) {
  if (nObs === 0) return null;
  const limits = [];
  const cellBytes = nObs * CELL_WORKING_SET_BYTES;
  if (cellBytes > allowanceBytes) {
    limits.push({ k: Math.floor(allowanceBytes / CELL_WORKING_SET_BYTES), limit: 'cells', budgetBytes: allowanceBytes, neededBytes: cellBytes });
  }
  // Every expression index that can be opened: the root's X and each
  // modality's (a modality measuring some of the cells keeps that share of
  // them per kept cell). Each costs a fixed part (its genes) and a part per
  // kept cell; a matrix presented twice (a default modality's X at the root)
  // counts once.
  const matrices = [{ group: root, nCells: nObs }];
  for (const modality of Array.isArray(root.modalities) ? root.modalities : []) {
    matrices.push({ group: child(child(root, 'mod'), modality.name), nCells: modality.nCells });
  }
  const seen = new Set();
  let fixed = 0;
  let perCell = 0;
  let indexBytes = 0;
  for (const { group, nCells } of matrices) {
    const matrix = group === null ? null : matrixOf(group, nCells);
    if (matrix === null || nCells === 0 || seen.has(matrix.node.path)) continue;
    seen.add(matrix.node.path);
    let bytes = null;
    let base = 0;
    if (matrix.layout === 'csr') {
      bytes = columnIndexResidentBytes({ layout: 'sparse', nnz: matrix.nnz, nObs: nCells, nVars: matrix.nVars, valuesOnDemand });
      base = columnIndexResidentBytes({ layout: 'sparse', nnz: 0, nObs: 0, nVars: matrix.nVars, valuesOnDemand });
    } else if (matrix.layout === 'dense') {
      // A dense matrix chunked by gene strips that fit the decoded-chunk
      // budget is read by strip, without an index (`openMatrixColumns`).
      const chunks = Array.isArray(matrix.node.chunks) ? matrix.node.chunks : null;
      const strip = chunks === null ? null : Math.min(chunks[1], matrix.nVars);
      const byStrip = strip !== null && nCells * strip * elementBytes(matrix.node) <= decodedChunkBytes;
      if (!byStrip) bytes = columnIndexResidentBytes({ layout: 'dense', nObs: nCells, nVars: matrix.nVars });
    }
    if (bytes === null) continue;
    indexBytes += bytes;
    fixed += base;
    perCell += (bytes - base) / nObs;
  }
  if (indexBytes > columnIndexBytes && perCell > 0) {
    limits.push({ k: Math.floor((columnIndexBytes - fixed) / perCell), limit: 'columnIndex', budgetBytes: columnIndexBytes, neededBytes: indexBytes });
  }
  if (limits.length === 0) return null;
  const tightest = limits.reduce((a, b) => (b.k < a.k ? b : a));
  // At least the fewest cells the viewer draws (`FEWEST_OPEN_CELLS`); a
  // dataset of no more than that opens whole.
  if (nObs <= FEWEST_OPEN_CELLS) return null;
  return { ...tightest, k: Math.max(FEWEST_OPEN_CELLS, Math.min(nObs - 1, tightest.k)) };
}

/**
 * A field's strata, read whole: a categorical field's codes and category
 * count; a column of text (AnnData's `string-array` and
 * `nullable-string-array`, a Loom column attribute) made categories in
 * code-point order, as the specification says of plain values (Python's
 * pandas `Categorical`), a missing value in none (code -1).
 */
async function readCodes(root, field, readOptions) {
  const column = child(child(root, 'obs'), field);
  if (column === null) throw new Error(`A stratified subsample needs the obs field '${field}', which this dataset does not have`);
  if (isGroup(column) && encodingType(column) === 'categorical') {
    const codesNode = column.get('codes');
    const categories = column.get('categories');
    const codes = await readStored(codesNode, 0, codesNode.shape[0], `obs['${field}'] codes`, readOptions);
    if (ArrayBuffer.isView(codes) && !(codes instanceof BigInt64Array)) return { codes, nCategories: categories.shape[0] };
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
  if (values === null) throw new Error(`A stratified subsample needs a categorical or text field; obs['${field}'] is neither`);
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
  if (!isArrayNode(array)) throw new Error(`A spatial subsample needs the embedding obsm['${key}'], which this dataset does not have as a dense array`);
  if (!['float', 'int', 'uint'].includes(valueKind(array))) throw new Error(`obsm['${key}'] is not numeric`);
  const width = array.shape[1] ?? 1;
  for (const column of columns) {
    if (column >= width) throw new Error(`obsm['${key}'] has no column ${column}`);
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

/** The embedding a spatial subsample uses unless one is named: the first 2-D dense obsm array. */
function defaultEmbedding(root, nObs) {
  const obsm = child(root, 'obsm');
  if (!isGroup(obsm)) return null;
  const keys = obsm.keys();
  const preferred = ['X_umap', 'X_tsne', 'X_pca'].filter(key => keys.includes(key));
  for (const key of [...preferred, ...keys]) {
    const node = obsm.get(key);
    if (isArrayNode(node) && node.shape[0] === nObs && node.shape.length === 2 && node.shape[1] >= 2) return key;
  }
  return null;
}

/**
 * A subsample request's specification, complete: every default filled in
 * from the store.
 */
function specOf(request, root, nObs) {
  const method = request.method;
  if (!SUBSAMPLE_METHODS.includes(method)) throw new RangeError(`Unknown subsample method '${String(method)}'`);
  let k;
  if (request.k !== undefined && request.k !== null) k = request.k;
  else if (request.percent !== undefined && request.percent !== null) k = countFromShare(request.percent, nObs, { percent: true });
  else if (request.fraction !== undefined && request.fraction !== null) k = countFromFraction(request.fraction, nObs);
  else throw new TypeError('A subsample request names its size: k, percent or fraction');
  if (!Number.isSafeInteger(k) || k < 1) throw new RangeError(`A subsample keeps at least one cell; ${String(k)} was asked for`);
  if (k >= nObs) return null;
  const spec = { method, nObs, k, seed: request.seed ?? DEFAULT_SUBSAMPLE_SEED };
  if (method === 'blocks') spec.blockSize = request.blockSize ?? defaultBlockSize(root, nObs);
  if (method === 'stratified') {
    if (typeof request.field !== 'string' || request.field === '') throw new TypeError('A stratified subsample names its categorical obs field');
    spec.field = request.field;
    spec.allocation = request.allocation ?? 'proportional';
    if (!STRATIFIED_ALLOCATIONS.includes(spec.allocation)) throw new RangeError(`Unknown allocation '${String(spec.allocation)}'`);
    spec.minPerCategory = request.minPerCategory ?? 0;
  }
  if (method === 'spatial') {
    const embedding = request.embedding ?? defaultEmbedding(root, nObs);
    if (embedding === null) throw new Error('A spatial subsample needs an embedding, and this dataset has no two-dimensional one');
    spec.embedding = embedding;
    spec.columns = request.columns ?? [0, 1];
    spec.gridSize = request.gridSize ?? DEFAULT_GRID_SIZE;
  }
  return requireSubsampleSpec(spec);
}

/**
 * The kept cells of a specification, reading what its method needs.
 *
 * @param {Object} root
 * @param {Readonly<import('../subsample.js').SubsampleSpec>} spec
 * @param {Object} readOptions
 * @returns {Promise<Uint32Array|null>}
 */
export async function keptCellsOf(root, spec, readOptions = {}, fileOrder = null) {
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
    case 'uniform': return subsampleUniform(spec.nObs, spec.k, spec.seed);
    case 'blocks': return subsampleBlocks(spec.nObs, spec.k, spec.seed, spec.blockSize);
    case 'stratified': {
      const { codes, nCategories } = await readCodes(root, spec.field, readOptions);
      return subsampleStratified(await original(codes, 1), nCategories, spec.k, spec.seed, { allocation: spec.allocation, minPerCategory: spec.minPerCategory });
    }
    case 'spatial': {
      const coordinates = await readEmbeddingColumns(root, spec.embedding, spec.columns, readOptions);
      return subsampleSpatial(await original(coordinates, spec.columns.length), spec.columns.length, spec.k, spec.seed, { gridSize: spec.gridSize });
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
 * @property {{k: number, limit: 'cells'|'columnIndex', budgetBytes: number, neededBytes: number}|null} autoFit
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
 *   budgets?: {allowanceBytes?: number, columnIndexBytes?: number}}} context - `budgets`:
 *   the device's budgets (`memory-budget.js`) unless given
 * @returns {Promise<CellSubsetResolution>}
 */
export async function resolveCellSubset(root, request, context) {
  const nObs = storeCellCount(root);
  // A record that does not describe the file's cells is no layout: the file
  // is read as one Cellucid did not write, and its notice says why.
  const { layout: priority, notice } = await readPriorityLayout(root, nObs, context.readOptions ?? {});
  let order = null;
  // Every row's original position, computed from the seed and checked
  // against the stored column's first rows (`priority-layout.js`).
  const fileOrder = priority === null ? null : () => (order ??= priority.order());
  const resolution = await resolveInOriginalSpace(root, request, nObs, priority, fileOrder, context);
  const note = [notice, resolution.note].filter(text => text !== null).join('. ') || null;
  const placed = { ...resolution, note, ...await placeInFile(resolution, nObs, priority, fileOrder) };
  return request?.mode === 'chunks' ? chunkStep(placed, request.chunks, priority) : placed;
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
 * opened in. A subsample's cells open in **priority order**
 * (`priorityOrder`): its first `m` cells are a sample at every `m`, so an
 * opening read in parts, a column index built in parts, or a larger
 * subsample of the same method and seed, appends to what is open.
 *
 * `fileRows`, the file row of each open cell in open order (null: every
 * row, in file order); `openOrder`, the original position of each open cell
 * in open order (null: open cell `i` is original position `kept[i]`, or `i`);
 * `prefix`, the count when the open cells are file rows `[0, prefix)` (a
 * uniform subsample under a priority-ordered file's seed), else null.
 * `ordered`: whether open order is a priority order, so that any run of
 * consecutive open cells is a sample (every subsample's is; a priority-ordered
 * file's file order is, opened whole).
 */
async function placeInFile(resolution, nObs, priority, fileOrder) {
  const { kept, spec } = resolution;
  if (priority === null) {
    if (kept === null) return { fileRows: null, openOrder: null, prefix: null, prioritySeed: null, levels: null, ordered: false };
    const openOrder = priorityOrder(spec, kept);
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
  if (spec?.method === 'uniform' && spec.seed === priority.seed) {
    // ... and checked to be the cells the specification keeps.
    // Their order is the seed's (the kept cells by rank); the stored
    // column's first rows check it.
    // The stored column's first rows, read once with the record (never
    // again on a resize), must be the first of them.
    const openOrder = priorityOrder(spec, kept);
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
  const order = await fileOrder();
  const rowOf = allocateTypedArray(Uint32Array, nObs, 'File rows');
  for (let row = 0; row < nObs; row++) rowOf[order[row]] = row;
  const openOrder = priorityOrder(spec, kept);
  const fileRows = allocateTypedArray(Uint32Array, openOrder.length, 'File rows');
  for (let i = 0; i < openOrder.length; i++) fileRows[i] = rowOf[openOrder[i]];
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
async function resolveInOriginalSpace(root, request, nObs, priority, fileOrder, { valuesOnDemand, decodedChunkBytes, readOptions = {}, budgets = {} }) {
  // A priority-ordered file's seed is the default: its uniform subsamples are prefixes.
  const defaultSeed = priority?.seed ?? DEFAULT_SUBSAMPLE_SEED;
  const all = { nObs, kept: null, spec: null, autoFit: null, reproduced: null, note: null };
  const mode = request?.mode ?? 'all';
  if (mode === 'all') return all;
  if (mode === 'auto') {
    const fit = autoFitCount(root, nObs, { valuesOnDemand, decodedChunkBytes, ...budgets });
    if (fit === null) return all;
    // Whole blocks aligned to the storage: the cells left out are never
    // read. A uniform subsample's cells lie in most chunks of a row-chunked
    // array (HLCA, 5 cells a chunk: 10 % of the cells touch 45 % of X's
    // chunks), so its genes would read most of the matrix.
    // A priority-ordered file: uniform under its seed, a prefix of every array.
    const spec = requireSubsampleSpec(priority !== null
      ? { method: 'uniform', nObs, k: fit.k, seed: priority.seed }
      : { method: 'blocks', nObs, k: fit.k, seed: DEFAULT_SUBSAMPLE_SEED, blockSize: defaultBlockSize(root, nObs) });
    return { nObs, kept: await keptCellsOf(root, spec, readOptions, fileOrder), spec, autoFit: fit, reproduced: null, note: null };
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
    const spec = specOf({ ...resolved, method: resolved.method ?? defaultSubsampleMethod(priority), seed: resolved.seed ?? defaultSeed }, root, nObs);
    if (spec === null) return all;
    return { nObs, kept: await keptCellsOf(root, spec, readOptions, fileOrder), spec, autoFit: null, reproduced: null, note };
  }
  if (mode === 'chunks') {
    // A subsample grown from few chunks: the subsample here, its step's
    // cells taken by `chunkStep`.
    const spec = requireSubsampleSpec(request.spec);
    if (spec.nObs !== nObs) throw new Error(`A subsample of ${formatCountOf(spec.nObs, 'cell')} is not of this dataset of ${formatCountOf(nObs, 'cell')}`);
    return { nObs, kept: await keptCellsOf(root, spec, readOptions, fileOrder), spec, autoFit: request.autoFit ?? null, reproduced: null, note: null };
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
    try {
      const again = await keptCellsOf(root, spec, readOptions, fileOrder);
      reproduced = again !== null && again.length === identity.kept.length && again.every((p, i) => p === identity.kept[i]);
    } catch {
      // A field or embedding the specification read is gone: the recorded
      // cells stand; only that they are reproducible is unknown.
      reproduced = false;
    }
    // The same cells opened again (a page restored from the back/forward
    // cache, a cancelled reading undone) keep what they were: fitted to the
    // device, or not reproducible by their specification.
    if (request.reproduced === false) reproduced = false;
    return { nObs, kept: identity.kept, spec, autoFit: request.autoFit ?? null, reproduced, note: null };
  }
  throw new TypeError(`Unknown cell subset request mode '${String(mode)}'`);
}

