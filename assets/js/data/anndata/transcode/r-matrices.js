/**
 * R matrices (features × cells, as Seurat and SingleCellExperiment hold
 * them) presented as AnnData matrices (cells × features), copying nothing
 * when the stored layout already is one:
 *
 * | R | AnnData (cells × features) |
 * | --- | --- |
 * | `dgCMatrix` (column-compressed over cells) | `csr_matrix`: `indptr = @p`, `indices = @i`, `data = @x` |
 * | `ngCMatrix`/`lgCMatrix` (pattern, logical) | the same, `data` all ones / the logicals |
 * | `dgRMatrix` (row-compressed over features) | `csc_matrix`: `indptr = @p`, `indices = @j`, `data = @x` |
 * | `dgTMatrix` (triplets) | `csr_matrix` (`csc_matrix` when stored by feature), sorted by cell in bounded blocks when stored in neither order (`entries.js`) |
 * | dense `matrix` (column-major) | a dense array, row-major cells × features |
 *
 * A matrix whose values live outside the file (a BPCells matrix folder, an
 * HDF5Array/DelayedArray seed) is named with where it points, so the caller
 * can refuse it with what to do.
 *
 * Several pieces of one matrix (Seurat v5 split layers, each over some of
 * the cells and features) are assembled into one compressed matrix
 * (`assembleColumns`). Both read their vectors in slices and write the
 * matrix through the space (`entries.js`): memory holds a block of entries,
 * never the matrix.
 *
 * @module data/anndata/transcode/r-matrices
 */

import {
  attribute,
  classesOf,
  dimOf,
  dimnamesOf,
  isNull,
  packageOf,
  scalarString,
  vectorSlice,
  vectorValues,
  writable,
} from './r-values.js';
import { EntryCollector, SORT_BLOCK_ENTRIES } from './entries.js';
import { allocateTypedArray, copyTypedArray } from '../../sparse-column-index.js';

/**
 * What one R matrix is.
 *
 * @param {Object} node
 * @returns {{kind: 'csc'|'csr'|'coo'|'dense'|'external'|'unknown', nrow?: number, ncol?: number,
 *   rownames?: string[]|null, colnames?: string[]|null, className: string, where?: string}}
 */
export function describeMatrix(node) {
  const className = classesOf(node)[0] ?? node?.kind ?? 'NULL';
  if (isNull(node)) return { kind: 'unknown', className: 'NULL' };
  const [rownames, colnames] = dimnamesOf(node);
  const dim = dimOf(node);
  const base = { className, nrow: dim?.[0] ?? 0, ncol: dim?.[1] ?? 0, rownames, colnames };
  if (node.kind === 'S4') {
    const where = externalLocation(node);
    if (where !== null) return { ...base, kind: 'external', where };
    // Matched by slots, not class: Seurat's Graph and other classes extend dgCMatrix.
    if (/^ds|^dt|^dsy|symmetric/i.test(className)) return { ...base, kind: 'unknown' };
    const p = attribute(node, 'p');
    const i = attribute(node, 'i');
    const j = attribute(node, 'j');
    if (dim === null) return { ...base, kind: 'unknown' };
    if (p !== null && i !== null) return { ...base, kind: 'csc', p, i, x: attribute(node, 'x') };
    if (p !== null && j !== null) return { ...base, kind: 'csr', p, j, x: attribute(node, 'x') };
    if (i !== null && j !== null) return { ...base, kind: 'coo', i, j, x: attribute(node, 'x') };
    return { ...base, kind: 'unknown' };
  }
  if ((node.kind === 'double' || node.kind === 'integer' || node.kind === 'logical') && dim !== null && dim.length === 2) {
    return { ...base, kind: 'dense', className: 'matrix', values: node };
  }
  return { ...base, kind: 'unknown' };
}

/**
 * Where a matrix whose values are outside the file points (a BPCells
 * folder or HDF5 file, an HDF5Array seed's file), or null when it is not
 * such a matrix.
 */
export function externalLocation(node, depth = 0) {
  if (node === null || node === undefined || node.kind !== 'S4' || depth > 16) return null;
  const pkg = packageOf(node);
  const className = classesOf(node)[0] ?? '';
  for (const slot of ['dir', 'path', 'filepath', 'file']) {
    const value = scalarString(attribute(node, slot));
    if (value !== null && (pkg === 'BPCells' || pkg === 'HDF5Array' || /HDF5|MatrixDir|MatrixH5|10xMatrix/.test(className))) {
      return `${className} at ${value}`;
    }
  }
  if (pkg === 'BPCells' || pkg === 'DelayedArray' || pkg === 'HDF5Array' || /^Delayed/.test(className)) {
    for (const slot of ['matrix', 'seed', 'mat', 'matrix_list', 'x']) {
      const inner = attribute(node, slot);
      if (inner?.kind === 'list') {
        for (const element of inner.items ?? []) {
          const found = externalLocation(element, depth + 1);
          if (found !== null) return found;
        }
      }
      const found = externalLocation(inner, depth + 1);
      if (found !== null) return found;
    }
    return `a ${className} (${pkg ?? 'external'}) matrix`;
  }
  return null;
}

/** One AnnData matrix part: `{values}` or `{region, dtype}`. */
function part(node, what) {
  const result = node === null ? null : writable(node);
  if (result === null) throw new Error(`The matrix's ${what} were not kept.`);
  return result;
}

/**
 * An R matrix (features × cells) as an AnnData matrix (cells × features),
 * in the cells' and features' own order.
 *
 * @param {ReturnType<typeof describeMatrix>} matrix
 * @param {{space: Object, readRegion: Function}} context
 * @returns {Promise<{format: 'csr'|'csc'|'dense', shape: [number, number], data: Object, indices?: Object, indptr?: Object}>}
 */
export async function cellsByFeatures(matrix, context) {
  const shape = [matrix.ncol, matrix.nrow];
  if (matrix.kind === 'csc') {
    return {
      format: 'csr',
      shape,
      indptr: part(matrix.p, 'column pointers'),
      indices: part(matrix.i, 'row indices'),
      data: await valuesPart(matrix.x, matrix.i, context),
    };
  }
  if (matrix.kind === 'csr') {
    return {
      format: 'csc',
      shape,
      indptr: part(matrix.p, 'row pointers'),
      indices: part(matrix.j, 'column indices'),
      data: await valuesPart(matrix.x, matrix.j, context),
    };
  }
  if (matrix.kind === 'dense') {
    const values = part(matrix.values, 'values');
    if (matrix.values.kind === 'logical') {
      const numbers = await vectorValues(matrix.values, context);
      return { format: 'dense', shape, data: { values: logicalNumbers(Float32Array, numbers) } };
    }
    return { format: 'dense', shape, data: values };
  }
  if (matrix.kind === 'coo') {
    const count = matrix.i.length;
    const collector = await EntryCollector.open(context.space, {
      nCells: matrix.ncol, nFeatures: matrix.nrow, entries: count, Values: Float64Array, signal: context.signal,
    });
    for (let from = 0; from < count; from += SORT_BLOCK_ENTRIES) {
      const take = Math.min(SORT_BLOCK_ENTRIES, count - from);
      const rows = await vectorSlice(matrix.i, from, take, context);
      const columns = await vectorSlice(matrix.j, from, take, context);
      const values = await sliceOfValues(matrix.x, from, take, context);
      for (let k = 0; k < take; k++) collector.add(columns[k], rows[k], values === null ? 1 : values[k]);
    }
    return collector.finish();
  }
  throw new Error(`a ${matrix.className} is not a matrix Cellucid reads`);
}

/** A sparse matrix's values; a pattern matrix (no `@x`) is all ones, a logical one 0/1. */
async function valuesPart(x, indices, context) {
  if (x === null || isNull(x)) {
    const count = indices.length;
    return { values: allocateTypedArray(Float32Array, count, 'A pattern matrix').fill(1) };
  }
  if (x.kind === 'logical') {
    const numbers = await vectorValues(x, context);
    return { values: logicalNumbers(Float32Array, numbers) };
  }
  return part(x, 'values');
}

/** Values `[from, from + count)` of a sparse matrix's `@x` (null: a pattern matrix, all ones; logical NA: NaN). */
async function sliceOfValues(x, from, count, context) {
  if (x === null || isNull(x)) return null;
  const values = await vectorSlice(x, from, count, context);
  if (x.kind !== 'logical') return values;
  return logicalNumbers(Float64Array, values);
}

/** A logical vector's values as numbers of `ArrayType`, NA as NaN. */
function logicalNumbers(ArrayType, numbers) {
  const out = allocateTypedArray(ArrayType, numbers.length, 'A logical matrix');
  for (let i = 0; i < numbers.length; i++) out[i] = numbers[i] === -2147483648 ? NaN : numbers[i];
  return out;
}

/**
 * Assemble one cells × features compressed matrix from pieces of an R
 * matrix (each a `dgCMatrix` over some cells and features, columns = cells),
 * as Seurat v5 split layers are, in one streaming pass: the cells are taken
 * in blocks of about `SORT_BLOCK_ENTRIES` entries, and each piece gives a
 * block the run of its columns that falls in it (its columns' cells rise),
 * read as one slice of `@i` and `@x`; the block is written in cell order
 * (features in order within a cell) and dropped. Memory holds one block,
 * never the matrix. Pieces whose cells do not rise are collected by cell
 * instead (`EntryCollector`).
 *
 * @param {Array<{matrix: Object, cells: Int32Array, features: Int32Array|null}>} pieces
 *   Each piece's matrix, the position of each of its columns among the
 *   assembled cells (-1: not among them), and of each of its rows among the
 *   assembled features (null: the same features in the same order)
 * @param {number} nCells
 * @param {number} nFeatures
 * @param {{space: Object, readRegion: Function, signal?: AbortSignal|null}} context
 * @param {{blockEntries?: number}} [options] - The block size (tests make it small)
 * @returns {Promise<Object>} An AnnData `csr_matrix` part set
 */
export async function assembleColumns(pieces, nCells, nFeatures, context, { blockEntries = SORT_BLOCK_ENTRIES } = {}) {
  const loaded = [];
  let entries = 0;
  let rising = true;
  const counts = allocateTypedArray(Float64Array, nCells, 'Entries per cell');
  for (const piece of pieces) {
    const p = await vectorValues(piece.matrix.p, context);
    let last = -1;
    for (let column = 0; column < piece.cells.length; column++) {
      const cell = piece.cells[column];
      if (cell < 0) continue;
      if (cell <= last) rising = false;
      last = cell;
      counts[cell] += p[column + 1] - p[column];
      entries += p[column + 1] - p[column];
    }
    loaded.push({ ...piece, p });
  }
  if (!rising) return collectColumns(loaded, nCells, nFeatures, entries, context);
  const pointers = allocateTypedArray(Float64Array, nCells + 1, 'Matrix pointers');
  for (let cell = 0; cell < nCells; cell++) pointers[cell + 1] = pointers[cell] + counts[cell];
  const indicesWriter = await context.space.sink.open(entries * 4);
  const dataWriter = await context.space.sink.open(entries * 8);
  // Each piece's first column not yet written.
  const cursors = loaded.map(() => 0);
  for (let first = 0; first < nCells;) {
    if (context.signal?.aborted) throw context.signal.reason ?? new DOMException('The read was aborted.', 'AbortError');
    // The block: consecutive cells, at most `blockEntries` entries (or one cell).
    let end = first + 1;
    while (end < nCells && pointers[end + 1] - pointers[first] <= blockEntries) end++;
    const base = pointers[first];
    const size = pointers[end] - base;
    const indices = allocateTypedArray(Int32Array, size, 'Matrix entries');
    const data = allocateTypedArray(Float64Array, size, 'Matrix entries');
    const filled = allocateTypedArray(Float64Array, end - first, 'Matrix pointers');
    let interleaved = false;
    for (let q = 0; q < loaded.length; q++) {
      const { p, cells, features, matrix } = loaded[q];
      let from = cursors[q];
      while (from < cells.length && cells[from] < 0) from++;
      let to = from;
      while (to < cells.length && (cells[to] < 0 || cells[to] < end)) to++;
      cursors[q] = to;
      if (p[to] === p[from]) continue;
      const rows = await vectorSlice(matrix.i, p[from], p[to] - p[from], context);
      const values = await sliceOfValues(matrix.x, p[from], p[to] - p[from], context);
      for (let column = from; column < to; column++) {
        const cell = cells[column];
        if (cell < 0) continue;
        if (filled[cell - first] > 0) interleaved = true;
        let at = pointers[cell] - base + filled[cell - first];
        for (let k = p[column] - p[from]; k < p[column + 1] - p[from]; k++) {
          indices[at] = features === null ? rows[k] : features[rows[k]];
          data[at] = values === null ? 1 : values[k];
          at++;
        }
        filled[cell - first] += p[column + 1] - p[column];
      }
    }
    // Features in order within a cell (a piece's features remapped, or a
    // cell held by several pieces).
    if (interleaved || loaded.some(piece => piece.features !== null)) {
      for (let cell = first; cell < end; cell++) sortCellEntries(indices, data, pointers[cell] - base, pointers[cell + 1] - base);
    }
    await indicesWriter.write(new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength));
    await dataWriter.write(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    first = end;
  }
  return {
    format: 'csr',
    shape: [nCells, nFeatures],
    indptr: { values: entries < 2 ** 31 ? copyTypedArray(Int32Array, pointers, 'Matrix pointers') : pointers },
    indices: { region: await indicesWriter.close(), dtype: '<i4' },
    data: { region: await dataWriter.close(), dtype: '<f8' },
  };
}

/** Sort one cell's entries `[start, end)` by feature, when they are not in order. */
function sortCellEntries(indices, data, start, end) {
  let ordered = true;
  for (let k = start + 1; k < end && ordered; k++) ordered = indices[k - 1] <= indices[k];
  if (ordered) return;
  const order = allocateTypedArray(Int32Array, end - start, 'Cell entry order');
  for (let k = 0; k < order.length; k++) order[k] = start + k;
  order.sort((a, b) => indices[a] - indices[b] || a - b);
  const sortedIndices = allocateTypedArray(Int32Array, order.length, 'Matrix entries');
  const sortedData = allocateTypedArray(Float64Array, order.length, 'Matrix entries');
  for (let k = 0; k < order.length; k++) {
    sortedIndices[k] = indices[order[k]];
    sortedData[k] = data[order[k]];
  }
  indices.set(sortedIndices, start);
  data.set(sortedData, start);
}

/** Pieces in any cell order, collected by cell (`EntryCollector`). */
async function collectColumns(loaded, nCells, nFeatures, entries, context) {
  const collector = await EntryCollector.open(context.space, {
    nCells, nFeatures, entries, Values: Float64Array, signal: context.signal,
  });
  for (const piece of loaded) {
    const { p, cells, features } = piece;
    const total = p[cells.length];
    let column = 0;
    for (let from = 0; from < total; from += SORT_BLOCK_ENTRIES) {
      const take = Math.min(SORT_BLOCK_ENTRIES, total - from);
      const rows = await vectorSlice(piece.matrix.i, from, take, context);
      const values = await sliceOfValues(piece.matrix.x, from, take, context);
      for (let k = 0; k < take; k++) {
        const entry = from + k;
        while (entry >= p[column + 1]) column++;
        const cell = cells[column];
        if (cell < 0) continue;
        collector.add(cell, features === null ? rows[k] : features[rows[k]], values === null ? 1 : values[k]);
      }
    }
  }
  return collector.finish();
}
