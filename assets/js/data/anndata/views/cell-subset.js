/**
 * A dataset opened as a subsample (`../../subsample.js`), presented as a
 * dataset of the kept cells only: a layout view (`view-nodes.js`) of the
 * store root whose cell axis has `k` rows, so the reader and everything
 * above it read a smaller AnnData and never learn the cells that were left
 * out. Cell `i` of the view is original row `kept[i]` (`../../cell-identity.js`).
 *
 * ## What is presented, and how each is read
 *
 * | element | presented as | reads |
 * | --- | --- | --- |
 * | `obs` columns and index, categorical codes, nullable values and masks | the kept rows | `gatheredArray` |
 * | dense `obsm`, dense `X` / layers / `raw/X`, stored outlier quantiles | the kept rows | `gatheredArray` |
 * | CSR `X` / layers / `raw/X` / `obsm` | a CSR matrix of the kept rows: `indptr` recomputed from the stored one (read once, when the view is made); `indices` and `data` the kept rows' entry ranges, one after another | `gatheredArray` over entry runs |
 * | CSC `X` / layers / `raw/X` | the stored matrix with `cellRows` set: the reader reads a gene's entries and keeps those of kept cells (`reader.js`, `_cellsOf`) | a gene's own entries |
 * | `obsp` graphs | as stored; the reader reads the induced subgraph (`readInducedGraph`) | kept rows' entry runs, kept columns renumbered |
 * | each modality | its rows the kept cells measured, its cell map renumbered to them | as the root's |
 * | `var`, `varm`, `varp`, the rest of `uns` | as stored | — |
 *
 * ## Interfaces (for the lanes building on it)
 *
 * - `cellSubsetView(root, {nObs, kept, mergeGapBytes, readOptions, indptrs})`
 *   — `kept`: the **file row** of each view row, in view order (a
 *   subsample's priority order, `../subsample-plan.js`; for a priority-ordered
 *   file, rows are not original positions: `../priority-layout.js`); returns
 *   the root a reader opens. A prefix (`kept` = `0 … k−1`) is one run per
 *   array, so every read is a contiguous range. View rows `[0, m)` of any
 *   view are a sample, so a read of them fetches the chunks of the
 *   highest-priority cells first.
 * - `gatheredArray(real, runs, {mergeGapBytes})`, `runsOfPositions(kept)`,
 *   `planBoxes(...)` — the gather of any array by row runs.
 * - `keptEntries(pointers, rows)` — a CSR matrix's kept entry runs and row
 *   pointers; `keptValueCount`, `keptChunkShare` — what a subsample's gene
 *   index holds and reads.
 * - `readInducedGraph(graph, rows, {mergeGapBytes, readOptions})` — an
 *   `obsp` graph on the kept cells.
 * - `CellRows` — kept rows with their runs and inverse.
 *
 * What a reader opened is `AnnDataReader.cellSubset` (`../subsample-plan.js`,
 * `CellSubsetResolution`): `kept` (ascending original positions), `openOrder`
 * (original position of each open cell, in open order),
 * `prefix` (k when the open cells are file rows `[0, k)`), `spec`, `autoFit`.
 *
 * ## Invariants at this boundary
 *
 * 1. A read of view rows `[a, b)` returns exactly what a read of the
 *    original array followed by taking rows `kept[a..b)` returns: the same
 *    type, the same values, bit for bit.
 * 2. It fetches no chunk that holds no kept row: the kept rows' runs are
 *    read as boxes of the stored array, and two runs share a box only when
 *    no chunk lies wholly between them (a chunked array decoded whole), or
 *    when the gap between them costs less than a request on the link
 *    (`mergeGapBytes`, measured: an array read byte by byte — stored in one
 *    piece, or an unfiltered HDF5 chunk). The byte reader below batches the
 *    boxes of one read into as few requests as the link prices best.
 * 3. Memory: a read holds its output and at most `SLAB_BYTES` of decoded
 *    boxes at a time (boxes are read in waves), never the full-length array.
 * 4. Nothing is read when the view is made but the kept cells' entries of
 *    each modality's cell map.
 *    A CSR matrix's row pointers are read when the matrix is first read
 *    (`readRowPointers`, which the reader awaits before it touches the
 *    matrix), and only the kept rows' (`readKeptRowPointers`): a subsample
 *    never reads the pointers of the cells it left out, nor those of a
 *    matrix it does not read (a `raw.X` or a layer next to `X`). On
 *    CELLxGENE's HLCA (2.3M cells, int64 pointers in gzip chunks of about
 *    1,250 rows) the three matrices' whole pointers were 19 of the 20 MB a
 *    1 % subsample's opening fetched.
 *
 * @module data/anndata/views/cell-subset
 */

import { formatCountOf } from '../../../utils/format-units.js';
import { isArrayNode, isGroup, normalizeSelection, numericDtype } from '../../../formats/store.js';
import { attributeValue, elementBytes, encodingType } from '../elements.js';
import { SLAB_BYTES } from '../values.js';
import { valueArray, viewGroup } from './view-nodes.js';
import { allocateTypedArray } from '../../sparse-column-index.js';
import { DecodedChunks } from '../decoded-chunks.js';

/**
 * Runs of source rows, one after another: run `r` is source rows
 * `[starts[r], ends[r])`, presented at view rows `[offsets[r], offsets[r + 1])`.
 *
 * @typedef {{count: number, starts: Float64Array, ends: Float64Array, offsets: Float64Array}} Runs
 */

/** The maximal runs of consecutive positions of a list (each run ascending by one). */
export function runsOfPositions(kept) {
  let count = 0;
  for (let i = 0; i < kept.length; i++) if (i === 0 || kept[i] !== kept[i - 1] + 1) count++;
  const starts = allocateTypedArray(Float64Array, count, 'Kept row runs');
  const ends = allocateTypedArray(Float64Array, count, 'Kept row runs');
  const offsets = allocateTypedArray(Float64Array, count + 1, 'Kept row runs');
  let r = -1;
  for (let i = 0; i < kept.length; i++) {
    if (i === 0 || kept[i] !== kept[i - 1] + 1) {
      r++;
      starts[r] = kept[i];
      offsets[r] = i;
    }
    ends[r] = kept[i] + 1;
  }
  offsets[count] = kept.length;
  return { count, starts, ends, offsets };
}

/**
 * The kept rows of one axis: `kept` (distinct positions of `nOriginal`, in view order),
 * with their runs and the inverse map made once, when first needed.
 */
export class CellRows {
  /**
   * @param {Uint32Array} kept
   * @param {number} nOriginal
   */
  constructor(kept, nOriginal) {
    this.kept = kept;
    this.nOriginal = nOriginal;
    this._runs = null;
    this._positionOf = null;
  }

  get count() { return this.kept.length; }

  /** @returns {Runs} */
  runs() {
    this._runs ??= runsOfPositions(this.kept);
    return this._runs;
  }

  /** Each original row's kept position, -1 where it is not kept. */
  positionOf() {
    if (this._positionOf === null) {
      const positionOf = allocateTypedArray(Int32Array, this.nOriginal, 'Kept cell positions').fill(-1);
      for (let i = 0; i < this.kept.length; i++) positionOf[this.kept[i]] = i;
      this._positionOf = positionOf;
    }
    return this._positionOf;
  }
}

/**
 * The stored row pointers of some rows of a CSR matrix: `at(row)` is
 * `indptr[row]` for every row a kept run starts, holds or ends at (the
 * pointer elements `[start, end]` of each run), as `Float64Array.prototype.at`
 * is for the whole array; every helper below reads pointers through `at`, so
 * either serves.
 */
export class RowPointers {
  /**
   * @param {Float64Array} starts - Ascending first pointer element of each range
   * @param {Float64Array} ends - Its end (exclusive)
   * @param {Float64Array} offsets - Where each range's values start in `values`
   * @param {Float64Array} values
   */
  constructor(starts, ends, offsets, values) {
    this.starts = starts;
    this.ends = ends;
    this.offsets = offsets;
    this.values = values;
    this.length = values.length;
  }

  at(row) {
    let lo = 0;
    let hi = this.starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ends[mid] <= row) lo = mid + 1;
      else hi = mid;
    }
    if (lo === this.starts.length || this.starts[lo] > row) {
      throw new RangeError(`Row pointer ${row} was not read with the kept rows`);
    }
    return this.values[this.offsets[lo] + row - this.starts[lo]];
  }
}

/**
 * The row pointers of the kept rows of a CSR matrix (`indptr[start..end]`
 * of every kept run), read through the stored `indptr`'s chunks that hold
 * them and no other: what knowing the kept rows' entry ranges costs. Ranges
 * `known` holds already (the same store opened before with other cells:
 * lowering a subsample, or raising it) are taken from it, not read again.
 *
 * @param {Object} indptr - The stored `indptr` array node
 * @param {CellRows} rows
 * @param {{mergeGapBytes: () => number, readOptions?: Object, known?: RowPointers|Float64Array|null}} options
 * @returns {Promise<RowPointers>}
 */
export async function readKeptRowPointers(indptr, rows, { mergeGapBytes, readOptions = {}, known = null }) {
  const runs = rows.runs();
  const order = allocateTypedArray(Uint32Array, runs.count, 'Kept row runs');
  for (let r = 0; r < order.length; r++) order[r] = r;
  order.sort((a, b) => runs.starts[a] - runs.starts[b]);
  const starts = [];
  const ends = [];
  for (const r of order) {
    const start = runs.starts[r];
    const end = runs.ends[r] + 1;
    if (ends.length > 0 && start <= ends[ends.length - 1]) ends[ends.length - 1] = Math.max(ends[ends.length - 1], end);
    else {
      starts.push(start);
      ends.push(end);
    }
  }
  const offsets = allocateTypedArray(Float64Array, starts.length + 1, 'Kept row pointers');
  for (let i = 0; i < starts.length; i++) offsets[i + 1] = offsets[i] + ends[i] - starts[i];
  const values = allocateTypedArray(Float64Array, offsets[starts.length], 'Kept row pointers');
  // The ranges `known` does not hold, read; the others copied from it.
  const missing = [];
  for (let i = 0; i < starts.length; i++) {
    if (known !== null && covers(known, starts[i], ends[i])) {
      for (let row = starts[i]; row < ends[i]; row++) values[offsets[i] + row - starts[i]] = known.at(row);
    } else missing.push(i);
  }
  if (missing.length > 0) {
    const missingOffsets = allocateTypedArray(Float64Array, missing.length + 1, 'Kept row pointers');
    missing.forEach((i, m) => { missingOffsets[m + 1] = missingOffsets[m] + ends[i] - starts[i]; });
    const missingRuns = {
      count: missing.length,
      starts: Float64Array.from(missing, i => starts[i]),
      ends: Float64Array.from(missing, i => ends[i]),
      offsets: missingOffsets,
    };
    const read = await gatheredArray(indptr, missingRuns, { mergeGapBytes }).read(undefined, readOptions);
    missing.forEach((i, m) => {
      for (let j = 0; j < ends[i] - starts[i]; j++) values[offsets[i] + j] = Number(read[missingOffsets[m] + j]);
    });
  }
  for (let range = 0; range < starts.length; range++) {
    for (let i = offsets[range]; i < offsets[range + 1]; i++) {
      if (!(values[i] >= 0) || (i > offsets[range] && !(values[i] >= values[i - 1]))) {
        throw new Error(`${indptr.path}: row pointers must be non-negative and must not decrease`);
      }
    }
  }
  return new RowPointers(Float64Array.from(starts), Float64Array.from(ends), offsets.subarray(0, starts.length), values);
}

/** Whether `pointers` (the stored `indptr`, or some rows' `RowPointers`) holds every pointer of `[start, end)`. */
function covers(pointers, start, end) {
  if (!(pointers instanceof RowPointers)) return end <= pointers.length;
  let lo = 0;
  let hi = pointers.starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (pointers.ends[mid] <= start) lo = mid + 1;
    else hi = mid;
  }
  return lo < pointers.starts.length && pointers.starts[lo] <= start && pointers.ends[lo] >= end;
}

/** First run whose view rows reach past `row` (binary search over `offsets`). */
function runAt(runs, row) {
  let lo = 0;
  let hi = runs.count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (runs.offsets[mid + 1] <= row) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The source pieces of view rows `[a, b)` grouped into boxes: each box is
 * one read of the source, `[start, end)`, holding the pieces
 * `order[from..to)`. Piece `p` is source rows `[pieceStarts[p], pieceEnds[p])`,
 * presented at view rows `[pieceAt[p], pieceAt[p] + its length)`. Pieces are
 * in view order; a subsample presents its cells in priority order
 * (`subsample-plan.js`), so their source rows need not ascend: the boxes are
 * planned over the pieces sorted by source row (`order`), each piece then
 * copied to its own view rows. See invariant 2 for when two pieces share a box.
 * `rowBytes` is a row of what is read (the columns asked for: a box holds at
 * most `spanBytes` of them); `storedRowBytes` a stored row, every column:
 * what a gap between two pieces costs when one box spans it, since the rows
 * between are read whole wherever their columns lie closer than a request
 * (a latent's two columns of thirty read thirty columns' bytes across it).
 */
export function planBoxes(runs, a, b, { chunkRows, rowBytes, storedRowBytes = rowBytes, mergeGapBytes, spanBytes = SLAB_BYTES }) {
  const pieceStarts = [];
  const pieceEnds = [];
  const pieceAt = [];
  let ascending = true;
  for (let r = runAt(runs, a); r < runs.count && runs.offsets[r] < b; r++) {
    const from = Math.max(a, runs.offsets[r]);
    const to = Math.min(b, runs.offsets[r + 1]);
    const start = runs.starts[r] + from - runs.offsets[r];
    if (pieceEnds.length > 0 && start < pieceEnds[pieceEnds.length - 1]) ascending = false;
    pieceStarts.push(start);
    pieceEnds.push(runs.starts[r] + to - runs.offsets[r]);
    pieceAt.push(from - a);
  }
  const order = Uint32Array.from(pieceStarts.keys());
  if (!ascending) order.sort((x, y) => pieceStarts[x] - pieceStarts[y]);
  const maxRows = Math.max(1, Math.floor(spanBytes / Math.max(1, rowBytes)));
  const boxes = [];
  let box = null;
  for (let o = 0; o < order.length; o++) {
    const start = pieceStarts[order[o]];
    const end = pieceEnds[order[o]];
    let joins = false;
    if (box !== null && end - box.start <= maxRows) {
      joins = chunkRows === null
        ? (start - box.end) * storedRowBytes <= mergeGapBytes
        : Math.floor(start / chunkRows) <= Math.floor((box.end - 1) / chunkRows) + 1;
    }
    if (joins) {
      box.end = end;
      box.to = o + 1;
    } else {
      box = { start, end, from: o, to: o + 1 };
      boxes.push(box);
    }
  }
  return { boxes, order, pieceStarts, pieceEnds, pieceAt };
}

/** Bytes a row of `real` holds in `tail` (a string counts as a pointer's worth). */
function rowBytesOf(real, width) {
  const bytes = elementBytes(real);
  return width * (Number.isFinite(bytes) && bytes > 0 ? bytes : 8);
}

/** Copy rows `[from, from + rows)` of `source` (width `width`) into `out` at row `at`. */
function copyRows(source, from, rows, out, at, width) {
  if (ArrayBuffer.isView(out)) {
    out.set(source.subarray(from * width, (from + rows) * width), at * width);
    return;
  }
  for (let i = 0; i < rows * width; i++) out[at * width + i] = source[from * width + i];
}

/**
 * An array presented as the rows `runs` names of `real`'s first dimension,
 * one run after another (invariants 1–3 of this module).
 *
 * @param {Object} real - An array node
 * @param {Runs} runs
 * @param {{path?: string, mergeGapBytes: () => number}} options
 * @returns {Object}
 */
export function gatheredArray(real, runs, { path = real.path, mergeGapBytes, chunks = null }) {
  const length = runs.offsets[runs.count];
  const shape = [length, ...real.shape.slice(1)];
  // A chunked array is decoded a chunk at a time; one stored in one piece,
  // or an unfiltered HDF5 one (`partialChunks`), is read byte by byte.
  const sourceChunkRows = Array.isArray(real.chunks) && real.chunks.length > 0 && real.partialChunks !== true
    ? real.chunks[0]
    : null;
  const storedRowBytes = rowBytesOf(real, real.shape.slice(1).reduce((product, extent) => product * extent, 1));
  const plan = (pairs, gap) => {
    let width = 1;
    for (const [start, stop] of pairs.slice(1)) width *= stop - start;
    const rowBytes = rowBytesOf(real, width);
    return { width, ...planBoxes(runs, pairs[0][0], pairs[0][1], { chunkRows: sourceChunkRows, rowBytes, storedRowBytes, mergeGapBytes: gap }) };
  };
  /**
   * Rows of the view through whole decoded chunks of the source: each chunk
   * the pieces touch is taken from `kept` or decoded once, a slab of chunks
   * at a time (asked for in one task, so the byte reader plans them
   * together), and its pieces' rows copied out. `kept` is the store's
   * decoded chunks (`decoded-chunks.js`), so a growth's later step, or a
   * column read again, copies its rows out of chunks decoded before; a view
   * made without them reads through a set of each read's own.
   */
  const readThroughChunks = async (pairs, options, kept) => {
    const [a, b] = pairs[0];
    const tail = pairs.slice(1);
    const tailKey = JSON.stringify(tail);
    const { width, order, pieceStarts, pieceEnds, pieceAt } = plan(pairs, 0);
    const rowBytes = rowBytesOf(real, width);
    const rowsOfChunk = c => [c * sourceChunkRows, Math.min(real.shape[0], (c + 1) * sourceChunkRows)];
    // The chunks the pieces touch, ascending (the pieces are in source order through `order`).
    const touched = [];
    for (let o = 0; o < order.length; o++) {
      const p = order[o];
      const first = Math.floor(pieceStarts[p] / sourceChunkRows);
      const last = Math.floor((pieceEnds[p] - 1) / sourceChunkRows);
      for (let c = Math.max(first, touched.length > 0 ? touched[touched.length - 1] + 1 : first); c <= last; c++) touched.push(c);
    }
    let out = null;
    let o = 0;
    for (let first = 0; first < touched.length;) {
      let last = first;
      let bytes = 0;
      while (last < touched.length && (last === first || bytes + sourceChunkRows * rowBytes <= SLAB_BYTES)) {
        bytes += sourceChunkRows * rowBytes;
        last++;
      }
      const wave = touched.slice(first, last);
      // A chunk another read is decoding is shared, and stops only once
      // every read waiting for it withdrew (`decoded-chunks.js`).
      const decoded = await Promise.all(wave.map(c => kept.get(`${real.path}|${tailKey}|${c}`, decodeOptions => {
        const [start, end] = rowsOfChunk(c);
        return real.read([[start, end], ...tail], decodeOptions);
      }, options)));
      const blocks = new Map(wave.map((c, i) => [c, decoded[i]]));
      const waveStart = rowsOfChunk(wave[0])[0];
      const waveEnd = rowsOfChunk(wave[wave.length - 1])[1];
      // Each piece's rows inside the wave's chunks, chunk by chunk.
      while (o < order.length && pieceStarts[order[o]] < waveEnd) {
        const p = order[o];
        const from = Math.max(pieceStarts[p], waveStart);
        const to = Math.min(pieceEnds[p], waveEnd);
        for (let row = from; row < to;) {
          const c = Math.floor(row / sourceChunkRows);
          const block = blocks.get(c);
          const [chunkStart, chunkEnd] = rowsOfChunk(c);
          if (block === null || block === undefined || block.length !== (chunkEnd - chunkStart) * width) {
            throw new Error(`${real.path}: rows ${chunkStart} to ${chunkEnd} did not read as ${formatCountOf(chunkEnd - chunkStart, 'row')}`);
          }
          const stop = Math.min(to, chunkEnd);
          if (out === null) out = ArrayBuffer.isView(block) ? allocateTypedArray(block.constructor, (b - a) * width, `${real.path} kept rows`) : new Array((b - a) * width);
          copyRows(block, row - chunkStart, stop - row, out, pieceAt[p] + (row - pieceStarts[p]), width);
          row = stop;
        }
        if (pieceEnds[p] > waveEnd) break;
        o++;
      }
      first = last;
    }
    return out;
  };
  return Object.freeze({
    kind: 'array',
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    attrs: real.attrs,
    attributeType: name => real.attributeType(name),
    shape,
    dtype: real.dtype,
    // Kept rows per stored chunk, about: what cost estimates and slab
    // alignment read; the chunks themselves stay the stored ones.
    chunks: Array.isArray(real.chunks) && real.chunks.length > 0
      ? [Math.max(1, Math.round(real.chunks[0] * length / Math.max(1, real.shape[0]))), ...real.chunks.slice(1)]
      : null,
    partialChunks: false,
    fillValue: real.fillValue,
    gather: Object.freeze({ source: real, runs }),
    async storedBytes(selection, options) {
      const pairs = normalizeSelection(shape, selection, path);
      if (pairs[0][1] === pairs[0][0]) return 0;
      const { boxes } = plan(pairs, mergeGapBytes());
      const tail = pairs.slice(1);
      const sizes = await Promise.all(boxes.map(box => real.storedBytes([[box.start, box.end], ...tail], options)));
      return sizes.some(size => !Number.isFinite(size)) ? null : sizes.reduce((sum, size) => sum + size, 0);
    },
    async read(selection, options) {
      const pairs = normalizeSelection(shape, selection, path);
      const tail = pairs.slice(1);
      const [a, b] = pairs[0];
      if (b === a) return real.read([[0, 0], ...tail], options);
      // An array decoded a chunk at a time is read through its decoded
      // chunks: the store's (`chunks`), else a set of this read's own.
      if (sourceChunkRows !== null) return readThroughChunks(pairs, options, chunks ?? new DecodedChunks(0));
      const { width, boxes, order, pieceStarts, pieceEnds, pieceAt } = plan(pairs, mergeGapBytes());
      const rowBytes = rowBytesOf(real, width);
      let out = null;
      // Waves of boxes of at most a slab of decoded rows, every box of a
      // wave asked for in one task so the byte reader plans them together.
      for (let first = 0; first < boxes.length;) {
        let last = first;
        let bytes = 0;
        while (last < boxes.length && (last === first || bytes + (boxes[last].end - boxes[last].start) * rowBytes <= SLAB_BYTES)) {
          bytes += (boxes[last].end - boxes[last].start) * rowBytes;
          last++;
        }
        const wave = boxes.slice(first, last);
        const blocks = await Promise.all(wave.map(box => real.read([[box.start, box.end], ...tail], options)));
        wave.forEach((box, w) => {
          const block = blocks[w];
          if (block === null || block === undefined || block.length !== (box.end - box.start) * width) {
            throw new Error(`${real.path}: rows ${box.start} to ${box.end} did not read as ${formatCountOf(box.end - box.start, 'row')}`);
          }
          if (out === null) out = ArrayBuffer.isView(block) ? allocateTypedArray(block.constructor, (b - a) * width, `${real.path} kept rows`) : new Array((b - a) * width);
          for (let o = box.from; o < box.to; o++) {
            const p = order[o];
            copyRows(block, pieceStarts[p] - box.start, pieceEnds[p] - pieceStarts[p], out, pieceAt[p], width);
          }
        });
        first = last;
      }
      return out;
    },
  });
}

/** A child made once, as `viewGroup` makes its children. */
function passChildren(group, wrap = () => null) {
  return new Map(group.keys().map(key => [key, () => wrap(key, group.get(key)) ?? group.get(key)]));
}

/** A node's path as the view keys matrices by (no leading slash: Zarr and HDF5 paths alike). */
function pathKey(path) {
  return String(path).replace(/^\/+/, '');
}

/** Context every wrapped node of one view shares, with the rows of the group it wraps. */
function contextOf(rows, ctx) {
  return { ...ctx, rows };
}


/** A dataframe of the kept rows: every column, categorical codes, nullable values and masks. */
function dataFrameRows(frame, ctx) {
  const n = ctx.rows.nOriginal;
  const gatherIfRows = node => (isArrayNode(node) && node.shape.length >= 1 && node.shape[0] === n
    ? gatheredArray(node, ctx.rows.runs(), { mergeGapBytes: ctx.mergeGapBytes , chunks: ctx.chunks })
    : null);
  return viewGroup({
    path: frame.path,
    attrs: frame.attrs,
    real: frame,
    children: passChildren(frame, (key, node) => {
      if (isArrayNode(node)) return gatherIfRows(node);
      if (!isGroup(node)) return null;
      const encoding = encodingType(node);
      if (encoding === 'categorical') {
        return viewGroup({
          path: node.path,
          attrs: node.attrs,
          real: node,
          children: passChildren(node, (name, part) => (name === 'codes' ? gatherIfRows(part) : null)),
        });
      }
      if (encoding.startsWith('nullable-')) {
        return viewGroup({
          path: node.path,
          attrs: node.attrs,
          real: node,
          children: passChildren(node, (name, part) => (name === 'values' || name === 'mask' ? gatherIfRows(part) : null)),
        });
      }
      return null;
    }),
  });
}

/** Whether `node` is a sparse matrix group, and which. */
function sparseFormatOf(node) {
  if (!isGroup(node)) return null;
  const encoding = encodingType(node);
  return encoding === 'csr_matrix' ? 'csr' : encoding === 'csc_matrix' ? 'csc' : null;
}

/** The stored row count of a matrix node (a sparse group's `shape`, a dense array's first extent). */
function matrixRowsOf(node) {
  if (isArrayNode(node)) return node.shape[0];
  const shape = attributeValue(node, 'shape');
  return Array.isArray(shape) ? Number(shape[0]) : null;
}

/** An `indptr` of exact counts as the array a view presents. */
export function pointerArray(path, pointers) {
  const total = pointers[pointers.length - 1];
  const wide = total > 0x7fffffff;
  const values = allocateTypedArray(wide ? BigInt64Array : Int32Array, pointers.length, `${path} indptr`);
  for (let i = 0; i < pointers.length; i++) values[i] = wide ? BigInt(pointers[i]) : pointers[i];
  return valueArray({
    path,
    dtype: numericDtype('int', wide ? 8 : 4),
    shape: [pointers.length],
    values,
    attrs: {},
  });
}

/**
 * The entry runs of the kept rows of a CSR matrix with row pointers
 * `pointers` (the stored `indptr`, or the kept rows' `RowPointers`), and the
 * pointers of the kept rows.
 */
export function keptEntries(pointers, rows) {
  const kept = rows.kept;
  const rowPointers = allocateTypedArray(Float64Array, kept.length + 1, 'Kept row pointers');
  for (let i = 0; i < kept.length; i++) rowPointers[i + 1] = rowPointers[i] + pointers.at(kept[i] + 1) - pointers.at(kept[i]);
  const rowRuns = rows.runs();
  const starts = [];
  const ends = [];
  for (let r = 0; r < rowRuns.count; r++) {
    const start = pointers.at(rowRuns.starts[r]);
    const end = pointers.at(rowRuns.ends[r]);
    if (end === start) continue;
    if (ends.length > 0 && ends[ends.length - 1] === start) ends[ends.length - 1] = end;
    else {
      starts.push(start);
      ends.push(end);
    }
  }
  const offsets = allocateTypedArray(Float64Array, starts.length + 1, 'Kept entry runs');
  for (let r = 0; r < starts.length; r++) offsets[r + 1] = offsets[r] + ends[r] - starts[r];
  return {
    rowPointers,
    entries: { count: starts.length, starts: Float64Array.from(starts), ends: Float64Array.from(ends), offsets },
  };
}

/**
 * A CSR matrix of the kept rows. Its `indptr`, `indices` and `data` are
 * made once its kept rows' pointers are read (`readRowPointers` on the view
 * root, which every read of the matrix awaits first); its shape and
 * attributes are known before.
 */
function csrRows(matrix, rows, ctx) {
  const key = pathKey(matrix.path);
  ctx.matrices.set(key, { matrix, rows });
  let kept = null;
  const keptOf = () => {
    if (kept !== null) return kept;
    const pointers = ctx.indptrs.get(key);
    if (pointers === undefined) throw new Error(`${matrix.path}: its row pointers are read before the matrix is (readRowPointers)`);
    kept = keptEntries(pointers, rows);
    return kept;
  };
  const shape = attributeValue(matrix, 'shape');
  return viewGroup({
    path: matrix.path,
    attrs: { ...matrix.attrs, shape: [rows.count, Number(shape[1])] },
    real: matrix,
    ownAttributes: ['shape'],
    // Until its pointers are read, what describing the matrix may ask:
    // whether they are, and its stored `data` (dtype; stored values unknown).
    extra: { rowPointersPending: () => !ctx.indptrs.has(key), storedData: () => matrix.get('data') },
    children: passChildren(matrix, (key, node) => {
      if (key === 'indptr') return pointerArray(node.path, keptOf().rowPointers);
      if ((key === 'indices' || key === 'data') && isArrayNode(node)) {
        return gatheredArray(node, keptOf().entries, { mergeGapBytes: ctx.mergeGapBytes , chunks: ctx.chunks });
      }
      return null;
    }),
  });
}

/**
 * A matrix (cells × features) of the kept rows: a CSR one as `csrRows`, a
 * dense one gathered, a CSC one as stored with `cellRows` naming the kept
 * rows (its genes are read whole and their kept entries kept).
 */
function matrixRows(matrix, rows, ctx) {
  if (isArrayNode(matrix)) {
    return matrix.shape[0] === rows.nOriginal ? gatheredArray(matrix, rows.runs(), { mergeGapBytes: ctx.mergeGapBytes , chunks: ctx.chunks }) : matrix;
  }
  const format = sparseFormatOf(matrix);
  if (format === 'csr') return csrRows(matrix, rows, ctx);
  if (format === 'csc') {
    const shape = attributeValue(matrix, 'shape');
    return viewGroup({
      path: matrix.path,
      attrs: { ...matrix.attrs, shape: [rows.count, Number(shape[1])] },
      real: matrix,
      ownAttributes: ['shape'],
      children: passChildren(matrix),
      extra: { cellRows: Object.freeze({ matrix, rows }) },
    });
  }
  return matrix;
}

/**
 * The induced subgraph of an `obsp` graph (cells × cells) on the kept cells:
 * the kept rows' entries (their entry runs only are read), those whose
 * column is kept, renumbered; as `readSparseMatrix` reads a whole graph
 * (`data` as stored, `indices` int32, `indptr` exact). A dense graph is
 * read by its kept rows, then its kept columns taken.
 *
 * @param {Object} graph - The stored graph (a `csr_matrix`/`csc_matrix` group, or a dense array)
 * @param {CellRows} rows
 * @param {{mergeGapBytes: () => number, roundTripBytes?: () => number, readOptions?: Object}} options
 *   `roundTripBytes`: what one round trip of the link is worth in bytes (0
 *   for a local file): the kept edges' values are read apart from the
 *   others' when the others' would cost more
 * `share` is how much of the kept cells' graph the subgraph keeps: its
 * stored entries (`kept`) of those of the kept rows (`of`); the others join
 * a kept cell to one left out, and cannot be in a subsample.
 *
 * @returns {Promise<{format: 'csr'|'csc'|'dense', shape: number[], data: any, indices?: Int32Array, indptr?: Int32Array|Float64Array,
 *   share: {kept: number, of: number}}>}
 */
export async function readInducedGraph(graph, rows, { mergeGapBytes, roundTripBytes = () => 0, readOptions = {} }) {
  const k = rows.count;
  const n = rows.nOriginal;
  const format = sparseFormatOf(graph);
  if (format === null) {
    const block = await gatheredArray(graph, rows.runs(), { mergeGapBytes }).read([[0, k], [0, n]], readOptions);
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
  const pointerNode = graph.get('indptr');
  const indexNode = graph.get('indices');
  const dataNode = graph.get('data');
  // The kept rows' pointers only: a subgraph never reads those of the cells it left out.
  const pointers = await readKeptRowPointers(pointerNode, rows, { mergeGapBytes, readOptions });
  if (pointers.values[pointers.values.length - 1] > indexNode.shape[0]) {
    throw new Error(`${graph.path}: row pointers reach past its ${formatCountOf(indexNode.shape[0], 'stored value')}`);
  }
  const { rowPointers, entries } = keptEntries(pointers, rows);
  const total = rowPointers[k];
  const positionOf = rows.positionOf();
  // An edge is kept when its column is: about k/n of the kept rows' edges.
  // Their values alone are read after the indices (one round trip more)
  // when the values of the edges dropped cost more than that round trip;
  // else all the kept rows' values are read beside the indices. What a
  // pass reads is whole chunks: the kept rows' values span the value chunks
  // their entries lie in (a Zarr store's chunk can be a megabyte: forty
  // kept cells' 1,000 values still read all of it in one pass).
  const valueBytes = elementBytes(dataNode);
  const chunkEntries = Array.isArray(dataNode.chunks) && dataNode.chunks.length > 0 && dataNode.partialChunks !== true ? dataNode.chunks[0] : null;
  let onePassValues = 0;
  if (chunkEntries === null) onePassValues = total;
  else {
    let lastChunk = -1;
    for (let r = 0; r < entries.count; r++) {
      const first = Math.max(Math.floor(entries.starts[r] / chunkEntries), lastChunk + 1);
      const last = Math.floor((entries.ends[r] - 1) / chunkEntries);
      if (last >= first) onePassValues += (last - first + 1) * chunkEntries;
      lastChunk = Math.max(lastChunk, last);
    }
  }
  const droppedValueBytes = onePassValues * valueBytes * (1 - k / n);
  const twoPass = total > 0 && droppedValueBytes > roundTripBytes();
  let indices;
  let data;
  if (total === 0) {
    indices = new Int32Array(0);
    data = await dataNode.read([[0, 0]], readOptions);
  } else if (!twoPass) {
    [indices, data] = await Promise.all([
      gatheredArray(indexNode, entries, { mergeGapBytes }).read([[0, total]], readOptions),
      gatheredArray(dataNode, entries, { mergeGapBytes }).read([[0, total]], readOptions),
    ]);
  } else {
    indices = await gatheredArray(indexNode, entries, { mergeGapBytes }).read([[0, total]], readOptions);
    // The stored positions of the kept edges, as runs: only the value chunks
    // that hold one are read.
    const starts = [];
    const ends = [];
    const offsets = [0];
    let at = 0;
    for (let r = 0; r < entries.count; r++) {
      for (let p = entries.starts[r]; p < entries.ends[r]; p++, at++) {
        const index = Number(indices[at]);
        if (!(index >= 0 && index < n) || positionOf[index] < 0) continue;
        if (ends.length > 0 && ends[ends.length - 1] === p) ends[ends.length - 1] = p + 1;
        else {
          starts.push(p);
          ends.push(p + 1);
          offsets.push(offsets[offsets.length - 1]);
        }
        offsets[offsets.length - 1]++;
      }
    }
    const keptRuns = { count: starts.length, starts: Float64Array.from(starts), ends: Float64Array.from(ends), offsets: Float64Array.from([0, ...offsets.slice(1)]) };
    const keptCount = keptRuns.offsets[keptRuns.count] ?? 0;
    const keptValues = keptCount === 0 ? await dataNode.read([[0, 0]], readOptions) : await gatheredArray(dataNode, keptRuns, { mergeGapBytes }).read([[0, keptCount]], readOptions);
    // Values back at their entries (the dropped ones never read: zero, skipped below).
    data = allocateTypedArray(keptValues.constructor, total, 'Kept cells graph values');
    let next = 0;
    at = 0;
    for (let r = 0; r < entries.count; r++) {
      for (let p = entries.starts[r]; p < entries.ends[r]; p++, at++) {
        const index = Number(indices[at]);
        if (index >= 0 && index < n && positionOf[index] >= 0) data[at] = keptValues[next++];
      }
    }
  }
  const outIndices = allocateTypedArray(Int32Array, total, 'Kept cells graph indices');
  const outData = allocateTypedArray(data.constructor, total, 'Kept cells graph values');
  const outPointers = allocateTypedArray(total <= 0x7fffffff ? Int32Array : Float64Array, k + 1, 'Kept cells graph indptr');
  let at = 0;
  for (let i = 0; i < k; i++) {
    for (let e = rowPointers[i]; e < rowPointers[i + 1]; e++) {
      const index = Number(indices[e]);
      if (!(index >= 0 && index < n) || !Number.isInteger(index)) {
        throw new Error(`Connectivity matrix index ${String(indices[e])} is outside axis bounds [0, ${n})`);
      }
      const position = positionOf[index];
      if (position < 0) continue;
      outIndices[at] = position;
      outData[at++] = data[e];
    }
    outPointers[i + 1] = at;
  }
  return { format, shape: [k, k], data: outData.slice(0, at), indices: outIndices.slice(0, at), indptr: outPointers, share: { kept: at, of: total } };
}

/** A mapping (`obsm`, `layers`, `obsp`) whose every child is wrapped by `wrap`. */
function mappingOf(group, wrap) {
  if (!isGroup(group)) return group;
  return viewGroup({ path: group.path, attrs: group.attrs, real: group, children: passChildren(group, (key, node) => wrap(node)) });
}

/** `obsm` of the kept rows: dense arrays gathered, dataframes and sparse matrices by rows. */
function obsmRows(obsm, rows, ctx) {
  return mappingOf(obsm, node => {
    if (isArrayNode(node)) return node.shape[0] === rows.nOriginal ? gatheredArray(node, rows.runs(), { mergeGapBytes: ctx.mergeGapBytes , chunks: ctx.chunks }) : node;
    if (encodingType(node) === 'dataframe') return dataFrameRows(node, contextOf(rows, ctx));
    return matrixRows(node, rows, ctx);
  });
}

/** One AnnData group (the root's cells, or a modality's rows) with every cell-axis element of the kept rows. */
function annDataRows(group, rows, ctx, extraChildren = new Map()) {
  const children = passChildren(group, (key, node) => {
    switch (key) {
      case 'obs': return isGroup(node) ? dataFrameRows(node, contextOf(rows, ctx)) : null;
      case 'obsm': return obsmRows(node, rows, ctx);
      case 'X': return matrixRows(node, rows, ctx);
      case 'layers': return mappingOf(node, layer => matrixRows(layer, rows, ctx));
      case 'raw':
        if (!isGroup(node)) return null;
        return viewGroup({
          path: node.path,
          attrs: node.attrs,
          real: node,
          children: passChildren(node, (name, part) => (name === 'X' ? matrixRows(part, rows, ctx) : null)),
        });
      default: return null;
    }
  });
  for (const [key, make] of extraChildren) children.set(key, make);
  return children;
}

/** `uns` with the stored outlier quantiles (one value per cell) of the kept rows. */
function unsRows(uns, rows, ctx) {
  const wrapPath = (node, names, leaf) => {
    if (!isGroup(node)) return node;
    if (names.length === 0) return mappingOf(node, leaf);
    return viewGroup({
      path: node.path,
      attrs: node.attrs,
      real: node,
      children: passChildren(node, (key, part) => (key === names[0] ? wrapPath(part, names.slice(1), leaf) : null)),
    });
  };
  return wrapPath(uns, ['cellucid', 'outlierQuantiles', 'fields'], node => (
    isArrayNode(node) && node.shape[0] === rows.nOriginal ? gatheredArray(node, rows.runs(), { mergeGapBytes: ctx.mergeGapBytes , chunks: ctx.chunks }) : node
  ));
}

/**
 * The rows of one modality the kept cells measured, and its cell map
 * renumbered to them (1-based, 0 where not measured).
 */
async function modalityRows(modality, rows, options, mergeGapBytes) {
  // The kept cells' entries of the cell map only, in view order.
  const kept = await gatheredArray(modality.obsmap, rows.runs(), { mergeGapBytes }).read(undefined, options);
  const k = rows.count;
  const measuredRows = [];
  for (let i = 0; i < k; i++) {
    const row = Number(kept[i]);
    if (row > 0) measuredRows.push(row - 1);
  }
  const unique = Uint32Array.from(new Set(measuredRows)).sort();
  const newRow = new Map();
  unique.forEach((row, i) => newRow.set(row, i + 1));
  const obsmap = allocateTypedArray(Uint32Array, k, 'Modality cell rows');
  for (let i = 0; i < k; i++) {
    const row = Number(kept[i]);
    obsmap[i] = row > 0 ? newRow.get(row - 1) : 0;
  }
  return { modalityKept: new CellRows(unique, modality.nCells), obsmap };
}

/**
 * The view of a store root (in the current AnnData layout) that holds only
 * the kept cells.
 *
 * @param {Object} root
 * @param {{nObs: number, kept: Uint32Array, mergeGapBytes: () => number, readOptions?: Object,
 *   indptrs?: Map<string, Float64Array>, knownRowPointers?: Map<string, RowPointers>}} subset -
 *   `kept`: the file row of each view row, in view order, fewer than `nObs`; `mergeGapBytes`:
 *   the link's merge gap now (a function: it follows the link as measured);
 *   `indptrs`: CSR row pointers read whole before, by matrix path;
 *   `knownRowPointers`: the rows' pointers an earlier view of the same store
 *   read (`knownRowPointers()` of that view), taken over where they hold
 *   the kept rows' pointers
 * @returns {Promise<Object>}
 */
export async function cellSubsetView(root, { nObs, kept, mergeGapBytes, readOptions = {}, indptrs = new Map(), knownRowPointers = new Map(), chunks = null }) {
  const known = new Map([...knownRowPointers].map(([path, pointers]) => [pathKey(path), pointers]));
  const rows = new CellRows(kept, nObs);
  const modalities = Array.isArray(root.modalities) ? root.modalities : null;
  // What the view must know before it is made: each modality's rows.
  const modalityPlans = new Map();
  if (modalities !== null) {
    await Promise.all(modalities.map(async modality => {
      const plan = modality.obsmap === null
        ? { modalityKept: rows, obsmap: null }
        : await modalityRows(modality, rows, readOptions, mergeGapBytes);
      modalityPlans.set(modality.name, plan);
    }));
  }
  // Row pointers by matrix path: the stored ones given (read whole before,
  // for every cell), else the kept rows' once read; `matrices` names each
  // CSR matrix the view presents and the rows it keeps of it.
  const ctx = {
    rows,
    mergeGapBytes,
    // The store's decoded chunks (`decoded-chunks.js`) every chunk-decoded read goes through, or null.
    chunks,
    indptrs: new Map([...indptrs].map(([path, pointers]) => [pathKey(path), pointers])),
    matrices: new Map(),
    pointerReads: new Map(),
  };
  /**
   * Read the kept rows' pointers of the CSR matrix at `path` (once; nothing
   * for any other node, or one whose pointers are known).
   */
  /**
   * The key a matrix's pointers are kept under: its node's own path. A view
   * that presents a store under other names (a 10x `.h5`'s `/matrix` as
   * `X`) names the element by where it is shown; the matrix is known by
   * where it is stored. Reaching it makes its view (which names its rows).
   */
  const matrixKey = path => {
    const named = pathKey(path);
    if (named === '') return named;
    const node = view.get(named);
    return node === null || node === undefined ? named : pathKey(node.path);
  };
  const readRowPointers = (path, options = {}) => {
    const key = matrixKey(path);
    const entry = ctx.matrices.get(key) ?? null;
    if (entry === null || ctx.indptrs.has(key)) return Promise.resolve();
    let reading = ctx.pointerReads.get(key);
    if (reading === undefined) {
      reading = readKeptRowPointers(entry.matrix.get('indptr'), entry.rows, { mergeGapBytes, readOptions: options, known: known.get(key) ?? null }).then(pointers => {
        const last = pointers.values[pointers.values.length - 1];
        if (last > entry.matrix.get('indices').shape[0]) {
          throw new Error(`${path}: row pointers reach past its ${formatCountOf(entry.matrix.get('indices').shape[0], 'stored value')}`);
        }
        ctx.indptrs.set(key, pointers);
      });
      ctx.pointerReads.set(key, reading);
      // A failed or cancelled read is tried again by the next read of the matrix.
      reading.catch(() => ctx.pointerReads.delete(key));
    }
    return reading;
  };

  const extraChildren = new Map();
  let presentedModalities = null;
  if (modalities !== null) {
    presentedModalities = Object.freeze(modalities.map(modality => {
      const plan = modalityPlans.get(modality.name);
      const obsmap = plan.obsmap === null ? null : valueArray({
        path: modality.obsmap.path,
        dtype: numericDtype('uint', 4),
        shape: [rows.count],
        values: plan.obsmap,
        attrs: modality.obsmap.attrs,
      });
      return Object.freeze({ name: modality.name, obsmap, nCells: plan.modalityKept.count });
    }));
    const mod = root.get('mod');
    extraChildren.set('mod', () => viewGroup({
      path: mod.path,
      attrs: mod.attrs,
      real: mod,
      children: passChildren(mod, (name, group) => {
        const plan = modalityPlans.get(name);
        if (plan === undefined || !isGroup(group)) return null;
        const modalityCtx = { ...ctx, rows: plan.modalityKept };
        return viewGroup({ path: group.path, attrs: group.attrs, real: group, children: annDataRows(group, plan.modalityKept, modalityCtx) });
      }),
    }));
    const obsmaps = root.get('obsmap');
    if (isGroup(obsmaps)) {
      extraChildren.set('obsmap', () => viewGroup({
        path: obsmaps.path,
        attrs: obsmaps.attrs,
        real: obsmaps,
        children: passChildren(obsmaps, name => presentedModalities.find(item => item.name === name)?.obsmap ?? null),
      }));
    }
  }
  if (root.has('uns')) extraChildren.set('uns', () => unsRows(root.get('uns'), rows, ctx));

  /** The pointers `readRowPointers` read of the matrix at `path`, or null. */
  const rowPointersOf = path => ctx.indptrs.get(matrixKey(path)) ?? null;
  /**
   * Every pointer this view and the ones before it of the same store read
   * (by matrix): what a later view of the store takes over (`knownRowPointers`).
   */
  const knownRowPointersOf = () => {
    const all = new Map(known);
    for (const [key, pointers] of ctx.indptrs) if (pointers instanceof RowPointers) all.set(key, pointers);
    return all;
  };
  const extra = presentedModalities === null
    ? { readRowPointers, rowPointersOf, knownRowPointers: knownRowPointersOf }
    : { modalities: presentedModalities, defaultModality: root.defaultModality, readRowPointers, rowPointersOf, knownRowPointers: knownRowPointersOf };
  const view = viewGroup({
    path: root.path,
    attrs: root.attrs,
    real: root,
    children: annDataRows(root, rows, ctx, extraChildren),
    close: () => root.close?.(),
    extra,
  });
  return view;
}

/**
 * The share of a CSR matrix's index chunks (`chunkElements` entries each)
 * the kept rows' entries lie in: what reading the subsample's genes fetches
 * of the matrix, against the share of the cells it keeps.
 *
 * @param {Float64Array|RowPointers} pointers - The stored `indptr`, or the kept rows' pointers
 * @param {Uint32Array} rows - The kept rows, in any order
 * @param {number} chunkElements
 * @param {number} [nnz] - The matrix's stored values (the stored `indptr`'s last)
 * @returns {number}
 */
export function keptChunkShare(pointers, rows, chunkElements, nnz = pointers[pointers.length - 1]) {
  if (nnz === 0) return 0;
  // Counted over the rows ascending (a view presents them in priority order).
  const kept = rows.every((row, i) => i === 0 || row > rows[i - 1]) ? rows : rows.slice().sort();
  let touched = 0;
  let last = -1;
  for (let i = 0; i < kept.length; i++) {
    const start = pointers.at(kept[i]);
    const end = pointers.at(kept[i] + 1);
    if (end <= start) continue;
    let first = Math.floor(start / chunkElements);
    const stop = Math.floor((end - 1) / chunkElements);
    if (first <= last) first = last + 1;
    if (stop >= first) touched += stop - first + 1;
    if (stop > last) last = stop;
  }
  return touched / Math.ceil(nnz / chunkElements);
}

/**
 * `keptChunkShare` before any pointer is read: each row taken to hold the
 * matrix's mean stored values (`nnz / nRows`), so row `r`'s entries start at
 * about `r * nnz / nRows`. What opening says of reading genes, without the
 * pointers it does not read (replaced by the exact share once X is read).
 *
 * @param {Uint32Array} rows - The kept rows, in any order
 * @param {number} nRows
 * @param {number} nnz
 * @param {number} chunkElements
 * @returns {number}
 */
export function estimatedChunkShare(rows, nRows, nnz, chunkElements) {
  if (nnz === 0 || nRows === 0) return 0;
  const perRow = nnz / nRows;
  const at = row => Math.min(nnz, Math.round(row * perRow));
  return keptChunkShare({ at }, rows, chunkElements, nnz);
}

/**
 * The stored values of the kept rows of a CSR matrix, from its row
 * pointers: what a column index of the subsample holds.
 *
 * @param {Float64Array|RowPointers} pointers - The stored `indptr`, or the kept rows' pointers
 * @param {Uint32Array} kept
 * @returns {number}
 */
export function keptValueCount(pointers, kept) {
  let total = 0;
  for (let i = 0; i < kept.length; i++) total += pointers.at(kept[i] + 1) - pointers.at(kept[i]);
  return total;
}
