/**
 * The values of a continuous field, one per open cell: float32, the form
 * every continuous field takes, or float64 for an integer column that
 * float32 cannot hold exactly (an integer dtype wider than 16 bits: cell or
 * donor ids, deep cells' counts; `anndata/values.js` `readContinuous`).
 * Colors, filters, legends, highlights, analysis pages and exports read
 * either; a value is never rounded on its way to them.
 *
 * @module data/continuous-values
 */

/**
 * Whether `values` is a continuous field's values array.
 *
 * @param {unknown} values
 * @returns {values is Float32Array|Float64Array}
 */
export function isContinuousValues(values) {
  return values instanceof Float32Array || values instanceof Float64Array;
}
