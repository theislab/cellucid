/**
 * @fileoverview The expression transform: how the values of the mapped
 * expression matrix are shown and analyzed (Session › Data mapping ›
 * Expression values). One setting for the whole app: coloring, legends,
 * filters, highlights by value, the cell card, the agents' reads and every
 * analysis that reads genes follow it; obs fields never do, and a gene field
 * made in the app (a copy) keeps the values it was made with.
 *
 * Two switches, both off by default (nothing more is read for a simple
 * look):
 *
 * - **normalize** — each cell's values scaled to a common total,
 *   `x · 10,000 / t` (`t` the cell's total count, its library size:
 *   `data/library-sizes.js`); scanpy `sc.pp.normalize_total(adata,
 *   target_sum=1e4)`, Seurat `NormalizeData(scale.factor = 1e4)`. The total
 *   is fixed rather than scanpy's default median of the totals: the median
 *   moves with the open cells (a subsample, the cells genes are read for),
 *   a fixed total does not, so one value means one thing whatever is open.
 * - **log1p** — `ln(1 + x)`, after the normalization when both are on
 *   (scanpy `sc.pp.log1p`; with normalize, Seurat's `LogNormalize`).
 *
 * Offered for a matrix of counts only (`DataLayer.matrixHoldsCounts`,
 * the Data mapping's `counts`): a matrix that is not counts is shown as
 * stored, whatever the setting (`effectiveTransform`).
 *
 * A zero stays zero (ln 1 = 0, 0 · f = 0), so a sparse gene stays sparse;
 * a cell whose total is 0 holds only zeros; a cell with no total (not read)
 * has no value (NaN) where it has a count. Values are rounded to float32,
 * as a gene's values are held (scanpy keeps a float32 matrix float32).
 *
 * Pseudobulk differential expression is the one exception: it sums each
 * sample's raw counts and normalizes the samples (TMM + log-CPM,
 * `app/analysis/stats/edger-normalization.js`), whatever this setting.
 *
 * @module data/expression-transform
 */

import { formatCountOf } from '../utils/format-units.js';
import { allocateTypedArray } from './sparse-column-index.js';

/** The common total each cell is scaled to (scanpy `target_sum`, Seurat `scale.factor`). */
export const EXPRESSION_TARGET_SUM = 10_000;

/**
 * @typedef {Readonly<{normalize: boolean, log1p: boolean}>} ExpressionTransform
 */

/** The values as stored: the default. */
export const RAW_VALUES = Object.freeze({ normalize: false, log1p: false });

const TRANSFORM_KEYS = Object.freeze(['log1p', 'normalize']);

/**
 * A transform checked: exactly `{normalize, log1p}`, both booleans; frozen.
 *
 * @param {unknown} value
 * @param {string} [label]
 * @returns {ExpressionTransform}
 */
export function requireExpressionTransform(value, label = 'An expression transform') {
  if (
    value === null || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== TRANSFORM_KEYS.join(',') ||
    typeof value.normalize !== 'boolean' || typeof value.log1p !== 'boolean'
  ) {
    throw new TypeError(`${label} is exactly {normalize: boolean, log1p: boolean}`);
  }
  return value.normalize === false && value.log1p === false
    ? RAW_VALUES
    : Object.freeze({ normalize: value.normalize, log1p: value.log1p });
}

/** Whether `transform` leaves the values as stored. */
export function isRawValues(transform) {
  return transform.normalize === false && transform.log1p === false;
}

/**
 * The transform that applies to a matrix: `transform` when it holds counts,
 * else the values as stored.
 *
 * @param {ExpressionTransform} transform
 * @param {boolean} holdsCounts
 * @returns {ExpressionTransform}
 */
export function effectiveTransform(transform, holdsCounts) {
  return holdsCounts ? transform : RAW_VALUES;
}

/** One word for a transform, the key caches and results keep it by. */
export function transformKey(transform) {
  if (transform.normalize) return transform.log1p ? 'normalized-log1p' : 'normalized';
  return transform.log1p ? 'log1p' : 'raw';
}

/** A transform in a person's words: "Raw values", "Normalized", "log1p", "Normalized · log1p". */
export function transformWords(transform) {
  if (transform.normalize) return transform.log1p ? 'Normalized · log1p' : 'Normalized';
  return transform.log1p ? 'log1p' : 'Raw values';
}

/**
 * The units a legend or an axis names values in: `norm.`, `log1p`,
 * `log1p(norm.)`; null for the values as stored.
 */
export function transformUnits(transform) {
  if (transform.normalize) return transform.log1p ? 'log1p(norm.)' : 'norm.';
  return transform.log1p ? 'log1p' : null;
}

/**
 * The one name of a gene's values wherever they are shown, plotted or
 * exported: `label` with the units of the values it names when they are not
 * as stored ("Ins1 · log1p(norm.)", "Mean expression · norm."), else `label`
 * itself. `values` are what the values are in: a transform
 * (`{normalize, log1p}`, the setting shown), a result's record
 * (`valuesRecord`: what the run computed from, so a result keeps its own
 * units whatever the setting is now), or null (as stored: an obs field, a
 * gene made in the app, a matrix the transform does not apply to).
 *
 * Every label of gene values goes through here (the legend, the figure
 * legend, the cell card, Detailed, Correlation, the dot plot, the marker
 * heatmap, the CSV files): `tests/gene-value-labels-contract.test.mjs`.
 *
 * @param {string} label - A gene's name, or what a value of genes is ("Mean expression")
 * @param {{normalize: boolean, log1p: boolean}|null} values
 * @returns {string}
 */
export function geneValueLabel(label, values) {
  if (typeof label !== 'string' || label.length === 0) throw new TypeError('A gene value label names its values');
  if (values === null) return label;
  if (typeof values !== 'object' || typeof values.normalize !== 'boolean' || typeof values.log1p !== 'boolean') {
    throw new TypeError('A gene value label takes a transform {normalize, log1p}, a values record, or null');
  }
  const units = transformUnits(values);
  return units === null ? label : `${label} · ${units}`;
}

/** The per-cell formula: `ln(1 + x · 10,000 / cell total)`, `x · 10,000 / cell total`, `ln(1 + x)`, `x`. */
export function transformFormula(transform) {
  const scaled = transform.normalize ? 'x · 10,000 / cell total' : 'x';
  return transform.log1p ? `ln(1 + ${scaled})` : scaled;
}

/** The scanpy calls that give the same values. */
export function transformScanpy(transform) {
  const calls = [];
  if (transform.normalize) calls.push('sc.pp.normalize_total(adata, target_sum=1e4)');
  if (transform.log1p) calls.push('sc.pp.log1p(adata)');
  return calls.length === 0 ? 'none' : calls.join(' then ');
}

// ============================================================================
// Values
// ============================================================================

/**
 * Each cell's factor `10⁴ / t`: 0 for a total of 0 (its zeros stay zeros),
 * NaN for a cell with no total.
 *
 * @param {ArrayLike<number>} totals - Each cell's total count (NaN: none)
 * @returns {Float32Array}
 */
export function cellFactors(totals) {
  const factors = allocateTypedArray(Float32Array, totals.length, 'The cells\' factors');
  for (let cell = 0; cell < totals.length; cell++) {
    const total = totals[cell];
    factors[cell] = total > 0 ? EXPRESSION_TARGET_SUM / total : total === 0 ? 0 : NaN;
  }
  return factors;
}

/**
 * One value transformed: `ln(1 + x · factor)`, `x · factor` or `ln(1 + x)`
 * (`factor` null: not normalized), rounded to float32. Zero stays zero; a
 * value that is not finite stays as it is (a cell not read).
 *
 * @param {number} value
 * @param {number|null} factor
 * @param {boolean} log1p
 * @returns {number}
 */
export function transformValue(value, factor, log1p) {
  if (value === 0 || !Number.isFinite(value)) return value;
  const scaled = factor === null ? value : value * factor;
  return Math.fround(log1p ? Math.log1p(scaled) : scaled);
}

function requireFactors(factors, length, what) {
  if (factors === null) return;
  if (!(factors instanceof Float32Array)) throw new TypeError('Cell factors are a Float32Array of one factor a position');
  if (length > factors.length) {
    throw new RangeError(`A transformed ${what} has ${formatCountOf(length, 'position')}; the factors cover ${factors.length}`);
  }
}

/** Whether `column` is a gene's non-zero entries `{length, indices, values}`. */
function isEntries(column) {
  return column !== null && typeof column === 'object' && !ArrayBuffer.isView(column) && !Array.isArray(column) &&
    Number.isSafeInteger(column.length) && column.indices instanceof Uint32Array && ArrayBuffer.isView(column.values);
}

/**
 * A gene transformed, in the form it came in: a dense column (one value a
 * position) as a new Float32Array, a gene's non-zero entries
 * `{length, indices, values}` as new entries with the same indices (the
 * input is never written: it may be shared). Position `p` is scaled by
 * `factors[p]` (null: not normalized).
 *
 * @template {ArrayLike<number>|{length: number, indices: Uint32Array, values: ArrayLike<number>}} T
 * @param {T} column
 * @param {Float32Array|null} factors
 * @param {boolean} log1p
 * @returns {T}
 */
export function transformColumn(column, factors, log1p) {
  if (isEntries(column)) {
    requireFactors(factors, column.length, 'gene');
    const { indices, values } = column;
    const out = allocateTypedArray(Float32Array, values.length, 'A transformed gene');
    for (let k = 0; k < values.length; k++) out[k] = transformValue(values[k], factors === null ? null : factors[indices[k]], log1p);
    return { length: column.length, indices, values: out };
  }
  if (!ArrayBuffer.isView(column) && !Array.isArray(column)) {
    throw new TypeError('A transformed gene is a numeric array or its entries {length, indices, values}');
  }
  requireFactors(factors, column.length, 'gene');
  const out = allocateTypedArray(Float32Array, column.length, 'A transformed gene');
  for (let p = 0; p < column.length; p++) out[p] = transformValue(column[p], factors === null ? null : factors[p], log1p);
  return out;
}

/**
 * Rows `[from, from + rows.length)` of a gene transformed (a gene read for
 * more cells: `factors` are of every position, the rows' from `from`).
 *
 * @param {ArrayLike<number>} rows
 * @param {number} from
 * @param {Float32Array|null} factors
 * @param {boolean} log1p
 * @returns {Float32Array}
 */
export function transformRows(rows, from, factors, log1p) {
  if (factors !== null && from + rows.length > factors.length) {
    throw new RangeError(`Transformed rows end at ${from + rows.length}; the factors cover ${factors.length}`);
  }
  const out = allocateTypedArray(Float32Array, rows.length, 'A transformed gene\'s rows');
  for (let k = 0; k < rows.length; k++) out[k] = transformValue(rows[k], factors === null ? null : factors[from + k], log1p);
  return out;
}

/**
 * A block of genes read in a cell subset (`{pointers, positions|cellIndex,
 * values}`, `data/gene-delivery.js`), its values transformed by position
 * (`factors[p]`: the factor of the subset's `p`-th cell).
 *
 * @param {{values: Float32Array, positions?: ArrayLike<number>, cellIndex?: ArrayLike<number>}} block
 * @param {Float32Array|null} factors
 * @param {boolean} log1p
 */
export function transformBlock(block, factors, log1p) {
  const positions = block.positions ?? block.cellIndex;
  const { values } = block;
  const out = allocateTypedArray(Float32Array, values.length, 'A transformed gene');
  for (let k = 0; k < values.length; k++) {
    const position = positions[k];
    if (factors !== null && position >= factors.length) {
      throw new RangeError(`A transformed block names position ${position}; the factors cover ${factors.length}`);
    }
    out[k] = transformValue(values[k], factors === null ? null : factors[position], log1p);
  }
  return { ...block, values: out };
}

/**
 * The factors of a cell subset, by position (`factors[cells[p]]`).
 *
 * @param {Float32Array} factors
 * @param {ArrayLike<number>} cells
 * @returns {Float32Array}
 */
export function factorsOfCells(factors, cells) {
  const out = allocateTypedArray(Float32Array, cells.length, 'The factors of a cell subset');
  for (let p = 0; p < cells.length; p++) out[p] = factors[cells[p]];
  return out;
}

// ============================================================================
// What a result keeps
// ============================================================================

/**
 * What a result keeps of the values it computed from: the transform, and
 * where the cells' totals came from when normalized (`library-sizes.js`
 * `source`). Null: the values as stored.
 *
 * @param {ExpressionTransform} transform
 * @param {{source: string}|null} sizes - The cells' totals (normalized only)
 * @returns {{normalize: boolean, log1p: boolean, totals: string|null}|null}
 */
export function valuesRecord(transform, sizes) {
  if (isRawValues(transform)) return null;
  if (transform.normalize && (sizes === null || typeof sizes?.source !== 'string')) {
    throw new TypeError('Normalized values name where the cells\' totals came from');
  }
  return { normalize: transform.normalize, log1p: transform.log1p, totals: transform.normalize ? sizes.source : null };
}

/** Whether a saved result's values record is one `valuesRecord` made, or null. */
export function isValuesRecord(record) {
  return record === null || (
    typeof record === 'object' && !Array.isArray(record) &&
    Object.keys(record).sort().join(',') === 'log1p,normalize,totals' &&
    typeof record.normalize === 'boolean' && typeof record.log1p === 'boolean' &&
    (record.normalize || record.log1p) &&
    (record.normalize ? typeof record.totals === 'string' && record.totals.length > 0 : record.totals === null)
  );
}

/**
 * A result's values in words, as its `about` and Statistics say them.
 *
 * @param {{normalize: boolean, log1p: boolean, totals: string|null}|null} record - `valuesRecord`
 * @param {{counts?: boolean}} [options] - `counts`: the matrix holds counts
 * @returns {string}
 */
export function describeValues(record, { counts = false } = {}) {
  if (record === null) return counts ? 'raw counts as stored, not normalized' : 'values as stored';
  const formula = transformFormula(record);
  return record.normalize ? `${formula}, cell totals from ${record.totals}` : formula;
}
