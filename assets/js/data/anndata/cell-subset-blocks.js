/**
 * The gene-major sparse blocks a read of some cells' genes answers with
 * (`getMatrixCellSubset`): some genes of a block that holds every gene
 * (`genesOfCellSubset`), a modality's block placed over the cells of the
 * whole request (`placeCellSubset`), and a block made of sparse gene
 * columns (`cellSubsetOfSparseColumns`). Functions of the blocks they are
 * given; reading them is the reader's.
 *
 * @module data/anndata/cell-subset-blocks
 */

import { allocateTypedArray } from '../sparse-column-index.js';

/** Genes `genes` (positions in the matrix) of a cell subset holding every gene in order. */
export function genesOfCellSubset(block, genes) {
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

/**
 * A cell subset read over the cells a modality measured (`measured`: their
 * positions in the request, ascending) as the block of the whole request:
 * positions renumbered, and a NaN entry for every cell it did not measure.
 */
export function placeCellSubset(block, measured, cellCount) {
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
export function cellSubsetOfSparseColumns(columns, cells) {
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
  // cell. Walking every cell for every gene costs milliseconds a gene
  // however few entries it holds, minutes over a whole run's genes
  // (measured: 23_decisions_partial_reading.md).
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
