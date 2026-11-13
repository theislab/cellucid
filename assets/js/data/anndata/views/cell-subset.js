/**
 * A dataset opened as a subsample (`../../subsample.js`), presented as a
 * dataset of the kept cells only: a layout view (`view-nodes.js`) of the
 * store root whose cell axis has `k` rows, so the reader and everything
 * above it read a smaller AnnData and never learn the cells that were left
 * out. Cell `i` of the view is file row `kept[i]` (the reader passes the
 * resolution's `fileRows`: for a priority-ordered file, not an original
 * position; `../../cell-identity.js` maps open cells to original positions).
 *
 * ## What is presented, and how each is read
 *
 * | element | presented as | reads |
 * | --- | --- | --- |
 * | `obs` columns and index, categorical codes, nullable values and masks | the kept rows | `gatheredArray` |
 * | dense `obsm`, dense `X` / layers / `raw/X`, stored outlier quantiles | the kept rows | `gatheredArray` |
 * | CSR `X` / layers / `raw/X` / `obsm` | a CSR matrix of the kept rows: `indptr` recomputed from the stored one (read when the matrix is first read, the kept rows' only: invariant 4); `indices` and `data` the kept rows' entry ranges, one after another | `gatheredArray` over entry runs |
 * | CSC `X` / layers / `raw/X` | the stored matrix with `cellRows` set: the reader reads a gene's entries and keeps those of kept cells (`reader/matrices.js`, `_cellsOf`) | a gene's own entries |
 * | `obsp` graphs | as stored; the reader reads the induced subgraph (`graph-lines.js` `inducedGraphLines`, `readInducedGraph`) | the open rows' entry runs, or the whole graph streamed, whichever costs less; open columns renumbered |
 * | each modality | its rows the kept cells measured, its cell map renumbered to them | as the root's |
 * | `var`, `varm`, `varp`, the rest of `uns` | as stored | — |
 *
 * ## Interfaces
 *
 * - `cellSubsetView(root, {nObs, kept, rows, mergeGapBytes, readOptions, indptrs, knownRowPointers, chunks, meter})`
 *   — `kept`: the **file row** of each view row, in view order (a
 *   subsample's priority order, `../subsample-plan.js`; for a priority-ordered
 *   file, rows are not original positions: `../priority-layout.js`); returns
 *   the root a reader opens. A prefix (`kept` = `0 … k−1`) is one run per
 *   array, so every read is a contiguous range. View rows `[0, m)` of any
 *   view are a sample, so a read of them fetches the chunks of the
 *   highest-priority cells first.
 * - `gatheredArray(real, runs, {mergeGapBytes})`, `runsOfPositions(kept)`,
 *   `planBoxes(...)` — the gather of any array by row runs; its
 *   `readInSourceOrder(selection)` reads many view rows in the stored
 *   array's order (`values.js` `readRowsInStoreOrder`).
 * - `keptEntries(pointers, rows)` — a CSR matrix's kept entry runs and row
 *   pointers; `keptValueCount`, `keptChunkShare` — what a subsample's gene
 *   index holds and reads.
 * - an `obsp` graph on the kept cells: `graph-lines.js` (`inducedGraphLines`,
 *   `readInducedGraph`).
 * - `CellRows` — kept rows with their runs and inverse.
 *
 * What a reader opened is `AnnDataReader.cellSubset` (`../subsample-plan.js`,
 * `CellSubsetResolution`): `kept` (ascending original positions), `openOrder`
 * (original position of each open cell, in open order),
 * `prefix` (k when the open cells are file rows `[0, k)`), `fileRows` (the
 * file row of each open cell, what `cellSubsetView` takes as `kept`), `spec`,
 * `autoFit`, `genes` (the gene sample), `cellOrder`.
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
 *    (`mergeGapBytes`; an array read byte by byte — stored in one piece, or
 *    an unfiltered HDF5 chunk — is measured: 23_decisions_partial_reading.md).
 *    The byte reader below batches the boxes of one read into as few
 *    requests as the link prices best.
 * 3. Memory: a read holds its output and at most two slabs (`SLAB_BYTES`)
 *    of decoded boxes at a time (boxes are read in waves in source order,
 *    the next asked for while one is copied), never the full-length array.
 *    `readInSourceOrder` hands the rows out wave by wave instead, each with
 *    the view rows it holds, so a conversion holds no second copy either.
 *    The whole view of an array whose runs were made of rows is read row by
 *    row in the rows' file order (`rowWaves`), in the same waves.
 * 4. Nothing is read when the view is made but the kept cells' entries of
 *    each modality's cell map.
 *    A CSR matrix's row pointers are read when the matrix is first read
 *    (`readRowPointers`, which the reader awaits before it touches the
 *    matrix), and only the kept rows' (`readKeptRowPointers`): a subsample
 *    never reads the pointers of the cells it left out, nor those of a
 *    matrix it does not read (a `raw.X` or a layer next to `X`): the whole
 *    pointers of a large atlas's matrices are most of what a small
 *    subsample's opening would fetch (measured:
 *    23_decisions_partial_reading.md). A read of some of the kept rows only
 *    (a gene sample: the first open cells) reads only theirs
 *    (`readRowPointers` given `rows`) and reads them as a matrix of their
 *    own (`rowsMatrix`), never the whole `indptr`.
 *
 * @module data/anndata/views/cell-subset
 */

import { formatCountOf } from '../../../utils/format-units.js';
import { isArrayNode, isGroup, normalizeSelection, numericDtype } from '../../../formats/store.js';
import { AnnDataFormatError, attributeValue, elementBytes, encodingType } from '../elements.js';
import { SLAB_BYTES } from '../values.js';
import { valueArray, viewGroup } from './view-nodes.js';
import { allocateTypedArray } from '../../sparse-column-index.js';
import { DecodedChunks } from '../decoded-chunks.js';
import { orderByKey, sortUint32 } from '../../../utils/radix-order.js';

/**
 * Told the work a view does of its own over a matrix, as it does it (the
 * reader's `PassRates`, `prefix-column-index.js`): `note(ms)`, the
 * milliseconds of its kept rows' pointers made, or of a gather's copies out
 * of decoded chunks, its reads' waits not counted.
 *
 * @typedef {{note: (ms: number) => void}} ViewMeter
 */

/**
 * Runs of source rows, one after another: run `r` is source rows
 * `[starts[r], ends[r])`, presented at view rows `[offsets[r], offsets[r + 1])`.
 *
 * Positions are whole numbers in a `Float64Array`, or a `Uint32Array` where
 * every one fits (`runsOfPositions`); either is read alike.
 *
 * `byRow`, when the runs were made of rows (`CellRows.runs`), gives those
 * rows in file order and the view row of each (`CellRows.byRow`): what a
 * whole view is read through row by row (`gatheredArray`, `rowWaves`).
 *
 * @typedef {{count: number, starts: Float64Array|Uint32Array, ends: Float64Array|Uint32Array, offsets: Float64Array|Uint32Array, byRow?: () => {order: Uint32Array, rows: CellRows}}} Runs
 */

/**
 * Runs made with a list of positions by whoever made the list, from what it
 * knew of it (`subsample-plan.js` `wholeInOrder`: every cell in a `blocks`
 * order is whole blocks, its runs found a block at a time), so the open
 * cells' rows (`CellRows.runs`) take them instead of walking every position.
 * Keyed by the list itself: a list is never changed once made.
 *
 * @type {WeakMap<Uint32Array, Runs>}
 */
const KNOWN_RUNS = new WeakMap();

/**
 * Give the runs of `kept` (`runsOfPositions`'s, exactly) to the rows made of
 * that list (`CellRows.runs`).
 *
 * @param {Uint32Array} kept
 * @param {Runs} runs
 */
export function noteRunsOf(kept, runs) {
  KNOWN_RUNS.set(kept, runs);
}

/** The maximal runs of consecutive positions of a list (each run ascending by one). */
export function runsOfPositions(kept) {
  let count = 0;
  let highest = -1;
  for (let i = 0; i < kept.length; i++) {
    if (i === 0 || kept[i] !== kept[i - 1] + 1) count++;
    if (kept[i] > highest) highest = kept[i];
  }
  // Rows and positions as 32-bit integers when every end fits one (12 bytes
  // a run, not 24: a 50% uniform share of 5M cells is 2.5M runs).
  const Positions = highest + 1 <= 0xffffffff && kept.length <= 0xffffffff ? Uint32Array : Float64Array;
  const starts = allocateTypedArray(Positions, count, 'Kept row runs');
  const ends = allocateTypedArray(Positions, count, 'Kept row runs');
  const offsets = allocateTypedArray(Positions, count + 1, 'Kept row runs');
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
 * The view position of each kept row, found by its row (`get`, -1 for a row
 * not kept), in whichever of two forms holds fewer bytes:
 *
 * - an open-addressed table of at least twice the kept rows' slots (8 bytes
 *   a slot: 16 to 32 bytes a kept row), for a small share of the file;
 * - an array of every original row (4 bytes a row of the file), once the
 *   kept rows are more than about an eighth of them: every cell of a
 *   50M-cell file is 1.07 GB as a table, 200 MB as an array.
 *
 * Without `nOriginal` (rows of no known axis) it is the table.
 */
export class KeptPositions {
  /**
   * @param {ArrayLike<number>} kept - Distinct original rows, in view order
   * @param {number|null} [nOriginal] - Rows of the axis they are of (every kept row below it)
   */
  constructor(kept, nOriginal = null) {
    let bits = 1;
    while (2 ** bits < 2 * kept.length) bits++;
    if (nOriginal !== null && 4 * nOriginal <= 8 * 2 ** bits) {
      this._rows = null;
      this._positions = allocateTypedArray(Int32Array, nOriginal, 'Kept cell positions').fill(-1);
      for (let i = 0; i < kept.length; i++) this._positions[kept[i]] = i;
      return;
    }
    this._shift = 32 - bits;
    this._mask = 2 ** bits - 1;
    this._rows = allocateTypedArray(Uint32Array, 2 ** bits, 'Kept cell positions').fill(EMPTY_SLOT);
    this._positions = allocateTypedArray(Int32Array, 2 ** bits, 'Kept cell positions');
    for (let i = 0; i < kept.length; i++) {
      let slot = this._slot(kept[i]);
      while (this._rows[slot] !== EMPTY_SLOT) slot = (slot + 1) & this._mask;
      this._rows[slot] = kept[i];
      this._positions[slot] = i;
    }
  }

  /** What the lookup holds, in bytes. */
  get byteLength() {
    return this._positions.byteLength + (this._rows?.byteLength ?? 0);
  }

  /** The array form's table (each original row's position, -1 for a row not kept), or null for the open-addressed one. */
  get table() {
    return this._rows === null ? this._positions : null;
  }

  /** Its arrays. */
  arrays() {
    return this._rows === null ? [this._positions] : [this._positions, this._rows];
  }

  /** @private */
  _slot(row) {
    return Math.imul(row, 0x9e3779b1) >>> this._shift;
  }

  /** The view position of original row `row`, or -1 when it is not kept. */
  get(row) {
    if (this._rows === null) return row < this._positions.length ? this._positions[row] : -1;
    for (let slot = this._slot(row); ; slot = (slot + 1) & this._mask) {
      const at = this._rows[slot];
      if (at === row) return this._positions[slot];
      if (at === EMPTY_SLOT) return -1;
    }
  }
}

/**
 * The view row of each of `cells`' rows by ascending row (`CellRows.byRow`),
 * `rows` those rows ascending: what a radix order of the rows gives, made
 * the cheapest way for the share of the axis they are. Rows already
 * ascending are their own order; rows that are more than an eighth of the
 * axis are looked up in a table of the axis (each row's view row, the
 * array form of `KeptPositions`: the one held when made, else one made for
 * this and let go): one write a row and one read a row in file order,
 * where the radix order makes two counting passes and two scattering ones
 * (measured: 23_decisions_partial_reading.md); fewer rows take
 * the radix order (the table would be mostly empty).
 *
 * @param {CellRows} cells
 * @param {CellRows} rows - `cells.ascending()`
 * @returns {Uint32Array}
 */
function viewRowsByRow(cells, rows) {
  const kept = cells.kept;
  const order = allocateTypedArray(Uint32Array, kept.length, 'Kept rows by row');
  if (rows === cells) {
    for (let i = 0; i < order.length; i++) order[i] = i;
    return order;
  }
  if (8 * kept.length < cells.nOriginal) return orderByKey(kept);
  let table = cells._positions?.table ?? null;
  if (table === null) {
    table = allocateTypedArray(Int32Array, cells.nOriginal, 'Kept cell positions');
    for (let i = 0; i < kept.length; i++) table[kept[i]] = i;
  }
  const ascending = rows.kept;
  for (let j = 0; j < ascending.length; j++) order[j] = table[ascending[j]];
  return order;
}

/** A slot of `KeptPositions` holding no row (no row of an axis reaches 2^32 - 1). */
const EMPTY_SLOT = 0xffffffff;

/**
 * The kept rows of one axis: `kept` (distinct positions of `nOriginal`, in view order),
 * with their runs, the runs in file order, the rows in file order and the
 * inverse map, each made once, when first needed.
 */
export class CellRows {
  /**
   * @param {Uint32Array} kept
   * @param {number} nOriginal
   */
  constructor(kept, nOriginal, { onHeld = null } = {}) {
    this.kept = kept;
    this.nOriginal = nOriginal;
    this._runs = null;
    this._ascending = null;
    this._byRow = null;
    this._positions = null;
    /** Told what these rows hold whenever a lookup is made (the reader counts an open subset's). */
    this._onHeld = onHeld;
    onHeld?.(this.byteLength, this);
  }

  get count() { return this.kept.length; }

  /** The buffers of the kept rows and every lookup made of them (`byteLength`'s). */
  buffers() {
    const held = new Set([this.kept.buffer]);
    if (this._runs !== null) for (const array of [this._runs.starts, this._runs.ends, this._runs.offsets]) held.add(array.buffer);
    if (this._ascending !== null && this._ascending !== this) for (const buffer of this._ascending.buffers()) held.add(buffer);
    if (this._byRow !== null) held.add(this._byRow.order.buffer);
    if (this._positions !== null) for (const array of this._positions.arrays()) held.add(array.buffer);
    return held;
  }

  /** What the kept rows and every lookup made of them hold, in bytes. */
  get byteLength() {
    const runs = this._runs === null ? 0 : this._runs.starts.byteLength + this._runs.ends.byteLength + this._runs.offsets.byteLength;
    const ascending = this._ascending === null || this._ascending === this ? 0 : this._ascending.byteLength;
    return this.kept.byteLength + runs + ascending + (this._byRow?.order.byteLength ?? 0) + (this._positions?.byteLength ?? 0);
  }

  /** @returns {Runs} */
  runs() {
    if (this._runs === null) {
      const known = KNOWN_RUNS.get(this.kept);
      KNOWN_RUNS.delete(this.kept);
      this._runs = { ...(known ?? runsOfPositions(this.kept)), byRow: () => this.byRow() };
      this._onHeld?.(this.byteLength, this);
    }
    return this._runs;
  }

  /**
   * The kept rows ascending (`CellRows`; these rows when they ascend
   * already), made once: what their pointers are read for
   * (`readKeptRowPointers`), what counts their stored values and the chunks
   * those lie in (`keptValueCount`, `keptChunkShare`), and the rows of a
   * pass in store order (`byRow`). Each walks them forward, in sequence.
   */
  ascending() {
    if (this._ascending === null) {
      const kept = this.kept;
      let ascends = true;
      for (let i = 1; ascends && i < kept.length; i++) ascends = kept[i] > kept[i - 1];
      // Every row of the axis (distinct, as kept rows are) in another order
      // (every cell opened in a `blocks` order): ascending they are 0 … n − 1.
      this._ascending = ascends ? this : new CellRows(kept.length === this.nOriginal ? everyRow(kept.length) : ascendingRows(kept), this.nOriginal);
      this._onHeld?.(this.byteLength, this);
    }
    return this._ascending;
  }

  /**
   * The kept rows in file order: `order`, the view row of each by ascending
   * file row (a radix order of the rows), and `rows`, those rows
   * (`ascending`): what a pass over the rows in store order reads
   * (`AnnDataReader._storeOrderMatrix`). Made once.
   *
   * @returns {{order: Uint32Array, rows: CellRows}}
   */
  byRow() {
    if (this._byRow === null) {
      const rows = this.ascending();
      this._byRow = { order: viewRowsByRow(this, rows), rows };
      this._onHeld?.(this.byteLength, this);
    }
    return this._byRow;
  }

  /** Each kept row's position (`KeptPositions`, in its smaller form for this share of the axis). */
  positions() {
    if (this._positions === null) {
      this._positions = new KeptPositions(this.kept, this.nOriginal);
      this._onHeld?.(this.byteLength, this);
    }
    return this._positions;
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
    /** The first range of each bucket of rows (`_buckets`), made at the first lookup. @private */
    this._buckets = null;
    this._shift = 0;
    /**
     * The rows they were read for (`readKeptRowPointers`), held weakly (these
     * pointers may outlive them: a store opened again with other cells); else null.
     * @type {WeakRef<CellRows>|null}
     */
    this.forRows = null;
    /** Where each run of `forRows` starts in `values` (`runIndexFor`), once made. @type {Uint32Array|null} */
    this.runIndex = null;
  }

  /**
   * Where each run of `rows` (the rows these pointers were read for,
   * `forRows`) has its first pointer in `values`: looked up a run at a time
   * (`indexOf`) at the first read of those rows' entries in their own order
   * (`keptEntries`), then kept, so no later read looks one up (fewer than
   * 2^32 pointers). Null for any other rows. Not made when the pointers are
   * read: a pass over the rows in store order (`CellRows` `byRow`) and the
   * counts of their values walk the ranges forward and need none.
   *
   * @param {CellRows} rows
   * @returns {Uint32Array|null}
   */
  runIndexFor(rows) {
    if (this.forRows?.deref() !== rows) return null;
    if (this.runIndex === null) {
      const runs = rows.runs();
      const index = allocateTypedArray(Uint32Array, runs.count, 'Kept row runs');
      for (let r = 0; r < runs.count; r++) index[r] = this.indexOf(runs.starts[r]);
      this.runIndex = index;
    }
    return this.runIndex;
  }

  /**
   * The bucket of `2^shift` rows `row` is in, in a table of the first range
   * ending past each bucket's first row (about one range a bucket, 4 bytes
   * a range): a lookup then searches the few ranges of its bucket, not all
   * of them. A binary search over millions of ranges (a uniform subsample's)
   * misses the cache at nearly every step (measured:
   * 24_decisions_graph_edges_at_scale.md). @private
   */
  _bucketOf(row) {
    const n = this.starts.length;
    if (this._buckets === null) {
      const top = this.ends[n - 1];
      let shift = 0;
      while (top / 2 ** shift > n) shift++;
      const count = Math.floor((top - 1) / 2 ** shift) + 2;
      const buckets = allocateTypedArray(Uint32Array, count, 'Kept row pointer buckets');
      let range = 0;
      for (let b = 0; b < count; b++) {
        const first = b * 2 ** shift;
        while (range < n && this.ends[range] <= first) range++;
        buckets[b] = range;
      }
      this._buckets = buckets;
      this._shift = shift;
    }
    return Math.min(Math.floor(row / 2 ** this._shift), this._buckets.length - 1);
  }

  /** Where row `row`'s pointer is in `values`. */
  indexOf(row) {
    const n = this.starts.length;
    let lo = 0;
    let hi = n;
    if (n > 64) {
      // The range holding `row` is the first one ending past it, at or after
      // its bucket's first and no later than the next bucket's first.
      const b = this._bucketOf(row);
      lo = this._buckets[b];
      hi = b + 1 < this._buckets.length ? Math.min(n, this._buckets[b + 1] + 1) : n;
    }
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ends[mid] <= row) lo = mid + 1;
      else hi = mid;
    }
    if (lo === n || this.starts[lo] > row) {
      throw new RangeError(`Row pointer ${row} was not read with the kept rows`);
    }
    return this.offsets[lo] + row - this.starts[lo];
  }

  at(row) {
    return this.values[this.indexOf(row)];
  }

  /**
   * `indexOf` for rows asked in ascending order (each at least the one
   * before): a walk forward over the ranges, no search a row (rows in store
   * order: a share's millions of runs searched one by one would hold up
   * its first gene).
   */
  walker() {
    let range = 0;
    const n = this.starts.length;
    return row => {
      while (range < n && this.ends[range] <= row) range++;
      if (range === n || this.starts[range] > row) {
        throw new RangeError(`Row pointer ${row} was not read with the kept rows`);
      }
      return this.offsets[range] + row - this.starts[range];
    };
  }
}

/**
 * Pointers between two ranges of kept rows' pointers up to which the two
 * are read and held as one (`readKeptRowPointers`): a range of its own holds
 * three numbers (its start, end and offset), as many as three pointers. A
 * 50% uniform share's pointer ranges, a row or two apart, are then a few
 * ranges, not millions, each a fragment of the read.
 */
const POINTER_GAP_MERGED = 3;

/**
 * The row pointers of the kept rows of a CSR matrix (`indptr[start..end]`
 * of every kept run), read through the stored `indptr`'s chunks that hold
 * them and no other: what knowing the kept rows' entry ranges costs. Ranges
 * `known` holds already (the same store opened before with other cells:
 * lowering a subsample, or raising it) are taken from it, not read again.
 *
 * @param {Object} indptr - The stored `indptr` array node
 * @param {CellRows} rows
 * @param {{mergeGapBytes: () => number, readOptions?: Object, known?: RowPointers|Float64Array|null, chunks?: Object|null, meter?: ViewMeter|null}} options -
 *   `chunks`: the store's decoded chunks (`decoded-chunks.js`): the pointer chunks a raise's added
 *   rows share with the rows open before are decoded once; `meter`: told the milliseconds of its own work
 * @returns {Promise<RowPointers>}
 */
export async function readKeptRowPointers(indptr, rows, { mergeGapBytes, readOptions = {}, known = null, chunks = null, meter = null }) {
  let started = performance.now();
  let spent = 0;
  /** A read of the stored pointers, its wait not counted as the work's. */
  const awaited = async promise => {
    spent += performance.now() - started;
    try {
      return await promise;
    } finally {
      started = performance.now();
    }
  };
  // The kept rows' runs in file order (`ascending`), walked forward: each
  // run's pointers, the pointer after its last row included, a range.
  const runs = rows.ascending().runs();
  let starts = allocateTypedArray(Float64Array, runs.count, 'Kept row pointers');
  let ends = allocateTypedArray(Float64Array, runs.count, 'Kept row pointers');
  let count = 0;
  for (let r = 0; r < runs.count; r++) {
    const start = runs.starts[r];
    const end = runs.ends[r] + 1;
    // Ranges a few pointers apart are one (`POINTER_GAP_MERGED`): the
    // pointers between hold no more than a range of their own would, and
    // lie in chunks read anyway.
    if (count > 0 && start <= ends[count - 1] + POINTER_GAP_MERGED) ends[count - 1] = end;
    else {
      starts[count] = start;
      ends[count] = end;
      count++;
    }
  }
  // Held as long as the pointers are: exactly as long as the ranges (a memory copy).
  if (count < runs.count) {
    starts = starts.slice(0, count);
    ends = ends.slice(0, count);
  }
  const offsets = allocateTypedArray(Float64Array, count + 1, 'Kept row pointers');
  for (let i = 0; i < count; i++) offsets[i + 1] = offsets[i] + ends[i] - starts[i];
  const values = allocateTypedArray(Float64Array, offsets[count], 'Kept row pointers');
  // The pointers `known` holds are copied from it, the rest read: piece by
  // piece, so a range only part of which is known (ranges merged across a
  // gap, rows added beside rows open before) reads only what it lacks.
  if (known === null) {
    // Nothing known: the ranges themselves are what is read, into `values` as laid out.
    const read = await awaited(gatheredArray(indptr, { count, starts, ends, offsets }, { mergeGapBytes, chunks, meter }).read(undefined, readOptions));
    if (read instanceof BigInt64Array || read instanceof BigUint64Array) for (let j = 0; j < read.length; j++) values[j] = Number(read[j]);
    else values.set(read);
  } else {
    // Known ranges: a `RowPointers`' own, or a stored `indptr` (whole, or a prefix) as one.
    const knownRanges = known instanceof RowPointers ? known.starts.length : 1;
    const knownStart = k => (known instanceof RowPointers ? known.starts[k] : 0);
    const knownEnd = k => (known instanceof RowPointers ? known.ends[k] : known.length);
    const knownAt = (k, row) => (known instanceof RowPointers ? known.offsets[k] + row - known.starts[k] : row);
    const knownValues = known instanceof RowPointers ? known.values : known;
    // Missing pieces: at most one before each known range and one after the last, a range.
    const capacity = count + knownRanges;
    const pieceStarts = allocateTypedArray(Float64Array, capacity, 'Kept row pointers');
    const pieceEnds = allocateTypedArray(Float64Array, capacity, 'Kept row pointers');
    const pieceOffsets = allocateTypedArray(Float64Array, capacity + 1, 'Kept row pointers');
    const pieceTargets = allocateTypedArray(Float64Array, capacity, 'Kept row pointers');
    let pieces = 0;
    // The first known range ending past `row` (known ranges ascend and are disjoint).
    let k = 0;
    for (let i = 0; i < count; i++) {
      const end = ends[i];
      let row = starts[i];
      if (k < knownRanges && knownEnd(k) <= row) {
        let lo = k;
        let hi = knownRanges;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (knownEnd(mid) <= row) lo = mid + 1;
          else hi = mid;
        }
        k = lo;
      }
      while (row < end) {
        if (k < knownRanges && knownStart(k) <= row) {
          const stop = Math.min(end, knownEnd(k));
          const from = knownAt(k, row);
          if (known instanceof RowPointers || ArrayBuffer.isView(known)) values.set(knownValues.subarray(from, from + stop - row), offsets[i] + row - starts[i]);
          else for (let at = row; at < stop; at++) values[offsets[i] + at - starts[i]] = known.at(at);
          row = stop;
          if (stop === knownEnd(k)) k++;
        } else {
          const stop = k < knownRanges ? Math.min(end, knownStart(k)) : end;
          pieceStarts[pieces] = row;
          pieceEnds[pieces] = stop;
          pieceTargets[pieces] = offsets[i] + row - starts[i];
          pieceOffsets[pieces + 1] = pieceOffsets[pieces] + stop - row;
          pieces++;
          row = stop;
        }
      }
    }
    if (pieces > 0) {
      const pieceRuns = { count: pieces, starts: pieceStarts.subarray(0, pieces), ends: pieceEnds.subarray(0, pieces), offsets: pieceOffsets.subarray(0, pieces + 1) };
      const read = await awaited(gatheredArray(indptr, pieceRuns, { mergeGapBytes, chunks, meter }).read(undefined, readOptions));
      for (let m = 0; m < pieces; m++) {
        const from = pieceOffsets[m];
        const target = pieceTargets[m];
        for (let j = 0; j < pieceEnds[m] - pieceStarts[m]; j++) values[target + j] = Number(read[from + j]);
      }
    }
  }
  // Each range non-negative and not decreasing: one pass over the values,
  // a decrease (or a value that is no number) allowed only where a range
  // starts, at a non-negative value.
  const invalid = () => new Error(`${indptr.path}: row pointers must be non-negative and must not decrease`);
  if (values.length > 0 && !(values[0] >= 0)) throw invalid();
  for (let i = 1, range = 1; i < values.length; i++) {
    const value = values[i];
    if (value >= values[i - 1]) continue;
    while (range < count && offsets[range] < i) range++;
    if (!(range < count && offsets[range] === i && value >= 0)) throw invalid();
  }
  const pointers = new RowPointers(starts, ends, offsets.subarray(0, count), values);
  pointers.forRows = new WeakRef(rows);
  meter?.note(spent + performance.now() - started);
  return pointers;
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
 * `boxed` false: the pieces and their order alone (`boxes` null), for a
 * read through whole decoded chunks, which reads no boxes; `pieces` false:
 * the boxes alone (the pieces and order null when the pieces lie in source
 * order: one pass, nothing listed), for what a read would cost.
 * `rowBytes` is a row of what is read (the columns asked for: a box holds at
 * most `spanBytes` of them); `storedRowBytes` a stored row, every column:
 * what a gap between two pieces costs when one box spans it, since the rows
 * between are read whole wherever their columns lie closer than a request
 * (a latent's two columns of thirty read thirty columns' bytes across it).
 */
export function planBoxes(runs, a, b, { chunkRows, rowBytes, storedRowBytes = rowBytes, mergeGapBytes, spanBytes = SLAB_BYTES, boxed = true, pieces: listed = true }) {
  // The runs the view rows lie in, each a piece (the first and last cut to `[a, b)`).
  const first = runAt(runs, a);
  let last = first;
  while (last < runs.count && runs.offsets[last] < b) last++;
  const count = last - first;
  const maxRows = Math.max(1, Math.floor(spanBytes / Math.max(1, rowBytes)));
  // The boxes alone (`pieces` false: what a read would cost), over pieces in
  // source order already: one pass over the runs, no piece listed.
  if (!listed && boxed) {
    const boxes = boxesInSourceOrder(runs, first, last, a, b, { chunkRows, storedRowBytes, mergeGapBytes, maxRows });
    if (boxes !== null) return { boxes, order: null, pieceStarts: null, pieceEnds: null, pieceAt: null };
  }
  const pieceStarts = allocateTypedArray(Float64Array, count, 'Kept row pieces');
  const pieceEnds = allocateTypedArray(Float64Array, count, 'Kept row pieces');
  const pieceAt = allocateTypedArray(Float64Array, count, 'Kept row pieces');
  let ascending = true;
  for (let p = 0; p < count; p++) {
    const r = first + p;
    const from = Math.max(a, runs.offsets[r]);
    const to = Math.min(b, runs.offsets[r + 1]);
    pieceStarts[p] = runs.starts[r] + from - runs.offsets[r];
    pieceEnds[p] = runs.starts[r] + to - runs.offsets[r];
    pieceAt[p] = from - a;
    if (p > 0 && pieceStarts[p] < pieceEnds[p - 1]) ascending = false;
  }
  const order = ascending ? identityOrder(count) : runsBySource(runs, first, last);
  // A read through whole decoded chunks has no boxes (`waves`).
  if (!boxed) return { boxes: null, order, pieceStarts, pieceEnds, pieceAt };
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

/**
 * `planBoxes`' boxes of runs `[first, last)` cut to view rows `[a, b)`, made
 * as the runs are walked, when their pieces lie in source order (each piece
 * starting at or after the one before ends); null when they do not (the
 * caller then sorts them). The same boxes, by the same joining rule.
 */
function boxesInSourceOrder(runs, first, last, a, b, { chunkRows, storedRowBytes, mergeGapBytes, maxRows }) {
  const boxes = [];
  let box = null;
  let previousEnd = -Infinity;
  for (let r = first; r < last; r++) {
    const offset = runs.offsets[r];
    const from = a > offset ? a : offset;
    const next = runs.offsets[r + 1];
    const to = b < next ? b : next;
    const start = runs.starts[r] + from - offset;
    const end = runs.starts[r] + to - offset;
    if (start < previousEnd) return null;
    previousEnd = end;
    let joins = false;
    if (box !== null && end - box.start <= maxRows) {
      joins = chunkRows === null
        ? (start - box.end) * storedRowBytes <= mergeGapBytes
        : Math.floor(start / chunkRows) <= Math.floor((box.end - 1) / chunkRows) + 1;
    }
    if (joins) {
      box.end = end;
      box.to = r - first + 1;
    } else {
      box = { start, end, from: r - first, to: r - first + 1 };
      boxes.push(box);
    }
  }
  return boxes;
}

/** `0 … count − 1`. */
function identityOrder(count) {
  const order = allocateTypedArray(Uint32Array, count, 'Kept row order');
  for (let i = 0; i < count; i++) order[i] = i;
  return order;
}

/** Each view's runs in source order, once (`runsBySource`). */
const sourceOrders = new WeakMap();

/**
 * Runs `[first, last)` of `runs` in ascending source order, as positions from
 * `first`. Runs hold disjoint source rows, so their starts are distinct but
 * for empty runs beside others (`rankedOrder` compares those): they
 * are sorted as numbers (the engine's own sort of a typed array) and each
 * run placed at its start's rank, where a comparator sort of a subsample's
 * million single-row runs is slower than opening every cell (measured:
 * 23_decisions_partial_reading.md). Every run of a view is ordered once and
 * kept; a read of a quarter of them or more takes its runs from that order,
 * a smaller one orders its own.
 */
function runsBySource(runs, first, last) {
  const count = last - first;
  if (4 * count >= runs.count) {
    let all = sourceOrders.get(runs);
    if (all === undefined) {
      all = rankedOrder(runs.starts, 0, runs.count);
      sourceOrders.set(runs, all);
    }
    if (count === runs.count) return all;
    const order = allocateTypedArray(Uint32Array, count, 'Kept row order');
    let at = 0;
    for (let i = 0; i < all.length; i++) if (all[i] >= first && all[i] < last) order[at++] = all[i] - first;
    return order;
  }
  const order = rankedOrder(runs.starts, first, last);
  for (let i = 0; i < count; i++) order[i] -= first;
  return order;
}

/**
 * Positions `[from, to)` of numbers `starts` (whole rows, at least 0),
 * ascending by their value (equal ones in position order): a stable radix
 * order of their 32-bit words (`orderByKey`, the high words, when any is
 * used, ordered stably after the low ones), linear in the runs. A sort of
 * the values with a binary search placing each run is slower than every
 * cell's whole first view (measured: 23_decisions_partial_reading.md).
 */
function rankedOrder(starts, from, to) {
  const count = to - from;
  // Runs already in source order (rows read in the stored order: an induced
  // subgraph's open rows, `graph-lines.js`) are their own order.
  let ascending = true;
  for (let i = from + 1; ascending && i < to; i++) ascending = starts[i] > starts[i - 1];
  if (ascending) {
    const order = allocateTypedArray(Uint32Array, count, 'Kept row order');
    for (let r = from; r < to; r++) order[r - from] = r;
    return order;
  }
  const words = allocateTypedArray(Uint32Array, count, 'Kept row order');
  let high = false;
  for (let i = 0; i < count; i++) {
    const value = starts[from + i];
    words[i] = value % 4294967296;
    if (value >= 4294967296) high = true;
  }
  let order = orderByKey(words);
  if (high) {
    for (let k = 0; k < count; k++) words[k] = Math.floor(starts[from + order[k]] / 4294967296);
    const byHigh = orderByKey(words);
    const low = order;
    order = allocateTypedArray(Uint32Array, count, 'Kept row order');
    for (let k = 0; k < count; k++) order[k] = low[byHigh[k]];
  }
  for (let k = 0; k < count; k++) order[k] += from;
  return order;
}

/** Bytes a row of `real` holds in `tail` (a string counts as a pointer's worth). */
function rowBytesOf(real, width) {
  const bytes = elementBytes(real);
  return width * (Number.isFinite(bytes) && bytes > 0 ? bytes : 8);
}

/**
 * Values above which a copy of rows goes through a view (`copyRows`): below,
 * a loop is faster (measured: 23_decisions_partial_reading.md).
 */
const COPY_BY_VIEW_VALUES = 32;

/** Copy rows `[from, from + rows)` of `source` (width `width`) into `out` at row `at`. */
function copyRows(source, from, rows, out, at, width) {
  // A few values (a uniform subsample's single rows) copied one by one: a
  // view and a copy each cost more than the values.
  const count = rows * width;
  if (ArrayBuffer.isView(out) && count > COPY_BY_VIEW_VALUES) {
    out.set(source.subarray(from * width, from * width + count), at * width);
    return;
  }
  const to = at * width;
  const of = from * width;
  for (let i = 0; i < count; i++) out[to + i] = source[of + i];
}

/** Each set of rows' chunks, by chunk rows (`chunksOfRows`), for as long as the rows are held. */
const ROW_CHUNKS = new WeakMap();

/**
 * The stored chunks of `chunkRows` rows that `rows` (ascending `CellRows`)
 * lie in, ascending (`chunkOf`), and the position of the first row in each
 * (`firstAt`, one more: the rows' count): a pass over the rows, made once
 * for every column of that chunking read row by row (`rowWaves`), not once
 * a column (measured: 23_decisions_partial_reading.md).
 */
function chunksOfRows(rows, chunkRows) {
  let byChunking = ROW_CHUNKS.get(rows);
  if (byChunking === undefined) ROW_CHUNKS.set(rows, (byChunking = new Map()));
  let found = byChunking.get(chunkRows);
  if (found === undefined) {
    const fileRows = rows.kept;
    const chunkOf = [];
    const firstAt = [];
    for (let k = 0; k < fileRows.length; k++) {
      const chunk = Math.floor(fileRows[k] / chunkRows);
      if (chunkOf.length === 0 || chunkOf[chunkOf.length - 1] !== chunk) {
        chunkOf.push(chunk);
        firstAt.push(k);
      }
    }
    firstAt.push(fileRows.length);
    found = Object.freeze({ chunkOf: Uint32Array.from(chunkOf), firstAt: Float64Array.from(firstAt) });
    byChunking.set(chunkRows, found);
  }
  return found;
}

/**
 * The rows of a wave (`rowWaves`: positions `[from, to)` of the rows in
 * file order, out of blocks `read[u]` of stored rows `units[u]`) copied to
 * their view rows of `out` (`order`: the view row of each position): one
 * copy a row, its rows and their view rows read in sequence.
 */
function placeRows({ read, units, from, to }, { order, rows }, width, out) {
  const fileRows = rows.kept;
  let u = 0;
  let unitEnd = units[0].end;
  let unitStart = units[0].start;
  let block = read[0];
  if (width === 1) {
    for (let k = from; k < to; k++) {
      const row = fileRows[k];
      while (row >= unitEnd) {
        u++;
        unitEnd = units[u].end;
        unitStart = units[u].start;
        block = read[u];
      }
      out[order[k]] = block[row - unitStart];
    }
    return;
  }
  for (let k = from; k < to; k++) {
    const row = fileRows[k];
    while (row >= unitEnd) {
      u++;
      unitEnd = units[u].end;
      unitStart = units[u].start;
      block = read[u];
    }
    const source = (row - unitStart) * width;
    const target = order[k] * width;
    // A 2-D embedding's two values as two copies, not a loop a row (a third
    // of a large share's placement: measured, 23_decisions_partial_reading.md).
    if (width === 2) {
      out[target] = block[source];
      out[target + 1] = block[source + 1];
    } else for (let i = 0; i < width; i++) out[target + i] = block[source + i];
  }
}

/**
 * `outer` (runs of the rows of a gathered array, `inner`) as runs of the
 * rows `inner` gathers them from: each outer run cut where it crosses from
 * one inner run to the next, pieces that meet in the source joined. As many
 * runs as the two together touch, never more.
 *
 * @param {Runs} inner
 * @param {Runs} outer
 * @returns {Runs}
 */
export function composedRuns(inner, outer) {
  const innerLength = inner.offsets[inner.count];
  const starts = [];
  const ends = [];
  for (let r = 0; r < outer.count; r++) {
    let from = outer.starts[r];
    const to = from + outer.offsets[r + 1] - outer.offsets[r];
    if (!(from >= 0 && to <= innerLength)) {
      throw new RangeError(`Rows ${from} to ${to} lie outside a gathered array of ${formatCountOf(innerLength, 'row')}`);
    }
    for (let i = runAt(inner, from); from < to; i++) {
      const stop = Math.min(to, inner.offsets[i + 1]);
      const start = inner.starts[i] + from - inner.offsets[i];
      const end = start + stop - from;
      if (ends.length > 0 && ends[ends.length - 1] === start) ends[ends.length - 1] = end;
      else {
        starts.push(start);
        ends.push(end);
      }
      from = stop;
    }
  }
  const offsets = allocateTypedArray(Float64Array, starts.length + 1, 'Gathered row runs');
  for (let r = 0; r < starts.length; r++) offsets[r + 1] = offsets[r] + ends[r] - starts[r];
  return { count: starts.length, starts: Float64Array.from(starts), ends: Float64Array.from(ends), offsets };
}

/**
 * An array presented as the rows `runs` names of `real`'s first dimension,
 * one run after another (invariants 1–3 of this module).
 *
 * A gather of a gathered array (a segment of a subsample's matrix, rows of
 * a view of a view) is one gather of the stored array: its runs are composed
 * (`composedRuns`) and read through the stored chunks, with the inner
 * gather's link and decoded chunks (it is the one that reads the store). Its
 * own `chunks` are an estimate of kept rows per stored chunk, never a unit
 * of decoding: read through them, each of a slab's thousands of estimated
 * chunks would be a read of its own, all at once (gigabytes of reads in
 * flight for a few MB of entries: measured, 23_decisions_partial_reading.md).
 *
 * @param {Object} real - An array node
 * @param {Runs} runs
 * @param {{path?: string, mergeGapBytes: () => number, chunks?: DecodedChunks|null, meter?: ViewMeter|null}} options -
 *   `chunks`: the store's decoded chunks (`decoded-chunks.js`) the reads go through;
 *   `meter`: told the milliseconds of the gather's own work
 * @returns {Object}
 */
export function gatheredArray(real, runs, { path = real.path, mergeGapBytes, chunks = null, meter = null }) {
  if (real.gather !== undefined) {
    const inner = real.gather;
    return gatheredArray(inner.source, composedRuns(inner.runs, runs), { path, mergeGapBytes: inner.mergeGapBytes, chunks: inner.chunks, meter: meter ?? inner.meter });
  }
  const length = runs.offsets[runs.count];
  const shape = [length, ...real.shape.slice(1)];
  // A chunked array is decoded a chunk at a time; one stored in one piece,
  // or an unfiltered HDF5 one (`partialChunks`), is read byte by byte.
  const sourceChunkRows = Array.isArray(real.chunks) && real.chunks.length > 0 && real.partialChunks !== true
    ? real.chunks[0]
    : null;
  const storedRowBytes = rowBytesOf(real, real.shape.slice(1).reduce((product, extent) => product * extent, 1));
  // A column of variable-length elements (strings) reads its kept rows
  // alone (`readRows`): what they need of its storage, those rows decoded.
  const byRows = typeof real.readRows === 'function' && real.shape.length === 1;
  const plan = (pairs, gap, boxed = true, pieces = true) => {
    let width = 1;
    for (const [start, stop] of pairs.slice(1)) width *= stop - start;
    const rowBytes = rowBytesOf(real, width);
    return { width, ...planBoxes(runs, pairs[0][0], pairs[0][1], { chunkRows: sourceChunkRows, rowBytes, storedRowBytes, mergeGapBytes: gap, boxed, pieces }) };
  };
  /**
   * Stored chunk `unit` (`{chunk, start, end}`) of the columns `tail` names,
   * through `kept`: a chunk another read is decoding is shared, and stops
   * only once every read waiting for it withdrew (`decoded-chunks.js`).
   */
  const readChunk = (unit, tail, options, kept) => kept.get(`${real.path}|${JSON.stringify(tail)}|${unit.chunk}`, decodeOptions => real.read([[unit.start, unit.end], ...tail], decodeOptions), options);
  /**
   * Every view row of the columns `pairs` names, in waves over the stored
   * chunks in ascending order, row by row in the view's rows' own file order
   * (`runs.byRow`: the rows ascending and the view row of each, a radix
   * order made once per set of rows), when the whole view of an array
   * decoded a chunk at a time and read by values is asked for, and its runs
   * were made of rows (`CellRows.runs`); else null (the pass over pieces,
   * `waves`). The chunks are the pass's (those the rows lie in, each once),
   * consecutive ones read as one range as every cell's slabs are, a wave at
   * most a slab of decoded rows, the next asked for while one is handed
   * out; each row is one copy to its place, with none of the pass's pieces
   * listed, ordered or walked through a permutation (millions of single-row
   * pieces placed through three permuted arrays a row make a uniform share's
   * first view several times slower than every cell's, the same bytes:
   * measured, 23_decisions_partial_reading.md). Each wave is
   * `{read, units, from, to}`: blocks `read[u]` of stored rows
   * `[units[u].start, units[u].end)`, holding the rows of positions
   * `[from, to)` of the rows ascending.
   */
  async function* rowWaves(pairs, options) {
    const [a, b] = pairs[0];
    if (!readsRowByRow(a, b)) return;
    const tail = pairs.slice(1);
    let width = 1;
    for (const [start, stop] of tail) width *= stop - start;
    const { chunkOf, firstAt } = chunksOfRows(runs.byRow().rows, sourceChunkRows);
    const perWave = Math.max(1, Math.floor(SLAB_BYTES / Math.max(1, sourceChunkRows * rowBytesOf(real, width))));
    const ask = first => {
      if (first >= chunkOf.length) return null;
      const last = Math.min(chunkOf.length, first + perWave);
      // Consecutive chunks read as one range, as every cell's slabs are
      // (one read of the store a stretch, not one a chunk).
      const units = [];
      for (let u = first; u < last; u++) {
        const start = chunkOf[u] * sourceChunkRows;
        const end = Math.min(real.shape[0], (chunkOf[u] + 1) * sourceChunkRows);
        if (units.length > 0 && units[units.length - 1].end === start) units[units.length - 1].end = end;
        else units.push({ start, end });
      }
      const promise = Promise.all(units.map(unit => real.read([[unit.start, unit.end], ...tail], options).then(block => {
        if (block === null || block === undefined || block.length !== (unit.end - unit.start) * width) {
          throw new Error(`${real.path}: rows ${unit.start} to ${unit.end} did not read as ${formatCountOf(unit.end - unit.start, 'row')}`);
        }
        return block;
      })));
      promise.catch(() => {});
      return { units, promise, from: firstAt[first], to: firstAt[last], next: last };
    };
    let next = ask(0);
    while (next !== null) {
      const current = next;
      next = ask(current.next);
      yield { read: await current.promise, units: current.units, from: current.from, to: current.to };
    }
  }
  /**
   * Whether view rows `[a, b)` are read row by row (`rowWaves`): the whole
   * view of an array decoded a chunk at a time and read by values, made of
   * rows (`runs.byRow`), whose runs are mostly single rows (fewer than two
   * rows a run). The pass over pieces does a few operations a piece and
   * copies a run whole, the rows path one a row (and orders every row once):
   * every cell opened in a `blocks` order is a few hundred runs of 65,536
   * rows, which the rows path would take as every one of its millions of
   * rows (measured: 23_decisions_partial_reading.md).
   */
  const readsRowByRow = (a, b) => a === 0 && b === length && typeof runs.byRow === 'function'
    && sourceChunkRows !== null && !byRows && 2 * runs.count > length;
  /** The stored chunks a whole view's rows lie in, as runs of consecutive chunks (`rowWaves`), or null. */
  const rowChunkRuns = pairs => {
    const [a, b] = pairs[0];
    if (!readsRowByRow(a, b)) return null;
    const { chunkOf } = chunksOfRows(runs.byRow().rows, sourceChunkRows);
    const spans = [];
    for (const chunk of chunkOf) {
      if (spans.length > 0 && spans[spans.length - 1][1] === chunk - 1) spans[spans.length - 1][1] = chunk;
      else spans.push([chunk, chunk]);
    }
    return spans.map(([first, last]) => [first * sourceChunkRows, Math.min(real.shape[0], (last + 1) * sourceChunkRows)]);
  };
  /**
   * The rows of view rows `[a, b)` (`pairs`) in waves, in source order: each
   * wave at most a slab (`SLAB_BYTES`) of decoded source rows, its reads
   * asked for in one task so the byte reader plans them together, the next
   * wave asked for before this one is handed out. A wave is
   * `{fragments, rows, each(visit), copyInto(out, width)}`: `each` calls
   * `visit(block, from, rows, at)` for each of its `fragments`, in source
   * order -- rows `[from, from + rows)` of `block` are view rows `[at, at +
   * rows)` (from `a`) -- and `rows` is theirs together (counted only when
   * `counted`: a read placing rows by view row needs neither); `copyInto`
   * copies each fragment to its view rows of `out` (from `a`) in one walk.
   * (Fragments are walked, never listed: a uniform subsample's are single
   * rows, millions to a wave.) `first()`: what the wave read first, the
   * kind of array its values come in.
   *
   * An array decoded a chunk at a time is read through whole decoded chunks:
   * each chunk the pieces touch is taken from `kept` (the store's decoded
   * chunks, `decoded-chunks.js`, so a growth's later step, or a column read
   * again, copies its rows out of chunks decoded before; a view made without
   * them reads through a set of each read's own) or decoded once. Any other
   * is read in boxes (`planBoxes`), a box longer than a slab in slabs. A
   * column of variable-length elements reads each wave's rows with one
   * `readRows` (`byRows`): the store reads what they need (an HDF5 column's
   * references, then the heap objects of those rows alone; a Zarr column's
   * chunks, those rows' items alone decoded) and hands back their values, so
   * a share of a string column decodes and holds its share of the strings,
   * not every string of every chunk it touches. What a store decodes whole
   * per chunk and keeps (a Zarr chunk's items as stored) is kept in `kept`
   * as any chunk is, at what it holds.
   *
   * Source order is what keeps a read of many view rows at the requests of
   * the stored array: a subsample's view rows, and every cell of a file
   * opened in a subsample's order (`subsample-plan.js`, `cellOrder`), are in
   * priority order, so a stretch of them lies all over the file, and read
   * stretch by stretch each stretch's chunks lie apart (measured:
   * 23_decisions_partial_reading.md).
   */
  async function* waves(pairs, options, kept, { counted = true } = {}) {
    const tail = pairs.slice(1);
    const chunked = sourceChunkRows !== null;
    // Read through whole decoded chunks, the pieces need no boxes.
    const { width, boxes, order, pieceStarts, pieceEnds, pieceAt } = plan(pairs, chunked ? 0 : mergeGapBytes(), !chunked);
    const rowBytes = rowBytesOf(real, width);
    const check = (block, start, end) => {
      if (block === null || block === undefined || block.length !== (end - start) * width) {
        throw new Error(`${real.path}: rows ${start} to ${end} did not read as ${formatCountOf(end - start, 'row')}`);
      }
      return block;
    };
    // Units of reading, ascending: `[start, end)` source rows each.
    const units = [];
    if (chunked) {
      // The chunks the pieces touch (the pieces are in source order through `order`).
      for (let o = 0; o < order.length; o++) {
        const p = order[o];
        const first = Math.floor(pieceStarts[p] / sourceChunkRows);
        const last = Math.floor((pieceEnds[p] - 1) / sourceChunkRows);
        const after = units.length > 0 ? units[units.length - 1].chunk + 1 : first;
        for (let c = Math.max(first, after); c <= last; c++) {
          units.push({ chunk: c, start: c * sourceChunkRows, end: Math.min(real.shape[0], (c + 1) * sourceChunkRows) });
        }
      }
    } else {
      // A box holding one piece longer than a slab is read a slab at a time.
      const maxRows = Math.max(1, Math.floor(SLAB_BYTES / Math.max(1, rowBytes)));
      for (const box of boxes) {
        if (box.end - box.start <= maxRows) units.push(box);
        else for (let start = box.start; start < box.end; start += maxRows) units.push({ start, end: Math.min(box.end, start + maxRows) });
      }
    }
    const readUnit = unit => (chunked
      ? readChunk(unit, tail, options, kept)
      : real.read([[unit.start, unit.end], ...tail], options));
    // Waves of units of at most a slab of decoded rows.
    const bounds = [];
    for (let first = 0; first < units.length;) {
      let last = first;
      let bytes = 0;
      while (last < units.length && (last === first || bytes + (units[last].end - units[last].start) * rowBytes <= SLAB_BYTES)) {
        bytes += (units[last].end - units[last].start) * rowBytes;
        last++;
      }
      bounds.push([first, last]);
      first = last;
    }
    /**
     * The piece wave `w`'s walk from piece `order[from]` ends at (`walk`'s
     * return), found by a binary search: the first piece from `from` that
     * starts at or past the wave's end, or reaches past it (pieces ascend
     * in source order and are disjoint, so this holds for every piece after
     * one it holds for).
     */
    const walkEnd = (w, from) => {
      const waveEnd = units[bounds[w][1] - 1].end;
      let lo = from;
      let hi = order.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const p = order[mid];
        if (pieceStarts[p] >= waveEnd || pieceEnds[p] > waveEnd) hi = mid;
        else lo = mid + 1;
      }
      return lo;
    };
    /**
     * Each piece's rows inside wave `w`'s units, unit by unit (units ascend
     * and never overlap; a box's pieces lie within it, gaps between them
     * read and left), from piece `order[from]`: `visit(u, row, rows, at)`
     * for source rows `[row, row + rows)` of unit `u` (of the wave), view
     * rows `[at, at + rows)`; the piece to go on from.
     */
    const walk = (w, from, visit) => {
      const wave = units.slice(bounds[w][0], bounds[w][1]);
      const waveStart = wave[0].start;
      const waveEnd = wave[wave.length - 1].end;
      let at = from;
      let u = 0;
      while (at < order.length && pieceStarts[order[at]] < waveEnd) {
        const p = order[at];
        const to = Math.min(pieceEnds[p], waveEnd);
        for (let row = Math.max(pieceStarts[p], waveStart); row < to;) {
          while (wave[u].end <= row) u++;
          const stop = Math.min(to, wave[u].end);
          visit(u, row, stop - row, pieceAt[p] + (row - pieceStarts[p]));
          row = stop;
        }
        if (pieceEnds[p] > waveEnd) break;
        at++;
      }
      return at;
    };
    /**
     * `walk` counting its fragments and their rows, the walk inlined (a
     * uniform share's millions of single-row fragments: a call each cost
     * more than the count): `{to, fragments, rows}`, `to` the piece to go on from.
     */
    const countWave = (w, from) => {
      const first = bounds[w][0];
      const last = bounds[w][1];
      const waveStart = units[first].start;
      const waveEnd = units[last - 1].end;
      let fragments = 0;
      let rows = 0;
      let at = from;
      let u = first;
      while (at < order.length && pieceStarts[order[at]] < waveEnd) {
        const p = order[at];
        const pieceEnd = pieceEnds[p];
        const to = pieceEnd < waveEnd ? pieceEnd : waveEnd;
        for (let row = pieceStarts[p] > waveStart ? pieceStarts[p] : waveStart; row < to;) {
          while (units[u].end <= row) u++;
          const stop = to < units[u].end ? to : units[u].end;
          fragments++;
          rows += stop - row;
          row = stop;
        }
        if (pieceEnd > waveEnd) break;
        at++;
      }
      return { to: at, fragments, rows };
    };
    // Waves are asked one ahead, in order: each from the piece the one
    // before it ended at.
    let askFrom = 0;
    const ask = w => {
      if (w >= bounds.length) return null;
      const from = askFrom;
      let fragments = 0;
      let rows = 0;
      if (counted || byRows) {
        const counts = countWave(w, from);
        askFrom = counts.to;
        fragments = counts.fragments;
        rows = counts.rows;
      } else askFrom = walkEnd(w, from);
      let promise;
      if (byRows) {
        // The wave's source rows, in source order: one `readRows`.
        const starts = allocateTypedArray(Float64Array, fragments, `${real.path} row runs`);
        const ends = allocateTypedArray(Float64Array, fragments, `${real.path} row runs`);
        let count = 0;
        walk(w, from, (u, row, length) => {
          if (count > 0 && ends[count - 1] === row) ends[count - 1] = row + length;
          else {
            starts[count] = row;
            ends[count] = row + length;
            count++;
          }
        });
        promise = real.readRows({ count, starts, ends }, { ...options, chunks: kept }).then(values => {
          if (values?.length !== rows) throw new Error(`${real.path}: ${formatCountOf(rows, 'row')} did not read as many values`);
          return values;
        });
      } else {
        const wave = units.slice(bounds[w][0], bounds[w][1]);
        promise = Promise.all(wave.map(readUnit)).then(blocks => blocks.map((block, i) => check(block, wave[i].start, wave[i].end)));
      }
      promise.catch(() => {});
      return { promise, from, fragments, rows };
    };
    let next = ask(0);
    for (let w = 0; w < bounds.length; w++) {
      const current = next;
      next = ask(w + 1);
      const read = await current.promise;
      const wave = units.slice(bounds[w][0], bounds[w][1]);
      // Read by rows, the wave's values are its fragments' rows one after
      // another, in the order the walk visits them.
      const each = byRows
        ? visit => {
          let taken = 0;
          walk(w, current.from, (u, row, length, at) => {
            visit(read, taken, length, at);
            taken += length;
          });
        }
        : visit => walk(w, current.from, (u, row, length, at) => visit(read[u], row - wave[u].start, length, at));
      /**
       * `each` with each fragment copied to its view rows of `out` (`copyRows`),
       * the walk inlined: a uniform share's millions of single-row fragments
       * cost a few operations each, not three calls.
       */
      const copyInto = (out, rowWidth) => {
        if (byRows) {
          each((block, from, length, at) => copyRows(block, from, length, out, at, rowWidth));
          return;
        }
        const waveStart = wave[0].start;
        const waveEnd = wave[wave.length - 1].end;
        const viewOut = ArrayBuffer.isView(out);
        let u = 0;
        let unitEnd = wave[0].end;
        let block = read[0];
        let blockStart = wave[0].start;
        for (let o = current.from; o < order.length; o++) {
          const p = order[o];
          const pieceStart = pieceStarts[p];
          if (pieceStart >= waveEnd) break;
          const pieceEnd = pieceEnds[p];
          const to = pieceEnd < waveEnd ? pieceEnd : waveEnd;
          for (let row = pieceStart > waveStart ? pieceStart : waveStart; row < to;) {
            while (unitEnd <= row) {
              u++;
              unitEnd = wave[u].end;
              block = read[u];
              blockStart = wave[u].start;
            }
            const stop = to < unitEnd ? to : unitEnd;
            const count = (stop - row) * rowWidth;
            const source = (row - blockStart) * rowWidth;
            const target = (pieceAt[p] + row - pieceStart) * rowWidth;
            if (viewOut && count > COPY_BY_VIEW_VALUES) out.set(block.subarray(source, source + count), target);
            else for (let i = 0; i < count; i++) out[target + i] = block[source + i];
            row = stop;
          }
          if (pieceEnd > waveEnd) break;
        }
      };
      /**
       * The wave's rows one after another in source order, `values`, and the
       * view rows they are (`runs`: from `origin`, fragments that follow one
       * another in the view too joined), the walk inlined as `copyInto`'s:
       * what `readInSourceOrder` hands out. Counted waves only.
       */
      const gather = (rowWidth, origin) => {
        const starts = allocateTypedArray(Float64Array, current.fragments, `${real.path} row runs`);
        const offsets = allocateTypedArray(Float64Array, current.fragments + 1, `${real.path} row runs`);
        let count = 0;
        let values = null;
        let taken = 0;
        if (byRows) {
          each((block, from, length, at) => {
            values ??= ArrayBuffer.isView(block) ? allocateTypedArray(block.constructor, current.rows * rowWidth, `${real.path} kept rows`) : new Array(current.rows * rowWidth);
            copyRows(block, from, length, values, taken, rowWidth);
            if (count > 0 && starts[count - 1] + taken - offsets[count - 1] === origin + at) offsets[count] = taken + length;
            else {
              starts[count] = origin + at;
              offsets[count + 1] = taken + length;
              count++;
            }
            taken += length;
          });
          return { values, runs: { count, starts: starts.subarray(0, count), offsets: offsets.subarray(0, count + 1) } };
        }
        values = ArrayBuffer.isView(read[0]) ? allocateTypedArray(read[0].constructor, current.rows * rowWidth, `${real.path} kept rows`) : new Array(current.rows * rowWidth);
        const viewValues = ArrayBuffer.isView(values);
        const waveStart = wave[0].start;
        const waveEnd = wave[wave.length - 1].end;
        let u = 0;
        let unitEnd = wave[0].end;
        let block = read[0];
        let blockStart = wave[0].start;
        for (let o = current.from; o < order.length; o++) {
          const p = order[o];
          const pieceStart = pieceStarts[p];
          if (pieceStart >= waveEnd) break;
          const pieceEnd = pieceEnds[p];
          const to = pieceEnd < waveEnd ? pieceEnd : waveEnd;
          for (let row = pieceStart > waveStart ? pieceStart : waveStart; row < to;) {
            while (unitEnd <= row) {
              u++;
              unitEnd = wave[u].end;
              block = read[u];
              blockStart = wave[u].start;
            }
            const stop = to < unitEnd ? to : unitEnd;
            const length = stop - row;
            const n = length * rowWidth;
            const source = (row - blockStart) * rowWidth;
            const target = taken * rowWidth;
            if (viewValues && n > COPY_BY_VIEW_VALUES) values.set(block.subarray(source, source + n), target);
            else for (let i = 0; i < n; i++) values[target + i] = block[source + i];
            const at = origin + pieceAt[p] + row - pieceStart;
            if (count > 0 && starts[count - 1] + taken - offsets[count - 1] === at) offsets[count] = taken + length;
            else {
              starts[count] = at;
              offsets[count + 1] = taken + length;
              count++;
            }
            taken += length;
            row = stop;
          }
          if (pieceEnd > waveEnd) break;
        }
        return { values, runs: { count, starts: starts.subarray(0, count), offsets: offsets.subarray(0, count + 1) } };
      };
      yield { fragments: current.fragments, rows: current.rows, each, copyInto, gather, first: () => (byRows ? read : read[0]) };
    }
  }
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
    // What a gather of this array composes with (`composedRuns`).
    gather: Object.freeze({ source: real, runs, mergeGapBytes, chunks, meter }),
    async storedBytes(selection, options) {
      const pairs = normalizeSelection(shape, selection, path);
      if (pairs[0][1] === pairs[0][0]) return 0;
      const tail = pairs.slice(1);
      // Read row by row (`rowWaves`): the chunks the rows lie in.
      const spans = rowChunkRuns(pairs);
      // The boxes alone: what is read is priced, no piece listed.
      const boxes = spans !== null ? spans.map(([start, end]) => ({ start, end })) : plan(pairs, mergeGapBytes(), true, false).boxes;
      const sizes = await Promise.all(boxes.map(box => real.storedBytes([[box.start, box.end], ...tail], options)));
      return sizes.some(size => !Number.isFinite(size)) ? null : sizes.reduce((sum, size) => sum + size, 0);
    },
    async read(selection, options) {
      const pairs = normalizeSelection(shape, selection, path);
      const tail = pairs.slice(1);
      const [a, b] = pairs[0];
      if (b === a) return real.read([[0, 0], ...tail], options);
      let width = 1;
      for (const [start, stop] of tail) width *= stop - start;
      const kept = chunks ?? new DecodedChunks(0);
      // Row by row in the rows' file order (`rowWaves`), each to its place.
      let out = null;
      let spent = 0;
      for await (const wave of rowWaves(pairs, options)) {
        const started = performance.now();
        out ??= ArrayBuffer.isView(wave.read[0]) ? allocateTypedArray(wave.read[0].constructor, (b - a) * width, `${real.path} kept rows`) : new Array((b - a) * width);
        placeRows(wave, runs.byRow(), width, out);
        spent += performance.now() - started;
      }
      if (out !== null) {
        meter?.note(spent);
        return out;
      }
      const into = block => (ArrayBuffer.isView(block) ? allocateTypedArray(block.constructor, (b - a) * width, `${real.path} kept rows`) : new Array((b - a) * width));
      for await (const wave of waves(pairs, options, kept, { counted: false })) {
        const started = performance.now();
        out ??= into(wave.first());
        wave.copyInto(out, width);
        spent += performance.now() - started;
      }
      meter?.note(spent);
      return out;
    },
    /**
     * Rows `selection` names, a slab at a time in source order (`waves`):
     * each `{values, runs}`, its value rows `[runs.offsets[r],
     * runs.offsets[r + 1])` the rows of the selection from `runs.starts[r]`
     * on (`values.js` `readRowsInStoreOrder`).
     */
    async *readInSourceOrder(selection, options) {
      const pairs = normalizeSelection(shape, selection, path);
      const tail = pairs.slice(1);
      const [a, b] = pairs[0];
      if (b === a) return;
      let width = 1;
      for (const [start, stop] of tail) width *= stop - start;
      const kept = chunks ?? new DecodedChunks(0);
      // Row by row in the rows' file order (`rowWaves`), each placed in its
      // view row as it is read: one slab of the view, in its order (a copy
      // in file order and a scatter after it cost a pass more a column).
      let placed = null;
      for await (const wave of rowWaves(pairs, options)) {
        placed ??= ArrayBuffer.isView(wave.read[0]) ? allocateTypedArray(wave.read[0].constructor, (b - a) * width, `${real.path} kept rows`) : new Array((b - a) * width);
        placeRows(wave, runs.byRow(), width, placed);
      }
      if (placed !== null) {
        yield { values: placed, runs: { count: 1, starts: [a], offsets: [0, b - a] } };
        return;
      }
      for await (const wave of waves(pairs, options, kept)) {
        if (wave.rows === 0) continue;
        yield wave.gather(width, a);
      }
    },
  });
}

/** A child made once, as `viewGroup` makes its children. */
function passChildren(group, wrap = /** @type {(key: string, node: object) => object|null} */ (() => null)) {
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
    children: () => passChildren(frame, (key, node) => {
      if (isArrayNode(node)) return gatherIfRows(node);
      if (!isGroup(node)) return null;
      const encoding = encodingType(node);
      if (encoding === 'categorical') {
        return viewGroup({
          path: node.path,
          attrs: node.attrs,
          real: node,
          children: () => passChildren(node, (name, part) => (name === 'codes' ? gatherIfRows(part) : null)),
        });
      }
      if (encoding.startsWith('nullable-')) {
        return viewGroup({
          path: node.path,
          attrs: node.attrs,
          real: node,
          children: () => passChildren(node, (name, part) => (name === 'values' || name === 'mask' ? gatherIfRows(part) : null)),
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

/**
 * An `indptr` of exact counts (`pointers`, numbers) as the array a view
 * presents: the integers of the rows each read asks for, made then from
 * `pointers` and held by nobody after it. It is read rarely (every reader of
 * a view's matrix takes `rowPointers()`), and a copy made with the node held
 * the open rows' pointers a third time beside the stored ones and `pointers`
 * (200 MB at 50M open cells).
 */
export function pointerArray(path, pointers) {
  const total = pointers[pointers.length - 1];
  const wide = total > 0x7fffffff;
  const shape = [pointers.length];
  return Object.freeze({
    kind: 'array',
    wideIntegers: false,
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    attrs: Object.freeze({}),
    attributeType: () => null,
    shape,
    dtype: numericDtype('int', wide ? 8 : 4),
    chunks: null,
    fillValue: null,
    storedBytes: async () => 0,
    async read(selection) {
      const [[start, end]] = normalizeSelection(shape, selection, path);
      const values = allocateTypedArray(wide ? BigInt64Array : Int32Array, end - start, `${path} indptr`);
      for (let i = start; i < end; i++) values[i - start] = wide ? BigInt(pointers[i]) : pointers[i];
      return values;
    },
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
  const rowRuns = rows.runs();
  // A run's rows are consecutive, and so are their pointers (`RowPointers`
  // reads each run's in one range): one lookup a run, not two a row.
  const values = ArrayBuffer.isView(pointers) ? pointers : pointers instanceof RowPointers ? pointers.values : null;
  // Runs in ascending rows (rows in store order) walk the ranges forward;
  // the rows the pointers were read for, in their own order, take each
  // run's place from the pointers' run index (`runIndexFor`, made once).
  let ascending = pointers instanceof RowPointers;
  for (let r = 1; ascending && r < rowRuns.count; r++) ascending = rowRuns.starts[r] >= rowRuns.ends[r - 1];
  const walk = ascending ? pointers.walker() : null;
  const runIndex = !ascending && pointers instanceof RowPointers ? pointers.runIndexFor(rows) : null;
  const indexOfRun = r => (values === pointers ? rowRuns.starts[r] : walk !== null ? walk(rowRuns.starts[r]) : runIndex !== null ? runIndex[r] : pointers.indexOf(rowRuns.starts[r]));
  // Entry runs in typed arrays, at most one a row run (lists grown an item
  // at a time hold millions of runs as boxed numbers).
  let starts = allocateTypedArray(Float64Array, rowRuns.count, 'Kept entry runs');
  let ends = allocateTypedArray(Float64Array, rowRuns.count, 'Kept entry runs');
  let count = 0;
  for (let r = 0; r < rowRuns.count; r++) {
    const first = rowRuns.offsets[r];
    const length = rowRuns.offsets[r + 1] - first;
    let start;
    let end;
    if (values === null) {
      for (let j = 0; j < length; j++) rowPointers[first + j + 1] = rowPointers[first + j] + pointers.at(kept[first + j] + 1) - pointers.at(kept[first + j]);
      start = pointers.at(rowRuns.starts[r]);
      end = pointers.at(rowRuns.ends[r]);
    } else {
      const at = indexOfRun(r);
      for (let j = 0; j < length; j++) rowPointers[first + j + 1] = rowPointers[first + j] + values[at + j + 1] - values[at + j];
      start = values[at];
      end = values[at + length];
    }
    if (end === start) continue;
    if (count > 0 && ends[count - 1] === start) ends[count - 1] = end;
    else {
      starts[count] = start;
      ends[count] = end;
      count++;
    }
  }
  if (count < rowRuns.count) {
    starts = starts.slice(0, count);
    ends = ends.slice(0, count);
  }
  const offsets = allocateTypedArray(Float64Array, count + 1, 'Kept entry runs');
  for (let r = 0; r < count; r++) offsets[r + 1] = offsets[r] + ends[r] - starts[r];
  return {
    rowPointers,
    entries: { count, starts, ends, offsets },
  };
}

/**
 * A CSR matrix of the kept rows. Its `indptr`, `indices` and `data` are
 * made once its kept rows' pointers are read (`readRowPointers` on the view
 * root, which every read of the matrix awaits first); its shape and
 * attributes are known before.
 */
/** Note arrays the view made in `ctx.held`, weakly (`heldBuffers`). */
function holdWeakly(ctx, ...arrays) {
  for (const array of arrays) if (ArrayBuffer.isView(array) && array.byteLength > 0) ctx.held?.add(new WeakRef(array));
}

function csrRows(matrix, rows, ctx) {
  const key = pathKey(matrix.path);
  ctx.matrices.set(key, { matrix, rows });
  let kept = null;
  const keptOf = () => {
    if (kept !== null) return kept;
    const pointers = ctx.indptrs.get(key);
    if (pointers === undefined) throw new Error(`${matrix.path}: its row pointers are read before the matrix is (readRowPointers)`);
    kept = keptEntries(pointers, rows);
    holdWeakly(ctx, kept.rowPointers, kept.entries.starts, kept.entries.ends, kept.entries.offsets);
    return kept;
  };
  return csrOfRows(matrix, rows, keptOf, ctx, { rowPointersPending: () => !ctx.indptrs.has(key) });
}

/**
 * A CSR matrix of `rows` of the stored `matrix`, its entries where
 * `keptOf()` (`keptEntries`) says: `indptr` exact, `indices` and `data`
 * gathered from the stored arrays. `rowPointers()` gives its row pointers
 * as numbers (no `indptr` of 64-bit integers made to be read back);
 * `storedData()` the stored `data` (dtype), known before any pointer.
 */
function csrOfRows(matrix, rows, keptOf, ctx, extra = {}) {
  const shape = attributeValue(matrix, 'shape');
  return viewGroup({
    path: matrix.path,
    attrs: { ...matrix.attrs, shape: [rows.count, Number(shape[1])] },
    real: matrix,
    ownAttributes: ['shape'],
    // Until its pointers are read, what describing the matrix may ask:
    // whether they are, and its stored `data` (dtype; stored values unknown).
    // Its children are arrays made from its kept rows' pointers, so loading
    // it loads the stored matrix and makes none of them: a load that reaches
    // it (describing `obsm`, where a sparse array is listed as one that cannot
    // be drawn) never asks for pointers not read yet.
    extra: {
      rowPointersPending: () => false,
      ...extra,
      rowPointers: () => keptOf().rowPointers,
      storedData: () => matrix.get('data'),
      load: (paths = [''], options = {}) => matrix.load(paths, options),
    },
    children: () => passChildren(matrix, (key, node) => {
      if (key === 'indptr') {
        return pointerArray(node.path, keptOf().rowPointers);
      }
      if ((key === 'indices' || key === 'data') && isArrayNode(node)) {
        return gatheredArray(node, keptOf().entries, { mergeGapBytes: ctx.mergeGapBytes, chunks: ctx.chunks, meter: ctx.meter });
      }
      return null;
    }),
  });
}

/**
 * Some view rows of `rows` as rows of their own: the first `count` when
 * `which` is a number, else the view rows `which` names, in that order.
 */
function someRows(rows, which) {
  if (typeof which === 'number') return new CellRows(rows.kept.subarray(0, which), rows.nOriginal);
  const kept = allocateTypedArray(Uint32Array, which.length, 'Rows read');
  for (let i = 0; i < which.length; i++) {
    const row = which[i];
    if (!(row >= 0 && row < rows.count)) throw new RangeError(`Row ${row} is outside the ${formatCountOf(rows.count, 'open row')}`);
    kept[i] = rows.kept[row];
  }
  return new CellRows(kept, rows.nOriginal);
}

/** Whether `pointers` (the stored `indptr`, or some rows' `RowPointers`) holds every pointer `rows` needs. */
function coversRows(pointers, rows) {
  if (!(pointers instanceof RowPointers)) return true;
  const runs = rows.runs();
  for (let r = 0; r < runs.count; r++) if (!covers(pointers, runs.starts[r], runs.ends[r] + 1)) return false;
  return true;
}

/**
 * Two rows' pointers as one: every pointer either holds (ranges that meet
 * or overlap joined; where both hold one, they agree, being the file's).
 *
 * @param {RowPointers|null} a
 * @param {RowPointers} b
 * @returns {RowPointers}
 */
export function unitedRowPointers(a, b) {
  if (a === null) return b;
  const ranges = [];
  for (const pointers of [a, b]) {
    for (let i = 0; i < pointers.starts.length; i++) ranges.push({ start: pointers.starts[i], end: pointers.ends[i], from: pointers, at: pointers.offsets[i] });
  }
  ranges.sort((x, y) => x.start - y.start);
  const starts = [];
  const ends = [];
  for (const range of ranges) {
    if (ends.length > 0 && range.start <= ends[ends.length - 1]) ends[ends.length - 1] = Math.max(ends[ends.length - 1], range.end);
    else {
      starts.push(range.start);
      ends.push(range.end);
    }
  }
  const offsets = allocateTypedArray(Float64Array, starts.length + 1, 'Kept row pointers');
  for (let i = 0; i < starts.length; i++) offsets[i + 1] = offsets[i] + ends[i] - starts[i];
  const values = allocateTypedArray(Float64Array, offsets[starts.length], 'Kept row pointers');
  let joined = 0;
  for (const range of ranges) {
    while (ends[joined] < range.end) joined++;
    const into = offsets[joined] + range.start - starts[joined];
    values.set(range.from.values.subarray(range.at, range.at + range.end - range.start), into);
  }
  return new RowPointers(Float64Array.from(starts), Float64Array.from(ends), offsets.subarray(0, starts.length), values);
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
      children: () => passChildren(matrix),
      extra: { cellRows: Object.freeze({ matrix, rows }) },
    });
  }
  return matrix;
}

/** A mapping (`obsm`, `layers`, `obsp`) whose every child is wrapped by `wrap`. */
function mappingOf(group, wrap) {
  if (!isGroup(group)) return group;
  return viewGroup({ path: group.path, attrs: group.attrs, real: group, children: () => passChildren(group, (key, node) => wrap(node)) });
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
          children: () => passChildren(node, (name, part) => (name === 'X' ? matrixRows(part, rows, ctx) : null)),
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
      children: () => passChildren(node, (key, part) => (key === names[0] ? wrapPath(part, names.slice(1), leaf) : null)),
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
async function modalityRows(modality, rows, options, mergeGapBytes, chunks = null) {
  // The kept cells' entries of the cell map only, in view order.
  const kept = await gatheredArray(modality.obsmap, rows.runs(), { mergeGapBytes, chunks }).read(undefined, options);
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
 * @param {{nObs: number, kept: Uint32Array, rows?: CellRows|null, mergeGapBytes: () => number, readOptions?: Object,
 *   indptrs?: Map<string, Float64Array>, knownRowPointers?: Map<string, RowPointers>,
 *   chunks?: DecodedChunks|null, meter?: ViewMeter|null}} subset -
 *   `kept`: the file row of each view row, in view order, fewer than `nObs`; `mergeGapBytes`:
 *   the link's merge gap now (a function: it follows the link as measured);
 *   `indptrs`: CSR row pointers read whole before, by matrix path;
 *   `knownRowPointers`: the rows' pointers an earlier view of the same store
 *   read (`knownRowPointers()` of that view), taken over where they hold
 *   the kept rows' pointers; the view reads the map it is given, so a clear
 *   of it lets them go
 * @returns {Promise<Object>}
 */
export async function cellSubsetView(root, { nObs, kept, rows: given = null, mergeGapBytes, readOptions = {}, indptrs = new Map(), knownRowPointers = new Map(), chunks = null, meter = null }) {
  // The reader's own map, keyed as `knownRowPointersOf` keys it: the reader
  // counts what it holds and lets it go (`_rowPointerBytes`, `trimResident`).
  const known = knownRowPointers;
  // The reader's rows when it gives them (it counts what they and their
  // lookups hold): one set of runs and one inverse for the open cells.
  const rows = given ?? new CellRows(kept, nObs);
  const modalities = Array.isArray(root.modalities) ? root.modalities : null;
  // What the view must know before it is made: each modality's rows.
  const modalityPlans = new Map();
  if (modalities !== null) {
    await Promise.all(modalities.map(async modality => {
      const plan = modality.obsmap === null
        ? { modalityKept: rows, obsmap: null }
        : await modalityRows(modality, rows, readOptions, mergeGapBytes, chunks);
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
    // Told the work of the view's own over a matrix (its kept rows' pointers, its entries gathered): `ViewMeter`.
    meter,
    indptrs: new Map([...indptrs].map(([path, pointers]) => [pathKey(path), pointers])),
    matrices: new Map(),
    // The arrays the view makes of its matrices' pointers (a CSR matrix's
    // kept row pointers and entry runs, its presented `indptr`), held weakly
    // here so the reader counts what they hold (`heldBuffers`) for as long
    // as they live, and no longer.
    held: new Set(),
    pointerReads: new Map(),
    // Some rows' pointers by matrix (`readRowPointers` given `rows`), with
    // those an earlier view of the store read (`known`), until every kept
    // row's are read; and the reads of first rows under way, by row count.
    partial: new Map(),
    prefixReads: new Map(),
    // The most first rows whose pointers are known held, by matrix (held
    // pointers only grow): every read of a gene asks for the gene sample's
    // first rows, and is answered from this, not by a walk of their runs.
    coveredFirst: new Map(),
  };
  /** The pointers of some rows held for the matrix at `key`: read by this view, or by one before it. */
  const pointersHeld = key => ctx.partial.get(key) ?? known.get(key) ?? null;
  /**
   * Whether the pointers held for the matrix at `key` (some rows', not
   * every kept row's) cover view rows `rows`: the first `rows` (a number)
   * or the rows listed. A count of first rows is walked once: a run reads
   * thousands of genes, each asking for the gene sample's first rows, and a
   * walk of their runs each time (O(sample) a read) makes a markers run over
   * a sample of millions of cells time out.
   */
  const heldCover = (key, rows) => {
    const first = typeof rows === 'number';
    if (first && rows <= (ctx.coveredFirst.get(key) ?? 0)) return true;
    const held = pointersHeld(key);
    if (held === null || !coversRows(held, someRows(ctx.matrices.get(key).rows, rows))) return false;
    if (first) ctx.coveredFirst.set(key, rows);
    return true;
  };
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
  /**
   * Read the row pointers of the CSR matrix at `path` (nothing for any
   * other node): every kept row's, once (then the matrix's own `indptr`,
   * `indices` and `data` can be made); or, given `rows`, only those view
   * rows' -- the first `rows` (a number) or the view rows listed -- for
   * `rowsMatrix`: a gene sample's first cells of a view of every cell of a
   * large file need a small share of the pointer chunks, not all of them
   * (CELLxGENE's writer lays the pointer chunks between the matrix's, so
   * none merge; measured: 23_decisions_partial_reading.md). Pointers read
   * once, by either, are never read again: they are kept together
   * (`ctx.partial`) and copied from by every later read.
   */
  const readRowPointers = (path, { rows = null, ...options } = {}) => {
    const key = matrixKey(path);
    const entry = ctx.matrices.get(key) ?? null;
    if (entry === null || ctx.indptrs.has(key)) return Promise.resolve();
    const read = (cellRows, readOptions) => (
      // Through the store's decoded chunks: a raise reads the pointer chunks its added rows share with the open ones once.
      readKeptRowPointers(entry.matrix.get('indptr'), cellRows, { mergeGapBytes, readOptions, known: pointersHeld(key), chunks, meter }).then(pointers => {
        const last = pointers.values[pointers.values.length - 1];
        if (last > entry.matrix.get('indices').shape[0]) {
          throw new AnnDataFormatError(`${path}: row pointers reach past its ${formatCountOf(entry.matrix.get('indices').shape[0], 'stored value')}`);
        }
        return pointers;
      })
    );
    if (rows !== null) {
      if (heldCover(key, rows)) return Promise.resolve();
      // A read of the first rows waits for one of at least as many already asked for.
      const reads = ctx.prefixReads.get(key) ?? new Map();
      const asked = typeof rows === 'number' ? [...reads].find(([count]) => count >= rows) : undefined;
      if (asked !== undefined) return asked[1];
      const reading = read(someRows(entry.rows, rows), options).then(pointers => {
        if (ctx.indptrs.has(key)) return;
        ctx.partial.set(key, unitedRowPointers(pointersHeld(key), pointers));
        if (typeof rows === 'number' && rows > (ctx.coveredFirst.get(key) ?? 0)) ctx.coveredFirst.set(key, rows);
      });
      if (typeof rows === 'number') {
        ctx.prefixReads.set(key, reads);
        reads.set(rows, reading);
        reading.then(() => reads.delete(rows), () => reads.delete(rows));
      }
      return reading;
    }
    let reading = ctx.pointerReads.get(key);
    if (reading === undefined) {
      reading = read(entry.rows, options).then(pointers => {
        ctx.indptrs.set(key, pointers);
        ctx.partial.delete(key);
      });
      ctx.pointerReads.set(key, reading);
      // A failed or canceled read is tried again by the next read of the matrix.
      reading.catch(() => ctx.pointerReads.delete(key));
    }
    return reading;
  };
  /**
   * Whether the row pointers of the CSR matrix at `path` that `rows` (as
   * `readRowPointers` takes them; null: every kept row) needs are read.
   */
  const rowPointersCover = (path, rows = null) => {
    const key = matrixKey(path);
    const entry = ctx.matrices.get(key) ?? null;
    if (entry === null || ctx.indptrs.has(key)) return true;
    return rows !== null && heldCover(key, rows);
  };
  /**
   * The CSR matrix at `path` on some of its view rows -- the first `rows`
   * (a number), or the view rows listed, in that order -- made from those
   * rows' pointers alone (`readRowPointers` with the same `rows` first):
   * its `indptr` exact (`rowPointers()`), its `indices` and `data` the
   * rows' entries in the stored arrays, read through `chunks` (the store's
   * decoded chunks by default; a scan in store order larger than they hold
   * passes a window of its own, `AnnDataReader._scanChunks`).
   */
  const rowsMatrix = (path, rows, { chunks = ctx.chunks } = {}) => {
    const key = matrixKey(path);
    const entry = ctx.matrices.get(key) ?? null;
    if (entry === null) throw new Error(`${path} is not a CSR matrix of the open cells`);
    const cellRows = someRows(entry.rows, rows);
    const pointers = ctx.indptrs.get(key) ?? pointersHeld(key);
    if (!ctx.indptrs.has(key) && !heldCover(key, rows)) {
      throw new Error(`${path}: the row pointers of ${formatCountOf(cellRows.count, 'row')} are read before they are (readRowPointers)`);
    }
    const kept = keptEntries(pointers, cellRows);
    return csrOfRows(entry.matrix, cellRows, () => kept, chunks === ctx.chunks ? ctx : { ...ctx, chunks });
  };
  /**
   * The CSR matrix at `path` on every view row in file order (`CellRows`
   * `byRow`, made once):
   * `order`, the view row of each of its rows; `matrix`, as `rowsMatrix`
   * makes it, of those rows. Every kept row's pointers are read first
   * (`readRowPointers` without `rows`). A pass over it reads the stored
   * chunks in order, each once (`AnnDataReader._storeOrderMatrix`), with no
   * sort, list or run of the rows of its own.
   */
  const fileOrderMatrix = (path, { chunks = ctx.chunks } = {}) => {
    const key = matrixKey(path);
    const entry = ctx.matrices.get(key) ?? null;
    if (entry === null) throw new Error(`${path} is not a CSR matrix of the open cells`);
    const pointers = ctx.indptrs.get(key);
    if (pointers === undefined) throw new Error(`${path}: its row pointers are read before the matrix is (readRowPointers)`);
    const { order, rows } = entry.rows.byRow();
    const kept = keptEntries(pointers, rows);
    return { order, matrix: csrOfRows(entry.matrix, rows, () => kept, chunks === ctx.chunks ? ctx : { ...ctx, chunks }) };
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
      children: () => passChildren(mod, (name, group) => {
        const plan = modalityPlans.get(name);
        if (plan === undefined || !isGroup(group)) return null;
        const modalityCtx = { ...ctx, rows: plan.modalityKept };
        return viewGroup({ path: group.path, attrs: group.attrs, real: group, children: () => annDataRows(group, plan.modalityKept, modalityCtx) });
      }),
    }));
    const obsmaps = root.get('obsmap');
    if (isGroup(obsmaps)) {
      extraChildren.set('obsmap', () => viewGroup({
        path: obsmaps.path,
        attrs: obsmaps.attrs,
        real: obsmaps,
        children: () => passChildren(obsmaps, name => presentedModalities.find(item => item.name === name)?.obsmap ?? null),
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
    for (const [key, pointers] of ctx.partial) all.set(key, pointers);
    for (const [key, pointers] of ctx.indptrs) if (pointers instanceof RowPointers) all.set(key, pointers);
    return all;
  };
  /**
   * The buffers of every pointer array this view holds: the pointers it read
   * (whole or the kept rows'), and what it made of them while those live.
   */
  const heldBuffers = () => {
    const buffers = new Set();
    const add = value => {
      if (ArrayBuffer.isView(value)) {
        if (value.byteLength > 0) buffers.add(value.buffer);
      } else if (value instanceof RowPointers) {
        for (const array of Object.values(value)) if (ArrayBuffer.isView(array) && array.byteLength > 0) buffers.add(array.buffer);
      }
    };
    for (const pointers of ctx.indptrs.values()) add(pointers);
    for (const pointers of ctx.partial.values()) add(pointers);
    for (const ref of ctx.held) {
      const array = ref.deref();
      if (array === undefined) ctx.held.delete(ref);
      else add(array);
    }
    return buffers;
  };
  const rowAccess = { readRowPointers, rowPointersOf, rowPointersCover, rowsMatrix, fileOrderMatrix, knownRowPointers: knownRowPointersOf, heldBuffers };
  const extra = presentedModalities === null
    ? rowAccess
    : { modalities: presentedModalities, defaultModality: root.defaultModality, ...rowAccess };
  const view = viewGroup({
    path: root.path,
    attrs: root.attrs,
    real: root,
    children: () => annDataRows(root, rows, ctx, extraChildren),
    close: reason => root.close?.(reason),
    extra,
  });
  return view;
}

/**
 * `rows` (file rows, any order) ascending and once each, through a bit a row
 * up to the largest: linear in the rows and the file, where a sort of a
 * priority-ordered selection of tens of millions of rows is slower (measured:
 * 23_decisions_partial_reading.md); rows fewer than the
 * bit words that would hold them are radix-sorted instead (linear in the
 * rows alone).
 *
 * @param {Uint32Array} rows
 * @returns {Uint32Array}
 */
function ascendingRows(rows) {
  let top = 0;
  for (let i = 0; i < rows.length; i++) if (rows[i] > top) top = rows[i];
  // Rows few against the file (more bit words to scan than rows): two radix
  // passes over the rows, then the repeats left out.
  if ((top >>> 5) + 1 > rows.length) {
    const sorted = sortUint32(copyRowList(rows));
    let at = 0;
    for (let i = 0; i < sorted.length; i++) if (i === 0 || sorted[i] !== sorted[i - 1]) sorted[at++] = sorted[i];
    return at === sorted.length ? sorted : sorted.subarray(0, at);
  }
  const words = allocateTypedArray(Uint32Array, (top >>> 5) + 1, 'Kept row bits');
  for (let i = 0; i < rows.length; i++) words[rows[i] >>> 5] |= 1 << (rows[i] & 31);
  const out = allocateTypedArray(Uint32Array, rows.length, 'Kept rows');
  let at = 0;
  for (let w = 0; w < words.length; w++) {
    for (let bits = words[w]; bits !== 0; bits &= bits - 1) out[at++] = w * 32 + (31 - Math.clz32(bits & -bits));
  }
  return at === out.length ? out : out.subarray(0, at);
}

/** Rows `0 … n − 1`. */
function everyRow(n) {
  const rows = allocateTypedArray(Uint32Array, n, 'Kept rows');
  for (let i = 0; i < n; i++) rows[i] = i;
  return rows;
}

/** A copy of a row list, as a `Uint32Array`. */
function copyRowList(rows) {
  const copy = allocateTypedArray(Uint32Array, rows.length, 'Kept rows');
  copy.set(rows);
  return copy;
}

/**
 * The share of a CSR matrix's index chunks (`chunkElements` entries each)
 * the kept rows' entries lie in: what reading the subsample's genes fetches
 * of the matrix, against the share of the cells it keeps.
 *
 * @param {Float64Array|RowPointers} pointers - The stored `indptr`, or the kept rows' pointers
 * @param {Uint32Array} rows - The kept rows, in any order (ascending: no sorted copy is made)
 * @param {number} chunkElements
 * @param {number} [nnz] - The matrix's stored values (the stored `indptr`'s last)
 * @returns {number}
 */
export function keptChunkShare(pointers, rows, chunkElements, nnz = pointers[pointers.length - 1]) {
  return keptValueStats(pointers, rows, chunkElements, nnz).chunkShare;
}

/**
 * `keptValueCount` and `keptChunkShare` of the same rows in one walk:
 * `values`, the kept rows' stored values; `chunkShare`, the share of the
 * index chunks (`chunkElements` entries each; null: not counted) they lie in.
 * Over the rows ascending (a view presents them in priority order; rows
 * given ascending are walked as they are), consecutive rows a span, [their
 * first's pointer, the pointer after their last): two pointer reads a run
 * of rows (`PointerCursor`, a walk forward), not two a row (a lookup a row
 * over millions of rows in open order takes seconds: measured,
 * 23_decisions_partial_reading.md).
 *
 * @param {Float64Array|RowPointers|{at: (row: number) => number}} pointers
 * @param {Uint32Array} rows - In any order
 * @param {number|null} chunkElements
 * @param {number} [nnz] - The matrix's stored values (the stored `indptr`'s last)
 * @returns {{values: number, chunkShare: number|null}}
 */
export function keptValueStats(pointers, rows, chunkElements, nnz = pointers[pointers.length - 1]) {
  // Every row of the stored `indptr` (kept rows are distinct): every value, every chunk.
  if (ArrayBuffer.isView(pointers) && pointers.length > 1 && rows.length === pointers.length - 1) {
    return { values: nnz, chunkShare: chunkElements === null ? null : nnz === 0 ? 0 : 1 };
  }
  const kept = ascendingRowsOf(rows);
  const cursor = new PointerCursor(pointers);
  const chunked = chunkElements !== null && nnz > 0;
  let values = 0;
  let touched = 0;
  let last = -1;
  for (let i = 0; i < kept.length;) {
    let next = i + 1;
    while (next < kept.length && kept[next] === kept[next - 1] + 1) next++;
    const start = cursor.at(kept[i]);
    const end = cursor.at(kept[next - 1] + 1);
    i = next;
    values += end - start;
    if (!chunked || end <= start) continue;
    let first = Math.floor(start / chunkElements);
    const stop = Math.floor((end - 1) / chunkElements);
    if (first <= last) first = last + 1;
    if (stop >= first) touched += stop - first + 1;
    if (stop > last) last = stop;
  }
  return { values, chunkShare: chunkElements === null ? null : nnz === 0 ? 0 : touched / Math.ceil(nnz / chunkElements) };
}

/** `rows` ascending: themselves when they ascend, else sorted once each (`ascendingRows`). */
function ascendingRowsOf(rows) {
  let ascending = true;
  for (let i = 1; i < rows.length && ascending; i++) ascending = rows[i] > rows[i - 1];
  return ascending ? rows : ascendingRows(rows);
}

/**
 * Row pointers looked up for rows asked in ascending order (`at(row)`, each
 * at least the one before): the stored `indptr` at the row; some rows'
 * `RowPointers` by a walk forward over their ranges (a method the engine
 * inlines, not a closure a lookup: a share's millions of runs); anything
 * else by its own `at`.
 */
class PointerCursor {
  constructor(pointers) {
    this.pointers = pointers;
    this.ranged = pointers instanceof RowPointers;
    this.stored = !this.ranged && ArrayBuffer.isView(pointers);
    this.range = 0;
  }

  at(row) {
    if (this.stored) return this.pointers[row];
    if (!this.ranged) return this.pointers.at(row);
    const { starts, ends, offsets, values } = this.pointers;
    let range = this.range;
    while (range < starts.length && ends[range] <= row) range++;
    this.range = range;
    if (range === starts.length || starts[range] > row) throw new RangeError(`Row pointer ${row} was not read with the kept rows`);
    return values[offsets[range] + row - starts[range]];
  }
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
  // Every row (kept rows are distinct): every chunk.
  if (rows.length === nRows) return 1;
  const perRow = nnz / nRows;
  const at = row => Math.min(nnz, Math.round(row * perRow));
  const chunks = Math.ceil(nnz / chunkElements);
  // Rows of at least one entry each (every row's span is not empty) and
  // fewer chunks than rows: chunk by chunk, the first kept row whose
  // entries end past the chunk's start found by halving, the chunk touched
  // when that row's entries start before its end -- a few looks a chunk,
  // not a walk of every row.
  if (perRow >= 1 && chunks < rows.length) {
    const kept = ascendingRowsOf(rows);
    let touched = 0;
    let j = 0;
    for (let c = 0; c < chunks && j < kept.length; c++) {
      const start = c * chunkElements;
      const end = Math.min(nnz, start + chunkElements);
      let high = kept.length;
      while (j < high) {
        const mid = (j + high) >>> 1;
        if (at(kept[mid] + 1) <= start) j = mid + 1;
        else high = mid;
      }
      if (j < kept.length && at(kept[j]) < end) touched++;
    }
    return touched / chunks;
  }
  return keptChunkShare({ at }, rows, chunkElements, nnz);
}

/**
 * The stored values of the kept rows of a CSR matrix, from its row
 * pointers: what a column index of the subsample holds.
 *
 * @param {Float64Array|RowPointers} pointers - The stored `indptr`, or the kept rows' pointers
 * @param {Uint32Array} kept - In any order (ascending: no sorted copy is made)
 * @returns {number}
 */
export function keptValueCount(pointers, kept) {
  return keptValueStats(pointers, kept, null).values;
}
