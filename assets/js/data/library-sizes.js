/**
 * @fileoverview Each open cell's library size (its total count): the `t` of
 * the expression transform's normalization (`data/expression-transform.js`).
 *
 * A cell's total is of the whole cell, every gene of it:
 *
 * - from the file when it records it. First the obs field the file names
 *   (`uns['cellucid']['totalCounts']`, written by `prepare()` /
 *   `cellucid_prepare()`: `over` says whether it is the total over all genes,
 *   over the source's gene panel or over the genes stored), then a continuous obs field named like a
 *   cell's total count (`candidates`, best-ranked first:
 *   `app/utils/field-roles.js` `librarySizeFields`), the first whose every
 *   value is a finite total of 0 or more. One obs column, no gene read;
 * - else one pass over the matrix: every gene of it read once, each cell's
 *   values summed (scanpy's `normalize_total` sums `X` the same way). The
 *   genes are read as their non-zero entries, a batch at a time: as many as
 *   half the `analysis` share holds at a gene's densest (8 bytes an entry
 *   of every cell read), the reads of a batch asked for at once so the
 *   fetch scheduler keeps the link as busy as it carries. Only the open
 *   cells genes are read for are summed (`readTo`, the gene sample's): a
 *   cell past them has no total (NaN).
 *
 * The sizes are kept with what they are of (`holder`: the mapped matrix's
 * lineage, which the open cells grown or cut in place keep, or another
 * matrix opened) and shared by every asker while they are computed
 * (`SharedWorks`); the pass stops when every asker has withdrawn. Cells
 * added later (the open cells grown, genes read for more of them) are
 * totaled on their own (`rows`): their obs rows, or every gene in those
 * cells only (`readGenesInCells`), never the whole pass again.
 *
 * @module data/library-sizes
 */

import { SharedWorks, throwIfAborted } from '../utils/abort.js';
import { formatCountOf } from '../utils/format-units.js';
import { residencyBudgetBytes } from './memory-budget.js';
import { cellFactors } from './expression-transform.js';
import { allocateTypedArray } from './sparse-column-index.js';

/**
 * @typedef {Object} LibrarySizes
 * @property {Float64Array} totals - Each open cell's total (NaN: none)
 * @property {Float32Array} factors - Each open cell's factor `10⁴ / total` (`cellFactors`)
 * @property {string|null} field - The obs field they were read from, or null when summed over the matrix
 * @property {'all genes'|'source panel'|'stored genes'|null} over - What the obs field covers, as the file says; null when it does not say
 * @property {number} genes - The genes summed (0 from an obs field)
 * @property {number} readTo - The open cells with a total: `[0, readTo)`
 * @property {string} source - Where they came from, in words
 */

/** @type {WeakMap<object, {works: SharedWorks, last: LibrarySizes|null}>} */
const kept = new WeakMap();

function keptOf(holder) {
  let entry = kept.get(holder);
  if (entry === undefined) {
    entry = { works: new SharedWorks({ keep: true }), last: null };
    kept.set(holder, entry);
  }
  return entry;
}

/**
 * The library sizes of an obs field, or null when a value of an open cell
 * read is not a total (missing, negative, not finite).
 *
 * @param {ArrayLike<number>|null} values
 * @param {number} pointCount
 * @returns {Float64Array|null}
 */
export function totalsOfObsField(values, pointCount) {
  if (values === null || values === undefined || values.length !== pointCount) return null;
  const totals = allocateTypedArray(Float64Array, pointCount, 'The cells\' totals');
  for (let cell = 0; cell < pointCount; cell++) {
    const value = values[cell];
    if (!(Number.isFinite(value) && value >= 0)) return null;
    totals[cell] = value;
  }
  return totals;
}

/**
 * Add a gene's values to each cell's total, its cells `[0, readTo)` only.
 *
 * @param {Float64Array} totals
 * @param {ArrayLike<number>|{length: number, indices: Uint32Array, values: ArrayLike<number>}} column
 * @param {number} readTo
 */
export function addColumnToTotals(totals, column, readTo) {
  if (ArrayBuffer.isView(column) || Array.isArray(column)) {
    const end = Math.min(readTo, column.length);
    for (let cell = 0; cell < end; cell++) {
      const value = column[cell];
      // A cell a modality did not measure (NaN) adds nothing.
      if (value !== 0 && Number.isFinite(value)) totals[cell] += value;
    }
    return;
  }
  const { indices, values } = column;
  for (let k = 0; k < indices.length; k++) {
    const cell = indices[k];
    if (cell >= readTo) break;
    const value = values[k];
    if (Number.isFinite(value)) totals[cell] += value;
  }
}

/**
 * Add a block of genes read in some cells (`{pointers, cellIndex|positions,
 * values}`: position `p` is the `p`-th of those cells) to their totals.
 *
 * @param {Float64Array} totals - One a cell of the block
 * @param {{cellIndex?: ArrayLike<number>, positions?: ArrayLike<number>, values: ArrayLike<number>}} block
 */
export function addBlockToTotals(totals, block) {
  const positions = block.cellIndex ?? block.positions;
  const { values } = block;
  for (let k = 0; k < values.length; k++) {
    const value = values[k];
    if (Number.isFinite(value)) totals[positions[k]] += value;
  }
}

/** Bytes a gene's sparse entry holds at most: its cell (4) and its value (4). */
const ENTRY_BYTES = 8;

/**
 * The genes one batch of the pass reads: as many as half the `analysis`
 * share holds at a gene's densest over the cells read.
 *
 * @param {number} cells
 * @param {number} [budgetBytes]
 * @returns {number}
 */
export function genesPerBatch(cells, budgetBytes = residencyBudgetBytes('analysis')) {
  return Math.max(1, Math.floor(budgetBytes / 2 / Math.max(1, cells * ENTRY_BYTES)));
}

/** Where totals read from an obs field came from, in words. */
function obsSource(field, over) {
  return over === null ? `obs['${field}']` : `obs['${field}'] (over ${over})`;
}

/** Where totals summed over a matrix came from, in words. */
function summedSource(genes, matrixLabel) {
  return `the sum of its ${formatCountOf(genes, 'gene')} of ${matrixLabel}`;
}

function finished({ totals, field, over, genes, readTo, matrixLabel }) {
  return Object.freeze({
    totals,
    factors: cellFactors(totals),
    field,
    over,
    genes,
    readTo,
    source: field === null ? summedSource(genes, matrixLabel) : obsSource(field, over),
  });
}

/**
 * Each gene of the matrix summed over cells `cells` (open positions), a
 * batch of genes at a time.
 * @private
 */
async function sumGenesInCells({ cells, geneCount, readGenesInCells, signal }) {
  const totals = allocateTypedArray(Float64Array, cells.length, 'The cells\' totals');
  const batch = genesPerBatch(cells.length);
  for (let first = 0; first < geneCount; first += batch) {
    const genes = [];
    for (let gene = first; gene < Math.min(geneCount, first + batch); gene++) genes.push(gene);
    const block = await readGenesInCells(genes, cells, signal);
    throwIfAborted(signal);
    addBlockToTotals(totals, block);
  }
  return totals;
}

function cellRange(from, to) {
  const cells = allocateTypedArray(Uint32Array, Math.max(0, to - from), 'The cells added');
  for (let k = 0; k < cells.length; k++) cells[k] = from + k;
  return cells;
}

/**
 * Each open cell's library size.
 *
 * @param {Object} options
 * @param {object|Function} options.holder - What the sizes are of (kept with it)
 * @param {number} options.pointCount - The open cells
 * @param {number} options.readTo - The open cells genes are read for
 * @param {string} options.matrixLabel - The matrix as results name it
 * @param {{field: string, over: 'all genes'|'source panel'|'stored genes'}|null} [options.stored] -
 *   The obs field the file names as its cells' totals (`uns['cellucid']['totalCounts']`)
 * @param {string[]} options.candidates - The continuous obs fields named like a total, best first
 * @param {(key: string, signal: AbortSignal) => Promise<ArrayLike<number>|null>} options.readObs -
 *   An obs field's values on every open cell
 * @param {number} options.geneCount - The genes of the matrix
 * @param {(gene: number, signal: AbortSignal) => Promise<ArrayLike<number>|{length: number, indices: Uint32Array, values: ArrayLike<number>}>} options.readGene -
 *   One gene's values in the open cells, by its position in the matrix
 * @param {((genes: number[], cells: Uint32Array, signal: AbortSignal) => Promise<{cellIndex: ArrayLike<number>, values: ArrayLike<number>}>)|null} [options.readGenesInCells] -
 *   Some genes in some cells (a block): cells added since totals were kept are summed with it
 * @param {AbortSignal|null} [options.signal] - This asker's
 * @returns {Promise<LibrarySizes>}
 */
export function cellLibrarySizes({
  holder, pointCount, readTo, matrixLabel, stored = null, candidates, readObs, geneCount, readGene,
  readGenesInCells = null, signal = null,
}) {
  if (holder === null || (typeof holder !== 'object' && typeof holder !== 'function')) {
    throw new TypeError('Library sizes are kept with the matrix they are of');
  }
  if (!Number.isSafeInteger(pointCount) || pointCount < 0 || !Number.isSafeInteger(readTo) || readTo < 0 || readTo > pointCount) {
    throw new RangeError('Library sizes are of the open cells, read for a prefix of them');
  }
  const entry = keptOf(holder);
  return entry.works.run(JSON.stringify([pointCount, readTo]), async ({ signal: work }) => {
    const sizes = await computeSizes({
      previous: entry.last, pointCount, readTo, matrixLabel, stored, candidates, readObs, geneCount, readGene, readGenesInCells, signal: work,
    });
    entry.last = sizes;
    return sizes;
  }, { signal });
}

async function computeSizes({ previous, pointCount, readTo, matrixLabel, stored, candidates, readObs, geneCount, readGene, readGenesInCells, signal }) {
  // An obs field: the file's own record first, then a name ranked as a total.
  const fields = [];
  if (previous?.field != null) fields.push([previous.field, previous.over]);
  if (stored !== null) fields.push([stored.field, stored.over]);
  for (const key of candidates) fields.push([key, null]);
  const tried = new Set();
  if (previous === null || previous.field !== null) {
    for (const [field, over] of fields) {
      if (tried.has(field)) continue;
      tried.add(field);
      const totals = totalsOfObsField(await readObs(field, signal), pointCount);
      throwIfAborted(signal);
      if (totals !== null) return finished({ totals, field, over, genes: 0, readTo, matrixLabel });
    }
  }
  // Summed over the matrix: the cells already totaled kept (the open
  // cells grown or cut in place keep their positions), the others summed
  // in those cells only when the source reads cell subsets.
  const totals = allocateTypedArray(Float64Array, pointCount, 'The cells\' totals');
  totals.fill(NaN, readTo);
  const known = previous === null || previous.field !== null ? 0 : Math.min(previous.readTo, readTo, previous.totals.length);
  if (known > 0 && readGenesInCells !== null) {
    totals.set(previous.totals.subarray(0, known));
    if (readTo > known) totals.set(await sumGenesInCells({ cells: cellRange(known, readTo), geneCount, readGenesInCells, signal }), known);
    return finished({ totals, field: null, over: null, genes: geneCount, readTo, matrixLabel });
  }
  totals.fill(0, 0, readTo);
  const batch = genesPerBatch(readTo);
  for (let first = 0; first < geneCount; first += batch) {
    const genes = [];
    for (let gene = first; gene < Math.min(geneCount, first + batch); gene++) genes.push(gene);
    const columns = await Promise.all(genes.map(gene => readGene(gene, signal)));
    throwIfAborted(signal);
    for (const column of columns) addColumnToTotals(totals, column, readTo);
  }
  return finished({ totals, field: null, over: null, genes: geneCount, readTo, matrixLabel });
}

/**
 * The totals of open cells `[from, to)` the kept sizes do not cover yet (a
 * gene read for cells added to the open cells, or to the cells genes are
 * read for), in the same way as the sizes: their rows of the obs field, or
 * every gene summed in those cells. Kept with the sizes, so the next ask
 * reads only what is new.
 *
 * @param {Object} options
 * @param {object|Function} options.holder
 * @param {LibrarySizes} options.sizes - The sizes kept so far
 * @param {number} options.from
 * @param {number} options.to
 * @param {(field: string, from: number, to: number, signal: AbortSignal|null) => Promise<ArrayLike<number>>} options.readObsRows
 * @param {number} options.geneCount
 * @param {(genes: number[], cells: Uint32Array, signal: AbortSignal|null) => Promise<{cellIndex: ArrayLike<number>, values: ArrayLike<number>}>} options.readGenesInCells
 * @param {string} options.matrixLabel
 * @param {AbortSignal|null} [options.signal]
 * @returns {Promise<Float64Array>} One total a row
 */
export async function rowLibrarySizes({ holder, sizes, from, to, readObsRows, geneCount, readGenesInCells, matrixLabel, signal = null }) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from) {
    throw new RangeError('Library sizes of rows are of a range of open cells');
  }
  let rows;
  if (sizes.field !== null) {
    const values = await readObsRows(sizes.field, from, to, signal);
    rows = totalsOfObsField(values, to - from);
    if (rows === null) throw new Error(`obs['${sizes.field}'] holds a value that is not a cell's total among the cells added`);
  } else {
    rows = await sumGenesInCells({ cells: cellRange(from, to), geneCount, readGenesInCells, signal });
  }
  throwIfAborted(signal);
  // Kept: the sizes now reach `to` when the rows follow on from them.
  const entry = keptOf(holder);
  if (entry.last === sizes && from <= sizes.readTo && to > sizes.readTo) {
    const totals = allocateTypedArray(Float64Array, Math.max(to, sizes.totals.length), 'The cells\' totals');
    totals.fill(NaN);
    totals.set(sizes.totals.subarray(0, sizes.readTo));
    totals.set(rows, from);
    entry.last = finished({ totals, field: sizes.field, over: sizes.over, genes: sizes.genes, readTo: to, matrixLabel });
  }
  return rows;
}

/** The sizes last computed for `holder` (any cells), or null. */
export function keptLibrarySizes(holder) {
  return kept.get(holder)?.last ?? null;
}
