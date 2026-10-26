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
