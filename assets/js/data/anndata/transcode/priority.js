/**
 * A transcoded store in priority order: the layout `prepare()` and
 * `cellucid_prepare()` write (`../priority-layout.js`; the Cellucid-ready
 * AnnData specification), so a subsample of a converted R object or
 * MatrixMarket folder is the first rows of every array, read as a prefix.
 *
 * Row `r` of every per-cell array is the cell of the `r`-th lowest `uniform`
 * rank under `TRANSCODED_PRIORITY_SEED` (`../../subsample.js`), its position
 * in the file (the order the object holds its cells) recorded in
 * `obs['cellucid_original_position']`; `uns['cellucid']['priority']` names
 * the seed, the specification's version, the cell count and the prefix
 * levels; the
 * expression matrix is stored by feature with each gene's rows ascending,
 * and `varm['cellucid_prefix_counts']` gives each gene's values below every
 * level. Every boundary still names a cell by its original position (the
 * object's own order), through the reader's cell identity.
 *
 * What it costs: the permutation is one more pass over each per-cell array
 * while the store is written (sparse matrices in bounded memory,
 * `entries.js`), once per file -- a kept store opens without it on later
 * visits. An uncompressed R file is the exception: its arrays are read in
 * place from the file, never copied, so its cells keep the object's order
 * (`writeModel` with `ordered: false`) and a subsample reads it in blocks,
 * as any file read in place.
 *
 * @module data/anndata/transcode/priority
 */

import { DEFAULT_SUBSAMPLE_SEED, SUBSAMPLE_SPEC_VERSION, priorityOrder } from '../../subsample.js';
import { byFeature, majorInOrder } from './entries.js';
import { prefixLevels } from '../priority-layout.js';
import { allocateTypedArray } from '../../sparse-column-index.js';

/** The seed of a transcoded store's priority order: the specification's default. */
export const TRANSCODED_PRIORITY_SEED = DEFAULT_SUBSAMPLE_SEED;

/**
 * The priority order of `nObs` cells: `order[r]` the original position at
 * row `r`, `position[p]` the row of original position `p`.
 *
 * @param {number} nObs
 * @param {number} [seed]
 * @returns {{seed: number, order: Uint32Array, position: Uint32Array, levels: number[]}}
 */
export function cellPriority(nObs, seed = TRANSCODED_PRIORITY_SEED) {
  const all = allocateTypedArray(Uint32Array, nObs, 'Cell priority order');
  for (let i = 0; i < nObs; i++) all[i] = i;
  const order = priorityOrder({ method: 'uniform', seed }, all);
  return { seed, order, position: inverseOf(order), levels: prefixLevels(nObs) };
}

/** The inverse of a permutation. */
export function inverseOf(order) {
  const inverse = allocateTypedArray(Uint32Array, order.length, 'Cell priority positions');
  for (let i = 0; i < order.length; i++) inverse[order[i]] = i;
  return inverse;
}

/**
 * The rows of one modality measured on some cells, in the order of their
 * cells' global rows: `order[r]` the modality row placed at row `r`,
 * `position` its inverse, `levels` the modality's rows below each global
 * level (so a global prefix of cells is a prefix of the modality).
 *
 * @param {Uint32Array} globalRowOf - the global row of each modality row's cell
 * @param {number[]} globalLevels
 */
export function modalityPriority(globalRowOf, globalLevels) {
  const rows = Array.from(globalRowOf.keys()).sort((a, b) => globalRowOf[a] - globalRowOf[b]);
  const order = Uint32Array.from(rows);
  const placed = Float64Array.from(order, row => globalRowOf[row]);
  const levels = globalLevels.map(level => {
    let low = 0;
    let high = placed.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (placed[middle] < level) low = middle + 1;
      else high = middle;
    }
    return low;
  });
  return { order, position: inverseOf(order), levels };
}

/** `values` (one item of `width` elements per row, rows contiguous) with its rows in `order`. */
function rowsOf(values, order, width = 1) {
  const out = allocateTypedArray(values.constructor, order.length * width, 'Per-cell values in priority order');
  if (width === 1) {
    for (let r = 0; r < order.length; r++) out[r] = values[order[r]];
    return out;
  }
  for (let r = 0; r < order.length; r++) out.set(values.subarray(order[r] * width, (order[r] + 1) * width), r * width);
  return out;
}

/** Bytes of `itemSize`-byte items (any byte order) with the items in `order`. */
function itemsOf(bytes, itemSize, order) {
  const out = allocateTypedArray(Uint8Array, order.length * itemSize, 'Per-cell values in priority order');
  for (let r = 0; r < order.length; r++) out.set(bytes.subarray(order[r] * itemSize, (order[r] + 1) * itemSize), r * itemSize);
  return out;
}

const ITEM_BYTES = { b1: 1, i1: 1, u1: 1, i2: 2, u2: 2, i4: 4, u4: 4, f4: 4, i8: 8, u8: 8, f8: 8 };

const HOST_TYPES = { i1: Int8Array, u1: Uint8Array, i2: Int16Array, i4: Int32Array, u4: Uint32Array, f4: Float32Array, f8: Float64Array };

/** A region's values (R's big-endian doubles and integers) as a host-order typed array. */
async function hostValues(part, readRegion) {
  const kind = part.dtype.slice(1);
  const Type = HOST_TYPES[kind];
  if (Type === undefined) throw new TypeError(`A per-cell array of dtype '${part.dtype}' cannot be put in priority order.`);
  const bytes = await readRegion(part.region);
  const count = bytes.byteLength / Type.BYTES_PER_ELEMENT;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = part.dtype[0] !== '>';
  const out = allocateTypedArray(Type, count, 'Per-cell values');
  const width = Type.BYTES_PER_ELEMENT;
  const get = {
    i1: k => view.getInt8(k), u1: k => view.getUint8(k), i2: k => view.getInt16(k * 2, little),
    i4: k => view.getInt32(k * 4, little), u4: k => view.getUint32(k * 4, little),
    f4: k => view.getFloat32(k * 4, little), f8: k => view.getFloat64(k * 8, little),
  }[kind];
  for (let k = 0; k < count; k++) out[k] = get(k);
  return out;
}

/**
 * One dataframe column (a kind `zarr-writer.js` writes) with its rows in
 * `order`, in host byte order.
 */
export async function columnInOrder(column, order, readRegion) {
  switch (column.kind) {
    case 'numbers': {
      const values = column.values ?? await hostValues(column, readRegion);
      return { kind: 'numbers', values: rowsOf(values, order), note: column.note };
    }
    case 'booleans':
      return { ...column, values: rowsOf(column.values, order) };
    case 'strings':
      return { ...column, values: Array.from(order, r => column.values[r]) };
    case 'nullable-integer':
    case 'nullable-boolean':
      return { ...column, values: rowsOf(column.values, order), mask: rowsOf(column.mask, order) };
    case 'categorical':
      return { ...column, codes: rowsOf(column.codes, order) };
    default:
      throw new TypeError(`Unknown column kind '${column.kind}'.`);
  }
}

/**
 * A per-cell numeric array part (`{values}` or `{region, dtype}`) of
 * `rows × width` values with its rows in `order`: rows contiguous (`'C'`) or
 * columns contiguous (`'F'`, as R stores every matrix), in host byte order.
 */
export async function rowsInOrder(part, { rows, width, layout }, order, readRegion) {
  const values = part.values ?? await hostValues(part, readRegion);
  if (layout === 'C') return { values: rowsOf(values, order, width) };
  const out = allocateTypedArray(values.constructor, rows * width, 'Per-cell values in priority order');
  for (let c = 0; c < width; c++) out.set(rowsOf(values.subarray(c * rows, (c + 1) * rows), order), c * rows);
  return { values: out };
}

/**
 * A cells × features matrix of one store in priority order: the expression
 * matrix (`expression`) stored by feature with the prefix counts at
 * `levels`; any other layer in its own layout (a matrix by cell with its
 * rows in order, a matrix by feature renumbered, a dense one with its rows
 * in order). `rows` null keeps the cells as the source holds them.
 */
export async function matrixInOrder(matrix, rows, context, { expression, levels = null }) {
  const { space, readRegion, signal = null } = context;
  if (rows === null) {
    // Cells as the source holds them (an uncompressed R file, read in place):
    // a cell-major X still by feature, unless its arrays are the file's own.
    const inPlace = [matrix.indptr, matrix.indices, matrix.data].some(part => part?.region?.store === 'file');
    return expression && matrix.format === 'csr' && !inPlace ? byFeature(matrix, { space, readRegion, signal }) : matrix;
  }
  if (matrix.format === 'dense') {
    const [nRows, width] = matrix.shape;
    const data = await rowsInOrder(matrix.data, { rows: nRows, width, layout: 'C' }, rows.order, readRegion);
    return { ...matrix, data };
  }
  if (expression || matrix.format === 'csc') {
    return byFeature(matrix, { space, readRegion, signal }, { rows: rows.position, levels: expression ? levels : null });
  }
  return majorInOrder(matrix, { space, readRegion, signal }, { order: rows.order, position: rows.position });
}

/** A cells × cells graph with both axes in priority order (as it is when `priority` is null). */
export async function graphInOrder(matrix, priority, context) {
  const { space, readRegion, signal = null } = context;
  if (priority === null) return matrix;
  if (matrix.format === 'dense') {
    const n = matrix.shape[0];
    const { values } = await rowsInOrder(matrix.data, { rows: n, width: n, layout: 'C' }, priority.order, readRegion);
    const out = allocateTypedArray(values.constructor, n * n, 'A cells × cells graph in priority order');
    for (let r = 0; r < n; r++) out.set(rowsOf(values.subarray(r * n, (r + 1) * n), priority.order), r * n);
    return { ...matrix, data: { values: out } };
  }
  return majorInOrder(matrix, { space, readRegion, signal }, { order: priority.order, position: priority.position, minor: priority.position });
}

/** `uns['cellucid']['priority']` of a store in priority order. */
export function priorityRecord(priority) {
  return {
    seed: priority.seed,
    specVersion: SUBSAMPLE_SPEC_VERSION,
    nObs: priority.order.length,
    levels: BigInt64Array.from(priority.levels, BigInt),
  };
}
