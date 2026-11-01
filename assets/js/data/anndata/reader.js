/**
 * The AnnData reader: one class that reads an AnnData dataset from an array
 * store (`formats/store.js`), whether the store is an `.h5ad` (HDF5) or an
 * AnnData Zarr store. It runs in the AnnData reader worker
 * (`anndata-reader-worker.js`); the main thread talks to it through
 * `AnnDataReaderClient` and never blocks on a file.
 *
 * Opening checks the dataset's structure from its metadata alone (a store's
 * tree is read as it is navigated into, `formats/store.js` `Group.load`, so
 * opening loads only the groups it checks), reading only the obs and var
 * indexes it needs.
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

import { connectivityEdgesFromLines } from '../connectivity-edges.js';
import { EmbeddingPayloads } from '../embedding-payload.js';
import { codeBooleanColumn, codeDiscoveredColumn } from '../discovered-categories.js';
import { DecodedChunks } from './decoded-chunks.js';
import {
  requireObsmColumnSelection,
  requireObspKey,
} from '../data-mapping-candidates.js';
import { defaultExpression, defaultGraph, expressionRuleInputs } from '../data-mapping.js';
import { decodeAnnDataBooleanFlags, isAnnDataMatrixDataKind, isAnnDataNumericValueKind } from '../anndata-value-kinds.js';
import {
  combineDatasetLifecycleFailures,
} from '../dataset-lifecycle-errors.js';
import { allocateTypedArray, copyTypedArray, sparseColumnOf, sparseColumnOfDense } from '../sparse-column-index.js';
import { yieldToMacrotask } from '../../utils/yield-macrotask.js';
import { setOwnDataProperty } from '../../utils/exact-record.js';
import { createWorkerColumnStoreFactory } from '../column-store-placement.js';
import { onAbort, abortReason, awaitWithSignal, cancelled, SharedWork, sharedOnce } from '../../utils/abort.js';
import { residencyBudgetBytes, setWorkingSet, typedArrayBytes } from '../memory-budget.js';
import { isArrayNode, isGroup } from '../../formats/store.js';
import {
  ANNDATA_OPENING_PATHS,
  NULLABLE_ENCODINGS,
  attributeValue,
  child,
  elementBytes,
  encodingType,
  requireCategoricalOrdered,
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
  columnDefect,
  loadFrameStructure,
  probeColumns,
  readBooleanColumn,
  readCategories,
  readCategoriesAt,
  readCodes,
  readDataFrameIndex,
  readGeneNameColumn,
  readNullableValues,
  resolveCategoricalColumn,
  validateColumnEncoding,
  validateCodes,
} from './dataframe.js';
import { sparseContract } from './sparse.js';
import { denseGraphLines, gatheredGraph, heldGraphLines, inducedGraphLines, placedGraphLines, readGraphRows, readInducedGraph, readPlacedGraphRows, sparseGraphLines } from './graph-lines.js';
import { cellSubsetRunCosts, columnIndexResidentBytes, geneLayoutOf, geneReadCost, openMatrixColumns, openMatrixRows, readCellSubset, readInWholeChunks, readsThroughRowIndex } from './matrix-access.js';
import { SLAB_BYTES, asNumbers, readContinuous, readIntegers, readRowSlabs, readRowsInStoreOrder, readStored, scatterRows } from './values.js';
import { currentLayoutView, isOlderAnnDataLayout } from './older-layouts.js';
import { cellMapOf } from './views/modalities.js';
import { noEmbeddingRefusal } from './views/refusal.js';
import { cellSubsetView, CellRows, estimatedChunkShare, gatheredArray, keptValueStats, runsOfPositions } from './views/cell-subset.js';
import { cellReadLayout, defaultExpressionPath, firstGeneReadCost, geneReadMs, heldPrefix, linkPriced, linkReadMs, noteGeneSampleSeen, openOrderSpecOf, prefixRowsOf, resolveCellSubset, wholeSampleCost } from './subsample-plan.js';
import { firstViewCost, planProgressiveOpening } from './progressive-open.js';
import { createSubsampleCache } from '../subsample.js';
import { orderByKey, sortByKeyWithValues, sortUint32 } from '../../utils/radix-order.js';
import {
  carriedSegments,
  entriesPerRow,
  fileOrderedAccess,
  firstSegmentRows,
  PassRates,
  restrictedAccess,
  growthSegmentBounds,
  readRowPointers,
  rowRangeMatrix,
  rowsInterleaved,
  segmentBounds,
  segmentedColumns,
  sharedBudgetFactory,
  wholeGeneIndexActivity,
  wholeIsCheaper,
} from './prefix-column-index.js';
import { PRIORITY_ORIGINAL_COLUMN, readPrefixCounts, requirePrefixRows } from './priority-layout.js';
import { findKeptRuns, keepRun, keptIndexGroup, keptIndexPrefix, orderKey } from './kept-column-index.js';
import { pricingLink } from '../host-link-memory.js';
import { formatCount, formatCountOf } from '../../utils/format-units.js';
import { geneLayoutReason } from '../gene-read-plan.js';

const OBS_KINDS = ['string', 'float', 'int', 'uint', 'bool'];

/**
 * Readers made in this thread, naming each one's working-set part of an open
 * subsample's rows (`CellRows`: the kept rows, their runs and inverse;
 * `memory-budget.js`): a reader closed after the next one opened clears its
 * own part only.
 */
let readersMade = 0;

/**
 * Obs columns whose categories are found among the open cells, coded as
 * they are read (`codeDiscoveredColumn`): text, true/false, and integer
 * labels a layout view marks (`labels`).
 */
const DISCOVERED_DTYPES = new Set(['string', 'bool', 'labels']);

/**
 * One past the highest store row of the first `count` cells of an opening
 * (`fileRows` in open order; null: cell `i` is row `i`): the prefix of
 * store rows that holds them.
 *
 * @param {ArrayLike<number>|null} fileRows
 * @param {number} count
 * @returns {number}
 */
function prefixEndRow(fileRows, count) {
  if (fileRows === null) return count;
  let highest = -1;
  for (let i = 0; i < count; i++) if (fileRows[i] > highest) highest = fileRows[i];
  return highest + 1;
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
 * The distinct cells of a cell subset (an analysis's groups: up to every
 * open cell) as one `Uint32Array`, checked without a JavaScript array or set
 * of them (a set of ten million positions held hundreds of megabytes of the
 * reader's heap, on every read of a run's genes): ascending cells in one
 * pass, any other order against a byte a cell.
 *
 * @param {ArrayLike<number>} values
 * @param {number} extent - Cells of the dataset
 * @param {string} label - The matrix, for errors
 * @returns {Uint32Array}
 */
function requireDistinctCells(values, extent, label) {
  if (!Array.isArray(values) && !ArrayBuffer.isView(values)) {
    throw new TypeError(`${label} cell row positions must be an array`);
  }
  const cells = allocateTypedArray(Uint32Array, values.length, `${label} cell subset`);
  let ascending = true;
  let previous = -1;
  for (let k = 0; k < values.length; k++) {
    const position = Number(values[k]);
    if (!Number.isSafeInteger(position) || position < 0 || position >= extent) {
      throw new RangeError(`${label} cell row ${String(values[k])} is outside [0, ${extent})`);
    }
    if (position <= previous) ascending = false;
    previous = position;
    cells[k] = position;
  }
  if (!ascending) {
    const seen = allocateTypedArray(Uint8Array, extent, `${label} cell subset`);
    for (let k = 0; k < cells.length; k++) {
      if (seen[cells[k]] === 1) throw new RangeError(`A cell subset of ${label} names a cell more than once`);
      seen[cells[k]] = 1;
    }
  }
  return cells;
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
  const rowOf = allocateTypedArray(Uint32Array, measured, 'Measured rows');
  const cellOf = allocateTypedArray(Uint32Array, measured, 'Measured cells');
  let at = 0;
  for (let cell = 0; cell < rows.length; cell++) {
    if (rows[cell] < 0) continue;
    rowOf[at] = rows[cell];
    cellOf[at++] = cell;
  }
  // The cells by their rows, in a radix order: each row's cell is where the
  // order puts it, no search a cell (a 50 % uniform share of 10M cells,
  // its rows sorted and each cell then searched among 2.5M runs, took 1.6 s
  // of a CSC gene's 1.8 s).
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
/** Whether two lists of cell positions are the same cells in the same order. */
function sameCells(a, b) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Genes `genes` (positions in the matrix) of a cell subset holding every gene in order. */
function genesOfCellSubset(block, genes) {
  let total = 0;
  for (const gene of genes) total += block.pointers[gene + 1] - block.pointers[gene];
  const pointers = allocateTypedArray(Float64Array, genes.length + 1, 'Cell subset genes');
  const cellIndex = allocateTypedArray(Int32Array, total, 'Cell subset genes');
  const values = allocateTypedArray(Float32Array, total, 'Cell subset genes');
  let at = 0;
  genes.forEach((gene, g) => {
    const from = block.pointers[gene];
    const to = block.pointers[gene + 1];
    cellIndex.set(block.cellIndex.subarray(from, to), at);
    values.set(block.values.subarray(from, to), at);
    at += to - from;
    pointers[g + 1] = at;
  });
  return { pointers, cellIndex, values };
}

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
  // A gene's entries met with the cells by galloping (`rows` ascend, so do
  // its entries): O(entries x log(cells / entries)) a gene, not one step a
  // cell. Walking every cell for every gene made a DE of two groups of a
  // 13M-cell gene sample (50M-cell file) take 5.8 ms a gene, 174 s for
  // 30,000 genes, whatever the genes held.
  const each = (column, visit) => {
    const { indices } = column;
    let j = 0;
    for (let e = 0; e < indices.length && j < n; e++) {
      const row = indices[e];
      if (rows[j] < row) {
        let low = j + 1;
        let step = 1;
        let high = Math.min(n, low + step);
        while (high < n && rows[high] < row) {
          low = high + 1;
          step *= 2;
          high = Math.min(n, low + step);
        }
        // rows[low - 1] < row, and rows[high] >= row (or high = n).
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (rows[middle] < row) low = middle + 1;
          else high = middle;
        }
        j = low;
      }
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
 * The expression matrix a file names for genes in its launch defaults
 * (`uns['cellucid']['defaults']['expression']`: `X`, `raw/X` or
 * `layers/<name>`), or null when it names none. One small read; the
 * adapter checks the value against the file when it applies the defaults.
 */
async function launchExpressionOf(root, readOptions) {
  const node = child(child(child(child(root, 'uns'), 'cellucid'), 'defaults'), 'expression');
  if (node === null) return null;
  const value = await readUnsTree(node, "uns['cellucid']['defaults']['expression']", readOptions);
  return typeof value === 'string' ? value : null;
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
    // A member named `__proto__` is a key like any other, never the object's prototype.
    keys.forEach((key, index) => { setOwnDataProperty(object, key, values[index]); });
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
 * `sc.pl.*` writes them; a MuData modality's column `<modality>:<column>`
 * its modality's `uns['<column>_colors']`), as the stored text; null when the
 * file has none.
 * Which entries are colours, and whether there are enough of them, is the
 * page's to judge (`scanpyCategoryPalette`). A palette that cannot be read
 * is no palette: the field is still shown, in Cellucid's colours.
 *
 * `at` reads the colours of some categories only: those at the stored
 * positions `at.positions` (ascending) of a dictionary of `at.count`, read
 * through `at.gather` (`views/cell-subset.js` `gatheredArray`); a palette
 * shorter than the dictionary is none.
 *
 * @param {Object} root
 * @param {string} key
 * @param {{signal?: AbortSignal|null}} readOptions
 * @param {{count: number, positions: Uint32Array, gather: Function}|null} [at]
 * @returns {Promise<string[]|null>}
 */
async function readObsFieldColors(root, key, readOptions, at = null) {
  // A modality's column pulled to the cells (`<modality>:<column>`,
  // `views/mudata.js`) keeps its colours in that modality's own `uns`, where
  // Scanpy run on the modality writes them.
  const colon = key.indexOf(':');
  const modality = colon > 0 ? child(child(root, 'mod'), key.slice(0, colon)) : null;
  const node = modality !== null
    ? child(child(modality, 'uns'), `${key.slice(colon + 1)}_colors`) ?? child(child(root, 'uns'), `${key}_colors`)
    : child(child(root, 'uns'), `${key}_colors`);
  if (node?.kind !== 'array' || valueKind(node) !== 'string' || node.shape.length !== 1) return null;
  if (at !== null && node.shape[0] < at.count) return null;
  try {
    const values = at === null
      ? await node.read(undefined, readOptions)
      : await readStored(at.gather(node, at.positions), 0, at.positions.length, `uns['${key}_colors']`, readOptions);
    return Array.from(values, value => String(value));
  } catch (error) {
    if (readOptions.signal?.aborted) throw error;
    console.warn(`[AnnDataReader] uns['${key}_colors'] could not be read; '${key}' is shown in Cellucid's colours (${error?.message ?? error})`);
    return null;
  }
}

/**
 * Whether stored positions `positions` (ascending) lie in every chunk of a
 * chunked array: a read of them then fetches every chunk the whole array
 * has (and, for HDF5 strings, nearly every heap collection: a share of the
 * cells of a dictionary in label order names a few labels of each), so it
 * is read as the whole array is -- one plan, no more bytes or requests --
 * and the positions picked (`pickedArray`).
 */
function touchesEveryChunk(array, positions) {
  const rows = Array.isArray(array?.chunks) && array.chunks.length > 0 ? array.chunks[0] : null;
  if (rows === null || !(rows > 0)) return false;
  const total = Math.ceil(array.shape[0] / rows);
  if (positions.length < total) return false;
  let touched = 0;
  let last = -1;
  for (let i = 0; i < positions.length; i++) {
    const chunk = Math.floor(positions[i] / rows);
    if (chunk !== last) {
      touched++;
      last = chunk;
    }
  }
  return touched === total;
}

/**
 * How many chunks along its rows a dictionary is decoded in (a nullable
 * one's values'), or null when it is read by its bytes (stored in one piece,
 * or unfiltered chunks): a share of its rows then reads only theirs.
 */
function chunkCount(categories) {
  const node = isGroup(categories) ? child(categories, 'values') : categories;
  const rows = Array.isArray(node?.chunks) && node.chunks.length > 0 && node.partialChunks !== true ? node.chunks[0] : null;
  return rows === null || !(rows > 0) ? null : Math.ceil(node.shape[0] / rows);
}

/** An array read whole, its values at `positions` handed out (`touchesEveryChunk`). */
function pickedArray(array, positions) {
  return {
    shape: [positions.length],
    dtype: array.dtype,
    async read(selection, options) {
      const [[start, end]] = selection;
      const all = await array.read([[0, array.shape[0]]], options);
      const out = ArrayBuffer.isView(all) ? allocateTypedArray(all.constructor, end - start, 'Picked values') : new Array(end - start);
      for (let i = start; i < end; i++) out[i - start] = all[positions[i]];
      return out;
    },
  };
}

/**
 * The fewest bytes one category of a dictionary is stored in: an HDF5
 * variable-length string's reference and its global heap object's header
 * (the label's own bytes come on top), a Zarr variable-length item's length
 * prefix and one byte, a fixed-size element's size. A nullable dictionary
 * (a group) counts its values array's.
 */
function leastCategoryBytes(categories) {
  const node = isGroup(categories) ? child(categories, 'values') : categories;
  if (node?.dtype?.variable !== true) return elementBytes(node);
  return node.hdf5 !== undefined ? (node.info?.type?.size ?? 16) + 16 : 5;
}

/**
 * The stored categories `codes` name (each -1, missing, or a stored
 * position) that `known` (ascending stored positions) lacks, ascending.
 *
 * @param {Int32Array} codes
 * @param {Uint32Array} known
 * @returns {Uint32Array}
 */
function codesMissingFrom(codes, known) {
  const sorted = allocateTypedArray(Int32Array, codes.length, 'Categorical codes');
  sorted.set(codes);
  sorted.sort();
  let count = 0;
  let previous = -1;
  let k = 0;
  for (let i = 0; i < sorted.length; i++) {
    const code = sorted[i];
    if (code < 0 || code === previous) continue;
    previous = code;
    while (k < known.length && known[k] < code) k++;
    if (k < known.length && known[k] === code) continue;
    sorted[count++] = code;
  }
  return Uint32Array.from(sorted.subarray(0, count));
}

/**
 * A present-categories coding (`_categoryCoding`) with the stored categories
 * `added` (ascending, with their `labels` and `colors`) put in stored order
 * among its own; any it holds already (found by a read that ended first)
 * kept as it was. Colours stay only while every category found has one.
 */
function mergedCoding(coding, added, labels, colors, key) {
  const { stored } = coding;
  const total = stored.length + added.length;
  const mergedStored = allocateTypedArray(Uint32Array, total, `obs['${key}'] categories`);
  const mergedLabels = new Array(total);
  const keepColors = coding.colors !== null || stored.length === 0;
  const mergedColors = keepColors && colors !== null ? new Array(total) : null;
  let i = 0;
  let j = 0;
  let n = 0;
  while (i < stored.length || j < added.length) {
    if (j >= added.length || (i < stored.length && stored[i] <= added[j])) {
      if (j < added.length && stored[i] === added[j]) j++;
      mergedStored[n] = stored[i];
      mergedLabels[n] = coding.labels[i];
      if (mergedColors !== null) mergedColors[n] = coding.colors[i];
      i++;
    } else {
      mergedStored[n] = added[j];
      mergedLabels[n] = labels[j];
      if (mergedColors !== null) mergedColors[n] = colors[j];
      j++;
    }
    n++;
  }
  return {
    present: true,
    count: coding.count,
    stored: mergedStored.slice(0, n),
    labels: Object.freeze(mergedLabels.slice(0, n)),
    colors: mergedColors === null ? null : Object.freeze(mergedColors.slice(0, n)),
  };
}

/** Each stored code's position among `stored` (ascending), -1 missing: a code `stored` lacks is a reader defect. */
function positionsAmong(codes, stored, key) {
  const positions = allocateTypedArray(Int32Array, codes.length, `obs['${key}'] codes`);
  let lastCode = -1;
  let lastPosition = -1;
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code < 0) {
      positions[i] = -1;
      continue;
    }
    if (code !== lastCode) {
      let low = 0;
      let high = stored.length - 1;
      lastPosition = -1;
      while (low <= high) {
        const middle = (low + high) >>> 1;
        if (stored[middle] < code) low = middle + 1;
        else if (stored[middle] > code) high = middle - 1;
        else {
          lastPosition = middle;
          break;
        }
      }
      if (lastPosition < 0) throw new Error(`Categorical code ${code} for '${key}' names a category that was not read`);
      lastCode = code;
    }
    positions[i] = lastPosition;
  }
  return positions;
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
 * metadata and `uns` alone: its cell and gene counts (from the shape of the
 * expression matrix it opens with, `defaultExpression`, else the dataframe
 * indexes' shapes), `uns['title']` and `uns['cellucid']` as stored. No index, matrix or column is read, so
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
  const root = isOlderAnnDataLayout(store) ? await currentLayoutView(store, readOptions) : store;
  // What opening reads, and all of uns/cellucid (`readUnsCellucid`).
  await root.load(ANNDATA_OPENING_PATHS, readOptions);
  requireExactStringAttribute(root, 'encoding-type', 'anndata', `${format.file} root`);
  if (!root.has('obs') || !root.has('var')) {
    throw new Error(`${format.file} obs and var are required and must be current AnnData dataframes`);
  }
  await Promise.all([child(root, 'obs'), child(root, 'var')].map(frame => loadFrameStructure(frame, readOptions)));
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
    // The genes the dataset opens with: raw's, when the default expression
    // rule reads raw (`defaultExpression`: more genes than X, or X scaled).
    const rawX = child(child(root, 'raw'), 'X');
    if (rawX !== null) {
      const rawShape = isGroup(rawX) ? sparseContract(rawX, format, 'Sparse raw.X').shape : shapeOf(rawX, 'Dense raw.X', 2);
      const inputs = await expressionRuleInputs({ X: storedMatrix(X, [nObs, nVars]), rawX: { shape: rawShape }, read: region => X.read(region) });
      if (defaultExpression({ ...inputs, layers: [] }).expression === 'raw') nVars = rawShape[1];
    }
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
 * What a person reads while a matrix is indexed by gene (CSR, dense in row
 * chunks, or dense in strips too wide to keep decoded: `geneLayoutOf`): why
 * one gene costs the whole matrix, and, when no index of it can be kept
 * (`rescan`: why), that every gene scans it again and what makes the index
 * fit.
 *
 * @param {string} label - `X`, `layers['counts']`, `raw.X`
 * @param {string|null} rescan
 * @param {string} layout - `geneLayoutOf`
 * @returns {string}
 */
export function geneIndexActivityLabel(label, rescan, layout) {
  const reason = geneLayoutReason(layout) ?? 'stored cell by cell, so one gene reads every cell\'s entries';
  if (rescan === null) {
    return `${label} by gene (${reason}: one gene reads every open cell's part once; ` +
      'genes after it read the index this builds)';
  }
  return `${label} again for the genes asked for (${rescan}; ${reason}, so each gene reads every open cell's part; ` +
    'opening a subsample of the cells makes the index fit)';
}

/**
 * A matrix as the default expression rule reads it (`expressionRuleInputs`):
 * dense or not, float or not, its shape and chunks (null: stored in one
 * piece).
 *
 * @param {Object} node
 * @param {ReadonlyArray<number>} shape
 */
function storedMatrix(node, shape) {
  const dense = node?.kind === 'array';
  return {
    dense,
    floating: dense && node.dtype?.kind === 'float',
    shape,
    chunks: dense && Array.isArray(node.chunks) ? node.chunks : null,
  };
}

/**
 * Regions of one dense array read once each, however many rules ask for
 * them (`expressionRuleInputs` and `storedValueFacts` read the same first chunk).
 *
 * @param {Object} node
 * @returns {(region: [[number, number], [number, number]]) => Promise<ArrayLike<number>>}
 */
function regionReader(node) {
  const read = new Map();
  return region => {
    const key = JSON.stringify(region);
    if (!read.has(key)) read.set(key, node.read(region));
    return read.get(key);
  };
}

/**
 * The largest finite value of each float dtype a matrix is stored in: the
 * values a `log1p` was applied to were held in the same type (`sc.pp.log1p`
 * keeps the dtype), so once the log1p is undone no cell's total can exceed it.
 */
const FLOAT_DTYPE_MAX = Object.freeze({ float16: 65504, float32: 3.4028234663852886e38, float64: Number.MAX_VALUE });

/**
 * What a matrix's first stored values tell -- a dense matrix's first chunk
 * (stored in one piece: its first row), a sparse one's first chunk of stored
 * values; one small read, shared with the default expression rule:
 *
 * - `counts`: whether it holds counts, an integer dtype or float values all
 *   whole and non-negative (raw counts written as float32, as CELLxGENE and
 *   10x conversions write them); data mapping and the analyses say so (a
 *   fold change on counts is not normalised by each cell's depth);
 * - `notLog1p` (only with `log1pBase`, the base the file's `uns['log1p']`
 *   records, null for e): whether the values refute that record. Undo the
 *   log1p of each value (`expm1` in that base) and sum each cell's: that is
 *   the cell's total before the transform, at least (a dense chunk holds part
 *   of each row; a sparse matrix's first values are taken one by one, their
 *   rows unread). A total past the largest finite value of the matrix's own
 *   float type (`FLOAT_DTYPE_MAX`) is no total any data held, so the values
 *   are not log1p, whatever the record says: EBI SCEA's E-ANND-5 stores
 *   per-million values (252 to 1,118) under an empty `uns['log1p']`, and
 *   `expm1(252)` is 1e109 where float32 ends at 3.4e38. Null when they do
 *   not refute it, else `{value, dtype, total}`: the largest value read,
 *   the type, and the total it implies (null past float64).
 *
 * Null for a matrix holding no number or no value; `notLog1p` null without
 * a record.
 *
 * @param {Object} node - A dense array, or a `csr_matrix` / `csc_matrix` group
 * @param {{read?: (region: [[number, number], [number, number]]) => Promise<ArrayLike<number>>, stored?: Object, log1pBase?: number|null|undefined}} [options] -
 *   `read`: a dense matrix's region read (`regionReader`: the one read the
 *   default expression rule shares); `stored`: the same matrix as the store
 *   holds it, before a subsample's view (a sparse matrix's stored values are
 *   read there: a view reads a CSR matrix's values only by its kept rows);
 *   `log1pBase`: undefined when the file records no log1p
 * @returns {Promise<{counts: boolean, notLog1p: {value: number, dtype: string, total: number|null}|null}|null>}
 */
async function storedValueFacts(node, { read = region => node.read(region), stored = node, log1pBase = undefined } = {}) {
  const values = isGroup(node) ? child(stored, 'data') : node;
  if (values?.kind !== 'array') return null;
  const kind = values.dtype?.kind;
  // An integer dtype holds counts, which a log1p never writes (`defaultLog1p` reads it as stored).
  if (kind === 'int' || kind === 'uint') return { counts: true, notLog1p: null };
  if (kind !== 'float' || !Array.isArray(values.shape) || !values.shape.every(extent => extent > 0)) return null;
  let sample;
  let rowLength;
  if (values.shape.length === 1) {
    // A sparse matrix's stored values: their first chunk, or, stored in one
    // piece or in chunks read in part (`partialChunks`: raw, as a served
    // store's are), as many as one full row of the matrix holds. Their rows
    // are not read: each value stands alone.
    const length = values.shape[0];
    const nColumns = attributeValue(node, 'shape')?.[1] ?? length;
    const first = Array.isArray(values.chunks) && values.partialChunks !== true ? values.chunks[0] : Math.max(1, Number(nColumns));
    sample = await readStored(values, 0, Math.min(length, first), 'Matrix values');
    rowLength = 1;
  } else {
    const [nRows, nColumns] = values.shape;
    const [rows, columns] = Array.isArray(values.chunks) ? values.chunks : [1, nColumns];
    sample = await read([[0, Math.min(nRows, rows)], [0, Math.min(nColumns, columns)]]);
    rowLength = Math.min(nColumns, columns);
  }
  let counts = true;
  for (let i = 0; i < sample.length; i++) {
    const value = sample[i];
    if (!(value >= 0) || value !== Math.floor(value)) {
      counts = false;
      break;
    }
  }
  let notLog1p = null;
  const ceiling = FLOAT_DTYPE_MAX[numpyDtypeName(values)];
  if (log1pBase !== undefined && ceiling !== undefined) {
    const scale = log1pBase === null ? 1 : Math.log(log1pBase);
    let largest = -Infinity;
    let refuting = -Infinity;
    for (let start = 0; start < sample.length; start += rowLength) {
      let total = 0;
      let rowLargest = -Infinity;
      for (let i = start; i < Math.min(sample.length, start + rowLength); i++) {
        const value = sample[i];
        if (!(value > 0)) continue;
        total += Math.expm1(value * scale);
        if (value > rowLargest) rowLargest = value;
      }
      if (rowLargest > largest) largest = rowLargest;
      if (total > ceiling && total > refuting) refuting = total;
    }
    if (refuting > ceiling) {
      notLog1p = { value: largest, dtype: numpyDtypeName(values), total: Number.isFinite(refuting) ? refuting : null };
    }
  }
  return { counts, notLog1p };
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
    /** Every gene of the cells a run reads by their rows, kept for its later reads (`_keptCellSubset`). */
    this._cellSubsetGenes = null;
    /** What reading a run's cells by their rows costs, priced once (`_rowsCostOf`). */
    this._cellSubsetRowsCost = null;
    /** A run's cells checked once, for its later reads (`_checkedCells`). */
    this._cellSubsetChecked = null;
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
    /** What opening left out, and why (`notes`). @type {readonly string[]} */
    this._notes = Object.freeze([]);
    /**
     * The var index as stored: names, possibly repeated. The adapter makes
     * them unique with the data-mapping rule (`makeUniqueNames`).
     * @type {string[]}
     */
    /** @type {Map<string, Object>} Field types, categories, names */
    this._cache = new Map();
    /**
     * How each categorical obs field read so far is coded (`_categoryCoding`),
     * by key: `{present: false}`, its stored dictionary; or `{present: true,
     * count, stored, labels, colors}`, the categories its open cells hold.
     * Kept by a clear of the cache (the page holds codes under it) and
     * carried to an opening grown or cut in place (`_takeCarried`): a column
     * is coded one way for the life of what the page shows.
     * @type {Map<string, Object>}
     */
    this._categoryCodings = new Map();
    /**
     * The expression matrices whose columns are read, and how each one's
     * columns are reached, least recently read first. The matrix read now
     * is the last; a built gene index of an earlier one is kept while every
     * kept index fits the `columnIndex` memory budget, so switching back to
     * it reads nothing again (`_settleMatrices`).
     * @type {Map<string, {element: string, columns: Object|null, load: import('../../utils/abort.js').SharedWork|null}>}
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
    /** This reader's working-set part of its open subsample's rows. @private */
    this._cellRowsPart = `cell rows ${++readersMade}`;
    this._fullRoot = null;
    /**
     * The expression matrix genes are read from by default, as a path below
     * the store root (`subsample-plan.js` `defaultExpressionPath`): what the
     * opening priced a gene by, and whose kept values it reports.
     * @type {string|null}
     */
    this._expression = null;
    /**
     * The prefix counts an opening of a priority-ordered file's first rows
     * reads as it opens (`startPrefixReads`), by matrix path.
     * @type {Map<string, Promise<{counts: Float64Array, levelRows: number}|null>>}
     */
    this._prefixReads = new Map();
    /**
     * The row pointers of the store's CSR matrices, by path, read whole:
     * they do not depend on the cells open, so another opening of the same
     * store takes them over (`open`'s `carry`). Counted with the gene
     * indexes they are read to build (`columnIndex`, `residentBytes`), let go
     * with them and read again when asked for.
     * @type {Map<string, Float64Array>}
     */
    this._indptrs = new Map();
    /** Kept rows' pointers an earlier subsample of the same store read (`cellSubsetView`). */
    this._knownRowPointers = new Map();
    /**
     * The first stored row pointers of CSR matrices whose open rows are the
     * file's (`_storedRowPointers`: a gene sample's), by path, until the
     * whole `indptr` is read (`_indptrs`).
     * @type {Map<string, Float64Array>}
     */
    this._indptrPrefixes = new Map();
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
    /** What the opening's host delivered on earlier visits (`host-link-memory.js`), or null. */
    this._hostLink = null;
    /** Store rows holding their matrix rows when not every one does (`open`'s `held`). */
    this._held = null;
    /**
     * With `held`, a progressive opening's (`growth`): the store rows the
     * first `held.fitCells` cells it grows to lie in, which the one pass
     * over its matrix keeps (`shareRows`); null otherwise.
     * @type {number|null}
     */
    this._grownShareRows = null;
    /**
     * The subsamples this opening resolves, ranked once (`subsample.js`
     * `createSubsampleCache`): carried to each opening of the same bytes (a
     * progressive opening's steps, Apply), so each size of one subsample
     * ranks no cell again; let go on close.
     * @type {import('../subsample.js').SubsampleCache|null}
     */
    this._subsampleCache = null;
    /**
     * The kept runs of each matrix's index found for this opening and not
     * yet taken by its index (`_keptRunsOf`), by matrix element.
     * @type {Map<string, Promise<import('./kept-column-index.js').KeptRun[]>>}
     */
    this._keptRuns = new Map();
    /**
     * Open rows of a matrix in store order (`_storeOrderMatrix`), made for
     * the check of a run kept in store order and not yet taken by the
     * segment that uses them, by matrix element and rows.
     * @type {Map<string, Promise<{order: Uint32Array, matrix: Object, pointers: Float64Array}>>}
     */
    this._storeOrdered = new Map();
    /** @type {Set<Promise<void>>} Runs of built indexes being kept (`_keepRun`). */
    this._keeping = new Set();
    /**
     * Whether each matrix indexed in segments reads its genes through every
     * stored row's index restricted to the open rows (`_restrictsWhole`),
     * decided once per opening, by matrix element.
     * @type {Map<string, Promise<boolean>>}
     */
    this._restricted = new Map();
    /**
     * What the work of a gene index pass measured on this store costs
     * (`PassRates`): carried to every opening of the same store, it weighs a
     * share's pass against every stored row's (`_restrictsWhole`).
     */
    this._passRates = new PassRates();
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
    /** The running read of a matrix's open rows' pointers, by element (`_readyRows`). */
    this._pointerActivities = new Map();
    /**
     * Embedding and vector-field payloads made from `obsm` columns
     * (`embedding-payload.js`), forgotten whenever the caches are cleared.
     */
    this._payloads = new EmbeddingPayloads(
      (key, columns, options) => this.readObsmColumns(key, columns, options),
      {
        cellCount: () => this._nObs,
        cellNames: cells => this._cellNames(cells),
        generation: () => this._generation,
        // What the cell-order digest names each open cell by (`cell-identity.js` `originalAt`).
        originals: () => this._cellSubset?.openOrder ?? this._cellSubset?.kept ?? null,
      }
    );
  }

  /**
   * Load the elements at `paths` below the open root (`formats/store.js`,
   * `Group.load`): what a reading navigates beyond what opening loaded
   * (`ANNDATA_OPENING_PATHS`), each object read once however many readings
   * ask, under the reading's own signal and activity. @private
   */
  _ready(paths, readOptions = {}) {
    return this._root.load(paths, { signal: readOptions.signal ?? null, activity: readOptions.activity ?? null });
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
      const result = await awaitWithSignal(operation({ activity, signal }), signal);
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
      throw cancelled('superseded', `${this._format?.file ?? 'AnnData'} open request was superseded or closed.`);
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
   *   (`_takeCarried`) instead of read again; an opening grown or cut in
   *   place keeps its embeddings' frame (`EmbeddingPayloads.adoptTransforms`).
   *   Only the same store is carried (the same version of the same file:
   *   `anndata-reader-worker.js`): an opening of a store that could not be
   *   taken over is read anew, frame and all. `signal` stops the opening.
   *   `keptIndexes`: `{identity, about?, tab?, onStore?, environment?}`, what
   *   the store's bytes are (`openDatasetStore`'s `identity`): the gene
   *   indexes of its cell-major matrices are kept in this browser under it
   *   and found again by a later opening of the same cells
   *   (`kept-column-index.js`); `about`: what the file is for the Session
   *   panel's list of what is kept (`space.js` `keptAbout`);
   *   `onStore({directory, state})` hears each kept directory as it is
   *   written and completed (the page holds it for the tab's life).
   *   `held`: `{rows, fitCells, bytes}` when only rows `[0, rows)` of the
   *   store hold their matrix rows (a matrix read after its map,
   *   `transcode/matrix-market.js`): the gene sample never reaches past
   *   them (`subsample-plan.js` `geneSampleOf`), nor does a growth
   *   (`growGeneSample`); `fitCells` the share sized to this device and
   *   `bytes` the matrix's, for what the page says of it.
   *   `drawn`: the opening is to be drawn (the app's): a store whose `obsm`
   *   holds no array of cell coordinates is refused before its cells are
   *   resolved (`_requireEmbedding`).
   */
  async open(store, { format, name, decodedChunkBytes = residencyBudgetBytes('decodedBlocks'), decodedBudget = null, link = null, activity = null, cellSubset = null, carry = null, keptIndexes = null, hostLink = null, held = null, drawn = false, signal = null }) {
    if (!isGroup(store)) throw new TypeError('An AnnData reader opens a store root group.');
    const requestId = ++this._openRequestId;
    const candidate = new AnnDataReader();
    candidate._format = format;
    candidate._name = name;
    candidate._store = store;
    candidate._decodedChunkBytes = decodedChunkBytes;
    candidate._link = link;
    // What the host delivered on earlier visits: the link sizing prices at
    // until this one's own reads measure more (`host-link-memory.js`).
    candidate._hostLink = hostLink;
    candidate._held = held;
    candidate._keptIndexes = keptIndexes?.identity == null ? null : {
      identity: keptIndexes.identity,
      about: keptIndexes.about ?? null,
      // Kept for one tab only (an identity naming no version): the page's tab.
      tab: keptIndexes.tab ?? undefined,
      onStore: keptIndexes.onStore ?? null,
      environment: keptIndexes.environment ?? globalThis,
    };
    candidate.createActivity = this.createActivity;
    try {
      // A file written before anndata 0.8 is read through its current-layout
      // view; everything below reads one layout.
      candidate._root = isOlderAnnDataLayout(store) ? await currentLayoutView(store, { signal, activity }) : store;
      // The store's decoded chunks (`decoded-chunks.js`): an opening of the
      // same store (a growth's next step) reads its added rows out of them,
      // holding them beside the earlier opening (several may be live at
      // once: a reopen in flight while another commits), so they go only
      // once the last opening holding them closes.
      candidate._decodedChunks = carry?._decodedChunks?.retain() ?? new DecodedChunks(decodedBudget ?? decodedChunkBytes);
      // The subsamples the earlier opening of these bytes ranked: a growth's
      // next step takes its cells from them (`resolveCellSubset`).
      candidate._subsampleCache = carry?._subsampleCache ?? createSubsampleCache();
      // The cells the earlier openings of these bytes opened, each with its
      // cell order and the gene sample it read them for (the gene time's,
      // grown to fill it, or a person's): the same cells opened again -- a
      // share lowered and raised back -- read genes for that sample in that
      // order (`noteGeneSampleSeen`), not for one fitted again over the
      // link as measured this moment (which read every cell of a 50M-cell
      // store after a round trip, and its gene index past the memory).
      candidate._geneSamplesSeen = new Map(carry?._geneSamplesSeen ?? []);
      if (carry?._cellSubset != null) noteGeneSampleSeen(candidate._geneSamplesSeen, carry._cellSubset);
      // What its index passes measured (`PassRates`): the rates are the source's.
      if (carry !== null) candidate._passRates = carry._passRates;
      if (carry !== null) {
        for (const [path, pointers] of carry._indptrs) candidate._indptrs.set(path, pointers);
        for (const [path, pointers] of carry._indptrPrefixes) candidate._indptrPrefixes.set(path, pointers);
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
        // What opening reads of the store's tree (`ANNDATA_OPENING_PATHS`);
        // the rest loads when a reading needs it (`_ready`), never before.
        await candidate._ready(ANNDATA_OPENING_PATHS, options);
        // An opening to be drawn of a store with nothing to draw is refused
        // here, before its cells are resolved (pricing them reads the
        // matrix's structure).
        if (drawn) await candidate._requireEmbedding(options);
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
      const earlier = carry;
      const shared = earlier === null ? 0 : candidate._sharedRows(earlier);
      if (carry !== null) candidate._takeCarried(carry, shared);
      this._adopt(candidate);
      // An opening grown or cut in place -- its first cells are all of the
      // earlier one's, or its cells are all among the earlier one's first --
      // shows every embedding in the frame those cells were shown in, so
      // none of them moves (`EmbeddingPayloads.adoptTransforms`).
      // The same cells in another order (a subsample grown from few chunks
      // put in priority order, `progressive-open.js`) keep it likewise.
      const sameCells = earlier !== null && this._sameCells(earlier);
      if (earlier !== null && ((shared > 0 && shared === Math.min(earlier._nObs, this._nObs)) || sameCells)) {
        this._payloads.adoptTransforms(earlier._payloads);
      }
      // The cell-order sums of the rows both openings share are kept,
      // whatever the frame (`EmbeddingPayloads.adoptCellOrderSums`).
      if (earlier !== null) this._payloads.adoptCellOrderSums(earlier._payloads, { shared, sameCells });
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
    for (const key of ['_root', '_store', '_format', '_name', '_nObs', '_nVars', '_obsKeys', '_notes', '_cache', '_matrices', '_decodedChunkBytes', '_title', '_cellucid', '_link', '_pointerReads', '_modalities', '_defaultModality', '_cellSubset', '_expression', '_fullRoot', '_indptrs', '_indptrPrefixes', '_carried', '_graphShares', '_prefixReads', '_keptIndexes', '_keptRuns', '_decodedChunks', '_hostLink', '_held', '_grownShareRows', '_subsampleCache', '_geneSamplesSeen', '_cellRowsPart', '_categoryCodings', '_restricted', '_passRates']) {
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
    // Cells grown or cut in place (or the same cells in another order) stay
    // shown with the codes the page holds: each categorical keeps its coding
    // (`_categoryCoding`). Other cells are a new reading, coded anew.
    if ((shared > 0 && shared === Math.min(nPrevious, this._nObs)) || this._sameCells(previous)) {
      this._categoryCodings = new Map(previous._categoryCodings);
    }
    for (const [element, state] of [...previous._matrices]) {
      const columns = state.columns?.source ?? null;
      if (columns === null || element.startsWith('mod/')) continue;
      if (Array.isArray(columns.segments) && this._cellSubset?.ordered === true && previous._cellSubset?.ordered === true) {
        // Within the rows this opening reads genes for (its gene sample).
        const rows = Math.min(shared, this._cellSubset?.genes?.cells ?? shared);
        if (rows === 0) continue;
        previous._matrices.delete(element);
        this._carried.set(element, { segments: carriedSegments(columns, rows) });
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
    const { label, nRows, sourceVars, key: element } = resolved;
    // The rows a gene is read for: the gene sample's (`subsample-plan.js`,
    // `genes`), else every open row. Rows past them are not read, nor are
    // their row pointers: the segments are made of the rows read
    // (`_openRowsMatrix`), and of more of them as the sample grows.
    let readTo = this._geneRows(resolved);
    // The rows read as a matrix in open order, with their pointers: made
    // when a segment in open order needs it. Rows in store order never do
    // (a 50 % uniform share of 10M cells is 5M runs of one row in open order).
    let rowsRead = null;
    let openRead = null;
    const openRows = () => {
      openRead ??= this._openRowsMatrix(resolved, readTo, readOptions).then(read => (rowsRead = read));
      openRead.catch(() => { openRead = null; });
      return openRead;
    };
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
    const runs = await this._takeKeptRuns(resolved, () => openRows().then(read => read.pointers), readTo);
    let perRow = null;
    let first = null;
    // The open-order matrix and its first segment's rows, once a segment in open order is made.
    const inOpenOrder = async () => {
      await openRows();
      perRow ??= entriesPerRow(rowsRead.matrix, readTo);
      first ??= firstSegmentRows(readTo, perRow);
      return rowsRead;
    };
    // The segments in store order, by first row: what their passes read.
    const storeOrdered = new Map();
    // One activity for every unbuilt segment a gene waits for: the whole gene's bytes and time left.
    const layout = geneLayoutOf(resolved.node, { nObs: readTo, nVars: sourceVars, decodedChunkBytes: this._decodedChunkBytes });
    const valuesOnDemand = !this._readsAhead();
    const passBytes = async (matrix, rows) => {
      const cost = await geneReadCost(matrix, {
        format: this._format,
        label,
        nObs: rows,
        nVars: sourceVars,
        decodedChunkBytes: this._decodedChunkBytes,
        valuesOnDemand,
        retainIndicesBytes: residencyBudgetBytes('columnIndex'),
      });
      // What the pass fetches: none of what this browser keeps of the file.
      return (cost.scan?.fetchBytes ?? cost.scan?.storedBytes ?? 0) + (cost.index?.passes === 2 ? cost.index.secondPassStoredBytes ?? 0 : 0);
    };
    const onIndexStartAt = wholeGeneIndexActivity({
      nRows: () => readTo,
      create: () => this.createActivity?.({ kind: 'index', label: geneIndexActivityLabel(label, null, layout), background: true }) ?? null,
      createRescan: (_label, rescan) => this.createActivity?.({ kind: 'index', label: geneIndexActivityLabel(label, rescan, layout), background: false }) ?? null,
      bytesFrom: async row => {
        let bytes = 0;
        // A segment in store order is priced as it reads (its rows in open
        // order made a sort of every row's run: 3 s of a 50 % share's gene).
        const ordered = storeOrdered.get(row) ?? null;
        if (ordered !== null) {
          bytes += await passBytes(ordered.matrix, ordered.nObs ?? ordered.rows);
          row += ordered.rows;
        }
        if (row >= readTo) return bytes;
        const { matrix, pointers } = await inOpenOrder();
        return bytes + await passBytes(rowRangeMatrix(matrix, row, readTo, pointers), readTo - row);
      },
    });
    // A pass over the open rows' view (a subsample's: its rows gathered out
    // of the stored chunks) measures the view's work per entry too (`PassRates`).
    const noteViewPass = work => this._passRates.noteIndex(work, { overView: this._cellSubset?.fileRows != null });
    // Open rows `[segmentStart, end)` as a segment: from a kept run, or
    // built by a pass and kept as it is.
    const segmentOf = async (segmentStart, end, run) => {
      const { matrix, pointers } = rowsRead;
      const segment = rowRangeMatrix(matrix, segmentStart, end, pointers);
      const access = await openMatrixColumns(segment, {
        format: this._format,
        label,
        nObs: end - segmentStart,
        nVars: sourceVars,
        decodedChunkBytes: this._decodedChunkBytes,
        indexOptions: {
          ...this._indexOptions(),
          storeFactory,
          // Built by a pass (no run kept, or the kept run found damaged): kept.
          onBuilt: store => this._keepRun(resolved, segmentStart, end, store, { pointers }),
          onWork: noteViewPass,
          ...(run === null ? {} : { kept: run.kept }),
        },
        onIndexStart: onIndexStartAt(segmentStart, end - segmentStart),
        readOptions: { activity: readOptions.activity ?? null },
      });
      const residentBytes = columnIndexResidentBytes({
        layout: isGroup(matrix) ? 'sparse' : 'dense',
        nnz: pointers === null ? 0 : pointers[end] - pointers[segmentStart],
        nObs: end - segmentStart,
        nVars: sourceVars,
        valuesOnDemand: !this._readsAhead(),
        valuesBought: !this._readsAhead() && isGroup(matrix) && readInWholeChunks(matrix.storedData?.() ?? matrix.get('data')),
      });
      return { start: segmentStart, rows: end - segmentStart, access, residentBytes };
    };
    // Open rows `[segmentStart, end)` spread through the store (a uniform,
    // stratified or spatial share of a file in its own order:
    // `_inStoreOrder`), as one segment whose rows are in store order
    // (`fileOrderedAccess`): its pass reads and decodes each stored chunk
    // once, where segments in open order each read nearly every chunk (a
    // 10 % uniform share of a 10M-cell CSR file read 517 MB for a gene
    // against 266 MB for every cell). From a kept run of the same rows in
    // store order, or built by a pass and kept as it is.
    const orderedSegmentOf = async (segmentStart, end, run, options = readOptions) => {
      const { order, matrix, pointers } = await this._takeStoreOrderMatrix(resolved, segmentStart, end, options);
      storeOrdered.set(segmentStart, { matrix, rows: end - segmentStart });
      const access = await openMatrixColumns(matrix, {
        format: this._format,
        label,
        nObs: end - segmentStart,
        nVars: sourceVars,
        decodedChunkBytes: this._decodedChunkBytes,
        indexOptions: {
          ...this._indexOptions(),
          storeFactory,
          onBuilt: store => this._keepRun(resolved, segmentStart, end, store, { pointers, order }),
          onWork: noteViewPass,
          ...(run === null ? {} : { kept: run.kept }),
        },
        onIndexStart: onIndexStartAt(segmentStart, end - segmentStart),
        readOptions: { activity: readOptions.activity ?? null },
      });
      const residentBytes = columnIndexResidentBytes({
        layout: pointers === null ? 'dense' : 'sparse',
        nnz: pointers === null ? 0 : pointers[end - segmentStart],
        nObs: end - segmentStart,
        nVars: sourceVars,
        valuesOnDemand: !this._readsAhead(),
        valuesBought: !this._readsAhead() && pointers !== null && readInWholeChunks(matrix.storedData?.() ?? matrix.get('data')),
      });
      return { start: segmentStart, rows: end - segmentStart, access: fileOrderedAccess(access, order, this._passRates.placing('own')), residentBytes };
    };
    // Open rows `[segmentStart, end)` (the rest of every open row, spread
    // through the store) as a segment of the index every cell builds, of
    // every stored row, restricted to them (`restrictedAccess`): chosen when
    // that is less work than their pass in store order (`_restrictsWhole`).
    // Its pass is every cell's, over the stored matrix as stored (the same
    // reads, the same decoded chunks). From that index kept in this browser
    // by any opening of every cell (or a share that built it), else built by
    // a pass and kept under every cell's rows, so either takes it over later.
    const restrictedSegmentOf = async (segmentStart, end) => {
      const stored = child(this._fullRoot, resolved.key);
      const nFile = this._cellSubset.nObs;
      storeOrdered.set(segmentStart, { matrix: stored, nObs: nFile, rows: end - segmentStart });
      const kept = await this._wholeKeptRun(resolved);
      const access = await openMatrixColumns(stored, {
        format: this._format,
        label,
        nObs: nFile,
        nVars: sourceVars,
        decodedChunkBytes: this._decodedChunkBytes,
        indexOptions: {
          ...this._indexOptions(),
          storeFactory,
          ...(kept === null
            ? { onBuilt: store => this._keepRun(resolved, 0, nFile, store, { pointers: store._rowPointers ?? null, everyCell: true }) }
            : { kept: kept.kept }),
        },
        onIndexStart: onIndexStartAt(segmentStart, end - segmentStart),
        readOptions: { activity: readOptions.activity ?? null },
      });
      const residentBytes = columnIndexResidentBytes({
        layout: isGroup(stored) ? 'sparse' : 'dense',
        nnz: isGroup(stored) ? stored.get('indices').shape[0] : 0,
        nObs: nFile,
        nVars: sourceVars,
        valuesOnDemand: !this._readsAhead(),
        valuesBought: !this._readsAhead() && isGroup(stored) && readInWholeChunks(stored.get('data')),
      });
      const fileRows = this._cellSubset.fileRows.subarray(segmentStart, end);
      const rows = this._cellSubset.rows;
      // Every stored row open in another order (a share raised back to every
      // cell in its order): its genes placed by the open rows' runs (a run
      // a block), where there are fewer runs than a gene's entries.
      const runs = rows.kept.length === rows.nOriginal ? () => rows.runs() : null;
      return { start: segmentStart, rows: end - segmentStart, access: restrictedAccess(access, fileRows, () => rows.positions(), segmentStart, runs, this._passRates.placing('whole')), residentBytes };
    };
    try {
      while (start < readTo) {
        let run = runs.find(item => item.start === start) ?? null;
        // A run kept past the rows a gene is read for is not taken: genes
        // are read for exactly the sample's cells.
        if (run !== null && start + run.rows > readTo) {
          runs.splice(runs.indexOf(run), 1);
          run.kept.release();
          run = null;
        }
        if (run !== null && run.storeOrder) {
          const segment = await orderedSegmentOf(start, start + run.rows, run);
          runs.splice(runs.indexOf(run), 1);
          segments.push(segment);
          start += run.rows;
          continue;
        }
        const next = runs.find(item => item.start > start);
        // The rows left, spread through the store: one segment, of every
        // stored row's index restricted to them, or in store order.
        if (run === null && next === undefined && (await this._restrictsWhole(resolved, start) || this._inStoreOrder(resolved, start, readTo))) {
          segments.push(await (await this._restrictsWhole(resolved, start) ? restrictedSegmentOf(start, readTo) : orderedSegmentOf(start, readTo, null)));
          start = readTo;
          continue;
        }
        await inOpenOrder();
        let end = run === null ? segmentBounds(start, readTo, first)[0] : start + run.rows;
        if (run === null && next !== undefined) end = Math.min(end, next.start);
        // A segment whose genes are read as stored (a dense one in strips
        // the decoded-chunk budget holds) has no index: its run is let go.
        if (run !== null && !readsThroughRowIndex(rowRangeMatrix(rowsRead.matrix, start, end, rowsRead.pointers), { nObs: end - start, nVars: sourceVars, decodedChunkBytes: this._decodedChunkBytes })) {
          runs.splice(runs.indexOf(run), 1);
          run.kept.release();
          run = null;
        }
        const segment = await segmentOf(start, end, run);
        // Its index holds it now, and lets it go when it is disposed.
        if (run !== null) runs.splice(runs.indexOf(run), 1);
        segments.push(segment);
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
    const columns = segmentedColumns({ nRows, segments, together });
    return {
      ...columns,
      /**
       * Read genes for the open rows up to `to` too (`growGeneSample`): the
       * segments after those there, unbuilt -- each from a run kept in this
       * browser where one starts (an earlier visit grew further: its rows
       * are not read again), the rest one in store order when the rows lie
       * spread through the store (`_inStoreOrder`), else doubling from them
       * (`growthSegmentBounds`); each is built when a gene is read on it.
       * Returns the new segments.
       */
      growTo: async (to, growOptions = {}) => {
        const end = Math.min(nRows, to);
        const from = columns.readRows();
        if (end <= from) return [];
        // The open rows' matrix to `end`, with their pointers (the added
        // rows' only: those before are held), once a segment in open order,
        // or the check of a kept run, needs it.
        let grown = null;
        const grownRows = async () => (grown ??= await this._openRowsMatrix(resolved, end, growOptions));
        // Runs kept past the rows read so far, within the growth (the
        // opening took those within the sample, `_takeKeptRuns`).
        const kept = [];
        for (const run of await this._takeKeptRuns(resolved, () => grownRows().then(read => read.pointers), end)) {
          if (run.start >= from && run.start + run.rows <= end) kept.push(run);
          else run.kept.release();
        }
        const added = [];
        let inOpenOrder = false;
        try {
          let at = from;
          while (at < end) {
            const run = kept.find(item => item.start === at) ?? null;
            if (run !== null) kept.splice(kept.indexOf(run), 1);
            // The rows up to the next kept run (or the end) when none starts here.
            const next = run !== null ? at + run.rows : Math.min(end, ...kept.filter(item => item.start > at).map(item => item.start));
            if (run?.storeOrder === true || (run === null && this._inStoreOrder(resolved, at, next))) {
              added.push(await orderedSegmentOf(at, next, run, growOptions));
            } else {
              rowsRead = await grownRows();
              inOpenOrder = true;
              perRow ??= entriesPerRow(rowsRead.matrix, end);
              if (run !== null) added.push(await segmentOf(at, next, run));
              else {
                let segmentStart = at;
                for (const bound of growthSegmentBounds(at, next, perRow)) {
                  added.push(await segmentOf(segmentStart, bound, null));
                  segmentStart = bound;
                }
              }
            }
            at = next;
          }
        } finally {
          // Runs no segment took (the growth failed before them).
          for (const run of kept) run.kept.release();
        }
        // The open-order matrix is made again for the rows read now, when a
        // segment needs it, unless this growth made it.
        rowsRead = inOpenOrder ? grown : null;
        openRead = inOpenOrder ? Promise.resolve(grown) : null;
        columns.extend(added);
        readTo = end;
        return added;
      },
      /** Read genes for the first `rows` open rows only: the unbuilt segments past them are let go (a growth stopped). */
      trimTo(rows) {
        columns.trimTo(rows);
        readTo = columns.readRows();
        for (const start of storeOrdered.keys()) if (start >= readTo) storeOrdered.delete(start);
      },
    };
  }

  /**
   * Whether the rows a gene of a matrix indexed in segments still reads --
   * open rows `[start, nRows)`, after the segments an earlier opening
   * carried over, every open row on (no gene sample) -- are read through
   * the index every cell builds, of every stored row, restricted to them
   * (`restrictedAccess`), instead of their own pass in store order
   * (`fileOrderedAccess`). Only for rows spread through the store
   * (`_inStoreOrder`), or every stored row open in another order (a share
   * raised back to every cell in its order), that no run kept in this
   * browser of these rows starts (a kept run is taken as it is; the
   * carried rows' runs end at `start`). Yes when every stored row's index
   * is kept here (an opening of every cell kept it: nothing is read but
   * genes; raised back to every cell, the rows past the share's were
   * indexed again by a pass of their own, 27 MB read and decoded on a
   * 10M-cell store, marker genes 2.7 s → 5.3 s); else, for rows spread
   * through the store, when the whole reads no more stored bytes than the
   * rows (`_readsNoMoreThanRows`: they lie in every chunk) and is no more
   * work to index and to answer each gene once (`wholeIsCheaper`, at the
   * rates measured on this source: the index's, the view's and each path's
   * placement of a gene in open order). Unmeasured, a share of two thirds
   * of the entries or more: a 50 % uniform share of a 10M-cell store took
   * 1.3-1.7x on every stored row's index what its own pass took for its
   * first gene and marker genes (Chromium), each gene placing every stored
   * row's entries. A gene sample (fewer rows) grows, segment by
   * segment, and stays in store order. Decided once per opening and
   * matrix, by whichever asks first (`_readyGeneRows`, `_segmentedColumns`:
   * both from the same rows). @private
   */
  _restrictsWhole(resolved, start) {
    const key = resolved.key;
    let decided = this._restricted.get(key);
    if (decided === undefined) {
      decided = (async () => {
        const nRows = resolved.nRows;
        if (this._geneRows(resolved) < nRows || start >= nRows) return false;
        const stored = child(this._fullRoot, resolved.key);
        const nFile = this._cellSubset.nObs;
        // Every stored row open in another order (a share raised back to
        // every cell in its order): the rows past those carried are every
        // stored row's but the carried, whatever their order, and every
        // stored row's index kept here serves them with nothing read.
        const inStoreOrder = this._inStoreOrder(resolved, start, nRows);
        if (!inStoreOrder && nRows < nFile) return false;
        const kept = this._keptIndexes;
        // What this browser keeps, looked up while the rest is weighed.
        const where = kept === null ? null : { environment: kept.environment, tab: kept.tab };
        const keptPrefixes = where === null ? null : Promise.all([
          keptIndexPrefix(this._keptGroup(resolved), where),
          keptIndexPrefix(this._keptGroup(resolved, { everyCell: true }), where),
        ]);
        keptPrefixes?.catch(() => {});
        const allEntries = isGroup(stored) ? stored.get('indices').shape[0] : nFile * resolved.sourceVars;
        const cheaper = wholeIsCheaper({ keptEntries: allEntries * (nRows - start) / nFile, allEntries, rates: this._passRates });
        if (keptPrefixes !== null) {
          const [own, whole] = await keptPrefixes;
          // A run kept of these rows (past those carried) is taken as it is;
          // every stored row's kept reads nothing but genes.
          if (own.ends.some(end => end > start)) return false;
          if (whole.rows >= nFile) return true;
        }
        if (!inStoreOrder || !cheaper) return false;
        const rows = start === 0 && this._cellSubset.rows?.count === nRows
          ? this._cellSubset.rows.ascending().kept
          : sortUint32(copyTypedArray(Uint32Array, this._cellSubset.fileRows.subarray(start, nRows), 'File rows'));
        return this._readsNoMoreThanRows({ node: stored, rows, nRows: nFile, valuesOnDemand: !this._readsAhead() });
      })();
      decided.catch(() => this._restricted.delete(key));
      this._restricted.set(key, decided);
    }
    return decided;
  }

  /**
   * The rows a gene of a matrix indexed in segments still reads start at:
   * where the segments an earlier opening carried over end. @private
   */
  _restrictedStart(resolved) {
    const carried = this._carried.get(resolved.key)?.segments ?? [];
    return carried.length === 0 ? 0 : carried.at(-1).start + carried.at(-1).rows;
  }

  /**
   * Make a matrix ready for a gene read (`_readyRows` with the gene
   * sample's rows), unless its genes are read through every stored row's
   * index restricted to the open rows (`_restrictsWhole`): that reads the
   * stored row pointers itself, and the open rows' are never needed (a
   * 50 % uniform share's are 2.5M runs to read and walk at 5M cells). @private
   */
  _readyGeneRows(element, readOptions = {}) {
    const ready = () => this._readyRows(element, readOptions, this._geneReadRows(element));
    if (this._cellSubset?.fileRows == null) return ready();
    let resolved;
    try {
      resolved = this._requireMatrixElement(element);
    } catch {
      // Not a matrix: the read says so itself.
      return ready();
    }
    // Columns an earlier opening of the same rows carried over whole are read as they were made.
    if (!this._indexedInSegments(resolved) || this._carried.get(resolved.key)?.columns !== undefined) return ready();
    return this._restrictsWhole(resolved, this._restrictedStart(resolved)).then(whole => (whole ? undefined : ready()));
  }

  /**
   * Every stored row's index of a matrix kept in this browser by an opening
   * of every cell (or a share that built it, `_restrictsWhole`), taken, or
   * null. @private
   */
  async _wholeKeptRun(resolved) {
    const kept = this._keptIndexes;
    if (kept === null) return null;
    const nFile = this._cellSubset.nObs;
    const stored = child(this._fullRoot, resolved.key);
    const runs = await findKeptRuns(this._keptGroup(resolved, { everyCell: true }), {
      nRows: nFile,
      nCols: resolved.sourceVars,
      fileRows: (start, end) => {
        const rows = allocateTypedArray(Uint32Array, end - start, 'File rows');
        for (let i = 0; i < rows.length; i++) rows[i] = start + i;
        return rows;
      },
      pointers: isGroup(stored) ? () => this._storedIndptr(resolved) : null,
      label: resolved.label,
    }, { environment: kept.environment, tab: kept.tab }).catch(() => []);
    const whole = runs.find(run => run.start === 0 && run.rows === nFile && !run.storeOrder) ?? null;
    for (const run of runs) if (run !== whole) run.kept.release();
    return whole;
  }

  /**
   * The stored row pointers of a CSR matrix (every stored row's, whatever
   * cells are open; null for a dense one), read once and kept with the
   * store's (`_indptrs`: a later opening of every cell, or a share's view,
   * takes them over). @private
   */
  async _storedIndptr(resolved) {
    const stored = child(this._fullRoot, resolved.key);
    if (!isGroup(stored)) return null;
    let pointers = this._indptrs.get(stored.path);
    if (pointers === undefined) {
      pointers = await readRowPointers(stored);
      this._indptrs.set(stored.path, pointers);
    }
    return pointers;
  }

  /**
   * Whether open rows `[start, end)` of a cell-major matrix (CSR, or dense
   * in row chunks) lie so spread through its stored chunks that segments in
   * open order would each read most of them (`rowsInterleaved`, against the
   * first segment doubling from `start` would make): they are then indexed
   * in store order (`_takeStoreOrderMatrix`). Not for a file in its own
   * order or a priority-ordered file's prefix (rows ascending), whole
   * blocks, a modality's matrix, a column window, a matrix not in chunks.
   * @private
   */
  _inStoreOrder(resolved, start, end) {
    const fileRows = this._cellSubset?.fileRows ?? null;
    if (fileRows === null || resolved.start !== 0 || resolved.throughCells || resolved.key.startsWith('mod/')) return false;
    let stored = this._fullRoot ?? null;
    for (const part of resolved.key.split('/')) stored = isGroup(stored) ? stored.get(part) ?? null : null;
    const nFile = this._cellSubset.nObs;
    // Stored rows a chunk holds, about, and stored values a row.
    let rowsPerChunk = null;
    let perRow = 0;
    if (isGroup(resolved.node) && isGroup(stored) && typeof this._root?.rowsMatrix === 'function') {
      const indices = stored.get('indices') ?? null;
      const nnz = indices?.shape?.[0] ?? 0;
      if (Array.isArray(indices?.chunks) && indices.partialChunks !== true && nnz > 0) {
        rowsPerChunk = nFile * Number(indices.chunks[0]) / nnz;
        perRow = nnz / nFile;
      }
    } else if (isArrayNode(resolved.node) && resolved.node.gather !== undefined && isArrayNode(stored) && stored.shape.length === 2) {
      if (Array.isArray(stored.chunks) && stored.partialChunks !== true) {
        rowsPerChunk = Number(stored.chunks[0]);
        perRow = stored.shape[1];
      }
    }
    if (rowsPerChunk === null) return false;
    const firstRows = segmentBounds(start, end, firstSegmentRows(end, perRow))[0] - start;
    return rowsInterleaved(fileRows.subarray(start, end), end - start, firstRows, rowsPerChunk, nFile);
  }

  /**
   * Open rows `[start, end)` of a cell-major matrix in store order:
   * `order`, the open row (from `start`) of each row in ascending file row
   * (a radix order of their file rows); `matrix`, those rows as a matrix of
   * their own (a CSR matrix's `rowsMatrix`, after their pointers; a dense
   * one's gathered rows); `pointers`, a CSR matrix's row pointers (null for
   * a dense one).
   * Made once for the check of a run kept in store order and the segment
   * that then uses it (`_takeStoreOrderMatrix`). @private
   */
  _storeOrderMatrix(resolved, start, end, readOptions = {}) {
    const key = `${resolved.key}\u0000${start}\u0000${end}`;
    let made = this._storeOrdered.get(key);
    if (made === undefined) {
      // The view's own work making them, measured (`PassRates`: `_restrictsWhole` weighs it).
      const meter = this._passRates.view;
      const timed = work => {
        const started = performance.now();
        try {
          return work();
        } finally {
          meter.note(performance.now() - started);
        }
      };
      made = (async () => {
        // Every open row (the whole first segment): the open rows' own file
        // order (`CellRows` `byRow`), made once, beside the rows ascending
        // their pointers were read for; no row list or runs of its own.
        const cellRows = this._cellSubset.rows ?? null;
        if (start === 0 && end === resolved.nRows && cellRows?.count === end) {
          if (isGroup(resolved.node)) {
            await this._root.readRowPointers(resolved.key, readOptions);
            const { order, matrix } = timed(() => this._root.fileOrderMatrix(resolved.key, { chunks: this._scanChunks(resolved) }));
            return { order, matrix, pointers: matrix.rowPointers() };
          }
          // A dense matrix's open rows are a gather of the stored array over
          // the open rows' runs: in file order, over the same rows' runs ascending.
          const inner = resolved.node.gather;
          if (inner !== undefined && inner.runs === cellRows.runs()) {
            const { order, rows } = timed(() => cellRows.byRow());
            return { order, matrix: gatheredArray(inner.source, timed(() => rows.runs()), { mergeGapBytes: inner.mergeGapBytes, chunks: inner.chunks, meter }), pointers: null };
          }
        }
        const { order, rows } = timed(() => {
          const ascending = orderByKey(this._cellSubset.fileRows.subarray(start, end));
          if (start === 0) return { order: ascending, rows: ascending };
          const shifted = allocateTypedArray(Uint32Array, ascending.length, 'Rows in store order');
          for (let i = 0; i < ascending.length; i++) shifted[i] = ascending[i] + start;
          return { order: ascending, rows: shifted };
        });
        // A dense matrix's rows: a gather of its open rows, one gather of the stored array.
        if (!isGroup(resolved.node)) return { order, matrix: gatheredArray(resolved.node, timed(() => runsOfPositions(rows)), { mergeGapBytes: () => this._mergeGapBytes(), meter }), pointers: null };
        await this._root.readRowPointers(resolved.key, { ...readOptions, rows });
        const matrix = timed(() => this._root.rowsMatrix(resolved.key, rows, { chunks: this._scanChunks(resolved) }));
        return { order, matrix, pointers: matrix.rowPointers() };
      })();
      this._storeOrdered.set(key, made);
      made.catch(() => this._storeOrdered.delete(key));
    }
    return made;
  }

  /**
   * The decoded chunks a pass in store order over a CSR matrix's rows reads
   * through (`_storeOrderMatrix`): the store's (`decoded-chunks.js`) when the
   * matrix's chunks, decoded, fit what they keep; else a window of two
   * chunks of `indices` and of `data`, the ones a slab's read shares with
   * the next. A pass reads each stored chunk once, in order, and a later
   * one (the gene sample grown) starts again from the first: chunks kept
   * by recency within a budget smaller than the pass are evicted before
   * the next pass reaches them, so keeping them buys nothing and held a
   * 50 % uniform share's index pass 132 MB above every cell's (5M cells).
   * @private
   */
  _scanChunks(resolved) {
    const chunks = this._decodedChunks ?? null;
    const stored = this._fullRoot === null ? null : child(this._fullRoot, resolved.key);
    if (chunks === null || !isGroup(stored)) return chunks;
    const indices = stored.get('indices');
    const data = stored.get('data');
    const chunkElements = array => (Array.isArray(array?.chunks) && array.partialChunks !== true ? Number(array.chunks[0]) : null);
    const decoded = (indices.shape[0] ?? 0) * (elementBytes(indices) + elementBytes(data));
    if (decoded <= chunks.budgetBytes || chunkElements(indices) === null || chunkElements(data) === null) return chunks;
    return new DecodedChunks(2 * (chunkElements(indices) * elementBytes(indices) + chunkElements(data) * elementBytes(data)));
  }

  /** `_storeOrderMatrix`, taken by the segment it is made for (no longer held by the reader). @private */
  async _takeStoreOrderMatrix(resolved, start, end, readOptions = {}) {
    const made = await this._storeOrderMatrix(resolved, start, end, readOptions);
    this._storeOrdered.delete(`${resolved.key}\u0000${start}\u0000${end}`);
    return made;
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

  /**
   * The group a matrix's kept index is filed under (`keptIndexGroup`): this
   * opening's rows', or (`everyCell`) every stored row's in file order, as
   * an opening of every cell files it. @private
   */
  _keptGroup(resolved, { everyCell = false } = {}) {
    const subset = !everyCell && (this._cellSubset?.fileRows ?? null) !== null;
    return keptIndexGroup({
      file: this._keptIndexes.identity,
      element: resolved.key,
      // The matrix as stored: every row of the file (a subsample keeps some).
      shape: [resolved.key.startsWith('mod/') || (this._cellSubset?.fileRows ?? null) === null ? resolved.nRows : this._cellSubset.nObs, resolved.sourceVars],
      // A subsample's order (in the cell order it opened in), or every cell
      // opened in one's (`cellOrder`): `openOrderSpecOf`.
      order: orderKey(this._cellSubset === null ? null : openOrderSpecOf(this._cellSubset), subset),
    });
  }

  /**
   * The kept runs of a matrix's index this opening can use
   * (`findKeptRuns`), found once and held until its index takes them
   * (`_takeKeptRuns`) or the opening ends. `pointers()`: the open rows' row
   * pointers (read only when a kept run is checked), of the first `within`
   * open rows at least: a run reaching past them (past the gene sample) is
   * left for another opening, unchecked. @private
   */
  _keptRunsOf(resolved, pointers, within = resolved.nRows) {
    const rows = this._keptRowsOf(resolved);
    if (rows === null) return Promise.resolve([]);
    let found = this._keptRuns.get(resolved.key);
    if (found === undefined) {
      const { tab, environment } = this._keptIndexes;
      found = findKeptRuns(this._keptGroup(resolved), {
        nRows: resolved.nRows,
        within,
        nCols: resolved.sourceVars,
        fileRows: rows.of,
        pointers: isGroup(resolved.node) ? pointers : null,
        // Runs of a segment in store order (`_inStoreOrder`): their rows'
        // file rows ascending, and the pointers of those rows in that order.
        storeOrder: rows.fileRows === null ? null : {
          fileRows: (start, end) => sortUint32(copyTypedArray(Uint32Array, rows.fileRows.subarray(start, end), 'File rows')),
          pointers: async (start, end) => (await this._storeOrderMatrix(resolved, start, end)).pointers,
        },
        label: resolved.label,
      }, { environment, tab }).catch(() => []);
      this._keptRuns.set(resolved.key, found);
    }
    return found;
  }

  /** The kept runs of a matrix's index, taken by the index that starts from them (the caller releases what it does not use). @private */
  async _takeKeptRuns(resolved, pointers, within = resolved.nRows) {
    const runs = [...await this._keptRunsOf(resolved, pointers, within)];
    this._keptRuns.delete(resolved.key);
    return runs;
  }

  /**
   * Keep the index of open rows `[start, end)` of a matrix, built by a pass
   * (`RowMajorColumnIndex` `onBuilt`), for a later opening of the same rows:
   * in the background, a piece at a time between the reader's other work.
   * `pointers`: the open rows' row pointers from open row 0; or, with
   * `order` (a segment in store order: the open row from `start` of each of
   * its rows), the segment's own. `everyCell`: the index of every stored
   * row (`_restrictsWhole`), kept as an opening of every cell keeps it, its
   * pointers the stored ones. @private
   */
  _keepRun(resolved, start, end, store, { pointers = null, order = null, everyCell = false } = {}) {
    const rows = everyCell ? (this._keptIndexes === null ? null : { fileRows: null }) : this._keptRowsOf(resolved);
    if (rows === null || typeof store?.keptParts !== 'function') return;
    const kept = this._keptIndexes;
    const group = this._keptGroup(resolved, { everyCell });
    const job = (async () => {
      const all = pointers ?? (everyCell
        ? await this._storedIndptr(resolved)
        : (isGroup(resolved.node) ? await this._openRowPointers(resolved.node) : null));
      const from = order === null ? start : 0;
      let rowPointers = null;
      if (all !== null) {
        rowPointers = allocateTypedArray(Float64Array, end - start + 1, 'Row pointers');
        for (let i = 0; i < rowPointers.length; i++) rowPointers[i] = all[from + i] - all[from];
      }
      let fileRows = null;
      if (rows.fileRows !== null) {
        fileRows = allocateTypedArray(Uint32Array, end - start, 'File rows');
        // A segment in store order keeps its rows' file rows ascending (`storeOrder`).
        if (order === null) fileRows.set(rows.fileRows.subarray(start, end));
        else for (let i = 0; i < order.length; i++) fileRows[i] = rows.fileRows[start + order[i]];
      }
      // The run kept before of the same rows (a structure kept again with
      // its values once a gene read them whole, `onBuilt`) is replaced.
      const slot = `${resolved.key}\u0000${start}\u0000${end}${everyCell ? '\u0000every cell' : ''}`;
      this._keptRunDirectories ??= new Map();
      const directory = await keepRun(group, {
        start,
        fileRows,
        storeOrder: order !== null,
        rowPointers,
        parts: store.keptParts(),
      }, {
        file: kept.identity,
        about: kept.about,
        environment: kept.environment,
        tab: kept.tab,
        onStore: kept.onStore,
        yieldControl: () => this._yieldToForeground(false),
        replaces: this._keptRunDirectories.get(slot) ?? null,
      });
      if (directory !== null) this._keptRunDirectories.set(slot, directory);
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
   * next gene shows on first); `matrix` and `pointers`, the rows read as a
   * matrix in open order and a CSR matrix's row pointers (null when the rest
   * is in store order); `rest`, the rows still to index as the pass reads
   * them (`{matrix, rows}`: in store order when they lie spread through the
   * store, `_inStoreOrder`, one segment, so `next` is the last of them; the
   * stored matrix and its rows when that segment reads every stored row's
   * index, `_restrictsWhole`). @private
   */
  async _segmentProgress(resolved) {
    const { nRows, key: element } = resolved;
    // The rows a gene is read for (the gene sample's): nothing past them is read.
    const readTo = this._geneRows(resolved);
    const segments = this._matrices.get(element)?.columns?.segments ?? this._carried.get(element)?.segments ?? [];
    let done = 0;
    for (const segment of segments) {
      if (segment.start !== done || segment.access.built?.() !== true) break;
      done += segment.rows;
    }
    // The rows read as a matrix in open order, with their pointers only
    // (`_openRowsMatrix`): made when a kept run is checked or the rest is
    // read in open order. Rows in store order never need it (a 50 % uniform
    // share's open rows in open order are millions of runs of one row).
    let opened = null;
    const openRows = () => (opened ??= this._openRowsMatrix(resolved, readTo));
    let runs = [];
    if (this._matrices.get(element)?.columns == null) {
      // Not opened yet: the runs kept in this browser are built too (those
      // within the gene sample: `_segmentedColumns` takes no other).
      runs = await this._keptRunsOf(resolved, () => openRows().then(read => read.pointers), readTo);
      for (const run of runs) if (run.start === done && done + run.rows <= readTo) done += run.rows;
    }
    done = Math.min(done, readTo);
    const pending = segments.find(segment => segment.start === done);
    const following = runs.find(run => run.start > done);
    // The rest read through every stored row's index (`_restrictsWhole`):
    // its pass is every stored row's.
    if (pending === undefined && following === undefined && done < readTo && await this._restrictsWhole(resolved, done)) {
      return { done, next: readTo, pointers: null, matrix: null, readTo, rest: { matrix: child(this._fullRoot, resolved.key), rows: this._cellSubset.nObs } };
    }
    // Rows spread through the store are one segment in store order (`_segmentedColumns`).
    if (pending === undefined && following === undefined && done < readTo && this._inStoreOrder(resolved, done, readTo)) {
      const ordered = await this._storeOrderMatrix(resolved, done, readTo);
      return { done, next: readTo, pointers: null, matrix: null, readTo, rest: { matrix: ordered.matrix, rows: readTo - done } };
    }
    const { matrix, pointers } = await openRows();
    const next = pending !== undefined
      ? done + pending.rows
      : Math.min(segmentBounds(done, readTo, firstSegmentRows(readTo, entriesPerRow(matrix, Math.min(nRows, readTo))))[0] ?? readTo, following?.start ?? readTo);
    const rest = done === 0 && readTo === nRows ? resolved.node : rowRangeMatrix(matrix, done, readTo, pointers);
    return { done, next, pointers, matrix, readTo, rest: { matrix: rest, rows: readTo - done } };
  }


  /**
   * How many of a matrix's open rows a gene is read for: the gene sample's
   * cells (`subsample-plan.js`, `genes`: the first open cells in priority
   * order) for a matrix indexed in segments, else every row. @private
   */
  _geneRows(resolved) {
    const genes = this._cellSubset?.genes ?? null;
    return genes === null || !this._indexedInSegments(resolved) ? resolved.nRows : Math.min(resolved.nRows, genes.cells);
  }

  /**
   * The row pointers of a CSR matrix as open (null for a dense one): a
   * subsample view's, in memory, else the stored ones, kept (they do not
   * depend on the cells). @private
   */
  async _openRowPointers(matrix, readOptions = {}) {
    if (!isGroup(matrix)) return null;
    const stored = this._cellSubset?.fileRows === null;
    // A view's own, as numbers (its `indptr` is made of them, in 64-bit integers past 2^31 entries).
    const viewed = stored ? null : matrix.rowPointers?.() ?? null;
    const pointers = viewed ?? (stored ? this._indptrs.get(matrix.path) : undefined) ?? await readRowPointers(matrix, readOptions);
    if (stored) {
      this._indptrs.set(matrix.path, pointers);
      // The whole holds every prefix read before (`_storedRowPointers`).
      this._indptrPrefixes.delete(matrix.path);
    }
    return pointers;
  }

  /**
   * Open rows `[0, rows)` of a matrix indexed in segments as a matrix of
   * their own (`matrix`), with its row pointers (`pointers`: exact, at
   * least `rows + 1`; null for a dense matrix): what the gene sample's
   * segments are made of. Only those rows' pointers are read -- a
   * subsample view's through `rowsMatrix`, a stored matrix's first
   * `rows + 1` -- never every open row's: a sample of 2,011 of the
   * 11,441,407 cells of a CELLxGENE atlas read the whole `X/indptr`
   * (31 MB, 4,379 requests) before its first gene. Every open row is the
   * matrix as open. @private
   */
  async _openRowsMatrix(resolved, rows, readOptions = {}) {
    const { node, key, nRows } = resolved;
    if (!isGroup(node)) return { matrix: node, pointers: null };
    const root = this._root;
    if (rows >= nRows) {
      // Every open row's pointers (a view reads only those it does not hold).
      if (this._cellSubset?.fileRows !== null && typeof root?.readRowPointers === 'function') await root.readRowPointers(key, readOptions);
      return { matrix: node, pointers: await this._openRowPointers(node, readOptions) };
    }
    if (this._cellSubset?.fileRows !== null && typeof root?.rowsMatrix === 'function') {
      await root.readRowPointers(key, { ...readOptions, rows });
      const matrix = root.rowsMatrix(key, rows);
      return { matrix, pointers: matrix.rowPointers() };
    }
    return { matrix: node, pointers: await this._storedRowPointers(node, rows, readOptions) };
  }

  /**
   * The first `rows + 1` stored row pointers of a matrix the open rows are
   * the file's rows of (a priority-ordered file opened whole): the whole
   * `indptr` when read already, else the prefix read so far
   * (`_indptrPrefixes`) and the pointers after it it lacks. @private
   */
  async _storedRowPointers(matrix, rows, readOptions = {}) {
    const whole = this._indptrs.get(matrix.path);
    if (whole !== undefined) return whole;
    const held = this._indptrPrefixes.get(matrix.path) ?? null;
    if (held !== null && held.length > rows) return held;
    const from = held === null ? 0 : held.length;
    const read = await readIntegers(matrix.get('indptr'), from, rows + 1, `${matrix.path} indptr`, readOptions);
    const pointers = allocateTypedArray(Float64Array, rows + 1, `${matrix.path} indptr`);
    if (held !== null) pointers.set(held);
    for (let i = 0; i < read.length; i++) pointers[from + i] = Number(read[i]);
    const nnz = matrix.get('indices').shape[0];
    if (pointers[0] !== 0) throw new Error(`${matrix.path} indptr must start at zero`);
    for (let i = Math.max(1, from); i <= rows; i++) {
      if (!(pointers[i] >= pointers[i - 1]) || pointers[i] > nnz) throw new Error(`${matrix.path} indptr must be monotonic and within its ${formatCountOf(nnz, 'stored value')}`);
    }
    // Another read may have taken more meanwhile: the longer prefix is kept.
    if ((this._indptrPrefixes.get(matrix.path)?.length ?? 0) < pointers.length) this._indptrPrefixes.set(matrix.path, pointers);
    return pointers;
  }

  /**
   * The open rows a gene read of `element` needs the row pointers of: the
   * gene sample's (`_geneRows`) when it is fewer than every open row, else
   * null (every open row's). @private
   */
  _geneReadRows(element) {
    if ((this._cellSubset?.genes ?? null) === null) return null;
    let resolved;
    try {
      resolved = this._requireMatrixElement(element);
    } catch {
      // Not a matrix: the read says so itself.
      return null;
    }
    const rows = this._geneRows(resolved);
    return rows < resolved.nRows ? rows : null;
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
    // The layout as stored: the open cells' view of a CSR matrix has no
    // arrays until their row pointers are read (`readRowPointers`), and
    // whether genes are read through a row index does not depend on them.
    const stored = this._fullRoot === null ? null : child(this._fullRoot, resolved.key);
    return readsThroughRowIndex(stored ?? resolved.node, { nObs: resolved.nRows, nVars: resolved.sourceVars, decodedChunkBytes: this._decodedChunkBytes });
  }

  /**
   * Make a matrix of a subsample ready to be read: its kept rows' pointers,
   * when it is a CSR matrix on the cell axis (`cellSubsetView`
   * `readRowPointers`; nothing for any other matrix, or when every cell is
   * open: null, so a read of every cell waits for nothing). `X`'s also
   * give the subsample's kept values and the share of X's index chunks they
   * lie in (`cellSubset`). @private
   */
  _readyRows(element, readOptions = {}, rows = null) {
    const root = this._root;
    if (typeof root?.readRowPointers !== 'function' || typeof element !== 'string') return null;
    // A read of the pointers is a step of its own before the gene (the kept
    // rows lie throughout the file, so their pointers lie in most of its
    // pointer chunks): it is shown as one, once, while it runs.
    let activity = null;
    const covered = typeof root.rowPointersCover === 'function' ? root.rowPointersCover(element, rows) : (root.rowPointersOf?.(element) ?? null) !== null;
    if (readOptions.activity == null && !covered && !this._pointerActivities.has(element)) {
      // Read for genes, not an index built: a later visit with the gene
      // index kept reads them too (they place the kept runs' entries in the
      // file, and check them: `findKeptRuns`).
      activity = this.createActivity?.({
        kind: 'genes',
        label: rows === null
          ? `where each open cell's row of ${element} starts (its row pointers), read once before its first gene`
          : `where the row of ${element} of each of the ${formatCountOf(typeof rows === 'number' ? rows : rows.length, 'cell')} read starts (their row pointers), read once`,
      }) ?? null;
      if (activity !== null) this._pointerActivities.set(element, activity);
    }
    const options = activity === null ? readOptions : { ...readOptions, activity };
    const read = root.readRowPointers(element, rows === null ? options : { ...options, rows });
    if (activity !== null) {
      read.then(() => activity.finish(), error => activity.finish(error))
        .finally(() => this._pointerActivities.delete(element));
    }
    // The kept values of every open row are known once every open row's pointers are.
    return rows === null ? read.then(() => this._noteKeptValues(element, root)) : read;
  }

  /**
   * `estimatedChunkShare` of the expression matrix genes are read from
   * (`_expression`), when it is CSR, for the kept rows (null for another
   * layout). @private
   */
  _estimatedChunkShare(full, resolution, rows = null) {
    const X = this._expression === null ? null : child(full, this._expression);
    if (!isGroup(X) || encodingType(X) !== 'csr_matrix') return null;
    const indices = X.get('indices');
    const chunkElements = Array.isArray(indices?.chunks) && indices.partialChunks !== true ? indices.chunks[0] : null;
    if (chunkElements === null) return null;
    // Every row open (in another order): every chunk, no rows ascending made for it.
    if (resolution.fileRows.length === resolution.nObs) return estimatedChunkShare(resolution.fileRows, resolution.nObs, indices.shape[0], chunkElements);
    // Over the open rows ascending, made once (`CellRows` `ascending`: a gene read weighs them again, `_restrictsWhole`).
    return estimatedChunkShare(rows?.ascending().kept ?? resolution.fileRows, resolution.nObs, indices.shape[0], chunkElements);
  }

  /**
   * The subsample's kept values of the expression matrix genes are read
   * from (`_expression`), once its kept rows' pointers are read. @private
   */
  _noteKeptValues(element, root) {
    const subset = this._cellSubset;
    if (element !== this._expression || subset === null || subset.keptValues !== null || root !== this._root) return;
    // Exact from here on: the estimate made at opening is replaced.
    const X = child(this._fullRoot, element);
    const pointers = root.rowPointersOf(element);
    if (!isGroup(X) || encodingType(X) !== 'csr_matrix' || pointers === null) return;
    const indices = X.get('indices');
    const chunkElements = Array.isArray(indices?.chunks) && indices.partialChunks !== true ? indices.chunks[0] : null;
    // One walk forward over the open rows ascending (`CellRows` `ascending`, made when their pointers were read).
    const started = performance.now();
    const stats = keptValueStats(pointers, subset.rows?.ascending().kept ?? subset.fileRows, chunkElements, indices.shape[0]);
    // Work of the view's own before its pass (`PassRates`).
    this._passRates.view.note(performance.now() - started);
    subset.keptValues = stats.values;
    subset.matrixChunkShare = stats.chunkShare;
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
    // The matrix genes are read from by default: what a gene costs is its
    // cost (`defaultExpressionPath`), decided once on the stored root. It is
    // decided here, before the cells are resolved, because it prices the
    // opening: the gene sample (`geneSampleOf`: gene time, gene index), the
    // default block size, which fixes every cell's open order (`cellOrder`),
    // and the map's memory fit (`autoFitCount`). Deciding it after the first
    // view would change the open cells and their order (a reopen). So the
    // K-07 read it may make -- the first chunk of a dense float `X` beside a
    // `raw` of the same genes, whether `X` is scaled -- is the one matrix
    // read an opening makes; every other probe of a matrix (whether it
    // holds counts) waits until after the first view (`probeMapping`), and a
    // served store answers that chunk at once while it lays the matrix out.
    this._expression = await defaultExpressionPath(full, { launch: await launchExpressionOf(full, readOptions) });
    // Opening loads every expression matrix (`ANNDATA_OPENING_PATHS`); a
    // launch default may name another element, priced here.
    if (this._expression !== null) await full.load([this._expression], readOptions);
    const context = {
      expression: this._expression,
      valuesOnDemand: !this._readsAhead(),
      decodedChunkBytes: this._decodedChunkBytes ?? residencyBudgetBytes('decodedBlocks'),
      readOptions,
      // Auto-fit prices the first gene of a matrix stored cell by cell at
      // the link as measured now, or as the host delivered on earlier visits
      // while this opening's reads rest on less (`host-link-memory.js`).
      link: pricingLink(this._link?.snapshot?.() ?? null, this._hostLink ?? null),
      // What a `blocks` order's rung is sized at, the opening's own rate
      // being a lower bound (`blockRung`): the rate the host sustained on
      // earlier visits, or this browser's downlink measured on the page's
      // assets (`host-link-memory.js` `hostLinkSeed`).
      seedBytesPerMs: Math.max(this._hostLink?.downlinkBytesPerMs ?? 0, this._hostLink?.bytesPerMs ?? 0) || null,
      // The first open cells whose gene index of that matrix is kept in
      // this browser cost the first gene only what the kept runs lack: their
      // values, when the runs hold entry positions alone (`keptIndexPrefix`).
      // Store rows holding their matrix rows, when not every one does.
      held: this._held ?? null,
      keptIndexRows: this._keptIndexes === null || this._expression === null ? null : (spec, shape) => keptIndexPrefix(keptIndexGroup({
        file: this._keptIndexes.identity,
        element: this._expression,
        shape,
        order: orderKey(spec, true),
      }), { environment: this._keptIndexes.environment, tab: this._keptIndexes.tab }),
      // The cells asked for are resolved first, then a progressive opening's
      // first view and each step after: every size of the subsample from
      // the one rank pass made for the largest (`subsample.js`).
      subsampleCache: this._subsampleCache,
      geneSamplesSeen: this._geneSamplesSeen ?? null,
    };
    let resolution = await resolveCellSubset(full, request, context);
    // A first view smaller than the cells asked for, when reading them is
    // measured to take long (`progressive-open.js`): the page grows it in
    // place to them (`growth`).
    let growth = null;
    if (request?.progressive != null) {
      const nObs = resolution.nObs;
      const link = pricingLink(this._link?.snapshot?.() ?? null, this._hostLink ?? null);
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
        // A matrix read after its map is read in one pass for the cells
        // the opening grows to, not for each step's (`shareRows`).
        if (this._held != null) this._grownShareRows = prefixEndRow(asked.fileRows ?? null, Math.min(growth.target, this._held.fitCells));
      }
    }
    this._fullRoot = full;
    if (resolution.fileRows === null) {
      this._cellSubset = { ...resolution, rows: null, keptValues: null, matrixChunkShare: null, readLayout: cellReadLayout(full, resolution.nObs, this._expression), growth };
      this._noteRowsHeld();
      return;
    }
    // The view reads a CSR matrix's row pointers when the matrix is first
    // read, and only the kept rows' (`readRowPointers`): opening a
    // subsample reads none. Pointers read whole before (every cell open,
    // then a subsample of the same store) serve it at once.
    // The open cells' rows and the lookups made of them (their runs, their
    // inverse), one set shared by the view and this reader, held while the
    // cells are open: counted in the working set (no cache gives them back).
    const rows = new CellRows(resolution.fileRows, resolution.nObs, { onHeld: (_bytes, made) => this._noteRowsHeld(made) });
    this._root = await cellSubsetView(full, {
      nObs: resolution.nObs,
      kept: resolution.fileRows,
      rows,
      mergeGapBytes: () => this._mergeGapBytes(),
      readOptions,
      indptrs: this._indptrs,
      knownRowPointers: this._knownRowPointers,
      chunks: this._decodedChunks,
      meter: this._passRates.view,
    });
    this._prefixReads = startPrefixReads(full, resolution, readOptions);
    this._cellSubset = {
      ...resolution,
      rows,
      // The stored values of the kept rows of a CSR X, known once X's kept
      // row pointers are read (`_readyRows`); the share of its index chunks
      // they lie in, estimated from its mean values a row until then (null
      // for another layout, or one read byte by byte).
      keptValues: null,
      matrixChunkShare: this._estimatedChunkShare(full, resolution, rows),
      // What a share of the cells costs of the arrays read most, by method (`cellShareReadShare`).
      readLayout: cellReadLayout(full, resolution.nObs, this._expression),
      growth,
    };
    this._noteRowsHeld();
  }

  /**
   * Count in this thread's working-set part what the open cells' rows (their
   * kept rows, runs and inverse), the subset's open order and the subsample
   * cache hold, each buffer once (the kept rows are often the cache's
   * selection). `rows`: the rows
   * being made, before `_cellSubset` names them. @private
   */
  _noteRowsHeld(rows = this._cellSubset?.rows ?? null) {
    const buffers = this._subsampleCache?.buffers() ?? new Set();
    for (const buffer of rows?.buffers() ?? []) buffers.add(buffer);
    // The subset's own per-cell arrays (its kept cells, its open order).
    for (const value of Object.values(this._cellSubset ?? {})) {
      if (ArrayBuffer.isView(value) && value.byteLength > 0) buffers.add(value.buffer);
    }
    let bytes = 0;
    for (const buffer of buffers) bytes += buffer.byteLength;
    setWorkingSet(this._cellRowsPart, bytes);
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
    this._noteRowsHeld();
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
      await column.load([''], readOptions);
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
    // Each frame's index and nested column names (`loadFrameStructure`), the
    // other var frames' too (`raw.var`, each modality's), all at once.
    await Promise.all([obs, var_, ...this._otherVarFrames(root).map(([frame]) => frame)]
      .map(frame => loadFrameStructure(frame, readOptions)));
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
    // Each column is checked on its own (no value is read): one this reader
    // does not understand is left out with the reason (`notes`), never the
    // dataset refused for it. The index, the shape and X are what the file
    // needs.
    const notes = [];
    const readable = (frame, columnOrder, frameLabel, length) => columnOrder.filter(key => {
      const defect = columnDefect(frame, key, format, frameLabel, length);
      if (defect !== null) notes.push(defect);
      return defect === null;
    });
    const obsColumns = readable(obs, obsSchema.columnOrder, 'obs', nObs);
    readable(var_, varSchema.columnOrder, 'var', nVars);
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
    this._obsKeys = obsColumns.filter(key => !(priorityOrdered && positions.has(key)));
    const otherVarFrames = this._otherVarFrames(root);
    await Promise.all(otherVarFrames.map(([frame]) => loadFrameStructure(frame, readOptions)));
    for (const [frame, frameLabel, length] of otherVarFrames) {
      readable(frame, validateDataFrame(frame, format, frameLabel).columnOrder, frameLabel, length);
    }
    this._notes = Object.freeze(notes);
    if (notes.length > 0) console.warn(`[AnnDataReader] ${this._name}: ${notes.join(' ')}`);
  }

  /**
   * The var frames besides the root's whose columns the data-mapping
   * catalog lists (`probeColumns`): `raw.var` and each modality's `var`,
   * each with its length when the matrix beside it states one. @private
   */
  _otherVarFrames(root) {
    const frames = [];
    const add = (group, frameLabel) => {
      const frame = child(group, 'var');
      if (!isGroup(frame)) return;
      const matrix = child(group, 'X');
      const shape = matrix === null ? null : (isGroup(matrix) ? attributeValue(matrix, 'shape') : matrix.shape);
      frames.push([frame, frameLabel, Array.isArray(shape) && shape.length === 2 ? Number(shape[1]) : null]);
    };
    add(child(root, 'raw'), 'raw.var');
    for (const name of this._modalities?.keys() ?? []) add(child(child(root, 'mod'), name), `${name} var`);
    return frames;
  }

  /**
   * What opening left out of the dataset, and why: the columns of `obs`,
   * `var`, `raw.var` and each modality's `var` this reader cannot read
   * (`columnDefect`), one sentence each.
   *
   * @returns {readonly string[]}
   */
  get notes() { return this._notes; }

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
   * is read but `uns['log1p']` and, for a group with `raw`, the first chunk
   * of a dense float `X` (whether it is scaled, `defaultExpression`, the
   * read the opening made: `_openCells`), and, with `counts`, each matrix's
   * first stored values (`storedValueFacts`: whether it holds counts, and
   * whether they refute `uns['log1p']`; null for each without). The opening describes the file without them
   * (`getDatasetMetadata`): the first view reads no matrix value, and a
   * served store's matrix being laid out in the background never holds it
   * back; the data-mapping catalog is completed with them after it.
   *
   * @param {{counts?: boolean}} [options]
   */
  async probeMapping({ counts = true } = {}) {
    this._ensureOpen();
    const root = this._root;
    const format = this._format;
    // What the catalog describes beyond what opening loaded: the graphs, an
    // `obsm` entry that is a group (a dataframe, a sparse matrix), and
    // `uns['log1p']`, of the root and of each modality.
    const probed = ['obsp', 'obsm', 'uns/log1p'];
    await root.load([...probed, ...[...(this._modalities?.keys() ?? [])].flatMap(name => probed.map(path => `mod/${name}/${path}`))]);
    const mappingProbes = name => {
      if (!root.has(name)) return [];
      const group = requireMapping(root.get(name), format, `${format.file} ${name} mapping`);
      return group.keys().map(key => probeElement(key, group.get(key)));
    };
    // Sparse matrices' stored values are probed in the store as it is held,
    // before a subsample's view (`storedValueFacts`).
    const stored = this._fullRoot ?? root;
    const expression = await this._probeExpression(root, format.file, stored, counts);
    let modalities = null;
    if (this._modalities !== null) {
      modalities = await Promise.all([...this._modalities.values()].map(async ({ modality }) => {
        const group = this._root.get(`mod/${modality.name}`);
        const probe = await this._probeExpression(group, `${format.file} modality '${modality.name}'`, stored.get(`mod/${modality.name}`), counts);
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
   * its var count and columns, `X`, layers, `raw` and `uns['log1p']`;
   * whether each matrix holds counts with `counts` (else null).
   * @private
   */
  async _probeExpression(group, label, stored = group, counts = true) {
    // What each matrix's first stored values tell (`storedValueFacts`):
    // whether it holds counts and whether they refute `uns['log1p']`.
    const log1p = await readLog1pRecord(group, {});
    const factsOf = async (node, read, storedNode) => {
      const facts = counts ? await storedValueFacts(node, { read, stored: storedNode, log1pBase: log1p === null ? undefined : log1p.base }) : null;
      return { counts: facts?.counts ?? null, notLog1p: facts?.notLog1p ?? null };
    };
    const format = this._format;
    let raw = null;
    let rawShape = null;
    const rawGroup = child(group, 'raw');
    if (isGroup(rawGroup) && rawGroup.has('X')) {
      const rawX = probeElement('X', rawGroup.get('X'));
      rawShape = rawX.shape?.length === 2 ? rawX.shape : [0, 0];
      raw = {
        nVars: rawX.shape?.length === 2 ? rawX.shape[1] : 0,
        X: { storage: rawX.storage, dtype: rawX.dtype, ...await factsOf(rawGroup.get('X'), undefined, child(child(stored, 'raw'), 'X')) },
        varColumns: rawGroup.has('var') ? probeColumns(rawGroup.get('var'), format, `${label} raw.var`, rawX.shape?.length === 2 ? rawX.shape[1] : null) : [],
      };
    }
    let matrixX = null;
    let nVars = null;
    if (group.has('X')) {
      const node = group.get('X');
      const probe = probeElement('X', node);
      // Whether X is scaled decides between it and raw (`defaultExpression`):
      // asked only when there is a raw to choose.
      const read = regionReader(node);
      const scaled = raw === null || probe.shape?.length !== 2
        ? null
        : (await expressionRuleInputs({ X: storedMatrix(node, probe.shape), rawX: { shape: rawShape }, read })).xScaled;
      matrixX = { storage: probe.storage, dtype: probe.dtype, scaled, ...await factsOf(node, read, stored.get('X')) };
      nVars = probe.shape?.[1] ?? null;
    }
    const layers = group.has('layers')
      ? await Promise.all(requireMapping(group.get('layers'), format, `${label} layers mapping`).keys()
        .map(async key => {
          const node = group.get('layers').get(key);
          return { ...probeElement(key, node), ...await factsOf(node, undefined, stored.get('layers').get(key)) };
        }))
      : [];
    const varFrame = group.get('var');
    if (nVars === null) {
      const { indexKey } = validateDataFrame(varFrame, format, `${label} var`);
      nVars = (await readDataFrameIndex(varFrame.get(indexKey), format, `${label} var index`, null, false, {})).length;
    }
    return {
      nVars,
      varColumns: probeColumns(varFrame, format, `${label} var`, nVars),
      X: matrixX,
      layers,
      raw,
      log1p,
    };
  }

  /**
   * Refuse a store whose `obsm` holds no array of cell coordinates -- no
   * dense numeric array of one or two dimensions with a column -- with the
   * no-embedding refusal every format gives (design decision D4), from the
   * metadata opening loaded: no cell is resolved and no value read for it.
   * (An array listed here whose rows or values cannot be drawn is refused
   * once read, by the data mapping, with its reason.) @private
   */
  async _requireEmbedding(readOptions) {
    const probesOf = () => {
      const obsm = child(this._root, 'obsm');
      return isGroup(obsm) ? obsm.keys().map(key => probeElement(key, obsm.get(key))) : [];
    };
    const coordinates = probe => probe.storage === 'dense' && probe.numeric
      && (probe.shape?.length === 1 || (probe.shape?.length === 2 && probe.shape[1] >= 1));
    if (probesOf().some(coordinates)) return;
    // Refused: its groups (a sparse matrix, a table) are loaded to be named.
    await this._ready([{ path: 'obsm', depth: 2 }], readOptions);
    const what = probe => {
      if (probe.storage === 'csr' || probe.storage === 'csc') return 'sparse';
      if (probe.storage === 'dataframe') return 'a table';
      if (probe.storage !== 'dense') return 'not an array';
      if (!probe.numeric) return 'not numeric';
      return probe.shape?.length === 2 ? 'no columns' : 'not one- or two-dimensional';
    };
    const held = probesOf().map(probe => `${probe.key} (${what(probe)})`);
    throw noEmbeddingRefusal(this._name, held.length === 0 ? '' : `Its obsm holds ${held.join(', ')}: no array of cell coordinates.`);
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
   * read is for (its activity's label). `cells`: listed open cells alone,
   * in their order (an export's), their rows read in the stored order
   * (`gatheredArray`): never every open row between them (a 50 % uniform
   * share's export of one cell type read all 5M open rows, every chunk, for
   * 489,612 cells in rows of their own).
   */
  async readObsmColumns(key, columns, { signal = null, rows = null, cells = null, reason = null } = {}) {
    this._ensureOpen();
    const generation = this._generation;
    const { array, shape, width, label } = this._obsmArray(key);
    const selected = requireObsmColumnSelection(columns, width, label);
    if (cells !== null) {
      if (rows !== null) throw new TypeError(`${label} is read for listed cells or a range of rows, not both`);
      const listed = requirePositions(cells, shape[0], `${label} row`);
      const gathered = gatheredArray(array, runsOfPositions(listed), { mergeGapBytes: () => this._mergeGapBytes(), chunks: this._decodedChunks });
      const what = `${label} columns ${selected.join(', ')}, ${formatCountOf(listed.length, 'listed cell')}${reason === null ? '' : ` (${reason})`}`;
      return this._track('embedding', what, readOptions =>
        this._readObsmColumns(gathered, gathered.shape, selected, label, generation, readOptions), signal);
    }
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
    // Rows in the order the store reads them fastest (a view's in the
    // stored order, `readRowsInStoreOrder`), each put in its place.
    if (shape.length === 1) {
      for await (const { values, runs } of readRowsInStoreOrder(array, firstRow, endRow, readOptions)) {
        // 64-bit integers (Visium or Xenium pixel coordinates) through their words.
        scatterRows(asNumbers(values, label), 1, runs, result, firstRow);
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
        for await (const { values, runs } of readRowsInStoreOrder(array, firstRow, endRow, { ...readOptions, columns: [from, to] })) {
          const block = asNumbers(values, label);
          if (whole) {
            scatterRows(block, nColumns, runs, result, firstRow);
            continue;
          }
          if (runs.rows !== undefined) {
            // A row a value row (`readRowsInStoreOrder`).
            for (let row = 0; row < runs.rows.length; row++) {
              const at = (runs.rows[row] - firstRow) * nColumns;
              for (const [column, outputColumn] of picks) result[at + outputColumn] = block[row * blockWidth + column - from];
            }
            continue;
          }
          for (let r = 0; r < runs.count; r++) {
            const at = runs.starts[r] - firstRow - runs.offsets[r];
            for (const [column, outputColumn] of picks) {
              const offset = column - from;
              for (let row = runs.offsets[r]; row < runs.offsets[r + 1]; row++) {
                result[(at + row) * nColumns + outputColumn] = block[row * blockWidth + offset];
              }
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
   * The obs names of some open cells: the whole index when it is held,
   * else each cell's row of it. What names the cells an embedding or a
   * vector field leaves unplaced (`EmbeddingPayloads`). @private
   */
  async _cellNames(cells) {
    const held = this._cache.get('obs_names');
    if (held !== undefined) return cells.map(cell => held[cell]);
    return (await Promise.all(cells.map(cell => this.readObsNames({ rows: [cell, cell + 1] })))).map(names => names[0]);
  }

  /**
   * The cell-order digest of one embedding over the open cells
   * (`cell-order-digest.js`, `EmbeddingPayloads.cellOrderDigest`): its
   * stored values, each cell named by its original position, summed as
   * they were read. `signal` cancels what is read for it.
   *
   * @param {string} key
   * @param {ReadonlyArray<number>} columns
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<string>}
   */
  readCellOrderDigest(key, columns, { signal = null } = {}) {
    this._ensureOpen();
    const { width, label } = this._obsmArray(key);
    return this._payloads.cellOrderDigest(key, [...requireObsmColumnSelection(columns, width, label)], { signal });
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
   * @returns {Promise<{vectors: Float32Array, maxMagnitude: number, unplacedCount: number, unplacedNames: string[]}>}
   *   `unplacedCount`: cells without a vector, the first named
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
      await frame.load([column], readOptions);
      const flags = await readBooleanColumn(frame, column, this._format, label, index.length, readOptions);
      this._assertGeneration(generation, `reading ${label}`);
      return flags;
    });
  }

  /**
   * The obs names of the open cells, in their order: the obs index (a CSV or
   * `.h5ad` export names its cells by them). Listed `cells` read their own
   * rows of the index alone, in stored order; `rows` reads that range of the
   * index; with neither, the whole index is read once and kept (a held one
   * answers the others). Opening reads only its length.
   *
   * @returns {Promise<string[]>}
   */
  async readObsNames({ rows = null, cells = null } = {}) {
    this._ensureOpen();
    const range = this._rowRange(rows, 'obs names');
    const cacheKey = 'obs_names';
    if (cells !== null) {
      // Listed open cells (an export's, a batch at a time): their rows of
      // the index alone, read in the stored order (`gatheredArray`), so the
      // names of cells listed in another order than the file's (every cell
      // of a file opened in a subsample's order, listed by original
      // position) cost their own rows' chunks, once, never every name.
      const listed = requirePositions(cells, this._nObs, 'obs name');
      const held = this._cache.get(cacheKey);
      if (held !== undefined) return Array.from(listed, cell => held[cell]);
      if (listed.length === 0) return [];
      return this._track('names', `obs names of ${formatCountOf(listed.length, 'cell')}`, async readOptions => {
        const obs = this._root.get('obs');
        const { indexKey } = validateDataFrame(obs, this._format, `${this._format.file} obs`);
        const node = obs.get(indexKey);
        await readDataFrameIndex(node, this._format, 'Observation index', this._nObs, false, readOptions);
        const values = isGroup(node) ? node.get('values') : node;
        const gathered = gatheredArray(values, runsOfPositions(listed), { mergeGapBytes: () => this._mergeGapBytes(), chunks: this._decodedChunks });
        const raw = await readStored(gathered, 0, listed.length, 'Observation index', readOptions);
        return Array.from(raw, String);
      });
    }
    if (this._cache.has(cacheKey)) {
      const names = this._cache.get(cacheKey);
      return range === null ? names : names.slice(range.start, range.end);
    }
    if (range !== null) {
      // Rows `[start, end)` of the open cells (an export of a few cells),
      // read as that range of the index; only a whole read is kept.
      return this._track('names', `obs names, open cells ${formatCount(range.start)}–${formatCount(range.end)}`, async readOptions => {
        const obs = this._root.get('obs');
        const { indexKey } = validateDataFrame(obs, this._format, `${this._format.file} obs`);
        const node = obs.get(indexKey);
        // Checked as a whole read checks it (encoding, length, no missing name).
        await readDataFrameIndex(node, this._format, 'Observation index', this._nObs, false, readOptions);
        const raw = await readStored(isGroup(node) ? node.get('values') : node, range.start, range.end, 'Observation index', readOptions);
        return Array.from(raw, String);
      });
    }
    return this._track('names', 'obs names', async readOptions => {
      const obs = this._root.get('obs');
      const { indexKey } = validateDataFrame(obs, this._format, `${this._format.file} obs`);
      const index = await readDataFrameIndex(obs.get(indexKey), this._format, 'Observation index', this._nObs, true, readOptions);
      const names = Array.from(index.values, String);
      this._cache.set(cacheKey, names);
      return names;
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
      await frame.load([column], readOptions);
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
    // The open cells' view of a CSR matrix (`views/cell-subset.js`, its
    // `rowPointersPending`) has its shape before their row pointers are read
    // (`readRowPointers`), and describing it never makes its arrays: they
    // are its kept rows' entry runs in open order (a 50 % uniform share of
    // 5M cells: 2.5M runs, 140 MB), which a gene read in store order never
    // uses. The matrix as stored was checked when the file was opened.
    const openCellsView = isGroup(node) && typeof node.rowPointersPending === 'function';
    const shape = !isGroup(node)
      ? shapeOf(node, label, 2)
      : openCellsView ? shapeFromAttribute(attributeValue(node, 'shape'), label) : sparseContract(node, format, label).shape;
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
    await this._readyGeneRows(element);
    const matrix = this._requireMatrixElement(element);
    // A matrix whose index is built reads only the gene: nothing to weigh.
    // One indexed in segments (`prefix-column-index.js`) has what is left
    // to read after the segments built (an earlier opening's, carried), and
    // the gene shows on more cells after each segment.
    const segments = this._indexedInSegments(matrix) ? await this._segmentProgress(matrix) : null;
    // One indexed whole whose index is kept in this browser is built too.
    const keptWhole = segments === null && this._matrices.get(matrix.key)?.columns == null &&
      (await this._keptRunsOf(matrix, () => this._openRowPointers(matrix.node))).some(run => run.start === 0 && run.rows === matrix.nRows);
    // The open cells a gene is read for (the gene sample's, `genes`).
    const readTo = segments?.readTo ?? matrix.nRows;
    const sample = readTo < matrix.nRows ? { cells: readTo, of: matrix.nRows } : null;
    if (keptWhole || this._matrices.get(matrix.key)?.columns?.built?.() === true || (segments !== null && segments.done >= readTo)) {
      return { label: matrix.label, cells: readTo, sample, cellMajor: null, layout: null, entries: null, built: true, scan: null, index: null, progressive: null, bytesPerSecond: null };
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
    const cost = segments === null ? await costOf(matrix.node, readTo) : await costOf(segments.rest.matrix, segments.rest.rows);
    let progressive = null;
    if (segments !== null && (segments.done > 0 || segments.next < readTo)) {
      const first = segments.next === readTo ? cost : await costOf(rowRangeMatrix(segments.matrix, segments.done, segments.next, segments.pointers), segments.next - segments.done);
      progressive = { cells: readTo, done: segments.done, next: segments.next, nextStoredBytes: first.scan?.fetchBytes ?? first.scan?.storedBytes ?? null };
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
      // The open cells the first gene reads the rows of: the gene sample's
      // (`sample`, null when every open cell's are read).
      cells: readTo,
      sample,
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
   * The open cells genes are read for (`subsample-plan.js`, `genes`): the
   * first `cells` of the `of` open cells in priority order, and why no more
   * (`fit`: the first gene's time over the link, or its index's memory;
   * null once a person or a session chose the count); null when a gene is
   * read for every open cell. A gene of a matrix indexed in segments has a
   * value on those cells only (NaN on the others); a gene-major matrix's
   * genes are read for every open cell.
   *
   * @returns {Readonly<{cells: number, of: number, fit: Object|null}>|null}
   */
  get geneSample() {
    return this._cellSubset?.genes ?? null;
  }

  /**
   * The gene sample a gene of `element` is read for: `{cells, of}` when the
   * matrix is indexed in segments (read through a row index, the dataset's
   * own) and genes are read for fewer than every open cell; null when its
   * genes are read for every open cell (a gene-major matrix, a modality's,
   * or no sample).
   *
   * @param {string} element
   * @returns {Readonly<{cells: number, of: number}>|null}
   */
  geneSampleOf(element) {
    this._ensureOpen();
    const sample = this.geneSample;
    if (sample === null) return null;
    const matrix = this._requireMatrixElement(element);
    const cells = this._geneRows(matrix);
    return cells < matrix.nRows ? Object.freeze({ cells, of: matrix.nRows }) : null;
  }

  /**
   * What reading genes of `element` for the first `target` open cells costs
   * beyond the gene sample, before it is read: the first gene reads the rows
   * of open cells `[cells, target)` (`firstGeneReadCost`, the cost model the
   * sample was fitted by): the stored bytes it fetches (`bytes`; none of
   * what this browser keeps, `keptBytes`), its requests, and the time over
   * the link as measured (`ms`; null for a link not measured, as a local
   * file's before it is read); `index`: the memory its gene index then
   * holds and where it would be kept (`placement`: `memory`, `disk`, or
   * null with the `refusal`; then `fits`: the most open cells whose index
   * is kept here, else `target`). Null when there is no gene sample, or
   * `element` is not read for one.
   *
   * `geneTime` (the page's top-up, `DataState.topUpGeneSample`): the
   * sample's gene time (`ms`, its fit's `budgetMs`) and what it has
   * transferred and asked for in it so far (`spentBytes`, `spentRequests`).
   * A share's sample then never transfers more bytes, nor makes more
   * requests, than every cell's would in the same gene time
   * (`wholeSampleCost` at `ms` over the link as measured now, the rule its
   * first gene was fitted by): `target` is lowered to the most cells whose
   * read stays within both (`ceiling`: those bytes and requests, or null
   * for every cell of a file in its own order, which is the whole).
   * Without it, a scattered share's steps each fetch nearly every stored
   * chunk again (each step's cells lie in all of them), and a share's
   * steps in the file's cell order reach past every cell's blocks a
   * request for a few cells each.
   *
   * @param {string} element
   * @param {number} target - Open cells, more than the sample's
   * @param {{geneTime?: {ms: number, spentBytes: number, spentRequests?: number}|null}} [options]
   * @returns {Promise<{cells: number, target: number, bytes: number, keptBytes: number, requests: number, ms: number|null,
   *   index: {residentBytes: number, placement: string|null, refusal: string|null, fits: number},
   *   ceiling: {bytes: number, requests: number}|null}|null>}
   */
  async geneSampleCost(element, target, { geneTime = null } = {}) {
    this._ensureOpen();
    const sample = this.geneSample;
    if (sample === null) return null;
    await this._readyGeneRows(element);
    const matrix = this._requireMatrixElement(element);
    if (!this._indexedInSegments(matrix)) return null;
    let to = Math.min(matrix.nRows, Math.max(sample.cells, Math.floor(target)));
    const link = pricingLink(this._link?.snapshot?.() ?? null, this._hostLink ?? null);
    const valuesOnDemand = !this._readsAhead();
    const decodedChunkBytes = this._decodedChunkBytes ?? residencyBudgetBytes('decodedBlocks');
    const cost = await firstGeneReadCost(this._fullRoot, this._cellSubset.nObs, {
      valuesOnDemand,
      decodedChunkBytes,
      expression: matrix.key,
      // The gaps the byte reader fetches through between scattered rows.
      mergeGapBytes: link?.mergeGapBytes ?? 0,
    });
    // Every cell in a cell order reads its blocks as runs; any other opening its open cells' rows.
    const whole = this._cellSubset.kept === null;
    const rowsOf = prefixRowsOf(this._cellSubset.fileRows ?? null, this._cellSubset.nObs, whole ? this._cellSubset.cellOrder ?? null : null, this._subsampleCache ?? undefined);
    const readTo = end => (cost === null ? { bytes: 0, requests: 0, keptBytes: 0 } : cost(rowsOf(end, sample.cells)));
    let read = readTo(to);
    let ceiling = null;
    const subset = this._cellSubset;
    if (geneTime !== null && geneTime.ms > 0 && cost !== null && !(subset.kept === null && subset.prioritySeed == null)) {
      ceiling = await wholeSampleCost(this._fullRoot, subset.nObs, subset.prioritySeed == null ? null : { seed: subset.prioritySeed }, {
        link,
        targetMs: geneTime.ms,
        valuesOnDemand,
        decodedChunkBytes,
        expression: matrix.key,
        seedBytesPerMs: Math.max(this._hostLink?.downlinkBytesPerMs ?? 0, this._hostLink?.bytesPerMs ?? 0) || null,
        subsampleCache: this._subsampleCache ?? undefined,
      });
      if (!Number.isFinite(ceiling.bytes) && !Number.isFinite(ceiling.requests)) ceiling = null;
      const allowedBytes = ceiling === null ? Infinity : ceiling.bytes - geneTime.spentBytes;
      const allowedRequests = ceiling === null ? Infinity : ceiling.requests - (geneTime.spentRequests ?? 0);
      const within = priced => priced.bytes <= allowedBytes && priced.requests <= allowedRequests;
      if (!within(read)) {
        // The most cells whose read stays within it (bytes and requests grow with the cells).
        let low = sample.cells;
        let high = to - 1;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (within(readTo(mid))) low = mid;
          else high = mid - 1;
        }
        to = low;
        read = readTo(to);
      }
    }
    // The index of the cells past the sample holds their entries: their
    // rows' pointers are not read for a price (every open row's would be
    // the whole `indptr` of a file opened whole), so they are taken at the
    // sample's entries a row (a sample of the open cells: priority order).
    const { pointers } = await this._openRowsMatrix(matrix, sample.cells);
    const entriesPerCell = pointers === null || sample.cells === 0 ? 0 : pointers[sample.cells] / sample.cells;
    const indexBytesTo = end => columnIndexResidentBytes({
      layout: isGroup(matrix.node) ? 'sparse' : 'dense',
      nnz: Math.round((end - sample.cells) * entriesPerCell),
      nObs: end - sample.cells,
      nVars: matrix.sourceVars,
      valuesOnDemand: !this._readsAhead(),
      // The stored `data`: a view's own is made only once every open row's pointers are read.
      valuesBought: !this._readsAhead() && isGroup(matrix.node) && readInWholeChunks(matrix.node.storedData?.() ?? matrix.node.get('data')),
    });
    const residentBytes = indexBytesTo(to);
    const placed = await this.columnStoreFactory.plan(residentBytes);
    // The gene index of every cell asked for fits neither the memory nor
    // this site's storage (`refusal`): the most open cells whose index does
    // (`fits`, the sample's own count when no more do).
    let fits = to;
    if ((placed.refusal ?? null) !== null) {
      let low = sample.cells;
      let high = to - 1;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (((await this.columnStoreFactory.plan(indexBytesTo(mid))).refusal ?? null) === null) low = mid;
        else high = mid - 1;
      }
      fits = low;
    }
    return {
      cells: sample.cells,
      target: to,
      bytes: read.bytes,
      keptBytes: read.keptBytes,
      requests: read.requests,
      ms: linkPriced(link) && read.bytes > 0 ? geneReadMs(read, link) : (read.bytes === 0 ? 0 : null),
      index: { residentBytes, placement: placed.kind, refusal: placed.refusal ?? null, fits },
      ceiling,
    };
  }

  /**
   * What reading the rows of `cells` (open positions) of a matrix costs
   * now, before it is read (`readMatrixRows`, a cell export): the stored
   * chunks of its pointers, indices and values the cells' file rows lie in
   * and the requests and dependent steps they make, as the first gene of
   * the gene sample is priced (`firstGeneReadCost`, from the layout alone:
   * no request), and the time over the link as measured (`geneReadMs`; null
   * before it is measured). What this browser keeps of the file costs
   * nothing. Null for a matrix read by gene (CSC, `geneLayoutOf`) or a
   * modality's: a row read of it is not priced this way.
   *
   * @param {string} element
   * @param {ArrayLike<number>} cells
   * @returns {Promise<{cells: number, bytes: number, keptBytes: number, requests: number, ms: number|null}|null>}
   */
  async matrixRowsCost(element, cells) {
    this._ensureOpen();
    const matrix = this._requireMatrixElement(element);
    if (matrix.key.startsWith('mod/') || matrix.start !== 0) return null;
    const nFile = this._cellSubset?.nObs ?? this._nObs;
    const fileRows = this._cellSubset?.fileRows ?? null;
    const rows = allocateTypedArray(Float64Array, cells?.length ?? 0, 'Cells priced');
    for (let i = 0; i < rows.length; i++) {
      const cell = cells[i];
      if (!Number.isSafeInteger(cell) || cell < 0 || cell >= this._nObs) throw new RangeError(`${matrix.label} cell row ${String(cell)} is outside [0, ${this._nObs})`);
      rows[i] = fileRows === null ? cell : fileRows[cell];
    }
    rows.sort();
    const link = pricingLink(this._link?.snapshot?.() ?? null, this._hostLink ?? null);
    const cost = await firstGeneReadCost(this._fullRoot ?? this._root, nFile, {
      // Every value of a read row is handed out: its values are read with its indices.
      valuesOnDemand: false,
      decodedChunkBytes: this._decodedChunkBytes ?? residencyBudgetBytes('decodedBlocks'),
      expression: matrix.key,
      mergeGapBytes: link?.mergeGapBytes ?? 0,
    });
    if (cost === null) return null;
    const read = cost(rows);
    const priced = read.bytes > 0 && linkPriced(link);
    return {
      cells: rows.length,
      bytes: read.bytes,
      keptBytes: read.keptBytes,
      requests: read.requests,
      ms: read.bytes === 0 ? 0 : priced ? geneReadMs(read, link) : null,
      // What binds: the link's time, or decoding the chunks the rows lie in.
      linkMs: priced ? linkReadMs(read, link) : null,
      decodedBytes: read.decodedBytes,
    };
  }

  /**
   * Read genes for the first `target` open cells (a person's "Read for all
   * cells"): the segments of `element` after the gene sample, doubling as
   * the first ones did (`prefix-column-index.js`), each built by reading
   * gene `gene` on it (its index pass reads the rows of its cells once; every
   * later gene reads the index). After each segment the sample is that much
   * larger (`onStep(sample, cells)`): what is built stays when `signal`
   * stops the rest. Every other matrix open in segments reads genes for the
   * same cells: its new segments are built when one of its genes is read.
   * Resolves to the gene sample now (null: every open cell's). A person's
   * count has no fit; one grown to fill the gene time (`topUp`, the page's
   * `DataState.topUpGeneSample`) keeps the fit that sized it, so the same
   * cells opened again after a share change take it again
   * (`_geneSamplesSeen`).
   *
   * @param {string} element
   * @param {number} target
   * @param {{signal?: AbortSignal|null, gene?: number, onStep?: ((sample: Object|null, cells: number) => void)|null, topUp?: boolean}} [options]
   * @returns {Promise<Readonly<{cells: number, of: number, fit: Object|null}>|null>}
   */
  async growGeneSample(element, target, { signal = null, gene = 0, onStep = null, topUp = false } = {}) {
    this._ensureOpen();
    const generation = this._generation;
    const sample = this.geneSample;
    if (sample === null) return null;
    const ready = this._readyGeneRows(element, { signal });
    if (ready !== null) {
      await ready;
      this._assertGeneration(generation, `reading ${element}`);
    }
    const matrix = this._requireMatrixElement(element);
    if (!this._indexedInSegments(matrix)) throw new Error(`Genes of ${matrix.label} are read for every open cell`);
    if (!Number.isSafeInteger(gene) || gene < 0 || gene >= matrix.nVars) throw new RangeError(`${matrix.label} has no gene column ${String(gene)}`);
    // Never past the rows the store holds (`held`): the reader worker reads
    // more of the matrix first (`matrixStream`).
    const to = Math.min(matrix.nRows, this.heldOpenCells(), Math.max(sample.cells, Math.floor(target)));
    if (to <= sample.cells) return sample;
    return this._track('genes', `${matrix.label} for ${formatCountOf(to, 'open cell')} (genes read for ${formatCountOf(sample.cells, 'cell')} so far)`, async readOptions => {
      const columns = await this._matrixColumns(matrix, generation, readOptions);
      let cells = columns.readRows();
      const added = await columns.growTo(to, readOptions);
      // Withdrawn (a gene asked for on the page stops a top-up's step): the
      // unbuilt segments go at once, before any read after it sees them, so
      // a gene read next never waits for their index passes.
      const withdraw = () => {
        if (this._generation === generation) columns.trimTo(cells);
      };
      const stopWithdrawing = onAbort(readOptions.signal, withdraw);
      try {
        for (const segment of added) {
          // Its index pass, stopped with the read when `signal` withdraws it.
          await segment.access.sparseColumn(matrix.start + gene, { signal: readOptions.signal ?? null });
          this._assertGeneration(generation, `reading ${matrix.label} for more cells`);
          cells = segment.start + segment.rows;
          await this._setGeneRows(cells, matrix.key, topUp ? sample.fit : null);
          onStep?.(this.geneSample, cells);
        }
      } catch (error) {
        withdraw();
        throw error;
      } finally {
        stopWithdrawing();
      }
      return this.geneSample;
    }, signal);
  }

  /**
   * How many open cells, from the first, have their matrix rows in the store:
   * every one, unless the store holds only rows `[0, held.rows)` (a matrix
   * read after its map: `open`'s `held`).
   *
   * @returns {number}
   */
  heldOpenCells() {
    this._ensureOpen();
    const subset = this._cellSubset;
    const nOpen = subset.kept === null ? subset.nObs : subset.kept.length;
    return this._held === null || this._held === undefined ? nOpen : heldPrefix(subset.fileRows ?? null, nOpen, this._held.rows);
  }

  /**
   * The store rows the first `count` open cells lie in, as a prefix: one
   * past the highest of their rows (`count` where open cell `i` is row `i`):
   * what a matrix read after its map keeps for them (`held`).
   *
   * @param {number} count
   * @returns {number}
   */
  rowsForOpenCells(count) {
    this._ensureOpen();
    const subset = this._cellSubset;
    const nOpen = subset.kept === null ? subset.nObs : subset.kept.length;
    return prefixEndRow(subset.fileRows ?? null, Math.max(0, Math.min(nOpen, Math.floor(count))));
  }

  /**
   * The store rows a matrix read after its map keeps for this opening
   * (`held`): those its first `fitCells` open cells lie in or, for a
   * progressive opening, those of the first `fitCells` cells it grows to
   * (`growth`), so the one pass over the matrix serves its every step
   * (`anndata-reader-worker.js` `ensureMatrixShare`). A pass keeps the
   * rows of its cells only, but reads the stream to the last of them --
   * nearly all of it for cells spread over the file -- whatever their
   * count, so a pass a step read the whole matrix again.
   *
   * @param {number} fitCells - The share sized to this device (`shareFit`)
   * @returns {number}
   */
  shareRows(fitCells) {
    return Math.max(this.rowsForOpenCells(fitCells), this._grownShareRows ?? 0);
  }

  /**
   * Rows `[0, heldRows)` of the store hold their matrix rows: every row,
   * unless the store is a matrix read after its map (`open`'s `held`).
   *
   * @returns {number}
   */
  get heldRows() {
    this._ensureOpen();
    return this._held?.rows ?? this._cellSubset.nObs;
  }

  /**
   * The gene sample is now the first `cells` open cells (`growGeneSample`;
   * `fit` the one that sized it when the gene time grew it, null for a
   * person's count): every other matrix open in segments reads genes for
   * them too (its new segments built when one of its genes is read). @private
   */
  async _setGeneRows(cells, grown, fit = null) {
    const subset = this._cellSubset;
    const of = subset.genes?.of ?? this._nObs;
    this._cellSubset = { ...subset, genes: cells >= of ? null : Object.freeze({ cells, of, fit }) };
    for (const [element, state] of this._matrices) {
      if (element !== grown && typeof state.columns?.growTo === 'function') await state.columns.growTo(cells);
    }
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
    const ready = this._readyGeneRows(element, { signal });
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
    const ready = this._readyGeneRows(element, { signal });
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
      // Rows past the gene sample are not read: no value, never a zero.
      const read = columns.readRows();
      if (end > read) out.fill(Number.NaN, Math.max(0, read - start));
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
   * Whether reading rows `[0, end)` of a gene (`_sparseColumnRows`) reads
   * fewer of its rows than its whole column: the segments those rows lie in
   * end before the last one (`columns.segments`), or a priority-ordered
   * file's prefix counts bound them below every row (the smallest level
   * holding `end`). Otherwise the rows read are the column's, and a read
   * of them is no cheaper than the gene's column. @private
   */
  _readsFewerColumnRows(matrix, columns, end) {
    if (!this._readsColumnRows(matrix, columns)) return false;
    if (Array.isArray(columns.segments)) {
      const last = columns.segments.at(-1);
      return last !== undefined && end <= last.start;
    }
    const levels = this._cellSubset.levels;
    const above = levels.findIndex(size => size >= end);
    return above >= 0 && levels[above] < this._nObs;
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
    const ready = this._readyGeneRows(element, { signal });
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
   * The non-zero genes of cells (rows) of one matrix, in the order asked,
   * all at once: `readMatrixRows`'s parts gathered, each row a view of its
   * part.
   *
   * @param {string} element
   * @param {ReadonlyArray<number>} cells
   * @param {{signal?: AbortSignal|null}} [options] - `signal` cancels the read
   * @returns {Promise<Array<{genes: Int32Array, values: Float32Array}>>}
   */
  async getMatrixRows(element, cells, { signal = null } = {}) {
    const rows = new Array(cells.length);
    await this.readMatrixRows(element, cells, {
      signal,
      onPart: ({ first, count, pointers, genes, values }) => {
        for (let i = 0; i < count; i++) {
          rows[first + i] = { genes: genes.subarray(pointers[i], pointers[i + 1]), values: values.subarray(pointers[i], pointers[i + 1]) };
        }
      },
    });
    return rows;
  }

  /**
   * The non-zero genes of many cells (rows) of one matrix, in the order
   * asked, handed out part by part as a compressed sparse row block: what a
   * cell export writes (`app/exports/cell-exports.js`). One read for every
   * cell, so its rows' pointers are read once, in one plan, and the link
   * is never left idle between parts: each part is asked for before the
   * one before it is handed out, and every read of a part goes through the
   * stored-order reads of the matrix (a view's rows in waves in the stored
   * order, `views/cell-subset.js`; nearby rows of a file in its own order as
   * one range; a dense matrix's strips decoded once), so the byte reader
   * plans the next part's requests while this part's arrive. A part is
   * about a slab of entries (`SLAB_BYTES`), so a read of any number of
   * cells holds two parts at a time, never every cell's rows.
   *
   * `onPart({first, count, pointers, genes, values})`: cells
   * `[first, first + count)` of `cells`, cell `first + i` holding entries
   * `[pointers[i], pointers[i + 1])` of `genes` (ascending in each row,
   * duplicates summed) and `values`. Resolves with the cells and entries
   * handed out.
   *
   * @param {string} element
   * @param {ReadonlyArray<number>} cells
   * @param {{signal?: AbortSignal|null, partEntries?: number, onPart: (part: {first: number, count: number, pointers: Float64Array, genes: Int32Array, values: Float32Array}) => void}} options -
   *   `partEntries`: the entries a part holds, about (by default as many as
   *   a slab holds decoded and handed out)
   * @returns {Promise<{cells: number, entries: number}>}
   */
  async readMatrixRows(element, cells, { signal = null, partEntries = null, onPart }) {
    this._ensureOpen();
    if (typeof onPart !== 'function') throw new TypeError('readMatrixRows hands its parts to onPart.');
    const generation = this._generation;
    const named = this._namedRows(element, cells);
    const ready = this._readyRows(element, { signal }, named);
    if (ready !== null) {
      await ready;
      this._assertGeneration(generation, `reading ${element}`);
    }
    const matrix = this._requireMatrixElement(element);
    const { label } = matrix;
    // Checked into one typed array: an export may name millions of cells.
    const positions = allocateTypedArray(Uint32Array, cells?.length ?? 0, 'Cells read');
    for (let i = 0; i < positions.length; i++) {
      const cell = cells[i];
      if (!Number.isSafeInteger(cell) || cell < 0 || cell >= this._nObs) throw new RangeError(`${label} cell row ${String(cell)} is outside [0, ${this._nObs})`);
      positions[i] = cell;
    }
    // A gene-major matrix lists a row's entries in every gene: its rows are
    // read as the cells' entries of every gene (`_rowsByGenes`), never
    // through an index of every stored row.
    if (isGroup(matrix.node) && encodingType(matrix.node) === 'csc_matrix') {
      return this._rowsByGenes(element, matrix, positions, { signal, partEntries, onPart, generation });
    }
    const access = named === null ? await this._matrixRows(matrix, signal) : await this._rowsOfCells(matrix, named);
    return this._track('cells', `${formatCountOf(positions.length, 'cell')} of ${label}`, async readOptions => {
      const map = await this._cellsOf(matrix, readOptions);
      // Each asked cell's row to read (the named cells' own rows 0, 1, …;
      // else its open row), or -1: a cell the modality did not measure.
      const rowOf = allocateTypedArray(Float64Array, positions.length, 'Cell rows');
      for (let i = 0; i < positions.length; i++) {
        const cell = positions[i];
        rowOf[i] = map !== null && map[cell] < 0 ? -1 : named !== null ? i : (map === null ? cell : map[cell]);
      }
      // Parts of about `partEntries` entries: by default a slab
      // (`SLAB_BYTES`) of entries decoded and handed out (a gene index and a
      // value each, 8 bytes), so the two parts read at once hold about two
      // slabs, whatever the cells.
      const entriesOf = row => (row < 0 ? 0 : typeof access.entries === 'function' ? access.entries(row) : matrix.sourceVars);
      const perPart = partEntries ?? Math.max(1, Math.floor(SLAB_BYTES / ((access.entryBytes ?? 4) + 8)));
      const bounds = [];
      for (let first = 0; first < positions.length;) {
        let last = first;
        let entries = 0;
        while (last < positions.length && (last === first || entries + entriesOf(rowOf[last]) <= perPart)) entries += entriesOf(rowOf[last++]);
        bounds.push([first, last]);
        first = last;
      }
      const readPart = ([first, last]) => {
        const rows = [];
        for (let i = first; i < last; i++) if (rowOf[i] >= 0) rows.push(rowOf[i]);
        const read = access.rows !== undefined
          ? access.rows(rows, readOptions)
          : Promise.all(rows.map(row => access.row(row, readOptions)));
        read.catch(() => {});
        return read;
      };
      let handed = 0;
      let next = bounds.length > 0 ? readPart(bounds[0]) : null;
      for (let p = 0; p < bounds.length; p++) {
        const current = next;
        next = p + 1 < bounds.length ? readPart(bounds[p + 1]) : null;
        const read = await current;
        this._assertGeneration(generation, `loading ${positions.length} cell rows of ${label}`);
        const [first, last] = bounds[p];
        const windowed = [];
        let total = 0;
        let r = 0;
        for (let i = first; i < last; i++) {
          const row = rowOf[i] < 0 ? null : windowRow(read[r++], matrix.start, matrix.nVars, matrix.sourceVars);
          windowed.push(row);
          total += row === null ? 0 : row.genes.length;
        }
        const pointers = allocateTypedArray(Float64Array, last - first + 1, 'Cell row pointers');
        const genes = allocateTypedArray(Int32Array, total, 'Cell row genes');
        const values = allocateTypedArray(Float32Array, total, 'Cell row values');
        windowed.forEach((row, i) => {
          const at = pointers[i];
          if (row !== null) {
            genes.set(row.genes, at);
            values.set(row.values, at);
          }
          pointers[i + 1] = at + (row === null ? 0 : row.genes.length);
        });
        handed += total;
        onPart({ first, count: last - first, pointers, genes, values });
      }
      return { cells: positions.length, entries: handed };
    }, signal);
  }

  /**
   * `readMatrixRows` of a gene-major (CSC) matrix: the cells' entries of
   * every gene, read as a cell subset is (`getMatrixCellSubset`, its
   * activity of kind `cells`) -- a priority-ordered file opened as a prefix
   * reads each gene's prefix alone (its counted entries, one stored chunk a
   * gene and array at a 1 % share), any other matrix each gene's entries,
   * keeping the cells' -- in runs of consecutive genes of about a slab of
   * stored entries (`SLAB_BYTES`, 8 bytes an entry), two runs read at once;
   * then made rows (genes ascending) and handed out in parts of about
   * `partEntries` entries, in the order asked. What it holds is the cells'
   * entries, the rows it hands out, and a run's reads, never an index of
   * every stored row: through one, 2,000 cells of a 1 % share of a 10M-cell
   * priority-ordered file decoded every chunk of X (244 MB, 1.9 GB peak).
   * A cell named twice is handed out twice; one a modality did not measure
   * has no entries. @private
   */
  async _rowsByGenes(element, matrix, positions, { signal, partEntries, onPart, generation }) {
    const { label, nVars } = matrix;
    // The distinct cells, ascending: what the subset reads.
    const cells = positions.slice().sort();
    let distinct = 0;
    for (let i = 0; i < cells.length; i++) if (i === 0 || cells[i] !== cells[i - 1]) cells[distinct++] = cells[i];
    const asked = cells.subarray(0, distinct);
    // Runs of consecutive genes, each about a slab of stored entries.
    const runs = [];
    if (distinct > 0 && nVars > 0) {
      const columns = await this._matrixColumns(matrix, generation, { signal });
      const budget = Math.max(1, Math.floor(SLAB_BYTES / 8));
      for (let first = 0; first < nVars;) {
        let last = first;
        let entries = 0;
        while (last < nVars && (last === first || entries + columns.entryCount(matrix.start + last) <= budget)) entries += columns.entryCount(matrix.start + last++);
        runs.push([first, last]);
        first = last;
      }
    }
    const readRun = ([first, last]) => {
      const genes = allocateTypedArray(Uint32Array, last - first, 'Genes read');
      for (let g = 0; g < genes.length; g++) genes[g] = first + g;
      const read = this.getMatrixCellSubset(element, asked, genes, { signal, kind: 'cells' });
      read.catch(() => {});
      return read;
    };
    const blocks = [];
    let next = runs.length > 0 ? readRun(runs[0]) : null;
    for (let r = 0; r < runs.length; r++) {
      const current = next;
      next = r + 1 < runs.length ? readRun(runs[r + 1]) : null;
      blocks.push(await current);
      this._assertGeneration(generation, `loading ${positions.length} cell rows of ${label}`);
    }
    // Each distinct cell's row (`starts[c]` to `starts[c + 1]`), genes ascending.
    let total = 0;
    for (const block of blocks) total += block.cellIndex.length;
    const starts = allocateTypedArray(Float64Array, distinct + 1, 'Cell row pointers');
    for (const block of blocks) for (let k = 0; k < block.cellIndex.length; k++) starts[block.cellIndex[k] + 1]++;
    for (let c = 0; c < distinct; c++) starts[c + 1] += starts[c];
    const rowGenes = allocateTypedArray(Int32Array, total, 'Cell row genes');
    const rowValues = allocateTypedArray(Float32Array, total, 'Cell row values');
    const cursor = starts.slice(0, distinct);
    blocks.forEach((block, b) => {
      const [first, last] = runs[b];
      for (let g = 0; g < last - first; g++) {
        for (let k = block.pointers[g]; k < block.pointers[g + 1]; k++) {
          const at = cursor[block.cellIndex[k]]++;
          rowGenes[at] = first + g;
          rowValues[at] = block.values[k];
        }
      }
      blocks[b] = null;
    });
    // Each asked cell's distinct row.
    const rowOf = allocateTypedArray(Uint32Array, positions.length, 'Cell rows');
    for (let i = 0; i < positions.length; i++) {
      let lo = 0;
      let hi = distinct - 1;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (cells[mid] < positions[i]) lo = mid + 1;
        else hi = mid;
      }
      rowOf[i] = lo;
    }
    // Parts of about `partEntries` entries (by default a slab of them handed
    // out, a gene index and a value each), each in arrays of its own: a part
    // crosses to the page with its buffers.
    const perPart = partEntries ?? Math.max(1, Math.floor(SLAB_BYTES / 8));
    const entriesOf = i => starts[rowOf[i] + 1] - starts[rowOf[i]];
    let handed = 0;
    for (let first = 0; first < positions.length;) {
      let last = first;
      let entries = 0;
      while (last < positions.length && (last === first || entries + entriesOf(last) <= perPart)) entries += entriesOf(last++);
      const pointers = allocateTypedArray(Float64Array, last - first + 1, 'Cell row pointers');
      const partGenes = allocateTypedArray(Int32Array, entries, 'Cell row genes');
      const partValues = allocateTypedArray(Float32Array, entries, 'Cell row values');
      for (let i = first; i < last; i++) {
        const from = starts[rowOf[i]];
        const to = starts[rowOf[i] + 1];
        const at = pointers[i - first];
        partGenes.set(rowGenes.subarray(from, to), at);
        partValues.set(rowValues.subarray(from, to), at);
        pointers[i - first + 1] = at + to - from;
      }
      handed += entries;
      onPart({ first, count: last - first, pointers, genes: partGenes, values: partValues });
      first = last;
    }
    return { cells: positions.length, entries: handed };
  }

  /**
   * The open cells a read by row names, as view rows, when the store is a
   * view of the open cells (`rowsMatrix`) and they are fewer than every open
   * cell of a dataset's own CSR matrix: then only their rows' pointers are
   * read, and their rows as a matrix of their own (`_rowsOfCells`); null
   * for any other read (every open row's, as `_matrixRows` reads them).
   * Cell exports and cells past a gene sample read a few rows of a view of
   * millions: never every open row's pointers for them. @private
   */
  _namedRows(element, cells) {
    if (typeof this._root?.rowsMatrix !== 'function' || this._cellSubset?.fileRows == null) return null;
    let matrix;
    try {
      matrix = this._requireMatrixElement(element);
    } catch {
      return null;
    }
    if (!isGroup(matrix.node) || matrix.cells !== null || matrix.key.startsWith('mod/') || matrix.start !== 0) return null;
    if (typeof cells?.length !== 'number' || cells.length >= matrix.nRows) return null;
    const rows = allocateTypedArray(Uint32Array, cells.length, 'Cells read');
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      if (!Number.isSafeInteger(cell) || cell < 0 || cell >= matrix.nRows) return null;
      rows[i] = cell;
    }
    return rows;
  }

  /** Row access to the named open cells' rows alone (`_namedRows`), their pointers read. @private */
  _rowsOfCells(matrix, named) {
    return openMatrixRows(this._root.rowsMatrix(matrix.key, named), {
      format: this._format,
      label: matrix.label,
      nObs: named.length,
      nVars: matrix.sourceVars,
      indexOptions: this._indexOptions(),
      inFlightEntries: this._inFlightEntries(),
    });
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
        inFlightEntries: this._inFlightEntries(),
      });
      rows.catch(() => {});
      this._rows = { element: key, rows };
    }
    const state = this._rows;
    try {
      return await awaitWithSignal(state.rows, signal);
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
   * A read that is one of a run's (`runGenes`: the genes the run has still
   * to read of these cells, this read's included -- a DE over every gene
   * reads them in batches) is priced over the run's reads: the gene index's
   * build once, not once a read (`cellSubsetRunCosts`); and every gene of
   * the cells read once by their rows and kept (`_keptCellSubset`), when
   * that costs the run less than the index and fits. One comparison decides
   * the route: a run never decodes the cells' rows again a read when either
   * is cheaper (a 10M-cell CSR file, 30,000 genes: 470 reads of ~130 MB).
   *
   * @param {string} element
   * @param {ReadonlyArray<number>} cells - Distinct cell positions
   * @param {ReadonlyArray<number>} genes - Distinct gene positions
   * @param {{signal?: AbortSignal|null, owner?: string|null, runGenes?: number|null, kind?: string}} [options] -
   *   An analysis's read (kind `analysis`) for the job `owner`; `runGenes`
   *   as above (null: a read on its own); `kind`: the activity's kind when
   *   the read is another's (`cells`: a cell export's rows of a gene-major
   *   matrix, `readMatrixRows`)
   * @returns {Promise<{pointers: Float64Array, cellIndex: Int32Array, values: Float32Array}>}
   */
  async getMatrixCellSubset(element, cells, genes, { signal = null, owner = null, runGenes = null, kind = 'analysis' } = {}) {
    this._ensureOpen();
    const generation = this._generation;
    if (runGenes !== null && !(Number.isSafeInteger(runGenes) && runGenes >= (genes?.length ?? 0))) {
      throw new RangeError(`A cell subset read's run genes count its own genes and those after them, not ${String(runGenes)}`);
    }
    // Cells all among the gene sample's are read through its segments, from
    // the sample's row pointers; any other cell by its row, from every open
    // row's (`_matrixRows`).
    const sampleRows = this._geneReadRows(element);
    // The run's cells checked by an earlier read (`_checkedCells`): compared,
    // never walked again.
    let checked = this._sameCheckedCells(cells);
    // Every gene of these cells kept by an earlier read of the run
    // (`_keptCellSubset`): a copy, nothing else asked. Cells past a gene
    // sample otherwise asked for their rows' pointers, a row view of them
    // made and its coverage walked again each read (10M CSR, two groups of
    // 2M cells: 0.6 s a read, 470 reads).
    const held = checked === null ? null : this._heldCellSubset(element, checked.cells, generation);
    if (held !== null) {
      const { label, nVars } = this._requireMatrixElement(element);
      const genePositions = requirePositions(genes, nVars, `${label} gene column`);
      if (new Set(genePositions).size !== genePositions.length) {
        throw new RangeError(`A cell subset of ${label} names a gene more than once`);
      }
      return this._track(kind, `${formatCountOf(genePositions.length, 'gene')} in ${formatCountOf(checked.cells.length, 'cell')} of ${label}`,
        async () => genesOfCellSubset(held, genePositions), signal, owner);
    }
    let withinSample = sampleRows !== null && typeof cells?.length === 'number';
    if (checked !== null) withinSample &&= checked.last < sampleRows;
    else for (let k = 0; withinSample && k < cells.length; k++) withinSample = cells[k] < sampleRows;
    // Cells past the sample are read by their own rows: only theirs (`_namedRows`).
    const named = sampleRows !== null && !withinSample ? this._namedRows(element, cells) : null;
    const ready = this._readyRows(element, { signal }, withinSample ? sampleRows : named);
    if (ready !== null) {
      await ready;
      this._assertGeneration(generation, `reading ${element}`);
    }
    const matrix = this._requireMatrixElement(element);
    const { node, label, nVars } = matrix;
    checked ??= this._checkedCells(cells, label);
    const cellPositions = checked.cells;
    const genePositions = requirePositions(genes, nVars, `${label} gene column`);
    if (new Set(genePositions).size !== genePositions.length) {
      throw new RangeError(`A cell subset of ${label} names a gene more than once`);
    }
    // The reads the run makes of these cells at this read's size, this one included.
    const batches = runGenes === null ? 1 : Math.ceil(runGenes / Math.max(1, genePositions.length));
    // From the encoding, not the arrays: a view's are made only once every open row's pointers are read.
    const byCell = !isGroup(node) || encodingType(node) === 'csr_matrix';
    // Genes are read for the gene sample's cells only (`genes`): its index
    // holds no entry of a cell past it, and a read through it would answer
    // that cell's absence as a zero. Such cells are read by their rows (a
    // matrix indexed in segments is read through a row index, so it has
    // rows to read): their own values, at their rows' cost. The app's
    // analyses ask for the sample's cells alone (they say so); a caller
    // that names others gets their values, never zeros.
    const readTo = this._geneRows(matrix);
    const pastSample = readTo < matrix.nRows && checked.last >= readTo;
    // A store holding the matrix rows of its first rows only (`held`): a
    // cell past them has no row to read yet (its row reads as empty, never
    // its values).
    if (pastSample && this._held != null && !element.startsWith('mod/')) {
      const held = this.heldOpenCells();
      if (cellPositions.some(cell => cell >= held)) {
        throw new RangeError(`${label} is read after its cells (a MatrixMarket matrix): it holds genes for the first ${formatCountOf(held, 'open cell')} so far`);
      }
    }
    if (pastSample && !byCell) {
      throw new RangeError(`Genes of ${label} are read for the first ${formatCountOf(readTo, 'open cell')} only (the gene sample), and its cells cannot be read by row`);
    }
    return this._track(kind, `${formatCountOf(genePositions.length, 'gene')} in ${formatCountOf(cellPositions.length, 'cell')} of ${label}`, async readOptions => {
      if (pastSample) {
        const rows = named === null ? await this._matrixRows(matrix, readOptions.signal) : await this._rowsOfCells(matrix, named);
        // The named cells' own rows are rows 0, 1, … of their matrix.
        const rowCells = named === null ? cellPositions : Array.from(cellPositions, (_, i) => i);
        if (typeof rows.subset !== 'function') {
          throw new RangeError(`Genes of ${label} are read for the first ${formatCountOf(readTo, 'open cell')} only (the gene sample), and its cells cannot be read by row`);
        }
        // Read by their rows whatever: a run of more reads reads them once, kept.
        const kept = await this._keptCellSubset(element, matrix, rows, cellPositions, generation, readOptions, rowCells, batches > 1);
        if (kept !== null) return genesOfCellSubset(kept, genePositions);
        const block = await rows.subset(rowCells, genePositions.map(gene => matrix.start + gene), readOptions);
        this._assertGeneration(generation, `loading ${formatCountOf(genePositions.length, 'gene')} in ${formatCountOf(cellPositions.length, 'cell')} of ${label}`);
        return block;
      }
      // Cells that all lie among the first open cells -- an analysis's
      // first pass on a sample of them (`progressive-cells.js`) -- are read
      // from those rows of each gene only, where the layout can read fewer
      // rows than the gene's (`_readsFewerColumnRows`): each gene's entries
      // there, never a column of every row. Cells reaching the last of them
      // gain nothing there and are read by the run's priced route below
      // (rows, index, or the cells' rows kept): every cell's groups on a
      // share raised back read the last segment too, and through this read
      // paid every gene's whole column a read, all genes of a read at once.
      const prefixEnd = checked.last + 1;
      if (prefixEnd < this._nObs) {
        const columns = await this._matrixColumns(matrix, generation, readOptions);
        if (this._readsFewerColumnRows(matrix, columns, prefixEnd)) {
          const parts = await Promise.all(genePositions.map(gene => this._sparseColumnRows(matrix, columns, matrix.start + gene, { start: 0, end: prefixEnd }, readOptions)));
          this._assertGeneration(generation, `loading ${formatCountOf(genePositions.length, 'gene')} in ${formatCountOf(cellPositions.length, 'cell')} of ${label}`);
          return cellSubsetOfSparseColumns(parts, cellPositions);
        }
      }
      // Rows only where every open row's pointers are read (no gene sample:
      // `_readyRows` above): cells among a sample's rows are read by its
      // columns, from the sample's pointers alone.
      const [columns, rows, map] = await Promise.all([
        this._matrixColumns(matrix, generation, readOptions),
        byCell && sampleRows === null ? this._matrixRows(matrix, readOptions.signal) : null,
        this._cellsOf(matrix, readOptions),
      ]);
      // A modality reads the cells it measured, at its own rows.
      let measured = null;
      if (map !== null) {
        measured = [];
        for (let position = 0; position < cellPositions.length; position++) {
          if (map[cellPositions[position]] >= 0) measured.push(position);
        }
      }
      // The run's genes of these cells already kept: a copy, nothing priced.
      if (measured === null) {
        const held = await this._keptCellSubset(element, matrix, rows, cellPositions, generation, readOptions, cellPositions, false);
        if (held !== null) return genesOfCellSubset(held, genePositions);
      }
      const subsetCells = measured === null ? cellPositions : measured.map(position => map[cellPositions[position]]);
      const storedGenes = genePositions.map(gene => matrix.start + gene);
      const costs = cellSubsetRunCosts(columns, rows, subsetCells, storedGenes, batches, this._rowsCostOf(element, generation, rows, subsetCells));
      if (measured === null && batches > 1) {
        // The run's three ways, over its reads: the rows every read; the
        // index (built once) and each read's whole-column entries; or the
        // rows once, kept, and each read's entries in these cells only.
        const copies = Math.max(0, columns.readCost(storedGenes) - (columns.passCost?.() ?? 0)) * (cellPositions.length / Math.max(1, matrix.nRows));
        const keep = costs.rows + copies * batches < Math.min(costs.rows, costs.columns) * batches;
        const kept = keep ? await this._keptCellSubset(element, matrix, rows, cellPositions, generation, readOptions, cellPositions, true) : null;
        if (kept !== null) return genesOfCellSubset(kept, genePositions);
      }
      const { block } = await readCellSubset(
        columns,
        rows,
        subsetCells,
        storedGenes,
        { nObs: matrix.nRows, label, inFlightEntries: this._inFlightEntries(), readOptions, link: this._link === null ? null : () => this._link.snapshot(), batches, costs }
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
    // Rows in open order: a run kept in store order is a segment's (`_segmentedColumns`).
    const whole = runs.find(run => run.start === 0 && run.rows === nRows && !run.storeOrder) ?? null;
    for (const run of runs) if (run !== whole) run.kept.release();
    return whole !== null
      ? { ...options, kept: whole.kept }
      : { ...options, onBuilt: store => this._keepRun(resolved, 0, nRows, store, { pointers: store._rowPointers ?? null }) };
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
      // Its own work measured (`PassRates`: what a share weighs its pass by, `_restrictsWhole`).
      onWork: work => this._passRates.noteIndex(work),
    };
  }

  /** Release row access (its row pointers). @private */
  _releaseRows() {
    this._rows = null;
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
    Promise.resolve(this._readyGeneRows(element))
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
    let held = (current.columns?.residentBytes?.() ?? 0) + this._rowPointerBytes();
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
            label: geneIndexActivityLabel(label, rescan, geneLayoutOf(matrix, { nObs: nRows, nVars: sourceVars, decodedChunkBytes: this._decodedChunkBytes })),
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
    this._storeOrdered.clear();
    this._restricted.clear();
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
    if (!withCategories && isGroup(item)) {
      // A field's type from its own metadata (`getObsFieldKind`): a column's
      // parts are not loaded at open (`ANNDATA_OPENING_PATHS`) and a defect
      // in them refuses the column when it is read, never here. A
      // categorical's count is known once its parts are loaded (null until).
      let result;
      if (declared === 'categorical') {
        let count = null;
        if (item.loaded) {
          try {
            count = categoryCount(item.get('categories'), key, format);
          } catch {
            count = null;
          }
        }
        result = { dtype: 'categorical', categoryCount: count, ordered: requireCategoricalOrdered(item, `Categorical field '${key}'`) };
      } else {
        // A nullable column: its values' type names an integer column's.
        await obs.load([key], readOptions);
        this._assertGeneration(generation, `loading observation field '${key}'`);
        let valuesKind = null;
        try {
          valuesKind = nullableContract(item, key, declared, format, this._nObs).valuesKind;
        } catch {
          valuesKind = null;
        }
        result = {
          dtype: declared === 'nullable-integer'
            ? (valuesKind === 'uint' ? 'uint' : 'int')
            : (declared === 'nullable-boolean' ? 'bool' : 'string'),
        };
      }
      this._cache.set(cacheKey, result);
      return result;
    }
    await obs.load([key], readOptions);
    this._assertGeneration(generation, `loading observation field '${key}'`);
    const categorical = resolveCategoricalColumn(obs, key, format);
    let result;
    if (categorical) {
      validateCodes(categorical.codes, key, format, this._nObs);
      if (withCategories && this._categoryCoding(key, categorical).present) {
        // Coded by the categories its open cells hold: none is read before
        // its codes (`_readPresentCategorical`).
        result = { dtype: 'categorical', present: true, categoryCount: categoryCount(categorical.categories, key, format), ordered: categorical.ordered, categories: null, colors: null };
      } else if (withCategories) {
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
      const kind = valueKind(item);
      // An integer column a layout view says holds labels (a Loom
      // clustering): categories, found when it is read.
      result = { dtype: item.labels === true && (kind === 'int' || kind === 'uint') ? 'labels' : kind };
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
   * One obs column on the open cells: a categorical's codes with its
   * categories, numbers as continuous values (float32, float64 where float32
   * cannot hold an integer exactly), and a text or boolean column coded here
   * as a categorical (`discovered: true`, `codeDiscoveredColumn`): under
   * `categories`, the ones it was coded with before (null the first time),
   * with any label these cells add, in label order. `rows` (`[start, end)`
   * of the open cells) reads only those rows -- what an opening grown in
   * place appends (`AnnDataFileSource.resizeCells`) -- and is not cached;
   * every row, cached, by default (a coded text column never: its codes
   * depend on `categories`). `signal` cancels the read.
   *
   * @param {string} key
   * @param {{signal?: AbortSignal|null, rows?: [number, number]|null, categories?: ReadonlyArray<string|boolean>|null}} [options]
   */
  async getObsField(key, { signal = null, rows = null, categories = null } = {}) {
    this._ensureOpen();
    const range = this._rowRange(rows, `obs['${key}']`);
    const cacheKey = range === null ? `obs:${key}` : null;
    if (cacheKey !== null && this._cache.has(cacheKey)) return this._cache.get(cacheKey);
    const label = range === null ? `obs['${key}']` : `obs['${key}'] rows ${range.start}–${range.end}`;
    const field = await this._track('field', label, readOptions => this._readObsField(key, cacheKey, readOptions, range), signal);
    if (DISCOVERED_DTYPES.has(field.dtype)) {
      const { codes, categories: labels } = field.dtype === 'bool'
        ? codeBooleanColumn(field.flags, categories, `Observation field '${key}'`)
        : codeDiscoveredColumn(field.values, categories, `Observation field '${key}'`);
      return {
        dtype: 'categorical',
        discovered: true,
        codes,
        categories: labels,
        ordered: false,
        // The values each code names, as a stored categorical's (computed
        // once, only when asked for); a code past the labels is missing.
        get values() {
          const computed = Array.from(codes, code => (code < labels.length ? labels[code] : null));
          Object.defineProperty(this, 'values', { value: computed, writable: false });
          return computed;
        },
      };
    }
    return field;
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
    await obs.load([key], readOptions);
    this._assertGeneration(generation, `loading observation field '${key}'`);
    const item = obs.get(key);
    const declared = validateColumnEncoding(item, format, `Observation field '${key}'`);
    const categorical = resolveCategoricalColumn(obs, key, format);
    const start = range?.start ?? 0;
    let result;
    if (categorical && this._categoryCoding(key, categorical).present) {
      result = await this._readPresentCategorical(key, categorical, readOptions, range, generation);
    } else if (categorical) {
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
        // Integers stay exact (float64 where float32 cannot hold them).
        values = await readContinuous(item, start, end, label, readOptions);
        if (item.labels === true && dtype !== 'float') {
          // Labels (a Loom clustering): coded by their caller's categories.
          result = { dtype: 'labels', values };
        }
      } else if (dtype === 'bool') {
        // One byte a cell, coded by `getObsField` (`codeBooleanColumn`).
        const raw = await readStored(item, start, end, label, readOptions);
        result = { dtype, flags: decodeAnnDataBooleanFlags(raw, null, `Observation field '${key}' contains a non-boolean value`) };
      } else {
        const raw = await readStored(item, start, end, label, readOptions);
        values = new Array(length);
        for (let i = 0; i < length; i++) values[i] = raw[i];
      }
      result ??= { dtype, values };
    }
    this._assertGeneration(generation, `reading observation field '${key}'`);
    // A text or boolean column is coded by its caller's categories
    // (`getObsField`): its values are not kept.
    if (cacheKey !== null && !DISCOVERED_DTYPES.has(result.dtype)) this._cache.set(cacheKey, result);
    return result;
  }

  /**
   * How the categorical obs field `key` is coded, decided on its first read
   * and kept (`_categoryCodings`): by the categories its open cells hold
   * (`present: true`) when its dictionary has more categories than there
   * are open cells and more than one request of its source reads (the
   * least its categories can be stored in, `leastCategoryBytes`, past the
   * source policy's request size,
   * `LinkMeter.policyRequestBytes`: 8 MiB from a web host, 32 MiB from this
   * machine, the same on every visit, so a list shows the same categories
   * each time) -- a dictionary of one category
   * per cell (barcodes kept as a categorical: 1.2M of them on CELLxGENE's
   * soundlife atlas, 35 MB) is then read for the few a share of the cells
   * names -- else by its stored dictionary, every category listed, the
   * unused ones too (what a request reads whole costs no more read whole). @private
   */
  _categoryCoding(key, categorical) {
    let coding = this._categoryCodings.get(key);
    if (coding === undefined) {
      const count = categoryCount(categorical.categories, key, this._format);
      const requestBytes = this._link?.policyRequestBytes ?? this._link?.maxRequestBytes ?? Infinity;
      coding = count > this._nObs && count * leastCategoryBytes(categorical.categories) > requestBytes
        ? { present: true, count, stored: new Uint32Array(0), labels: Object.freeze([]), colors: null }
        : { present: false };
      this._categoryCodings.set(key, coding);
    }
    return coding;
  }

  /**
   * A categorical coded by the categories its open cells hold
   * (`_categoryCoding`): its codes (of `range`'s rows, or every open row),
   * then the labels of the stored categories they name that no earlier read
   * found (`readCategoriesAt`: only theirs read), with their colours from
   * `uns['<key>_colors']` at the same positions. The field's categories are
   * every one found so far, in stored order (an ordered categorical keeps
   * its order); its codes are positions among them, -1 missing;
   * `present.stored` the stored position of each (its colour by default,
   * `presentCategoryPalette`), `present.count` the dictionary's size and
   * `present.colors` the file's colours of them, or null. Exact: each cell's
   * label is the one its stored code names. @private
   */
  async _readPresentCategorical(key, categorical, readOptions, range, generation) {
    const format = this._format;
    const coding = this._categoryCodings.get(key);
    const rows = range === null ? this._nObs : range.end - range.start;
    // Rows enough that their codes name a category in every chunk of the
    // dictionary (codes spread over it, as a label-ordered dictionary of
    // barcodes is: of c chunks, rows r leave about c * exp(-r / c) unnamed,
    // fewer than one once r > c * ln c): every chunk is read whatever the
    // codes say, so the dictionary and its colours are read with the codes,
    // in one plan, as a read of the stored dictionary is -- no round trip
    // waits for the codes, no request or byte more -- and the present ones
    // picked.
    const chunks = chunkCount(categorical.categories);
    const whole = chunks !== null && rows > chunks * Math.log(chunks) && coding.stored.length < coding.count
      ? Promise.all([
        readCategories(categorical.categories, key, format, readOptions),
        readObsFieldColors(this._root, key, readOptions),
      ])
      : null;
    whole?.catch(() => {});
    const codes = await readCodes(categorical.codes, coding.count, key, format, this._nObs, readOptions, range);
    this._assertGeneration(generation, `reading categorical codes for '${key}'`);
    const added = codesMissingFrom(codes, coding.stored);
    if (added.length > 0) {
      const gather = (array, positions) => (touchesEveryChunk(array, positions)
        ? pickedArray(array, positions)
        : gatheredArray(array, runsOfPositions(positions), { mergeGapBytes: () => this._mergeGapBytes(), chunks: this._decodedChunks }));
      const [labels, colors] = whole !== null
        ? await whole.then(([all, allColors]) => [
          Object.freeze(Array.from(added, position => all[position])),
          allColors === null || allColors.length < coding.count ? null : Array.from(added, position => allColors[position]),
        ])
        : await Promise.all([
          readCategoriesAt(categorical.categories, added, key, format, readOptions, gather),
          readObsFieldColors(this._root, key, readOptions, { count: coding.count, positions: added, gather }),
        ]);
      this._assertGeneration(generation, `reading categorical labels for '${key}'`);
      // A read that finished meanwhile may have found some of them: merged
      // into the coding as it is now.
      const now = this._categoryCodings.get(key);
      if (now !== undefined && now.present) this._categoryCodings.set(key, mergedCoding(now, added, labels, colors, key));
    }
    const merged = this._categoryCodings.get(key);
    const positions = positionsAmong(codes, merged.stored, key);
    return {
      dtype: 'categorical',
      codes: positions,
      categories: merged.labels,
      ordered: categorical.ordered,
      present: { count: merged.count, stored: merged.stored, colors: merged.colors },
      get values() {
        const computed = Array.from(positions, code => (code >= 0 ? merged.labels[code] : null));
        Object.defineProperty(this, 'values', { value: computed, writable: false });
        return computed;
      },
    };
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
    this._ensureOpen();
    await this._ready([`obsp/${requireObspKey(key)}`]);
    return this._connectivityMetadata(key) !== null;
  }

  /**
   * The edges of `obsp[key]`, checked and extracted here, beside the matrix
   * (in the reader worker), so the page never walks a large graph. The
   * graph is read line by line (`graph-lines.js`): one slab of it is held
   * at a time, beside the edges being built.
   */
  async getConnectivityEdges(key, { signal = null } = {}) {
    this._ensureOpen();
    await this._ready([`obsp/${requireObspKey(key)}`], { signal });
    const metadata = this._connectivityMetadata(key);
    if (metadata === null) return null;
    return this._track('graph', `obsp['${key}']`, async readOptions => {
      const generation = this._generation;
      const lines = await this._connectivityLines(key, metadata, readOptions);
      const edges = await connectivityEdgesFromLines(lines, this._nObs, { run: work => this._inForeground(work) });
      this._assertGeneration(generation, 'loading connectivity data');
      return edges;
    }, signal);
  }

  /**
   * The neighbours of some open cells in `obsp[key]` (`cells`, distinct
   * open cells), read from the file by row: what the k-NN tool expands
   * through, so no thread holds every cell's neighbour list. A subsample's
   * cells are read at their stored rows, keeping the neighbours it opened
   * (renumbered); a cell is never its own neighbour, and a stored zero is no
   * neighbour (as the edges, `connectivity-edges.js`). Null when the file
   * has no such matrix.
   *
   * @param {string} key
   * @param {Uint32Array} cells
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<{offsets: Uint32Array, neighbors: Uint32Array}|null>}
   *   Cell `cells[i]`'s neighbours are `neighbors[offsets[i] .. offsets[i + 1]]`.
   */
  async getConnectivityRows(key, cells, { signal = null } = {}) {
    this._ensureOpen();
    await this._ready([`obsp/${requireObspKey(key)}`], { signal });
    if (!(cells instanceof Uint32Array)) throw new TypeError('Connectivity rows are asked for by a Uint32Array of open cells.');
    for (let i = 0; i < cells.length; i++) {
      if (cells[i] >= this._nObs) throw new RangeError(`Cell ${cells[i]} is outside the ${formatCountOf(this._nObs, 'open cell')}.`);
    }
    const metadata = this._connectivityMetadata(key);
    if (metadata === null) return null;
    return this._track('graph', `obsp['${key}'] rows`, async readOptions => {
      const generation = this._generation;
      const subset = this._cellSubset?.rows ?? null;
      const nStored = subset?.nOriginal ?? this._nObs;
      // The stored rows, ascending, each with the request slot it answers.
      const stored = subset === null ? cells : Uint32Array.from(cells, cell => subset.kept[cell]);
      const order = Uint32Array.from(cells.keys()).sort((a, b) => stored[a] - stored[b]);
      const lines = Uint32Array.from(order, slot => stored[slot]);
      for (let i = 1; i < lines.length; i++) {
        if (lines[i] === lines[i - 1]) throw new RangeError('Connectivity rows are asked for distinct cells.');
      }
      const rowOptions = { mergeGapBytes: () => this._mergeGapBytes(), readOptions, chunks: this._decodedChunks, inFlightEntries: this._graphReadAhead() };
      // The rows alone, or the whole graph streamed when that costs less
      // (a large frontier: `_graphReadPlan`); a MuData modality's graph
      // placed on the cells in its own rows.
      const read = typeof metadata.node.graphPlacement === 'function'
        ? await readPlacedGraphRows(metadata.node, lines, { ...rowOptions, choose: target => this._graphReadPlan(target) })
        : await readGraphRows(metadata.node, lines, nStored, {
          ...rowOptions,
          plan: metadata.kind === 'sparse' ? await this._graphReadPlan({ group: metadata.node, rows: lines, nRows: nStored }) : 'rows',
        });
      this._assertGeneration(generation, 'loading connectivity rows');
      const positions = subset === null ? null : subset.positions();
      // Each answer's neighbours, in request order.
      const counts = allocateTypedArray(Uint32Array, cells.length + 1, 'Connectivity row offsets');
      const kept = allocateTypedArray(Int32Array, read.indices.length, 'Connectivity row neighbours');
      for (let line = 0; line < lines.length; line++) {
        let count = 0;
        for (let entry = read.pointers[line]; entry < read.pointers[line + 1]; entry++) {
          const column = Number(read.indices[entry]);
          if (!(column >= 0 && column < nStored) || !Number.isInteger(column)) {
            throw new Error(`Connectivity index ${String(read.indices[entry])} is outside axis bounds [0, ${nStored})`);
          }
          const neighbor = positions === null ? column : positions.get(column);
          kept[entry] = neighbor < 0 || column === lines[line] || Number(read.data[entry]) === 0 ? -1 : neighbor;
          if (kept[entry] >= 0) count++;
        }
        counts[order[line] + 1] = count;
      }
      for (let i = 0; i < cells.length; i++) counts[i + 1] += counts[i];
      const neighbors = allocateTypedArray(Uint32Array, counts[cells.length], 'Connectivity row neighbours');
      for (let line = 0; line < lines.length; line++) {
        let write = counts[order[line]];
        for (let entry = read.pointers[line]; entry < read.pointers[line + 1]; entry++) {
          if (kept[entry] >= 0) neighbors[write++] = kept[entry];
        }
      }
      return { offsets: counts, neighbors };
    }, signal);
  }

  /**
   * One neighbour graph, `obsp[key]`, as stored (a dense array, or its
   * sparse lines gathered), read whole: what a caller that wants the matrix
   * itself reads. Not cached: its edges are.
   */
  async getConnectivities(key, { signal = null } = {}) {
    this._ensureOpen();
    await this._ready([`obsp/${requireObspKey(key)}`], { signal });
    const metadata = this._connectivityMetadata(key);
    if (metadata === null) return null;
    return this._track('graph', `obsp['${key}']`, async readOptions => {
      const generation = this._generation;
      let result;
      if (this._cellSubset?.rows != null) {
        result = await this._inducedGraph(key, metadata, readOptions);
      } else if (metadata.kind === 'dense') {
        const [nRows, nCols] = metadata.shape;
        // Every row, every column: a two-dimensional read, not a row range of
        // a one-dimensional array.
        const data = await metadata.node.read([[0, nRows], [0, nCols]], readOptions);
        if (!data || data.length !== nRows * nCols) throw new Error('Dense connectivity matrix payload length does not match its shape');
        result = { data, format: 'dense', shape: metadata.shape };
      } else {
        result = await gatheredGraph(await sparseGraphLines(metadata.node, this._format, 'Connectivity matrix', readOptions), 'Connectivity matrix');
      }
      this._assertGeneration(generation, 'loading connectivity data');
      return result;
    }, signal);
  }

  /**
   * The lines of `obsp[key]` as the open cells see it (`graph-lines.js`),
   * streamed: a subsample's induced subgraph a slab of open cells at a time
   * (a dense one, small by nature, held), else the stored graph.
   * @private
   */
  async _connectivityLines(key, metadata, readOptions) {
    const rows = this._cellSubset?.rows ?? null;
    if (rows !== null && metadata.kind === 'sparse') {
      return inducedGraphLines(metadata.node, rows, {
        mergeGapBytes: () => this._mergeGapBytes(),
        roundTripBytes: () => this._link?.roundTripBytes ?? 0,
        readOptions,
        chunks: this._decodedChunks,
        choose: target => this._graphReadPlan(target),
        onShare: share => this._graphShares.set(key, share),
        inFlightEntries: this._graphReadAhead(),
      });
    }
    if (rows !== null) return heldGraphLines(await this._inducedGraph(key, metadata, readOptions));
    // A MuData modality's graph placed on the cells, streamed in its own rows.
    if (typeof metadata.node.graphPlacement === 'function') return placedGraphLines(metadata.node, this._nObs, { readOptions });
    if (metadata.kind === 'dense') return denseGraphLines(metadata.node, metadata.shape[0], readOptions);
    return sparseGraphLines(metadata.node, this._format, 'Connectivity matrix', readOptions);
  }

  /**
   * Entries of a graph's slabs read ahead of the one built (`graph-lines.js`):
   * none past the next from a disk (or a link as fast), else what fills every
   * request the link runs at once (`_inFlightEntries`), within the decoded
   * chunks' share of memory (`decodedBlocks`, what slabs being decoded are):
   * the full HLCA's graph over S3 with every request the link runs filled
   * held 1.6 GB of slabs in flight. @private
   */
  _graphReadAhead() {
    if (this._readsAhead()) return 0;
    const decoded = this._decodedChunkBytes ?? residencyBudgetBytes('decodedBlocks');
    return Math.min(this._inFlightEntries(), Math.floor(decoded / 8));
  }

  /**
   * How some rows of a stored graph are read (`graph-lines.js`
   * `GraphReadPlan`): the whole graph streamed when it reads no more than
   * the rows alone (`_readsNoMoreThanRows`, values included), else the
   * rows: where the rows lie in every chunk, the stream reads the same
   * bytes in fewer requests and walks its entries in order, where the rows
   * gather each open row's entries apart. `target`: `{group, rows, nRows}`,
   * the graph's group and the rows read (ascending) of its `nRows`.
   * @private
   */
  async _graphReadPlan({ group, rows, nRows }) {
    if (rows.length === 0 || !isGroup(group)) return 'rows';
    return await this._readsNoMoreThanRows({ node: group, rows, nRows, valuesOnDemand: false }) ? 'stream' : 'rows';
  }

  /**
   * Whether reading every row of a cell-major matrix (a CSR group, or a
   * dense array in row chunks) from the first of `rows` to the last reads
   * no more stored bytes than reading `rows` alone (ascending, of its
   * `nRows`): they lie in every chunk of that span, so the whole reads
   * nothing more, in fewer requests. Priced as the first gene prices a
   * matrix's rows (`firstGeneReadCost`: the stored chunks of its pointers,
   * indices and values -- the values only unless `valuesOnDemand` -- the
   * rows lie in, with the gaps the link joins reads across), unless every
   * gap between two rows is shorter than a chunk of each array (rows taken
   * to hold the mean entries): then the rows lie in every chunk, without
   * pricing each row (a 2.5M-cell share: 0.2 s). What a graph's induced
   * subgraph streams by (`_graphReadPlan`) and a share's genes are indexed
   * by (`_restrictsWhole`). @private
   */
  async _readsNoMoreThanRows({ node, rows, nRows, valuesOnDemand }) {
    if (rows.length === 0) return false;
    let widest = 0;
    for (let i = 1; i < rows.length; i++) if (rows[i] - rows[i - 1] > widest) widest = rows[i] - rows[i - 1];
    const chunkOf = array => (Array.isArray(array?.chunks) && array.chunks.length > 0 && array.partialChunks !== true ? Number(array.chunks[0]) : null);
    if (isGroup(node)) {
      const [pointerChunk, indexChunk, valueChunk] = ['indptr', 'indices', 'data'].map(name => chunkOf(node.get(name)));
      const perRow = node.get('indices').shape[0] / nRows;
      if (pointerChunk !== null && indexChunk !== null && valueChunk !== null &&
        widest <= pointerChunk && widest * perRow <= Math.min(indexChunk, valuesOnDemand ? indexChunk : valueChunk)) return true;
    } else {
      const rowChunk = chunkOf(node);
      if (rowChunk !== null && widest <= rowChunk) return true;
    }
    // The matrix's price, made once per merge gap (it moves with the link).
    const link = pricingLink(this._link?.snapshot?.() ?? null, this._hostLink ?? null);
    const mergeGapBytes = link?.mergeGapBytes ?? this._mergeGapBytes();
    this._rowsCosts ??= new WeakMap();
    let priced = this._rowsCosts.get(node);
    if (priced === undefined || priced.mergeGapBytes !== mergeGapBytes || priced.valuesOnDemand !== valuesOnDemand) {
      priced = {
        mergeGapBytes,
        valuesOnDemand,
        cost: await firstGeneReadCost(null, nRows, {
          expression: node,
          valuesOnDemand,
          decodedChunkBytes: this._decodedChunkBytes ?? residencyBudgetBytes('decodedBlocks'),
          mergeGapBytes,
        }),
      };
      this._rowsCosts.set(node, priced);
    }
    if (priced.cost === null) return false;
    const own = priced.cost(rows);
    const whole = priced.cost({ count: 1, starts: [rows[0]], ends: [rows[rows.length - 1] + 1] });
    // Else the whole would read chunks no row lies in, past the gaps the
    // link joins reads across (`mergeGapBytes`, already in the rows' price).
    return whole.decodedBytes <= own.decodedBytes && whole.bytes <= own.bytes;
  }

  /** A subsample's induced subgraph of `obsp[key]` (`readInducedGraph`), its share kept. @private */
  async _inducedGraph(key, metadata, readOptions) {
    const generation = this._generation;
    const { share, ...graph } = await readInducedGraph(metadata.node, this._cellSubset.rows, {
      mergeGapBytes: () => this._mergeGapBytes(),
      roundTripBytes: () => this._link?.roundTripBytes ?? 0,
      readOptions,
      chunks: this._decodedChunks,
      choose: target => this._graphReadPlan(target),
      inFlightEntries: this._graphReadAhead(),
    });
    this._assertGeneration(generation, 'loading connectivity data');
    this._graphShares.set(key, share);
    return graph;
  }


  async getDatasetMetadata() {
    this._ensureOpen();
    const generation = this._generation;
    // No matrix value is read for the first view (`probeMapping`).
    const probes = await this.probeMapping({ counts: false });
    let nCategorical = 0;
    let nContinuous = 0;
    for (const key of this._obsKeys) {
      const info = await this._fieldInfo(key, { withCategories: false });
      if (info.dtype === 'categorical') nCategorical++;
      else if (info.dtype === 'float' || info.dtype === 'int' || info.dtype === 'uint') nContinuous++;
    }
    // The graph a file opens with is the data mapping's default
    // (`defaultGraph`); any other is read only when it is chosen.
    const graph = defaultGraph(probes.obsp.map(item => item.key), { modality: this._defaultModality ?? null });
    const hasConnectivity = graph !== null && await this.hasConnectivities(graph);
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
    if (this._closed || generation !== this._generation) throw this._superseded(operation);
  }

  /**
   * Why a request of this reader's dataset stopped (`_assertGeneration`),
   * and why its store was closed under the reads still under way
   * (`_releaseCurrentState`): never a failure -- the file was closed, or the
   * dataset or its caches were replaced under the request (released: asked
   * again, it works). @private
   */
  _superseded(operation) {
    return cancelled(
      this._closed ? 'closed' : 'released',
      `${this._format?.file ?? 'AnnData'} dataset changed, cache was cleared, or file was closed while ${operation}; the request was superseded`
    );
  }

  /**
   * A cell subset's positions checked (`requireDistinctCells`) with its
   * largest (`last`, -1 for none), kept for the reads after: a run reads the
   * same cells for every batch of its genes (a differential expression of
   * two groups of 10M cells: ~400 reads of 1.9M cells), and walking them
   * several times a read (checked, bounded by the gene sample, by the rows
   * read, by a prefix) was most of what the reader did for it (10M Zarr,
   * Chromium: 8.5 of 9 s of the reader's work). @private
   */
  _checkedCells(cells, label) {
    const checked = requireDistinctCells(cells, this._nObs, label);
    let last = -1;
    for (let k = 0; k < checked.length; k++) if (checked[k] > last) last = checked[k];
    this._cellSubsetChecked = { generation: this._generation, nObs: this._nObs, cells: checked, last };
    return this._cellSubsetChecked;
  }

  /** The checked cells (`_checkedCells`) when `cells` are the same cells in the same order, else null: one comparison. @private */
  _sameCheckedCells(cells) {
    const checked = this._cellSubsetChecked;
    if (checked === null || checked.generation !== this._generation || checked.nObs !== this._nObs) return null;
    return (Array.isArray(cells) || ArrayBuffer.isView(cells)) && sameCells(checked.cells, cells) ? checked : null;
  }

  /**
   * `rows.subset(cells, genes)` of a CSR matrix of a subsample's open rows,
   * read in store order: the cells' file rows ascending through the open
   * rows' store-order matrix (`_storeOrderMatrix`), each stored chunk
   * decoded once, then each gene's entries put back at the cells'
   * positions. Read in open order, rows spread through the store (a uniform
   * share) made every read of the run's pipeline decode nearly every stored
   * chunk again: a 50 % share's DE groups (944,727 cells of a 10M CSR file)
   * read 7.5 GB of a 2.6 GB file. Any other matrix is read as `rows` reads.
   * @private
   */
  async _subsetInStoreOrder(matrix, rows, cells, genes, readOptions) {
    const fileRows = this._cellSubset?.fileRows ?? null;
    if (fileRows === null || !isGroup(matrix.node) || matrix.key.startsWith('mod/') || matrix.start !== 0 || matrix.cells !== null ||
      typeof this._root?.rowsMatrix !== 'function') {
      return rows.subset(cells, genes, readOptions);
    }
    const { order, matrix: stored } = await this._storeOrderMatrix(matrix, 0, matrix.nRows, readOptions);
    // Each cell's row in store order, ascending, and its position in `cells`.
    const rank = allocateTypedArray(Uint32Array, matrix.nRows, 'Rows in store order');
    for (let i = 0; i < order.length; i++) rank[order[i]] = i;
    const ranks = allocateTypedArray(Uint32Array, cells.length, 'Cells in store order');
    for (let k = 0; k < cells.length; k++) ranks[k] = rank[cells[k]];
    const byRank = orderByKey(ranks);
    const inStoreOrder = allocateTypedArray(Uint32Array, cells.length, 'Cells in store order');
    for (let k = 0; k < byRank.length; k++) inStoreOrder[k] = ranks[byRank[k]];
    const storedRows = await openMatrixRows(stored, {
      format: this._format,
      label: matrix.label,
      nObs: matrix.nRows,
      nVars: matrix.sourceVars,
      indexOptions: this._indexOptions(),
      inFlightEntries: this._inFlightEntries(),
    });
    const block = await storedRows.subset(inStoreOrder, genes, readOptions);
    // Back to the cells' positions, ascending within each gene.
    const positions = new Uint32Array(block.cellIndex.buffer, block.cellIndex.byteOffset, block.cellIndex.length);
    for (let k = 0; k < positions.length; k++) positions[k] = byRank[positions[k]];
    for (let g = 0; g + 1 < block.pointers.length; g++) {
      const from = block.pointers[g];
      const to = block.pointers[g + 1];
      if (to - from > 1) sortByKeyWithValues(positions.subarray(from, to), block.values.subarray(from, to));
    }
    return block;
  }

  /** Every gene of `cells` kept (`_keptCellSubset`) and read already, or null. @private */
  _heldCellSubset(element, cells, generation) {
    const kept = this._cellSubsetGenes;
    if (kept === null || kept.refused || kept.block === null) return null;
    return kept.element === element && kept.generation === generation && sameCells(kept.cells, cells) ? kept.block : null;
  }

  /**
   * Every gene of `cells` read once by their rows and kept, when the run
   * reading them (`keep`: it has more reads of these cells to make, and
   * keeping them costs it the least, `getMatrixCellSubset`) starts, and
   * used by every later read of the same cells: each read re-read the
   * cells' whole rows (a 10M-cell CSR file, 30,000 genes: 470 reads of
   * ~130 MB), and is now a copy out of the cells' genes held once (their
   * stored entries, 8 bytes each). Held within the `columnIndex` share
   * beside what is held there (`_heldBytes`; trimmed first by
   * `trimResident`); not kept when they would not fit, or when the device
   * refuses the memory (the run then reads by its other routes, and is not
   * offered keeping again). Null when not kept.
   * @private
   */
  async _keptCellSubset(element, matrix, rows, cells, generation, readOptions, rowCells, keep) {
    let kept = this._cellSubsetGenes;
    if (kept !== null && (kept.element !== element || kept.generation !== generation || !sameCells(kept.cells, cells))) {
      this._cellSubsetGenes = kept = null;
    }
    if (kept === null) {
      if (!keep || rows === null || typeof rows.subset !== 'function') return null;
      // The cells' stored entries, held (cell position and value, 8 bytes)
      // and while gathered (16 more), against what the share leaves.
      // Every open row's entries: counted once their pointers are read, else
      // at the file's mean a row (cells read by their own rows read no other's).
      const pending = isGroup(matrix.node) && matrix.node.rowPointersPending?.() === true;
      const nnz = !isGroup(matrix.node) ? matrix.nRows * matrix.nVars
        : pending ? matrix.node.storedData().shape[0] / Math.max(1, this._cellSubset?.nObs ?? matrix.nRows) * matrix.nRows
          : sparseContract(matrix.node, this._format, `Sparse ${matrix.label}`).dataLength;
      const entries = nnz * (cells.length / Math.max(1, matrix.nRows));
      if (entries * 24 > residencyBudgetBytes('columnIndex') - this._heldBytes()) return null;
      const genes = new Array(matrix.nVars);
      for (let g = 0; g < genes.length; g++) genes[g] = matrix.start + g;
      kept = { element, generation, cells, block: null, building: null, refused: false };
      kept.building = (rowCells === cells ? this._subsetInStoreOrder(matrix, rows, cells, genes, readOptions) : rows.subset(rowCells, genes, readOptions))
        .then(block => { kept.block = block; return block; });
      this._cellSubsetGenes = kept;
    }
    if (kept.refused) return null;
    let block;
    try {
      block = kept.block ?? await kept.building;
    } catch (error) {
      // Every gene of the cells could not be held (the device refused the
      // memory): this run reads each batch by its other routes.
      if (!(error instanceof RangeError)) {
        if (this._cellSubsetGenes === kept) this._cellSubsetGenes = null;
        throw error;
      }
      kept.refused = true;
      kept.building = null;
      return null;
    }
    this._assertGeneration(generation, `reading the genes of ${formatCountOf(cells.length, 'cell')} of ${matrix.label}`);
    return block;
  }

  /**
   * What the `columnIndex` share holds now: row pointers, kept cell genes,
   * and the gene indexes built or being built (a pass holds what it builds
   * as it goes, up to its reservation). An index no pass has started holds
   * nothing: its reservation (`residentBytes`) is not counted, for a run that
   * keeps its cells' genes instead does not build it. Counting a building
   * pass is what keeps the two from being held at once past the share (50M
   * cells: an index pass beside a kept subset took the reader to 8.7 GB).
   * @private
   */
  _heldBytes() {
    let bytes = this._rowPointerBytes() + this._cellSubsetBytes();
    for (const state of this._matrices.values()) {
      const columns = state.columns ?? null;
      if (columns?.built?.() === true || columns?.building?.() === true) bytes += columns.residentBytes?.() ?? 0;
    }
    return bytes;
  }

  /**
   * What reading `cells` by their rows costs (`rows.readCost`, whatever the
   * genes: a row is decoded whole), priced once for a run's cells, not once
   * a read (it orders and walks every cell). Infinity without rows. @private
   */
  _rowsCostOf(element, generation, rows, cells) {
    if (rows?.subset === undefined) return Infinity;
    const priced = this._cellSubsetRowsCost;
    if (priced !== null && priced.element === element && priced.generation === generation && priced.rows === rows && sameCells(priced.cells, cells)) return priced.cost;
    const cost = rows.readCost(cells);
    this._cellSubsetRowsCost = { element, generation, rows, cells, cost };
    return cost;
  }

  /** The bytes of the cells' genes kept (`_keptCellSubset`). @private */
  _cellSubsetBytes() {
    const block = this._cellSubsetGenes?.block ?? null;
    const checked = this._cellSubsetChecked?.cells ?? null;
    // The kept genes' cells are the checked cells (`_keptCellSubset` keeps them): counted once.
    const cells = checked === null || checked === this._cellSubsetGenes?.cells ? 0 : typedArrayBytes(checked);
    return cells + (block === null ? 0 : typedArrayBytes(block.pointers) + typedArrayBytes(block.cellIndex) + typedArrayBytes(block.values));
  }

  /** Drop every cached field, name list, matrix index and row pointers. */
  clearCache() {
    this._cellSubsetGenes = null;
    this._cellSubsetRowsCost = null;
    this._cellSubsetChecked = null;
    this._generation++;
    this._cache.clear();
    this._decodedChunks?.clear();
    this._indptrs.clear();
    this._indptrPrefixes.clear();
    this._knownRowPointers.clear();
    // Row access is released even when releasing a matrix fails.
    try {
      this._releaseMatrices();
    } finally {
      this._releaseRows();
    }
  }

  /** The bytes of the row pointers kept (`_indptrs`, `_indptrPrefixes`, `_knownRowPointers`, the open view's own). @private */
  _rowPointerBytes() {
    // Each buffer once: the open subset's view holds pointers of its own
    // (the kept rows' read, what its CSR matrices made of them), some the
    // same arrays as these maps.
    const buffers = new Set(this._root?.heldBuffers?.() ?? []);
    const add = pointers => {
      if (ArrayBuffer.isView(pointers)) buffers.add(pointers.buffer);
      else if (pointers !== null && typeof pointers === 'object') {
        for (const array of Object.values(pointers)) if (ArrayBuffer.isView(array)) buffers.add(array.buffer);
      }
    };
    for (const pointers of this._indptrs.values()) add(pointers);
    for (const pointers of this._indptrPrefixes.values()) add(pointers);
    for (const pointers of this._knownRowPointers.values()) add(pointers);
    let bytes = 0;
    for (const buffer of buffers) bytes += buffer.byteLength;
    return bytes;
  }

  /**
   * What the gene-column indexes and the row pointers they are built from
   * hold in memory (the `columnIndex` share, `memory-budget.js`).
   *
   * @returns {number}
   */
  residentBytes() {
    let bytes = this._rowPointerBytes() + this._cellSubsetBytes();
    for (const state of this._matrices.values()) bytes += state.columns?.residentBytes?.() ?? 0;
    return bytes;
  }

  /**
   * Hold no more than `budget` bytes of gene-column indexes and row
   * pointers: the row pointers go first (one array read to get again), then
   * the indexes, least recently read first (a pass over the matrix to build
   * again). The index of the matrix read last stays unless `budget` is 0
   * (as `_settleMatrices` keeps it). An index being built stops; the genes
   * waiting on it are still answered.
   *
   * @param {number} budget
   * @returns {string[]} What was let go, in words
   */
  trimResident(budget) {
    const released = [];
    // The cells' genes a run keeps go first: the next batch reads their rows again.
    if (this.residentBytes() > budget && this._cellSubsetBytes() > 0) {
      this._cellSubsetGenes = null;
      this._cellSubsetChecked = null;
      released.push('the genes of an analysis\'s cells');
    }
    if (this.residentBytes() > budget && (this._indptrs.size > 0 || this._indptrPrefixes.size > 0 || this._knownRowPointers.size > 0)) {
      this._indptrs.clear();
      this._indptrPrefixes.clear();
      this._knownRowPointers.clear();
      released.push('row pointers');
    }
    let indexes = 0;
    const states = [...this._matrices.values()];
    if (budget > 0) states.pop();
    for (const state of states) {
      if (this.residentBytes() <= budget) break;
      if (state.columns === null) continue;
      this._releaseMatrixState(state);
      indexes++;
    }
    if (indexes > 0) released.push(indexes === 1 ? 'a gene index' : `${indexes} gene indexes`);
    return released;
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
      // Its reads still under way stop, each rejecting as this reader's
      // requests do once it moved on (`_superseded`).
      try {
        this._store.close?.(this._superseded('reading it'));
        this._store = null;
      } catch (error) {
        record(error);
      }
    }
    this._root = null;
    this._fullRoot = null;
    this._cellSubset = null;
    setWorkingSet(this._cellRowsPart, 0);
    this._expression = null;
    this._prefixReads = new Map();
    try {
      this.clearCache();
    } catch (error) {
      record(error);
    }
    this._nObs = 0;
    this._nVars = 0;
    this._obsKeys = [];
    this._notes = Object.freeze([]);
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
    this._subsampleCache = null;
    this._categoryCodings = new Map();
    this._releaseCurrentState();
  }
}

