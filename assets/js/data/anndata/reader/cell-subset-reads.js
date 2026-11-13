/**
 * The reader's reads of some cells' genes, as an analysis makes them: the
 * genes of a cell subset as a gene-major block (`cell-subset-blocks.js`),
 * the cells checked once for a run's later reads, a subset read in store
 * order, every gene of a run's cells kept for its later reads, and what
 * that holds.
 *
 * A method group of `AnnDataReader` (`reader.js`), mixed onto its
 * prototype: `this` is the reader. It writes `_cellSubsetGenes`,
 * `_cellSubsetRowsCost` and `_cellSubsetChecked` (which `clearCache` and
 * `trimResident` reset).
 *
 * @module data/anndata/reader/cell-subset-reads
 */

import { allocateTypedArray } from '../../sparse-column-index.js';
import { residencyBudgetBytes, typedArrayBytes } from '../../memory-budget.js';
import { isGroup } from '../../../formats/store.js';
import { encodingType } from '../elements.js';
import { sparseContract } from '../sparse.js';
import { cellSubsetRunCosts, openMatrixRows, readCellSubset } from '../matrix-access.js';
import { orderByKey, sortByKeyWithValues } from '../../../utils/radix-order.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { requirePositions, requireDistinctCells, sameCells } from '../positions.js';
import { genesOfCellSubset, placeCellSubset, cellSubsetOfSparseColumns } from '../cell-subset-blocks.js';

export class AnnDataReaderCellSubsetMethods {
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
   * is cheaper (a differential expression over a large CSR file makes
   * hundreds of reads of the same cells: 23_decisions_partial_reading.md).
   *
   * @this {import('../reader.js').AnnDataReader}
   * @param {string} element
   * @param {ReadonlyArray<number>|Uint32Array} cells - Distinct cell positions
   * @param {ReadonlyArray<number>|Uint32Array} genes - Distinct gene positions
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
    // made and its coverage walked again each read, which at millions of
    // cells costs a large share of a run (measured:
    // 23_decisions_partial_reading.md).
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
   * A cell subset's positions checked (`requireDistinctCells`) with its
   * largest (`last`, -1 for none), kept for the reads after: a run reads the
   * same cells for every batch of its genes (a differential expression of
   * two large groups: hundreds of reads of millions of cells), and walking
   * them several times a read (checked, bounded by the gene sample, by the
   * rows read, by a prefix) would be most of what the reader does for the
   * run (measured: 23_decisions_partial_reading.md).
   * @this {import('../reader.js').AnnDataReader}
   * @private
   */
  _checkedCells(cells, label) {
    const checked = requireDistinctCells(cells, this._nObs, label);
    let last = -1;
    for (let k = 0; k < checked.length; k++) if (checked[k] > last) last = checked[k];
    this._cellSubsetChecked = { generation: this._generation, nObs: this._nObs, cells: checked, last };
    return this._cellSubsetChecked;
  }

  /**
   * The checked cells (`_checkedCells`) when `cells` are the same cells in the same order, else null: one comparison.
   * @this {import('../reader.js').AnnDataReader}
   * @private
   */
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
   * chunk again, so a large group of a half share reads the file several
   * times over (measured: 23_decisions_partial_reading.md). Any other
   * matrix is read as `rows` reads.
   * @this {import('../reader.js').AnnDataReader}
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

  /**
   * Every gene of `cells` kept (`_keptCellSubset`) and read already, or null.
   * @this {import('../reader.js').AnnDataReader}
   * @private
   */
  _heldCellSubset(element, cells, generation) {
    const kept = this._cellSubsetGenes;
    if (kept === null || kept.refused || kept.block === null) return null;
    return kept.element === element && kept.generation === generation && sameCells(kept.cells, cells) ? kept.block : null;
  }

  /**
   * Every gene of `cells` read once by their rows and kept, when the run
   * reading them (`keep`: it has more reads of these cells to make, and
   * keeping them costs it the least, `getMatrixCellSubset`) starts, and
   * used by every later read of the same cells: a read is a copy out of the
   * cells' genes held once (their stored entries, 8 bytes each), not a
   * re-read of the cells' whole rows (a run makes hundreds of such reads).
   * Held within the `columnIndex` share beside what is held there
   * (`_heldBytes`; trimmed first by `trimResident`); not kept when they
   * would not fit, or when the device refuses the memory (the run then reads
   * by its other routes, and is not offered keeping again). Null when not
   * kept.
   * @this {import('../reader.js').AnnDataReader}
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
   * pass is what keeps the two from being held at once past the share (at
   * tens of millions of cells both together exceed the reader's memory:
   * 27_decisions_memory_model.md).
   * @this {import('../reader.js').AnnDataReader}
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
   * a read (it orders and walks every cell). Infinity without rows.
   * @this {import('../reader.js').AnnDataReader}
   * @private
   */
  _rowsCostOf(element, generation, rows, cells) {
    if (rows?.subset === undefined) return Infinity;
    const priced = this._cellSubsetRowsCost;
    if (priced !== null && priced.element === element && priced.generation === generation && priced.rows === rows && sameCells(priced.cells, cells)) return priced.cost;
    const cost = rows.readCost(cells);
    this._cellSubsetRowsCost = { element, generation, rows, cells, cost };
    return cost;
  }

  /** The bytes of the cells' genes kept (`_keptCellSubset`). @this {import('../reader.js').AnnDataReader} */
  _cellSubsetBytes() {
    const block = this._cellSubsetGenes?.block ?? null;
    const checked = this._cellSubsetChecked?.cells ?? null;
    // The kept genes' cells are the checked cells (`_keptCellSubset` keeps them): counted once.
    const cells = checked === null || checked === this._cellSubsetGenes?.cells ? 0 : typedArrayBytes(checked);
    return cells + (block === null ? 0 : typedArrayBytes(block.pointers) + typedArrayBytes(block.cellIndex) + typedArrayBytes(block.values));
  }
}
