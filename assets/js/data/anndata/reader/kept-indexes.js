/**
 * The reader's gene indexes kept in this browser (`kept-column-index.js`):
 * the runs a matrix's index was kept in, found for an opening and taken by
 * its index, and the runs it builds kept as they are built.
 *
 * A method group of `AnnDataReader` (`reader.js`), mixed onto its
 * prototype: `this` is the reader. It writes `_keptRuns`, `_keeping` and
 * `_keptRunDirectories`.
 *
 * @module data/anndata/reader/kept-indexes
 */

import { allocateTypedArray, copyTypedArray } from '../../sparse-column-index.js';
import { isGroup } from '../../../formats/store.js';
import { child } from '../elements.js';
import { openOrderSpecOf } from '../subsample-plan.js';
import { sortUint32 } from '../../../utils/radix-order.js';
import { findKeptRuns, keepRun, keptIndexGroup, orderKey } from '../kept-column-index.js';

export class AnnDataReaderKeptIndexMethods {
  /**
   * Every stored row's index of a matrix kept in this browser by an opening
   * of every cell (or a share that built it, `_restrictsWhole`), taken, or
   * null.
   * @this {import('../reader.js').AnnDataReader}
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
   * The file rows of the open rows of a matrix whose index can be kept in
   * this browser (`kept-column-index.js`): the dataset's own matrices read
   * whole by their rows (all open rows, in the order they are open), and a
   * modality's when every cell is open; null for any other (a column
   * window, a subsample's gene-major matrix read through its rows, a
   * modality's rows of a subsample).
   * @this {import('../reader.js').AnnDataReader}
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
   * an opening of every cell files it.
   * @this {import('../reader.js').AnnDataReader}
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
   * left for another opening, unchecked.
   * @this {import('../reader.js').AnnDataReader}
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

  /**
   * The kept runs of a matrix's index, taken by the index that starts from them (the caller releases what it does not use).
   * @this {import('../reader.js').AnnDataReader}
   */
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
   * pointers the stored ones.
   * @this {import('../reader.js').AnnDataReader}
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
   * @this {import('../reader.js').AnnDataReader}
   */
  async whenIndexesKept() {
    while (this._keeping.size > 0) await Promise.all([...this._keeping]);
  }
}
