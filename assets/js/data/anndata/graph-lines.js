/**
 * A neighbour graph (`obsp`) read line by line: the one way every graph
 * reaches its edges (`connectivity-edges.js` `connectivityEdgesFromLines`)
 * and, gathered, the reader's matrix (`AnnDataReader.getConnectivities`).
 *
 * A line is a row of a CSR matrix or a column of a CSC one (a symmetric
 * matrix is its own transpose). The lines arrive in slabs of about
 * `SLAB_BYTES` of stored entries, the next slab's read issued before the
 * current one is handed out, so a 10M-cell graph (about 200-300M stored
 * entries, 2 GB) is never held whole: only one slab of it, beside the edges
 * being built. Row indices are converted to int32 and weights to numbers
 * through 64-bit integers' words (`values.js`), never a BigInt per entry.
 *
 * - `sparseGraphLines`: a `csr_matrix`/`csc_matrix` group as stored;
 * - `denseGraphLines`: a dense `n × n` array, by row slab (its non-zero
 *   entries counted in a first pass, so the edges are sized before any is
 *   built);
 * - `inducedGraphLines`: a subsample's induced subgraph (the open cells'
 *   rows, the entries between two open cells), read in the stored graph's
 *   row order by the cheaper of two reads (`GraphReadPlan`: the open rows
 *   alone, or the whole graph streamed), a slab at a time, each column its
 *   row's rank among the open rows, placed on the open cells by `relabel`:
 *   an opening grown to every cell of a 2.3M-cell atlas (102.9M entries) is
 *   never held whole beside its edges;
 * - `placedGraphLines`, `readPlacedGraphRows`: a MuData modality's graph
 *   placed on the store's cells, read in its own rows;
 * - `readInducedGraph`: a subsample's induced subgraph held (the reader's
 *   matrix of a subsample);
 * - `heldGraphLines`: a graph already in memory (a dense subsample's induced
 *   subgraph, a view that computed one), one slab.
 *
 * `readGraphRows` reads some lines only (the k-NN tool's frontier, by
 * row): their pointers and entries, through the chunks that hold them, or
 * the graph streamed when that reads no more (`stream`).
 *
 * @module data/anndata/graph-lines
 */

import { connectivityEdgeBytes, denseConnectivitySlab } from '../connectivity-edges.js';
import { allocateTypedArray } from '../sparse-column-index.js';
import { elementBytes, encodingType } from './elements.js';
import { checkPointers, sparseContract } from './sparse.js';
import { SLAB_BYTES, asNumbers, axisPositionWriter, readConvertedRange, readIntegers, readNumbers, readRowSlabs, readStored } from './values.js';
import { CellRows, KeptPositions, gatheredArray, keptEntries, readKeptRowPointers } from './views/cell-subset.js';
import { isArrayNode, isGroup } from '../../formats/store.js';
import { orderByKey } from '../../utils/radix-order.js';
import { yieldToMacrotask } from '../../utils/yield-macrotask.js';

/**
 * @typedef {import('../connectivity-edges.js').ConnectivityLines & {format: 'csr'|'csc'|'dense', shape: number[]}} GraphLines
 */

/** Whether weights of this dtype are float32 (held as float32), else held as float64. */
function float32Weights(array) {
  return array.dtype.kind === 'float' && array.dtype.bytes <= 4;
}

/** The first line after `start` whose entries would take a slab past `limit` entries (at least one line). */
function slabEnd(pointers, start, lines, limit) {
  const ceiling = pointers[start] + limit;
  let low = start + 1;
  let high = lines;
  while (low < high) {
    const middle = (low + high + 1) >>> 1;
    if (pointers[middle] <= ceiling) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * The lines of a sparse graph as stored: its pointers read whole (one per
 * line), then its entries a slab of lines at a time.
 *
 * @param {Object} group - A `csr_matrix` / `csc_matrix` group
 * @param {import('./elements.js').AnnDataFormat} format
 * @param {string} label
 * @param {Object} [readOptions] - `{signal, activity}` of every read
 * @returns {Promise<GraphLines>}
 */
export async function sparseGraphLines(group, format, label, readOptions = {}) {
  const contract = sparseContract(group, format, label);
  const { dataArray, dataLength, indicesArray, indptrArray, shape } = contract;
  const lines = contract.format === 'csr' ? shape[0] : shape[1];
  const pointers = checkPointers(await readIntegers(indptrArray, 0, lines + 1, `${label} indptr`, readOptions), dataLength, label);
  if (readOptions.activity && dataLength > 0) {
    // The whole read's stored size says up front how much is left.
    Promise.all([indicesArray, dataArray].map(array => array.storedBytes([[0, dataLength]], readOptions)))
      .then(([indices, data]) => readOptions.activity.expect(indices + data), () => {});
  }
  const limit = Math.max(1, Math.floor(SLAB_BYTES / (elementBytes(indicesArray) + elementBytes(dataArray))));
  const indexWriter = axisPositionWriter(contract.format === 'csr' ? shape[1] : shape[0]);
  const read = (start, end) => {
    const from = pointers[start];
    const to = pointers[end];
    const promise = Promise.all([
      readConvertedRange(indicesArray, from, to, Int32Array, `${label} index`, indexWriter, readOptions),
      readNumbers(dataArray, from, to, `${label} data`, readOptions),
    ]).then(([indices, data]) => {
      const local = allocateTypedArray(Float64Array, end - start + 1, `${label} indptr`);
      for (let line = start; line <= end; line++) local[line - start] = pointers[line] - from;
      return { start, end, pointers: local, indices, data };
    });
    promise.catch(() => {});
    return promise;
  };
  async function* slabs() {
    let next = lines > 0 ? read(0, slabEnd(pointers, 0, lines, limit)) : null;
    while (next !== null) {
      const current = await next;
      next = current.end < lines ? read(current.end, slabEnd(pointers, current.end, lines, limit)) : null;
      yield current;
    }
  }
  return { format: contract.format, shape, nnz: dataLength, float32: float32Weights(dataArray), pointers, slabs: slabs() };
}

/**
 * The lines of a dense `n × n` graph, by row slab: a first pass counts its
 * non-zero entries (the edges are sized by them), the second hands out each
 * slab's non-zero entries as lines. Every value is checked as the edges are
 * built.
 *
 * @param {Object} array - A dense array of `nCells × nCells`
 * @param {number} nCells
 * @param {Object} [readOptions]
 * @returns {Promise<GraphLines>}
 */
export async function denseGraphLines(array, nCells, readOptions = {}) {
  let nnz = 0;
  for await (const slab of readRowSlabs(array, 0, nCells, readOptions)) {
    const values = slab.values;
    for (let i = 0; i < values.length; i++) if (values[i] !== 0) nnz++;
  }
  async function* slabs() {
    for await (const slab of readRowSlabs(array, 0, nCells, readOptions)) {
      yield denseConnectivitySlab(slab.values, slab.rowStart, slab.rowEnd, nCells);
    }
  }
  return { format: 'dense', shape: [nCells, nCells], nnz, float32: float32Weights(array), slabs: slabs() };
}

/**
 * The open cells of an induced subgraph in the order its stored graph holds
 * their rows: `rows` (stored rows, ascending) and `lines` (the open
 * position of each; null when it is the row's own rank, the open cells
 * being in the stored order). A subsample opens its cells in priority order
 * (`subsample-plan.js`), so their rows are scattered through the graph;
 * read in that order, every slab of open cells spans the whole graph and
 * decodes its chunks again (a 2.5M-cell uniform share of a 5M-cell `.h5ad`:
 * 19.9 s for its edges against 2.0 s for every cell's). Read in the stored
 * order, each chunk is decoded once; the lines are their rows' ranks, in
 * order, placed on the open cells after the edges are built
 * (`ConnectivityLines` `relabel`).
 *
 * @param {ArrayLike<number>} rows - Stored rows, in open order, distinct
 * @returns {{rows: Uint32Array, lines: Uint32Array|null}}
 */
export function storedRowOrder(rows) {
  const kept = rows instanceof Uint32Array ? rows : Uint32Array.from(rows);
  let ascending = true;
  for (let i = 1; ascending && i < kept.length; i++) ascending = kept[i] > kept[i - 1];
  if (ascending) return { rows: kept, lines: null };
  const lines = orderByKey(kept);
  const sorted = allocateTypedArray(Uint32Array, kept.length, 'Open cells in stored order');
  for (let i = 0; i < lines.length; i++) sorted[i] = kept[lines[i]];
  return { rows: sorted, lines };
}

/**
 * The entries of stored rows `rows[first..last)` (pointers `pointers[row -
 * lo]`, entries at `pointers[row - lo] - from` of `indices`/`data`) whose
 * column is open (`positions`: a table of each column's open position, or a
 * function), renumbered into `outIndices`/`outData`, each row's end in
 * `slabPointers`: how many were kept; `UNMAPPED` at a column of `-2` (a row
 * no cell is mapped to); `-e - 2` at entry `e` outside `[0, bound)`.
 * A function of its own, its loops typed by their
 * arguments: inline in the slab's callback it walked 23 ns an entry.
 */
function keepOpen(rows, first, last, lo, from, pointers, indices, data, positions, bound, slabPointers, outIndices, outData) {
  let write = 0;
  if (positions instanceof Int32Array) {
    for (let i = first; i < last; i++) {
      const row = rows[i] - lo;
      const begin = pointers[row] - from;
      const end = pointers[row + 1] - from;
      for (let e = begin; e < end; e++) {
        const column = indices[e];
        if (!(column >= 0 && column < bound)) return -e - 2;
        const position = positions[column];
        if (position >= 0) {
          outIndices[write] = position;
          outData[write++] = data[e];
        } else if (position === -2) return UNMAPPED;
      }
      slabPointers[i - first + 1] = write;
    }
    return write;
  }
  for (let i = first; i < last; i++) {
    const row = rows[i] - lo;
    const begin = pointers[row] - from;
    const end = pointers[row + 1] - from;
    for (let e = begin; e < end; e++) {
      const column = indices[e];
      if (!(column >= 0 && column < bound)) return -e - 2;
      const position = positions(column);
      if (position >= 0) {
        outIndices[write] = position;
        outData[write++] = data[e];
      } else if (position === -2) return UNMAPPED;
    }
    slabPointers[i - first + 1] = write;
  }
  return write;
}

/**
 * Each line's entries whose column is open (`columns[e] >= 0`, renumbered)
 * copied with their values into `outIndices`/`outData`, each line's end in
 * `pointers`; how many. A loop of its own (typed by its arguments).
 */
function keptEntriesOf(local, lines, columns, values, pointers, outIndices, outData) {
  let write = 0;
  for (let line = 0; line < lines; line++) {
    const end = local[line + 1];
    for (let e = local[line]; e < end; e++) {
      const column = columns[e];
      if (column < 0) continue;
      outIndices[write] = column;
      outData[write++] = values[e];
    }
    pointers[line + 1] = write;
  }
  return write;
}

/**
 * The stored values a read of `entries` (runs of stored positions,
 * ascending) fetches only for entries left out (`columns[e] < 0`): the
 * elements of the chunks (`chunkElements` each) no kept entry lies in, or,
 * unchunked, the values left out. What reading the kept entries' values
 * alone saves.
 */
function droppedValueElements(entries, columns, chunkElements) {
  let dropped = 0;
  let at = 0;
  if (chunkElements === null) {
    for (let e = 0; e < columns.length; e++) if (columns[e] < 0) dropped++;
    return dropped;
  }
  // Chunks walked in ascending order, a stretch of entries within one at a
  // time: once a kept entry is found in a chunk, the rest of it is skipped.
  let chunk = -1;
  let keeps = true;
  for (let r = 0; r < entries.count; r++) {
    let p = entries.starts[r];
    const end = entries.ends[r];
    while (p < end) {
      const here = Math.floor(p / chunkElements);
      const stop = Math.min(end, (here + 1) * chunkElements);
      if (here !== chunk) {
        if (!keeps) dropped += chunkElements;
        chunk = here;
        keeps = false;
      }
      if (!keeps) {
        for (let e = at; e < at + stop - p; e++) {
          if (columns[e] >= 0) {
            keeps = true;
            break;
          }
        }
      }
      at += stop - p;
      p = stop;
    }
  }
  if (!keeps) dropped += chunkElements;
  return dropped;
}

/**
 * Each entry's open column (`positions`: a table, or a function; -1 left
 * out) into `columns`: how many are kept, `UNMAPPED` at a column of `-2`, or
 * `-e - 2` at entry `e` outside `[0, bound)` or not an integer.
 */
function openColumns(indices, total, positions, bound, columns) {
  let kept = 0;
  const table = positions instanceof Int32Array ? positions : null;
  for (let e = 0; e < total; e++) {
    const column = indices[e];
    if (!(column >= 0 && column < bound) || column !== Math.floor(column)) return -e - 2;
    const position = table !== null ? table[column] : positions(column);
    if (position === -2) return UNMAPPED;
    columns[e] = position;
    if (position >= 0) kept++;
  }
  return kept;
}

/** What `keepOpen` answers at a column of a row no cell is mapped to. */
const UNMAPPED = -1;

/** Whether `values` are integers of 32 bits or fewer, as typed (walked as read: a bound check each). */
function narrowIntegers(values) {
  return values instanceof Int32Array || values instanceof Uint32Array || values instanceof Int16Array ||
    values instanceof Uint16Array || values instanceof Int8Array || values instanceof Uint8Array;
}

/**
 * The two ways an induced subgraph's lines (and the k-NN tool's rows) are
 * read, whichever costs less (the reader prices them, `AnnDataReader`
 * `_graphReadPlan`):
 *
 * - `rows`: only the open cells' rows, through their pointers and the
 *   chunks their entries lie in (`readKeptRowPointers`, `gatheredArray`),
 *   in stored order a slab at a time;
 * - `stream`: the whole stored graph once, in slabs of consecutive rows
 *   (its pointers whole, its entries as contiguous ranges), keeping the
 *   open rows: what a uniform share of a graph in chunks of thousands of
 *   cells reads anyway (every chunk holds an open cell), without a gather a
 *   cell.
 *
 * @typedef {'rows'|'stream'} GraphReadPlan
 */

/**
 * An induced subgraph's lines of a sparse stored graph: the stored rows
 * `order.rows` (ascending; line `i` is cell `order.lines[i]` of `k`, or `i`:
 * `relabel`), each row's entries whose column is open (`positionOf(column)`:
 * its row's rank among `order.rows`, -1 for a column left out; `-2` for a
 * stored row no cell is mapped to, refused), renumbered, in the column order
 * stored (ascending when stored ascending). Read by
 * `plan` (`GraphReadPlan`), a slab of about `SLAB_BYTES` of entries at a
 * time; `nnz` is the open rows' stored entries, an upper bound of the
 * subgraph's. `onShare({kept, of})` is told, once every slab is read, how
 * many of the open rows' entries the subgraph keeps. `streamPointers`: a
 * stream's row pointers already asked for (`streamRowPointers`).
 *
 * @param {Object} group - A `csr_matrix` / `csc_matrix` group
 * @param {{rows: Uint32Array, lines: Uint32Array|null}} order - `storedRowOrder`, or the open rows' (`CellRows` `byRow`)
 * @param {Object} options
 * @returns {Promise<GraphLines>}
 */
async function openRowLines(group, order, { k, nStored, positionOf, plan, streamPointers = null, format, label, mergeGapBytes, roundTripBytes, readOptions, chunks, onShare, inFlightEntries = 0 }) {
  const indexNode = group.get('indices');
  const dataNode = group.get('data');
  const pointerNode = group.get('indptr');
  const valueBytes = elementBytes(dataNode);
  const limit = Math.max(1, Math.floor(SLAB_BYTES / (elementBytes(indexNode) + valueBytes)));
  const count = order.rows.length;
  const outside = raw => new Error(`Connectivity matrix index ${String(raw)} is outside axis bounds [0, ${nStored})`);
  // Each column's open position from a table where there is one (a lookup a call otherwise).
  const table = positionOf instanceof Int32Array ? positionOf : null;
  const unmapped = () => new RangeError(`${group.path} joins a row that no cell of the dataset is mapped to`);
  /**
   * Lines `[first, last)` of the order as one slab: `local` the rows'
   * entry offsets into `indices`/`values` (any numeric type, read), each
   * entry kept when its column is open (`columns`, renumbered; -1 left out).
   */
  const slabOf = (first, last, local, columns, values, keptCount) => {
    const pointers = allocateTypedArray(Float64Array, last - first + 1, `${label} pointers`);
    const outIndices = allocateTypedArray(Int32Array, keptCount, `${label} indices`);
    const numbers = values !== null && ArrayBuffer.isView(values) && !(values instanceof BigInt64Array) && !(values instanceof BigUint64Array);
    const outData = allocateTypedArray(numbers ? values.constructor : Float64Array, keptCount, `${label} values`);
    keptEntriesOf(local, last - first, columns, numbers || values === null ? values : asNumbers(values, `${label} values`), pointers, outIndices, outData);
    return { start: first, end: last, pointers, indices: outIndices, data: outData, kept: keptCount };
  };
  /** Each entry's open column (-1 left out), checked; and how many are kept. */
  const columnsOf = (indices, total) => {
    const columns = allocateTypedArray(Int32Array, total, `${label} indices`);
    const keptCount = narrowIntegers(indices)
      ? openColumns(indices, total, table ?? positionOf, nStored, columns)
      : openColumns(Float64Array.from(indices, Number), total, table ?? positionOf, nStored, columns);
    if (keptCount === UNMAPPED) throw unmapped();
    if (keptCount < 0) throw outside(indices[-keptCount - 2]);
    return { columns, keptCount };
  };
  let bound;
  let read;
  let nextSlab;
  if (plan === 'stream') {
    // The pointers of the rows from the first open one to the last (every
    // row's for every cell: what every cell's edges read too).
    const lo = order.rows[0];
    const hi = order.rows[count - 1] + 1;
    const nnz = indexNode.shape[0];
    const pointers = await (streamPointers ?? streamRowPointers(group, order.rows, label, readOptions));
    if (lo === 0 && hi === nStored) checkPointers(pointers, nnz, label);
    else {
      for (let i = 0; i < pointers.length; i++) {
        if (!(pointers[i] >= (i === 0 ? 0 : pointers[i - 1]))) throw new Error(`${label} indptr must be monotonic`);
      }
      if (pointers[pointers.length - 1] > nnz) throw new Error(`${group.path}: row pointers reach past its ${nnz} stored values`);
    }
    bound = 0;
    for (let i = 0; i < count; i++) bound += pointers[order.rows[i] - lo + 1] - pointers[order.rows[i] - lo];
    // Stored rows `[start, end)` read as contiguous ranges, holding open lines `[first, last)`.
    read = (start, end, first, last) => {
      const from = pointers[start - lo];
      const to = pointers[end - lo];
      const promise = Promise.all([
        // Indices stored as 32-bit (or narrower) integers are walked as
        // read, each kept one checked; others are converted, every one checked.
        // Contiguous ranges, as every cell's edges read them (nothing kept
        // decoded past the slab: the stream holds what every cell's does).
        readStored(indexNode, from, to, 'Connectivity matrix index', readOptions).then(raw => {
          if (narrowIntegers(raw)) return raw;
          const converted = allocateTypedArray(Int32Array, raw.length, 'Connectivity matrix index');
          axisPositionWriter(nStored)(raw, converted, 0, 'Connectivity matrix index');
          return converted;
        }),
        readNumbers(dataNode, from, to, `${label} data`, readOptions),
      ]).then(([indices, data]) => {
        let total = 0;
        for (let i = first; i < last; i++) total += pointers[order.rows[i] - lo + 1] - pointers[order.rows[i] - lo];
        // The open rows' entries whose column is open, renumbered, in one pass.
        const slabPointers = allocateTypedArray(Float64Array, last - first + 1, `${label} pointers`);
        const outIndices = allocateTypedArray(Int32Array, total, `${label} indices`);
        const outData = allocateTypedArray(data.constructor, total, `${label} values`);
        const write = keepOpen(order.rows, first, last, lo, from, pointers, indices, data, table ?? positionOf, nStored, slabPointers, outIndices, outData);
        if (write === UNMAPPED) throw unmapped();
        if (write < 0) throw outside(indices[-write - 2]);
        return { start: first, end: last, pointers: slabPointers, indices: outIndices.subarray(0, write), data: outData.subarray(0, write), kept: write };
      });
      promise.catch(() => {});
      return promise;
    };
    // The next slab of stored rows from the one holding open line `first`, and the open lines it holds.
    let row = lo;
    nextSlab = first => {
      const start = Math.max(row, order.rows[first]);
      // Never past the last open row.
      const end = lo + slabEnd(pointers, start - lo, hi - lo, limit);
      let last = first;
      while (last < count && order.rows[last] < end) last++;
      row = end;
      return { promise: read(start, end, first, last), after: last, entries: pointers[end - lo] - pointers[start - lo] };
    };
  } else {
    // The open rows' pointers only: a subgraph never reads those of the cells it left out.
    const sortedRows = new CellRows(order.rows, nStored);
    const stored = await readKeptRowPointers(pointerNode, sortedRows, { mergeGapBytes, readOptions, chunks });
    const { rowPointers } = keptEntries(stored, sortedRows);
    bound = rowPointers[count];
    if (bound > indexNode.shape[0]) throw new Error(`${group.path}: row pointers reach past its ${indexNode.shape[0]} stored values`);
    const chunkEntries = Array.isArray(dataNode.chunks) && dataNode.chunks.length > 0 && dataNode.partialChunks !== true ? dataNode.chunks[0] : null;
    read = async (first, last) => {
      const { rowPointers: local, entries } = keptEntries(stored, new CellRows(order.rows.subarray(first, last), nStored));
      const total = local[last - first];
      if (total === 0) return slabOf(first, last, local, new Int32Array(0), null, 0);
      const indices = await gatheredArray(indexNode, entries, { mergeGapBytes, chunks }).read([[0, total]], readOptions);
      const { columns, keptCount } = columnsOf(indices, total);
      // The values of every entry the slab reads in whole chunks, or the kept
      // entries' alone (one round trip more) when the chunks (or, unchunked,
      // the values) only the entries left out lie in cost more.
      const twoPass = keptCount < total && keptCount > 0 &&
        droppedValueElements(entries, columns, chunkEntries) * valueBytes > roundTripBytes();
      let values;
      if (keptCount === 0) values = null;
      else if (!twoPass) values = await gatheredArray(dataNode, entries, { mergeGapBytes, chunks }).read([[0, total]], readOptions);
      else {
        const starts = [];
        const ends = [];
        let at = 0;
        for (let r = 0; r < entries.count; r++) {
          for (let p = entries.starts[r]; p < entries.ends[r]; p++, at++) {
            if (columns[at] < 0) continue;
            if (ends.length > 0 && ends[ends.length - 1] === p) ends[ends.length - 1] = p + 1;
            else {
              starts.push(p);
              ends.push(p + 1);
            }
          }
        }
        const offsets = allocateTypedArray(Float64Array, starts.length + 1, `${label} runs`);
        for (let r = 0; r < starts.length; r++) offsets[r + 1] = offsets[r] + ends[r] - starts[r];
        const keptValues = await gatheredArray(dataNode, { count: starts.length, starts: Float64Array.from(starts), ends: Float64Array.from(ends), offsets }, { mergeGapBytes, chunks })
          .read([[0, keptCount]], readOptions);
        // Back at their entries; those left out are never read.
        values = allocateTypedArray(keptValues.constructor, total, `${label} values`);
        let next = 0;
        for (let e = 0; e < total; e++) if (columns[e] >= 0) values[e] = keptValues[next++];
      }
      return slabOf(first, last, local, columns, values, keptCount);
    };
    nextSlab = first => {
      const after = slabEnd(rowPointers, first, count, limit);
      const promise = read(first, after);
      promise.catch(() => {});
      return { promise, after, entries: rowPointers[after] - rowPointers[first] };
    };
  }
  // Slabs read ahead while one is built: the next, and over a link as many
  // as keep `inFlightEntries` entries asked for (what fills every request
  // the link runs at once, `AnnDataReader._graphReadAhead`: over S3's 7 × 6
  // connections a slab at a time left most of them idle; from a disk one
  // ahead keeps the decoders busy, and two held three times the ArrayBuffers).
  async function* slabs() {
    let kept = 0;
    const queue = [];
    let first = 0;
    let queued = 0;
    const fill = () => {
      while (first < count && (queue.length < 1 || queued < inFlightEntries)) {
        const next = nextSlab(first);
        queue.push(next);
        queued += next.entries;
        first = next.after;
      }
    };
    fill();
    while (queue.length > 0) {
      const next = queue.shift();
      const { kept: slabKept, ...slab } = await next.promise;
      queued -= next.entries;
      kept += slabKept;
      fill();
      yield slab;
    }
    onShare({ kept, of: bound });
  }
  // Lines over the open rows in stored order, each column its row's rank
  // among them; placed on the cells by `order.lines` when it is not that order
  // (within what every stored line's edges take to build: `wholeBuildBytes`).
  const relabel = order.lines === null ? null : {
    positions: order.lines,
    nCells: k,
    wholeBuildBytes: connectivityEdgeBytes({ nCells: nStored, nnz: indexNode.shape[0], float32: float32Weights(dataNode) }).build,
  };
  return { format, shape: [k, k], nnz: bound, float32: float32Weights(dataNode), relabel, slabs: slabs() };
}

/**
 * A subsample's induced subgraph of a sparse stored graph (`rows`: the open
 * cells' stored rows, in open order), as lines over the open cells: each
 * open cell's row, keeping the entries whose column is an open cell, each
 * column its rank among the open rows in stored order (so a line's entries
 * stay ascending; the edge builder places the lines on the open cells),
 * read in the stored graph's row order
 * (`storedRowOrder`) by `plan` (`GraphReadPlan`: `choose(order)` is told
 * the open rows in stored order and names it; the open rows alone without
 * it). `nnz` is the open cells' stored entries, an upper bound of the
 * subgraph's (exact when every cell is open). Over a link a round trip of
 * which costs more than the values of the entries left out, a slab of
 * `rows` reads its kept entries' values alone, after their indices.
 * `onShare({kept, of})` is told, once every slab is read, how many of the
 * open cells' stored entries the subgraph keeps.
 *
 * A MuData modality's graph placed on the store's cells (`graphPlacement`,
 * `views/modalities.js`) is read the same way, in its own rows: the open
 * cells' modality rows, each entry's column the open position of its row's
 * cell.
 *
 * @param {Object} graph - A `csr_matrix` / `csc_matrix` group, or a placed graph
 * @param {import('./views/cell-subset.js').CellRows} rows
 * @param {{mergeGapBytes: () => number, roundTripBytes?: () => number, readOptions?: Object, chunks?: Object|null,
 *   choose?: (target: {group: Object, rows: Uint32Array, nRows: number}) => Promise<GraphReadPlan>|GraphReadPlan,
 *   onShare?: (share: {kept: number, of: number}) => void}} options
 * @returns {Promise<GraphLines>}
 */
export async function inducedGraphLines(graph, rows, { mergeGapBytes, roundTripBytes = () => 0, readOptions = {}, chunks = null, choose = () => 'rows', onShare = () => {}, inFlightEntries = 0 }) {
  const k = rows.count;
  const format = encodingType(graph) === 'csc_matrix' ? 'csc' : 'csr';
  const label = `${graph.path} induced subgraph`;
  if (typeof graph.graphPlacement === 'function') {
    const { group, cellOfRow, rowOfCell, nRows } = await graph.graphPlacement(readOptions);
    // The open cells' modality rows (an unmeasured cell has none: its line is empty).
    const measured = [];
    for (let p = 0; p < k; p++) {
      const row = rowOfCell === null ? rows.kept[p] : rowOfCell[rows.kept[p]];
      if (row >= 0) measured.push(p);
    }
    const ownRows = Uint32Array.from(measured, p => (rowOfCell === null ? rows.kept[p] : rowOfCell[rows.kept[p]]));
    const order = storedRowOrder(ownRows);
    const open = Uint32Array.from(measured);
    const lines = order.lines === null ? open : Uint32Array.from(order.lines, i => open[i]);
    // In order only when every open cell is measured, in the stored order.
    const identity = measured.length === k && order.lines === null;
    const plan = await choose({ group, rows: order.rows, nRows });
    // Each modality row's rank among the open rows (-1 left out, -2 a row no cell is mapped to).
    const ranks = new KeptPositions(order.rows, nRows);
    const rowPositions = allocateTypedArray(Int32Array, nRows, `${label} positions`);
    for (let row = 0; row < nRows; row++) rowPositions[row] = cellOfRow[row] < 0 ? -2 : ranks.get(row);
    return openRowLines(group, { rows: order.rows, lines: identity ? null : lines }, {
      k, nStored: nRows, format, label, plan,
      positionOf: rowPositions,
      mergeGapBytes, roundTripBytes, readOptions, chunks, onShare, inFlightEntries,
    });
  }
  // The open rows in stored order, as the open cells hold them (`CellRows`
  // `ascending`, `byRow`: made once, shared with every read in store order).
  const ascending = rows.ascending();
  const plan = await choose({ group: graph, rows: ascending.kept, nRows: rows.nOriginal });
  // A stream's row pointers (from the first open row to the last) are asked
  // for at once: the lines' order and ranks are made while they arrive.
  const streamPointers = plan === 'stream' ? streamRowPointers(graph, ascending.kept, label, readOptions) : null;
  streamPointers?.catch(() => {});
  // The read goes out before the order is made (its requests are asked for between tasks).
  if (streamPointers !== null) await yieldToMacrotask();
  const order = ascending === rows ? { rows: rows.kept, lines: null } : { rows: ascending.kept, lines: rows.byRow().order };
  // Each column's rank among the open rows in stored order: its open
  // position when that is the open order (a lookup of the smaller form,
  // `KeptPositions`, held for the read).
  const ranks = order.lines === null ? rows.positions() : new KeptPositions(order.rows, rows.nOriginal);
  return openRowLines(graph, order, {
    k, nStored: rows.nOriginal, format, label, plan, streamPointers,
    positionOf: ranks.table ?? (column => ranks.get(column)),
    mergeGapBytes, roundTripBytes, readOptions, chunks, onShare, inFlightEntries,
  });
}

/** The row pointers a stream of the stored rows `rows` (ascending) reads: from the first to the last, the one after included. */
function streamRowPointers(group, rows, label, readOptions) {
  return readIntegers(group.get('indptr'), rows[0], rows[rows.length - 1] + 2, `${label} indptr`, readOptions);
}

/**
 * A MuData modality's graph placed on the store's cells (`graphPlacement`),
 * as lines over every store cell: its stored rows streamed once in their
 * own order, each row the line of its cell (out of order unless the
 * modality's rows are the store's cells, in order), its columns placed on
 * their rows' cells; a row with entries that no cell is mapped to is
 * refused. `nnz` is the stored graph's entries.
 *
 * @param {Object} graph - A placed graph (`views/modalities.js` `placedGraph`)
 * @param {number} nObs - The store's cells
 * @param {{readOptions?: Object}} [options]
 * @returns {Promise<GraphLines>}
 */
export async function placedGraphLines(graph, nObs, { readOptions = {} } = {}) {
  const { group, cellOfRow, rowOfCell, nRows } = await graph.graphPlacement(readOptions);
  const format = encodingType(group) === 'csc_matrix' ? 'csc' : 'csr';
  const label = `Modality graph ${group.path}`;
  // The rows a cell is mapped to, in their order, each column its row's rank among them.
  let mapped = 0;
  for (let row = 0; row < nRows; row++) if (cellOfRow[row] >= 0) mapped++;
  const rows = allocateTypedArray(Uint32Array, mapped, `${label} rows`);
  const cells = allocateTypedArray(Uint32Array, mapped, `${label} cells`);
  const ranks = allocateTypedArray(Int32Array, nRows, `${label} ranks`);
  for (let row = 0, at = 0; row < nRows; row++) {
    if (cellOfRow[row] < 0) {
      ranks[row] = -2;
      continue;
    }
    rows[at] = row;
    cells[at] = cellOfRow[row];
    ranks[row] = at++;
  }
  const identity = rowOfCell === null && nRows === nObs;
  const lines = await openRowLines(group, { rows, lines: identity ? null : cells }, {
    k: nObs, nStored: nRows, format, label, plan: 'stream',
    positionOf: ranks,
    mergeGapBytes: () => 0, roundTripBytes: () => 0, readOptions, chunks: null, onShare: () => {},
  });
  // Every stored entry is a mapped row's: a row no cell is mapped to holds none.
  if (lines.nnz !== group.get('indices').shape[0]) throw new RangeError(`${group.path} joins a row that no cell of the dataset is mapped to`);
  return lines;
}

/**
 * Some store cells' rows of a MuData modality's placed graph (`cells`,
 * distinct, any order): `{pointers, indices, data}` in the order asked, each
 * row's columns placed on their rows' cells, an unmeasured cell's row empty
 * (`readGraphRows` of the modality's own rows).
 *
 * @param {Object} graph - A placed graph
 * @param {Uint32Array} cells
 * @param {{mergeGapBytes: () => number, readOptions?: Object, chunks?: Object|null,
 *   choose?: (target: {group: Object, rows: Uint32Array, nRows: number}) => Promise<GraphReadPlan>|GraphReadPlan}} options -
 *   `choose`: told the modality rows read, names how (`GraphReadPlan`)
 * @returns {Promise<{pointers: Float64Array, indices: Int32Array, data: Float32Array|Float64Array}>}
 */
export async function readPlacedGraphRows(graph, cells, { mergeGapBytes, readOptions = {}, chunks = null, choose = () => 'rows', inFlightEntries = 0 }) {
  const { group, cellOfRow, rowOfCell, nRows } = await graph.graphPlacement(readOptions);
  const label = `Modality graph ${group.path}`;
  const asked = [];
  for (let i = 0; i < cells.length; i++) {
    const row = rowOfCell === null ? cells[i] : rowOfCell[cells[i]];
    if (row >= 0) asked.push(i);
  }
  const rowOf = i => (rowOfCell === null ? cells[i] : rowOfCell[cells[i]]);
  asked.sort((a, b) => rowOf(a) - rowOf(b));
  const ownRows = Uint32Array.from(asked, rowOf);
  const plan = await choose({ group, rows: ownRows, nRows });
  const read = await readGraphRows(group, ownRows, nRows, { mergeGapBytes, readOptions, chunks, plan, inFlightEntries });
  const counts = allocateTypedArray(Float64Array, cells.length + 1, `${label} pointers`);
  asked.forEach((slot, at) => { counts[slot + 1] = read.pointers[at + 1] - read.pointers[at]; });
  for (let i = 0; i < cells.length; i++) counts[i + 1] += counts[i];
  const total = counts[cells.length];
  const indices = allocateTypedArray(Int32Array, total, `${label} indices`);
  const data = allocateTypedArray(read.data instanceof Float32Array ? Float32Array : Float64Array, total, `${label} values`);
  asked.forEach((slot, at) => {
    let write = counts[slot];
    for (let entry = read.pointers[at]; entry < read.pointers[at + 1]; entry++) {
      const column = Number(read.indices[entry]);
      const cell = column >= 0 && column < nRows ? cellOfRow[column] : -1;
      if (cell < 0) throw new RangeError(`${group.path} joins a row that no cell of the dataset is mapped to`);
      indices[write] = cell;
      data[write++] = Number(read.data[entry]);
    }
  });
  return { pointers: counts, indices, data };
}

/**
 * The induced subgraph of an `obsp` graph on the open cells, held: what
 * `AnnDataReader.getConnectivities` answers for a subsample. A sparse graph
 * is its induced lines (`inducedGraphLines`, read by the same plan as its
 * edges) gathered in open order (`{format, shape, indptr, indices, data}`,
 * each row's entries in the column order stored, renumbered); a dense one
 * is read by its open rows, then its open columns taken. `share`: how much
 * of the open cells' graph the subgraph keeps (`{kept, of}`: its stored
 * entries between two open cells of those of the open rows).
 *
 * @param {Object} graph - The stored graph (a `csr_matrix`/`csc_matrix` group, a placed graph, or a dense array)
 * @param {import('./views/cell-subset.js').CellRows} rows
 * @param {Object} options - As `inducedGraphLines`
 * @returns {Promise<{format: 'csr'|'csc'|'dense', shape: number[], data: any, indices?: Int32Array, indptr?: Int32Array|Float64Array,
 *   share: {kept: number, of: number}}>}
 */
export async function readInducedGraph(graph, rows, options) {
  const k = rows.count;
  const n = rows.nOriginal;
  const { mergeGapBytes, readOptions = {}, chunks = null } = options;
  if (isArrayNode(graph)) {
    const block = await gatheredArray(graph, rows.runs(), { mergeGapBytes, chunks }).read([[0, k], [0, n]], readOptions);
    const data = allocateTypedArray(block.constructor, k * k, 'Kept cells graph');
    let kept = 0;
    let of = 0;
    for (let i = 0; i < k; i++) {
      for (let c = 0; c < n; c++) if (block[i * n + c] !== 0) of++;
      for (let j = 0; j < k; j++) {
        data[i * k + j] = block[i * n + rows.kept[j]];
        if (data[i * k + j] !== 0) kept++;
      }
    }
    return { format: 'dense', shape: [k, k], data, share: { kept, of } };
  }
  let share = null;
  const lines = await inducedGraphLines(graph, rows, { ...options, onShare: value => { share = value; } });
  // Slabs held until every line's count is known (the subgraph is held whole anyway).
  const held = [];
  const counts = allocateTypedArray(Float64Array, k + 1, 'Kept cells graph indptr');
  let DataType = null;
  // Line (and column) `i` is open cell `placed[i]` (`relabel`), else `i`.
  const placed = lines.relabel?.positions ?? null;
  for await (const slab of lines.slabs) {
    held.push(slab);
    DataType ??= slab.data.constructor;
    for (let line = slab.start; line < slab.end; line++) {
      counts[(placed === null ? line : placed[line]) + 1] = slab.pointers[line - slab.start + 1] - slab.pointers[line - slab.start];
    }
  }
  for (let i = 0; i < k; i++) counts[i + 1] += counts[i];
  const total = counts[k];
  const indptr = allocateTypedArray(lines.nnz <= 0x7fffffff ? Int32Array : Float64Array, k + 1, 'Kept cells graph indptr');
  for (let i = 0; i <= k; i++) indptr[i] = counts[i];
  const indices = allocateTypedArray(Int32Array, total, 'Kept cells graph indices');
  const data = allocateTypedArray(DataType ?? (float32Weights(graph.get('data')) ? Float32Array : Float64Array), total, 'Kept cells graph values');
  for (const slab of held) {
    for (let line = slab.start; line < slab.end; line++) {
      const i = line - slab.start;
      const at = counts[placed === null ? line : placed[line]];
      for (let e = slab.pointers[i]; e < slab.pointers[i + 1]; e++) indices[at + e - slab.pointers[i]] = placed === null ? slab.indices[e] : placed[slab.indices[e]];
      data.set(slab.data.subarray(slab.pointers[i], slab.pointers[i + 1]), at);
    }
  }
  return { format: lines.format, shape: [k, k], data, indices, indptr, share };
}

/**
 * The lines of a graph already held in memory (`{format, shape, indptr,
 * indices, data}`, or `{format: 'dense', shape, data}`), as one slab.
 *
 * @param {Object} graph
 * @returns {GraphLines}
 */
export function heldGraphLines(graph) {
  if (graph.format === 'dense') {
    const nCells = graph.shape[0];
    const slab = denseConnectivitySlab(graph.data, 0, nCells, nCells);
    return { format: 'dense', shape: graph.shape, nnz: slab.indices.length, float32: graph.data instanceof Float32Array, slabs: [slab][Symbol.iterator]() };
  }
  const lines = graph.format === 'csr' ? graph.shape[0] : graph.shape[1];
  return {
    format: graph.format,
    shape: graph.shape,
    nnz: graph.indices.length,
    float32: graph.data instanceof Float32Array,
    pointers: graph.indptr,
    slabs: [{ start: 0, end: lines, pointers: graph.indptr, indices: graph.indices, data: graph.data }][Symbol.iterator](),
  };
}

/**
 * A sparse graph's lines gathered into one matrix, as stored (`{format,
 * shape, indptr, indices, data}`): what `AnnDataReader.getConnectivities`
 * answers.
 *
 * @param {GraphLines} lines - Of a sparse graph (`sparseGraphLines`)
 * @param {string} label
 * @returns {Promise<{format: 'csr'|'csc', shape: number[], indptr: ArrayLike<number>, indices: Int32Array, data: ArrayLike<number>}>}
 */
export async function gatheredGraph(lines, label) {
  let indices = null;
  let data = null;
  for await (const slab of lines.slabs) {
    const at = lines.pointers[slab.start];
    indices ??= allocateTypedArray(Int32Array, lines.nnz, `${label} index`);
    data ??= allocateTypedArray(slab.data.constructor, lines.nnz, `${label} data`);
    indices.set(slab.indices, at);
    data.set(slab.data, at);
  }
  return {
    format: lines.format,
    shape: lines.shape,
    indptr: lines.pointers,
    indices: indices ?? new Int32Array(0),
    data: data ?? new Float32Array(0),
  };
}

/**
 * Some lines of a stored graph (`lines`: distinct, ascending, of
 * `nLines`), as stored: `pointers` (`lines.length + 1`) into their own
 * `indices` and `data`. A sparse graph reads the lines' pointers, then
 * their entries, through the chunks that hold them (`readKeptRowPointers`,
 * `gatheredArray`: runs of adjacent lines are one read); a dense graph
 * reads the lines' rows and keeps their non-zero entries.
 *
 * A sparse graph's lines read by the `stream` plan (`GraphReadPlan`: many
 * scattered lines, a k-NN tool's large frontier) are read as the graph's
 * contiguous ranges from each slab's first line on, the lines asked kept.
 *
 * @param {Object} graph - A `csr_matrix`/`csc_matrix` group, or a dense `n × n` array
 * @param {Uint32Array} lines
 * @param {number} nLines
 * @param {{mergeGapBytes: () => number, readOptions?: Object, chunks?: Object|null, plan?: GraphReadPlan}} options
 * @returns {Promise<{pointers: Float64Array, indices: ArrayLike<number|bigint>, data: ArrayLike<number|bigint>}>}
 */
export async function readGraphRows(graph, lines, nLines, { mergeGapBytes, readOptions = {}, chunks = null, plan = 'rows', inFlightEntries = 0 }) {
  if (plan === 'stream' && isGroup(graph) && lines.length > 0) {
    const streamed = await openRowLines(graph, { rows: lines, lines: null }, {
      k: lines.length, nStored: nLines, format: 'csr', label: 'Connectivity rows', plan,
      // Every column of a line asked is kept, as stored.
      positionOf: column => column,
      mergeGapBytes, roundTripBytes: () => 0, readOptions, chunks, onShare: () => {}, inFlightEntries,
    });
    const held = [];
    let total = 0;
    for await (const slab of streamed.slabs) {
      held.push(slab);
      total += slab.indices.length;
    }
    const pointers = allocateTypedArray(Float64Array, lines.length + 1, 'Connectivity row pointers');
    const indices = allocateTypedArray(Int32Array, total, 'Connectivity row neighbours');
    const data = allocateTypedArray(held[0]?.data.constructor ?? Float64Array, total, 'Connectivity row weights');
    for (const slab of held) {
      const at = pointers[slab.start];
      for (let i = 0; i < slab.end - slab.start; i++) pointers[slab.start + i + 1] = at + slab.pointers[i + 1];
      indices.set(slab.indices, at);
      data.set(slab.data, at);
    }
    return { pointers, indices, data };
  }
  const rows = new CellRows(lines, nLines);
  if (!isGroup(graph)) {
    const block = lines.length === 0 ? new Float64Array(0)
      : await gatheredArray(graph, rows.runs(), { mergeGapBytes, chunks }).read([[0, lines.length], [0, nLines]], readOptions);
    let stored = 0;
    for (let i = 0; i < block.length; i++) if (block[i] !== 0) stored++;
    const pointers = allocateTypedArray(Float64Array, lines.length + 1, 'Connectivity row pointers');
    const indices = allocateTypedArray(Int32Array, stored, 'Connectivity row neighbours');
    const data = allocateTypedArray(Float64Array, stored, 'Connectivity row weights');
    let at = 0;
    for (let line = 0; line < lines.length; line++) {
      for (let column = 0; column < nLines; column++) {
        const value = block[line * nLines + column];
        if (value === 0) continue;
        indices[at] = column;
        data[at++] = Number(value);
      }
      pointers[line + 1] = at;
    }
    return { pointers, indices, data };
  }
  const pointerNode = graph.get('indptr');
  const indexNode = graph.get('indices');
  const dataNode = graph.get('data');
  const stored = await readKeptRowPointers(pointerNode, rows, { mergeGapBytes, readOptions, chunks });
  const { rowPointers, entries } = keptEntries(stored, rows);
  const total = rowPointers[lines.length];
  if (total > indexNode.shape[0]) {
    throw new Error(`${graph.path}: row pointers reach past its ${indexNode.shape[0]} stored values`);
  }
  if (total === 0) return { pointers: rowPointers, indices: new Int32Array(0), data: new Float64Array(0) };
  const [indices, data] = await Promise.all([
    gatheredArray(indexNode, entries, { mergeGapBytes, chunks }).read([[0, total]], readOptions),
    gatheredArray(dataNode, entries, { mergeGapBytes, chunks }).read([[0, total]], readOptions),
  ]);
  return { pointers: rowPointers, indices, data };
}
