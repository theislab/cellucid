/**
 * How a Cellucid-ready AnnData lays its arrays out for the browser: the
 * chunk of each array by the way it is read, and its codecs. The written
 * contract is §3 of the Cellucid-ready AnnData specification
 * (`cellucid-python/docs/user_guide/python_package/c_data_preparation_api/09_cellucid_ready_anndata_specification.md`);
 * cellucid-python's `prepare_data/_store.py` and cellucid-r's writer make
 * the same choices, measured there.
 *
 * | Role | Arrays | Chunk |
 * | --- | --- | --- |
 * | `gene-entries` | `data` and `indices` of a gene-major expression matrix (a gene's range, or its first values) | 2^14 values |
 * | `cell` | every array with one value per cell: obs columns and index, categorical codes, nullable values and masks, stored outlier quantiles, MuData cell maps | 2^16 values |
 * | `cell-rows` | `obsm` arrays, read by rows | `[2^16 / columns, columns]` |
 * | `whole` | read whole: `indptr`, var columns and index, categories, graphs, `uns`, `varm` | 2^18 values (a 2-D array by rows, every later dimension whole) |
 * | `gene-strips` | a dense expression matrix, read one gene at a time | `[rows, genes]`: rows up to 2^18 (fewer when a band of every gene must fit a writer's budget), genes as many as keep 2^18 values |
 * | `columns` | read one column at a time: `varm['cellucid_prefix_counts']` (a subsample reads the column of its level) | `[min(rows, 2^18), 1]` |
 *
 * An array shorter than its chunk is one chunk of exactly its length; an
 * empty dimension has chunks of 1. Every array is deflated (zlib, level 6);
 * values wider than one byte are byte-shuffled first, except the values of
 * an expression matrix (real expression values repeat whole, which deflate
 * finds only unshuffled) and text.
 *
 * @module data/anndata/write/layout
 */

import { DEFLATE_LEVEL, v2Codecs } from '../../../formats/zarr/writer.js';
import { itemSizeOf } from '../../../formats/zarr/format-v2.js';

/** Values of a chunk of an expression matrix's entries (cellucid-python `SLICED_CHUNK_ELEMENTS`). */
export const GENE_ENTRY_CHUNK = 2 ** 14;
/** Values of a chunk of an array with one value per cell (`CELL_CHUNK_ELEMENTS`). */
export const CELL_CHUNK = 2 ** 16;
/** Values of a chunk of an array read whole (`WHOLE_CHUNK_ELEMENTS`). */
export const WHOLE_CHUNK = 2 ** 18;

/** The roles an array is written with (`element-writer.js`). */
export const ROLES = Object.freeze(['gene-entries', 'cell', 'cell-rows', 'whole', 'gene-strips', 'columns']);

/** Chunks along the first dimension of `length` rows, `target` values a chunk, rows of `rowValues` values. */
function rowsPerChunk(length, rowValues, target) {
  return Math.max(1, Math.min(length, Math.floor(target / Math.max(1, rowValues))));
}

/**
 * The chunk shape of an array of `shape` written with `role`.
 *
 * @param {string} role
 * @param {number[]} shape
 * @param {{maxRows?: number}} [options] - `gene-strips`: the most rows a band
 *   of chunks may span (a writer streaming a dense matrix a band of every
 *   gene at a time sets it to what its budget holds: each band of the
 *   source then read once)
 * @returns {number[]}
 */
export function chunkShapeOf(role, shape, { maxRows = Infinity } = {}) {
  if (!ROLES.includes(role)) throw new TypeError(`'${role}' is not an array role (${ROLES.join(', ')}).`);
  if (shape.length === 0) return [];
  if (role === 'columns' && shape.length === 2) return [Math.max(1, Math.min(shape[0], WHOLE_CHUNK)), 1];
  if (role === 'gene-strips' && shape.length === 2) {
    // Fewer rows than 2^18 when a band of every gene must fit a budget (`maxRows`): the chunk keeps its 2^18 values.
    const rows = Math.max(1, Math.min(shape[0], WHOLE_CHUNK, maxRows));
    return [rows, Math.max(1, Math.min(shape[1], Math.floor(WHOLE_CHUNK / rows)))];
  }
  const target = role === 'gene-entries' ? GENE_ENTRY_CHUNK : role === 'cell' || role === 'cell-rows' ? CELL_CHUNK : WHOLE_CHUNK;
  const rest = shape.slice(1).map(extent => Math.max(1, extent));
  const rowValues = rest.reduce((product, extent) => product * extent, 1);
  return [rowsPerChunk(shape[0], rowValues, target), ...rest];
}

/**
 * The filters and compressor of an array of `dtype`: shuffled unless one
 * byte wide, text, or the values of an expression matrix (`expression`).
 *
 * @param {string} dtype
 * @param {{expression?: boolean}} [options]
 */
export function codecsOf(dtype, { expression = false } = {}) {
  return v2Codecs(dtype, { shuffle: !expression && dtype !== '|O' && itemSizeOf(dtype) > 1, level: DEFLATE_LEVEL });
}

/**
 * The role of a source array by where it sits in an AnnData group
 * (`relative`: its path below the AnnData's root, `X/data`, `obs/cell_type/codes`),
 * and whether it holds expression values. `expressionMatrix` says whether
 * the element at a path (`X`, `layers/counts`, `raw/X`) is an expression
 * matrix (cells × features of the AnnData).
 *
 * @param {string} relative
 * @param {number} rank - The array's dimensions
 * @param {(path: string) => boolean} expressionMatrix
 * @returns {{role: string, expression: boolean}}
 */
export function roleOf(relative, rank, expressionMatrix) {
  const parts = relative.split('/');
  const parent = parts.slice(0, -1).join('/');
  const name = parts.at(-1);
  if (expressionMatrix(relative)) return { role: rank === 2 ? 'gene-strips' : 'whole', expression: true };
  if (expressionMatrix(parent)) {
    if (name === 'data') return { role: 'gene-entries', expression: true };
    if (name === 'indices') return { role: 'gene-entries', expression: false };
    return { role: 'whole', expression: false };
  }
  // A categorical's labels are read whole, its codes one per cell.
  if (parts[0] === 'obs' && name === 'categories' && parts.length > 2) return { role: 'whole', expression: false };
  if (parts[0] === 'obs' || parts[0] === 'obsmap') return { role: 'cell', expression: false };
  if (parts[0] === 'varm' && name === 'cellucid_prefix_counts') return { role: 'columns', expression: false };
  if (parts[0] === 'obsm') return { role: rank >= 2 ? 'cell-rows' : 'cell', expression: false };
  if (parts[0] === 'uns' && parts[1] === 'cellucid' && parts[2] === 'outlierQuantiles' && parts[3] === 'fields') {
    return { role: 'cell', expression: false };
  }
  return { role: 'whole', expression: false };
}
