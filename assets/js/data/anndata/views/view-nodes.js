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

import { compareNames, pathParts, isGroup } from '../../../formats/store.js';

/**
 * The encoding attributes anndata writes for one encoding:
 * `{'encoding-type', 'encoding-version'}` (`dict` and the sparse matrices
 * are 0.1.0, every other element 0.2.0).
 *
 * @param {string} encoding
 * @returns {{'encoding-type': string, 'encoding-version': string}}
 */
export function encodingAttrs(encoding) {
  const version = encoding === 'dict' || encoding.endsWith('_matrix') ? '0.1.0' : '0.2.0';
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
 * reader is done with the view.
 */
export function viewGroup({ path, attrs, children, real = null, ownAttributes = [], close = null }) {
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
