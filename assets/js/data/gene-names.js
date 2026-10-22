/**
 * Gene names read from a `var` column, in the words `cellucid serve` uses.
 *
 * The data-mapping gene-name rule (design §1.3): a column of strings,
 * categories or integers names the genes; an empty or missing value takes the
 * gene's var-index name, and the list is then made unique with
 * `makeUniqueNames` (`data-mapping.js`). A value is turned into text exactly
 * as `cellucid.anndata_mapping` does with Python's `str()`, so a file read in
 * the browser and the same file served list the same names.
 *
 * @module data/gene-names
 */

/**
 * The text of one gene-name value, or null when it is missing.
 *
 * - a string is itself (an empty string is "missing" for `makeUniqueNames`);
 * - null, undefined and NaN are missing;
 * - an integer (number or bigint) is its decimal digits, as `str(5)`;
 * - a boolean is `True` or `False`, as `str(True)`;
 * - a value stored as a float (`isFloat`, e.g. float categories) keeps
 *   Python's `.0` on whole numbers (`str(5.0)` is `5.0`);
 * - any other number is its shortest round-trip text.
 *
 * @param {unknown} value
 * @param {{isFloat?: boolean}} [options]
 * @returns {string|null}
 */
export function geneNameText(value, { isFloat = false } = {}) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return null;
    if (isFloat && Number.isInteger(value)) return `${value}.0`;
    return String(value);
  }
  throw new TypeError(`A gene name must be text, a number or missing; got ${typeof value}.`);
}
