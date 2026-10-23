/**
 * Gene signature scores of one page, from whole gene columns.
 *
 * A gene arrives as its dense values over every cell (a field already loaded)
 * or as its non-zero entries `{length, indices, values}` (the source's sparse
 * column, `DataLayer.readGeneColumn`). A sparse gene costs its entries, not
 * the page: a typical 20-gene signature over half a million cells touches
 * about 130,000 entries instead of eleven million values.
 *
 * The scores are exactly those of adding every gene's value cell by cell:
 * - sum and mean accumulate each cell's finite values in single precision,
 *   gene by gene in signature order (an absent sparse entry is a zero, and
 *   adding zero leaves a sum unchanged), then the mean divides by the count
 *   of finite values (NaN when there is none);
 * - median is the median of a cell's finite values, the absent sparse entries
 *   counted as zeros (`medianInPlace`).
 *
 * @module stats/signature-score
 */

import { medianInPlace } from '../compute/math-utils.js';

/**
 * @typedef {{length: number, indices: ArrayLike<number>, values: ArrayLike<number>}} SparseGeneColumn
 */

/**
 * Whether a gene column is a sparse column (`{length, indices, values}`).
 * @param {unknown} column
 * @returns {column is SparseGeneColumn}
 */
export function isSparseGeneColumn(column) {
  return (
    column !== null &&
    typeof column === 'object' &&
    !ArrayBuffer.isView(column) &&
    !Array.isArray(column) &&
    Number.isSafeInteger(column.length) &&
    ArrayBuffer.isView(column.indices) &&
    ArrayBuffer.isView(column.values)
  );
}

/**
 * Scores one page's cells, a gene at a time (`addGene`), then a range of
 * cells at a time (`scoreCells`), so a caller can hand the event loop back
 * between steps.
 */
export class SignaturePageScorer {
  /**
   * @param {Object} options
   * @param {'mean'|'sum'|'median'} options.method
   * @param {number} options.geneCount - Genes that will be added
   * @param {ArrayLike<number>} options.cellIndices - The page's distinct cells
   * @param {number} options.pointCount - Cells in the dataset (column length)
   */
  constructor({ method, geneCount, cellIndices, pointCount }) {
    if (!['mean', 'sum', 'median'].includes(method)) {
      throw new RangeError(`Unsupported signature scoring method: ${String(method)}`);
    }
    if (!Number.isSafeInteger(geneCount) || geneCount < 1) {
      throw new RangeError('A signature needs at least one gene');
    }
    if (!Number.isSafeInteger(pointCount) || pointCount < 0) {
      throw new RangeError('Signature scoring needs the dataset cell count');
    }
    if (!cellIndices || !Number.isSafeInteger(cellIndices.length)) {
      throw new TypeError('Signature page cells must be an array of cell indices');
    }
    for (let p = 0; p < cellIndices.length; p++) {
      const cell = cellIndices[p];
      if (!Number.isSafeInteger(cell) || cell < 0 || cell >= pointCount) {
        throw new RangeError(`Signature page cell ${String(cell)} is outside the dataset`);
      }
    }
    this._method = method;
    this._geneCount = geneCount;
    this._cells = cellIndices;
    this._pointCount = pointCount;
    this._added = 0;
    const size = cellIndices.length;
    this.scores = new Float32Array(size);
    /** Genes without a finite value, per cell. */
    this._missing = new Uint32Array(size);
    /** Position of each dataset cell in the page, built for sparse genes. */
    this._position = null;
    // Median: dense genes are read per cell at the end; sparse entries are
    // collected per cell (in `_entryCells`/`_entryValues`) and their absent
    // entries counted as zeros.
    this._denseColumns = [];
    this._sparseGenes = 0;
    this._entryCells = new Int32Array(0);
    this._entryValues = new Float64Array(0);
    this._entryCount = 0;
  }

  _positions() {
    if (this._position === null) {
      const position = new Int32Array(this._pointCount).fill(-1);
      const cells = this._cells;
      for (let p = 0; p < cells.length; p++) position[cells[p]] = p;
      this._position = position;
    }
    return this._position;
  }

  /**
   * Add the next gene of the signature.
   * @param {ArrayLike<number>|SparseGeneColumn} column - Over every dataset cell
   */
  addGene(column) {
    if (this._added >= this._geneCount) {
      throw new RangeError('More genes were added than the signature has');
    }
    if (column?.length !== this._pointCount) {
      throw new RangeError('A signature gene column must cover every dataset cell');
    }
    this._added++;
    if (isSparseGeneColumn(column)) {
      this._addSparse(column);
    } else {
      this._addDense(column);
    }
  }

  _addDense(column) {
    const cells = this._cells;
    const missing = this._missing;
    if (this._method === 'median') {
      this._denseColumns.push(column);
      return;
    }
    const scores = this.scores;
    for (let p = 0; p < cells.length; p++) {
      const value = column[cells[p]];
      if (Number.isFinite(value)) scores[p] += value;
      else missing[p]++;
    }
  }

  _addSparse({ indices, values }) {
    if (indices.length !== values.length) {
      throw new RangeError('A sparse gene column needs one value per index');
    }
    const position = this._positions();
    const missing = this._missing;
    const median = this._method === 'median';
    if (median) this._sparseGenes++;
    const scores = this.scores;
    const pointCount = this._pointCount;
    for (let e = 0; e < indices.length; e++) {
      const cell = indices[e];
      if (!(cell < pointCount) || !Number.isSafeInteger(cell) || cell < 0) {
        throw new RangeError(`Sparse gene entry cell ${String(cell)} is outside the dataset`);
      }
      const p = position[cell];
      if (p < 0) continue;
      const value = values[e];
      if (median) {
        const at = this._entryCount++;
        if (at === this._entryCells.length) this._growEntries();
        this._entryCells[at] = p;
        this._entryValues[at] = value;
      } else if (Number.isFinite(value)) {
        scores[p] += value;
      } else {
        missing[p]++;
      }
    }
  }

  _growEntries() {
    const capacity = Math.max(1024, this._entryCells.length * 2);
    const cells = new Int32Array(capacity);
    cells.set(this._entryCells);
    const values = new Float64Array(capacity);
    values.set(this._entryValues);
    this._entryCells = cells;
    this._entryValues = values;
  }

  /**
   * Finish the scores of cells `[from, to)` once every gene was added.
   * @param {number} from
   * @param {number} to
   */
  scoreCells(from, to) {
    if (this._added !== this._geneCount) {
      throw new Error('Signature scores need every gene before they are finished');
    }
    if (this._method === 'median') {
      this._medianCells(from, to);
      return;
    }
    const scores = this.scores;
    const missing = this._missing;
    const geneCount = this._geneCount;
    const mean = this._method === 'mean';
    for (let p = from; p < to; p++) {
      const count = geneCount - missing[p];
      if (count === 0) scores[p] = NaN;
      else if (mean) scores[p] = scores[p] / count;
    }
  }

  _groupEntries() {
    if (this._entryOffsets !== undefined) return;
    const size = this._cells.length;
    const offsets = new Uint32Array(size + 1);
    const entryCells = this._entryCells;
    for (let e = 0; e < this._entryCount; e++) offsets[entryCells[e] + 1]++;
    for (let p = 0; p < size; p++) offsets[p + 1] += offsets[p];
    const grouped = new Float64Array(this._entryCount);
    const cursor = offsets.slice(0, size);
    for (let e = 0; e < this._entryCount; e++) {
      grouped[cursor[entryCells[e]]++] = this._entryValues[e];
    }
    this._entryOffsets = offsets;
    this._groupedEntries = grouped;
    this._entryCells = null;
    this._entryValues = null;
    this._buffer = new Float64Array(this._geneCount);
  }

  _medianCells(from, to) {
    this._groupEntries();
    const cells = this._cells;
    const scores = this.scores;
    const dense = this._denseColumns;
    const sparseGenes = this._sparseGenes;
    const offsets = this._entryOffsets;
    const grouped = this._groupedEntries;
    const buffer = this._buffer;
    for (let p = from; p < to; p++) {
      const first = offsets[p];
      const last = offsets[p + 1];
      if (dense.length === 0 && first === last) {
        // Every gene is sparse and absent here: the median of zeros.
        scores[p] = 0;
        continue;
      }
      let present = 0;
      const cell = cells[p];
      for (let g = 0; g < dense.length; g++) {
        const value = dense[g][cell];
        if (Number.isFinite(value)) buffer[present++] = value;
      }
      for (let e = first; e < last; e++) {
        const value = grouped[e];
        if (Number.isFinite(value)) buffer[present++] = value;
      }
      for (let zeros = sparseGenes - (last - first); zeros > 0; zeros--) buffer[present++] = 0;
      // NaN when no gene carried a value for this cell.
      scores[p] = medianInPlace(buffer, present);
    }
  }
}
