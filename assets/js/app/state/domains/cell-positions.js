/**
 * @fileoverview Cells in state domain values: named by original position
 * (`data/cell-identity.js`), whatever cells are open and in whatever order.
 *
 * - A **cell list** (a highlight group, the cells hidden by hand) is an
 *   ascending `Uint32Array` of original positions.
 * - A **per-cell column** (a user-defined field's codes or values) is
 *   `{cells, values}`: `cells` the ascending original positions of the cells
 *   it holds a value for (null: every cell of the dataset, `values[p]` that
 *   of original position `p`), `values` their values in that order.
 *
 * Restored on other open cells (a subsample, another share), a cell that is
 * not open is left out of a list and a column, and an open cell a column has
 * no value for gets the column's missing marker.
 *
 * The app replaces these arrays, it never writes one in place (highlight
 * groups, user-defined codes and values: `state/managers/open-cells.js`,
 * `registries/user-defined-fields.js`), so a conversion is cached by the
 * array and the cell identity it was made for: capturing an unchanged
 * highlight or field again costs nothing, and gives the same value object,
 * whose content hash the value pool has cached by identity.
 *
 * @module app/state/domains/cell-positions
 */

import { formatCountOf } from '../../../utils/format-units.js';

/** positions array → {identity, cells}. */
const ORIGINAL_LISTS = new WeakMap();
/** original cells array → {identity, positions}: the open list a restore made, reused. */
const OPEN_LISTS = new WeakMap();
/** per-cell values array → {identity, column}. */
const ORIGINAL_COLUMNS = new WeakMap();
/** column values array → {identity, values}: the open values a restore made, reused. */
const OPEN_COLUMNS = new WeakMap();

function isAscending(array) {
  for (let i = 1; i < array.length; i++) if (!(array[i - 1] < array[i])) return false;
  return true;
}

/**
 * The cells of an open-position list, by original position, ascending.
 *
 * @param {import('../../../data/cell-identity.js').CellIdentity} identity
 * @param {Uint32Array} positions - Open positions (any order, each once)
 * @returns {Uint32Array}
 */
export function originalCellList(identity, positions) {
  const cached = ORIGINAL_LISTS.get(positions);
  if (cached !== undefined && cached.identity === identity) return cached.cells;
  let cells;
  if (identity.kept === null && identity.openOrder === null && positions instanceof Uint32Array && isAscending(positions)) {
    // Every cell open in its own order: the list names original positions.
    cells = positions;
  } else {
    cells = identity.toOriginal(positions);
    if (!isAscending(cells)) cells.sort();
  }
  ORIGINAL_LISTS.set(positions, { identity, cells });
  OPEN_LISTS.set(cells, { identity, positions });
  return cells;
}

/**
 * The open positions (ascending) of a list of original positions; cells
 * that are not open are left out.
 *
 * @param {import('../../../data/cell-identity.js').CellIdentity} identity
 * @param {Uint32Array} cells - Original positions, ascending
 * @returns {Uint32Array}
 */
export function openCellList(identity, cells) {
  const cached = OPEN_LISTS.get(cells);
  if (cached !== undefined && cached.identity === identity) return cached.positions;
  const { positions } = identity.fromOriginal(cells);
  OPEN_LISTS.set(cells, { identity, positions });
  ORIGINAL_LISTS.set(positions, { identity, cells });
  return positions;
}

/**
 * A per-cell array of the open cells (open order) as a column by original
 * position.
 *
 * @template {ArrayLike<number>} T
 * @param {import('../../../data/cell-identity.js').CellIdentity} identity
 * @param {T} values - One value per open cell
 * @returns {{cells: Uint32Array|null, values: T}}
 */
export function originalColumn(identity, values) {
  const cached = ORIGINAL_COLUMNS.get(values);
  if (cached !== undefined && cached.identity === identity) return cached.column;
  const { cells, values: ordered } = identity.originalValues(null, values);
  const column = { cells, values: ordered };
  ORIGINAL_COLUMNS.set(values, { identity, column });
  OPEN_COLUMNS.set(ordered, { identity, values });
  return column;
}

/**
 * A column by original position laid out over the open cells (open order);
 * an open cell the column has no value for gets `missing`.
 *
 * @template {ArrayLike<number>} T
 * @param {import('../../../data/cell-identity.js').CellIdentity} identity
 * @param {{cells: Uint32Array|null, values: T}} column
 * @param {{new (length: number): T}} ArrayType
 * @param {number} missing
 * @returns {T}
 */
export function openColumn(identity, column, ArrayType, missing) {
  const cached = OPEN_COLUMNS.get(column.values);
  if (cached !== undefined && cached.identity === identity && cached.values instanceof ArrayType) return cached.values;
  let values;
  if (column.cells === null && column.values.length !== identity.nOriginal) {
    throw new RangeError(`A column of ${formatCountOf(column.values.length, 'value')} does not fit the ${formatCountOf(identity.nOriginal, 'cell')} of this dataset.`);
  }
  const sameOpenCells = identity.openOrder === null && (column.cells === null
    ? identity.kept === null
    : identity.kept !== null && column.cells.length === identity.kept.length && sameCells(column.cells, identity.kept));
  if (sameOpenCells) {
    // The same cells open, in their own order: the column is the open values.
    values = column.values instanceof ArrayType ? column.values : ArrayType.from(column.values);
  } else {
    values = identity.openValues(column, ArrayType, missing);
  }
  OPEN_COLUMNS.set(column.values, { identity, values });
  ORIGINAL_COLUMNS.set(values, { identity, column });
  return values;
}

function sameCells(a, b) {
  if (a === b) return true;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
