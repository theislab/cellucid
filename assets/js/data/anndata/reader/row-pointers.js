/**
 * The reader's row pointers of cell-major (CSR) matrices: a matrix's open
 * rows readied before a read (their pointers read, a subsample view's or
 * the stored ones), the first rows of a matrix as a matrix of their own,
 * and the kept values the open rows hold.
 *
 * A method group of `AnnDataReader` (`reader.js`), mixed onto its
 * prototype: `this` is the reader. It writes `_indptrs`, `_indptrPrefixes`
 * and `_pointerActivities`, and sets `keptValues` and `matrixChunkShare` on
 * `_cellSubset` (`_noteKeptValues`).
 *
 * @module data/anndata/reader/row-pointers
 */

import { allocateTypedArray } from '../../sparse-column-index.js';
import { isGroup } from '../../../formats/store.js';
import { AnnDataFormatError, child, encodingType } from '../elements.js';
import { readIntegers } from '../values.js';
import { keptValueStats } from '../views/cell-subset.js';
import { readRowPointers } from '../prefix-column-index.js';
import { formatCountOf } from '../../../utils/format-units.js';

export class AnnDataReaderRowPointerMethods {
  /**
   * Make a matrix ready for a gene read (`_readyRows` with the gene
   * sample's rows), unless its genes are read through every stored row's
   * index restricted to the open rows (`_restrictsWhole`): that reads the
   * stored row pointers itself, and the open rows' are never needed (a
   * uniform share's are millions of runs to read and walk).
   * @this {import('../reader.js').AnnDataReader}
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
   * The stored row pointers of a CSR matrix (every stored row's, whatever
   * cells are open; null for a dense one), read once and kept with the
   * store's (`_indptrs`: a later opening of every cell, or a share's view,
   * takes them over).
   * @this {import('../reader.js').AnnDataReader}
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
   * The row pointers of a CSR matrix as open (null for a dense one): a
   * subsample view's, in memory, else the stored ones, kept (they do not
   * depend on the cells).
   * @this {import('../reader.js').AnnDataReader}
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
   * `rows + 1` -- never every open row's: reading the whole `X/indptr` of
   * an atlas before its first gene costs megabytes and thousands of
   * requests (measured: 23_decisions_partial_reading.md). Every open row is
   * the matrix as open.
   * @this {import('../reader.js').AnnDataReader}
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
   * (`_indptrPrefixes`) and the pointers after it it lacks.
   * @this {import('../reader.js').AnnDataReader}
   * @private
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
    if (pointers[0] !== 0) throw new AnnDataFormatError(`${matrix.path} indptr must start at zero`);
    for (let i = Math.max(1, from); i <= rows; i++) {
      if (!(pointers[i] >= pointers[i - 1]) || pointers[i] > nnz) throw new AnnDataFormatError(`${matrix.path} indptr must be monotonic and within its ${formatCountOf(nnz, 'stored value')}`);
    }
    // Another read may have taken more meanwhile: the longer prefix is kept.
    if ((this._indptrPrefixes.get(matrix.path)?.length ?? 0) < pointers.length) this._indptrPrefixes.set(matrix.path, pointers);
    return pointers;
  }

  /**
   * The open rows a gene read of `element` needs the row pointers of: the
   * gene sample's (`_geneRows`) when it is fewer than every open row, else
   * null (every open row's).
   * @this {import('../reader.js').AnnDataReader}
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
   * Make a matrix of a subsample ready to be read: its kept rows' pointers,
   * when it is a CSR matrix on the cell axis (`cellSubsetView`
   * `readRowPointers`; nothing for any other matrix, or when every cell is
   * open: null, so a read of every cell waits for nothing). `X`'s also
   * give the subsample's kept values and the share of X's index chunks they
   * lie in (`cellSubset`).
   * @this {import('../reader.js').AnnDataReader}
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
   * The subsample's kept values of the expression matrix genes are read
   * from (`_expression`), once its kept rows' pointers are read.
   * @this {import('../reader.js').AnnDataReader}
   * @private
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
}
