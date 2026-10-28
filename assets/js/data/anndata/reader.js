/**
 * The AnnData reader: one class that reads an AnnData dataset from an array
 * store (`formats/store.js`), whether the store is an `.h5ad` (HDF5) or an
 * AnnData Zarr store. It runs in the AnnData reader worker
 * (`anndata-reader-worker.js`); the main thread talks to it through
 * `AnnDataReaderClient` and never blocks on a file.
 *
 * Opening checks the dataset's structure from its metadata alone (the store
 * holds the whole node tree), reading only the obs and var indexes it needs.
 * A store of several modalities (`views/modalities.js`) adds one AnnData
 * group per modality: every expression read names its matrix by path
 * (`mod/<name>/X`), and a modality that measured only some cells is read
 * through its cell map.
 * Everything else is read when asked for, touching only what the request
 * needs: a field reads its arrays, a gene reads its column
 * (`matrix-access.js`), an embedding reads its columns.
 *
 * @module data/anndata/reader
 */

import { connectivityEdgesOf } from '../connectivity-edges.js';
import { EmbeddingPayloads } from '../embedding-payload.js';
import { DecodedChunks } from './decoded-chunks.js';
import {
  DEFAULT_KNN_KEY,
  requireObsmColumnSelection,
  requireObspKey,
} from '../data-mapping-candidates.js';
import { decodeAnnDataBoolean, isAnnDataMatrixDataKind, isAnnDataNumericValueKind } from '../anndata-value-kinds.js';
import {
  combineDatasetLifecycleFailures,
  createDatasetReloadSupersededError,
} from '../dataset-lifecycle-errors.js';
import { allocateTypedArray, copyTypedArray, sparseColumnOf, sparseColumnOfDense } from '../sparse-column-index.js';
import { yieldToMacrotask } from '../../utils/yield-macrotask.js';
import { createWorkerColumnStoreFactory } from '../column-store-placement.js';
import { onAbort } from '../../formats/io/abort.js';
import { residencyBudgetBytes } from '../memory-budget.js';
import { isGroup } from '../../formats/store.js';
import {
  NULLABLE_ENCODINGS,
  attributeValue,
  child,
  encodingType,
  numpyDtypeName,
  requireArray,
  requireExactStringAttribute,
  requireMapping,
  requirePrimitiveKind,
  shapeFromAttribute,
  shapeOf,
  validateArrayEncoding,
  validateDataFrame,
  validateOneDimensional,
  valueKind,
} from './elements.js';
import {
  categoryCount,
  nullableContract,
  probeColumns,
  readBooleanColumn,
  readCategories,
  readCodes,
  readDataFrameIndex,
  readGeneNameColumn,
  readNullableValues,
  resolveCategoricalColumn,
  validateColumnAxis,
  validateColumnEncoding,
  validateCodes,
} from './dataframe.js';
import { readSparseMatrix, sparseContract } from './sparse.js';
import { columnIndexResidentBytes, geneReadCost, openMatrixColumns, openMatrixRows, readCellSubset, readsThroughRowIndex } from './matrix-access.js';
import { SLAB_BYTES, readFloat32, readIntegers, readRowSlabs, readStored } from './values.js';
import { currentLayoutView, isOlderAnnDataLayout } from './older-layouts.js';
import { cellMapOf } from './views/modalities.js';
import { cellSubsetView, CellRows, estimatedChunkShare, keptChunkShare, keptValueCount, readInducedGraph } from './views/cell-subset.js';
import { resolveCellSubset } from './subsample-plan.js';
import { firstViewCost, planProgressiveOpening } from './progressive-open.js';
import {
  carriedSegments,
  entriesPerRow,
  firstSegmentRows,
  readRowPointers,
  rowRangeMatrix,
  segmentBounds,
  segmentedColumns,
  sharedBudgetFactory,
} from './prefix-column-index.js';
import { PRIORITY_ORIGINAL_COLUMN, readPrefixCounts, requirePrefixRows } from './priority-layout.js';
import { findKeptRuns, fingerprintRows, keepRun, keptIndexGroup, orderKey, rowChecksums } from './kept-column-index.js';
import { formatCount, formatCountOf } from '../../utils/format-units.js';
import { SharedWork, sharedOnce } from '../../formats/io/abort.js';

const OBS_KINDS = ['string', 'float', 'int', 'uint', 'bool'];

/** Why a cancelled read stopped: its own signal's reason, else an AbortError. */
function abortReason(signal) {
  return signal.reason ?? new DOMException('The read was cancelled.', 'AbortError');
}

/**
 * `promise`, or a rejection as soon as `signal` aborts: a read waiting on
 * shared work (a gene index other reads still need) stops waiting at once,
 * and the shared work goes on.
 */
function untilAborted(promise, signal) {
  if (signal === null || signal === undefined) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(abortReason(signal));
  }
  return new Promise((resolve, reject) => {
    const stopWaiting = onAbort(signal, () => reject(abortReason(signal)));
    promise.then(
      value => {
        stopWaiting();
        resolve(value);
      },
      error => {
        stopWaiting();
        reject(error);
      }
    );
  });
}

/** Distinct-or-repeated whole positions within `[0, extent)`, as an array. */
function requirePositions(values, extent, label) {
  if (!Array.isArray(values) && !ArrayBuffer.isView(values)) {
    throw new TypeError(`${label} positions must be an array`);
  }
  const positions = Array.from(values, Number);
  for (const position of positions) {
    if (!Number.isSafeInteger(position) || position < 0 || position >= extent) {
      throw new RangeError(`${label} ${String(position)} is outside [0, ${extent})`);
    }
  }
  return positions;
}

/**
 * One modality's gene column on the dataset's cells: NaN where the modality
 * did not measure a cell (not 0: "not measured" is not "measured zero").
 * `rows` is the cell map (`_cellsOf`), null when there is nothing to place.
 */
function placeColumn(column, rows, nObs) {
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
function placeSparseColumn(column, rows, nObs, nRows) {
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
 * 80 MB here, where a lookup of every stored row held 400 MB. Null for a map
 * that sends two cells to one row.
 */
const keptRowsByMap = new WeakMap();
function keptRowsOf(rows) {
  if (keptRowsByMap.has(rows)) return keptRowsByMap.get(rows);
  let measured = 0;
  for (let cell = 0; cell < rows.length; cell++) if (rows[cell] >= 0) measured++;
  // The rows sorted natively, then each cell placed at its row's position
  // (a comparator sort of a million cells took 160 ms).
  const sorted = allocateTypedArray(Uint32Array, measured, 'Measured rows');
  let at = 0;
  for (let cell = 0; cell < rows.length; cell++) if (rows[cell] >= 0) sorted[at++] = rows[cell];
  sorted.sort();
  let kept = { sorted, cells: allocateTypedArray(Int32Array, measured, 'Measured cells') };
  for (let i = 1; i < measured; i++) {
    if (sorted[i] === sorted[i - 1]) {
      kept = null;
      break;
    }
  }
  if (kept !== null) {
    // Runs of consecutive rows (a blocks subsample's are its blocks): a
    // column's entries are matched against the runs, not every kept row.
    const starts = [];
    const bases = [];
    for (let i = 0; i < measured; i++) {
      if (i === 0 || sorted[i] !== sorted[i - 1] + 1) {
        starts.push(sorted[i]);
        bases.push(i);
      }
    }
    kept.runStarts = Float64Array.from(starts);
    kept.runBases = Float64Array.from([...bases, measured]);
    // Each cell's position: its run (searched among the runs, few for
    // blocks) and its offset in it; cells in open order follow their runs,
    // so the last run found is tried first.
    const runStarts = kept.runStarts;
    const runBases = kept.runBases;
    let run = 0;
    for (let cell = 0; cell < rows.length; cell++) {
      const row = rows[cell];
      if (row < 0) continue;
      if (!(runStarts[run] <= row && row - runStarts[run] < runBases[run + 1] - runBases[run])) {
        let low = 0;
        let high = runStarts.length - 1;
        while (low < high) {
          const middle = (low + high + 1) >>> 1;
          if (runStarts[middle] <= row) low = middle;
          else high = middle - 1;
        }
        run = low;
      }
      kept.cells[runBases[run] + row - runStarts[run]] = cell;
    }
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
function denseOfSparse(column) {
  const dense = allocateTypedArray(Float32Array, column.length, 'Gene column');
  for (let entry = 0; entry < column.indices.length; entry++) dense[column.indices[entry]] = column.values[entry];
  return dense;
}

/** The genes of one row inside a column window, renumbered from the window's start. */
function windowRow(row, start, count, total) {
  if (start === 0 && count === total) return row;
  const genes = [];
  const values = [];
  for (let entry = 0; entry < row.genes.length; entry++) {
    const gene = row.genes[entry] - start;
    if (gene >= 0 && gene < count) {
      genes.push(gene);
      values.push(row.values[entry]);
    }
  }
  return { genes: Int32Array.from(genes), values: Float32Array.from(values) };
}

/**
 * A cell subset read over the cells a modality measured (`measured`: their
 * positions in the request, ascending) as the block of the whole request:
 * positions renumbered, and a NaN entry for every cell it did not measure.
 */
function placeCellSubset(block, measured, cellCount) {
  const genes = block.pointers.length - 1;
  const absent = [];
  let next = 0;
  for (let position = 0; position < cellCount; position++) {
    if (measured[next] === position) next++;
    else absent.push(position);
  }
  const total = block.cellIndex.length + genes * absent.length;
  const pointers = allocateTypedArray(Float64Array, genes + 1, 'Cell subset pointers');
  const cellIndex = allocateTypedArray(Int32Array, total, 'Cell subset positions');
  const values = allocateTypedArray(Float32Array, total, 'Cell subset values');
  let at = 0;
  for (let gene = 0; gene < genes; gene++) {
    pointers[gene] = at;
    let entry = block.pointers[gene];
    const end = block.pointers[gene + 1];
    let missing = 0;
    while (entry < end || missing < absent.length) {
      const stored = entry < end ? measured[block.cellIndex[entry]] : Infinity;
      if (missing < absent.length && absent[missing] < stored) {
        cellIndex[at] = absent[missing++];
        values[at++] = Number.NaN;
      } else {
        cellIndex[at] = stored;
        values[at++] = block.values[entry++];
      }
    }
  }
  pointers[genes] = at;
  return { pointers, cellIndex, values };
}

/**
 * Some cells of sparse gene columns as a gene-major sparse block
 * (`getMatrixCellSubset`'s): gene `g` has the cells of `cells` (by their
 * position in it, ascending) that `columns[g]` lists. Each column's entries
 * are matched to the cells in row order (the cells sorted once when they are
 * not ascending), so it holds the cells and the entries, never a column of
 * every cell.
 *
 * @param {Array<{indices: ArrayLike<number>, values: ArrayLike<number>}>} columns -
 *   Each gene's entries on the first rows (`SparseColumn`, rows ascending)
 * @param {ArrayLike<number>} cells - Distinct rows
 * @returns {{pointers: Float64Array, cellIndex: Int32Array, values: Float32Array}}
 */
function cellSubsetOfSparseColumns(columns, cells) {
  const n = cells.length;
  let ascending = true;
  for (let i = 1; i < n && ascending; i++) ascending = cells[i - 1] < cells[i];
  // The cells by row: `rows[j]`, at position `positions[j]` of `cells`.
  let positions = null;
  let rows = cells;
  if (!ascending) {
    positions = allocateTypedArray(Uint32Array, n, 'Cell order');
    for (let i = 0; i < n; i++) positions[i] = i;
    positions.sort((a, b) => cells[a] - cells[b]);
    rows = allocateTypedArray(Float64Array, n, 'Cell rows');
    for (let i = 0; i < n; i++) rows[i] = cells[positions[i]];
  }
  const each = (column, visit) => {
    const { indices } = column;
    let j = 0;
    for (let e = 0; e < indices.length && j < n; e++) {
      const row = indices[e];
      while (j < n && rows[j] < row) j++;
      if (j < n && rows[j] === row) visit(e, j);
    }
  };
  let count = 0;
  for (const column of columns) each(column, () => { count++; });
  const pointers = allocateTypedArray(Float64Array, columns.length + 1, 'Cell subset pointers');
  const cellIndex = allocateTypedArray(Int32Array, count, 'Cell subset positions');
  const values = allocateTypedArray(Float32Array, count, 'Cell subset values');
  let at = 0;
  columns.forEach((column, g) => {
    const from = at;
    each(column, (e, j) => {
      cellIndex[at] = ascending ? j : positions[j];
      values[at++] = column.values[e];
    });
    if (!ascending && at - from > 1) {
      // Ascending by position within the gene, as every block lists them.
      const order = allocateTypedArray(Uint32Array, at - from, 'Cell subset order');
      for (let k = 0; k < order.length; k++) order[k] = from + k;
      order.sort((a, b) => cellIndex[a] - cellIndex[b]);
      const sortedCells = allocateTypedArray(Int32Array, order.length, 'Cell subset positions');
      const sortedValues = allocateTypedArray(Float32Array, order.length, 'Cell subset values');
      for (let k = 0; k < order.length; k++) {
        sortedCells[k] = cellIndex[order[k]];
        sortedValues[k] = values[order[k]];
      }
      cellIndex.set(sortedCells, from);
      values.set(sortedValues, from);
    }
    pointers[g + 1] = at;
  });
  return { pointers, cellIndex, values };
}

/**
 * The prefix a gene-major matrix is opened as, or null: the dataset's own
 * `X` takes the opening's prefix `k`; a modality's, its kept rows' count `m`
 * when they are its first `m` rows (as a priority-ordered file stores a
 * modality: by its cells' priority).
 */
function openPrefixOf(prefix, keptRows, isModality) {
  if (prefix === null) return null;
  if (!isModality) return prefix;
  const m = keptRows.length;
  return m > 0 && keptRows[m - 1] === m - 1 ? m : null;
}

/**
 * The prefix counts an opening of the first `k` rows of a priority-ordered
 * file reads (`priority-layout.js`), started as it opens and awaited by the
 * first gene: for the dataset's `X` and each modality's, the column of the
 * smallest level holding `k` and the rows below that level (a modality's:
 * its rows of the cells below it, from its cell map's first rows). Keyed by
 * the matrix's path (`X`, `mod/<name>/X`); a matrix without counts is absent.
 */
function startPrefixReads(full, resolution, readOptions) {
  const reads = new Map();
  const { prefix: k, levels } = resolution;
  if (k === null || k === undefined || !Array.isArray(levels)) return reads;
  const level = levels.findIndex(size => size >= k);
  if (level < 0) return reads;
  const levelCells = levels[level];
  const start = (key, group, rowsBelow) => {
    const table = child(child(group, 'varm'), 'cellucid_prefix_counts');
    if (table === null) return;
    const read = rowsBelow.then(async levelRows => {
      const counts = await readPrefixCounts(group, level, table.shape?.[0], readOptions, { levelRows });
      return counts === null ? null : { counts, levelRows };
    });
    read.catch(() => {});
    reads.set(key, read);
  };
  start('X', full, Promise.resolve(levelCells));
  for (const modality of Array.isArray(full.modalities) ? full.modalities : []) {
    const group = full.get(`mod/${modality.name}`);
    const rowsBelow = modality.obsmap === null
      ? Promise.resolve(levelCells)
      : modality.obsmap.read([[0, levelCells]], readOptions).then(map => {
        let rows = 0;
        for (let i = 0; i < map.length; i++) if (Number(map[i]) > 0) rows++;
        return rows;
      });
    start(`mod/${modality.name}/X`, group, rowsBelow);
  }
  return reads;
}

/**
 * Children of `uns['cellucid']` the tree read leaves out: `session` is the
 * record the Python package's `apply_cellucid_session_to_anndata` keeps of a
 * session applied to the file, which can be large and which the viewer does
 * not use; `outlierQuantiles` holds one array per categorical field
 * (several MB each), so opening describes it (`describeStoredOutlierQuantiles`)
 * and a field's array is read only when its outlier filter is used
 * (`readStoredOutlierQuantiles`).
 */
const CELLUCID_UNREAD_KEYS = Object.freeze(['session', 'outlierQuantiles']);

/**
 * What `uns['cellucid']['outlierQuantiles']` holds, from its metadata and two
 * scalars: `{latentKey, minPoints, fields: {<obs key>: {shape, dtype}}}` as
 * plain JSON values (`anndata-cellucid-metadata.js` checks them). No field's
 * values are read.
 */
async function describeStoredOutlierQuantiles(node, readOptions) {
  const label = "uns['cellucid']['outlierQuantiles']";
  if (!isGroup(node)) throw unsCellucidError(`${label} must be a mapping`);
  const scalar = async key => (node.has(key) ? readUnsTree(node.get(key), `${label}['${key}']`, readOptions) : undefined);
  const [latentKey, minPoints] = await Promise.all([scalar('latentKey'), scalar('minPoints')]);
  const description = { latentKey, minPoints, fields: {} };
  for (const key of node.keys()) {
    if (key !== 'latentKey' && key !== 'minPoints' && key !== 'fields') description[key] = null;
  }
  if (node.has('fields')) {
    const fields = node.get('fields');
    if (!isGroup(fields)) throw unsCellucidError(`${label}['fields'] must be a mapping`);
    for (const key of fields.keys()) {
      const array = fields.get(key);
      description.fields[key] = array?.kind === 'array'
        ? { shape: [...array.shape], dtype: valueKind(array) === 'float' ? `float${8 * (array.dtype?.bytes ?? 0)}` : valueKind(array) }
        : { shape: null, dtype: 'group' };
    }
  } else {
    description.fields = undefined;
  }
  return description;
}

/** `uns['cellucid']` as plain JSON values, its stored outlier quantiles described. */
async function readUnsCellucid(node, readOptions) {
  const [cellucid, outliers] = await Promise.all([
    readUnsTree(node, "uns['cellucid']", readOptions, CELLUCID_UNREAD_KEYS),
    isGroup(node) && node.has('outlierQuantiles')
      ? describeStoredOutlierQuantiles(node.get('outlierQuantiles'), readOptions)
      : null,
  ]);
  if (outliers !== null) cellucid.outlierQuantiles = outliers;
  return cellucid;
}

/**
 * A refusal of what `uns['cellucid']` holds, written for the person who opened
 * the file and shown as it is (`explained`, which survives the worker's error
 * serialization).
 */
function unsCellucidError(message) {
  const error = new TypeError(
    `${message}. uns['cellucid'] is what a file says about itself for Cellucid; ` +
    'write it again with cellucid.prepare() in Python or cellucid_prepare() in R, or remove it.'
  );
  error.code = 'INVALID_FORMAT';
  error.details = { explained: true };
  return error;
}

/** One stored scalar as JSON would hold it. */
function unsScalar(value, kind, label) {
  if (kind === 'bool') return Boolean(value);
  if (kind === 'string') return value;
  if (typeof value === 'bigint') {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw unsCellucidError(`${label} is an integer beyond 2^53`);
    return number;
  }
  if (typeof value === 'number') return value;
  throw unsCellucidError(`${label} must hold text, numbers or booleans`);
}

/**
 * Read one `uns` subtree as plain JSON values: a mapping (an AnnData `dict`
 * group, or a plain group as files before anndata 0.8 write it) becomes an
 * object, a scalar array its value, a one-dimensional array a list. Anything
 * else (a dataframe, a matrix, an array of more dimensions) is refused, since
 * no Cellucid metadata is stored that way.
 *
 * @param {Object} node
 * @param {string} label - Where the node is, for messages
 * @param {Object} readOptions
 * @param {ReadonlyArray<string>} [unread] - Children of this node left unread
 * @returns {Promise<unknown>}
 */
async function readUnsTree(node, label, readOptions, unread = []) {
  if (isGroup(node)) {
    const declared = encodingType(node);
    if (declared !== '' && declared !== 'dict') {
      throw unsCellucidError(`${label} is stored as '${declared}'; it must be a mapping (a dict), a list or a single value`);
    }
    const keys = node.keys().filter(key => !unread.includes(key));
    const values = await Promise.all(keys.map(key => readUnsTree(node.get(key), `${label}['${key}']`, readOptions)));
    const object = {};
    keys.forEach((key, index) => { object[key] = values[index]; });
    return object;
  }
  if (node?.kind !== 'array') throw unsCellucidError(`${label} must be a mapping, a list or a single value`);
  const kind = valueKind(node);
  if (!['string', 'float', 'int', 'uint', 'bool'].includes(kind)) {
    throw unsCellucidError(`${label} must hold text, numbers or booleans`);
  }
  if (node.shape.length > 1) {
    throw unsCellucidError(`${label} is a ${node.shape.length}-dimensional array; it must be a list or a single value`);
  }
  const value = await node.read(undefined, readOptions);
  if (node.shape.length === 0) return unsScalar(value, kind, label);
  return Array.from(value, element => unsScalar(element, kind, label));
}

/**
 * `uns['title']` as a file names itself (every CELLxGENE file does), else
 * null: a string, or a one-element string array as R writers and anndata 0.6
 * leave it. A title that cannot be read is no title.
 */
async function readUnsTitle(root, readOptions) {
  const title = child(child(root, 'uns'), 'title');
  if (title?.kind !== 'array' || valueKind(title) !== 'string') return null;
  if (!title.shape.every(extent => extent === 1)) return null;
  let value;
  try {
    value = await title.read(undefined, readOptions);
    if (typeof value !== 'string') value = value?.[0];
  } catch (error) {
    // A title only names the dataset: one that cannot be read is no title,
    // and never stops the file from opening.
    console.warn(`[AnnDataReader] uns['title'] could not be read; the file name is used instead (${error?.message ?? error})`);
    return null;
  }
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The colours Scanpy keeps for one categorical obs field,
 * `uns['<key>_colors']` (one colour per category, in category order, as
 * `sc.pl.*` writes them), as the stored text; null when the file has none.
 * Which entries are colours, and whether there are enough of them, is the
 * page's to judge (`scanpyCategoryPalette`). A palette that cannot be read
 * is no palette: the field is still shown, in Cellucid's colours.
 *
 * @param {Object} root
 * @param {string} key
 * @param {{signal?: AbortSignal|null}} readOptions
 * @returns {Promise<string[]|null>}
 */
async function readObsFieldColors(root, key, readOptions) {
  const node = child(child(root, 'uns'), `${key}_colors`);
  if (node?.kind !== 'array' || valueKind(node) !== 'string' || node.shape.length !== 1) return null;
  try {
    const values = await node.read(undefined, readOptions);
    return Array.from(values, value => String(value));
  } catch (error) {
    if (readOptions.signal?.aborted) throw error;
    console.warn(`[AnnDataReader] uns['${key}_colors'] could not be read; '${key}' is shown in Cellucid's colours (${error?.message ?? error})`);
    return null;
  }
}

/**
 * `uns['log1p']` as `sc.pp.log1p` records it: null when the file has none,
 * else `{base}`, null for the natural logarithm. Scanpy writes `base` as None
 * for e, which anndata stores as nothing; a base that is not a positive
 * number other than 1 is not a base a logarithm has, and reads as e too.
 *
 * @returns {Promise<{base: number|null}|null>}
 */
async function readLog1pRecord(root, readOptions) {
  const record = child(child(root, 'uns'), 'log1p');
  if (record === null || record === undefined) return null;
  const node = isGroup(record) ? child(record, 'base') : null;
  if (node?.kind !== 'array' || !['float', 'int', 'uint'].includes(valueKind(node))) return { base: null };
  if (!node.shape.every(extent => extent === 1)) return { base: null };
  let value = await node.read(undefined, readOptions);
  if (typeof value !== 'number' && typeof value !== 'bigint') value = value?.[0];
  const base = Number(value);
  return { base: Number.isFinite(base) && base > 0 && base !== 1 ? base : null };
}

/**
 * What a dataset catalog lists about one AnnData store, read from its
 * metadata and `uns` alone: its cell and gene counts (from the expression
 * matrix's shape, else the dataframe indexes' shapes), `uns['title']` and
 * `uns['cellucid']` as stored. No index, matrix or column is read, so
 * describing a large remote store costs its metadata and a few small reads.
 *
 * @param {Object} store - An opened store root (`openHdf5` / `openZarr`)
 * @param {{format: import('./elements.js').AnnDataFormat}} options
 * @param {Object} [readOptions]
 * @returns {Promise<{nObs: number, nVars: number, hasExpressionMatrix: boolean,
 *   title: string|null, cellucid: Object|null}>}
 */
export async function describeAnnDataStore(store, { format }, readOptions = {}) {
  if (!isGroup(store)) throw new TypeError('An AnnData store is described by its root group.');
  const root = isOlderAnnDataLayout(store) ? currentLayoutView(store) : store;
  requireExactStringAttribute(root, 'encoding-type', 'anndata', `${format.file} root`);
  if (!root.has('obs') || !root.has('var')) {
    throw new Error(`${format.file} obs and var are required and must be current AnnData dataframes`);
  }
  const extentOf = (frame, label) => {
    const { indexKey } = validateDataFrame(frame, format, label);
    return shapeOf(frame.get(indexKey), `${label} index`, 1)[0];
  };
  let nObs;
  let nVars;
  const hasExpressionMatrix = root.has('X');
  if (hasExpressionMatrix) {
    const X = root.get('X');
    [nObs, nVars] = isGroup(X) ? sparseContract(X, format, 'Sparse X').shape : shapeOf(X, 'Dense X', 2);
  } else {
    nObs = extentOf(root.get('obs'), `${format.file} obs`);
    nVars = extentOf(root.get('var'), `${format.file} var`);
  }
  const unsCellucid = child(child(root, 'uns'), 'cellucid');
  const [title, cellucid] = await Promise.all([
    readUnsTitle(root, readOptions),
    unsCellucid === null ? null : readUnsCellucid(unsCellucid, readOptions),
  ]);
  return { nObs, nVars, hasExpressionMatrix, title, cellucid };
}

/**
 * What a person reads while a cell-major matrix (CSR, or dense in row
 * chunks) is read by gene: why one gene costs the whole matrix, and, when no
 * index of it can be kept (`rescan`: why), that every gene scans it again
 * and what makes the index fit.
 *
 * @param {string} label - `X`, `layers['counts']`, `raw.X`
 * @param {string|null} rescan
 * @returns {string}
 */
export function geneIndexActivityLabel(label, rescan) {
  if (rescan === null) {
    return `${label} by gene (stored cell by cell, so one gene reads every cell's entries; ` +
      'genes after it read the index this builds)';
  }
  return `${label} again for the genes asked for (${rescan}, so each gene reads every cell's entries; ` +
    'opening a subsample of the cells makes the index fit)';
}

/**
 * Describe one AnnData element from its metadata, for the data-mapping
 * catalog. Nothing is read and nothing is refused: an element this reader
 * cannot classify is storage `other`, and one whose metadata it cannot read
 * carries the reason (`problem`), which the catalog shows.
 */
function probeElement(key, node) {
  const other = { key, storage: 'other', shape: null, dtype: 'object', numeric: false, nnz: null };
  try {
    if (node?.kind === 'array') {
      return {
        key,
        storage: 'dense',
        shape: shapeOf(node, key),
        dtype: numpyDtypeName(node),
        numeric: isAnnDataNumericValueKind(valueKind(node)),
        nnz: null,
      };
    }
    if (!isGroup(node)) return other;
    const declared = encodingType(node);
    if (declared === 'csr_matrix' || declared === 'csc_matrix') {
      const shape = shapeFromAttribute(attributeValue(node, 'shape'), key);
      // A subsample's CSR matrix not read yet: its stored values are not
      // known (its kept rows' pointers are read with the matrix).
      if (node.rowPointersPending?.() === true) {
        const stored = node.storedData();
        return {
          key,
          storage: declared.slice(0, 3),
          shape,
          dtype: numpyDtypeName(stored),
          numeric: isAnnDataNumericValueKind(valueKind(stored)),
          nnz: null,
        };
      }
      const data = child(node, 'data');
      if (data?.kind !== 'array') return { ...other, storage: declared.slice(0, 3), shape };
      return {
        key,
        storage: declared.slice(0, 3),
        shape,
        dtype: numpyDtypeName(data),
        numeric: isAnnDataNumericValueKind(valueKind(data)),
        nnz: shapeOf(data, key)[0] ?? null,
      };
    }
    if (declared === 'dataframe') {
      const indexKey = attributeValue(node, '_index');
      const columnOrder = attributeValue(node, 'column-order');
      const index = typeof indexKey === 'string' ? child(node, indexKey) : null;
      const rows = index?.kind === 'array' ? shapeOf(index, key)[0] : null;
      const columns = Array.isArray(columnOrder) ? columnOrder.length : null;
      return {
        ...other,
        storage: 'dataframe',
        shape: rows === null || rows === undefined || columns === null ? null : [rows, columns],
      };
    }
  } catch (error) {
    // Its metadata is malformed: the catalog lists it as unusable, saying why.
    return { ...other, problem: error?.message ?? String(error) };
  }
  return other;
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
function composeCellMaps(modality, rows, nCells) {
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

/**
 * Reads one AnnData dataset. One instance reads one store; it lives in the
 * AnnData reader worker.
 */
export class AnnDataReader {
  constructor() {
    /**
     * Whole decoded chunks the subsample view reads its kept rows through
     * (`decoded-chunks.js`): the store's, kept within its decoded-chunk
     * budget beside its own cache, carried to each opening of the same
     * store (a progressive opening's steps copy their added rows out of
     * chunks earlier steps decoded), let go with the store.
     * @type {DecodedChunks|null}
     */
    this._decodedChunks = null;
    /**
     * Work on the reader thread someone waits for running now (a graph's
     * extraction), and what waits for there to be none: an index built
     * ahead of need takes the reader thread only between them
     * (`_yieldToForeground`). Only work that never waits for an index counts.
     */
    this._foreground = 0;
    this._foregroundIdle = [];
    /** @type {Object|null} The store root, in the current layout */
    this._root = null;
    /** @type {Object|null} The store as opened (closed with the reader) */
    this._store = null;
    /** @type {import('./elements.js').AnnDataFormat|null} */
    this._format = null;
    this._name = null;
    /** @type {import('../../formats/io/link.js').LinkMeter|null} The link to the store (see `open`) */
    this._link = null;
    this._nObs = 0;
    this._nVars = 0;
    this._obsKeys = [];
    /**
     * The var index as stored: names, possibly repeated. The adapter makes
     * them unique with the data-mapping rule (`makeUniqueNames`).
     * @type {string[]}
     */
    /** @type {Map<string, Object>} Field types, categories, names */
    this._cache = new Map();
    /**
     * The expression matrices whose columns are read, and how each one's
     * columns are reached, least recently read first. The matrix read now
     * is the last; a built gene index of an earlier one is kept while every
     * kept index fits the `columnIndex` memory budget, so switching back to
     * it reads nothing again (`_settleMatrices`).
     * @type {Map<string, {element: string, columns: Object|null, load: import('../../formats/io/abort.js').SharedWork|null}>}
     */
    this._matrices = new Map();
    /**
     * The modalities of a multimodal store (`views/modalities.js`), by
     * name, each with its cell map, and the one it opens with; null for a
     * store of one feature space.
     * @type {Map<string, {modality: Object, cells: Function}>|null}
     */
    this._modalities = null;
    this._defaultModality = null;
    /** @type {Promise<string|null>|null} `uns['title']`, read while opening */
    this._title = null;
    /**
     * `uns['cellucid']` as stored (`readUnsTree`), or null when the file has
     * none; read while opening and validated by the adapter
     * (`anndata-cellucid-metadata.js`).
     * @type {Promise<Object|null>|null}
     */
    this._cellucid = null;
    /**
     * Row access (one cell's genes) to one matrix; like `_matrix`, one at a
     * time.
     * @type {{element: string, rows: Promise<Object>}|null}
     */
    this._rows = null;
    /**
     * Column pointers of a CSC matrix being read ahead of its first gene, by
     * element: `X`'s are read while the dataset opens, beside its indexes,
     * so the first gene shown is one round trip.
     * @type {Map<string, Promise<ArrayLike<number>>>}
     */
    this._pointerReads = new Map();
    /**
     * The cells this reader presents (`subsample-plan.js`): every cell
     * (`kept` null), or a subsample, whose view (`views/cell-subset.js`)
     * is `_root`; `_fullRoot` is the store as stored, for what is read of
     * every cell (a field's representation in the subsample).
     * @type {(import('./subsample-plan.js').CellSubsetResolution & {rows: CellRows|null, keptValues: number|null})|null}
     */
    this._cellSubset = null;
    this._fullRoot = null;
    /**
     * The prefix counts an opening of a priority-ordered file's first rows
     * reads as it opens (`startPrefixReads`), by matrix path.
     * @type {Map<string, Promise<{counts: Float64Array, levelRows: number}|null>>}
     */
    this._prefixReads = new Map();
    /**
     * The row pointers of the store's CSR matrices, by path, read whole:
     * they do not depend on the cells open, so another opening of the same
     * store takes them over (`open`'s `carry`).
     * @type {Map<string, Float64Array>}
     */
    this._indptrs = new Map();
    /** Kept rows' pointers an earlier subsample of the same store read (`cellSubsetView`). */
    this._knownRowPointers = new Map();
    /**
     * Gene columns an earlier opening of the same store built that this
     * one's cells keep (`_takeCarried`), by matrix element, until the matrix
     * is first read: `{segments}` (a prefix of rows, `prefix-column-index.js`)
     * or `{columns}` (the same rows, the whole access).
     * @type {Map<string, {segments?: Array, columns?: Object}>}
     */
    this._carried = new Map();
    /**
     * Where the gene indexes of this store's cell-major matrices are kept in
     * this browser across visits (`kept-column-index.js`): `{identity, tab,
     * onStore, environment}`, the bytes' identity (`openDatasetStore`); null
     * keeps none.
     * @type {{identity: Object, tab?: string, onStore?: Function|null, environment: Object}|null}
     */
    this._keptIndexes = null;
    /**
     * The kept runs of each matrix's index found for this opening and not
     * yet taken by its index (`_keptRunsOf`), by matrix element.
     * @type {Map<string, Promise<import('./kept-column-index.js').KeptRun[]>>}
     */
    this._keptRuns = new Map();
    /** @type {Set<Promise<void>>} Runs of built indexes being kept (`_keepRun`). */
    this._keeping = new Set();
    /**
     * How much of each neighbour graph read the subsample keeps
     * (`subsampleGraphShare`), by `obsp` key.
     * @type {Map<string, {kept: number, of: number}>}
     */
    this._graphShares = new Map();
    this._generation = 0;
    this._openRequestId = 0;
    this._closed = false;
    /** Where gene-column indexes are kept (memory, else disk). */
    this.columnStoreFactory = createWorkerColumnStoreFactory();
    /**
     * Makes the activity (`formats/io/activity.js`) one operation reads
     * under, so what each read fetched and decoded is counted and reported;
     * null counts nothing.
     * @type {((what: {kind: string, label: string}) => import('../../formats/io/activity.js').ReadActivity)|null}
     */
    this.createActivity = null;
    /**
     * Embedding and vector-field payloads made from `obsm` columns
     * (`embedding-payload.js`), forgotten whenever the caches are cleared.
     */
    this._payloads = new EmbeddingPayloads(
      (key, columns, options) => this.readObsmColumns(key, columns, options),
      { cellCount: () => this._nObs, generation: () => this._generation }
    );
  }

  /**
   * Run `operation(readOptions)` under one activity of `kind` named `label`,
   * read for the job `owner` (if any), finished with the outcome. `signal`
   * cancels it: its reads stop, and so does any wait on shared work. @private
   */
  async _track(kind, label, operation, signal = null, owner = null, keys = null) {
    const activity = this.createActivity?.({ kind, label, owner, keys }) ?? null;
    try {
      if (signal?.aborted) throw abortReason(signal);
      const result = await untilAborted(operation({ activity, signal }), signal);
      activity?.finish();
      return result;
    } catch (error) {
      activity?.finish(error);
      throw error;
    }
  }

  /** Run `work` as an operation someone waits for (see `_yieldToForeground`). @private */
  async _inForeground(work) {
    this._foreground++;
    try {
      return await work();
    } finally {
      if (--this._foreground === 0) {
        const waiting = this._foregroundIdle;
        this._foregroundIdle = [];
        for (const resolve of waiting) resolve();
      }
    }
  }

  /**
   * Where an index built ahead of need yields between parts of its work:
   * after a macrotask, and, while no read waits for the index (`waited`),
   * until no extraction someone waits for runs (`_inForeground`). The
   * index's work is the reader thread's, and a graph's extraction took turns
   * with it (Suo's neighbour graph: 0.8 s while the index of the cells asked
   * for before it was built, 0.4 s alone). Reads are not counted: one may
   * wait for the index itself.
   * @private
   */
  async _yieldToForeground(waited) {
    await yieldToMacrotask();
    while (!waited && this._foreground > 0) {
      await new Promise(resolve => this._foregroundIdle.push(resolve));
    }
  }

  _assertOpenRequest(requestId) {
    if (requestId !== this._openRequestId) {
      throw createDatasetReloadSupersededError(`${this._format?.file ?? 'AnnData'} open request was superseded or closed.`);
    }
  }

  /**
   * Open one store.
   *
   * @param {Object} store - An opened store root (`openHdf5` / `openZarr`), with `close()`
   * @param {{format: import('./elements.js').AnnDataFormat, name: string, decodedChunkBytes?: number,
   *   decodedBudget?: import('../../formats/io/decoded-budget.js').DecodedBudget|null,
   *   link?: import('../../formats/io/link.js').LinkMeter|null}} options
   *   `decodedBudget`: the byte budget the store's own decoded-chunk cache
   *   charges (`openDatasetStore`), which the whole chunks a subsample's
   *   rows are read through share (`decoded-chunks.js`); without one they
   *   keep `decodedChunkBytes` of their own.
   *   `link`: the link to the store, measured as it is read (`openDatasetStore`).
   *   Over a link that delivers bytes as fast as a disk (`link.readsAhead`), a
   *   cell-major matrix is indexed by gene as soon as it is prepared, values
   *   with the structure, as a local file is; over a slower one, the index
   *   waits for the first gene and reads values only where genes need them,
   *   so opening downloads nothing a view has not asked for. A store without
   *   a link (one built in memory) has nothing between it and the reader and
   *   is read ahead.
   *   `activity`: the activity that opening the store started, which reading
   *   the AnnData structure continues (else it gets its own).
   *   `carry`: the reader of an earlier opening of the same store (other
   *   cells of it, read again in place): what it read that does not depend
   *   on the cells (row pointers, a CSC matrix's column pointers), and the
   *   gene indexes of the rows both openings share, are taken over
   *   (`_takeCarried`) instead of read again. `previous`: the reader of an
   *   earlier opening of the same dataset whose store could not be taken
   *   over (`carry` null): an opening grown or cut in place still keeps its
   *   embeddings' frame (`EmbeddingPayloads.adoptTransforms`). `signal`
   *   stops the opening.
   *   `keptIndexes`: `{identity, tab?, onStore?, environment?}`, what the
   *   store's bytes are (`openDatasetStore`'s `identity`): the gene indexes
   *   of its cell-major matrices are kept in this browser under it and found
   *   again by a later opening of the same cells (`kept-column-index.js`);
   *   `onStore({directory, state})` hears each kept directory as it is
   *   written and completed (the page holds it for the tab's life).
   */
  async open(store, { format, name, decodedChunkBytes = residencyBudgetBytes('decodedBlocks'), decodedBudget = null, link = null, activity = null, cellSubset = null, carry = null, previous = null, keptIndexes = null, signal = null }) {
    if (!isGroup(store)) throw new TypeError('An AnnData reader opens a store root group.');
    const requestId = ++this._openRequestId;
    const candidate = new AnnDataReader();
    candidate._format = format;
    candidate._name = name;
    candidate._store = store;
    candidate._decodedChunkBytes = decodedChunkBytes;
    candidate._link = link;
    candidate._keptIndexes = keptIndexes?.identity == null ? null : {
      identity: keptIndexes.identity,
      // Kept for one tab only (an identity naming no version): the page's tab.
      tab: keptIndexes.tab ?? undefined,
      onStore: keptIndexes.onStore ?? null,
      environment: keptIndexes.environment ?? globalThis,
    };
    candidate.createActivity = this.createActivity;
    try {
      // A file written before anndata 0.8 is read through its current-layout
      // view; everything below reads one layout.
      candidate._root = isOlderAnnDataLayout(store) ? currentLayoutView(store) : store;
      // The store's decoded chunks (`decoded-chunks.js`): an opening of the
      // same store (a growth's next step) reads its added rows out of them,
      // holding them beside the earlier opening (several may be live at
      // once: a reopen in flight while another commits), so they go only
      // once the last opening holding them closes.
      candidate._decodedChunks = carry?._decodedChunks?.retain() ?? new DecodedChunks(decodedBudget ?? decodedChunkBytes);
      if (carry !== null) {
        for (const [path, pointers] of carry._indptrs) candidate._indptrs.set(path, pointers);
        // The kept rows' pointers its subsample read: a raise or a lowering
        // of the same store reads only the rows they do not hold.
        candidate._knownRowPointers = carry._root?.knownRowPointers?.() ?? new Map();
        for (const [element, pointers] of carry._pointerReads) {
          if (!element.startsWith('mod/')) candidate._pointerReads.set(element, pointers);
        }
        // What was read of the store whatever its cells: the gene names of
        // each var axis (the var index among them), and each categorical
        // field's counts over every cell
        // (`subsampleRepresentation`). A progressive opening reopens at each
        // step; these are not read again.
        for (const [key, value] of carry._cache) {
          if (key.startsWith('var_names:') || key.startsWith('obs_counts:')) candidate._cache.set(key, value);
        }
      }
      const structure = async options => {
        await candidate._openCells(cellSubset, options);
        // The open cells' original positions (a priority-ordered file) are
        // read beside the structure, not before it.
        await Promise.all([candidate._readStructure(options, carry), candidate._settleOpenOrder()]);
      };
      if (activity === null) {
        await candidate._track('open', `the structure of ${name}`, structure, signal);
      } else {
        await structure({ activity, signal });
      }
      // A cancelled opening takes nothing over from the earlier one, even
      // when a read of it did not stop.
      if (signal?.aborted) throw abortReason(signal);
      this._assertOpenRequest(requestId);
      const earlier = carry ?? previous;
      const shared = earlier === null ? 0 : candidate._sharedRows(earlier);
      if (carry !== null) candidate._takeCarried(carry, shared);
      this._adopt(candidate);
      // An opening grown or cut in place -- its first cells are all of the
      // earlier one's, or its cells are all among the earlier one's first --
      // shows every embedding in the frame those cells were shown in, so
      // none of them moves (`EmbeddingPayloads.adoptTransforms`), whether or
      // not the store itself could be taken over.
      // The same cells in another order (a subsample grown from few chunks
      // put in priority order, `progressive-open.js`) keep it likewise.
      if (earlier !== null && ((shared > 0 && shared === Math.min(earlier._nObs, this._nObs)) || this._sameCells(earlier))) {
        this._payloads.adoptTransforms(earlier._payloads);
      }
      const subset = this._cellSubset;
      console.log(`[AnnDataReader] Opened ${name}: ${formatCountOf(this._nObs, 'cell')}${subset?.kept ? ` of ${subset.nObs}` : ''}, ${formatCountOf(this._nVars, 'gene')}`);
    } catch (error) {
      let terminal = error instanceof Error && error.message.length > 0
        ? error
        : new TypeError(`${format.file} opening must reject with a non-empty Error.`, { cause: error });
      try {
        candidate._store = null;
        // Its hold on the decoded chunks goes; the earlier opening keeps its own.
        candidate.close();
      } catch (cleanupFailure) {
        terminal = combineDatasetLifecycleFailures(terminal, cleanupFailure, `${format.file} opening and candidate cleanup both failed.`);
      }
      throw terminal;
    }
  }

  _adopt(candidate) {
    // This reader's hold on its decoded chunks goes; the candidate's becomes its own.
    this._decodedChunks?.release();
    this._decodedChunks = null;
    this._releaseCurrentState();
    for (const key of ['_root', '_store', '_format', '_name', '_nObs', '_nVars', '_obsKeys', '_cache', '_matrices', '_decodedChunkBytes', '_title', '_cellucid', '_link', '_pointerReads', '_modalities', '_defaultModality', '_cellSubset', '_fullRoot', '_indptrs', '_carried', '_graphShares', '_prefixReads', '_keptIndexes', '_keptRuns', '_decodedChunks']) {
      this[key] = candidate[key];
    }
    this._closed = false;
    candidate._root = null;
    candidate._fullRoot = null;
    candidate._store = null;
    candidate._decodedChunks = null;
  }

  /** The file row of open cell `i` (every row in file order when no subset is open). @private */
  _fileRowAt(i) {
    const rows = this._cellSubset?.fileRows ?? null;
    return rows === null ? i : rows[i];
  }

  /**
   * Take over from `previous` (an earlier opening of the same store, about
   * to close) the gene columns of the dataset's own matrices that this
   * opening's cells keep: open rows `[0, L)` are the same file rows in both
   * (`L` their shared prefix; a larger or smaller subsample of the same
   * method and seed shares all of the smaller one, `priorityOrder`). A
   * matrix indexed in segments (`prefix-column-index.js`) keeps the segments
   * within `L`; one indexed whole is kept when both open the same rows.
   * What is not kept is `previous`'s to release. Returns `L`. @private
   */
  _takeCarried(previous, shared) {
    const nPrevious = previous._nObs;
    const sameRows = shared === nPrevious && shared === this._nObs;
    for (const [element, state] of [...previous._matrices]) {
      const columns = state.columns?.source ?? null;
      if (columns === null || element.startsWith('mod/')) continue;
      if (Array.isArray(columns.segments) && this._cellSubset?.ordered === true && previous._cellSubset?.ordered === true) {
        if (shared === 0) continue;
        previous._matrices.delete(element);
        this._carried.set(element, { segments: carriedSegments(columns, shared) });
      } else if (sameRows) {
        previous._matrices.delete(element);
        this._carried.set(element, { columns });
      }
    }
    return shared;
  }

  /**
   * Whether this opening and `previous` (an earlier opening of the same
   * dataset) open the same cells, in any order. @private
   */
  _sameCells(previous) {
    const mine = this._cellSubset?.kept ?? null;
    const theirs = previous._cellSubset?.kept ?? null;
    if (this._nObs !== previous._nObs || mine === null || theirs === null || mine.length !== theirs.length) return false;
    for (let i = 0; i < mine.length; i++) if (mine[i] !== theirs[i]) return false;
    return true;
  }

  /**
   * How many of the first open rows this opening and `previous` (an earlier
   * opening of the same dataset) share: the largest `L` such that open rows
   * `[0, L)` are the same file rows in both. @private
   */
  _sharedRows(previous) {
    const limit = Math.min(previous._nObs, this._nObs);
    let shared = 0;
    while (shared < limit && previous._fileRowAt(shared) === this._fileRowAt(shared)) shared++;
    return shared;
  }

  /**
   * Gene columns of a cell-major matrix whose rows are in priority order,
   * indexed in segments (`prefix-column-index.js`): the segments an earlier
   * opening carried over (`_carried`), then new ones to the last row. @private
   */
  async _segmentedColumns(resolved, readOptions) {
    const { node: matrix, label, nRows, sourceVars, key: element } = resolved;
    const pointers = await this._openRowPointers(matrix, readOptions);
    const segments = [...(this._carried.get(element)?.segments ?? [])];
    this._carried.delete(element);
    // Each segment's store is placed with what the built ones before it left.
    const storeFactory = sharedBudgetFactory(this.columnStoreFactory, () => segments
      .filter(segment => segment.access.built?.() === true)
      .reduce((sum, segment) => sum + (segment.access.residentBytes?.() ?? 0), 0));
    let start = segments.length === 0 ? 0 : segments.at(-1).start + segments.at(-1).rows;
    // Runs of the rows after those an earlier opening carried over, kept in
    // this browser (a later visit, or another subsample of the same method
    // and seed); the rest is built in doubling segments, each kept as it is.
    const runs = await this._takeKeptRuns(resolved, () => Promise.resolve(pointers));
    const first = firstSegmentRows(nRows, entriesPerRow(matrix, nRows));
    try {
      while (start < nRows) {
        let run = runs.find(item => item.start === start) ?? null;
        let end = run === null ? segmentBounds(start, nRows, first)[0] : start + run.rows;
        const next = runs.find(item => item.start > start);
        if (run === null && next !== undefined) end = Math.min(end, next.start);
        const segmentStart = start;
        const segment = rowRangeMatrix(matrix, start, end, pointers);
        // A segment whose genes are read as stored (a dense one in strips
        // the decoded-chunk budget holds) has no index: its run is let go.
        if (run !== null && !readsThroughRowIndex(segment, { nObs: end - start, nVars: sourceVars, decodedChunkBytes: this._decodedChunkBytes })) {
          runs.splice(runs.indexOf(run), 1);
          run.kept.release();
          run = null;
        }
        const access = await openMatrixColumns(segment, {
          format: this._format,
          label,
          nObs: end - start,
          nVars: sourceVars,
          decodedChunkBytes: this._decodedChunkBytes,
          indexOptions: {
            ...this._indexOptions(),
            storeFactory,
            // Built by a pass (no run kept, or the kept run found damaged): kept,
            // with the fingerprint the pass takes of its rows.
            fingerprintRows: fingerprintRows(end - start),
            onBuilt: (store, fingerprint) => this._keepRun(resolved, segmentStart, end, pointers, store, fingerprint),
            ...(run === null ? {} : { kept: run.kept }),
          },
          onIndexStart: (indexLabel, { rescan = null } = {}) => this.createActivity?.({
            kind: 'index',
            label: geneIndexActivityLabel(label, rescan),
            background: rescan === null,
          }) ?? null,
          readOptions: { activity: readOptions.activity ?? null },
        });
        // Its index holds it now, and lets it go when it is disposed.
        if (run !== null) runs.splice(runs.indexOf(run), 1);
        const residentBytes = columnIndexResidentBytes({
          layout: isGroup(matrix) ? 'sparse' : 'dense',
          nnz: pointers === null ? 0 : pointers[end] - pointers[start],
          nObs: end - start,
          nVars: sourceVars,
          valuesOnDemand: !this._readsAhead(),
        });
        segments.push({ start, rows: end - start, access, residentBytes });
        start = end;
      }
    } finally {
      // Runs this opening did not use (they start inside rows carried over,
      // or the segments failed to open).
      for (const run of runs) run.kept.release();
    }
    // Unbuilt segments are built together when their indexes fit what the
    // budget leaves beside the built ones (`storeFactory.memoryBudgetBytes`).
    const together = unbuilt => unbuilt.reduce((sum, segment) => sum + (segment.residentBytes ?? Infinity), 0) <= storeFactory.memoryBudgetBytes;
    return segmentedColumns({ nRows, segments, together });
  }

  /**
   * The file rows of the open rows of a matrix whose index can be kept in
   * this browser (`kept-column-index.js`): the dataset's own matrices read
   * whole by their rows (all open rows, in the order they are open), and a
   * modality's when every cell is open; null for any other (a column
   * window, a subsample's gene-major matrix read through its rows, a
   * modality's rows of a subsample). @private
   */
  _keptRowsOf(resolved) {
    if (this._keptIndexes === null || resolved.start !== 0 || resolved.throughCells || (resolved.prefix ?? null) !== null) return null;
    const fileRows = this._cellSubset?.fileRows ?? null;
    if (resolved.key.startsWith('mod/') && fileRows !== null) return null;
    return {
      fileRows,
      of: (start, end) => {
        if (fileRows !== null) return fileRows.subarray(start, end);
        const rows = allocateTypedArray(Uint32Array, end - start, 'File rows');
        for (let i = 0; i < rows.length; i++) rows[i] = start + i;
        return rows;
      },
    };
  }

  /** The group a matrix's kept index is filed under (`keptIndexGroup`). @private */
  _keptGroup(resolved) {
    const subset = (this._cellSubset?.fileRows ?? null) !== null;
    return keptIndexGroup({
      file: this._keptIndexes.identity,
      element: resolved.key,
      // The matrix as stored: every row of the file (a subsample keeps some).
      shape: [resolved.key.startsWith('mod/') || !subset ? resolved.nRows : this._cellSubset.nObs, resolved.sourceVars],
      order: orderKey(this._cellSubset?.spec ?? null, subset),
    });
  }

  /**
   * The kept runs of a matrix's index this opening can use
   * (`findKeptRuns`), found once and held until its index takes them
   * (`_takeKeptRuns`) or the opening ends. `pointers()`: the open rows' row
   * pointers (read only when a kept run is checked). @private
   */
  _keptRunsOf(resolved, pointers) {
    const rows = this._keptRowsOf(resolved);
    if (rows === null) return Promise.resolve([]);
    let found = this._keptRuns.get(resolved.key);
    if (found === undefined) {
      const { tab, environment } = this._keptIndexes;
      found = findKeptRuns(this._keptGroup(resolved), {
        nRows: resolved.nRows,
        nCols: resolved.sourceVars,
        fileRows: rows.of,
        pointers: isGroup(resolved.node) ? pointers : null,
        rowChecksums: this._keptRowChecksums(resolved, pointers),
        label: resolved.label,
      }, { environment, tab }).catch(() => []);
      this._keptRuns.set(resolved.key, found);
    }
    return found;
  }

  /**
   * The file's open rows of a matrix as they are now (`rowChecksums`), for
   * the fingerprint of a kept run of a file whose identity does not name its
   * content; null when the matrix cannot be read so. `pointers()`: the open
   * rows' row pointers. @private
   */
  _keptRowChecksums(resolved, pointers) {
    try {
      return rowChecksums(resolved.node, { format: this._format, label: resolved.label, pointers });
    } catch {
      return null;
    }
  }

  /** The kept runs of a matrix's index, taken by the index that starts from them (the caller releases what it does not use). @private */
  async _takeKeptRuns(resolved, pointers) {
    const runs = [...await this._keptRunsOf(resolved, pointers)];
    this._keptRuns.delete(resolved.key);
    return runs;
  }

  /**
   * Keep the index of open rows `[start, end)` of a matrix, built by a pass
   * (`RowMajorColumnIndex` `onBuilt`), for a later opening of the same rows:
   * in the background, a piece at a time between the reader's other work.
   * @private
   */
  _keepRun(resolved, start, end, pointers, store, fingerprint) {
    const rows = this._keptRowsOf(resolved);
    if (rows === null || typeof store?.keptParts !== 'function') return;
    const kept = this._keptIndexes;
    const group = this._keptGroup(resolved);
    const job = (async () => {
      const all = pointers ?? (isGroup(resolved.node) ? await this._openRowPointers(resolved.node) : null);
      let rowPointers = null;
      if (all !== null) {
        rowPointers = allocateTypedArray(Float64Array, end - start + 1, 'Row pointers');
        for (let i = 0; i < rowPointers.length; i++) rowPointers[i] = all[start + i] - all[start];
      }
      await keepRun(group, {
        start,
        fileRows: rows.fileRows === null ? null : copyTypedArray(Uint32Array, rows.fileRows.subarray(start, end), 'File rows'),
        rowPointers,
        parts: store.keptParts(),
      }, {
        file: kept.identity,
        environment: kept.environment,
        tab: kept.tab,
        onStore: kept.onStore,
        fingerprint,
        yieldControl: () => this._yieldToForeground(false),
      });
    })().catch(() => {});
    this._keeping.add(job);
    void job.finally(() => this._keeping.delete(job));
  }

  /**
   * Resolves once every run of a built index this reader is keeping in this
   * browser is kept (or given up): a measurement, or a test, that opens the
   * same cells next.
   */
  async whenIndexesKept() {
    while (this._keeping.size > 0) await Promise.all([...this._keeping]);
  }

  /**
   * How far the segments of a matrix indexed in segments are built: `done`,
   * the rows of the built prefix of segments (its own, or those an earlier
   * opening carried over); `next`, where the next segment ends (the cells the
   * next gene shows on first); `pointers`, a CSR matrix's row pointers. @private
   */
  async _segmentProgress(resolved) {
    const { node: matrix, nRows, key: element } = resolved;
    const segments = this._matrices.get(element)?.columns?.segments ?? this._carried.get(element)?.segments ?? [];
    let done = 0;
    for (const segment of segments) {
      if (segment.start !== done || segment.access.built?.() !== true) break;
      done += segment.rows;
    }
    const pointers = await this._openRowPointers(matrix);
    let runs = [];
    if (this._matrices.get(element)?.columns == null) {
      // Not opened yet: the runs kept in this browser are built too.
      runs = await this._keptRunsOf(resolved, () => Promise.resolve(pointers));
      for (const run of runs) if (run.start === done) done += run.rows;
    }
    const pending = segments.find(segment => segment.start === done);
    const following = runs.find(run => run.start > done);
    const next = pending !== undefined
      ? done + pending.rows
      : Math.min(segmentBounds(done, nRows, firstSegmentRows(nRows, entriesPerRow(matrix, nRows)))[0] ?? nRows, following?.start ?? nRows);
    return { done, next, pointers };
  }

  /**
   * The row pointers of a CSR matrix as open (null for a dense one): a
   * subsample view's, in memory, else the stored ones, kept (they do not
   * depend on the cells). @private
   */
  async _openRowPointers(matrix, readOptions = {}) {
    if (!isGroup(matrix)) return null;
    const stored = this._cellSubset?.fileRows === null;
    const pointers = (stored ? this._indptrs.get(matrix.path) : undefined) ?? await readRowPointers(matrix, readOptions);
    if (stored) this._indptrs.set(matrix.path, pointers);
    return pointers;
  }

  /**
   * Whether a matrix is read by gene through a row-major index (a CSR
   * matrix, or a dense one not stored in gene strips the decoded-chunk
   * budget holds: `openMatrixColumns`), and its rows are the open cells in
   * priority order: then it is indexed in segments. @private
   */
  _indexedInSegments(resolved) {
    if (this._cellSubset?.ordered !== true || resolved.throughCells || resolved.prefix !== null || resolved.cells !== null) return false;
    if (resolved.key.startsWith('mod/') || resolved.start !== 0) return false;
    return readsThroughRowIndex(resolved.node, { nObs: resolved.nRows, nVars: resolved.sourceVars, decodedChunkBytes: this._decodedChunkBytes });
  }

  /**
   * Make a matrix of a subsample ready to be read: its kept rows' pointers,
   * when it is a CSR matrix on the cell axis (`cellSubsetView`
   * `readRowPointers`; nothing for any other matrix, or when every cell is
   * open: null, so a read of every cell waits for nothing). `X`'s also
   * give the subsample's kept values and the share of X's index chunks they
   * lie in (`cellSubset`). @private
   */
  _readyRows(element, readOptions = {}) {
    const root = this._root;
    if (typeof root?.readRowPointers !== 'function' || typeof element !== 'string') return null;
    return root.readRowPointers(element, readOptions).then(() => this._noteKeptValues(element, root));
  }

  /** `estimatedChunkShare` of a CSR X for the kept rows (null for another layout). @private */
  _estimatedChunkShare(full, resolution) {
    const X = child(full, 'X');
    if (!isGroup(X) || encodingType(X) !== 'csr_matrix') return null;
    const indices = X.get('indices');
    const chunkElements = Array.isArray(indices?.chunks) && indices.partialChunks !== true ? indices.chunks[0] : null;
    return chunkElements === null ? null : estimatedChunkShare(resolution.fileRows, resolution.nObs, indices.shape[0], chunkElements);
  }

  /** The subsample's kept values of X, once X's kept rows' pointers are read. @private */
  _noteKeptValues(element, root) {
    const subset = this._cellSubset;
    if (element !== 'X' || subset === null || subset.keptValues !== null || root !== this._root) return;
    // Exact from here on: the estimate made at opening is replaced.
    const X = child(this._fullRoot, 'X');
    const pointers = root.rowPointersOf('X');
    if (!isGroup(X) || encodingType(X) !== 'csr_matrix' || pointers === null) return;
    const indices = X.get('indices');
    const chunkElements = Array.isArray(indices?.chunks) && indices.partialChunks !== true ? indices.chunks[0] : null;
    subset.keptValues = keptValueCount(pointers, subset.fileRows);
    subset.matrixChunkShare = chunkElements === null ? null : keptChunkShare(pointers, subset.fileRows, chunkElements, indices.shape[0]);
  }

  /** The link's merge gap now (0 without a link): what the subsample view joins reads within. @private */
  _mergeGapBytes() {
    return this._link?.mergeGapBytes ?? 0;
  }

  /**
   * Resolve which cells to open (`resolveCellSubset`) and, for a subsample,
   * present the store as its view (`cellSubsetView`): everything after
   * this reads the kept cells only. @private
   */
  async _openCells(request, readOptions) {
    const full = this._root;
    const context = {
      valuesOnDemand: !this._readsAhead(),
      decodedChunkBytes: this._decodedChunkBytes ?? residencyBudgetBytes('decodedBlocks'),
      readOptions,
    };
    let resolution = await resolveCellSubset(full, request, context);
    // A first view smaller than the cells asked for, when reading them is
    // measured to take long (`progressive-open.js`): the page grows it in
    // place to them (`growth`).
    let growth = null;
    if (request?.progressive != null) {
      const nObs = resolution.nObs;
      const link = this._link?.snapshot?.() ?? null;
      const asked = resolution;
      const plan = await planProgressiveOpening(asked, {
        nObs,
        // Decoding is priced at a measured rate: before any chunk has been
        // decoded here, the first view's first chunk is read to measure it
        // where a read costs no round trip worth pricing.
        costOf: target => firstViewCost(full, nObs, asked.fileRows ?? null, target, readOptions, { measureDecode: link?.readsAhead === true }),
        link,
        msPerCell: request.progressive.msPerCell ?? null,
        targetMs: request.progressive.targetMs,
      });
      if (plan !== null) {
        resolution = await resolveCellSubset(full, plan.first, context);
        growth = plan.growth;
      }
    }
    this._fullRoot = full;
    if (resolution.fileRows === null) {
      this._cellSubset = { ...resolution, rows: null, keptValues: null, matrixChunkShare: null, growth };
      return;
    }
    // The view reads a CSR matrix's row pointers when the matrix is first
    // read, and only the kept rows' (`readRowPointers`): opening a
    // subsample reads none. Pointers read whole before (every cell open,
    // then a subsample of the same store) serve it at once.
    this._root = await cellSubsetView(full, {
      nObs: resolution.nObs,
      kept: resolution.fileRows,
      mergeGapBytes: () => this._mergeGapBytes(),
      readOptions,
      indptrs: this._indptrs,
      knownRowPointers: this._knownRowPointers,
      chunks: this._decodedChunks,
    });
    this._prefixReads = startPrefixReads(full, resolution, readOptions);
    this._cellSubset = {
      ...resolution,
      rows: new CellRows(resolution.fileRows, resolution.nObs),
      // The stored values of the kept rows of a CSR X, known once X's kept
      // row pointers are read (`_readyRows`); the share of its index chunks
      // they lie in, estimated from its mean values a row until then (null
      // for another layout, or one read byte by byte).
      keptValues: null,
      matrixChunkShare: this._estimatedChunkShare(full, resolution),
      growth,
    };
  }

  /**
   * Settle a priority-ordered file's open order (`openOrderRead`,
   * `subsample-plan.js`) into the cell subset. @private
   */
  async _settleOpenOrder() {
    const subset = this._cellSubset;
    const read = subset?.openOrderRead;
    if (read === undefined) return;
    const openOrder = await read;
    const { openOrderRead: _settled, ...rest } = subset;
    this._cellSubset = { ...rest, openOrder };
  }

  /**
   * The cells this reader presents: `{nObs, kept, spec, autoFit,
   * reproduced, note, keptValues, matrixChunkShare}` (`subsample-plan.js`);
   * `kept` null when every cell is open. `keptValues` is the stored values
   * of the kept rows of a cell-major `X` (what its gene index holds), and
   * `matrixChunkShare` the share of its stored chunks they lie in; null for
   * other layouts.
   */
  get cellSubset() {
    const subset = this._cellSubset;
    if (subset === null) return null;
    const { rows: _rows, fileRows: _fileRows, ...plain } = subset;
    return plain;
  }

  /**
   * How much of a neighbour graph a subsample keeps, once the graph was
   * read (`readInducedGraph`): `{kept, of}`, its stored entries between two
   * open cells of those of the open cells (the others join an open cell to
   * one left out); null before it is read, or when every cell is open.
   *
   * @param {string} key - The `obsp` key
   * @returns {{kept: number, of: number}|null}
   */
  subsampleGraphShare(key) {
    this._ensureOpen();
    return this._graphShares.get(key) ?? null;
  }

  /**
   * How the subsample represents a categorical obs field: each category's
   * share of the kept cells against its share of every cell, read from the
   * field's codes (a few bytes per cell), and the largest difference. Null
   * when every cell is open.
   *
   * @param {string} key
   * @returns {Promise<{field: string, largestDeviation: number, category: string|null,
   *   shares: Array<{category: string, all: number, kept: number}>}|null>}
   */
  async subsampleRepresentation(key) {
    this._ensureOpen();
    const subset = this._cellSubset;
    if (subset?.kept === null || subset === null) return null;
    const column = child(child(this._fullRoot, 'obs'), key);
    if (!isGroup(column) || encodingType(column) !== 'categorical') {
      throw new Error(`obs['${key}'] is not a categorical field`);
    }
    const memo = `obs_representation:${key}`;
    if (this._cache.has(memo)) return this._cache.get(memo);
    const result = this._track('fields', `the representation of obs['${key}'] in the subsample`, async readOptions => {
      // Every cell's counts are the store's, whatever cells are open: read
      // once (`obs_counts`, carried to a later opening of the same store),
      // then only the open cells' codes.
      const countsKey = `obs_counts:${key}`;
      const known = this._cache.get(countsKey) ?? null;
      let names;
      let all;
      let kept;
      const slotIn = count => code => (Number(code) >= 0 && Number(code) < count ? Number(code) : count);
      if (known === null) {
        const codesNode = column.get('codes');
        const [codes, categories] = await Promise.all([
          readStored(codesNode, 0, codesNode.shape[0], `obs['${key}'] codes`, readOptions),
          readCategories(column.get('categories'), key, this._format, readOptions),
        ]);
        names = Array.from(categories, String);
        all = allocateTypedArray(Float64Array, names.length + 1, `obs['${key}'] category sizes`);
        kept = allocateTypedArray(Float64Array, names.length + 1, `obs['${key}'] category sizes`);
        const slot = slotIn(names.length);
        for (let cell = 0; cell < codes.length; cell++) all[slot(codes[cell])]++;
        const rows = subset.fileRows ?? subset.kept;
        for (let i = 0; i < rows.length; i++) kept[slot(codes[rows[i]])]++;
        this._cache.set(countsKey, Object.freeze({ names, all }));
      } else {
        ({ names, all } = known);
        const openCodes = child(child(this._root, 'obs'), key).get('codes');
        const codes = await readStored(openCodes, 0, openCodes.shape[0], `obs['${key}'] codes`, readOptions);
        kept = allocateTypedArray(Float64Array, names.length + 1, `obs['${key}'] category sizes`);
        const slot = slotIn(names.length);
        for (let i = 0; i < codes.length; i++) kept[slot(codes[i])]++;
      }
      const shares = [];
      let largestDeviation = 0;
      let category = null;
      for (let c = 0; c <= names.length; c++) {
        if (all[c] === 0) continue;
        const entry = { category: c < names.length ? names[c] : null, all: all[c] / subset.nObs, kept: kept[c] / subset.kept.length };
        shares.push(entry);
        const deviation = Math.abs(entry.kept - entry.all);
        if (deviation > largestDeviation) {
          largestDeviation = deviation;
          category = entry.category;
        }
      }
      return { field: key, largestDeviation, category, shares };
    });
    this._cache.set(memo, result);
    result.catch(() => {
      if (this._cache.get(memo) === result) this._cache.delete(memo);
    });
    return result;
  }

  /**
   * The store's structure, checked. The var index is checked (its length and
   * kind) but its names are not read: no view waits for the gene names, and
   * they are read when first asked for (`readVarNames`). `carry`: the reader
   * of an earlier opening of the same store, whose title is this one's.
   * @private
   */
  async _readStructure(readOptions = {}, carry = null) {
    const root = this._root;
    const format = this._format;
    const fileLabel = `${format.file} root`;
    requireExactStringAttribute(root, 'encoding-type', 'anndata', fileLabel);
    requireExactStringAttribute(root, 'encoding-version', '0.1.0', fileLabel);
    if (!root.has('obs')) throw new Error(`${format.file} obs is required and must be a current AnnData dataframe`);
    if (!root.has('var')) throw new Error(`${format.file} var is required and must be a current AnnData dataframe`);
    const obs = root.get('obs');
    const var_ = root.get('var');
    const obsSchema = validateDataFrame(obs, format, `${format.file} obs`);
    const varSchema = validateDataFrame(var_, format, `${format.file} var`);

    const hasX = root.has('X');
    let nObs = 0;
    let nVars = 0;
    if (hasX) {
      const X = root.get('X');
      if (isGroup(X)) {
        // A subsample's CSR X is checked as stored: its kept rows' arrays
        // are made when it is first read (`_readyRows`), and only its shape
        // is the view's.
        const stored = this._fullRoot !== null && this._fullRoot !== root && X.rowPointersPending?.() === true
          ? this._fullRoot.get('X')
          : X;
        const sparse = sparseContract(stored, format, 'Sparse X');
        [nObs, nVars] = stored === X ? sparse.shape : shapeFromAttribute(attributeValue(X, 'shape'), 'Sparse X');
        const element = X.path.replace(/^\/+/, '');
        if (sparse.format === 'csc' && !this._pointerReads.has(element)) {
          // A gene of a CSC matrix reads its range of the pointers first:
          // read them now, beside the indexes, and the first gene is one
          // round trip. A failure reaches the first gene read, not opening.
          // (An earlier opening of the store read them already: `carry`.)
          const pointers = readIntegers(sparse.indptrArray, 0, nVars + 1, 'Sparse X indptr', readOptions);
          pointers.catch(() => {});
          this._pointerReads.set(element, pointers);
        }
      } else {
        validateArrayEncoding(X, format, 'Dense X', 'array');
        [nObs, nVars] = shapeOf(X, 'Dense X', 2);
        if (!isAnnDataMatrixDataKind(valueKind(X))) throw new Error('Dense X must use a numeric or boolean dtype');
      }
    }
    for (const key of obsSchema.columnOrder) {
      // Checked before any value is read, so a malformed column fails fast.
      validateColumnEncoding(obs.get(key), format, `Observation dataframe column '${key}'`);
    }
    // The title (one small read) is read beside the indexes: dataset
    // metadata then never waits a round trip for it.
    this._title = carry?._title ?? readUnsTitle(root, readOptions);
    this._title.catch(() => {});
    // What the file says about itself for Cellucid is part of opening it: a
    // malformed entry refuses the file, so it is read with the indexes. (Of
    // the open cells: a subsample's view gathers its per-cell entries.)
    const unsCellucid = child(child(root, 'uns'), 'cellucid');
    const [obsIndex, varIndex, cellucid] = await Promise.all([
      readDataFrameIndex(obs.get(obsSchema.indexKey), format, 'Observation index', hasX ? nObs : null, false, readOptions),
      readDataFrameIndex(var_.get(varSchema.indexKey), format, 'Variable index', hasX ? nVars : null, false, readOptions),
      unsCellucid === null ? null : readUnsCellucid(unsCellucid, readOptions),
    ]);
    this._cellucid = cellucid;
    if (!hasX) {
      nObs = obsIndex.length;
      nVars = varIndex.length;
    }
    for (const key of obsSchema.columnOrder) validateColumnAxis(obs, key, format, 'Observation dataframe', nObs);
    for (const key of varSchema.columnOrder) validateColumnAxis(var_, key, format, 'Variable dataframe', nVars);
    if (root.has('obsm')) requireMapping(root.get('obsm'), format, `${format.file} obsm mapping`);
    if (nObs === 0) console.warn('[AnnDataReader] AnnData has 0 cells');
    if (!hasX) console.warn('[AnnDataReader] No X matrix: gene expression is not available');
    this._nObs = nObs;
    this._nVars = nVars;
    if (Array.isArray(root.modalities) && root.modalities.length > 0) {
      this._modalities = new Map(root.modalities.map(modality => [
        modality.name,
        { modality, cells: cellMapOf(modality, nObs) },
      ]));
      this._defaultModality = root.defaultModality;
      for (const { modality } of this._modalities.values()) {
        if (!isGroup(child(child(root, 'mod'), modality.name))) {
          throw new Error(`${format.file} modality '${modality.name}' has no mod group`);
        }
      }
    }
    // A priority-ordered file's original positions are how its cells are
    // named (`priority-layout.js`, the cell identity), not a field: listed,
    // they would be offered for colouring and filtering and written into
    // exports, where a subset's positions no longer name its rows.
    // So are each modality's own (a MuData in priority order: its rows
    // follow their cells, `<modality>:cellucid_original_position`).
    // Only a verified record (`priority-layout.js`): one that does not
    // describe the cells leaves the column an ordinary one.
    const priorityOrdered = this._cellSubset?.prioritySeed != null;
    const positions = new Set([PRIORITY_ORIGINAL_COLUMN, ...[...(this._modalities?.keys() ?? [])].map(name => `${name}:${PRIORITY_ORIGINAL_COLUMN}`)]);
    this._obsKeys = obsSchema.columnOrder.filter(key => !(priorityOrdered && positions.has(key)));
  }

  get nObs() { return this._nObs; }

  get nVars() { return this._nVars; }

  get obsKeys() { return [...this._obsKeys]; }

  /** Whether the dataset has an expression matrix (`X` may be absent). */
  get hasExpressionMatrix() { return this._root?.has('X') === true; }

  get isOpen() { return this._root !== null; }

  /**
   * Describe, from metadata alone, every element the data-mapping catalog
   * lists: the `obsm` and `obsp` entries, the var columns, `X`, the layers
   * and `raw`, and, for a multimodal store, the same for each modality
   * (`modalities`, null for a store of one feature space). No array value
   * is read but `uns['log1p']`.
   */
  async probeMapping() {
    this._ensureOpen();
    const root = this._root;
    const format = this._format;
    const mappingProbes = name => {
      if (!root.has(name)) return [];
      const group = requireMapping(root.get(name), format, `${format.file} ${name} mapping`);
      return group.keys().map(key => probeElement(key, group.get(key)));
    };
    const expression = await this._probeExpression(root, format.file);
    let modalities = null;
    if (this._modalities !== null) {
      modalities = await Promise.all([...this._modalities.values()].map(async ({ modality }) => {
        const group = this._root.get(`mod/${modality.name}`);
        const probe = await this._probeExpression(group, `${format.file} modality '${modality.name}'`);
        return { name: modality.name, nCells: modality.nCells, ...probe };
      }));
    }
    // A subsample's graphs are stored on every cell and read as their induced
    // subgraph on the open cells (`readInducedGraph`): listed as that graph,
    // its stored entries unknown until it is read.
    const subsetRows = this._cellSubset?.rows ?? null;
    const openGraph = probe => (
      subsetRows !== null && probe.shape?.length === 2
        && probe.shape[0] === subsetRows.nOriginal && probe.shape[1] === subsetRows.nOriginal
        ? { ...probe, shape: [this._nObs, this._nObs], nnz: null }
        : probe
    );
    return {
      nObs: this._nObs,
      nVars: this._nVars,
      obsm: mappingProbes('obsm'),
      obsp: mappingProbes('obsp').map(openGraph),
      varColumns: expression.varColumns,
      X: expression.X,
      layers: expression.layers,
      raw: expression.raw,
      log1p: expression.log1p,
      modalities,
      defaultModality: this._defaultModality,
    };
  }

  /**
   * The expression side of one AnnData group (the root, or a modality's):
   * its var count and columns, `X`, layers, `raw` and `uns['log1p']`.
   * @private
   */
  async _probeExpression(group, label) {
    const format = this._format;
    let raw = null;
    const rawGroup = child(group, 'raw');
    if (isGroup(rawGroup) && rawGroup.has('X')) {
      const rawX = probeElement('X', rawGroup.get('X'));
      raw = {
        nVars: rawX.shape?.length === 2 ? rawX.shape[1] : 0,
        X: { storage: rawX.storage, dtype: rawX.dtype },
        varColumns: rawGroup.has('var') ? probeColumns(rawGroup.get('var'), format, `${label} raw.var`) : [],
      };
    }
    let matrixX = null;
    let nVars = null;
    if (group.has('X')) {
      const probe = probeElement('X', group.get('X'));
      matrixX = { storage: probe.storage, dtype: probe.dtype };
      nVars = probe.shape?.[1] ?? null;
    }
    const layers = group.has('layers')
      ? requireMapping(group.get('layers'), format, `${label} layers mapping`).keys()
        .map(key => probeElement(key, group.get('layers').get(key)))
      : [];
    const varFrame = group.get('var');
    if (nVars === null) {
      const { indexKey } = validateDataFrame(varFrame, format, `${label} var`);
      nVars = (await readDataFrameIndex(varFrame.get(indexKey), format, `${label} var index`, null, false, {})).length;
    }
    return {
      nVars,
      varColumns: probeColumns(varFrame, format, `${label} var`),
      X: matrixX,
      layers,
      raw,
      log1p: await readLog1pRecord(group, {}),
    };
  }

  /** One dense numeric `obsm` array, checked: one row per cell, one or two dimensions. @private */
  _obsmArray(key) {
    const label = `obsm['${key}']`;
    const obsm = requireMapping(child(this._root, 'obsm'), this._format, `${this._format.file} obsm mapping`);
    if (!obsm.has(key)) throw new Error(`${label} does not exist in this file`);
    const array = obsm.get(key);
    if (isGroup(array)) {
      // A sparse matrix, a dataframe, an awkward array: named, never misread.
      const encoding = attributeValue(array, 'encoding-type');
      throw new Error(
        `${label} is ${typeof encoding === 'string' && encoding.length > 0 ? `an '${encoding}' element` : 'a group'}, ` +
        'not a dense array; Cellucid reads embeddings stored as dense numeric arrays'
      );
    }
    if (valueKind(array) === 'string') {
      throw new Error(`${label} holds text, not numbers; Cellucid reads embeddings stored as dense numeric arrays`);
    }
    validateArrayEncoding(array, this._format, label, 'array');
    const shape = shapeOf(array, label);
    if (shape.length !== 1 && shape.length !== 2) throw new Error(`${label} must be a one- or two-dimensional array`);
    if (shape[0] !== this._nObs) throw new Error(`${label} has ${formatCountOf(shape[0], 'row')} but the dataset has ${formatCountOf(this._nObs, 'cell')}`);
    if (!isAnnDataNumericValueKind(valueKind(array))) throw new Error(`${label} must use a numeric dtype`);
    return { array, shape, width: shape.length === 1 ? 1 : shape[1], label };
  }

  /**
   * Every row of `obsm[key]`, every column, in row order, one slab at a
   * time, so the array is never held whole: `visit(block, rowStart, rowEnd)`
   * receives row-major values (numbers, or BigInts for 64-bit integers) and
   * runs synchronously. `signal` cancels the pass; `kind` and `label` name
   * the activity it runs under (an embedding read, by default).
   *
   * @param {string} key
   * @param {(block: ArrayLike<number|bigint>, rowStart: number, rowEnd: number) => void} visit
   * @param {{signal?: AbortSignal|null, kind?: string, label?: string|null}} [options]
   * @returns {Promise<number>} The array's width
   */
  async forEachObsmRowSlab(key, visit, { signal = null, kind = 'embedding', label: activityLabel = null } = {}) {
    this._ensureOpen();
    const generation = this._generation;
    const { array, shape, width, label } = this._obsmArray(key);
    return this._track(kind, activityLabel ?? label, async readOptions => {
      for await (const slab of readRowSlabs(array, 0, shape[0], readOptions)) {
        this._assertGeneration(generation, `reading ${label}`);
        visit(slab.values, slab.rowStart, slab.rowEnd);
      }
      return width;
    }, signal);
  }

  /**
   * What reading all of `obsm[key]` costs: its stored (compressed) bytes, or
   * null when the store cannot say without reading (a Zarr folder over HTTP
   * lists no sizes), and its bytes as values.
   *
   * @param {string} key
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<{storedBytes: number|null, valueBytes: number}>}
   */
  async obsmReadCost(key, { signal = null } = {}) {
    this._ensureOpen();
    const { array, shape } = this._obsmArray(key);
    const valueBytes = shape.reduce((product, extent) => product * extent, 1) * (array.dtype?.bytes ?? 8);
    let storedBytes = null;
    if (typeof array.storedBytes === 'function') {
      storedBytes = await array.storedBytes(shape.map(extent => [0, extent]), { signal });
    }
    return { storedBytes: Number.isFinite(storedBytes) ? storedBytes : null, valueBytes };
  }

  /** `uns['cellucid']['outlierQuantiles']['fields'][key]`, checked: float32, one value per cell. @private */
  _storedOutlierArray(fieldKey) {
    const label = `uns['cellucid']['outlierQuantiles']['fields']['${fieldKey}']`;
    const fields = child(child(child(child(this._root, 'uns'), 'cellucid'), 'outlierQuantiles'), 'fields');
    const array = fields === null ? null : child(fields, fieldKey);
    if (array?.kind !== 'array') throw new Error(`${label} does not exist in this file`);
    if (valueKind(array) !== 'float' || array.dtype?.bytes !== 4 || array.shape.length !== 1 || array.shape[0] !== this._nObs) {
      throw new Error(`${label} must be ${this._nObs} float32 values, one per cell`);
    }
    return { array, label };
  }

  /**
   * The outlier quantiles a file stores for one obs field (written by
   * `prepare()` / `cellucid_prepare()` with the latent space), as stored:
   * NaN where a cell has none.
   *
   * @param {string} fieldKey
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<Float32Array>}
   */
  async readStoredOutlierQuantiles(fieldKey, { signal = null } = {}) {
    this._ensureOpen();
    const generation = this._generation;
    const { array, label } = this._storedOutlierArray(fieldKey);
    return this._track('outliers', `stored outlier quantiles of obs['${fieldKey}']`, async readOptions => {
      const values = await array.read(undefined, readOptions);
      this._assertGeneration(generation, `reading ${label}`);
      if (!(values instanceof Float32Array) || values.length !== this._nObs) {
        throw new Error(`${label} did not read as ${this._nObs} float32 values`);
      }
      return values;
    }, signal);
  }

  /** The stored bytes of one field's stored outlier quantiles, or null when the store cannot say. */
  async storedOutlierQuantilesBytes(fieldKey, { signal = null } = {}) {
    this._ensureOpen();
    const { array } = this._storedOutlierArray(fieldKey);
    if (typeof array.storedBytes !== 'function') return null;
    const bytes = await array.storedBytes([[0, this._nObs]], { signal });
    return Number.isFinite(bytes) ? bytes : null;
  }

  /**
   * The selected columns of one dense `obsm` array, unnormalized, one row per
   * cell, `result[row * columns.length + i]`: float32 values for a float32
   * array (exactly as stored, half the bytes), float64 for any other numeric
   * type (64-bit integers converted as `Number` does). Only the
   * selected columns' chunks are read: a selection spanning at most twice
   * its own width is read as one column range, otherwise column by column,
   * every range at once. `signal` cancels the read; `reason` says what the
   * read is for (its activity's label).
   */
  async readObsmColumns(key, columns, { signal = null, rows = null, reason = null } = {}) {
    this._ensureOpen();
    const generation = this._generation;
    const { array, shape, width, label } = this._obsmArray(key);
    const selected = requireObsmColumnSelection(columns, width, label);
    const asked = this._rowRange(rows, label);
    const range = asked ?? { start: 0, end: shape[0] };
    // The activity names the open cells read and what for, so a trace tells
    // a growth step's added rows from a whole read.
    const what = `${label} columns ${selected.join(', ')}`
      + (asked === null ? `, every open cell` : `, open cells ${formatCount(asked.start)}–${formatCount(asked.end)}`)
      + (reason === null ? '' : ` (${reason})`);
    return this._track('embedding', what, readOptions =>
      this._readObsmColumns(array, shape, selected, label, generation, readOptions, range), signal);
  }

  /** @private */
  async _readObsmColumns(array, shape, selected, label, generation, readOptions, { start: firstRow, end: endRow } = { start: 0, end: shape[0] }) {
    const nRows = endRow - firstRow;
    const nColumns = selected.length;
    const stored32 = valueKind(array) === 'float' && array.dtype?.bytes === 4;
    const result = allocateTypedArray(stored32 ? Float32Array : Float64Array, nRows * nColumns, label);
    const toNumber = value => (typeof value === 'bigint' ? Number(value) : value);
    if (shape.length === 1) {
      for await (const slab of readRowSlabs(array, firstRow, endRow, readOptions)) {
        const block = slab.values;
        for (let row = 0; row < block.length; row++) result[slab.rowStart - firstRow + row] = toNumber(block[row]);
      }
    } else {
      const first = Math.min(...selected);
      const last = Math.max(...selected) + 1;
      const ranges = last - first <= 2 * nColumns
        ? [[first, last, selected.map((column, index) => [column, index])]]
        : selected.map((column, index) => [column, column + 1, [[column, index]]]);
      await Promise.all(ranges.map(async ([from, to, picks]) => {
        const blockWidth = to - from;
        // Every column of the range asked for, in order: a slab is already
        // laid out as the output is.
        const whole = blockWidth === nColumns && picks.every(([column, output], i) => column === from + i && output === i);
        for await (const slab of readRowSlabs(array, firstRow, endRow, { ...readOptions, columns: [from, to] })) {
          const block = slab.values;
          if (whole && !(block instanceof BigInt64Array) && !(block instanceof BigUint64Array)) {
            result.set(block, (slab.rowStart - firstRow) * nColumns);
            continue;
          }
          for (const [column, outputColumn] of picks) {
            const offset = column - from;
            for (let row = slab.rowStart; row < slab.rowEnd; row++) {
              result[(row - firstRow) * nColumns + outputColumn] = toNumber(block[(row - slab.rowStart) * blockWidth + offset]);
            }
          }
        }
      }));
    }
    this._assertGeneration(generation, `reading ${label}`);
    return result;
  }

  /**
   * One embedding's display coordinates, checked and normalized here
   * (`EmbeddingPayloads.embedding`), with their display transform and
   * bounds. `signal` cancels the read.
   *
   * @param {string} key
   * @param {ReadonlyArray<number>} columns
   * @param {boolean} normalize
   * @param {{signal?: AbortSignal|null, rows?: [number, number]|null}} [options] -
   *   `rows`: only rows `[start, end)` of the open cells, in the embedding's
   *   frame (`EmbeddingPayloads.embedding`); `pieces`: where the
   *   coordinates go as they are made (`EmbeddingPayloads.embedding`)
   * @returns {Promise<import('../embedding-payload.js').EmbeddingPayload>}
   */
  readEmbedding(key, columns, normalize, { signal = null, rows = null, pieces = undefined } = {}) {
    this._ensureOpen();
    const range = this._rowRange(rows, `obsm['${key}']`);
    return this._payloads.embedding(key, [...columns], normalize, { signal, rows: range === null ? null : [range.start, range.end], pieces });
  }

  /**
   * One vector field's display vectors, scaled here by the transform of the
   * embedding it is bound to (`EmbeddingPayloads.vectors`), with the largest
   * magnitude. `signal` cancels the reads.
   *
   * @param {string} key
   * @param {ReadonlyArray<number>} columns
   * @param {{key: string, columns: ReadonlyArray<number>}} embedding
   * @param {boolean} normalize
   * @param {{signal?: AbortSignal|null, rows?: [number, number]|null, pieces?: Function}} [options] -
   *   `pieces`: where the vectors go as they are made (`EmbeddingPayloads.vectors`)
   * @returns {Promise<{vectors: Float32Array, maxMagnitude: number}>}
   */
  readVectorField(key, columns, embedding, normalize, { signal = null, rows = null, pieces = undefined } = {}) {
    this._ensureOpen();
    const range = this._rowRange(rows, `obsm['${key}']`);
    return this._payloads.vectors(
      key,
      [...columns],
      { key: embedding.key, columns: [...embedding.columns] },
      normalize,
      { signal, rows: range === null ? null : [range.start, range.end], pieces }
    );
  }

  /**
   * One boolean column of `var` (axis `X`) or `raw.var` (axis `raw`), or of a
   * modality's (`mod/<name>`, `mod/<name>/raw`), as flags, one per gene of
   * that axis, 1 where true: which genes a column such as `highly_variable`
   * marks. Read when asked for, never at open.
   *
   * @param {string} axis
   * @param {string} column
   * @returns {Promise<Uint8Array>}
   */
  async readVarFlags(axis, column) {
    this._ensureOpen();
    const label = `${this._varAxis(axis).label}['${column}']`;
    return this._track('names', `flags of ${label}`, async readOptions => {
      const generation = this._generation;
      const { index } = await this.readVarNames(axis, null);
      const frame = this._varAxis(axis).frame;
      const { columnOrder } = validateDataFrame(frame, this._format, label);
      if (!columnOrder.includes(column)) throw new Error(`${label} does not exist`);
      const flags = await readBooleanColumn(frame, column, this._format, label, index.length, readOptions);
      this._assertGeneration(generation, `reading ${label}`);
      return flags;
    });
  }

  /**
   * The gene names of one var axis, as stored: the var index, or one var
   * column as text (null where a value is missing), with the index that names
   * the genes a column leaves empty. `axis` is `X` (shared by `X` and every
   * layer) or `raw`, or a modality's (`mod/<name>`, `mod/<name>/raw`).
   * Nothing is made unique here.
   *
   * @param {string} axis
   * @param {string|null} column
   * @returns {Promise<{index: string[], values: Array<string|null>}>}
   */
  /**
   * The obs names of the open cells, in their order: the obs index, read
   * whole when an export asks for it (a CSV or `.h5ad` names its cells by
   * them). Opening reads only its length.
   *
   * @returns {Promise<string[]>}
   */
  async readObsNames() {
    this._ensureOpen();
    const cacheKey = 'obs_names';
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);
    return this._track('names', 'obs names', async readOptions => {
      const obs = this._root.get('obs');
      const { indexKey } = validateDataFrame(obs, this._format, `${this._format.file} obs`);
      const index = await readDataFrameIndex(obs.get(indexKey), this._format, 'Observation index', this._nObs, true, readOptions);
      const names = Array.from(index.values, String);
      this._cache.set(cacheKey, names);
      return names;
    });
  }

  async readVarNames(axis, column) {
    this._ensureOpen();
    const cacheKey = `var_names:${axis}:${column === null ? '' : `column:${column}`}`;
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);
    const { label: axisLabel } = this._varAxis(axis);
    const what = column === null ? `gene names of ${axisLabel}` : `gene names from ${axisLabel}['${column}']`;
    return this._track('names', what, readOptions => this._readVarNames(axis, column, cacheKey, readOptions));
  }

  /**
   * One var axis: `X` (the var shared by `X` and the layers), `raw`, or a
   * modality's (`mod/<name>`, `mod/<name>/raw`). Its frame, its label, and
   * the element whose gene count it has. @private
   */
  _varAxis(axis) {
    const { modality, rest } = this._splitModality(axis);
    const base = modality === null ? '' : `mod/${modality.modality.name}/`;
    const where = modality === null ? '' : ` of modality '${modality.modality.name}'`;
    const group = modality === null ? this._root : this._root.get(`mod/${modality.modality.name}`);
    if ((modality === null && rest === 'X') || (modality !== null && rest === '')) {
      return { frame: group.get('var'), label: `var${where}`, element: `${base}X`, root: modality === null };
    }
    if (rest === 'raw') {
      const raw = child(group, 'raw');
      if (!isGroup(raw) || !raw.has('var') || !raw.has('X')) throw new Error(`This file has no raw var axis${where}`);
      return { frame: raw.get('var'), label: `raw.var${where}`, element: `${base}raw/X`, root: false };
    }
    throw new TypeError(`Unknown var axis '${String(axis)}'`);
  }

  /** @private */
  async _readVarNames(axis, column, cacheKey, readOptions) {
    const generation = this._generation;
    const format = this._format;
    const { frame, label, element, root } = this._varAxis(axis);
    let index;
    if (root) {
      // Read when first asked for (opening checks only its length). A
      // repeated name is kept as stored: the adapter makes the gene list
      // unique with the data-mapping rule, as cellucid serve does.
      const { indexKey } = validateDataFrame(frame, format, `${format.file} ${label}`);
      index = (await readDataFrameIndex(frame.get(indexKey), format, 'Variable index', this._nVars, true, readOptions)).values;
    } else {
      // Its gene count from the matrix's shape as stored: a subsample's CSR
      // matrix need not have its kept rows' pointers read (`_readyRows`)
      // for its gene names.
      const matrixGroup = this._root.get(element.slice(0, element.lastIndexOf('/')) || '/');
      const matrixNode = matrixGroup?.get?.('X') ?? null;
      const nVars = matrixNode === null
        ? null
        : (isGroup(matrixNode) ? shapeFromAttribute(attributeValue(matrixNode, 'shape'), label)[1] : shapeOf(matrixNode, label, 2)[1]);
      const { indexKey } = validateDataFrame(frame, format, `${format.file} ${label}`);
      index = (await readDataFrameIndex(frame.get(indexKey), format, `${label} index`, nVars, true, readOptions)).values;
    }
    let values;
    if (column === null) {
      values = index;
    } else {
      const { columnOrder } = validateDataFrame(frame, format, `${format.file} ${label}`);
      if (!columnOrder.includes(column)) throw new Error(`${label} has no column '${column}'`);
      values = await readGeneNameColumn(frame, column, format, `${label}['${column}']`, index.length, readOptions);
    }
    this._assertGeneration(generation, `reading the gene names of ${label}`);
    const result = Object.freeze({ index, values });
    this._cache.set(cacheKey, result);
    return result;
  }

  /**
   * The modality one element or var axis names (`mod/<name>/…`), and the
   * rest of it; `{modality: null, rest}` for the root's.
   * @private
   */
  _splitModality(path) {
    if (typeof path !== 'string' || !path.startsWith('mod/')) return { modality: null, rest: path };
    const end = path.indexOf('/', 'mod/'.length);
    const name = end < 0 ? path.slice('mod/'.length) : path.slice('mod/'.length, end);
    const entry = this._modalities?.get(name);
    if (entry === undefined) throw new Error(`This file has no modality '${name}'`);
    return { modality: entry, rest: end < 0 ? '' : path.slice(end + 1) };
  }

  /**
   * One expression matrix: its node, its label, its gene and cell counts,
   * and how it is read. `element` is `X`, `raw/X` or `layers/<name>`, of the
   * root or of a modality (`mod/<name>/X`, …). `source` is the matrix whose
   * columns are read (a column window's whole matrix) and `key` its
   * identity, which every element reading it shares; `start` the window's
   * first gene in it; `cells` the modality's cell map, null for the root's.
   * @private
   */
  _requireMatrixElement(element) {
    const format = this._format;
    const { modality, rest } = this._splitModality(element);
    const group = modality === null ? this._root : this._root.get(`mod/${modality.modality.name}`);
    const where = modality === null ? '' : ` of modality '${modality.modality.name}'`;
    let node;
    let label;
    if (rest === 'X') {
      if (!group.has('X')) throw new Error(`This file has no X expression matrix${where}`);
      node = group.get('X');
      label = `X${where}`;
    } else if (rest === 'raw/X') {
      const raw = child(group, 'raw');
      if (!isGroup(raw) || !raw.has('X')) throw new Error(`This file has no raw.X expression matrix${where}`);
      node = raw.get('X');
      label = `raw.X${where}`;
    } else if (typeof rest === 'string' && rest.startsWith('layers/')) {
      const name = rest.slice('layers/'.length);
      const layers = group.has('layers') ? requireMapping(group.get('layers'), format, `${format.file} layers mapping`) : null;
      if (name.length === 0 || name.includes('/') || layers === null || !layers.has(name)) {
        throw new Error(`This file has no layer '${name}'${where}`);
      }
      node = layers.get(name);
      label = `layers['${name}']${where}`;
    } else {
      throw new TypeError(`Unknown expression matrix '${String(element)}'`);
    }
    const shape = isGroup(node) ? sparseContract(node, format, label).shape : shapeOf(node, label, 2);
    const expectedRows = modality === null ? this._nObs : modality.modality.nCells;
    if (shape[0] !== expectedRows) {
      throw new Error(`${label} has ${formatCountOf(shape[0], 'row')} for ${formatCountOf(expectedRows, 'cell')}`);
    }
    // A gene-major (CSC) matrix of a subsample is read as stored, through
    // the kept rows (`views/cell-subset.js`): its genes' entries are read
    // whole and placed on the kept cells by the cell map.
    const cellRows = node.cellRows ?? null;
    const stored = cellRows === null ? node : cellRows.matrix;
    const window = stored.columnWindow ?? null;
    const source = window === null ? stored : window.matrix;
    const nRows = cellRows === null ? shape[0] : cellRows.rows.nOriginal;
    return {
      node: source,
      label,
      nVars: shape[1],
      nRows,
      sourceVars: window === null ? shape[1] : (isGroup(source) ? sparseContract(source, format, label).shape[1] : shapeOf(source, label, 2)[1]),
      start: window === null ? 0 : window.start,
      // The matrix's path in the store: `X`, `layers/counts`, `mod/rna/X`.
      key: source.path.replace(/^\/+/, ''),
      cells: composeCellMaps(modality === null ? null : modality.cells, cellRows === null ? null : cellRows.rows, expectedRows),
      throughCells: cellRows !== null,
      // The gene-major X of the dataset, or of a modality, opened as a prefix
      // of a priority-ordered file: a gene's kept values are a prefix of its
      // entries (a modality's rows follow their cells' priority, so its kept
      // rows are its first ones).
      prefix: cellRows !== null && rest === 'X' ? openPrefixOf(this._cellSubset?.prefix ?? null, cellRows.rows.kept, modality !== null) : null,
    };
  }

  /**
   * What reading a gene of one expression matrix costs now, before it is
   * read (`geneReadCost`, `matrix-access.js`): whether the matrix is stored
   * cell by cell (each gene spread over every cell), the stored bytes the
   * first gene must read when it is and no index is built yet, the index that
   * read builds and where it can be kept (`index.placement`: `memory`,
   * `disk`, or null with the `refusal` saying why nothing can hold it, when
   * every gene scans the matrix again), and the link's measured rate
   * (bytes per second, null until measured or for a local file). Once the
   * index is built, only `built: true` is said: a gene then reads only itself.
   *
   * @param {string} element
   * @returns {Promise<Object>}
   */
  async geneReadPlan(element) {
    this._ensureOpen();
    await this._readyRows(element);
    const matrix = this._requireMatrixElement(element);
    // A matrix whose index is built reads only the gene: nothing to weigh.
    // One indexed in segments (`prefix-column-index.js`) has what is left
    // to read after the segments built (an earlier opening's, carried), and
    // the gene shows on more cells after each segment.
    const segments = this._indexedInSegments(matrix) ? await this._segmentProgress(matrix) : null;
    // One indexed whole whose index is kept in this browser is built too.
    const keptWhole = segments === null && this._matrices.get(matrix.key)?.columns == null &&
      (await this._keptRunsOf(matrix, () => this._openRowPointers(matrix.node))).some(run => run.start === 0 && run.rows === matrix.nRows);
    if (keptWhole || this._matrices.get(matrix.key)?.columns?.built?.() === true || (segments !== null && segments.done >= matrix.nRows)) {
      return { label: matrix.label, cellMajor: null, layout: null, entries: null, built: true, scan: null, index: null, progressive: null, bytesPerSecond: null };
    }
    const valuesOnDemand = !this._readsAhead();
    const retainIndicesBytes = residencyBudgetBytes('columnIndex');
    const costOf = (node, nObs) => geneReadCost(node, {
      format: this._format,
      label: matrix.label,
      nObs,
      nVars: matrix.sourceVars,
      decodedChunkBytes: this._decodedChunkBytes,
      valuesOnDemand,
      retainIndicesBytes,
    });
    const rest = segments === null || segments.done === 0
      ? matrix.node
      : rowRangeMatrix(matrix.node, segments.done, matrix.nRows, segments.pointers);
    const cost = await costOf(rest, matrix.nRows - (segments?.done ?? 0));
    let progressive = null;
    if (segments !== null && (segments.done > 0 || segments.next < matrix.nRows)) {
      const first = await costOf(rowRangeMatrix(matrix.node, segments.done, segments.next, segments.pointers), segments.next - segments.done);
      progressive = { cells: matrix.nRows, done: segments.done, next: segments.next, nextStoredBytes: first.scan?.storedBytes ?? null };
    }
    let index = null;
    if (cost.index !== null) {
      const placed = valuesOnDemand && cost.index.passes === 1
        ? { kind: 'memory', refusal: null }
        : await this.columnStoreFactory.plan(cost.index.storeBytes);
      index = { ...cost.index, placement: placed.kind, refusal: placed.refusal };
    }
    const link = this._link?.snapshot?.() ?? null;
    return {
      label: matrix.label,
      cellMajor: cost.cellMajor,
      layout: cost.layout,
      entries: cost.entries,
      built: !cost.cellMajor,
      scan: cost.scan,
      index,
      progressive,
      bytesPerSecond: link !== null && link.measured && !link.readsAhead && link.bytesPerMs !== null
        ? link.bytesPerMs * 1000
        : null,
    };
  }

  /**
   * One column of one expression matrix -- one gene's value in every cell --
   * as float32. `element` is `X`, `layers/<name>` or `raw/X`, or one of a
   * modality's (`mod/<name>/X`, …: NaN where the modality did not measure a
   * cell); `index` is the gene's position on that matrix's var axis. `signal` cancels the read;
   * a read for a job (`owner`, an analysis's) is a job read (kind `analysis`);
   * `keys` name the shared loads it reads for, which a job may join later.
   * `onPartial(values, cells)`: while the gene index of a matrix indexed in
   * segments is built (`prefix-column-index.js`), the gene on the first
   * `cells` open cells (a sample of them: priority order) and NaN on the
   * others, each time it has more of them, before the whole column.
   * `rows` (`[start, end)` of the open cells): the gene on those cells only,
   * reading only what they need where the layout allows
   * (`_placedColumnRows`): the cells an opening grown in place appends, or
   * an analysis's first pass on the first cells of priority order.
   */
  async getMatrixColumn(element, index, { signal = null, owner = null, keys = null, onPartial = null, rows = null } = {}) {
    this._ensureOpen();
    const generation = this._generation;
    const ready = this._readyRows(element, { signal });
    if (ready !== null) {
      await ready;
      this._assertGeneration(generation, `reading ${element}`);
    }
    const matrix = this._requireMatrixElement(element);
    const { label, nVars } = matrix;
    if (!Number.isSafeInteger(index) || index < 0 || index >= nVars) {
      throw new RangeError(`${label} has no gene column ${String(index)}`);
    }
    const range = this._rowRange(rows, label);
    if (range !== null) {
      return this._track(owner === null ? 'genes' : 'analysis', `gene ${index} of ${label}, cells ${range.start}–${range.end}`, async readOptions => {
        const [columns, cells] = await Promise.all([this._matrixColumns(matrix, generation, readOptions), this._cellsOf(matrix, readOptions)]);
        const result = await this._placedColumnRows(matrix, columns, cells, matrix.start + index, range, readOptions);
        this._assertGeneration(generation, `loading gene column ${index} of ${label}`);
        return result;
      }, signal, owner, keys);
    }
    return this._track(owner === null ? 'genes' : 'analysis', `gene ${index} of ${label}`, async readOptions => {
      const [columns, cells] = await Promise.all([this._matrixColumns(matrix, generation, readOptions), this._cellsOf(matrix, readOptions)]);
      const result = await this._placedColumn(matrix, columns, cells, matrix.start + index, onPartial === null ? readOptions : {
        ...readOptions,
        onPartial: (values, rows) => {
          if (this._generation === generation) onPartial(values, rows);
        },
      });
      this._assertGeneration(generation, `loading gene column ${index} of ${label}`);
      return result;
    }, signal, owner, keys);
  }

  /**
   * Many gene columns of one matrix at once, in the order asked: their reads
   * go out together, so the store fetches what they need as one set of
   * coalesced, parallel requests.
   *
   * @param {string} element
   * @param {ReadonlyArray<number>} genes
   * @param {{signal?: AbortSignal|null, owner?: string|null, keys?: string[]|null,
   *   onPartial?: ((position: number, values: Float32Array, cells: number) => void)|null,
   *   rows?: [number, number]|null}} [options] -
   *   `signal` cancels the read; `owner` is the job it is for and `keys` the
   *   shared loads (as `getMatrixColumn`); `onPartial` as `getMatrixColumn`'s,
   *   with the gene's position in `genes`; `rows` as `getMatrixColumn`'s
   * @returns {Promise<Float32Array[]>}
   */
  async getMatrixColumns(element, genes, { signal = null, owner = null, keys = null, onPartial = null, rows = null } = {}) {
    this._ensureOpen();
    const generation = this._generation;
    const ready = this._readyRows(element, { signal });
    if (ready !== null) {
      await ready;
      this._assertGeneration(generation, `reading ${element}`);
    }
    const matrix = this._requireMatrixElement(element);
    const { label, nVars } = matrix;
    const positions = requirePositions(genes, nVars, `${label} gene column`);
    const range = this._rowRange(rows, label);
    return this._track(owner === null ? 'genes' : 'analysis', `${formatCountOf(positions.length, 'gene')} of ${label}${range === null ? '' : `, cells ${range.start}–${range.end}`}`, async readOptions => {
      const [columns, cells] = await Promise.all([this._matrixColumns(matrix, generation, readOptions), this._cellsOf(matrix, readOptions)]);
      const result = await Promise.all(positions.map((gene, position) => range !== null ? this._placedColumnRows(matrix, columns, cells, matrix.start + gene, range, readOptions) : this._placedColumn(matrix, columns, cells, matrix.start + gene, onPartial === null ? readOptions : {
        ...readOptions,
        onPartial: (values, rows) => {
          if (this._generation === generation) onPartial(position, values, rows);
        },
      })));
      this._assertGeneration(generation, `loading ${positions.length} gene columns of ${label}`);
      return result;
    }, signal, owner, keys);
  }

  /**
   * One gene column on open cells `[start, end)` only, reading no more than
   * the layout needs for them: a cell-major matrix indexed in segments
   * (`prefix-column-index.js`) reads the segments those cells lie in; the
   * gene-major X of a priority-ordered file opened as a prefix reads the
   * gene's entries between the prefix-count levels around the rows
   * (`_prefixEntryRows`). Any other matrix is read whole and cut. @private
   */
  async _placedColumnRows(matrix, columns, cells, gene, { start, end }, readOptions) {
    if (cells === null && Array.isArray(columns.segments)) {
      // The segments the rows lie in, built or built now, and no other.
      const out = allocateTypedArray(Float32Array, end - start, 'Gene column');
      const touched = columns.segments.filter(segment => segment.start < end && segment.start + segment.rows > start);
      const { onPartial: _onPartial, ...options } = readOptions;
      const parts = await Promise.all(touched.map(segment => segment.access.column(gene, options)));
      touched.forEach((segment, s) => {
        const from = Math.max(start, segment.start);
        const to = Math.min(end, segment.start + segment.rows);
        out.set(parts[s].subarray(from - segment.start, to - segment.start), from - start);
      });
      return out;
    }
    // Open cell i is file row i (a priority-ordered file opened whole or by
    // a prefix: the dataset's own X, whose cell map is then the first rows),
    // and its gene-major X lists each gene's rows ascending.
    const subset = this._cellSubset;
    const fileRowsAreOpenRows = subset?.prioritySeed != null && (subset.fileRows === null || subset.prefix !== null);
    if (matrix.key === 'X' && fileRowsAreOpenRows && columns.readEntries !== undefined) {
      const rows = await this._prefixEntryRows(matrix, columns, gene, start, end, readOptions);
      if (rows !== null) return denseOfSparse(rows);
    }
    const whole = await this._placedColumn(matrix, columns, cells, gene, readOptions);
    return whole.slice(start, end);
  }

  /**
   * Rows `[start, end)` of one gene as its entries there (`SparseColumn`,
   * rows renumbered from `start`), the values `_placedColumnRows` gives bit
   * for bit: from the segments of a cell-major matrix indexed in parts (each
   * segment's entries), or from a priority-ordered file's gene-major X (the
   * entries between its prefix counts); else the gene's column, kept as its
   * entries. What it holds is the gene's entries, not a value of every row.
   * @private
   */
  async _sparseColumnRows(matrix, columns, gene, { start, end }, readOptions) {
    const { onPartial: _onPartial, ...options } = readOptions;
    if (Array.isArray(columns.segments)) {
      const touched = columns.segments.filter(segment => segment.start < end && segment.start + segment.rows > start);
      const parts = await Promise.all(touched.map(segment => segment.access.sparseColumn(gene, options)));
      let count = 0;
      const inRange = (segment, part, visit) => {
        for (let e = 0; e < part.indices.length; e++) {
          const row = segment.start + part.indices[e];
          if (row >= start && row < end) visit(row - start, part.values[e]);
        }
      };
      touched.forEach((segment, s) => inRange(segment, parts[s], () => { count++; }));
      const indices = allocateTypedArray(Uint32Array, count, 'Gene column cells');
      const values = allocateTypedArray(Float32Array, count, 'Gene column values');
      let at = 0;
      touched.forEach((segment, s) => inRange(segment, parts[s], (row, value) => {
        indices[at] = row;
        values[at++] = value;
      }));
      return { length: end - start, indices, values };
    }
    const subset = this._cellSubset;
    const fileRowsAreOpenRows = subset?.prioritySeed != null && (subset.fileRows === null || subset.prefix !== null);
    if (matrix.key === 'X' && fileRowsAreOpenRows && columns.readEntries !== undefined) {
      const rows = await this._prefixEntryRows(matrix, columns, gene, start, end, readOptions);
      if (rows !== null) return rows;
    }
    return sparseColumnOfDense((await this._placedColumn(matrix, columns, null, gene, options)).subarray(start, end));
  }

  /**
   * Whether `_placedColumnRows` reads a gene's rows without reading it
   * whole: a cell-major matrix indexed in segments, or the gene-major X of a
   * priority-ordered file opened whole or by a prefix. @private
   */
  _readsColumnRows(matrix, columns) {
    if (Array.isArray(columns.segments)) return true;
    const subset = this._cellSubset;
    return matrix.key === 'X' && columns.readEntries !== undefined &&
      Array.isArray(subset?.levels) && subset.levels.length > 0 &&
      subset.prioritySeed != null && (subset.fileRows === null || subset.prefix !== null);
  }

  /**
   * Rows `[start, end)` of one gene of a priority-ordered file's gene-major
   * X opened as a prefix: its entries are sorted by row, so the entries of
   * those rows lie between the gene's prefix counts at the largest level at
   * or below `start` and the smallest at or above `end`
   * (`varm['cellucid_prefix_counts']`, one column a level, each read once
   * per opening); those entries are read, checked and placed. Null when the
   * file has no counts. The rows' entries (`SparseColumn`). @private
   */
  async _prefixEntryRows(matrix, columns, gene, start, end, readOptions) {
    const levels = this._cellSubset?.levels ?? null;
    if (!Array.isArray(levels) || levels.length === 0) return null;
    const above = levels.findIndex(size => size >= end);
    const below = levels.findLastIndex(size => size <= start);
    const [upper, lower] = await Promise.all([
      above < 0 ? null : this._prefixLevelCounts(matrix, above, readOptions),
      below < 0 ? null : this._prefixLevelCounts(matrix, below, readOptions),
    ]);
    if ((above >= 0 && upper === null) || (below >= 0 && lower === null)) return null;
    const first = columns.entryStart(gene);
    const held = columns.entryCount(gene);
    for (const [counts, level] of [[upper, above], [lower, below]]) {
      if (counts !== null && counts[gene] > held) {
        throw new Error(`varm['cellucid_prefix_counts'] of ${matrix.label} counts ${formatCountOf(counts[gene], 'value')} of gene ${gene} at level ${level}, which holds ${held}; the file is damaged`);
      }
    }
    const from = first + (lower === null ? 0 : lower[gene]);
    // One value past the upper count, when the gene has one: its row shows
    // the count holds every value below that level (`requirePrefixRows`).
    const to = first + (upper === null ? held : Math.min(held, upper[gene] + 1));
    if (to <= from) return { length: end - start, indices: new Uint32Array(0), values: new Float32Array(0) };
    const [entryRows, values] = await columns.readEntries(from, to, readOptions);
    const checked = columns.checkedEntries(entryRows, values, 0, entryRows.length, from);
    if (upper !== null) {
      requirePrefixRows(checked.rows, checked.count, upper[gene] - (lower === null ? 0 : lower[gene]), levels[above], gene);
    }
    if (lower !== null && checked.count > 0 && checked.rows[0] < levels[below]) {
      throw new Error(`varm['cellucid_prefix_counts'] of ${matrix.label} counts ${formatCountOf(lower[gene], 'value')} of gene ${gene} below ${formatCountOf(levels[below], 'row')}, and the next is at row ${checked.rows[0]}; the file is damaged`);
    }
    // The entries of rows `[start, end)` (ascending), renumbered from
    // `start`, as a whole column holds them (duplicates summed in float32,
    // in stored order; zeros left out).
    let low = 0;
    while (low < checked.count && checked.rows[low] < start) low++;
    let high = low;
    while (high < checked.count && checked.rows[high] < end) high++;
    const rows = allocateTypedArray(Float64Array, high - low, 'Gene column cells');
    for (let e = low; e < high; e++) rows[e - low] = checked.rows[e] - start;
    return sparseColumnOf(rows, checked.values.subarray(low, high), high - low, end - start);
  }

  /**
   * The prefix counts of one level of a priority-ordered file's gene-major
   * X (`readPrefixCounts`), read once per opening; null without counts.
   * @private
   */
  _prefixLevelCounts(matrix, level, readOptions) {
    this._levelCounts ??= new Map();
    const key = `${matrix.key}:${level}`;
    let read = this._levelCounts.get(key);
    if (read === undefined) {
      const group = matrix.key === 'X' ? this._fullRoot ?? this._root : null;
      read = group === null ? Promise.resolve(null) : readPrefixCounts(group, level, matrix.sourceVars, { signal: readOptions.signal ?? null, activity: readOptions.activity ?? null }, { levelRows: this._cellSubset.levels[level] });
      read.catch(() => this._levelCounts?.delete(key));
      this._levelCounts.set(key, read);
    }
    return read;
  }

  /**
   * One gene column on the dataset's cells. A matrix read through a
   * subsample's kept rows (`throughCells`) is read as its non-zero entries
   * and made dense on the kept cells, never at its stored length. @private
   */
  async _placedColumn(matrix, columns, cells, gene, readOptions) {
    if (matrix.throughCells) {
      return denseOfSparse(placeSparseColumn(await columns.sparseColumn(gene, readOptions), cells, this._nObs, matrix.nRows));
    }
    return placeColumn(await columns.column(gene, readOptions), cells, this._nObs);
  }

  /**
   * Many gene columns of one matrix as their non-zero entries
   * (`SparseColumn`: `{length, indices: Uint32Array, values: Float32Array}`,
   * each array owning its buffer), in the order asked: what an analysis
   * computes from, about 45 times fewer bytes than the dense column of a
   * median gene. The values are the dense column's, bit for bit. An
   * analysis's read (kind `analysis`): its job (`owner`) shows it.
   *
   * @param {string} element
   * @param {ReadonlyArray<number>} genes
   * @param {{signal?: AbortSignal|null, owner?: string|null}} [options] -
   *   `signal` cancels the read; `owner` is the job it reads for
   * @returns {Promise<Array<import('../sparse-column-index.js').SparseColumn>>}
   */
  async getMatrixColumnsSparse(element, genes, { signal = null, owner = null } = {}) {
    this._ensureOpen();
    const generation = this._generation;
    const ready = this._readyRows(element, { signal });
    if (ready !== null) {
      await ready;
      this._assertGeneration(generation, `reading ${element}`);
    }
    const matrix = this._requireMatrixElement(element);
    const { label, nVars } = matrix;
    const positions = requirePositions(genes, nVars, `${label} gene column`);
    return this._track('analysis', `${positions.length === 1 ? `gene ${positions[0]}` : `${formatCountOf(positions.length, 'gene')}`} of ${label}`, async readOptions => {
      const [columns, cells] = await Promise.all([this._matrixColumns(matrix, generation, readOptions), this._cellsOf(matrix, readOptions)]);
      const result = (await Promise.all(positions.map(gene => columns.sparseColumn(matrix.start + gene, readOptions))))
        .map(column => placeSparseColumn(column, cells, this._nObs, matrix.nRows));
      this._assertGeneration(generation, `loading ${positions.length} gene columns of ${label}`);
      return result;
    }, signal, owner);
  }

  /**
   * The non-zero genes of cells (rows) of one matrix, in the order asked.
   *
   * @param {string} element
   * @param {ReadonlyArray<number>} cells
   * @param {{signal?: AbortSignal|null}} [options] - `signal` cancels the read
   * @returns {Promise<Array<{genes: Int32Array, values: Float32Array}>>}
   */
  async getMatrixRows(element, cells, { signal = null } = {}) {
    this._ensureOpen();
    const generation = this._generation;
    const ready = this._readyRows(element, { signal });
    if (ready !== null) {
      await ready;
      this._assertGeneration(generation, `reading ${element}`);
    }
    const matrix = this._requireMatrixElement(element);
    const { label } = matrix;
    const positions = requirePositions(cells, this._nObs, `${label} cell row`);
    const access = await this._matrixRows(matrix, signal);
    return this._track('cells', `${formatCountOf(positions.length, 'cell')} of ${label}`, async readOptions => {
      const map = await this._cellsOf(matrix, readOptions);
      const measured = map === null ? positions : positions.filter(cell => map[cell] >= 0);
      const stored = map === null ? measured : measured.map(cell => map[cell]);
      // A CSR matrix reads nearby rows as one range; any other layout row by row.
      const read = access.rows !== undefined
        ? await access.rows(stored, readOptions)
        : await Promise.all(stored.map(row => access.row(row, readOptions)));
      // A cell the modality did not measure has no genes.
      let next = 0;
      const result = positions.map(cell => (map !== null && map[cell] < 0
        ? { genes: new Int32Array(0), values: new Float32Array(0) }
        : windowRow(read[next++], matrix.start, matrix.nVars, matrix.sourceVars)));
      this._assertGeneration(generation, `loading ${positions.length} cell rows of ${label}`);
      return result;
    }, signal);
  }

  /** The row access of one matrix, opened once and shared (`openMatrixRows`). @private */
  async _matrixRows(matrix, signal) {
    const { node, label, nRows, sourceVars, key } = matrix;
    if (this._rows?.element !== key) {
      this._releaseRows();
      const rows = openMatrixRows(node, {
        format: this._format,
        label,
        nObs: nRows,
        nVars: sourceVars,
        indexOptions: this._indexOptions(),
        onIndexStart: indexLabel => this.createActivity?.({ kind: 'index', label: `${indexLabel}, indexed by cell`, background: true }) ?? null,
        inFlightEntries: this._inFlightEntries(),
      });
      rows.catch(() => {});
      this._rows = { element: key, rows };
    }
    const state = this._rows;
    try {
      return await untilAborted(state.rows, signal);
    } catch (error) {
      if (this._rows === state) this._rows = null;
      throw error;
    }
  }

  /**
   * Entries a long read keeps requested at once: two slabs read ahead, as
   * every streamed read does; over a slower link, at least what fills every
   * request the link runs at once. A scheduling choice, not a limit.
   * @private
   */
  _inFlightEntries() {
    const slabs = 2 * SLAB_BYTES;
    const link = this._readsAhead() ? null : this._link.snapshot();
    const bytes = link === null ? slabs : Math.max(slabs, link.maxRequestBytes * link.concurrency);
    return Math.floor(bytes / 8);
  }

  /**
   * The values of some genes in some cells of one matrix, as a gene-major
   * sparse block: gene `genes[g]` has the entries `pointers[g]` to
   * `pointers[g + 1]`, each at position `cellIndex[k]` of `cells` (ascending
   * within a gene) with value `values[k]`; a cell a gene does not list is
   * zero.
   *
   * Read by whichever costs less (`readCellSubset`), counted in the bytes
   * each decodes or copies: the cells' rows (a CSR or dense matrix: every
   * chunk the rows touch), or the genes' columns (a CSC matrix's ranges, or
   * a gene index's entries in memory, plus what is left of building it).
   * Few cells of a large matrix are read by cell; many, or any once the gene
   * index is built, by gene.
   *
   * @param {string} element
   * @param {ReadonlyArray<number>} cells - Distinct cell positions
   * @param {ReadonlyArray<number>} genes - Distinct gene positions
   * @param {{signal?: AbortSignal|null, owner?: string|null}} [options] -
   *   An analysis's read (kind `analysis`) for the job `owner`
   * @returns {Promise<{pointers: Float64Array, cellIndex: Int32Array, values: Float32Array}>}
   */
  async getMatrixCellSubset(element, cells, genes, { signal = null, owner = null } = {}) {
    this._ensureOpen();
    const generation = this._generation;
    const ready = this._readyRows(element, { signal });
    if (ready !== null) {
      await ready;
      this._assertGeneration(generation, `reading ${element}`);
    }
    const matrix = this._requireMatrixElement(element);
    const { node, label, nVars } = matrix;
    const cellPositions = requirePositions(cells, this._nObs, `${label} cell row`);
    const genePositions = requirePositions(genes, nVars, `${label} gene column`);
    for (const [positions, what] of [[cellPositions, 'cell'], [genePositions, 'gene']]) {
      if (new Set(positions).size !== positions.length) {
        throw new RangeError(`A cell subset of ${label} names a ${what} more than once`);
      }
    }
    const byCell = !isGroup(node) || sparseContract(node, this._format, `Sparse ${label}`).format === 'csr';
    return this._track('analysis', `${formatCountOf(genePositions.length, 'gene')} in ${formatCountOf(cellPositions.length, 'cell')} of ${label}`, async readOptions => {
      // Cells that all lie among the first open cells -- an analysis's
      // first pass on a sample of them (`progressive-cells.js`) -- are read
      // from those rows of each gene only, where the layout can read rows:
      // each gene's entries there, never a column of every row.
      const prefixEnd = cellPositions.reduce((max, cell) => Math.max(max, cell + 1), 0);
      if (prefixEnd < this._nObs) {
        const columns = await this._matrixColumns(matrix, generation, readOptions);
        if (this._readsColumnRows(matrix, columns)) {
          const parts = await Promise.all(genePositions.map(gene => this._sparseColumnRows(matrix, columns, matrix.start + gene, { start: 0, end: prefixEnd }, readOptions)));
          this._assertGeneration(generation, `loading ${formatCountOf(genePositions.length, 'gene')} in ${formatCountOf(cellPositions.length, 'cell')} of ${label}`);
          return cellSubsetOfSparseColumns(parts, cellPositions);
        }
      }
      const [columns, rows, map] = await Promise.all([
        this._matrixColumns(matrix, generation, readOptions),
        byCell ? this._matrixRows(matrix, readOptions.signal) : null,
        this._cellsOf(matrix, readOptions),
      ]);
      // A modality reads the cells it measured, at its own rows.
      const measured = map === null ? null : cellPositions.flatMap((cell, position) => (map[cell] >= 0 ? [position] : []));
      const { block } = await readCellSubset(
        columns,
        rows,
        measured === null ? cellPositions : measured.map(position => map[cellPositions[position]]),
        genePositions.map(gene => matrix.start + gene),
        { nObs: matrix.nRows, label, inFlightEntries: this._inFlightEntries(), readOptions }
      );
      this._assertGeneration(generation, `loading ${formatCountOf(genePositions.length, 'gene')} in ${formatCountOf(cellPositions.length, 'cell')} of ${label}`);
      return measured === null ? block : placeCellSubset(block, measured, cellPositions.length);
    }, signal, owner);
  }

  /**
   * Where each cell sits in the modality one matrix belongs to: an
   * `Int32Array` of rows (-1 where not measured), or null when the rows are
   * the dataset's cells in order (the root's matrices, and a modality that
   * measured every cell in order). @private
   */
  async _cellsOf(matrix, readOptions) {
    if (matrix.cells === null) return null;
    const map = await matrix.cells(readOptions);
    return map.identity ? null : map.rows;
  }

  /** Whether the store's link delivers bytes as fast as a disk (see `open`). @private */
  _readsAhead() {
    return this._link === null || this._link.readsAhead;
  }

  /**
   * The index options of a matrix indexed whole by its rows: started from
   * its index kept in this browser when one covers every open row, else
   * kept once built (`kept-column-index.js`). @private
   */
  async _wholeIndexOptions(resolved) {
    const options = this._indexOptions();
    const { node: matrix, nRows } = resolved;
    const byRows = this._keptRowsOf(resolved) !== null &&
      readsThroughRowIndex(matrix, { nObs: nRows, nVars: resolved.sourceVars, decodedChunkBytes: this._decodedChunkBytes });
    if (!byRows) return options;
    const runs = await this._takeKeptRuns(resolved, () => this._openRowPointers(matrix));
    const whole = runs.find(run => run.start === 0 && run.rows === nRows) ?? null;
    for (const run of runs) if (run !== whole) run.kept.release();
    return whole !== null
      ? { ...options, kept: whole.kept }
      : { ...options, fingerprintRows: fingerprintRows(nRows), onBuilt: (store, fingerprint) => this._keepRun(resolved, 0, nRows, store._rowPointers ?? null, store, fingerprint) };
  }

  /** Options of a background index (`RowMajorColumnIndex`), from the link as measured now. @private */
  _indexOptions() {
    const budget = residencyBudgetBytes('columnIndex');
    const readsAhead = this._readsAhead();
    const link = this._link;
    return {
      storeFactory: this.columnStoreFactory,
      // Read ahead (a link as fast as a disk), a sparse matrix is indexed
      // with its values, as a local file is, pass 1's indices (and values a
      // waiting gene made it read) kept for pass 2 within what the budget
      // leaves beside the store, saving a second decode of them; a gene is
      // then a copy out of the column store. Over a slower link the indices
      // are the index (values are read per gene, where genes need them), and
      // reading them again costs far more than keeping them, so the whole
      // budget is theirs.
      retainIndicesBytes: budget,
      valuesOnDemand: !readsAhead,
      // What a request costs on the link, for reading genes' value ranges.
      link: link === null ? null : () => link.snapshot(),
      yieldControl: waited => this._yieldToForeground(waited),
    };
  }

  /** Release row access and any index it holds. @private */
  _releaseRows() {
    const state = this._rows;
    this._rows = null;
    state?.rows.then(rows => (rows.retire ?? rows.dispose)?.(), () => {});
  }

  /**
   * Start indexing one expression matrix by gene in the background, when its
   * layout needs it (CSR) and the link reads ahead (see `open`), so the first
   * gene shown does not wait for the whole build. A dense matrix is not
   * indexed ahead: its index holds every value, as much memory as the matrix
   * itself (28,317 x 3,136 float32: 663 MB resident at open, for a dataset
   * whose genes may never be shown), so it is built when the first gene is
   * asked for (549 ms on that matrix, read from disk) and kept within the
   * column-index budget like any other. Returns at once; a failure reaches
   * the gene reads.
   */
  prepareMatrix(element) {
    this._ensureOpen();
    if (!this._readsAhead()) return;
    const generation = this._generation;
    Promise.resolve(this._readyRows(element))
      .then(() => {
        if (generation !== this._generation) return null;
        const matrix = this._requireMatrixElement(element);
        return isGroup(matrix.node) ? this._matrixColumns(matrix, generation).then(columns => columns.prepare?.()) : null;
      })
      .catch(() => {});
  }

  /**
   * The state of one matrix, made the one read now (the last of
   * `_matrices`); switching matrices settles the others. @private
   */
  _matrixState(element) {
    let state = this._matrices.get(element);
    const switched = state === undefined || [...this._matrices.keys()].at(-1) !== element;
    if (state === undefined) state = { element, columns: null, load: null };
    this._matrices.delete(element);
    this._matrices.set(element, state);
    if (switched) this._settleMatrices();
    return state;
  }

  /**
   * Keep what the memory budget holds of the matrices read before the one
   * read now: an index still being built stops (its waiting genes are still
   * answered); built indexes stay, most recently read first, while they and
   * the current matrix's index fit `columnIndex`. @private
   */
  _settleMatrices() {
    const states = [...this._matrices.values()];
    const current = states.pop();
    let held = current.columns?.residentBytes?.() ?? 0;
    const budget = residencyBudgetBytes('columnIndex');
    for (const state of states.reverse()) {
      const built = state.columns !== null && state.columns.built?.() !== false;
      const bytes = state.columns?.residentBytes?.() ?? 0;
      if (built && held + bytes <= budget) {
        held += bytes;
      } else {
        this._releaseMatrixState(state);
      }
    }
  }

  /**
   * The column access of one matrix, opened once and shared: concurrent first
   * reads must not each start an index. Each caller waits with its own
   * signal, and the opening's reads stop only once every caller withdrew
   * (`SharedWork`), so one caller cancelling never fails the others.
   * @private
   */
  async _matrixColumns(resolved, generation, readOptions = {}) {
    const { node: matrix, label, nRows, sourceVars, key: element } = resolved;
    const state = this._matrixState(element);
    if (state.columns) return state.columns;
    // Opened once and shared by every read asking meanwhile (`SharedWork`):
    // what it reads (row pointers, the open cells' rows) stops only once
    // every one of them withdrew, and is then opened anew by the next.
    if (state.load === null || state.load.abandoned) {
      const carried = this._carried.get(element)?.columns ?? null;
      if (carried !== null) this._carried.delete(element);
      const open = loadOptions => {
        if (carried !== null) return Promise.resolve(carried);
        if (this._indexedInSegments(resolved)) return this._segmentedColumns(resolved, loadOptions);
        // A gene-major matrix read through a subsample's kept rows reads only
        // their entries' values where that saves more than a round trip.
        const keptRows = resolved.throughCells ? this._cellsOf(resolved, loadOptions).then(rows => (rows === null ? null : keptRowsOf(rows)?.sorted ?? null)) : null;
        return Promise.all([this._wholeIndexOptions(resolved), keptRows]).then(([indexOptions, kept]) => openMatrixColumns(matrix, {
          format: this._format,
          label,
          nObs: nRows,
          nVars: sourceVars,
          decodedChunkBytes: this._decodedChunkBytes,
          indexOptions,
          onIndexStart: (indexLabel, { rescan = null } = {}) => this.createActivity?.({
            kind: 'index',
            label: geneIndexActivityLabel(label, rescan),
            background: rescan === null,
          }) ?? null,
          readOptions: { activity: loadOptions.activity ?? null },
          pointers: this._pointerReads.get(element) ?? null,
          keptRows: kept,
          roundTripBytes: () => this._link?.roundTripBytes ?? 0,
        })).then(columns => (resolved.prefix === null || resolved.prefix === undefined ? columns : this._prefixColumns(columns, resolved, loadOptions)));
      };
      state.load = new SharedWork(signal => open({ ...readOptions, signal }).then(columns => {
        // Opened after every caller withdrew: nobody takes it, so it is let go.
        if (signal.aborted) {
          (columns.retire ?? columns.dispose)?.();
          throw signal.reason;
        }
        return columns;
      }));
    }
    const load = state.load;
    let columns;
    try {
      columns = await load.join(readOptions.signal ?? null);
    } catch (error) {
      // Pointers read ahead that failed are read again by the next attempt
      // (not when this read was only cancelled).
      if (!readOptions.signal?.aborted) this._pointerReads.delete(element);
      throw error;
    } finally {
      if (state.load === load && load.settled) state.load = null;
    }
    this._assertGeneration(generation, `loading ${label}`);
    if (this._matrices.get(element) !== state) {
      // The matrix was let go while it opened: this read is still answered,
      // then the columns are let go.
      const once = read => async (index, options) => {
        try {
          return await read(index, options);
        } finally {
          (columns.retire ?? columns.dispose)?.();
        }
      };
      return { ...columns, column: once(columns.column), sparseColumn: once(columns.sparseColumn) };
    }
    if (state.columns === null) {
      // A failed read is not kept: the next read of this matrix starts over
      // (a transient read error must not stick to the dataset). A read its
      // caller cancelled did not fail: the access stays.
      const kept = read => async (index, options) => {
        try {
          return await read(index, options);
        } catch (error) {
          if (options?.signal?.aborted) throw error;
          if (this._matrices.get(element) === state && state.columns?.source === columns) {
            this._matrices.delete(element);
            columns.dispose?.();
          }
          throw error;
        }
      };
      state.columns = {
        ...columns,
        column: kept(columns.column),
        sparseColumn: kept(columns.sparseColumn),
        source: columns,
      };
    } else if (state.columns.source !== columns) {
      columns.dispose?.();
    }
    return state.columns;
  }

  /**
   * A gene-major X of a priority-ordered file opened as the prefix of its
   * first `prefix` rows: a gene reads only the first entries of its range
   * (its rows ascend, so the kept rows' entries come first), as many as
   * `varm['cellucid_prefix_counts']` says for the smallest level holding
   * the prefix, and the next (its row shows the count holds every value
   * below the level: `requirePrefixRows`), then keeps the rows below it.
   * The access is the prefix's for every reader of it: `entryCount` is what
   * a read of a gene takes, so a cell subset read in runs of genes
   * (`subsetByColumns`, an analysis over every gene) reads those entries and
   * checks them (`requireEntries`), never a gene whole. Without the counts
   * the gene is read whole. @private
   */
  async _prefixColumns(columns, resolved, _readOptions) {
    const read = this._prefixReads?.get(resolved.key) ?? null;
    if (columns.readEntries === undefined || read === null) return columns;
    // The counts of the opened level, read as the dataset opened (`startPrefixReads`).
    const prefixRead = await read;
    if (prefixRead === null) return columns;
    const { counts, levelRows } = prefixRead;
    if (counts.length !== resolved.sourceVars) {
      throw new Error(`varm['cellucid_prefix_counts'] of ${resolved.label} counts ${formatCountOf(counts.length, 'gene')} for ${resolved.sourceVars}; the file is damaged`);
    }
    const k = resolved.prefix;
    /** The entries a read of gene `gene` takes: its counted ones and the next, when it has one. */
    const counted = gene => {
      const held = columns.entryCount(gene);
      if (counts[gene] > held) {
        throw new Error(`varm['cellucid_prefix_counts'] of ${resolved.label} counts ${formatCountOf(counts[gene], 'value')} of gene ${gene}, which holds ${held}; the file is damaged`);
      }
      return Math.min(held, counts[gene] + 1);
    };
    const sparseColumn = async (gene, options = {}) => {
      const start = columns.entryStart(gene);
      const end = start + counted(gene);
      const [rows, values] = end === start ? [new Int32Array(0), new Float32Array(0)] : await columns.readEntries(start, end, options);
      const checked = columns.checkedEntries(rows, values, 0, rows.length, start);
      requirePrefixRows(checked.rows, checked.count, counts[gene], levelRows, gene);
      let kept = 0;
      while (kept < checked.count && checked.rows[kept] < k) kept++;
      return sparseColumnOf(checked.rows, checked.values, kept, resolved.nRows);
    };
    return {
      ...columns,
      sparseColumn,
      column: async (gene, options = {}) => denseOfSparse(await sparseColumn(gene, options)),
      entryCount: counted,
      requireEntries: (gene, rows, from, to) => requirePrefixRows(rows.subarray(from, to), to - from, counts[gene], levelRows, gene),
    };
  }

  /** Release one matrix and any index it holds. @private */
  _releaseMatrixState(state) {
    if (this._matrices.get(state.element) === state) this._matrices.delete(state.element);
    const columns = state.columns;
    state.columns = null;
    if (columns) (columns.retire ?? columns.dispose)?.();
  }

  /** Release every matrix and the indexes they hold; every release is tried. @private */
  _releaseMatrices() {
    const failures = [];
    for (const state of [...this._matrices.values()]) {
      try {
        this._releaseMatrixState(state);
      } catch (error) {
        failures.push(error);
      }
    }
    this._matrices.clear();
    // Columns carried over from an earlier opening and never read go too.
    for (const carried of this._carried.values()) {
      try {
        for (const segment of carried.segments ?? []) (segment.access.retire ?? segment.access.dispose)?.();
        if (carried.columns) (carried.columns.retire ?? carried.columns.dispose)?.();
      } catch (error) {
        failures.push(error);
      }
    }
    this._carried.clear();
    // Kept runs found and never taken: their locks go.
    for (const found of this._keptRuns.values()) found.then(runs => runs.forEach(run => run.kept.release()), () => {});
    this._keptRuns.clear();
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Releasing the matrix indexes failed');
  }

  /** The obs column `key`, checked to exist. @private */
  _obsColumn(key) {
    const obs = this._root.get('obs');
    if (!isGroup(obs) || !obs.has(key)) throw new Error(`Obs field '${key}' not found`);
    return obs;
  }

  /** Categories of one categorical field, read once per generation. @private */
  async _categories(categorical, key, generation, readOptions = {}) {
    const cacheKey = `obs_categories:${key}`;
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);
    const categories = await readCategories(categorical.categories, key, this._format, readOptions);
    this._assertGeneration(generation, `reading categorical labels for '${key}'`);
    if (!this._cache.has(cacheKey)) this._cache.set(cacheKey, categories);
    return this._cache.get(cacheKey);
  }

  /**
   * One obs field's type and (for categoricals) category count or labels,
   * without reading its values. @private
   */
  async _fieldInfo(key, { withCategories }) {
    this._ensureOpen();
    const cacheKey = withCategories ? `obs_info:${key}` : `obs_type:${key}`;
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);
    if (!withCategories) return this._readFieldInfo(key, cacheKey, false, {});
    return this._track('field', `categories of obs['${key}']`, readOptions => this._readFieldInfo(key, cacheKey, true, readOptions));
  }

  /** @private */
  async _readFieldInfo(key, cacheKey, withCategories, readOptions) {
    const generation = this._generation;
    const format = this._format;
    const obs = this._obsColumn(key);
    const item = obs.get(key);
    const declared = validateColumnEncoding(item, format, `Observation field '${key}'`);
    const categorical = resolveCategoricalColumn(obs, key, format);
    let result;
    if (categorical) {
      validateCodes(categorical.codes, key, format, this._nObs);
      if (withCategories) {
        // The palette is read with the categories it colours, as metadata:
        // the first colouring, a legend or a restored session all need it
        // before any code is read.
        const [categories, colors] = await Promise.all([
          this._categories(categorical, key, generation, readOptions),
          readObsFieldColors(this._root, key, readOptions),
        ]);
        result = { dtype: 'categorical', categories, ordered: categorical.ordered, colors };
      } else {
        result = { dtype: 'categorical', categoryCount: categoryCount(categorical.categories, key, format), ordered: categorical.ordered };
      }
    } else if (NULLABLE_ENCODINGS.has(declared)) {
      const contract = nullableContract(item, key, declared, format, this._nObs);
      result = {
        dtype: declared === 'nullable-integer'
          ? (contract.valuesKind === 'uint' ? 'uint' : 'int')
          : (declared === 'nullable-boolean' ? 'bool' : 'string'),
      };
    } else {
      validateOneDimensional(item, format, `Observation field '${key}'`, this._nObs);
      result = { dtype: valueKind(item) };
    }
    this._assertGeneration(generation, `reading observation field metadata '${key}'`);
    this._cache.set(cacheKey, result);
    return result;
  }

  /** An obs field's type and categories, without its values. */
  getObsFieldInfo(key) {
    return this._fieldInfo(key, { withCategories: true });
  }

  /**
   * An obs field's type from its metadata alone, nothing read: a
   * categorical's `categoryCount` and `ordered`, not its categories (a
   * dictionary of one category per cell is megabytes, read when the field
   * is first loaded).
   */
  getObsFieldKind(key) {
    return this._fieldInfo(key, { withCategories: false });
  }

  /**
   * An obs field's values: categorical codes with their categories,
   * continuous values as float32, booleans and strings as values (null where
   * a nullable column is missing). `signal` cancels the read.
   */
  /**
   * One obs column on the open cells. `rows` (`[start, end)` of the open
   * cells) reads only those rows -- what an opening grown in place appends
   * (`AnnDataFileSource.resizeCells`) -- and is not cached; every row, cached,
   * by default.
   *
   * @param {string} key
   * @param {{signal?: AbortSignal|null, rows?: [number, number]|null}} [options]
   */
  async getObsField(key, { signal = null, rows = null } = {}) {
    this._ensureOpen();
    const range = this._rowRange(rows, `obs['${key}']`);
    if (range !== null) {
      return this._track('field', `obs['${key}'] rows ${range.start}–${range.end}`, readOptions => this._readObsField(key, null, readOptions, range), signal);
    }
    const cacheKey = `obs:${key}`;
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);
    return this._track('field', `obs['${key}']`, readOptions => this._readObsField(key, cacheKey, readOptions), signal);
  }

  /**
   * Rows `[start, end)` of the open cells as `{start, end}`, checked; null for
   * every row (`rows` null, or exactly `[0, nObs)`). @private
   */
  _rowRange(rows, label) {
    if (rows === null || rows === undefined) return null;
    const [start, end] = Array.isArray(rows) && rows.length === 2 ? rows : [NaN, NaN];
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > this._nObs) {
      throw new RangeError(`Rows of ${label} are [start, end) within the ${formatCountOf(this._nObs, 'open cell')}; got ${JSON.stringify(rows)}`);
    }
    return start === 0 && end === this._nObs ? null : { start, end };
  }

  /** @private */
  async _readObsField(key, cacheKey, readOptions, range = null) {
    const generation = this._generation;
    const format = this._format;
    const obs = this._obsColumn(key);
    const item = obs.get(key);
    const declared = validateColumnEncoding(item, format, `Observation field '${key}'`);
    const categorical = resolveCategoricalColumn(obs, key, format);
    const start = range?.start ?? 0;
    let result;
    if (categorical) {
      const count = categoryCount(categorical.categories, key, format);
      const [categories, codes] = await Promise.all([
        this._categories(categorical, key, generation, readOptions),
        readCodes(categorical.codes, count, key, format, this._nObs, readOptions, range),
      ]);
      result = {
        dtype: 'categorical',
        codes,
        categories,
        ordered: categorical.ordered,
        // Values are rarely needed (codes and categories are); computed once,
        // only when asked for.
        get values() {
          const computed = Array.from(codes, code => (code >= 0 ? categories[code] : null));
          Object.defineProperty(this, 'values', { value: computed, writable: false });
          return computed;
        },
      };
    } else if (NULLABLE_ENCODINGS.has(declared)) {
      result = await readNullableValues(item, key, declared, format, this._nObs, null, readOptions, range);
    } else {
      const label = `Observation field '${key}'`;
      const end = range?.end ?? validateOneDimensional(item, format, label, this._nObs);
      if (range !== null) validateOneDimensional(item, format, label, this._nObs);
      const length = end - start;
      const dtype = requirePrimitiveKind(item, label);
      if (!OBS_KINDS.includes(dtype)) throw new Error(`${label} uses an unsupported element type`);
      let values;
      if (dtype === 'float' || dtype === 'int' || dtype === 'uint') {
        values = await readFloat32(item, start, end, label, readOptions);
      } else {
        const raw = await readStored(item, start, end, label, readOptions);
        values = new Array(length);
        if (dtype === 'bool') {
          const message = `Observation field '${key}' contains a non-boolean value`;
          for (let i = 0; i < length; i++) values[i] = decodeAnnDataBoolean(raw[i], message);
        } else {
          for (let i = 0; i < length; i++) values[i] = raw[i];
        }
      }
      result = { dtype, values };
    }
    this._assertGeneration(generation, `reading observation field '${key}'`);
    if (cacheKey !== null) this._cache.set(cacheKey, result);
    return result;
  }

  /**
   * Restore a category dictionary retained by the adapter after this reader's
   * caches were cleared; the immutable array is shared, not decoded again.
   */
  seedObsFieldCategories(key, categories, ordered) {
    this._ensureOpen();
    if (!Array.isArray(categories)) return;
    if (typeof ordered !== 'boolean') throw new Error(`Categorical field '${key}' ordered must be a boolean`);
    const categoriesKey = `obs_categories:${key}`;
    const infoKey = `obs_info:${key}`;
    if (!this._cache.has(categoriesKey)) this._cache.set(categoriesKey, categories);
    if (!this._cache.has(infoKey)) this._cache.set(infoKey, { dtype: 'categorical', categories, ordered });
  }

  /**
   * Hand one observation payload to the caller: the reader forgets it but
   * keeps the field's categories and type, so the payload can be transferred
   * out of the worker without leaving a detached buffer in this cache.
   */
  detachObsField(key, field) {
    const cacheKey = `obs:${key}`;
    if (this._cache.get(cacheKey) === field) this._cache.delete(cacheKey);
  }

  /** Release one cached observation payload (and category aliases the adapter keeps). */
  releaseObsField(key, expected = undefined) {
    const cacheKey = `obs:${key}`;
    const cached = this._cache.get(cacheKey);
    if (expected !== undefined && cached !== expected) return;
    this._cache.delete(cacheKey);
    const categories = cached?.dtype === 'categorical' ? cached.categories : null;
    if (!Array.isArray(categories)) return;
    const categoriesKey = `obs_categories:${key}`;
    if (this._cache.get(categoriesKey) === categories) this._cache.delete(categoriesKey);
    const infoKey = `obs_info:${key}`;
    const info = this._cache.get(infoKey);
    if (info?.dtype === 'categorical' && info.categories === categories) this._cache.delete(infoKey);
  }

  /**
   * One neighbour graph's metadata (`obsp[key]`), checked without reading
   * it, or null when `obsp` has no such key. @private
   */
  _connectivityMetadata(key) {
    this._ensureOpen();
    requireObspKey(key);
    const cacheKey = `connectivity:metadata:${key}`;
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);
    const format = this._format;
    let result = null;
    if (this._root.has('obsp')) {
      const obsp = requireMapping(this._root.get('obsp'), format, `${format.file} obsp mapping`);
      if (obsp.has(key)) {
        const conn = obsp.get(key);
        // A subsample's graphs are stored on every cell; their induced
        // subgraph is read (`readInducedGraph`).
        const nStored = this._cellSubset?.rows?.nOriginal ?? this._nObs;
        if (isGroup(conn)) {
          const sparse = sparseContract(conn, format, 'Connectivity matrix');
          if (sparse.shape[0] !== nStored || sparse.shape[1] !== nStored) {
            throw new Error(`Connectivity matrix shape ${sparse.shape[0]}×${sparse.shape[1]} does not match ${formatCountOf(nStored, 'cell')}`);
          }
          result = { kind: 'sparse', node: conn };
        } else {
          validateArrayEncoding(conn, format, 'Dense connectivity matrix', 'array');
          const shape = shapeOf(conn, 'Dense connectivity matrix', 2);
          if (shape[0] !== nStored || shape[1] !== nStored) {
            throw new Error(`Connectivity matrix shape ${shape[0]}×${shape[1]} does not match ${formatCountOf(nStored, 'cell')}`);
          }
          if (!isAnnDataMatrixDataKind(valueKind(conn))) throw new Error('Dense connectivity matrix must use a numeric dtype');
          result = { kind: 'dense', node: conn, shape };
        }
      }
    }
    this._cache.set(cacheKey, result);
    return result;
  }

  /** Whether `obsp[key]` holds a neighbour graph. */
  async hasConnectivities(key) {
    return this._connectivityMetadata(key) !== null;
  }

  /**
   * The edges of `obsp[key]`, checked and extracted here, beside the matrix
   * (in the reader worker), so the page never walks a large graph.
   */
  async getConnectivityEdges(key, options = {}) {
    const matrix = await this.getConnectivities(key, options);
    return this._inForeground(() => connectivityEdgesOf(matrix, this._nObs));
  }

  /** One neighbour graph, `obsp[key]`, read whole (not cached: its edges are). */
  async getConnectivities(key, { signal = null } = {}) {
    this._ensureOpen();
    const metadata = this._connectivityMetadata(key);
    if (metadata === null) return null;
    return this._track('graph', `obsp['${key}']`, readOptions => this._readConnectivities(key, metadata, readOptions), signal);
  }

  /** @private */
  async _readConnectivities(key, metadata, readOptions) {
    const generation = this._generation;
    let result;
    const rows = this._cellSubset?.rows ?? null;
    if (rows !== null) {
      const { share, ...graph } = await readInducedGraph(metadata.node, rows, {
        mergeGapBytes: () => this._mergeGapBytes(),
        roundTripBytes: () => this._link?.roundTripBytes ?? 0,
        readOptions,
      });
      this._assertGeneration(generation, 'loading connectivity data');
      this._graphShares.set(key, share);
      return graph.format === 'dense' ? graph : { cscData: null, ...graph };
    }
    if (metadata.kind === 'dense') {
      const [nRows, nCols] = metadata.shape;
      // Every row, every column: a two-dimensional read, not a row range of
      // a one-dimensional array.
      const data = await metadata.node.read([[0, nRows], [0, nCols]], readOptions);
      result = { data, format: 'dense', shape: metadata.shape };
      if (!data || data.length !== nRows * nCols) throw new Error('Dense connectivity matrix payload length does not match its shape');
    } else {
      result = await readSparseMatrix(metadata.node, this._format, 'Connectivity matrix', 'exact', readOptions);
    }
    this._assertGeneration(generation, 'loading connectivity data');
    return result;
  }


  async getDatasetMetadata() {
    this._ensureOpen();
    const generation = this._generation;
    const probes = await this.probeMapping();
    let nCategorical = 0;
    let nContinuous = 0;
    for (const key of this._obsKeys) {
      const info = await this._fieldInfo(key, { withCategories: false });
      if (info.dtype === 'categorical') nCategorical++;
      else if (info.dtype === 'float' || info.dtype === 'int' || info.dtype === 'uint') nContinuous++;
    }
    // The graph a file opens with is obsp['connectivities'] (the data
    // mapping's default); any other is read only when it is chosen.
    const hasConnectivity = await this.hasConnectivities(DEFAULT_KNN_KEY);
    const title = await this._title;
    this._assertGeneration(generation, 'building dataset metadata');
    return {
      title,
      cellucid: this._cellucid,
      stats: {
        n_cells: this._nObs,
        n_genes: this.hasExpressionMatrix ? this._nVars : 0,
        n_obs_fields: this._obsKeys.length,
        n_categorical_fields: nCategorical,
        n_continuous_fields: nContinuous,
        has_connectivity: hasConnectivity,
      },
      probes,
      obs_fields: this._obsKeys.map(key => ({ key, kind: 'unknown' })),
    };
  }

  _ensureOpen() {
    if (this._closed || !this._root) throw new Error('No AnnData file is open. Call open() first.');
  }

  _assertGeneration(generation, operation = 'loading AnnData data') {
    if (this._closed || generation !== this._generation) {
      throw new Error(
        `${this._format?.file ?? 'AnnData'} dataset changed, cache was cleared, or file was closed while ${operation}; the request was superseded`
      );
    }
  }

  /** Drop every cached field, name list and matrix index. */
  clearCache() {
    this._generation++;
    this._cache.clear();
    this._decodedChunks?.clear();
    // Row access is released even when releasing a matrix fails.
    try {
      this._releaseMatrices();
    } finally {
      this._releaseRows();
    }
  }

  /**
   * Let go of the store without closing it: a reader of another cell subset
   * of the same bytes reads through it from now on (the reader worker's
   * `open`), with its structure, chunk indexes and caches. Closing this
   * reader afterwards releases its own state only.
   */
  releaseStore() {
    this._store = null;
  }

  _releaseCurrentState() {
    let failure = null;
    const record = error => {
      const exact = error instanceof Error ? error : new TypeError('AnnData resource release must reject with an Error.', { cause: error });
      failure = failure === null ? exact : combineDatasetLifecycleFailures(failure, exact, 'Multiple AnnData resources failed to release.');
    };
    if (this._store) {
      // A store whose close failed stays owned, so a later close retries it.
      try {
        this._store.close?.();
        this._store = null;
      } catch (error) {
        record(error);
      }
    }
    this._root = null;
    this._fullRoot = null;
    this._cellSubset = null;
    this._prefixReads = new Map();
    try {
      this.clearCache();
    } catch (error) {
      record(error);
    }
    this._nObs = 0;
    this._nVars = 0;
    this._obsKeys = [];
    if (failure !== null) throw failure;
  }

  /** Close the store and release everything held. */
  close() {
    if (this._closed && !this._root && !this._store) return;
    this._openRequestId++;
    this._closed = true;
    // Its hold on the store's decoded chunks goes: they go once no opening
    // holds them (one that carried this one holds them still: `open`, `carry`).
    this._decodedChunks?.release();
    this._decodedChunks = null;
    this._releaseCurrentState();
  }
}

