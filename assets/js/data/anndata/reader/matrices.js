/**
 * The reader's expression matrices: an element resolved and checked, its
 * column access (the gene index, `matrix-access.js`) opened once and shared
 * by every gene read, its row access, a matrix's cell map, the options its
 * index is built with, which indexes stay and their release.
 *
 * A method group of `AnnDataReader` (`reader.js`), mixed onto its
 * prototype: `this` is the reader. It writes `_matrices` (least recently
 * read first), `_rows`, `_pointerReads` and `_carried`, and its release
 * clears `_keptRuns`, `_storeOrdered` and `_restricted`.
 *
 * @module data/anndata/reader/matrices
 */

import { allocateTypedArray, sparseColumnOf } from '../../sparse-column-index.js';
import { abortReason, awaitWithSignal, SharedWork } from '../../../utils/abort.js';
import { residencyBudgetBytes } from '../../memory-budget.js';
import { isGroup } from '../../../formats/store.js';
import { AnnDataFormatError, attributeValue, child, requireMapping, shapeFromAttribute, shapeOf } from '../elements.js';
import { sparseContract } from '../sparse.js';
import { geneLayoutOf, openMatrixColumns, openMatrixRows, readsThroughRowIndex } from '../matrix-access.js';
import { requirePrefixRows } from '../priority-layout.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { geneLayoutReason } from '../../gene-read-plan.js';
import { openPrefixOf } from '../prefix-reads.js';
import { keptRowsOf, denseOfSparse, composeCellMaps } from '../cell-maps.js';

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

export class AnnDataReaderMatrixMethods {
  /**
   * One expression matrix: its node, its label, its gene and cell counts,
   * and how it is read. `element` is `X`, `raw/X` or `layers/<name>`, of the
   * root or of a modality (`mod/<name>/X`, …). `source` is the matrix whose
   * columns are read (a column window's whole matrix) and `key` its
   * identity, which every element reading it shares; `start` the window's
   * first gene in it; `cells` the modality's cell map, null for the root's.
   * @this {import('../reader.js').AnnDataReader}
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
    // are its kept rows' entry runs in open order (a uniform share of
    // millions of cells is millions of runs and hundreds of megabytes),
    // which a gene read in store order never uses. The matrix as stored was
    // checked when the file was opened.
    const openCellsView = isGroup(node) && typeof node.rowPointersPending === 'function';
    const shape = !isGroup(node)
      ? shapeOf(node, label, 2)
      : openCellsView ? shapeFromAttribute(attributeValue(node, 'shape'), label) : sparseContract(node, format, label).shape;
    const expectedRows = modality === null ? this._nObs : modality.modality.nCells;
    if (shape[0] !== expectedRows) {
      throw new AnnDataFormatError(`${label} has ${formatCountOf(shape[0], 'row')} for ${formatCountOf(expectedRows, 'cell')}`);
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
   * The open cells a read by row names, as view rows, when the store is a
   * view of the open cells (`rowsMatrix`) and they are fewer than every open
   * cell of a dataset's own CSR matrix: then only their rows' pointers are
   * read, and their rows as a matrix of their own (`_rowsOfCells`); null
   * for any other read (every open row's, as `_matrixRows` reads them).
   * Cell exports and cells past a gene sample read a few rows of a view of
   * millions: never every open row's pointers for them.
   * @this {import('../reader.js').AnnDataReader}
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

  /**
   * Row access to the named open cells' rows alone (`_namedRows`), their pointers read.
   * @this {import('../reader.js').AnnDataReader}
   */
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

  /**
   * The row access of one matrix, opened once and shared (`openMatrixRows`).
   * @this {import('../reader.js').AnnDataReader}
   */
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
   * Where each cell sits in the modality one matrix belongs to: an
   * `Int32Array` of rows (-1 where not measured), or null when the rows are
   * the dataset's cells in order (the root's matrices, and a modality that
   * measured every cell in order).
   * @this {import('../reader.js').AnnDataReader}
   */
  async _cellsOf(matrix, readOptions) {
    if (matrix.cells === null) return null;
    const map = await matrix.cells(readOptions);
    return map.identity ? null : map.rows;
  }

  /**
   * The index options of a matrix indexed whole by its rows: started from
   * its index kept in this browser when one covers every open row, else
   * kept once built (`kept-column-index.js`).
   * @this {import('../reader.js').AnnDataReader}
   * @private
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

  /**
   * Options of a background index (`RowMajorColumnIndex`), from the link as measured now.
   * @this {import('../reader.js').AnnDataReader}
   */
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

  /** Release row access (its row pointers). @this {import('../reader.js').AnnDataReader} */
  _releaseRows() {
    this._rows = null;
  }

  /**
   * Start indexing one expression matrix by gene in the background, when its
   * layout needs it (CSR) and the link reads ahead (see `open`), so the first
   * gene shown does not wait for the whole build. A dense matrix is not
   * indexed ahead: its index holds every value, as much memory as the matrix
   * itself (resident at open, for a dataset whose genes may never be
   * shown), so it is built when the first gene is asked for and kept within
   * the column-index budget like any other (measured:
   * 23_decisions_partial_reading.md). Returns at once; a failure reaches
   * the gene reads.
   * @this {import('../reader.js').AnnDataReader}
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
   * `_matrices`); switching matrices settles the others.
   * @this {import('../reader.js').AnnDataReader}
   * @private
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
   * the current matrix's index fit `columnIndex`.
   * @this {import('../reader.js').AnnDataReader}
   * @private
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
   * (`SharedWork`), so one caller canceling never fails the others.
   * @this {import('../reader.js').AnnDataReader}
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
          throw abortReason(signal);
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
   * the gene is read whole.
   * @this {import('../reader.js').AnnDataReader}
   * @private
   */
  async _prefixColumns(columns, resolved, _readOptions) {
    const read = this._prefixReads?.get(resolved.key) ?? null;
    if (columns.readEntries === undefined || read === null) return columns;
    // The counts of the opened level, read as the dataset opened (`startPrefixReads`).
    const prefixRead = await read;
    if (prefixRead === null) return columns;
    const { counts, levelRows } = prefixRead;
    if (counts.length !== resolved.sourceVars) {
      throw new AnnDataFormatError(`varm['cellucid_prefix_counts'] of ${resolved.label} counts ${formatCountOf(counts.length, 'gene')} for ${resolved.sourceVars}; the file is damaged`);
    }
    const k = resolved.prefix;
    /** The entries a read of gene `gene` takes: its counted ones and the next, when it has one. */
    const counted = gene => {
      const held = columns.entryCount(gene);
      if (counts[gene] > held) {
        throw new AnnDataFormatError(`varm['cellucid_prefix_counts'] of ${resolved.label} counts ${formatCountOf(counts[gene], 'value')} of gene ${gene}, which holds ${held}; the file is damaged`);
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

  /** Release one matrix and any index it holds. @this {import('../reader.js').AnnDataReader} */
  _releaseMatrixState(state) {
    if (this._matrices.get(state.element) === state) this._matrices.delete(state.element);
    const columns = state.columns;
    state.columns = null;
    if (columns) (columns.retire ?? columns.dispose)?.();
  }

  /**
   * Release every matrix and the indexes they hold; every release is tried.
   * @this {import('../reader.js').AnnDataReader}
   */
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
}
