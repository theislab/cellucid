/**
 * A matrix's rows placed on the dataset's cells through a cell map (a
 * modality that measured some cells, a subsample's kept rows): a dense or
 * sparse gene column placed with NaN where a cell was not measured
 * (`placeColumn`, `placeSparseColumn`), the stored rows a map reaches
 * (`keptRowsOf`), a sparse column made dense (`denseOfSparse`), and a
 * modality's map composed with a subsample's rows (`composeCellMaps`).
 * The two module-level maps hold what is made once per cell map, for every
 * reader of the thread. What a map is made from is the reader's
 * (`_cellsOf`) and `views/modalities.js`'s.
 *
 * @module data/anndata/cell-maps
 */

import { allocateTypedArray, copyTypedArray } from '../sparse-column-index.js';
import { sharedOnce } from '../../utils/abort.js';
import { CellRows } from './views/cell-subset.js';
import { orderByKey } from '../../utils/radix-order.js';

/**
 * One modality's gene column on the dataset's cells: NaN where the modality
 * did not measure a cell (not 0: "not measured" is not "measured zero").
 * `rows` is the cell map (`_cellsOf`), null when there is nothing to place.
 */
export function placeColumn(column, rows, nObs) {
  if (rows === null) return column;
  const placed = allocateTypedArray(Float32Array, nObs, 'Gene column');
  for (let cell = 0; cell < nObs; cell++) placed[cell] = rows[cell] < 0 ? Number.NaN : column[rows[cell]];
  return placed;
}

/**
 * One modality's sparse gene column on the dataset's cells: its entries at
 * the cells measuring them, and an explicit NaN entry at every cell the
 * modality did not measure, cells ascending.
 */
export function placeSparseColumn(column, rows, nObs, nRows) {
  if (rows === null) return column;
  const kept = keptRowsOf(rows);
  if (kept !== null) return placeSparseThrough(column, rows, kept);
  const byRow = allocateTypedArray(Float32Array, nRows, 'Gene column');
  for (let entry = 0; entry < column.indices.length; entry++) byRow[column.indices[entry]] = column.values[entry];
  const indices = [];
  const values = [];
  for (let cell = 0; cell < nObs; cell++) {
    const row = rows[cell];
    const value = row < 0 ? Number.NaN : byRow[row];
    if (value !== 0) {
      indices.push(cell);
      values.push(value);
    }
  }
  return { length: nObs, indices: Uint32Array.from(indices), values: Float32Array.from(values) };
}

/**
 * The stored rows a cell map reaches, ascending (`sorted`), with the cell of
 * each (`cells`): made once per map, sized to its cells (8 bytes a cell), not
 * to the stored rows -- a subsample of 10M cells of a 100M-cell file holds
 * 80 MB here, where a lookup of every stored row would hold 400 MB. Null for
 * a map that sends two cells to one row.
 */
const keptRowsByMap = new WeakMap();

export function keptRowsOf(rows) {
  if (keptRowsByMap.has(rows)) return keptRowsByMap.get(rows);
  let measured = 0;
  for (let cell = 0; cell < rows.length; cell++) if (rows[cell] >= 0) measured++;
  const rowOf = allocateTypedArray(Uint32Array, measured, 'Measured rows');
  const cellOf = allocateTypedArray(Uint32Array, measured, 'Measured cells');
  let at = 0;
  for (let cell = 0; cell < rows.length; cell++) {
    if (rows[cell] < 0) continue;
    rowOf[at] = rows[cell];
    cellOf[at++] = cell;
  }
  // The cells by their rows, in a radix order: each row's cell is where the
  // order puts it, no search a cell (searching each cell among the runs of
  // a large uniform share costs most of a CSC gene's read; measured:
  // 23_decisions_partial_reading.md).
  const order = orderByKey(rowOf);
  const sorted = allocateTypedArray(Uint32Array, measured, 'Measured rows');
  const cells = allocateTypedArray(Int32Array, measured, 'Measured cells');
  let runs = 0;
  let distinct = true;
  for (let i = 0; i < measured; i++) {
    sorted[i] = rowOf[order[i]];
    cells[i] = cellOf[order[i]];
    if (i > 0 && sorted[i] === sorted[i - 1]) distinct = false;
    if (i === 0 || sorted[i] !== sorted[i - 1] + 1) runs++;
  }
  let kept = null;
  if (distinct) {
    // Runs of consecutive rows (a blocks subsample's are its blocks): a
    // column's entries are matched against the runs, not every kept row.
    const runStarts = allocateTypedArray(Float64Array, runs, 'Measured row runs');
    const runBases = allocateTypedArray(Float64Array, runs + 1, 'Measured row runs');
    let run = -1;
    for (let i = 0; i < measured; i++) {
      if (i === 0 || sorted[i] !== sorted[i - 1] + 1) {
        runStarts[++run] = sorted[i];
        runBases[run] = i;
      }
    }
    runBases[runs] = measured;
    kept = { sorted, cells, runStarts, runBases };
  }
  keptRowsByMap.set(rows, kept);
  return kept;
}

/**
 * Where row `row` is in `sorted` from position `from` on (the first position
 * holding `row` or more): galloping, so a column's ascending rows walk the
 * kept rows once, in time of the column's entries and the gaps between them.
 */
function gallop(sorted, row, from) {
  let low = from;
  let step = 1;
  let high = from;
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
 * `placeSparseColumn` through the map's kept rows: each stored entry goes to
 * its cell, in time of the column's entries and the cells it did not
 * measure; a column's entries are ascending by row, so one galloping walk
 * finds them all (a column out of order is searched entry by entry).
 */
function placeSparseThrough(column, rows, kept) {
  const nObs = rows.length;
  const { cells: cellOf, runStarts, runBases } = kept;
  const runCount = runStarts.length;
  const entries = column.indices.length;
  // At most one cell an entry; typed, so a column of a million entries is
  // placed without growing arrays.
  let cells = allocateTypedArray(Uint32Array, entries, 'Gene column cells');
  let values = allocateTypedArray(Float32Array, entries, 'Gene column values');
  let count = 0;
  let ascending = true;
  // The run whose rows begin at or before the entry's row (galloped).
  let run = 0;
  let lastRow = -1;
  for (let entry = 0; entry < entries; entry++) {
    const row = column.indices[entry];
    if (row < lastRow) run = 0;
    lastRow = row;
    // The next run or two by a step, a farther one by galloping.
    if (run + 1 < runCount && runStarts[run + 1] <= row) {
      run++;
      if (run + 1 < runCount && runStarts[run + 1] <= row) run = gallop(runStarts, row + 1, run + 1) - 1;
    }
    if (run >= runCount || row < runStarts[run]) continue;
    const offset = row - runStarts[run];
    if (offset >= runBases[run + 1] - runBases[run]) continue;
    const value = column.values[entry];
    if (value === 0) continue;
    const cell = cellOf[runBases[run] + offset];
    if (count > 0 && cell < cells[count - 1]) ascending = false;
    cells[count] = cell;
    values[count++] = value;
  }
  cells = cells.subarray(0, count);
  values = values.subarray(0, count);
  // A subsample's cells are in priority order, not the file's: the entries
  // are put in cell order by two passes of a radix sort (stable, so entries
  // of one cell keep their order), not a comparator sort.
  if (!ascending) ({ cells, values } = byCell(cells, values));
  // Cells the map leaves unmeasured, counted once per map (not per column).
  const unmeasured = nObs - kept.sorted.length;
  if (unmeasured === 0) {
    return {
      length: nObs,
      indices: copyTypedArray(Uint32Array, cells, 'Gene column cells'),
      values: copyTypedArray(Float32Array, values, 'Gene column values'),
    };
  }
  const indices = allocateTypedArray(Uint32Array, count + unmeasured, 'Gene column cells');
  const out = allocateTypedArray(Float32Array, count + unmeasured, 'Gene column values');
  let at = 0;
  let next = 0;
  for (let cell = 0; cell < nObs; cell++) {
    if (rows[cell] >= 0) continue;
    while (next < count && cells[next] < cell) {
      indices[at] = cells[next];
      out[at++] = values[next++];
    }
    indices[at] = cell;
    out[at++] = Number.NaN;
  }
  for (; next < count; next++) {
    indices[at] = cells[next];
    out[at++] = values[next];
  }
  return { length: nObs, indices, values: out };
}

/** `cells` (uint32) and their `values`, stably sorted by cell: an LSD radix sort, 16 bits a pass. */
function byCell(cells, values) {
  const count = cells.length;
  let keys = cells;
  let payload = values;
  let nextKeys = allocateTypedArray(Uint32Array, count, 'Gene column cells');
  let nextPayload = allocateTypedArray(Float32Array, count, 'Gene column values');
  const buckets = new Uint32Array(1 << 16);
  for (const shift of [0, 16]) {
    buckets.fill(0);
    for (let i = 0; i < count; i++) buckets[(keys[i] >>> shift) & 0xffff]++;
    let sum = 0;
    for (let b = 0; b < buckets.length; b++) {
      const size = buckets[b];
      buckets[b] = sum;
      sum += size;
    }
    for (let i = 0; i < count; i++) {
      const at = buckets[(keys[i] >>> shift) & 0xffff]++;
      nextKeys[at] = keys[i];
      nextPayload[at] = payload[i];
    }
    [keys, nextKeys] = [nextKeys, keys];
    [payload, nextPayload] = [nextPayload, payload];
  }
  return { cells: keys, values: payload };
}

/** A placed sparse column as a dense one (zero where it lists no entry). */
export function denseOfSparse(column) {
  const dense = allocateTypedArray(Float32Array, column.length, 'Gene column');
  for (let entry = 0; entry < column.indices.length; entry++) dense[column.indices[entry]] = column.values[entry];
  return dense;
}

/**
 * A matrix's cell map through a subsample's kept rows (`rows`): cell `i`'s
 * row is the kept row of the row `modality` maps it to (its own position
 * when there is no modality map). Null when there are no kept rows to go
 * through; the modality's map alone then.
 *
 * @param {((options?: Object) => Promise<{rows: Int32Array|null, identity: boolean, measured: number}>)|null} modality
 * @param {CellRows|null} rows
 * @param {number} nCells - The cells the map is over (the reader's, or the modality's presented rows' owners)
 */
const composedMaps = new WeakMap();

export function composeCellMaps(modality, rows, nCells) {
  if (rows === null) return modality;
  // One map per subset and modality, whichever read asks: what is derived
  // from it (`keptRowsOf`) is then made once, not once per read.
  let byModality = composedMaps.get(rows);
  if (byModality === undefined) {
    byModality = new Map();
    composedMaps.set(rows, byModality);
  }
  const known = byModality.get(modality);
  if (known !== undefined) return known;
  // Made once, shared by every read asking meanwhile (`sharedOnce`).
  const map = sharedOnce(async options => {
    const base = modality === null ? null : await modality(options);
    const cells = base === null || base.rows === null ? null : base.rows;
    const n = cells === null ? nCells : cells.length;
    const mapped = allocateTypedArray(Int32Array, n, 'Modality rows');
    let measured = 0;
    for (let cell = 0; cell < n; cell++) {
      const row = cells === null ? cell : cells[cell];
      mapped[cell] = row < 0 ? -1 : rows.kept[row];
      if (row >= 0) measured++;
    }
    return { rows: mapped, identity: false, measured };
  });
  byModality.set(modality, map);
  return map;
}
