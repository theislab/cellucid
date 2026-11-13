/**
 * The reader's rows of cells, as an export reads them: what reading some
 * cells' rows costs before it is read, and the rows themselves (all genes
 * or a window of them, by rows or through the gene index). The matrices'
 * access is the matrices' (`matrices.js`); this group only reads through it.
 *
 * A method group of `AnnDataReader` (`reader.js`), mixed onto its
 * prototype: `this` is the reader. It writes no field.
 *
 * @module data/anndata/reader/matrix-rows
 */

import { allocateTypedArray } from '../../sparse-column-index.js';
import { isGroup } from '../../../formats/store.js';
import { encodingType } from '../elements.js';
import { SLAB_BYTES } from '../values.js';
import { firstGeneReadCost, geneReadMs, linkPriced, linkReadMs } from '../subsample-plan.js';
import { pricingLink } from '../../host-link-memory.js';
import { formatCountOf } from '../../../utils/format-units.js';

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

export class AnnDataReaderMatrixRowMethods {
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
   * @this {import('../reader.js').AnnDataReader}
   * @param {string} element
   * @param {ArrayLike<number>} cells
   * @returns {Promise<{cells: number, bytes: number, keptBytes: number, requests: number, ms: number|null,
   *   linkMs: number|null, decodedBytes: number}|null>}
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
      decodedChunkBytes: this._decodedChunkBytes,
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
   * The non-zero genes of cells (rows) of one matrix, in the order asked,
   * all at once: `readMatrixRows`'s parts gathered, each row a view of its
   * part.
   *
   * @this {import('../reader.js').AnnDataReader}
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
   * @this {import('../reader.js').AnnDataReader}
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
      /** @type {Array<[number, number]>} */
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
        this._assertGeneration(generation, `loading ${formatCountOf(positions.length, 'cell row')} of ${label}`);
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
   * gene and array at a 1% share), any other matrix each gene's entries,
   * keeping the cells' -- in runs of consecutive genes of about a slab of
   * stored entries (`SLAB_BYTES`, 8 bytes an entry), two runs read at once;
   * then made rows (genes ascending) and handed out in parts of about
   * `partEntries` entries, in the order asked. What it holds is the cells'
   * entries, the rows it hands out, and a run's reads, never an index of
   * every stored row: through one, a few thousand cells of a small share of
   * a priority-ordered file decode every chunk of X (measured:
   * 25_decisions_exports.md).
   * A cell named twice is handed out twice; one a modality did not measure
   * has no entries.
   * @this {import('../reader.js').AnnDataReader}
   * @private
   */
  async _rowsByGenes(element, matrix, positions, { signal, partEntries, onPart, generation }) {
    const { label, nVars } = matrix;
    // The distinct cells, ascending: what the subset reads.
    const cells = positions.slice().sort();
    let distinct = 0;
    for (let i = 0; i < cells.length; i++) if (i === 0 || cells[i] !== cells[i - 1]) cells[distinct++] = cells[i];
    const asked = cells.subarray(0, distinct);
    // Runs of consecutive genes, each about a slab of stored entries.
    /** @type {Array<[number, number]>} */
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
      this._assertGeneration(generation, `loading ${formatCountOf(positions.length, 'cell row')} of ${label}`);
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
}
