/**
 * @fileoverview The sparse form of a gene's column: what the page colors a
 * gene from, instead of every cell's value.
 *
 * A gene's column (one float32 an open cell) is mostly zeros, and on a gene
 * sample (`app/state/managers/field/gene-sample.js`) its cells past the
 * sample are NaN. Its sparse form says the same values in a fraction of the
 * bytes: `{length, indices, values, readRows}`, cell `indices[k]` holding
 * `values[k]` (strictly increasing, all below `readRows`), every other cell
 * below `readRows` 0, and every cell from `readRows` on NaN (not read). At
 * 10M cells, coloring a gene and measuring its range from the form is a
 * word fill and its few entries (~4 ms); from the column it is two passes
 * over every cell on the main thread (~50 ms; `continuous-colors.js`).
 *
 * The reader worker makes the form where the column is made, in one pass off
 * the main thread (`sparseFormOf`), and only when it is smaller than the
 * column; a gene shown while its index is built (`onPartial`) crosses to the
 * page as its form alone. The page notes a column's form beside it
 * (`noteColumnForm`), and the color kernels read the form of a column that
 * has one (`columnFormOf`). A column is never written in place (a field's
 * values are replaced, never edited: `color-manager.js`), so its form stays
 * exact as long as the column lives.
 *
 * @module data/column-forms
 */

import { allocateTypedArray } from './sparse-column-index.js';

/** @typedef {{length: number, indices: Uint32Array, values: Float32Array|Float64Array, readRows: number}} ColumnForm */

const FORMS = new WeakMap();

/** Whether `form` is a well-formed sparse form of `length` cells. */
function requireForm(form, length) {
  if (
    form === null
    || typeof form !== 'object'
    || form.length !== length
    || !(form.indices instanceof Uint32Array)
    || !(form.values instanceof Float32Array || form.values instanceof Float64Array)
    || form.indices.length !== form.values.length
    || !Number.isSafeInteger(form.readRows)
    || form.readRows < 0
    || form.readRows > length
  ) {
    throw new TypeError(`A column's sparse form is {length: ${length}, indices: Uint32Array, values, readRows <= ${length}}.`);
  }
  const { indices, readRows } = form;
  let previous = -1;
  for (let k = 0; k < indices.length; k++) {
    if (indices[k] <= previous || indices[k] >= readRows) {
      throw new RangeError(`Sparse form index ${k} must increase strictly and stay below ${readRows}.`);
    }
    previous = indices[k];
  }
  return form;
}

/**
 * Where the NaN tail of a column's cells not read begins (a gene sample's,
 * or a gene's cells read so far): the cells from there on are all NaN.
 *
 * @param {Float32Array|Float64Array} column
 * @returns {number}
 */
export function unreadTailOf(column) {
  let read = column.length;
  while (read > 0 && column[read - 1] !== column[read - 1]) read--;
  return read;
}

/**
 * The sparse form of `column`, or null when it would take as many bytes as
 * the column (its entries, a 4-byte index and a value each, against one
 * value a cell). `readRows`: where the NaN tail of cells not read begins
 * (a gene sample's), found from the end when not given.
 *
 * @param {Float32Array|Float64Array} column
 * @param {number} [readRows]
 * @returns {ColumnForm|null}
 */
export function sparseFormOf(column, readRows = undefined) {
  if (!(column instanceof Float32Array || column instanceof Float64Array)) {
    throw new TypeError('A sparse form is made of a Float32Array or Float64Array column.');
  }
  const n = column.length;
  let read = readRows;
  if (read === undefined) {
    read = unreadTailOf(column);
  } else if (!Number.isSafeInteger(read) || read < 0 || read > n) {
    throw new RangeError(`readRows must be a whole number from 0 to ${n}.`);
  }
  const width = column.BYTES_PER_ELEMENT;
  // Entries the form may hold and still be smaller than the column.
  const most = Math.floor((n * width - 1) / (4 + width));
  // A cell is an entry unless it holds +0 exactly (-0 and NaN are entries,
  // so the form gives back every bit): a float32's bits are 0 for +0 alone.
  // One pass collects the entries' cells (in a buffer doubled as it fills,
  // given up once the form would be no smaller), then their values.
  let cells = allocateTypedArray(Uint32Array, Math.min(most, 1024), 'Gene entries');
  let count = 0;
  const take = i => {
    if (count === most) return false;
    if (count === cells.length) {
      const grown = allocateTypedArray(Uint32Array, Math.min(most, cells.length * 2), 'Gene entries');
      grown.set(cells);
      cells = grown;
    }
    cells[count++] = i;
    return true;
  };
  if (column instanceof Float32Array) {
    const bits = new Uint32Array(column.buffer, column.byteOffset, n);
    for (let i = 0; i < read; i++) {
      if (bits[i] !== 0 && !take(i)) return null;
    }
  } else {
    for (let i = 0; i < read; i++) {
      if ((column[i] !== 0 || Object.is(column[i], -0)) && !take(i)) return null;
    }
  }
  const indices = cells.slice(0, count);
  const values = allocateTypedArray(column.constructor, count, 'Gene entry values');
  for (let k = 0; k < count; k++) values[k] = column[indices[k]];
  return { length: n, indices, values, readRows: read };
}

/**
 * Note `form` as the sparse form of `column` (checked once here).
 *
 * @param {Float32Array|Float64Array} column
 * @param {ColumnForm|null} form
 * @returns {Float32Array|Float64Array} The column
 */
export function noteColumnForm(column, form) {
  if (form !== null) FORMS.set(column, requireForm(form, column.length));
  return column;
}

/**
 * The sparse form noted for `column`, or null.
 *
 * @param {unknown} column
 * @returns {ColumnForm|null}
 */
export function columnFormOf(column) {
  return (column !== null && typeof column === 'object' && FORMS.get(column)) || null;
}

/**
 * Whether `value` is a sparse form (a partial gene's, or a column's).
 *
 * @param {unknown} value
 * @returns {value is ColumnForm}
 */
export function isColumnForm(value) {
  return value !== null && typeof value === 'object' && !ArrayBuffer.isView(value)
    && value.indices instanceof Uint32Array && Number.isSafeInteger(value.readRows);
}

/**
 * Check a sparse form handed over on its own (a partial gene's) for
 * `length` cells.
 *
 * @param {unknown} form
 * @param {number} length
 * @returns {ColumnForm}
 */
export function requireColumnForm(form, length) {
  return requireForm(form, length);
}

/**
 * The sparse form of a column resized from `from` cells to `to` in place
 * (`state/managers/open-cells.js`, `resizedCellArray`: its first
 * `min(from, to)` cells kept, then the cells added, whose column's form is
 * `added`), or null when the resized column's form cannot be told from
 * these (a part with no form; cells read after cells not read). Growing a
 * gene in place keeps it colored from its entries.
 *
 * @param {ColumnForm|null} form - The column's before
 * @param {number} from
 * @param {number} to
 * @param {ColumnForm|null} [added] - The added cells' column's, when `to > from`
 * @returns {ColumnForm|null}
 */
export function resizedForm(form, from, to, added = null) {
  if (form === null || form.length !== from) return null;
  if (to <= from) {
    let kept = 0;
    while (kept < form.indices.length && form.indices[kept] < to) kept++;
    return { length: to, indices: form.indices.slice(0, kept), values: form.values.slice(0, kept), readRows: Math.min(form.readRows, to) };
  }
  if (added === null || added.length !== to - from || added.values.constructor !== form.values.constructor) return null;
  // Cells read stop where the earlier column's were not, unless the added
  // cells were read for none of theirs either (a gene sample grown past).
  if (form.readRows < from && (added.readRows > 0)) return null;
  const count = form.indices.length + added.indices.length;
  const indices = allocateTypedArray(Uint32Array, count, 'Gene entries');
  const values = allocateTypedArray(form.values.constructor, count, 'Gene entry values');
  indices.set(form.indices);
  values.set(form.values);
  for (let k = 0; k < added.indices.length; k++) indices[form.indices.length + k] = from + added.indices[k];
  values.set(added.values, form.indices.length);
  return { length: to, indices, values, readRows: form.readRows < from ? form.readRows : from + added.readRows };
}

/**
 * The sparse form of a column whose cells `[from, from + rows.length)` were
 * read after it (a gene sample grown, `field/gene-sample.js`): `form` read
 * its first `from` cells exactly, `rows` is the form of the cells added.
 * Null when that cannot be told from these.
 *
 * @param {ColumnForm|null} form
 * @param {number} from
 * @param {ColumnForm|null} rows
 * @returns {ColumnForm|null}
 */
export function filledForm(form, from, rows) {
  if (form === null || rows === null || form.readRows !== from || from + rows.length > form.length || rows.values.constructor !== form.values.constructor) return null;
  const count = form.indices.length + rows.indices.length;
  const indices = allocateTypedArray(Uint32Array, count, 'Gene entries');
  const values = allocateTypedArray(form.values.constructor, count, 'Gene entry values');
  indices.set(form.indices);
  values.set(form.values);
  for (let k = 0; k < rows.indices.length; k++) indices[form.indices.length + k] = from + rows.indices[k];
  values.set(rows.values, form.indices.length);
  // Cells past the rows were not read; inside them, past the rows' own reading, neither.
  return { length: form.length, indices, values, readRows: from + rows.readRows };
}
