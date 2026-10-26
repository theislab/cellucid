/**
 * The nodes a layout view is made of: a group or an array of the store model
 * (`formats/store.js`) presented with other attributes, other children or
 * another shape, while every value it holds is read from the real node in
 * place. A layout view presents a file in the current AnnData layout without
 * copying it: `older-layouts.js` (anndata before 0.8, SeuratDisk) is one,
 * and every format whose container allows random access (Loom, 10x HDF5,
 * MuData) is presented the same way, through `views/` and `open.js`.
 *
 * Nothing here reads a value when a view is made: a child is made on its
 * first access, once, and an array's `read` reads the real one.
 *
 * @module data/anndata/views/view-nodes
 */

import { compareNames, isGroup, normalizeSelection, pathParts, selectionSize } from '../../../formats/store.js';

/**
 * The encoding attributes anndata writes for one encoding:
 * `{'encoding-type', 'encoding-version'}` (the root `anndata`, `dict`, the
 * sparse matrices and the nullable arrays are 0.1.0, every other element
 * 0.2.0).
 *
 * @param {string} encoding
 * @returns {{'encoding-type': string, 'encoding-version': string}}
 */
export function encodingAttrs(encoding) {
  const version = encoding === 'anndata' || encoding === 'dict' || encoding.endsWith('_matrix') ||
    encoding.startsWith('nullable-') ? '0.1.0' : '0.2.0';
  return { 'encoding-type': encoding, 'encoding-version': version };
}

/** A child's path below its parent's. */
export function joinPath(parent, name) {
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
}

/**
 * A group presented with other attributes and children. `children` maps each
 * name to a function making the child (made once, on first access). A view
 * of a store root passes `close`, which closes the real store when the
 * reader is done with the view. `extra` adds properties that are not part of
 * the store model (a root's `modalities`, `views/modalities.js`).
 */
export function viewGroup({ path, attrs, children, real = null, ownAttributes = [], close = null, extra = null }) {
  const made = new Map();
  const names = [...children.keys()].sort(compareNames);
  const frozenAttrs = Object.freeze({ ...attrs });
  const group = {
    kind: 'group',
    path,
    name: path === '/' ? '' : path.slice(path.lastIndexOf('/') + 1),
    attrs: frozenAttrs,
    attributeType(name) {
      return real !== null && !ownAttributes.includes(name) ? real.attributeType(name) : null;
    },
    keys: () => [...names],
    has(name) {
      const parts = pathParts(name);
      if (parts.length === 0) return false;
      if (parts.length === 1) return children.has(parts[0]);
      const first = group.get(parts[0]);
      return isGroup(first) && first.has(parts.slice(1).join('/'));
    },
    get(name) {
      const parts = pathParts(name);
      if (parts.length === 0) return group;
      const make = children.get(parts[0]);
      if (make === undefined) return null;
      if (!made.has(parts[0])) made.set(parts[0], make());
      const node = made.get(parts[0]);
      if (parts.length === 1) return node;
      return isGroup(node) ? node.get(parts.slice(1).join('/')) : null;
    },
  };
  if (close !== null) group.close = close;
  if (extra !== null) Object.assign(group, extra);
  return Object.freeze(group);
}

/** An array presented with added attributes and, optionally, other values. */
export function viewArray(real, { attrs = {}, dtype = real.dtype, shape = real.shape, read = null, path = real.path }) {
  const ownAttributes = Object.keys(attrs);
  return Object.freeze({
    kind: 'array',
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    attrs: Object.freeze({ ...real.attrs, ...attrs }),
    attributeType: name => (ownAttributes.includes(name) ? null : real.attributeType(name)),
    shape,
    dtype,
    chunks: real.chunks,
    partialChunks: real.partialChunks === true,
    fillValue: real.fillValue,
    read: read ?? ((selection, options) => real.read(selection, options)),
    storedBytes: (selection, options) => real.storedBytes(selection, options),
  });
}

/**
 * One member of a compound array as an array of its own, read one member at
 * a time (`readField`). An array member (an embedding of a compound `obsm`)
 * is a two-dimensional array of its element type.
 */
export function memberArray(compound, field) {
  const rows = compound.shape[0];
  const width = field.shape.length === 1 ? field.shape[0] : null;
  const shape = width === null ? [rows] : [rows, width];
  const path = joinPath(compound.path, field.name);
  return Object.freeze({
    kind: 'array',
    path,
    name: field.name,
    attrs: Object.freeze({}),
    attributeType: () => null,
    shape,
    dtype: field.dtype,
    chunks: compound.chunks === null ? null : (width === null ? [compound.chunks[0]] : [compound.chunks[0], width]),
    fillValue: null,
    storedBytes: (selection, options) => compound.storedBytes(selection === undefined ? undefined : [selection[0]], options),
    async read(selection, options) {
      const [start, end] = selection?.[0] ?? [0, rows];
      const values = await compound.readField(field.name, [[start, end]], options);
      if (width === null) return values;
      const [first, last] = selection?.[1] ?? [0, width];
      if (first === 0 && last === width) return values;
      const selected = new values.constructor((end - start) * (last - first));
      for (let row = 0; row < end - start; row++) {
        for (let column = first; column < last; column++) {
          selected[row * (last - first) + column - first] = values[row * width + column];
        }
      }
      return selected;
    },
  });
}

/**
 * A two-dimensional array presented transposed: a Loom `/matrix` (genes ×
 * cells) as AnnData's `X` (cells × genes). A read of `[rows, columns]` reads
 * the real array's `[columns, rows]` and transposes the values; the chunk
 * shape is reported transposed, so a reader plans its strips by the real
 * chunks.
 *
 * @param {Object} real - A two-dimensional array node
 * @param {{path?: string, attrs?: Object}} [options]
 * @returns {Object}
 */
export function transposedArray(real, { path = real.path, attrs = {} } = {}) {
  if (real.shape.length !== 2) throw new TypeError(`${real.path} is not two-dimensional, so it cannot be transposed.`);
  const shape = [real.shape[1], real.shape[0]];
  const realSelection = selection => {
    const [rows, columns] = normalizeSelection(shape, selection, path);
    return { rows, columns, real: [columns, rows] };
  };
  return Object.freeze({
    kind: 'array',
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    attrs: Object.freeze({ ...real.attrs, ...attrs }),
    attributeType: name => (Object.hasOwn(attrs, name) ? null : real.attributeType(name)),
    shape,
    dtype: real.dtype,
    chunks: real.chunks === null ? null : [real.chunks[1], real.chunks[0]],
    fillValue: real.fillValue,
    storedBytes: (selection, options) => real.storedBytes(realSelection(selection).real, options),
    async read(selection, options) {
      const { rows, columns, real: inner } = realSelection(selection);
      const values = await real.read(inner, options);
      const nRows = rows[1] - rows[0];
      const nColumns = columns[1] - columns[0];
      if (nRows <= 1 || nColumns <= 1) return values;
      const transposed = new values.constructor(nRows * nColumns);
      for (let column = 0; column < nColumns; column++) {
        const offset = column * nRows;
        for (let row = 0; row < nRows; row++) transposed[row * nColumns + column] = values[offset + row];
      }
      return transposed;
    },
  });
}

/**
 * Rows `[start, start + count)` of an array (its first dimension) as an
 * array of their own: one feature type's rows of a 10x feature list.
 *
 * @param {Object} real
 * @param {{start: number, count: number, path?: string, attrs?: Object}} window
 * @returns {Object}
 */
export function rowWindowArray(real, { start, count, path = real.path, attrs = {} }) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 0 || count < 0 || start + count > real.shape[0]) {
    throw new RangeError(`Rows ${start} to ${start + count} are outside ${real.path}.`);
  }
  const shape = [count, ...real.shape.slice(1)];
  const inner = selection => {
    const pairs = normalizeSelection(shape, selection, path);
    return [[pairs[0][0] + start, pairs[0][1] + start], ...pairs.slice(1)];
  };
  return Object.freeze({
    kind: 'array',
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    attrs: Object.freeze({ ...real.attrs, ...attrs }),
    attributeType: name => (Object.hasOwn(attrs, name) ? null : real.attributeType(name)),
    shape,
    dtype: real.dtype,
    chunks: real.chunks,
    partialChunks: real.partialChunks === true,
    fillValue: real.fillValue,
    storedBytes: (selection, options) => real.storedBytes(inner(selection), options),
    read: (selection, options) => real.read(inner(selection), options),
  });
}

/**
 * An array whose values are computed, once, from what other arrays hold:
 * `compute(options)` resolves to every value in row-major order (a typed
 * array or an Array of strings), and a read selects from them. For values a
 * layout stores in another shape and that are small next to a matrix: a
 * graph stored as coordinates, a column placed through a cell map. Nothing
 * is computed until the first read.
 *
 * @param {{path: string, dtype: Object, shape: number[], compute: (options: Object) => Promise<ArrayLike<unknown>>,
 *   attrs?: Object, storedBytes?: ((options: Object) => Promise<number|null>)|null}} definition
 * @returns {Object}
 */
export function computedArray({ path, dtype, shape, compute, attrs = {}, storedBytes = null }) {
  let values = null;
  const all = options => {
    if (values === null) {
      values = compute(options);
      values.catch(() => { values = null; });
    }
    return values;
  };
  return Object.freeze({
    kind: 'array',
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    attrs: Object.freeze({ ...attrs }),
    attributeType: () => null,
    shape: [...shape],
    dtype,
    chunks: null,
    fillValue: null,
    storedBytes: async (_selection, options) => (storedBytes === null ? null : storedBytes(options)),
    async read(selection, options) {
      const pairs = normalizeSelection(shape, selection, path);
      const whole = await all(options);
      if (shape.length === 0) return Array.isArray(whole) || ArrayBuffer.isView(whole) ? whole[0] : whole;
      if (shape.length === 1) {
        return whole.slice(pairs[0][0], pairs[0][1]);
      }
      const width = shape.slice(1).reduce((product, extent) => product * extent, 1);
      if (shape.length === 2 && pairs[1][0] === 0 && pairs[1][1] === shape[1]) {
        return whole.slice(pairs[0][0] * width, pairs[0][1] * width);
      }
      if (shape.length !== 2) throw new RangeError(`${path}: a computed array is read by rows, or rows and columns.`);
      const out = new whole.constructor(selectionSize(pairs));
      const [[r0, r1], [c0, c1]] = pairs;
      let at = 0;
      for (let row = r0; row < r1; row++) {
        for (let column = c0; column < c1; column++) out[at++] = whole[row * width + column];
      }
      return out;
    },
  });
}

/**
 * An array of values held in memory (an attribute a layout stores where
 * AnnData stores an array: a Loom file's global attributes as `uns`).
 *
 * @param {{path: string, dtype: Object, shape: number[], values: unknown, attrs?: Object}} definition
 * @returns {Object}
 */
export function valueArray({ path, dtype, shape, values, attrs = {} }) {
  return computedArray({ path, dtype, shape, attrs, compute: async () => values, storedBytes: async () => 0 });
}

/**
 * A column window of a cells × features sparse matrix: features `[start,
 * start + count)` of the CSR matrix `matrix` as a matrix of their own (one
 * feature type of a 10x file, whose features are stored together). The node
 * is the matrix with its shape narrowed and `columnWindow` naming the real
 * matrix and the window; the expression readers read it through the real
 * matrix (`matrix-access.js`), so every window of one matrix shares its
 * gene index. Its arrays are the real matrix's: a reader that does not know
 * windows must not read them.
 *
 * @param {Object} matrix - A `csr_matrix` group (cells × features)
 * @param {{start: number, count: number, path: string}} window
 * @returns {Object}
 */
export function columnWindowMatrix(matrix, { start, count, path }) {
  const shape = matrix.attrs.shape;
  return viewGroup({
    path,
    real: matrix,
    attrs: { ...matrix.attrs, shape: [Number(shape[0]), count] },
    ownAttributes: ['shape'],
    children: new Map(matrix.keys().map(key => [key, () => matrix.get(key)])),
    extra: { columnWindow: Object.freeze({ matrix, start, count }) },
  });
}
