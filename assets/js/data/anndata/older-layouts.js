/**
 * AnnData files written before anndata 0.8 (2022), presented in the current
 * on-disk layout so that the one set of element rules (`elements.js`) reads
 * them without a second code path. One implementation serves `.h5ad` and
 * Zarr alike: it works on the array-store model (`formats/store.js`).
 *
 * Two earlier layouts are in circulation, and each differs from the current
 * one in a closed set of ways, translated here and nowhere else.
 *
 * anndata 0.7 (2019–2022), and every file SeuratDisk's `Convert()` writes:
 *
 * - the root carries no `encoding-type`; it is `anndata` 0.1.0 (a Zarr store
 *   from then has no root `.zattrs` at all);
 * - arrays carry no encoding attributes; a string array is `string-array`
 *   0.2.0, any other `array` 0.2.0;
 * - dataframes are version 0.1.0, their `column-order` may list only some of
 *   the columns, and a categorical column stores its codes in place with its
 *   categories under `__categories/<column>` (`ordered` on the categories);
 *   they become 0.2.0 dataframes listing every column, whose categorical
 *   columns are `categorical` 0.2.0 groups of `codes` and `categories`;
 * - mappings (`obsm`, `layers`, `obsp`, …, `uns`) carry no encoding; they are
 *   `dict` 0.1.0;
 * - sparse matrices written through h5sparse name themselves with
 *   `h5sparse_format` and `h5sparse_shape`; they become `csr_matrix` /
 *   `csc_matrix` 0.1.0 with `shape`.
 *
 * anndata 0.6 and earlier (HDF5 only), in addition:
 *
 * - `obs` and `var` are compound arrays, one record per row with an `index`
 *   member and one member per column; each column is presented as its own
 *   array (read with `readField`, one member at a time), and a categorical
 *   column's categories are `uns/<column>_categories`;
 * - `obsm` may be a compound array with one multi-column member per
 *   embedding; each member is presented as a two-dimensional array;
 * - `raw` is stored as root entries `raw.X`, `raw.var` and `raw.varm`;
 * - `uns` scalars are one-element arrays.
 *
 * Only what the file lacks is supplied: an encoding a node does declare is
 * kept, so a file that mixes eras is read as it says. Everything else about a
 * real node (shape, element type, chunks, values) is the real one.
 *
 * @module data/anndata/older-layouts
 */

import { isArrayNode, isGroup } from '../../formats/store.js';
import { attributeValue } from './elements.js';
import { encodingAttrs, joinPath, memberArray, viewArray, viewGroup } from './views/view-nodes.js';

const MAPPING_ROLES = ['obsm', 'varm', 'obsp', 'varp', 'layers'];

/** Whether a store holds AnnData in a layout anndata wrote before 0.8. */
export function isOlderAnnDataLayout(root) {
  return isGroup(root) && attributeValue(root, 'encoding-type') === undefined &&
    (root.has('obs') || root.has('var') || root.has('X'));
}

/** An array, a sparse matrix, or (inside a mapping) a dataframe or nested mapping. */
function asElement(node) {
  if (isGroup(node)) {
    const declared = attributeValue(node, 'encoding-type');
    if (declared === 'dataframe') return asDataFrame(node, () => null);
    if (declared === 'csr_matrix' || declared === 'csc_matrix') return node;
    const format = attributeValue(node, 'h5sparse_format');
    if (format === 'csr' || format === 'csc') {
      return viewGroup({
        path: node.path,
        real: node,
        attrs: { ...node.attrs, ...encodingAttrs(`${format}_matrix`), shape: attributeValue(node, 'h5sparse_shape') },
        ownAttributes: ['encoding-type', 'encoding-version', 'shape'],
        children: new Map(node.keys().map(key => [key, () => node.get(key)])),
      });
    }
    if (declared === undefined) return asMapping(node, asElement);
    return node;
  }
  if (!isArrayNode(node) || attributeValue(node, 'encoding-type') !== undefined) return node;
  return viewArray(node, {
    attrs: encodingAttrs(node.dtype.kind === 'string' ? 'string-array' : 'array'),
  });
}

function asMapping(node, childOf) {
  if (isArrayNode(node) && node.dtype.kind === 'compound') return compoundMapping(node);
  if (!isGroup(node)) return node;
  const declared = attributeValue(node, 'encoding-type') !== undefined;
  return viewGroup({
    path: node.path,
    real: node,
    attrs: declared ? node.attrs : { ...node.attrs, ...encodingAttrs('dict') },
    ownAttributes: declared ? [] : ['encoding-type', 'encoding-version'],
    children: new Map(node.keys().map(key => [key, () => childOf(node.get(key))])),
  });
}

/** A one-element `uns` array is the scalar an earlier writer meant. */
function asUnsValue(node) {
  if (isArrayNode(node) && node.shape.length === 1 && node.shape[0] === 1 &&
      attributeValue(node, 'encoding-type') === undefined) {
    return viewArray(node, {
      shape: [],
      read: async (_selection, options) => {
        const values = await node.read([[0, 1]], options);
        return Array.isArray(values) || ArrayBuffer.isView(values) ? values[0] : values;
      },
    });
  }
  return asElement(node);
}

function asUns(node) {
  return asMapping(node, item => (isGroup(item) ? asUns(item) : asUnsValue(item)));
}

function asRaw(node, categoriesOf) {
  if (!isGroup(node)) return node;
  return viewGroup({
    path: node.path,
    real: node,
    attrs: node.attrs,
    children: new Map(node.keys().map(key => [key, () => {
      const item = node.get(key);
      if (key === 'var') return asDataFrame(item, categoriesOf);
      if (key === 'X') return asElement(item);
      if (key === 'varm') return asMapping(item, asElement);
      return item;
    }])),
  });
}

/**
 * Codes stored in place with their categories elsewhere; anndata 0.7 records
 * `ordered` on the categories (earlier writers on the codes).
 */
function categorical(codes, categories) {
  const ordered = attributeValue(categories, 'ordered') ?? attributeValue(codes, 'ordered');
  return viewGroup({
    path: codes.path,
    attrs: { ...encodingAttrs('categorical'), ordered: ordered === true || ordered === 1 },
    children: new Map([
      ['codes', () => viewArray(codes, { attrs: encodingAttrs('array'), path: joinPath(codes.path, 'codes') })],
      ['categories', () => asElement(categories)],
    ]),
  });
}

/**
 * A dataframe from before 0.8 as a current one: version 0.2.0, every column
 * in `column-order`, categorical columns as `categorical` groups.
 */
function asDataFrame(node, categoriesOf) {
  if (isArrayNode(node) && node.dtype.kind === 'compound') return compoundDataFrame(node, categoriesOf);
  if (!isGroup(node) || attributeValue(node, 'encoding-version') === '0.2.0') return node;
  const realKeys = node.keys();
  const categoriesGroup = node.has('__categories') ? node.get('__categories') : null;
  const categorised = new Set(isGroup(categoriesGroup) ? categoriesGroup.keys() : []);
  const declaredIndex = attributeValue(node, '_index');
  const indexKey = typeof declaredIndex === 'string' && realKeys.includes(declaredIndex)
    ? declaredIndex
    : ['_index', 'index'].find(key => realKeys.includes(key));
  const columns = realKeys.filter(key => key !== indexKey && key !== '__categories');
  const declaredOrder = attributeValue(node, 'column-order');
  const listed = Array.isArray(declaredOrder) ? declaredOrder.filter(key => columns.includes(key)) : [];
  const columnOrder = [...listed, ...columns.filter(key => !listed.includes(key))];
  return viewGroup({
    path: node.path,
    real: node,
    attrs: { ...node.attrs, ...encodingAttrs('dataframe'), _index: indexKey, 'column-order': columnOrder },
    ownAttributes: ['encoding-type', 'encoding-version', '_index', 'column-order'],
    children: new Map(realKeys.filter(key => key !== '__categories').map(key => [key, () => {
      const item = node.get(key);
      if (key === indexKey) return asElement(item);
      if (categorised.has(key)) return categorical(item, categoriesGroup.get(key));
      const unsCategories = categoriesOf(key);
      return unsCategories ? categorical(item, unsCategories) : asElement(item);
    }])),
  });
}

// ------------------------------------------------- anndata 0.6 compounds

function compoundDataFrame(compound, categoriesOf) {
  const fields = compound.dtype.fields;
  const indexField = fields.find(field => field.name === 'index' || field.name === '_index');
  const columns = fields.filter(field => field !== indexField);
  return viewGroup({
    path: compound.path,
    attrs: {
      ...encodingAttrs('dataframe'),
      _index: indexField?.name ?? 'index',
      'column-order': columns.map(field => field.name),
    },
    children: new Map(fields.map(field => [field.name, () => {
      const column = memberArray(compound, field);
      const unsCategories = field === indexField ? null : categoriesOf(field.name);
      return unsCategories ? categorical(column, unsCategories) : asElement(column);
    }])),
  });
}

/** anndata 0.6's compound `obsm`: one multi-column member per embedding. */
function compoundMapping(compound) {
  return viewGroup({
    path: compound.path,
    attrs: encodingAttrs('dict'),
    children: new Map(compound.dtype.fields.map(field => [field.name, () => asElement(memberArray(compound, field))])),
  });
}

/**
 * The current-layout view of an older AnnData store root.
 *
 * @param {Object} root - A store root group
 * @returns {Object} A store root group in the current layout
 */
export function currentLayoutView(root) {
  const uns = root.has('uns') ? root.get('uns') : null;
  // anndata 0.6 keeps a categorical column's categories in uns.
  const categoriesOf = column => (isGroup(uns) && uns.has(`${column}_categories`)
    ? uns.get(`${column}_categories`)
    : null);
  const rootKeys = root.keys();
  // anndata 0.6 stores raw as root entries `raw.X`, `raw.var`, `raw.varm`.
  const flatRaw = rootKeys.includes('raw.X') && !rootKeys.includes('raw');
  const children = new Map();
  for (const key of rootKeys) {
    if (flatRaw && key.startsWith('raw.')) continue;
    children.set(key, () => {
      const node = root.get(key);
      if (key === 'obs' || key === 'var') return asDataFrame(node, categoriesOf);
      if (key === 'X') return asElement(node);
      if (key === 'raw') return asRaw(node, categoriesOf);
      if (key === 'uns') return asUns(node);
      if (MAPPING_ROLES.includes(key)) return asMapping(node, asElement);
      return node;
    });
  }
  if (flatRaw) {
    const rawChildren = new Map([['X', () => asElement(root.get('raw.X'))]]);
    if (rootKeys.includes('raw.var')) rawChildren.set('var', () => asDataFrame(root.get('raw.var'), categoriesOf));
    if (rootKeys.includes('raw.varm')) rawChildren.set('varm', () => asMapping(root.get('raw.varm'), asElement));
    children.set('raw', () => viewGroup({ path: '/raw', attrs: {}, children: rawChildren }));
  }
  const view = viewGroup({
    path: '/',
    real: root,
    attrs: { ...root.attrs, ...encodingAttrs('anndata') },
    ownAttributes: ['encoding-type', 'encoding-version'],
    children,
  });
  return view;
}
