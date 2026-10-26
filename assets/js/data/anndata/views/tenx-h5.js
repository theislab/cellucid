/**
 * 10x Genomics Cell Ranger feature-barcode matrices (`.h5`), presented as
 * AnnData: the matrix is read in place.
 *
 * Two layouts are in circulation:
 *
 * - **Cell Ranger 3 and later** (root `filetype = 'matrix'`, `version` 2):
 *   `/matrix/{barcodes, data, indices, indptr, shape}` and
 *   `/matrix/features/{id, name, feature_type, genome, <tags>…}`;
 * - **Cell Ranger 1 and 2** (PyTables): one group per genome,
 *   `/<genome>/{barcodes, data, indices, indptr, shape, genes, gene_names}`.
 *
 * The matrix is stored by barcode (CSC over features × barcodes), which is
 * AnnData's CSR over cells × features: `X` is the stored arrays as they
 * are, no copy. The names follow `scanpy.read_10x_h5`, so a session saved on
 * the `.h5` applies to what scanpy reads from it:
 *
 * | 10x | AnnData |
 * | --- | --- |
 * | `barcodes` | the obs index |
 * | `features/name` (`gene_names`) | the var index |
 * | `features/id` (`genes`) | `var['gene_ids']` |
 * | `features/feature_type` | `var['feature_types']` |
 * | `features/genome` and other per-feature tags | `var['genome']`, `var['<tag>']` |
 *
 * A file of several feature types (Gene Expression with Antibody Capture,
 * CRISPR Guide Capture, …) has one modality per type (`modalities.js`),
 * each a column window of the one matrix: Cell Ranger stores the features
 * of a type together. Reading which feature is of which type is the one
 * read this view makes (one small array). A Cell Ranger 2 file of several
 * genomes has one modality per genome.
 *
 * A count matrix has no cell embedding: on its own it is refused with what
 * to do (`noEmbeddingRefusal`); the `outs/` folder it came from carries
 * Cell Ranger's own projections (`tenx-outs.js`), which are passed in as
 * `context.analysis`. `molecule_info.h5` is a molecule table, not a matrix,
 * and is refused naming the file to open instead.
 *
 * @module data/anndata/views/tenx-h5
 */

import { isArrayNode, isGroup } from '../../../formats/store.js';
import { defaultModality } from '../../data-mapping.js';
import { attributeValue } from '../elements.js';
import { LayoutRefusal, noEmbeddingRefusal } from './refusal.js';
import { modalityList } from './modalities.js';
import { columnWindowMatrix, encodingAttrs, joinPath, rowWindowArray, viewArray, viewGroup } from './view-nodes.js';

/** How the AnnData reader names a 10x file in messages. */
export const TENX_H5_FORMAT = Object.freeze({ storage: 'HDF5', file: '10x Cell Ranger HDF5' });

const MATRIX_ARRAYS = Object.freeze(['barcodes', 'data', 'indices', 'indptr']);

/** One text attribute of the root, whether stored as a string or bytes. */
function textAttribute(node, key) {
  const value = attributeValue(node, key);
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first : null;
}

/** Whether `group` holds a 10x matrix's arrays (of either layout). */
function isMatrixGroup(group, namesKey) {
  return isGroup(group) && MATRIX_ARRAYS.every(key => isArrayNode(group.get(key))) &&
    (namesKey === null || isArrayNode(group.get(namesKey)) || isGroup(group.get(namesKey)));
}

/** The genome groups of a Cell Ranger 2 file. */
function genomeGroups(root) {
  return root.keys().filter(key => isMatrixGroup(root.get(key), 'genes'));
}

/** Whether a store root is a 10x Cell Ranger HDF5 file (a matrix or a molecule table). */
export function isTenxRoot(root) {
  if (!isGroup(root) || attributeValue(root, 'encoding-type') !== undefined) return false;
  const filetype = textAttribute(root, 'filetype');
  if (filetype === 'molecule') return true;
  if (isMatrixGroup(root.get('matrix'), 'features')) return true;
  const genomes = genomeGroups(root);
  return genomes.length > 0 && genomes.length === root.keys().filter(key => isGroup(root.get(key))).length;
}

/** A one-dimensional stored array as an AnnData element (text or numbers). */
function element(array, path) {
  return viewArray(array, { path, attrs: encodingAttrs(array.dtype.kind === 'string' ? 'string-array' : 'array') });
}

/** A dataframe of an index and columns, each made on first access. */
function dataFrame(path, indexKey, makeIndex, columns) {
  const children = new Map([[indexKey, makeIndex], ...columns]);
  return viewGroup({
    path,
    attrs: { ...encodingAttrs('dataframe'), _index: indexKey, 'column-order': [...columns.keys()] },
    children,
  });
}

/** The CSR matrix (cells × features) of one matrix group. */
function csrOf(group, path, nCells, nFeatures) {
  return viewGroup({
    path,
    attrs: { ...encodingAttrs('csr_matrix'), shape: [nCells, nFeatures] },
    children: new Map(['data', 'indices', 'indptr'].map(key => [key, () => group.get(key)])),
  });
}

/**
 * One feature list as a var dataframe: `features` arrays (Cell Ranger 3) or
 * a genome group's `genes`/`gene_names` (Cell Ranger 2), rows `[start,
 * start + count)`.
 */
function varFrame(arrays, path, start, count, total) {
  const pick = array => (start === 0 && count === total
    ? element(array, array.path)
    : rowWindowArray(array, { start, count, attrs: encodingAttrs(array.dtype.kind === 'string' ? 'string-array' : 'array') }));
  const columns = new Map();
  for (const [key, array] of arrays.columns) columns.set(key, () => pick(array));
  return dataFrame(path, '_index', () => pick(arrays.index), columns);
}

/** The feature arrays of a Cell Ranger 3 file, by the names scanpy gives them. */
function featureArrays(features, nFeatures) {
  const index = features.get('name');
  const columns = new Map();
  const rename = { id: 'gene_ids', feature_type: 'feature_types' };
  // scanpy's order: gene_ids, feature_types, then the tags.
  const keys = ['id', 'feature_type', ...features.keys().filter(key => key !== 'id' && key !== 'feature_type')];
  for (const key of keys) {
    if (!features.has(key)) continue;
    const array = features.get(key);
    if (key === 'name' || key === '_all_tag_keys' || !isArrayNode(array)) continue;
    if (array.shape.length !== 1 || array.shape[0] !== nFeatures) continue;
    if (!['string', 'int', 'uint', 'float', 'bool'].includes(array.dtype.kind)) continue;
    columns.set(rename[key] ?? key, array);
  }
  return { index, columns };
}

/**
 * The feature types of a Cell Ranger 3 matrix as contiguous windows, in
 * stored order: `[{name, start, count}]`.
 */
async function featureTypeWindows(features, nFeatures, name, options) {
  const types = features.get('feature_type');
  if (!isArrayNode(types) || types.shape[0] !== nFeatures) return [{ name: 'Gene Expression', start: 0, count: nFeatures }];
  const values = await types.read(undefined, options);
  const windows = [];
  for (let feature = 0; feature < nFeatures; feature++) {
    const type = String(values[feature]);
    const last = windows.at(-1);
    if (last?.name === type) {
      last.count++;
      continue;
    }
    if (windows.some(window => window.name === type)) {
      throw new LayoutRefusal(
        `${name} keeps the features of type '${type}' in more than one place, so they cannot be read as one modality. ` +
        "Read it with scanpy (sc.read_10x_h5(path, gex_only=False)) and write it as .h5ad, then open that file.",
        { reason: 'split-feature-type' }
      );
    }
    windows.push({ name: type, start: feature, count: 1 });
  }
  return windows;
}

/**
 * Where an embedding of a 10x matrix is, for the refusal of one without, by
 * what was opened: Cell Ranger's `outs/` folder holds UMAP and t-SNE
 * projections beside the matrix. A file on this computer is beside its
 * folder; a link opens one file, never a folder, so its folder is opened
 * from this computer once downloaded (no provider shares a folder, and an
 * archive of one is not a format Cellucid reads); an `outs/` folder opened
 * without projections was run without its secondary analysis.
 *
 * @param {'file'|'folder'} opened
 * @param {boolean} fromLink
 */
function outsHint(opened, fromLink) {
  if (opened === 'folder') {
    return 'Its analysis/ folder holds no UMAP or t-SNE projection (Cell Ranger was run with --nosecondary).';
  }
  return fromLink
    ? 'Cell Ranger writes UMAP and t-SNE projections beside it, in the outs/ folder, which a link to one file cannot ' +
      'bring along: download the whole outs/ folder and open it from this computer (Open… › Folder…).'
    : 'Cell Ranger writes UMAP and t-SNE projections beside it: open the whole outs/ folder (Open… › Folder…), ' +
      'which holds this file and analysis/.';
}

/** obs and obsm from the analysis of an `outs/` folder, merged into the view's. */
function analysisChildren(analysis, name, fromLink) {
  const obsColumns = analysis?.obs ?? new Map();
  const obsm = analysis?.obsm ?? new Map();
  if (obsm.size === 0) {
    throw noEmbeddingRefusal(`${name} is a 10x Cell Ranger count matrix that`, outsHint(analysis === null ? 'file' : 'folder', fromLink));
  }
  return { obsColumns, obsm };
}

/** A mapping of children made on first access. */
function mapping(path, children) {
  return viewGroup({ path, attrs: encodingAttrs('dict'), children });
}

/**
 * The AnnData view of a 10x Cell Ranger HDF5 file.
 *
 * @param {Object} root
 * @param {{name: string, analysis?: {obs: Map<string, Function>, obsm: Map<string, Function>}|null,
 *   signal?: AbortSignal|null, fromLink?: boolean}} context - `analysis`: an
 *   `outs/` folder's (null for the file alone); `fromLink`: opened from a link
 * @returns {Promise<Object>}
 */
export async function tenxView(root, { name, analysis = null, signal = null, fromLink = false }) {
  if (textAttribute(root, 'filetype') === 'molecule') {
    throw new LayoutRefusal(
      `${name} is a Cell Ranger molecule table (molecule_info.h5), not a count matrix. ` +
      (fromLink
        ? 'Link filtered_feature_bc_matrix.h5 from the same outs/ folder instead, or download the whole outs/ folder ' +
          'and open it from this computer (Open… › Folder…).'
        : 'Open filtered_feature_bc_matrix.h5 from the same outs/ folder, or the whole outs/ folder.'),
      { reason: 'molecule-table' }
    );
  }
  const matrix = root.get('matrix');
  /** @type {Array<{name: string, matrixGroup: Object, nCells: number, arrays: Object, nFeatures: number, windows: Array}>} */
  let sources;
  if (isMatrixGroup(matrix, 'features')) {
    const features = matrix.get('features');
    const nFeatures = features.get('id')?.shape[0] ?? features.get('name').shape[0];
    const windows = await featureTypeWindows(features, nFeatures, name, { signal });
    sources = [{ matrixGroup: matrix, nCells: matrix.get('barcodes').shape[0], nFeatures, arrays: featureArrays(features, nFeatures), windows }];
  } else {
    const genomes = genomeGroups(root);
    sources = genomes.map(genome => {
      const group = root.get(genome);
      const nFeatures = group.get('genes').shape[0];
      const index = isArrayNode(group.get('gene_names')) ? group.get('gene_names') : group.get('genes');
      return {
        matrixGroup: group,
        nCells: group.get('barcodes').shape[0],
        nFeatures,
        arrays: { index, columns: new Map([['gene_ids', group.get('genes')]]) },
        windows: [{ name: genome, start: 0, count: nFeatures }],
      };
    });
    const cells = new Set(sources.map(source => source.nCells));
    if (cells.size !== 1) {
      throw new LayoutRefusal(
        `${name} holds genomes with different cells (${sources.map(source => `${source.windows[0].name}: ${source.nCells}`).join(', ')}). ` +
        "Read one genome with scanpy (sc.read_10x_h5(path, genome='…')), write it as .h5ad and open that.",
        { reason: 'genomes-differ' }
      );
    }
  }
  const nCells = sources[0].nCells;
  const barcodes = sources[0].matrixGroup.get('barcodes');
  const { obsColumns, obsm } = analysisChildren(analysis, name, fromLink);

  // One modality per feature type (or genome); none when there is one.
  const entries = sources.flatMap(source => source.windows.map(window => ({ ...window, source })));
  const groupOf = entry => {
    const { source, start, count } = entry;
    const path = entries.length === 1 ? '/' : joinPath('/mod', entry.name);
    const full = csrOf(source.matrixGroup, joinPath(source.matrixGroup.path, 'X'), nCells, source.nFeatures);
    const X = start === 0 && count === source.nFeatures
      ? full
      : columnWindowMatrix(full, { start, count, path: joinPath(path, 'X') });
    return {
      X,
      var: varFrame(source.arrays, joinPath(path, 'var'), start, count, source.nFeatures),
    };
  };
  const obs = () => dataFrame('/obs', '_index', () => element(barcodes, joinPath('/obs', '_index')), obsColumns);
  const common = [
    ['obs', obs],
    ['obsm', () => mapping('/obsm', obsm)],
    ['uns', () => mapping('/uns', new Map())],
  ];
  if (entries.length === 1) {
    const only = groupOf(entries[0]);
    return viewGroup({
      path: '/',
      attrs: encodingAttrs('anndata'),
      children: new Map([...common, ['X', () => only.X], ['var', () => only.var]]),
      close: () => root.close?.(),
    });
  }
  const names = entries.map(entry => entry.name);
  const chosen = defaultModality(names);
  const made = new Map();
  const modalityGroup = entry => {
    if (!made.has(entry.name)) {
      const { X, var: features } = groupOf(entry);
      made.set(entry.name, viewGroup({
        path: joinPath('/mod', entry.name),
        attrs: encodingAttrs('anndata'),
        children: new Map([['X', () => X], ['var', () => features], ['obs', obs]]),
      }));
    }
    return made.get(entry.name);
  };
  const defaultEntry = entries.find(entry => entry.name === chosen);
  return viewGroup({
    path: '/',
    attrs: encodingAttrs('anndata'),
    children: new Map([
      ...common,
      ['X', () => modalityGroup(defaultEntry).get('X')],
      ['var', () => modalityGroup(defaultEntry).get('var')],
      ['mod', () => viewGroup({
        path: '/mod',
        attrs: { 'mod-order': names },
        children: new Map(entries.map(entry => [entry.name, () => modalityGroup(entry)])),
      })],
    ]),
    close: () => root.close?.(),
    extra: {
      modalities: modalityList(entries.map(entry => ({ name: entry.name, obsmap: null, nCells }))),
      defaultModality: chosen,
    },
  });
}

/** The 10x `.h5` entry of `LAYOUT_VIEWS`. */
export const TENX_H5_VIEW = Object.freeze({ recognize: isTenxRoot, view: tenxView, readerFormat: TENX_H5_FORMAT });
