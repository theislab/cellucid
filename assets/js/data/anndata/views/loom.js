/**
 * Loom files (loompy, velocyto, SCENIC, LoomExperiment, SeuratDisk),
 * presented as AnnData: every array is read in place.
 *
 * A Loom file (https://linnarssonlab.org/loompy/format/) holds `/matrix`
 * (genes × cells), `/layers/<k>` of the same shape, `/row_attrs/*` (one
 * value per gene), `/col_attrs/*` (one value, or one row, per cell),
 * `/col_graphs/<g>` and `/row_graphs/<g>` as coordinate lists (`a`, `b`,
 * `w`), and global attributes: HDF5 attributes on `/` in Loom 2.0.1, arrays
 * under `/attrs` in Loom 3.0.0 (`LOOM_SPEC_VERSION`). Loom 2.0.1 stores
 * text as fixed-length ASCII with XML character references (`&#233;`),
 * which are decoded here.
 *
 * | Loom | AnnData |
 * | --- | --- |
 * | `/matrix` (genes × cells) | `X`, cells × genes: a transposed view |
 * | `/layers/<k>` | `layers/<k>` |
 * | `/col_attrs/<k>`, one value per cell | `obs` columns |
 * | `/col_attrs/<k>`, one row per cell (M × k) | `obsm/<k>` |
 * | `<b>_X`/`<b>_Y`[/`<b>_Z`], `<b>_1`/`<b>_2`[/`<b>_3`], `<b>1`/`<b>2`[/`<b>3`] | `obsm/X_<b>` (`X_embedding` when `<b>` is empty) |
 * | compound `Embedding` {`_X`, `_Y`} | `obsm/X_embedding` |
 * | compounds `Embeddings_X` / `Embeddings_Y` (SCope), member `<id>` of each | `obsm/X_embedding_<id>` |
 * | `CellID` (else `obs_names`, `cell_names`) | the obs index |
 * | `Gene` (else `var_names`, `gene_names`, `Accession`) | the var index; the rest are `var` columns |
 * | `/col_graphs/<g>` | `obsp/<g>`, a CSR matrix built from the coordinates on first read |
 * | global attributes | `uns` (`title` names the dataset) |
 *
 * Which axis holds the cells is decided by the attribute lengths, never
 * assumed: a file whose column attributes have as many rows as the matrix
 * (loomR's orientation) is read without transposing. A file with no
 * embedding is refused with what to do (`noEmbeddingRefusal`).
 *
 * @module data/anndata/views/loom
 */

import { isArrayNode, isGroup, numericDtype, stringDtype } from '../../../formats/store.js';
import { attributeValue } from '../elements.js';
import { LayoutRefusal, noEmbeddingRefusal } from './refusal.js';
import {
  computedArray,
  encodingAttrs,
  joinPath,
  memberArray,
  transposedArray,
  valueArray,
  viewArray,
  viewGroup,
} from './view-nodes.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { sharedOnce } from '../../../formats/io/abort.js';
import { allocateTypedArray, copyTypedArray } from '../../sparse-column-index.js';

/** How the AnnData reader names a Loom file in messages. */
export const LOOM_FORMAT = Object.freeze({ storage: 'HDF5', file: 'Loom' });

const OBS_INDEX_KEYS = Object.freeze(['CellID', 'obs_names', 'cell_names']);
const VAR_INDEX_KEYS = Object.freeze(['Gene', 'var_names', 'gene_names', 'Accession']);
const NUMERIC_KINDS = new Set(['int', 'uint', 'float']);

/**
 * Coordinate-column patterns: one embedding stored as one column per axis.
 * Each is `[pattern, axes]`: the pattern captures the base name, and the
 * axis suffixes it needs (the third is optional).
 */
const STACK_PATTERNS = Object.freeze([
  Object.freeze([/^(.*)_([XYZ])$/, ['X', 'Y', 'Z']]),
  Object.freeze([/^(.*)_([123])$/, ['1', '2', '3']]),
  Object.freeze([/^(.*[A-Za-z])([123])$/, ['1', '2', '3']]),
]);

/** Whether a store root is a Loom file. */
export function isLoomRoot(root) {
  if (!isGroup(root) || attributeValue(root, 'encoding-type') !== undefined) return false;
  const matrix = root.get('matrix');
  return isArrayNode(matrix) && matrix.shape.length === 2 && (root.has('col_attrs') || root.has('row_attrs'));
}

/** Decode the XML character references loompy 2 writes into ASCII text. */
function unescapeLoomText(value) {
  if (typeof value !== 'string' || !value.includes('&')) return value;
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&(lt|gt|quot|apos|amp);/g, (_match, name) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[name]);
}

/** One array as an AnnData element, its text decoded where Loom 2 encoded it. */
function asElement(array, path = array.path) {
  const text = array.dtype.kind === 'string';
  const attrs = encodingAttrs(text ? 'string-array' : 'array');
  if (text && array.dtype.variable === false) {
    return viewArray(array, {
      path,
      attrs,
      read: async (selection, options) => {
        const values = await array.read(selection, options);
        return Array.isArray(values) ? values.map(unescapeLoomText) : unescapeLoomText(values);
      },
    });
  }
  return viewArray(array, { path, attrs });
}

/** `0`, `1`, … as text: the index of an axis whose names a file does not store. */
function positionIndex(path, length) {
  return computedArray({
    path,
    dtype: stringDtype({ variable: true, encoding: 'utf-8' }),
    shape: [length],
    attrs: encodingAttrs('string-array'),
    compute: async () => Array.from({ length }, (_, index) => String(index)),
  });
}

/** One dataframe: an index and columns, each a function making its node. */
function dataFrame(path, indexKey, indexNode, columns) {
  const children = new Map([[indexKey, indexNode]]);
  for (const [key, make] of columns) children.set(key, make);
  return viewGroup({
    path,
    attrs: { ...encodingAttrs('dataframe'), _index: indexKey, 'column-order': [...columns.keys()] },
    children,
  });
}

/** A mapping (`dict`) of children made on first access. */
function mapping(path, children) {
  return viewGroup({ path, attrs: encodingAttrs('dict'), children });
}

/**
 * Columns of one row each per cell stacked into an `n × k` array (an
 * embedding stored as one column per axis): a read reads each column's rows.
 */
function stackedArray(path, members) {
  const rows = members[0].shape[0];
  const width = members.length;
  const allFloat32 = members.every(member => member.dtype.kind === 'float' && member.dtype.bytes === 4);
  const dtype = allFloat32 ? numericDtype('float', 4) : numericDtype('float', 8);
  const Output = allFloat32 ? Float32Array : Float64Array;
  return Object.freeze({
    kind: 'array',
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    attrs: Object.freeze(encodingAttrs('array')),
    attributeType: () => null,
    shape: [rows, width],
    dtype,
    chunks: members[0].chunks === null ? null : [members[0].chunks[0], width],
    fillValue: null,
    async storedBytes(selection, options) {
      const range = selection?.[0] ?? [0, rows];
      const sizes = await Promise.all(members.map(member => member.storedBytes([range], options)));
      return sizes.some(size => !Number.isFinite(size)) ? null : sizes.reduce((sum, size) => sum + size, 0);
    },
    async read(selection, options) {
      const [start, end] = selection?.[0] ?? [0, rows];
      const [first, last] = selection?.[1] ?? [0, width];
      const columns = await Promise.all(members.slice(first, last).map(member => member.read([[start, end]], options)));
      const count = last - first;
      const out = allocateTypedArray(Output, (end - start) * count, path);
      columns.forEach((values, column) => {
        for (let row = 0; row < end - start; row++) out[row * count + column] = Number(values[row]);
      });
      return out;
    },
  });
}

/** The base name an embedding stored as coordinate columns is listed by. */
function embeddingKeyOf(base) {
  const name = base.replace(/^_+|_+$/g, '');
  return name === '' || name === 'X' ? 'X_embedding' : (name.startsWith('X_') ? name : `X_${name}`);
}

/**
 * Embeddings stored one column per axis: `{key, members, used}` for each
 * group of numeric one-dimensional cell attributes that share a base name
 * and carry the first two axis suffixes.
 */
function coordinateStacks(columns) {
  const stacks = [];
  const used = new Set();
  for (const [pattern, axes] of STACK_PATTERNS) {
    const bases = new Map();
    for (const [key, array] of columns) {
      if (used.has(key) || !NUMERIC_KINDS.has(array.dtype.kind)) continue;
      const match = pattern.exec(key);
      if (match === null) continue;
      if (!bases.has(match[1])) bases.set(match[1], new Map());
      bases.get(match[1]).set(match[2], key);
    }
    for (const [base, byAxis] of bases) {
      if (!byAxis.has(axes[0]) || !byAxis.has(axes[1])) continue;
      const keys = axes.slice(0, byAxis.has(axes[2]) ? 3 : 2).map(axis => byAxis.get(axis));
      for (const key of keys) used.add(key);
      stacks.push({ key: embeddingKeyOf(base), keys });
    }
  }
  return { stacks, used };
}

/**
 * The global attributes as `uns`: Loom 3's `/attrs` arrays, else the root's
 * own HDF5 attributes (Loom 2).
 */
function unsOf(root) {
  const attrs = root.get('attrs');
  const children = new Map();
  if (isGroup(attrs)) {
    for (const key of attrs.keys()) {
      const node = attrs.get(key);
      if (isArrayNode(node) && node.shape.length <= 1 && node.dtype.kind !== 'compound') {
        children.set(key, () => asElement(node, joinPath('/uns', key)));
      }
    }
  } else {
    for (const [key, value] of Object.entries(root.attrs)) {
      const values = Array.isArray(value) ? value : [value];
      if (values.length === 0) continue;
      if (values.every(item => typeof item === 'string')) {
        children.set(key, () => valueArray({
          path: joinPath('/uns', key),
          dtype: stringDtype({ variable: true, encoding: 'utf-8' }),
          shape: Array.isArray(value) ? [values.length] : [],
          values: values.map(unescapeLoomText),
          attrs: encodingAttrs('string-array'),
        }));
      } else if (values.every(item => typeof item === 'number')) {
        children.set(key, () => valueArray({
          path: joinPath('/uns', key),
          dtype: numericDtype('float', 8),
          shape: Array.isArray(value) ? [values.length] : [],
          values: Float64Array.from(values),
          attrs: encodingAttrs('array'),
        }));
      }
    }
  }
  return mapping('/uns', children);
}

/** The coordinate list of one Loom graph as a CSR matrix, built on first read. */
function graphMatrix(group, path, nCells) {
  const label = `Loom graph ${group.path}`;
  const a = group.get('a');
  const b = group.get('b');
  const w = group.get('w');
  if (!isArrayNode(a) || !isArrayNode(b) || !isArrayNode(w) ||
      a.shape.length !== 1 || b.shape[0] !== a.shape[0] || w.shape[0] !== a.shape[0]) {
    return null;
  }
  const nnz = a.shape[0];
  const wide = nnz > 2147483647;
  // Built once, shared by every read asking meanwhile (`sharedOnce`).
  const build = sharedOnce(async options => {
    const [rows, columns, weights] = await Promise.all([a.read(undefined, options), b.read(undefined, options), w.read(undefined, options)]);
    const counts = allocateTypedArray(Float64Array, nCells + 1, 'Loom graph row counts');
    const at = index => {
      const value = Number(rows[index]);
      if (!Number.isInteger(value) || value < 0 || value >= nCells) throw new RangeError(`${label} names cell ${value}, outside its ${formatCountOf(nCells, 'cell')}`);
      return value;
    };
    for (let index = 0; index < nnz; index++) counts[at(index) + 1]++;
    for (let row = 0; row < nCells; row++) counts[row + 1] += counts[row];
    const indptr = allocateTypedArray(wide ? BigInt64Array : Int32Array, nCells + 1, 'Loom graph indptr');
    for (let row = 0; row <= nCells; row++) indptr[row] = wide ? BigInt(counts[row]) : counts[row];
    const next = copyTypedArray(Float64Array, counts.subarray(0, nCells), 'Loom graph row counts');
    const order = allocateTypedArray(Float64Array, nnz, 'Loom graph order');
    for (let index = 0; index < nnz; index++) order[next[Number(rows[index])]++] = index;
    const indices = allocateTypedArray(Int32Array, nnz, 'Loom graph indices');
    const data = allocateTypedArray(Float64Array, nnz, 'Loom graph values');
    for (let row = 0; row < nCells; row++) {
      const start = counts[row];
      const end = counts[row + 1];
      const entries = Array.from(order.subarray(start, end));
      entries.sort((left, right) => Number(columns[left]) - Number(columns[right]));
      entries.forEach((index, offset) => {
        const column = Number(columns[index]);
        if (!Number.isInteger(column) || column < 0 || column >= nCells) {
          throw new RangeError(`${label} names cell ${column}, outside its ${formatCountOf(nCells, 'cell')}`);
        }
        indices[start + offset] = column;
        data[start + offset] = Number(weights[index]);
      });
    }
    return { indptr, indices, data };
  });
  const part = (name, dtype, length) => () => computedArray({
    path: joinPath(path, name),
    dtype,
    shape: [length],
    compute: async options => (await build(options))[name],
  });
  return viewGroup({
    path,
    attrs: { ...encodingAttrs('csr_matrix'), shape: [nCells, nCells] },
    children: new Map([
      ['data', part('data', numericDtype('float', 8), nnz)],
      ['indices', part('indices', numericDtype('int', 4), nnz)],
      ['indptr', part('indptr', numericDtype('int', wide ? 8 : 4), nCells + 1)],
    ]),
  });
}

/** The arrays of one attribute group, by key. */
function arraysOf(group) {
  const arrays = new Map();
  if (!isGroup(group)) return arrays;
  for (const key of group.keys()) {
    const node = group.get(key);
    if (isArrayNode(node)) arrays.set(key, node);
  }
  return arrays;
}

/**
 * The AnnData view of a Loom file.
 *
 * @param {Object} root - The Loom file's root group
 * @param {{name: string}} context
 * @returns {Object}
 */
export function loomView(root, { name }) {
  const matrix = root.get('matrix');
  const colAttrs = arraysOf(root.get('col_attrs'));
  const rowAttrs = arraysOf(root.get('row_attrs'));
  const [first, second] = matrix.shape;
  const colLengths = new Set([...colAttrs.values()].map(array => array.shape[0]));
  const rowLengths = new Set([...rowAttrs.values()].map(array => array.shape[0]));
  // Cells are the matrix's columns (Loom's own orientation) unless every
  // attribute says they are its rows.
  let transposed = true;
  const fits = (lengths, extent) => lengths.size === 0 || (lengths.size === 1 && lengths.has(extent));
  if (!(fits(colLengths, second) && fits(rowLengths, first))) {
    if (first !== second && fits(colLengths, first) && fits(rowLengths, second)) {
      transposed = false;
    } else {
      throw new LayoutRefusal(
        `${name} is a Loom file whose cell and gene attributes do not match its ${first} × ${second} matrix ` +
        `(cell attributes have ${[...colLengths].join(' or ')} rows, gene attributes ${[...rowLengths].join(' or ')}). ` +
        'Write it again with loompy (loompy.create) or open the data it was made from.',
        { reason: 'loom-shape' }
      );
    }
  }
  const nCells = transposed ? second : first;
  const nGenes = transposed ? first : second;
  const asMatrix = (array, path) => {
    if (array.shape.length !== 2 || array.shape[0] !== matrix.shape[0] || array.shape[1] !== matrix.shape[1]) return null;
    return transposed
      ? transposedArray(array, { path, attrs: encodingAttrs('array') })
      : viewArray(array, { path, attrs: encodingAttrs('array') });
  };

  // obs: the index, plain columns, embeddings.
  const obsIndexKey = OBS_INDEX_KEYS.find(key => colAttrs.get(key)?.shape.length === 1 && colAttrs.get(key).dtype.kind === 'string') ?? null;
  const oneDimensional = new Map([...colAttrs].filter(([, array]) => array.shape.length === 1 && array.dtype.kind !== 'compound'));
  const { stacks, used } = coordinateStacks([...oneDimensional].filter(([key]) => key !== obsIndexKey));
  const obsColumns = new Map();
  for (const [key, array] of oneDimensional) {
    if (key === obsIndexKey || used.has(key)) continue;
    if (!['string', 'int', 'uint', 'float', 'bool'].includes(array.dtype.kind)) continue;
    obsColumns.set(key, () => asElement(array, joinPath('/obs', key)));
  }
  const indexKey = obsIndexKey ?? '_index';
  const obs = () => dataFrame(
    '/obs',
    indexKey,
    () => (obsIndexKey === null
      ? positionIndex(joinPath('/obs', indexKey), nCells)
      : asElement(colAttrs.get(obsIndexKey), joinPath('/obs', indexKey))),
    obsColumns
  );

  const obsm = new Map();
  for (const [key, array] of colAttrs) {
    if (array.shape.length === 2 && NUMERIC_KINDS.has(array.dtype.kind) && array.shape[1] > 0) {
      obsm.set(key, () => asElement(array, joinPath('/obsm', key)));
    }
  }
  for (const { key, keys } of stacks) {
    if (!obsm.has(key)) obsm.set(key, () => stackedArray(joinPath('/obsm', key), keys.map(item => colAttrs.get(item))));
  }
  const compoundCoordinates = (array, xName, yName, key) => {
    const fields = array.dtype.fields;
    const x = fields.find(field => field.name === xName && field.shape.length === 0);
    const y = fields.find(field => field.name === yName && field.shape.length === 0);
    if (x === undefined || y === undefined || obsm.has(key)) return;
    obsm.set(key, () => stackedArray(joinPath('/obsm', key), [memberArray(array, x), memberArray(array, y)]));
  };
  const embedding = colAttrs.get('Embedding');
  if (embedding?.dtype.kind === 'compound' && embedding.shape.length === 1) compoundCoordinates(embedding, '_X', '_Y', 'X_embedding');
  const embeddingsX = colAttrs.get('Embeddings_X');
  const embeddingsY = colAttrs.get('Embeddings_Y');
  if (embeddingsX?.dtype.kind === 'compound' && embeddingsY?.dtype.kind === 'compound') {
    for (const field of embeddingsX.dtype.fields) {
      const other = embeddingsY.dtype.fields.find(item => item.name === field.name);
      const key = `X_embedding_${field.name}`;
      if (other === undefined || field.shape.length !== 0 || other.shape.length !== 0 || obsm.has(key)) continue;
      obsm.set(key, () => stackedArray(joinPath('/obsm', key), [memberArray(embeddingsX, field), memberArray(embeddingsY, other)]));
    }
  }
  if (obsm.size === 0) {
    throw noEmbeddingRefusal(
      `${name} is a Loom file that`,
      'A Loom file keeps an embedding as cell attributes (an n × 2 X_umap, or _X and _Y); this one has none.'
    );
  }

  // var: the index and every other one-value-per-gene attribute.
  const varIndexKey = VAR_INDEX_KEYS.find(key => rowAttrs.get(key)?.shape.length === 1 && rowAttrs.get(key).dtype.kind === 'string') ?? null;
  const varColumns = new Map();
  for (const [key, array] of rowAttrs) {
    if (key === varIndexKey || array.shape.length !== 1) continue;
    if (!['string', 'int', 'uint', 'float', 'bool'].includes(array.dtype.kind)) continue;
    varColumns.set(key, () => asElement(array, joinPath('/var', key)));
  }
  const varKey = varIndexKey ?? '_index';
  const var_ = () => dataFrame(
    '/var',
    varKey,
    () => (varIndexKey === null
      ? positionIndex(joinPath('/var', varKey), nGenes)
      : asElement(rowAttrs.get(varIndexKey), joinPath('/var', varKey))),
    varColumns
  );

  const layers = new Map();
  const layerGroup = root.get('layers');
  if (isGroup(layerGroup)) {
    for (const key of layerGroup.keys()) {
      const node = layerGroup.get(key);
      if (!isArrayNode(node) || asMatrix(node, '/') === null) continue;
      layers.set(key === '' ? 'total' : key, () => asMatrix(node, joinPath('/layers', key === '' ? 'total' : key)));
    }
  }

  const obsp = new Map();
  const graphs = root.get('col_graphs');
  if (isGroup(graphs)) {
    for (const key of graphs.keys()) {
      const group = graphs.get(key);
      if (!isGroup(group) || key.includes('/')) continue;
      const node = graphMatrix(group, joinPath('/obsp', key), nCells);
      if (node !== null) obsp.set(key, () => node);
    }
  }

  return viewGroup({
    path: '/',
    attrs: encodingAttrs('anndata'),
    children: new Map([
      ['X', () => asMatrix(matrix, '/X')],
      ['obs', obs],
      ['var', var_],
      ['obsm', () => mapping('/obsm', obsm)],
      ['obsp', () => mapping('/obsp', obsp)],
      ['layers', () => mapping('/layers', layers)],
      ['uns', () => unsOf(root)],
    ]),
    close: () => root.close?.(),
  });
}

/** The Loom entry of `LAYOUT_VIEWS`. */
export const LOOM_VIEW = Object.freeze({
  recognize: isLoomRoot,
  view: loomView,
  readerFormat: LOOM_FORMAT,
});
