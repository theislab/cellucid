/**
 * Gene columns and cell rows of an expression matrix (`X`, `layers/<name>`,
 * `raw/X`): one gene's value in every cell, as a dense float32 column or as
 * its non-zero entries (`SparseColumn`, `sparse-column-index.js`); one cell's
 * non-zero genes; and some genes in some cells (a cell subset).
 *
 * How a column is reached is chosen from how the matrix is stored, so that a
 * gene reads as little as its layout allows:
 *
 * - **CSC** (stored by gene): the column pointers are read once (when the
 *   dataset opens, for `X`); a gene then reads only its own entries -- its
 *   row indices and values fetched together.
 * - **Dense, chunked by gene strips** (each chunk spans fewer genes than
 *   the matrix, a Loom file's 64-gene strips among them): a gene reads only
 *   the chunks of its strip, in parallel, streamed within the store's decode
 *   budget. The store keeps decoded chunks (its decoded-chunk cache, sized by
 *   the `decodedBlocks` budget), so when a strip fits it the neighboring
 *   genes of a strip decode nothing again; that budget decides reuse only,
 *   never the route (`geneLayoutOf`).
 * - **CSR** (stored by cell), or **dense** stored in one piece or in chunks
 *   spanning every gene: every gene is spread over the whole matrix, so the
 *   matrix is indexed by gene once, streaming (`RowMajorColumnIndex`), and a
 *   gene asked for meanwhile is answered from the same pass. A CSR matrix of
 *   a fast link is indexed ahead, in the background (`prepare`); a dense
 *   one only when its first gene is asked for, since its index holds every
 *   value (`AnnDataReader.prepareMatrix`). Dense strips too wide to keep
 *   decoded are indexed the same way when their index fits memory.
 *
 * Rows are the mirror image: a CSR row (stored by cell) reads only its own
 * entries; a dense row reads the chunks of its row strip; the rows of a CSC
 * matrix are a cell subset of every gene, read by gene (each gene's entries,
 * or a priority-ordered file's prefix of them, keeping the cells':
 * `AnnDataReader.readMatrixRows`), never an index of every stored row.
 *
 * A cell subset is read by whichever of the two costs less
 * (`readCellSubset`): the cells' rows, or the genes' columns. What either
 * costs is counted in the bytes it decodes or copies: a row or column range
 * of a chunked array costs every chunk it touches (a chunk is decoded whole),
 * a column of a built index costs its entries in memory, and an index still
 * being built costs what is left of its pass as well. A byte read from the
 * store over a link slower than the reader turns bytes into an index costs
 * as much more as the link is slower (`sourceWeight`): two large groups of a
 * 1M-cell CSR `.h5ad` over 5 MB/s read from the built index in memory, not
 * 400 MB of rows again.
 *
 * Reads of many columns or rows at once are issued together, so the store
 * plans them as one set of coalesced, parallel requests.
 *
 * @module data/anndata/matrix-access
 */

import { isGroup } from '../../formats/store.js';
import { allocateTypedArray, copyTypedArray, RowMajorColumnIndex, sparseColumnOf, sparseColumnOfDense, sparseIndexPlan } from '../sparse-column-index.js';
import { isAnnDataMatrixDataKind } from '../anndata-value-kinds.js';
import { AnnDataFormatError, elementBytes, encodingType, shapeOf, validateArrayEncoding, valueKind } from './elements.js';
import { checkPointers, sparseContract } from './sparse.js';
import { SLAB_BYTES, readIntegers, readNumbers, writeFloat32 } from './values.js';
import { keepSubsetEntries, keepSubsetRun, sortSubsetEntries } from './subset-entries.js';
import { releaseDecodeContext, retainDecodeContext, runOnDecodeWorker } from '../../formats/io/decode-pool.js';
import { READ_AHEAD_BYTES_PER_MS, roundTripBytesOf } from '../../formats/io/link.js';
import { subsetEntriesScript } from '../../../workers/scripts.js';
import { canTransfer } from '../../utils/large-arrays.js';
import { formatCountOf } from '../../utils/format-units.js';
import { residencyBudgetBytes } from '../memory-budget.js';

/** The kernel of a cell subset read by gene, for a decode worker to load. */
const SUBSET_ENTRIES_MODULE = subsetEntriesScript().href;

/** Each cell subset read's own decode context (its cells' positions). */
let nextSubsetContext = 1;

/** Bytes one entry of a built sparse index holds in memory: a uint32 row and a float32 value. */
const INDEX_ENTRY_BYTES = 8;

/**
 * What a byte read from the store costs against a byte copied in memory, as
 * the link is measured now: 1 where the store delivers bytes as fast as the
 * reader turns them into an index (a local file, a fast host: `readsAhead`),
 * else how many times slower its link is (`READ_AHEAD_BYTES_PER_MS` over its
 * bandwidth).
 *
 * @param {{link?: (() => Object|null)|null}} [indexOptions]
 * @returns {() => number}
 */
function sourceWeight(indexOptions) {
  return () => {
    const link = indexOptions?.link?.() ?? null;
    if (link === null || link.readsAhead || !(link.bytesPerMs > 0)) return 1;
    return Math.max(1, READ_AHEAD_BYTES_PER_MS / link.bytesPerMs);
  };
}

/** A typed array owning its whole buffer (one that can be transferred), copied out when it is a view. */
function wholeBuffer(values) {
  return values.byteOffset === 0 && values.byteLength === values.buffer.byteLength ? values : values.slice();
}

/**
 * The first chunk extent of a one-dimensional array, or null when any range
 * of it costs only its own bytes (stored in one piece, or in chunks fetched
 * by the run a read needs: `partialChunks`).
 */
function chunkElements(array) {
  if (array?.partialChunks === true) return null;
  const chunk = Array.isArray(array?.chunks) ? Number(array.chunks[0]) : null;
  return Number.isSafeInteger(chunk) && chunk > 0 ? chunk : null;
}

/**
 * Decoded bytes of the chunks of a one-dimensional `array` that the entry
 * ranges `[starts[i], ends[i])` touch, the ranges ascending by start: a chunk
 * is decoded whole, so a range costs its chunks, and a chunk two ranges share
 * is counted once. An array stored in one piece costs only the ranges' bytes.
 * A subsample's view of an array (`views/cell-subset.js` `gatheredArray`)
 * has chunks of its kept entries of each stored chunk: each one touched
 * costs the stored chunk it is part of, decoded whole (priced at its kept
 * entries, a 10% share's DE groups were read by their rows, 161 MB priced,
 * against its gene index already built, and read and decoded 750 MB).
 */
function touchedChunkBytes(array, starts, ends, count) {
  const bytes = elementBytes(array);
  const chunk = chunkElements(array);
  let total = 0;
  if (chunk === null) {
    for (let i = 0; i < count; i++) total += Math.max(0, ends[i] - starts[i]);
    return total * bytes;
  }
  let last = -1;
  for (let i = 0; i < count; i++) {
    if (ends[i] <= starts[i]) continue;
    let first = Math.floor(starts[i] / chunk);
    const stop = Math.floor((ends[i] - 1) / chunk);
    if (first <= last) first = last + 1;
    if (stop >= first) total += stop - first + 1;
    if (stop > last) last = stop;
  }
  return total * (chunkElements(array.gather?.source) ?? chunk) * bytes;
}

/**
 * Where `row` is in the ascending `sorted` from `from` on (the first
 * position holding `row` or more), galloping: a gene's ascending rows walk
 * the kept rows once.
 */
function gallopRows(sorted, row, from) {
  let low = from;
  let high = from;
  let step = 1;
  while (high < sorted.length && sorted[high] < row) {
    low = high + 1;
    high += step;
    step *= 2;
  }
  if (high > sorted.length) high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle] < row) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * About how many decoded bytes of a gene's value chunks hold no kept row,
 * before its rows are read: the gene's entries taken as spread evenly over
 * the stored rows, so entry `start + (end - start) * row / nRows` is about
 * row `row`'s, and the kept rows' runs touch the value chunks of their
 * entries. A gene of a foreign gene-major file at a 1% blocks subsample
 * leaves about half of its chunks untouched; at 10% nearly none (each chunk
 * spans millions of rows).
 */
function keptValueChunksSave(array, keptRuns, nRows, start, end) {
  const chunk = chunkElements(array);
  const bytes = elementBytes(array);
  if (chunk === null) return 0;
  const first = Math.floor(start / chunk);
  const last = Math.floor((end - 1) / chunk);
  const all = last - first + 1;
  // A gene within one chunk saves nothing.
  if (all < 2) return 0;
  const perRow = (end - start) / Math.max(1, nRows);
  let touched = 0;
  let lastTouched = -1;
  for (let r = 0; r < keptRuns.starts.length && touched < all; r++) {
    const from = Math.max(first, Math.floor((start + keptRuns.starts[r] * perRow) / chunk));
    const to = Math.min(last, Math.floor((start + keptRuns.ends[r] * perRow) / chunk));
    const begin = Math.max(from, lastTouched + 1);
    if (to >= begin) touched += to - begin + 1;
    if (to > lastTouched) lastTouched = to;
  }
  return (all - touched) * chunk * bytes;
}

/** The runs of consecutive rows of an ascending row list: `{starts, ends}`. */
function rowRunsOf(sorted) {
  const starts = [];
  const ends = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] === sorted[i - 1] + 1) ends[ends.length - 1] = sorted[i] + 1;
    else {
      starts.push(sorted[i]);
      ends.push(sorted[i] + 1);
    }
  }
  return { starts: Float64Array.from(starts), ends: Float64Array.from(ends) };
}

/** Positions `0..n-1` of `values` ordered by value (ascending, stable). */
function ascendingOrder(values) {
  const order = allocateTypedArray(Uint32Array, values.length, 'Cell order');
  for (let i = 0; i < order.length; i++) order[i] = i;
  let sorted = true;
  for (let i = 1; i < values.length && sorted; i++) sorted = values[i] > values[i - 1];
  if (!sorted) order.sort((a, b) => values[a] - values[b] || a - b);
  return { order, ascending: sorted };
}

/**
 * The entry ranges of `positions` (sorted ascending) under `pointers`, for
 * the cost of reading them.
 */
function rangesOf(pointers, positions) {
  const starts = allocateTypedArray(Float64Array, positions.length, 'Entry range starts');
  const ends = allocateTypedArray(Float64Array, positions.length, 'Entry range ends');
  positions.forEach((position, i) => {
    starts[i] = pointers[position];
    ends[i] = pointers[position + 1];
  });
  return { starts, ends };
}

/**
 * One CSC gene's entries `from..to` of `rows`/`values` (arrays read from
 * stored entry `start` on, which errors name), rows checked within `nObs`
 * and sorted ascending (stable) when stored unsorted.
 */
function checkedColumnEntries(rows, values, from, to, start, nObs) {
  let sorted = true;
  for (let entry = from; entry < to; entry++) {
    const row = rows[entry];
    if (!(row >= 0 && row < nObs) || !Number.isInteger(row)) {
      throw new AnnDataFormatError(
        `Sparse column row index ${row} at entry ${start + entry} is outside its ${nObs}-row shape`
      );
    }
    if (entry > from && row < rows[entry - 1]) sorted = false;
  }
  if (sorted) {
    return from === 0 && to === rows.length
      ? { rows, values, count: rows.length }
      : { rows: rows.subarray(from, to), values: values.subarray(from, to), count: to - from };
  }
  const order = allocateTypedArray(Uint32Array, to - from, 'Gene column order');
  for (let i = 0; i < order.length; i++) order[i] = from + i;
  order.sort((a, b) => rows[a] - rows[b] || a - b);
  const sortedRows = allocateTypedArray(Float64Array, to - from, 'Gene column cells');
  const sortedValues = allocateTypedArray(Float64Array, to - from, 'Gene column values');
  for (let i = 0; i < order.length; i++) {
    sortedRows[i] = rows[order[i]];
    sortedValues[i] = values[order[i]];
  }
  return { rows: sortedRows, values: sortedValues, count: to - from };
}

/** Whether `array` holds integers only, by its type (row indices need no integer check). */
function isIntegralArray(array) {
  return array instanceof Int32Array || array instanceof Uint32Array ||
    array instanceof Int16Array || array instanceof Uint16Array ||
    array instanceof Int8Array || array instanceof Uint8Array;
}

/** Whether values read from `array` must be summed in float64 before rounding (wider than float32 holds). */
function widerThanFloat32(array) {
  const { kind, bytes } = array.dtype;
  return (kind === 'float' && bytes > 4) || ((kind === 'int' || kind === 'uint') && bytes > 2);
}

/**
 * Access through a background index (`RowMajorColumnIndex`), made by
 * `create(options)`. Each build of the index -- started by the first column
 * asked for, or `prepare()` ahead of need -- gets its own activity
 * (`onIndexStart(label)`), which its reads count into and its progress
 * updates, finished when the index is built (or canceled, when the last
 * gene it was built for is withdrawn). `storedBytes(index, {values})` is what
 * a pass will read, for how much is left: a second pass (the store filled
 * from the matrix after an indices-only first pass) expects its bytes when it
 * starts. A matrix no store can hold is scanned once per batch of waiting
 * genes, each scan its own activity (`onIndexStart(label, {rescan: reason})`),
 * so it is never a silent wait. `cost` prices reading columns through it:
 * `passBytes` (what the whole pass decodes), `entryBytes` (what one entry
 * costs once built) and `defaultEntries` (a column's entries before they are
 * counted).
 */
function createIndexAccess(indexOptions, indexReadOptions, onIndexStart, storedBytes = null, cost) {
  const weight = sourceWeight(indexOptions);
  return create => {
    const expect = (activity, options) => {
      if (activity !== null && storedBytes !== null) {
        storedBytes(index, options).then(bytes => activity.expect(bytes), () => {});
      }
    };
    const index = create({
      ...indexOptions,
      // What building it by a pass is priced at: its pass at the rate an
      // index is built (`READ_AHEAD_BYTES_PER_MS`), slower over a slower
      // link. A gene index kept in this browser priced higher to read is
      // built instead (`RowMajorColumnIndex` `rebuildMs`).
      rebuildMs: () => cost.passBytes * weight() / READ_AHEAD_BYTES_PER_MS,
      onProgress: event => {
        indexOptions.onProgress?.(event);
        if (event.phase === 'unindexed') return;
        indexReadOptions.activity?.progress(event.done, event.total);
      },
      // Pass 2's reads, exactly: what it reads again of what pass 1 did not keep.
      onSecondPass: reads => expect(indexReadOptions.activity, { secondPass: reads }),
      onUnindexedScan: reason => {
        const activity = onIndexStart?.(index._label, { rescan: reason }) ?? null;
        if (activity !== null) activity.background = false;
        indexReadOptions.activity = activity;
        expect(activity, { values: true });
        return error => activity?.finish(error);
      },
      // Each build its own activity, whoever started it (a gene, `prepare`,
      // or a gene asked for while a stopped build let go).
      onBuild: build => {
        const activity = onIndexStart?.(index._label) ?? null;
        if (activity !== null && waited) activity.background = false;
        indexReadOptions.activity = activity;
        expect(activity);
        build.then(() => activity?.finish(), error => activity?.finish(error));
      },
    });
    let waited = false;
    const start = (ahead = false) => index.start({ ahead });
    const waiting = () => {
      waited = true;
      start();
      // Someone now waits for the index: its reads are no longer background.
      if (indexReadOptions.activity) indexReadOptions.activity.background = false;
    };
    return {
      column: (gene, options = {}) => {
        waiting();
        return index.column(gene, { signal: options.signal ?? null });
      },
      sparseColumn: (gene, options = {}) => {
        waiting();
        return index.sparseColumn(gene, { signal: options.signal ?? null });
      },
      entryCount: gene => index.entryCount(gene) ?? cost.defaultEntries,
      readCost(genes) {
        let entries = 0;
        for (const gene of genes) entries += index.entryCount(gene) ?? cost.defaultEntries;
        return index.remaining * cost.passBytes * weight() + entries * cost.entryBytes;
      },
      // What is left of building it: paid once, by the first read that
      // waits for it, whatever reads follow (`cellSubsetRunCosts`).
      passCost: () => index.remaining * cost.passBytes * weight(),
      // Whether the index is built, and the memory it holds (what it will
      // hold, until it is built).
      built: () => index.phase === 'ready',
      // Whether a pass is building it now (it holds what it builds as it goes).
      building: () => index.phase === 'counting' || index.phase === 'indexing',
      residentBytes: () => index.storeBytes ?? cost.residentBytes,
      prepare: () => start(true),
      retire: () => index.retire(),
      dispose: () => index.dispose(),
    };
  };
}

/**
 * The stored bytes an index pass over `matrix` reads: a dense matrix whole;
 * a sparse one's pointers and indices, and its values unless the index
 * leaves them in the file (`valuesOnDemand`, over the network) and the pass
 * does not read them (`values`: a scan without an index reads them); pass 2
 * (`secondPass`: its entry ranges, `RowMajorColumnIndex` `onSecondPass`)
 * its pointers and the ranges it reads again.
 */
function indexPassBytes(matrix, format, label) {
  return async (index, { values = !index.valuesOnDemand, secondPass = null } = {}) => {
    if (!isGroup(matrix)) return matrix.storedBytes();
    const sparse = sparseContract(matrix, format, `Sparse ${label}`);
    if (secondPass !== null) {
      const sizes = await Promise.all([
        sparse.indptrArray.storedBytes(),
        ...secondPass.indices.map(range => sparse.indicesArray.storedBytes([range])),
        ...secondPass.values.map(range => sparse.dataArray.storedBytes([range])),
      ]);
      return sizes.reduce((sum, bytes) => sum + bytes, 0);
    }
    const parts = [sparse.indptrArray, sparse.indicesArray];
    if (values) parts.push(sparse.dataArray);
    const sizes = await Promise.all(parts.map(array => array.storedBytes()));
    return sizes.reduce((sum, bytes) => sum + bytes, 0);
  };
}

/** A duplicate coordinate's sum, in float32 as every gene payload. */
function addSparseFloat32(current, value) {
  return Math.fround(current + value);
}

/**
 * @typedef {Object} MatrixColumns
 * @property {(gene: number, options?: {signal?: AbortSignal|null, activity?: Object|null}) => Promise<Float32Array>} column
 * @property {(gene: number, options?: Object) => Promise<import('../sparse-column-index.js').SparseColumn>} sparseColumn
 * @property {(gene: number) => number} entryCount - Stored entries of a column (known or expected)
 * @property {(genes: ReadonlyArray<number>) => number} readCost - Bytes reading these columns decodes or copies
 * @property {() => number} [passCost] - Of `readCost`, what is left of building the gene index: paid once by a run, whatever its reads (none for a layout read as stored)
 * @property {(gene: number) => number} [entryStart] - A CSC column's first stored entry
 * @property {(start: number, end: number, options?: Object) => Promise<[ArrayLike<number>, ArrayLike<number>]>} [readEntries] -
 *   The row indices and values of stored entries `[start, end)` (a CSC matrix: consecutive genes' entries are one range)
 * @property {boolean} [integerRows] - Whether `readEntries` gives integer row indices
 * @property {(rows: ArrayLike<number>, values: ArrayLike<number>, from: number, to: number, start: number) => {rows: ArrayLike<number>, values: ArrayLike<number>, count: number}} [checkedEntries] -
 *   One gene's entries `from..to` of a range read from entry `start`, rows checked and sorted
 * @property {(gene: number, rows: ArrayLike<number>, from: number, to: number) => void} [requireEntries] -
 *   Check what a read takes of a gene, rows `from..to` of a range read, where it takes less than the
 *   gene's stored entries (`entryCount`: a priority-ordered file opened as a prefix reads each gene's
 *   counted entries and the next); throws when the file is damaged
 * @property {() => Promise<void>} [prepare] - Start a background index
 * @property {() => void} [retire] - Answer reads under way, then release
 * @property {() => void} [dispose]
 */

/**
 * The memory a cell-major matrix's gene index (`RowMajorColumnIndex`) holds
 * once built: a sparse matrix's stored entries (a uint32 row each, and a
 * float32 value unless values are read per gene, `valuesOnDemand`) and its
 * pointers; values read per gene but bought with the first gene
 * (`valuesBought`: stored in chunks read whole, `sparseIndexPlan`
 * `buysValues`) add their float32 each; a dense matrix's every value as
 * float32. What `openMatrixColumns` budgets an index at, and what a
 * subsampled opening sizes a subsample and its gene sample to fit
 * (`subsample-plan.js`): one memory model with what the index holds.
 *
 * @param {{layout: 'sparse'|'dense', nnz?: number, nObs: number, nVars: number, valuesOnDemand?: boolean, valuesBought?: boolean}} matrix
 * @returns {number}
 */
export function columnIndexResidentBytes({ layout, nnz = 0, nObs, nVars, valuesOnDemand = false, valuesBought = false }) {
  if (layout === 'dense') return nObs * nVars * 4;
  return valuesOnDemand ? nnz * (valuesBought ? 8 : 4) + (nObs + nVars) * 8 : nnz * INDEX_ENTRY_BYTES + nVars * 16;
}

/**
 * Whether an array is read a whole stored chunk at a time (compressed or
 * filtered chunks: one value costs its chunk), not by range: a gathered
 * array (a subsample's, a segment's rows) as the array it reads.
 */
export function readInWholeChunks(array) {
  const stored = array?.gather?.source ?? array;
  return Array.isArray(stored?.chunks) && stored.chunks.length > 0 && stored.partialChunks !== true;
}

/**
 * How the genes of one expression matrix are read: the one rule behind
 * `openMatrixColumns`, `geneReadCost`, `readsThroughRowIndex` and the
 * sizing of a subsampled opening (`subsample-plan.js`). The routes are
 * weighed by what they cost, not by what a cache holds:
 *
 * - `csc`: stored by gene; a gene reads its own entries.
 * - `csr`: stored by cell; the genes are read through a gene index, built
 *   by one pass over the matrix.
 * - `dense-strips`: dense, chunked in strips of genes; a gene reads its
 *   strip's chunks, about `1 / strips` of the matrix. Decoded chunks are
 *   kept up to `decodedChunkBytes`, so when a strip fits, its other genes
 *   decode nothing again; when it does not, each gene decodes its strip
 *   anew, still a fraction of one pass.
 * - `dense-wide-strips`: dense in strips too wide to keep decoded, whose
 *   gene index fits the memory kept for gene indexes
 *   (`columnIndexBytes`): one pass through every strip indexes them all,
 *   and every gene after it is read from memory. An index that does not
 *   fit memory would make the first gene read and spill the whole matrix
 *   (or, with no room on disk, every gene read it again), so such a matrix
 *   is read by strip.
 * - `dense-rows`: dense in one piece, or in chunks spanning every gene
 *   that the decoded-chunk budget does not hold: every gene lies in every
 *   chunk, so the genes are read through a gene index.
 *
 * @param {Object} matrix - The matrix node (a sparse group or a dense array)
 * @param {{nObs: number, nVars: number, decodedChunkBytes: number, columnIndexBytes?: number}} context
 * @returns {'csc'|'csr'|'dense-strips'|'dense-wide-strips'|'dense-rows'}
 */
export function geneLayoutOf(matrix, { nObs, nVars, decodedChunkBytes, columnIndexBytes = residencyBudgetBytes('columnIndex') }) {
  if (isGroup(matrix)) return encodingType(matrix) === 'csc_matrix' ? 'csc' : 'csr';
  const chunks = Array.isArray(matrix.chunks) ? matrix.chunks : null;
  if (chunks === null) return 'dense-rows';
  const stripColumns = Math.min(chunks[1], nVars);
  if (nObs * stripColumns * elementBytes(matrix) <= decodedChunkBytes) return 'dense-strips';
  if (stripColumns >= nVars) return 'dense-rows';
  return columnIndexResidentBytes({ layout: 'dense', nObs, nVars }) <= columnIndexBytes ? 'dense-wide-strips' : 'dense-strips';
}

/**
 * What reading genes of one expression matrix costs, known from its metadata
 * before any gene is read: what the person is told before the first gene of
 * a cell-major matrix (`AnnDataReader.geneReadPlan`), and what a subsampled
 * opening weighs (pass the matrix as the subsample presents it: a view of
 * the kept rows, whose stored bytes are those of the chunks it fetches).
 *
 * - `cellMajor`: a gene is spread over every cell (CSR, or dense in chunks
 *   spanning many genes), so the first gene reads the whole matrix (`scan`);
 *   a gene-major matrix (CSC, dense in gene strips) reads only its own.
 * - `scan`: the stored bytes the index pass reads before the first gene is
 *   whole (`storedBytes`; null when the store cannot say without reading),
 *   those of them it fetches now (`fetchBytes`: none of what this browser
 *   keeps from an earlier reading of the file, `io/kept-parts.js`), the
 *   bytes they decode to (`valueBytes`), and the entries it walks.
 * - `index`: the index the pass builds (`sparseIndexPlan`): `residentBytes`
 *   in memory, `storeBytes` for a store pass 2 fills (`passes` 2: its own
 *   stored bytes again, `secondPassStoredBytes`).
 *
 * @param {Object} matrix - The matrix node (a sparse group or a dense array)
 * @param {{format: Object, label: string, nObs: number, nVars: number, decodedChunkBytes: number, valuesOnDemand: boolean, retainIndicesBytes: number}} context
 * @returns {Promise<{cellMajor: boolean, layout: string, entries: number, scan: {storedBytes: number|null, fetchBytes: number|null, valueBytes: number}|null, index: {residentBytes: number, passes: 1|2, storeBytes: number, secondPassStoredBytes: number|null}|null}>}
 */
export async function geneReadCost(matrix, { format, label, nObs, nVars, decodedChunkBytes, valuesOnDemand, retainIndicesBytes, columnIndexBytes = residencyBudgetBytes('columnIndex') }) {
  const stored = async (arrays, options = {}) => {
    try {
      const sizes = await Promise.all(arrays.map(array => array.storedBytes(undefined, options)));
      return sizes.every(Number.isFinite) ? sizes.reduce((sum, bytes) => sum + bytes, 0) : null;
    } catch {
      // A store that cannot say without reading (a Zarr folder over HTTP).
      return null;
    }
  };
  if (isGroup(matrix)) {
    const sparse = sparseContract(matrix, format, `Sparse ${label}`);
    const nnz = sparse.dataLength;
    if (sparse.format === 'csc') {
      return { cellMajor: false, layout: 'csc', entries: nnz, scan: null, index: null };
    }
    const plan = sparseIndexPlan({ nnz, nCols: nVars, nRows: nObs, valuesOnDemand, retainIndicesBytes, valuesInWholeChunks: readInWholeChunks(sparse.dataArray) });
    // Values read per gene are not the pass's, unless it buys them (`buysValues`).
    const passValues = !valuesOnDemand || plan.buysValues;
    const firstPass = [sparse.indptrArray, sparse.indicesArray, ...(passValues ? [sparse.dataArray] : [])];
    // A build this gene starts: the gene waits through pass 1, so pass 2
    // reads again only what pass 1 does not keep (`sparseIndexPlan`).
    const secondPass = [
      sparse.indptrArray,
      ...(plan.keepsIndices ? [] : [sparse.indicesArray]),
      ...(plan.keepsValues ? [] : [sparse.dataArray]),
    ];
    const [storedBytes, fetchBytes, secondPassStoredBytes] = await Promise.all([
      stored(firstPass),
      stored(firstPass, { toFetch: true }),
      plan.passes === 2 ? stored(secondPass) : null,
    ]);
    return {
      cellMajor: true,
      layout: 'csr',
      entries: nnz,
      scan: {
        storedBytes,
        fetchBytes,
        valueBytes: (nObs + 1) * elementBytes(sparse.indptrArray) +
          nnz * (elementBytes(sparse.indicesArray) + (passValues ? elementBytes(sparse.dataArray) : 0)),
      },
      index: {
        residentBytes: columnIndexResidentBytes({ layout: 'sparse', nnz, nObs, nVars, valuesOnDemand, valuesBought: plan.buysValues }),
        passes: plan.passes,
        storeBytes: plan.storeBytes,
        secondPassStoredBytes,
      },
    };
  }
  const bytes = elementBytes(matrix);
  const layout = geneLayoutOf(matrix, { nObs, nVars, decodedChunkBytes, columnIndexBytes });
  if (layout === 'dense-strips') {
    return { cellMajor: false, layout, entries: nObs * nVars, scan: null, index: null };
  }
  const residentBytes = columnIndexResidentBytes({ layout: 'dense', nObs, nVars });
  return {
    cellMajor: true,
    layout,
    entries: nObs * nVars,
    scan: { storedBytes: await stored([matrix]), fetchBytes: await stored([matrix], { toFetch: true }), valueBytes: nObs * nVars * bytes },
    index: { residentBytes, passes: 1, storeBytes: residentBytes, secondPassStoredBytes: null },
  };
}

/**
 * Whether `openMatrixColumns` reads a matrix's genes through a row-major
 * index (`RowMajorColumnIndex`): a CSR matrix, or a dense one whose genes
 * are not read by strip (`geneLayoutOf`). A CSC matrix and a dense one read
 * by strip read each gene as stored.
 *
 * @param {Object} matrix
 * @param {{nObs: number, nVars: number, decodedChunkBytes: number, columnIndexBytes?: number}} context
 * @returns {boolean}
 */
export function readsThroughRowIndex(matrix, context) {
  const layout = geneLayoutOf(matrix, context);
  return layout !== 'csc' && layout !== 'dense-strips';
}

/**
 * Open column access to one matrix.
 *
 * @param {Object} matrix - The matrix node (a sparse group or a dense array)
 * @param {Object} context
 * @param {import('./elements.js').AnnDataFormat} context.format
 * @param {string} context.label - `X`, `layers['…']`, `raw.X`
 * @param {number} context.nObs
 * @param {number} context.nVars
 * @param {number} context.decodedChunkBytes - The store's decoded-chunk budget
 * @param {number} [context.columnIndexBytes] - The memory kept for gene indexes (`geneLayoutOf`)
 * @param {Object} context.indexOptions - `RowMajorColumnIndex` options (store factory, progress …)
 * @param {(label: string) => (Object|null)} [context.onIndexStart] - The activity of a background index, made when it starts
 * @param {Object} [context.readOptions] - Read options of opening (reading CSC pointers)
 * @param {Promise<ArrayLike<number>>|null} [context.pointers] - A CSC matrix's
 *   column pointers, already being read (the dataset's `X`, read as it opens)
 * @param {Uint32Array|null} [context.keptRows] - A subsample's stored rows,
 *   ascending, when a CSC matrix is read through them (`sparseColumn`: only
 *   their entries are wanted; see `keptEntriesOfGene`)
 * @param {() => number} [context.roundTripBytes] - What one round trip of the
 *   link is worth in bytes (0 for a local file)
 * @returns {Promise<MatrixColumns>}
 */
export async function openMatrixColumns(matrix, { format, label, nObs, nVars, decodedChunkBytes, columnIndexBytes = residencyBudgetBytes('columnIndex'), indexOptions, onIndexStart = null, readOptions = {}, pointers: pointerRead = null, keptRows = null, roundTripBytes = () => 0 }) {
  const indexReadOptions = { activity: null };
  const weight = sourceWeight(indexOptions);

  if (isGroup(matrix)) {
    const sparse = sparseContract(matrix, format, `Sparse ${label}`);
    if (sparse.shape[0] !== nObs || sparse.shape[1] !== nVars) {
      throw new AnnDataFormatError(
        `Sparse ${label} shape ${sparse.shape[0]}×${sparse.shape[1]} does not match ${formatCountOf(nObs, 'cell')} and ${formatCountOf(nVars, 'gene')}`
      );
    }
    const dataLabel = `Sparse ${label} data`;
    const indexLabel = `Sparse ${label} index`;
    const pointerLabel = `Sparse ${label} indptr`;
    // Values go straight into float32 destinations, rounded as they are stored.
    const readValues = (start, end, options = indexReadOptions) => readNumbers(sparse.dataArray, start, end, dataLabel, options);
    const readIndices = (start, end, options = indexReadOptions) => readIntegers(sparse.indicesArray, start, end, indexLabel, options);

    if (sparse.format === 'csc') {
      const raw = await (pointerRead ?? readIntegers(sparse.indptrArray, 0, nVars + 1, pointerLabel, readOptions));
      const pointers = raw instanceof Float64Array ? raw : copyTypedArray(Float64Array, raw, pointerLabel);
      checkPointers(pointers, sparse.dataLength, `Sparse ${label}`);
      // The kept rows' runs, once (a gene's estimate walks them, not every kept row).
      const keptRuns = keptRows === null ? null : rowRunsOf(keptRows);
      /** One gene's entries: rows checked, sorted ascending (stable) when stored unsorted. */
      // A gene's kept entries alone, when the value chunks it would skip
      // cost more than the round trip the extra read adds. Shared over the
      // genes read at once, that round trip looked cheaper; measured, the
      // runs' extra requests made 100 genes of a 1% subsample slower
      // (3.2 s against 2.7 s, 150 ms at 5 MB/s) for 13% fewer bytes.
      const entries = async (gene, options) => {
        const start = pointers[gene];
        const end = pointers[gene + 1];
        if (end === start) return { rows: new Uint32Array(0), values: new Float64Array(0), count: 0 };
        if (keptRuns !== null && keptValueChunksSave(sparse.dataArray, keptRuns, nObs, start, end) > roundTripBytes()) {
          return keptEntriesOfGene(start, end, options);
        }
        const [rows, values] = await Promise.all([readIndices(start, end, options), readValues(start, end, options)]);
        return checkedColumnEntries(rows, values, 0, rows.length, start, nObs);
      };
      /**
       * A gene's entries at the kept rows only: its row indices first, then
       * the values of the kept entries' runs alone -- one round trip more,
       * taken when the value chunks holding no kept entry cost more than it
       * (`keptValueChunksSave`). Its other entries are left out (a subsample
       * reads them for nothing).
       */
      const keptEntriesOfGene = async (start, end, options) => {
        const stored = await readIndices(start, end, options);
        const rows = [];
        const runs = [];
        let position = 0;
        let lastRow = -1;
        for (let entry = 0; entry < stored.length; entry++) {
          const row = Number(stored[entry]);
          if (!(row >= 0 && row < nObs) || !Number.isInteger(row)) {
            throw new AnnDataFormatError(`Sparse column row index ${row} at entry ${start + entry} is outside its ${nObs}-row shape`);
          }
          // Rows stored out of order: the walk starts again.
          if (row < lastRow) position = 0;
          lastRow = row;
          position = gallopRows(keptRows, row, position);
          if (position >= keptRows.length || keptRows[position] !== row) continue;
          rows.push(row);
          const last = runs.at(-1);
          if (last !== undefined && last[1] === start + entry) last[1]++;
          else runs.push([start + entry, start + entry + 1]);
        }
        const parts = await Promise.all(runs.map(([from, to]) => readValues(from, to, options)));
        const values = allocateTypedArray(Float64Array, rows.length, `Sparse ${label} values`);
        let at = 0;
        for (const part of parts) for (let i = 0; i < part.length; i++) values[at++] = Number(part[i]);
        return checkedColumnEntries(Uint32Array.from(rows), values, 0, rows.length, start, nObs);
      };
      return {
        async column(gene, options = {}) {
          const result = allocateTypedArray(Float32Array, nObs, `Sparse ${label}`);
          const start = pointers[gene];
          const end = pointers[gene + 1];
          if (end === start) return result;
          const [rows, values] = await Promise.all([readIndices(start, end, options), readValues(start, end, options)]);
          for (let entry = 0; entry < rows.length; entry++) {
            const row = rows[entry];
            if (!(row >= 0 && row < nObs) || !Number.isInteger(row)) {
              throw new AnnDataFormatError(
                `Sparse column row index ${row} at entry ${start + entry} is outside its ${nObs}-row shape`
              );
            }
            result[row] = addSparseFloat32(result[row], values[entry]);
          }
          return result;
        },
        async sparseColumn(gene, options = {}) {
          const { rows, values, count } = await entries(gene, options);
          return sparseColumnOf(rows, values, count, nObs);
        },
        entryCount: gene => pointers[gene + 1] - pointers[gene],
        // Genes are stored one after another: the entries of a run of genes
        // are one range, read at once (`subsetByColumns`).
        entryStart: gene => pointers[gene],
        readEntries: (start, end, options = {}) => Promise.all([readIndices(start, end, options), readValues(start, end, options)]),
        // What an entry of `readEntries` costs: its row index and its value.
        entryBytes: elementBytes(sparse.indicesArray) + elementBytes(sparse.dataArray),
        // Row indices of an integer dtype read as integers (64-bit ones as
        // exact numbers), so a subset needs no integer check of them.
        integerRows: sparse.indicesArray.dtype.kind !== 'float',
        checkedEntries: (rows, values, from, to, start) => checkedColumnEntries(rows, values, from, to, start, nObs),
        built: () => true,
        residentBytes: () => pointers.byteLength,
        readCost(genes) {
          const ordered = copyTypedArray(Float64Array, genes, 'Gene positions').sort();
          const { starts, ends } = rangesOf(pointers, ordered);
          return (touchedChunkBytes(sparse.indicesArray, starts, ends, ordered.length) +
            touchedChunkBytes(sparse.dataArray, starts, ends, ordered.length)) * weight();
        },
      };
    }

    const nnz = sparse.dataLength;
    const valuesOnDemand = indexOptions.valuesOnDemand === true;
    const valuesInWholeChunks = readInWholeChunks(sparse.dataArray);
    const buysValues = sparseIndexPlan({ nnz, nCols: nVars, nRows: nObs, valuesOnDemand, retainIndicesBytes: indexOptions.retainIndicesBytes ?? 0, valuesInWholeChunks }).buysValues;
    const fromIndex = createIndexAccess(indexOptions, indexReadOptions, onIndexStart, indexPassBytes(matrix, format, label), {
      // Pass 1 reads the indices; read ahead, pass 2 their values too. Over a
      // slower link the values of a gene are fetched as it is read, unless
      // the pass buys them (stored in chunks read whole: `buysValues`).
      passBytes: nnz * (elementBytes(sparse.indicesArray) + (valuesOnDemand && !buysValues ? 0 : elementBytes(sparse.dataArray))),
      entryBytes: valuesOnDemand ? 4 + elementBytes(sparse.dataArray) : INDEX_ENTRY_BYTES,
      defaultEntries: nnz / Math.max(1, nVars),
      residentBytes: columnIndexResidentBytes({ layout: 'sparse', nnz, nObs, nVars, valuesOnDemand, valuesBought: buysValues }),
    });
    return fromIndex(options => new RowMajorColumnIndex({
      ...options,
      label: `Sparse ${label}`,
      layout: 'sparse',
      nRows: nObs,
      nCols: nVars,
      nnz,
      // The index's reads count into its activity and stop with its build.
      readRowPointers: (start, end, { signal = null } = {}) => readIntegers(sparse.indptrArray, start, end, pointerLabel, { ...indexReadOptions, signal }),
      readIndices: (start, end, { signal = null } = {}) => readIndices(start, end, { ...indexReadOptions, signal }),
      readValues: (start, end, { signal = null } = {}) => readValues(start, end, { ...indexReadOptions, signal }),
      valuesStoredBytes: () => sparse.dataArray.storedBytes(),
      valuesInWholeChunks,
    }));
  }

  // Dense matrix.
  validateArrayEncoding(matrix, format, `Dense ${label}`, 'array');
  const shape = shapeOf(matrix, `Dense ${label}`, 2);
  if (shape[0] !== nObs || shape[1] !== nVars) {
    throw new AnnDataFormatError(`Dense ${label} shape ${shape[0]}×${shape[1]} does not match ${formatCountOf(nObs, 'cell')} and ${formatCountOf(nVars, 'gene')}`);
  }
  // A boolean matrix (a mask, a detection call) reads as 0 and 1.
  if (!isAnnDataMatrixDataKind(valueKind(matrix))) {
    throw new AnnDataFormatError(`Dense ${label} must use a numeric or boolean dtype`);
  }
  const bytes = elementBytes(matrix);
  if (!readsThroughRowIndex(matrix, { nObs, nVars, decodedChunkBytes, columnIndexBytes })) {
    const chunks = matrix.chunks;
    const stripColumns = Math.min(chunks[1], nVars);
    const column = async (gene, options = {}) => {
      const values = await matrix.read([[0, nObs], [gene, gene + 1]], options);
      if (!values || values.length !== nObs) {
        throw new Error(`Dense ${label} column payload length does not match the cell count`);
      }
      if (values instanceof Float32Array) return wholeBuffer(values);
      const result = allocateTypedArray(Float32Array, nObs, `Dense ${label}`);
      writeFloat32(values, result, 0);
      return result;
    };
    const stripRows = Math.ceil(nObs / chunks[0]) * chunks[0];
    return {
      column,
      sparseColumn: async (gene, options) => sparseColumnOfDense(await column(gene, options)),
      entryCount: () => nObs,
      built: () => true,
      residentBytes: () => 0,
      readCost(genes) {
        const strips = new Set(Array.from(genes, gene => Math.floor(gene / stripColumns)));
        return strips.size * stripRows * stripColumns * bytes * weight();
      },
    };
  }
  const fromIndex = createIndexAccess(indexOptions, indexReadOptions, onIndexStart, indexPassBytes(matrix, format, label), {
    passBytes: nObs * nVars * bytes,
    entryBytes: 4,
    defaultEntries: nObs,
    residentBytes: columnIndexResidentBytes({ layout: 'dense', nObs, nVars }),
  });
  return fromIndex(options => new RowMajorColumnIndex({
    ...options,
    label: `Dense ${label}`,
    layout: 'dense',
    nRows: nObs,
    nCols: nVars,
    slabEntries: Math.max(nVars, Math.floor(SLAB_BYTES / bytes)),
    readRows: async (rowStart, rowEnd, { signal = null } = {}) => {
      const block = await matrix.read([[rowStart, rowEnd], [0, nVars]], { ...indexReadOptions, signal });
      if (!ArrayBuffer.isView(block) || block.length !== (rowEnd - rowStart) * nVars) {
        throw new Error(`Dense ${label} row slab does not match its selection`);
      }
      if (block instanceof Float32Array) return block;
      const values = allocateTypedArray(Float32Array, block.length, `Dense ${label}`);
      writeFloat32(block, values, 0);
      return values;
    },
  }));
}

/**
 * @typedef {Object} SparseRow
 * @property {Int32Array} genes - Gene positions of the row's stored entries, ascending
 * @property {Float32Array} values - Their values (duplicates summed)
 */

/**
 * One row's entries as a sparse row: positions sorted, duplicates summed (in
 * stored order), every stored entry kept. Costs the row's entries, never the
 * gene count.
 */
function sparseRowFrom(genes, values, nVars, label) {
  const count = genes.length;
  let sorted = true;
  for (let entry = 0; entry < count; entry++) {
    const gene = genes[entry];
    if (!(gene >= 0 && gene < nVars) || !Number.isInteger(gene)) {
      throw new AnnDataFormatError(`${label} gene index ${gene} is outside its ${nVars}-gene shape`);
    }
    if (entry > 0 && gene < genes[entry - 1]) sorted = false;
  }
  const order = allocateTypedArray(Uint32Array, count, 'Cell row order');
  for (let i = 0; i < count; i++) order[i] = i;
  if (!sorted) order.sort((a, b) => genes[a] - genes[b] || a - b);
  const outGenes = allocateTypedArray(Int32Array, count, 'Cell row genes');
  const outValues = allocateTypedArray(Float32Array, count, 'Cell row values');
  let kept = 0;
  for (let k = 0; k < count; k++) {
    const entry = order[k];
    const gene = genes[entry];
    if (kept > 0 && outGenes[kept - 1] === gene) {
      outValues[kept - 1] = addSparseFloat32(outValues[kept - 1], values[entry]);
    } else {
      outGenes[kept] = gene;
      outValues[kept] = addSparseFloat32(0, values[entry]);
      kept++;
    }
  }
  return kept === count
    ? { genes: outGenes, values: outValues }
    : { genes: outGenes.slice(0, kept), values: outValues.slice(0, kept) };
}

function sparseRowFromDense(dense) {
  let count = 0;
  for (let gene = 0; gene < dense.length; gene++) if (dense[gene] !== 0) count++;
  const genes = allocateTypedArray(Int32Array, count, 'Cell row genes');
  const values = allocateTypedArray(Float32Array, count, 'Cell row values');
  let at = 0;
  for (let gene = 0; gene < dense.length; gene++) {
    if (dense[gene] !== 0) {
      genes[at] = gene;
      values[at] = dense[gene];
      at++;
    }
  }
  return { genes, values };
}

/**
 * @typedef {Object} CellSubset
 * @property {Float64Array} pointers - Gene `g` holds entries `pointers[g]` to `pointers[g + 1]`
 * @property {Int32Array} cellIndex - Each entry's position in the cells asked for, ascending within a gene
 * @property {Float32Array} values - Each entry's value; a cell a gene does not list is zero
 */

/**
 * Entries of a cell subset gathered in any gene order: each a gene slot, a
 * cell position and a value at stored precision. `finish` sorts them
 * gene-major (cells ascending), sums duplicate coordinates in the order they
 * were added, leaves zeros out, and rounds to float32.
 */
class SubsetEntries {
  constructor(wide) {
    this._wide = wide;
    this._slots = new Int32Array(1024);
    this._positions = new Int32Array(1024);
    this._values = wide ? new Float64Array(1024) : new Float32Array(1024);
    this.count = 0;
  }

  add(slot, position, value) {
    if (this.count === this._slots.length) {
      const grow = (array, Type) => {
        const next = allocateTypedArray(Type, array.length * 2, 'Cell subset entries');
        next.set(array);
        return next;
      };
      this._slots = grow(this._slots, Int32Array);
      this._positions = grow(this._positions, Int32Array);
      this._values = grow(this._values, this._wide ? Float64Array : Float32Array);
    }
    this._slots[this.count] = slot;
    this._positions[this.count] = position;
    this._values[this.count] = value;
    this.count++;
  }

  /** @returns {CellSubset} */
  finish(nGenes, cellsAscending, label) {
    const total = this.count;
    const counts = allocateTypedArray(Float64Array, nGenes + 1, `${label} cell subset`);
    for (let i = 0; i < total; i++) counts[this._slots[i] + 1]++;
    for (let g = 0; g < nGenes; g++) counts[g + 1] += counts[g];
    const cursor = counts.slice(0, nGenes);
    const positions = allocateTypedArray(Int32Array, total, `${label} cell subset`);
    const raw = this._wide ? allocateTypedArray(Float64Array, total, `${label} cell subset`) : allocateTypedArray(Float32Array, total, `${label} cell subset`);
    for (let i = 0; i < total; i++) {
      const at = cursor[this._slots[i]]++;
      positions[at] = this._positions[i];
      raw[at] = this._values[i];
    }
    this._slots = this._positions = this._values = null;
    if (!cellsAscending) {
      // Entries were gathered in cell order, not position order: each gene's
      // run is put in position order (stable, so duplicates keep their order).
      for (let g = 0; g < nGenes; g++) {
        const from = counts[g];
        const to = counts[g + 1];
        if (to - from < 2) continue;
        const order = allocateTypedArray(Uint32Array, to - from, `${label} cell subset`);
        for (let i = 0; i < order.length; i++) order[i] = from + i;
        order.sort((a, b) => positions[a] - positions[b] || a - b);
        const runPositions = allocateTypedArray(Int32Array, order.length, `${label} cell subset`);
        const runValues = allocateTypedArray(Float64Array, order.length, `${label} cell subset`);
        for (let i = 0; i < order.length; i++) {
          runPositions[i] = positions[order[i]];
          runValues[i] = raw[order[i]];
        }
        positions.set(runPositions, from);
        raw.set(runValues, from);
      }
    }
    const pointers = allocateTypedArray(Float64Array, nGenes + 1, `${label} cell subset`);
    const values = allocateTypedArray(Float32Array, total, `${label} cell subset`);
    let kept = 0;
    for (let g = 0; g < nGenes; g++) {
      let entry = counts[g];
      const end = counts[g + 1];
      while (entry < end) {
        const position = positions[entry];
        let sum = addSparseFloat32(0, raw[entry]);
        entry++;
        while (entry < end && positions[entry] === position) {
          sum = addSparseFloat32(sum, raw[entry]);
          entry++;
        }
        if (sum !== 0) {
          positions[kept] = position;
          values[kept] = sum;
          kept++;
        }
      }
      pointers[g + 1] = kept;
    }
    return kept === total
      ? { pointers, cellIndex: positions, values }
      : { pointers, cellIndex: positions.slice(0, kept), values: values.slice(0, kept) };
  }
}

/**
 * Read `reads` (each `{start, end, ...}`, in order, by `request(read)`) with at most
 * `inFlightEntries` entries requested and not yet handled, handing each to
 * `handle(read, data)` in order. A read counts as no fewer entries than a
 * request is worth (`requestEntries`, `requestPriceOf`): every request in
 * flight holds the reader's work for it (its promises, its plan, its pieces)
 * whatever its bytes, so reads of a few entries each (a scattered cell's
 * row) are not all put in flight at once: a million of them held the
 * reader's heap past its limit (a two-group subset of a 10M-cell file).
 */
export async function pipelined(reads, inFlightEntries, request, handle, requestEntries = 0) {
  const pending = [];
  let next = 0;
  let inFlight = 0;
  const entries = read => read.end - read.start;
  const cost = read => Math.max(entries(read), requestEntries);
  const issue = () => {
    while (next < reads.length && (pending.length === 0 || inFlight + cost(reads[next]) <= inFlightEntries)) {
      const read = reads[next++];
      const data = request(read);
      inFlight += cost(read);
      // Arrived, a read holds its entries only: the rest of its request's
      // worth is free for the next reads at once, though it waits its turn
      // to be handed out (reads are handed out in order). A slow read at the
      // head never holds the link below its concurrency while the reads
      // after it have arrived.
      data.then(() => {
        inFlight -= cost(read) - entries(read);
        issue();
      }, () => {});
      pending.push({ read, data });
    }
  };
  issue();
  while (pending.length > 0) {
    const { read, data } = pending.shift();
    const value = await data;
    inFlight -= entries(read);
    issue();
    handle(read, value);
  }
}

/**
 * What a request to a store is worth, in entries of `entryBytes` bytes, by
 * the store's link as measured now (`formats/io/link.js`; `link` is the
 * index options' snapshot getter): `gap`, its merge gap (two ranges nearer
 * than this read as one: the gap transfers sooner than another request's
 * share of a round trip), and `request`, a round trip's worth (the price of
 * a request; until the link is measured, its merge gap at every request it
 * runs at once). Both 0 for a store with no link (in memory).
 *
 * @param {(() => Object|null)|null|undefined} link
 * @param {number} entryBytes
 * @returns {{gap: number, request: number}}
 */
function requestPriceOf(link, entryBytes) {
  const snapshot = link?.() ?? null;
  if (snapshot === null) return { gap: 0, request: 0 };
  const gapBytes = snapshot.mergeGapBytes ?? 0;
  // Never less than the merge gap: a local file's round trip may measure
  // within its clock's resolution while its gap keeps its prior's floor.
  const requestBytes = Math.max(gapBytes, roundTripBytesOf(snapshot));
  return { gap: Math.floor(gapBytes / entryBytes), request: Math.ceil(requestBytes / entryBytes) };
}

/**
 * Runs of cell rows read as one entry range each, in cell order (`order`
 * ascends the cells): a row joins the run before it when the entries between
 * them are no more than `gap` and the run stays within `maxEntries`; rows of
 * no entries are left out (`skipEmpty`) or ride along.
 */
function rowRuns(cells, order, pointers, gap, maxEntries, skipEmpty) {
  const runs = [];
  let run = null;
  for (let k = 0; k < order.length; k++) {
    const cell = cells[order[k]];
    const start = pointers[cell];
    const end = pointers[cell + 1];
    if (skipEmpty && end === start) continue;
    if (run !== null && start - run.end <= gap && Math.max(run.end, end) - run.start <= maxEntries) {
      run.end = Math.max(run.end, end);
      run.to = k + 1;
    } else {
      run = { start, end, from: k, to: k + 1 };
      runs.push(run);
    }
  }
  return runs;
}

/**
 * The cells of a subset as the kernels of `subset-entries.js` look them up:
 * their rows ascending (`rows`) and each one's subset position
 * (`positions`), 8 bytes a cell, never a lookup of every row of the matrix
 * (a subset of a 100M-cell file then held 400 MB, on the reader thread and
 * again on every decode worker it was sent to). A row given twice keeps its
 * last position.
 *
 * @param {ArrayLike<number>} cells - Rows of the subset's cells, in subset order
 * @returns {{rows: Uint32Array, positions: Int32Array}}
 */
function subsetCells(cells) {
  const n = cells.length;
  // The cells sorted by row, stably (a row given twice keeps its order), in
  // two passes of a radix sort on 16 bits each: linear in the cells, where a
  // comparison sort of a million cells took a quarter of a second.
  let keys = allocateTypedArray(Uint32Array, n, 'Cell subset');
  let order = allocateTypedArray(Uint32Array, n, 'Cell subset');
  for (let i = 0; i < n; i++) {
    keys[i] = cells[i];
    order[i] = i;
  }
  let nextKeys = allocateTypedArray(Uint32Array, n, 'Cell subset');
  let nextOrder = allocateTypedArray(Uint32Array, n, 'Cell subset');
  const counts = new Uint32Array(RADIX + 1);
  for (const shift of [0, 16]) {
    counts.fill(0);
    for (let i = 0; i < n; i++) counts[((keys[i] >>> shift) & (RADIX - 1)) + 1]++;
    for (let b = 1; b < counts.length; b++) counts[b] += counts[b - 1];
    for (let i = 0; i < n; i++) {
      const at = counts[(keys[i] >>> shift) & (RADIX - 1)]++;
      nextKeys[at] = keys[i];
      nextOrder[at] = order[i];
    }
    [keys, nextKeys] = [nextKeys, keys];
    [order, nextOrder] = [nextOrder, order];
  }
  let distinct = 0;
  for (let i = 0; i < n; i++) if (i + 1 === n || keys[i + 1] !== keys[i]) distinct++;
  const rows = allocateTypedArray(Uint32Array, distinct, 'Cell subset');
  const positions = allocateTypedArray(Int32Array, distinct, 'Cell subset');
  let at = 0;
  for (let i = 0; i < n; i++) {
    if (i + 1 < n && keys[i + 1] === keys[i]) continue;
    rows[at] = keys[i];
    positions[at++] = order[i];
  }
  return { rows, positions };
}

/** Buckets of one pass of `subsetCells`' radix sort (16 bits of a row). */
const RADIX = 1 << 16;

/**
 * A cell subset read by gene: each gene's non-zero entries, kept where they
 * fall in the cells, in one pass over them (`keepSubsetEntries`).
 *
 * The genes of a CSC matrix (`columns.readEntries`) are read in runs: genes
 * stored one after another are one range of the indices and one of the
 * values, read with one call each, several runs in flight while the entries
 * already read are kept (every gene of Suo, 51.8 million entries: 26 reads
 * of each array instead of 8,192). A run's entries are kept on a decode
 * worker (`keepSubsetRun`, `runOnDecodeWorker`): its arrays are transferred
 * there, and the reader thread goes on reading and decoding the next runs
 * while the workers keep them (every gene of the rebuilt Suo in its two
 * largest cell types, a local file in Chromium: 305-326 ms, about 150 of them
 * keeping entries on the reader thread, before; 206-215 ms after, against
 * 150 ms for reading the whole of `X`). A gene is the entries the access
 * says a read of it takes (`entryCount`): a priority-ordered file opened as
 * a prefix reads each gene's counted entries alone, checked
 * (`requireEntries`), and its genes are then runs of their own. Other
 * columns (a gene index) are read gene by gene, in groups of about
 * `inFlightEntries` entries.
 *
 * @param {MatrixColumns} columns
 * @param {ReadonlyArray<number>} cells
 * @param {ReadonlyArray<number>} genes
 * @param {{nObs: number, label: string, inFlightEntries: number, readOptions: Object, link?: (() => Object|null)|null}} context
 * @returns {Promise<CellSubset>}
 */
async function subsetByColumns(columns, cells, genes, { nObs, label, inFlightEntries, readOptions, link = null }) {
  // The cells' rows ascending with their positions: what the subset holds, not a lookup of every row.
  const subset = subsetCells(cells);
  const { ascending } = ascendingOrder(cells);
  // Each gene's kept entries: a slice of one part (`partOf[g]`, from
  // `startOf[g]`, `countOf[g]` entries).
  const parts = [];
  const partOf = allocateTypedArray(Int32Array, genes.length, `${label} cell subset`);
  const startOf = allocateTypedArray(Float64Array, genes.length, `${label} cell subset`);
  const countOf = allocateTypedArray(Float64Array, genes.length, `${label} cell subset`);
  let scratchPositions = new Int32Array(0);
  let scratchValues = new Float32Array(0);
  const scratch = entries => {
    if (scratchPositions.length < entries) {
      scratchPositions = allocateTypedArray(Int32Array, entries, `${label} cell subset`);
      scratchValues = allocateTypedArray(Float32Array, entries, `${label} cell subset`);
    }
  };
  /** Keep gene `g`'s entries `from..to` of `rows`/`values` at `at`; returns the new end. */
  const keepGene = (g, rows, values, from, to, at, checked, integral) => {
    let end = integral ? keepSubsetEntries(rows, values, from, to, subset, nObs, scratchPositions, scratchValues, at) : -1;
    if (end < 0) {
      // Duplicates summed, an unsorted gene sorted, every row checked.
      const entries = checked(rows, values, from, to);
      const column = sparseColumnOf(entries.rows, entries.values, entries.count, nObs);
      end = keepSubsetEntries(column.indices, column.values, 0, column.indices.length, subset, nObs, scratchPositions, scratchValues, at);
    }
    if (!ascending) sortSubsetEntries(scratchPositions, scratchValues, at, end);
    startOf[g] = at;
    countOf[g] = end - at;
    partOf[g] = parts.length;
    return end;
  };
  const closePart = kept => {
    parts.push({ positions: scratchPositions.slice(0, kept), values: scratchValues.slice(0, kept) });
  };

  if (columns.readEntries !== undefined) {
    // Runs of genes in stored order: genes stored one after another, or
    // nearer than the link transfers sooner than another request
    // (`requestPriceOf`), read as one range; every read priced in flight at
    // no less than a request.
    const order = ascendingOrder(genes).order;
    const runEntries = Math.max(1, Math.floor(inFlightEntries / 4));
    const { gap, request } = requestPriceOf(link, columns.entryBytes ?? 1);
    const runs = [];
    let run = null;
    for (let k = 0; k < order.length; k++) {
      const gene = genes[order[k]];
      const start = columns.entryStart(gene);
      const end = start + columns.entryCount(gene);
      if (run !== null && start >= run.end && start - run.end <= gap && end - run.start <= runEntries) {
        run.end = end;
        run.to = k + 1;
      } else {
        run = { start, end, from: k, to: k + 1 };
        runs.push(run);
      }
    }
    const checked = start => (rows, values, from, to) => columns.checkedEntries(rows, values, from, to, start);
    // The subset's cells go to each decode worker once, for every run.
    const context = `cell-subset-${nextSubsetContext++}`;
    retainDecodeContext(context, subset);
    const kept = [];
    let failure = null;
    try {
      await pipelined(runs, inFlightEntries, read => (read.end === read.start
        ? Promise.resolve([new Int32Array(0), new Float32Array(0)])
        : columns.readEntries(read.start, read.end, readOptions)), (read, [rows, values]) => {
        if (failure !== null) throw failure;
        if (columns.requireEntries !== undefined) {
          for (let k = read.from; k < read.to; k++) {
            const gene = genes[order[k]];
            const from = columns.entryStart(gene) - read.start;
            columns.requireEntries(gene, rows, from, from + columns.entryCount(gene));
          }
        }
        const check = checked(read.start);
        if (!(columns.integerRows || isIntegralArray(rows))) {
          // Rows that may not be integers: every gene through its checks.
          scratch(read.end - read.start);
          let at = 0;
          for (let k = read.from; k < read.to; k++) {
            const g = order[k];
            const from = columns.entryStart(genes[g]) - read.start;
            at = keepGene(g, rows, values, from, from + columns.entryCount(genes[g]), at, check, false);
          }
          closePart(at);
          return;
        }
        const ranges = allocateTypedArray(Float64Array, 2 * (read.to - read.from), `${label} cell subset`);
        for (let k = read.from; k < read.to; k++) {
          const from = columns.entryStart(genes[order[k]]) - read.start;
          ranges[2 * (k - read.from)] = from;
          ranges[2 * (k - read.from) + 1] = from + columns.entryCount(genes[order[k]]);
        }
        const args = { rows, values, ranges, nObs, ascending };
        const owned = [rows, values].every(canTransfer);
        const task = runOnDecodeWorker({
          module: SUBSET_ENTRIES_MODULE,
          name: 'keepSubsetRun',
          args,
          transfer: owned && rows.buffer !== values.buffer ? [rows.buffer, values.buffer] : [],
          context,
          size: rows.byteLength + values.byteLength,
          signal: readOptions.signal ?? null,
          inThread: () => keepSubsetRun(args, subset),
        }).then(result => {
          const part = parts.length;
          parts.push({ positions: result.positions, values: result.values });
          let at = 0;
          for (let k = read.from; k < read.to; k++) {
            const g = order[k];
            partOf[g] = part;
            startOf[g] = at;
            countOf[g] = result.counts[k - read.from];
            at += countOf[g];
          }
          // A gene whose rows do not ascend strictly: through its checks here
          // (its entries numbered from the gene's first, for errors).
          for (const refused of result.refused) {
            const g = order[read.from + refused.gene];
            scratch(refused.rows.length);
            closePart(keepGene(g, refused.rows, refused.values, 0, refused.rows.length, 0,
              checked(read.start + ranges[2 * refused.gene]), false));
          }
        });
        task.catch(error => { failure ??= error; });
        kept.push(task);
      }, request);
      await Promise.all(kept);
    } finally {
      releaseDecodeContext(context);
    }
  } else {
    const checked = (rows, values, from, to) => ({ rows: rows.subarray(from, to), values: values.subarray(from, to), count: to - from });
    for (let first = 0; first < genes.length;) {
      let last = first;
      let entries = 0;
      while (last < genes.length && (last === first || entries + columns.entryCount(genes[last]) <= inFlightEntries)) {
        entries += columns.entryCount(genes[last]);
        last++;
      }
      const samples = await Promise.all(genes.slice(first, last).map(gene => columns.sparseColumn(gene, readOptions)));
      scratch(samples.reduce((sum, sample) => sum + sample.indices.length, 0));
      let at = 0;
      samples.forEach((sample, k) => {
        at = keepGene(first + k, sample.indices, sample.values, 0, sample.indices.length, at, checked, isIntegralArray(sample.indices));
      });
      closePart(at);
      first = last;
    }
  }

  const pointers = allocateTypedArray(Float64Array, genes.length + 1, `${label} cell subset`);
  for (let g = 0; g < genes.length; g++) pointers[g + 1] = pointers[g] + countOf[g];
  const total = pointers[genes.length];
  const cellIndex = allocateTypedArray(Int32Array, total, `${label} cell subset`);
  const values = allocateTypedArray(Float32Array, total, `${label} cell subset`);
  for (let g = 0; g < genes.length; g++) {
    if (countOf[g] === 0) continue;
    const part = parts[partOf[g]];
    const from = startOf[g];
    const to = from + countOf[g];
    cellIndex.set(part.positions.subarray(from, to), pointers[g]);
    values.set(part.values.subarray(from, to), pointers[g]);
  }
  return { pointers, cellIndex, values };
}

/**
 * @typedef {Object} MatrixRows
 * @property {(cell: number, options?: Object) => Promise<SparseRow>} row
 * @property {(cells: ReadonlyArray<number>) => number} [readCost] - Bytes reading these rows decodes
 * @property {(cells: ReadonlyArray<number>, genes: ReadonlyArray<number>, options: Object) => Promise<CellSubset>} [subset]
 */

/**
 * Open row access to one cell-major matrix (CSR or dense: one cell's genes,
 * many cells' rows, and a cell subset read by cell). A gene-major (CSC)
 * matrix has none: its rows are read by gene (`AnnDataReader.readMatrixRows`).
 *
 * @param {Object} matrix
 * @param {Object} context - As `openMatrixColumns`, plus `inFlightEntries`
 *   (entries a subset keeps requested at once)
 * @returns {Promise<MatrixRows>}
 */
export async function openMatrixRows(matrix, { format, label, nObs, nVars, indexOptions, readOptions = {}, inFlightEntries = SLAB_BYTES }) {
  const weight = sourceWeight(indexOptions);
  if (isGroup(matrix)) {
    const sparse = sparseContract(matrix, format, `Sparse ${label}`);
    if (sparse.shape[0] !== nObs || sparse.shape[1] !== nVars) {
      throw new AnnDataFormatError(
        `Sparse ${label} shape ${sparse.shape[0]}×${sparse.shape[1]} does not match ${formatCountOf(nObs, 'cell')} and ${formatCountOf(nVars, 'gene')}`
      );
    }
    const dataLabel = `Sparse ${label} data`;
    const indexLabel = `Sparse ${label} index`;
    const pointerLabel = `Sparse ${label} indptr`;
    if (sparse.format === 'csr') {
      const raw = await readIntegers(sparse.indptrArray, 0, nObs + 1, pointerLabel, readOptions);
      const pointers = raw instanceof Float64Array ? raw : copyTypedArray(Float64Array, raw, pointerLabel);
      checkPointers(pointers, sparse.dataLength, `Sparse ${label}`);
      // Rows this close in the file are read as one range: a chunk is decoded
      // whole, so the gap between them costs nothing more, and a gap the
      // link transfers sooner than another request costs less than one (an
      // array read in part: uncompressed HDF5, a contiguous dataset). Every
      // read is priced at no less than a request (`requestPriceOf`), in
      // flight and in `readCost`, as the link measures it at the read.
      const chunkGap = Math.max(chunkElements(sparse.indicesArray) ?? 0, chunkElements(sparse.dataArray) ?? 0);
      const entryBytes = elementBytes(sparse.indicesArray) + elementBytes(sparse.dataArray);
      const pricing = () => {
        const price = requestPriceOf(indexOptions?.link, entryBytes);
        return { gap: Math.max(chunkGap, price.gap), request: price.request };
      };
      const wide = widerThanFloat32(sparse.dataArray);
      return {
        async row(cell, options = {}) {
          const start = pointers[cell];
          const end = pointers[cell + 1];
          if (end === start) return { genes: new Int32Array(0), values: new Float32Array(0) };
          const [genes, values] = await Promise.all([
            readIntegers(sparse.indicesArray, start, end, indexLabel, options),
            readNumbers(sparse.dataArray, start, end, dataLabel, options),
          ]);
          return sparseRowFrom(genes, values, nVars, `Sparse ${label}`);
        },
        /** The stored entries of one row: what a read of it decodes and hands out. */
        entries(cell) {
          return pointers[cell + 1] - pointers[cell];
        },
        /** Decoded bytes of one entry: its gene index and its value. */
        entryBytes,
        /** Many rows at once: nearby rows read as one range, each read once. */
        async rows(cells, options = {}) {
          const { order } = ascendingOrder(cells);
          const { gap, request } = pricing();
          const runs = rowRuns(cells, order, pointers, gap, inFlightEntries, false);
          const result = new Array(cells.length);
          await pipelined(runs, inFlightEntries, read => (read.end === read.start
            ? Promise.resolve([new Int32Array(0), new Float32Array(0)])
            : Promise.all([
              readIntegers(sparse.indicesArray, read.start, read.end, indexLabel, options),
              readNumbers(sparse.dataArray, read.start, read.end, dataLabel, options),
            ])), (read, [genes, values]) => {
            for (let k = read.from; k < read.to; k++) {
              const cell = cells[order[k]];
              const from = pointers[cell] - read.start;
              const to = pointers[cell + 1] - read.start;
              result[order[k]] = sparseRowFrom(genes.subarray(from, to), values.subarray(from, to), nVars, `Sparse ${label}`);
            }
          }, request);
          return result;
        },
        /**
         * What `subset` decodes or copies for these cells: the chunks its runs
         * touch (the runs' whole ranges, gaps included, where an array is read
         * in part), and a request's worth for every run.
         */
        readCost(cells) {
          const { order } = ascendingOrder(cells);
          const { gap, request } = pricing();
          const runs = rowRuns(cells, order, pointers, gap, inFlightEntries, true);
          const starts = allocateTypedArray(Float64Array, runs.length, 'Entry range starts');
          const ends = allocateTypedArray(Float64Array, runs.length, 'Entry range ends');
          runs.forEach((run, i) => {
            starts[i] = run.start;
            ends[i] = run.end;
          });
          return (touchedChunkBytes(sparse.indicesArray, starts, ends, runs.length) +
            touchedChunkBytes(sparse.dataArray, starts, ends, runs.length) +
            runs.length * request * entryBytes) * weight();
        },
        async subset(cells, genes, options = {}) {
          const slot = allocateTypedArray(Int32Array, nVars, `${label} cell subset`).fill(-1);
          genes.forEach((gene, g) => { slot[gene] = g; });
          const { order, ascending } = ascendingOrder(cells);
          // Runs of cells, in cell order, each read as one entry range.
          const { gap, request } = pricing();
          const runs = rowRuns(cells, order, pointers, gap, inFlightEntries, true);
          const entries = new SubsetEntries(wide);
          await pipelined(runs, inFlightEntries, read => Promise.all([
            readIntegers(sparse.indicesArray, read.start, read.end, indexLabel, options),
            readNumbers(sparse.dataArray, read.start, read.end, dataLabel, options),
          ]), (read, [geneIndex, values]) => {
            for (let k = read.from; k < read.to; k++) {
              const position = order[k];
              const cell = cells[position];
              const to = pointers[cell + 1] - read.start;
              for (let entry = pointers[cell] - read.start; entry < to; entry++) {
                const gene = geneIndex[entry];
                if (!(gene >= 0 && gene < nVars) || !Number.isInteger(gene)) {
                  throw new AnnDataFormatError(`Sparse ${label} gene index ${gene} is outside its ${nVars}-gene shape`);
                }
                const g = slot[gene];
                if (g >= 0) entries.add(g, position, values[entry]);
              }
            }
          }, request);
          return entries.finish(genes.length, ascending, label);
        },
      };
    }
    // A gene-major matrix lists a row's entries in every gene: its rows are
    // read as a cell subset of every gene (`AnnDataReader.readMatrixRows`),
    // never through an index of every stored row built here.
    throw new Error(`Sparse ${label} is stored by gene (CSC): its rows are read by gene, not by row`);
  }
  validateArrayEncoding(matrix, format, `Dense ${label}`, 'array');
  const shape = shapeOf(matrix, `Dense ${label}`, 2);
  if (shape[0] !== nObs || shape[1] !== nVars) {
    throw new AnnDataFormatError(`Dense ${label} shape ${shape[0]}×${shape[1]} does not match ${formatCountOf(nObs, 'cell')} and ${formatCountOf(nVars, 'gene')}`);
  }
  // A boolean matrix (a mask, a detection call) reads as 0 and 1.
  if (!isAnnDataMatrixDataKind(valueKind(matrix))) {
    throw new AnnDataFormatError(`Dense ${label} must use a numeric or boolean dtype`);
  }
  const bytes = elementBytes(matrix);
  const chunks = Array.isArray(matrix.chunks) ? matrix.chunks : null;
  // A row strip spans every gene; its rows are decoded together.
  const stripRows = chunks === null ? 1 : chunks[0];
  const rowWidth = chunks === null ? nVars : Math.ceil(nVars / chunks[1]) * chunks[1];
  const wide = widerThanFloat32(matrix);
  /**
   * Runs of nearby rows, each read as one row range of every gene: rows of
   * one strip, or rows the link transfers sooner than another request
   * (`requestPriceOf`), within what a read keeps in flight; each read is
   * priced in flight at no less than a request (`price.request`).
   */
  const denseRuns = (cells, order) => {
    const rowsPerRead = Math.max(1, Math.floor(inFlightEntries / Math.max(1, nVars)));
    const price = requestPriceOf(indexOptions?.link, bytes);
    const gapRows = Math.max(stripRows, Math.floor(price.gap / Math.max(1, nVars)) + 1);
    const runs = [];
    let run = null;
    for (let k = 0; k < order.length; k++) {
      const cell = cells[order[k]];
      if (run !== null && cell - run.end < gapRows && cell + 1 - run.start <= rowsPerRead) {
        run.end = cell + 1;
        run.to = k + 1;
      } else {
        run = { start: cell, end: cell + 1, from: k, to: k + 1 };
        runs.push(run);
      }
    }
    return { runs, price };
  };
  /** Row `row` of a block of rows read together, as a dense float32 row. */
  const denseRow = (block, row) => {
    const values = block.subarray(row * nVars, (row + 1) * nVars);
    if (values instanceof Float32Array) return values;
    const dense = allocateTypedArray(Float32Array, nVars, `Dense ${label}`);
    writeFloat32(values, dense, 0);
    return dense;
  };
  return {
    async row(cell, options = {}) {
      const values = await matrix.read([[cell, cell + 1], [0, nVars]], options);
      if (!values || values.length !== nVars) {
        throw new Error(`Dense ${label} row payload length does not match the gene count`);
      }
      return sparseRowFromDense(denseRow(values, 0));
    },
    /** What a read of one row decodes: every gene of it. */
    entries() {
      return nVars;
    },
    /** Decoded bytes of one entry (a gene's value). */
    entryBytes: bytes,
    /**
     * Many rows at once, as `subset` reads them: nearby rows as one row
     * range of every gene (`denseRuns`), each strip decoded once, never a
     * read and a strip's decoding a row.
     */
    async rows(cells, options = {}) {
      const { order } = ascendingOrder(cells);
      const { runs, price } = denseRuns(cells, order);
      const result = new Array(cells.length);
      await pipelined(
        runs.map(read => ({ ...read, start: read.start * nVars, end: read.end * nVars, rowStart: read.start, rowEnd: read.end })),
        inFlightEntries,
        read => matrix.read([[read.rowStart, read.rowEnd], [0, nVars]], options),
        (read, block) => {
          if (!block || block.length !== (read.rowEnd - read.rowStart) * nVars) {
            throw new Error(`Dense ${label} row payload length does not match the gene count`);
          }
          for (let k = read.from; k < read.to; k++) {
            result[order[k]] = sparseRowFromDense(denseRow(block, cells[order[k]] - read.rowStart));
          }
        },
        price.request
      );
      return result;
    },
    /** The strips these cells' rows touch, and a request's worth a read (`subset`'s runs). */
    readCost(cells) {
      const strips = new Set(Array.from(cells, cell => Math.floor(cell / stripRows)));
      const { order } = ascendingOrder(cells);
      const { runs, price } = denseRuns(cells, order);
      return (strips.size * stripRows * rowWidth * bytes + runs.length * price.request * bytes) * weight();
    },
    async subset(cells, genes, options = {}) {
      const { order, ascending } = ascendingOrder(cells);
      const { runs, price } = denseRuns(cells, order);
      const entries = new SubsetEntries(wide);
      await pipelined(
        runs.map(read => ({ ...read, start: read.start * nVars, end: read.end * nVars, rowStart: read.start, rowEnd: read.end })),
        inFlightEntries,
        read => matrix.read([[read.rowStart, read.rowEnd], [0, nVars]], options),
        (read, block) => {
          if (!block || block.length !== (read.rowEnd - read.rowStart) * nVars) {
            throw new Error(`Dense ${label} row payload length does not match the gene count`);
          }
          for (let k = read.from; k < read.to; k++) {
            const position = order[k];
            const base = (cells[position] - read.rowStart) * nVars;
            genes.forEach((gene, g) => {
              const value = typeof block[base + gene] === 'bigint' ? Number(block[base + gene]) : block[base + gene];
              if (value !== 0) entries.add(g, position, value);
            });
          }
        },
        price.request
      );
      return entries.finish(genes.length, ascending, label);
    },
  };
}

/**
 * What one read of some genes in some cells costs by each route, within a
 * run of `batches` such reads of the same cells (a DE over every gene reads
 * them in batches): `rows`, the cells' rows, decoded again by every read
 * (every gene of a row is decoded whatever genes are asked); `columns`, the
 * genes' entries, plus this read's share of what is left of building the
 * gene index (`passCost`), which the run pays once, not once a read. A run
 * of one read pays the whole build.
 *
 * @param {MatrixColumns} columns
 * @param {MatrixRows|null} rows
 * @param {ReadonlyArray<number>} cells
 * @param {ReadonlyArray<number>} genes
 * @param {number} [batches=1] - Reads the run makes of these cells, this one included
 * @param {number|null} [rowsCost] - `rows.readCost(cells)`, when the caller priced it for the run
 * @returns {{rows: number, columns: number}}
 */
export function cellSubsetRunCosts(columns, rows, cells, genes, batches = 1, rowsCost = null) {
  const byRows = rows?.subset === undefined ? Infinity : rowsCost ?? rows.readCost(cells);
  const pass = columns.passCost?.() ?? 0;
  const byColumns = columns.readCost(genes) - pass + pass / Math.max(1, batches);
  return { rows: byRows, columns: byColumns };
}

/**
 * Some genes in some cells, read by whichever costs less: the cells' rows
 * (`rows.subset`, a CSR or dense matrix) or the genes' columns, the gene
 * index's build priced once over the run's reads (`cellSubsetRunCosts`):
 * a run of many reads waits for the index once and is served from it, never
 * decoding the cells' rows again a read. Both give the same block.
 *
 * @param {MatrixColumns} columns
 * @param {MatrixRows|null} rows - Null when the layout has no direct row read (CSC)
 * @param {ReadonlyArray<number>} cells - Distinct cell positions
 * @param {ReadonlyArray<number>} genes - Distinct gene positions
 * @param {{nObs: number, label: string, inFlightEntries: number, readOptions: Object, link?: (() => Object|null)|null, batches?: number, costs?: {rows: number, columns: number}}} context -
 *   `link`: the store's link as measured now (`formats/io/link.js`), which
 *   prices a request (`requestPriceOf`); `batches`: the reads the run makes
 *   of these cells, this one included (1 by default); `costs`: the two
 *   routes' costs, when the caller priced them (`cellSubsetRunCosts`)
 * @returns {Promise<{route: 'rows'|'columns', block: CellSubset}>}
 */
export async function readCellSubset(columns, rows, cells, genes, context) {
  const { rows: byRows, columns: byColumns } = context.costs ?? cellSubsetRunCosts(columns, rows, cells, genes, context.batches ?? 1);
  if (byRows < byColumns) {
    return { route: 'rows', block: await rows.subset(cells, genes, context.readOptions) };
  }
  return { route: 'columns', block: await subsetByColumns(columns, cells, genes, context) };
}
