/**
 * Value kinds and boolean decoding shared by the browser AnnData readers.
 *
 * The H5AD and Zarr readers classify their stored dtypes into the same five
 * kinds (`float`, `int`, `uint`, `bool`, `string`), and every rule about which
 * kinds a payload may use, and how a stored boolean decodes, lives here so the
 * same file content is judged identically whichever container carries it.
 *
 * @module data/anndata-value-kinds
 */

import { allocateTypedArray } from './sparse-column-index.js';

/**
 * Kinds admitted where values are coordinates (embeddings). A boolean is
 * not a coordinate.
 */
const NUMERIC_VALUE_KINDS = new Set(['float', 'int', 'uint']);

/**
 * Kinds admitted for expression matrices (dense or sparse) and connectivity
 * weights, where a boolean (a mask, an adjacency) is a 0/1 value.
 */
const MATRIX_DATA_KINDS = new Set(['float', 'int', 'uint', 'bool']);

/**
 * @param {string} kind
 * @returns {boolean}
 */
export function isAnnDataNumericValueKind(kind) {
  return NUMERIC_VALUE_KINDS.has(kind);
}

/**
 * @param {string} kind
 * @returns {boolean}
 */
export function isAnnDataMatrixDataKind(kind) {
  return MATRIX_DATA_KINDS.has(kind);
}

/**
 * Decode one stored boolean. Only 0 and 1 (or the booleans themselves) are
 * booleans; any other stored value is corrupt and is refused rather than
 * coerced to `true`.
 *
 * @param {unknown} value
 * @param {string} errorMessage - Message of the error a non-boolean raises
 * @returns {boolean}
 */
export function decodeAnnDataBoolean(value, errorMessage) {
  if (value === 1 || value === true) return true;
  if (value === 0 || value === false) return false;
  const numeric = typeof value === 'bigint' ? Number(value) : value;
  if (numeric === 1) return true;
  if (numeric === 0) return false;
  throw new Error(errorMessage);
}

/** A boolean column's flag for a cell without a value (`decodeAnnDataBooleanFlags`). */
export const BOOLEAN_FLAG_MISSING = 2;

/**
 * Decode a stored boolean column into one byte a cell: 0 false, 1 true,
 * `BOOLEAN_FLAG_MISSING` where `mask` (a nullable column's) marks none. A
 * typed array of millions of cells, never a JavaScript boolean per cell.
 * Any stored value other than 0 and 1 is refused, as `decodeAnnDataBoolean`
 * refuses it.
 *
 * @param {ArrayLike<unknown>} raw - The stored values
 * @param {ArrayLike<number>|null} mask - Non-zero where a value is missing
 * @param {string} errorMessage
 * @returns {Uint8Array}
 */
export function decodeAnnDataBooleanFlags(raw, mask, errorMessage) {
  const flags = allocateTypedArray(Uint8Array, raw.length, 'Boolean column');
  const typed = ArrayBuffer.isView(raw) && !(raw instanceof BigInt64Array) && !(raw instanceof BigUint64Array);
  for (let i = 0; i < flags.length; i++) {
    if (mask !== null && mask[i]) {
      flags[i] = BOOLEAN_FLAG_MISSING;
      continue;
    }
    const value = raw[i];
    if (typed ? value === 1 : decodeAnnDataBoolean(value, errorMessage)) flags[i] = 1;
    else if (typed && value !== 0) throw new Error(errorMessage);
  }
  return flags;
}
