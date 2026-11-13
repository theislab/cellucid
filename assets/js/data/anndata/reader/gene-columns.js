/**
 * The reader's gene columns: one gene or several, dense or sparse, on the
 * open cells (placed through a cell map, `cell-maps.js`), read through the
 * matrix's column access, by rows where that reads less, or from a
 * priority-ordered file's prefix counts.
 *
 * A method group of `AnnDataReader` (`reader.js`), mixed onto its
 * prototype: `this` is the reader. It writes `_levelCounts`.
 *
 * @module data/anndata/reader/gene-columns
 */

import { allocateTypedArray, sparseColumnOf, sparseColumnOfDense } from '../../sparse-column-index.js';
import { AnnDataFormatError } from '../elements.js';
import { readPrefixCounts, requirePrefixRows } from '../priority-layout.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { requirePositions } from '../positions.js';
import { placeColumn, placeSparseColumn, denseOfSparse } from '../cell-maps.js';

export class AnnDataReaderGeneColumnMethods {
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
   * @this {import('../reader.js').AnnDataReader}
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
   * @this {import('../reader.js').AnnDataReader}
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
      this._assertGeneration(generation, `loading ${formatCountOf(positions.length, 'gene column')} of ${label}`);
      return result;
    }, signal, owner, keys);
  }

  /**
   * One gene column on open cells `[start, end)` only, reading no more than
   * the layout needs for them: a cell-major matrix indexed in segments
   * (`prefix-column-index.js`) reads the segments those cells lie in; the
   * gene-major X of a priority-ordered file opened as a prefix reads the
   * gene's entries between the prefix-count levels around the rows
   * (`_prefixEntryRows`). Any other matrix is read whole and cut.
   * @this {import('../reader.js').AnnDataReader}
   * @private
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
   * @this {import('../reader.js').AnnDataReader}
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
   * priority-ordered file opened whole or by a prefix.
   * @this {import('../reader.js').AnnDataReader}
   * @private
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
   * of them is no cheaper than the gene's column.
   * @this {import('../reader.js').AnnDataReader}
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
   * file has no counts. The rows' entries (`SparseColumn`).
   * @this {import('../reader.js').AnnDataReader}
   * @private
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
        throw new AnnDataFormatError(`varm['cellucid_prefix_counts'] of ${matrix.label} counts ${formatCountOf(counts[gene], 'value')} of gene ${gene} at level ${level}, which holds ${held}; the file is damaged`);
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
      throw new AnnDataFormatError(`varm['cellucid_prefix_counts'] of ${matrix.label} counts ${formatCountOf(lower[gene], 'value')} of gene ${gene} below ${formatCountOf(levels[below], 'row')}, and the next is at row ${checked.rows[0]}; the file is damaged`);
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
   * @this {import('../reader.js').AnnDataReader}
   * @private
   */
  _prefixLevelCounts(matrix, level, readOptions) {
    const key = `${matrix.key}:${level}`;
    let read = this._levelCounts.get(key);
    if (read === undefined) {
      const group = matrix.key === 'X' ? this._fullRoot ?? this._root : null;
      read = group === null ? Promise.resolve(null) : readPrefixCounts(group, level, matrix.sourceVars, { signal: readOptions.signal ?? null, activity: readOptions.activity ?? null }, { levelRows: this._cellSubset.levels[level] });
      read.catch(() => this._levelCounts.delete(key));
      this._levelCounts.set(key, read);
    }
    return read;
  }

  /**
   * One gene column on the dataset's cells. A matrix read through a
   * subsample's kept rows (`throughCells`) is read as its non-zero entries
   * and made dense on the kept cells, never at its stored length.
   * @this {import('../reader.js').AnnDataReader}
   * @private
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
   * computes from, many times fewer bytes than the dense column of a median
   * gene (measured: 23_decisions_partial_reading.md). The values are the dense column's, bit for bit. An
   * analysis's read (kind `analysis`): its job (`owner`) shows it.
   *
   * @this {import('../reader.js').AnnDataReader}
   * @param {string} element
   * @param {ReadonlyArray<number>} genes
   * @param {{signal?: AbortSignal|null, owner?: string|null}} [options] -
   *   `signal` cancels the read; `owner` is the job it reads for
   * @returns {Promise<Array<import('../../sparse-column-index.js').SparseColumn>>}
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
      this._assertGeneration(generation, `loading ${formatCountOf(positions.length, 'gene column')} of ${label}`);
      return result;
    }, signal, owner);
  }
}
