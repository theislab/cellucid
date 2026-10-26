/**
 * Modalities: several feature spaces measured on the same cells (RNA and
 * surface proteins of a CITE-seq experiment, the feature types of a 10x
 * file, the assays of a Seurat object, the alternative experiments of a
 * SingleCellExperiment).
 *
 * Every multimodal store is presented in MuData's layout, and only in it:
 *
 *     /                 the shared cells: obs, obsm, obsp, uns
 *     /mod/<name>/      one AnnData group per modality: X, var, layers, raw
 *     /obsmap/<name>    optional uint32, one per cell of the store: the
 *                       1-based row of that cell in the modality, 0 where
 *                       the modality did not measure it
 *     /X, /var, …       the default modality's, presented at the root when
 *                       it measured every cell
 *
 * A view of such a store gives its root two properties beside the store
 * model (`viewGroup`'s `extra`): `modalities`, the list made by
 * `modalityList`, and `defaultModality`, the name opened first. A store
 * without them has one feature space and is read exactly as AnnData.
 * `views/mudata.js` presents a MuData file or store (and every transcoded
 * store written in its layout); `views/tenx-h5.js` presents the feature
 * types of one 10x matrix as column windows of it.
 *
 * The reader reads a modality's matrices through its cell map (`cellMapOf`):
 * a cell the modality did not measure is NaN, never 0, so "not measured"
 * stays distinguishable from "measured zero".
 *
 * @module data/anndata/views/modalities
 */

import { isArrayNode, isGroup, numericDtype, stringDtype } from '../../../formats/store.js';
import { attributeValue, encodingType } from '../elements.js';
import { computedArray, encodingAttrs, joinPath, viewGroup } from './view-nodes.js';
import { formatCountOf } from '../../../utils/format-units.js';

/**
 * @typedef {Object} Modality
 * @property {string} name
 * @property {Object|null} obsmap - The cell map array (`/obsmap/<name>`), or
 *   null when the modality's rows are the store's cells in order
 * @property {number} nCells - The modality's own row count
 */

/**
 * The `modalities` a store root carries.
 *
 * @param {ReadonlyArray<{name: string, obsmap?: Object|null, nCells: number}>} entries
 * @returns {ReadonlyArray<Readonly<Modality>>}
 */
export function modalityList(entries) {
  return Object.freeze(entries.map(({ name, obsmap = null, nCells }) => Object.freeze({ name, obsmap, nCells })));
}

/** The rows of a dataframe group (its index's length), or null. */
export function frameRows(frame) {
  if (!isGroup(frame)) return null;
  const indexKey = attributeValue(frame, '_index');
  const index = typeof indexKey === 'string' ? frame.get(indexKey) : null;
  if (isArrayNode(index)) return index.shape[0];
  if (isGroup(index) && isArrayNode(index.get('values'))) return index.get('values').shape[0];
  return null;
}

/**
 * Where each cell of a store sits in one modality, read once:
 * `{rows, identity, measured}`. `rows[cell]` is the modality's row, -1 where
 * it did not measure the cell; `identity` says every cell is the same row
 * (nothing to place); `measured` counts the cells it measured.
 *
 * @param {Readonly<Modality>} modality
 * @param {number} nObs - The store's cell count
 * @returns {(options?: Object) => Promise<{rows: Int32Array|null, identity: boolean, measured: number}>}
 */
export function cellMapOf(modality, nObs) {
  let read = null;
  return (options = {}) => {
    read ??= (async () => {
      if (modality.obsmap === null) {
        if (modality.nCells !== nObs) {
          throw new Error(
            `Modality '${modality.name}' has ${formatCountOf(modality.nCells, 'cell')} and the dataset ${nObs}, and no cell map (obsmap) says which they are`
          );
        }
        return { rows: null, identity: true, measured: nObs };
      }
      const stored = await modality.obsmap.read(undefined, options);
      if (stored.length !== nObs) throw new Error(`obsmap['${modality.name}'] has ${formatCountOf(stored.length, 'row')} for ${formatCountOf(nObs, 'cell')}`);
      const rows = new Int32Array(nObs);
      let identity = modality.nCells === nObs;
      let measured = 0;
      for (let cell = 0; cell < nObs; cell++) {
        const row = Number(stored[cell]) - 1;
        if (!(row >= -1 && row < modality.nCells) || !Number.isInteger(row)) {
          throw new RangeError(`obsmap['${modality.name}'] places cell ${cell} at row ${row + 1}, outside its ${formatCountOf(modality.nCells, 'row')}`);
        }
        rows[cell] = row;
        if (row >= 0) measured++;
        if (row !== cell) identity = false;
      }
      return { rows: identity ? null : rows, identity, measured };
    })();
    read.catch(() => { read = null; });
    return read;
  };
}

/** One value per modality row, placed on the store's cells (`fill` where absent). */
function placeRows(values, rows, width, Output, fill) {
  const out = new Output(rows.length * width);
  for (let cell = 0; cell < rows.length; cell++) {
    const row = rows[cell];
    for (let column = 0; column < width; column++) {
      out[cell * width + column] = row < 0 ? fill : Number(values[row * width + column]);
    }
  }
  return out;
}

/**
 * A dense numeric array of one modality (an `obsm` embedding, a numeric obs
 * column) on the store's cells: float values, NaN where the modality did not
 * measure a cell.
 */
export function placedNumbers(array, map, nObs, path) {
  const width = array.shape.length === 2 ? array.shape[1] : 1;
  const float32 = array.dtype.kind === 'float' && array.dtype.bytes === 4;
  return computedArray({
    path,
    dtype: numericDtype('float', float32 ? 4 : 8),
    shape: array.shape.length === 2 ? [nObs, width] : [nObs],
    attrs: encodingAttrs('array'),
    compute: async options => {
      const [cells, values] = await Promise.all([map(options), array.read(undefined, options)]);
      if (cells.identity) return float32 ? values : Float64Array.from(values, Number);
      return placeRows(values, cells.rows, width, float32 ? Float32Array : Float64Array, Number.NaN);
    },
  });
}

/** A categorical column of one modality on the store's cells: code -1 where not measured. */
function placedCategorical(group, map, nObs, path) {
  const codes = group.get('codes');
  return viewGroup({
    path,
    attrs: { ...encodingAttrs('categorical'), ordered: attributeValue(group, 'ordered') === true || attributeValue(group, 'ordered') === 1 },
    children: new Map([
      ['codes', () => computedArray({
        path: joinPath(path, 'codes'),
        dtype: numericDtype('int', 4),
        shape: [nObs],
        attrs: encodingAttrs('array'),
        compute: async options => {
          const [cells, values] = await Promise.all([map(options), codes.read(undefined, options)]);
          if (cells.identity) return Int32Array.from(values, Number);
          return placeRows(values, cells.rows, 1, Int32Array, -1);
        },
      })],
      ['categories', () => group.get('categories')],
    ]),
  });
}

/** A text column of one modality on the store's cells: missing where not measured. */
function placedText(array, map, nObs, path) {
  let placed = null;
  const values = options => {
    placed ??= Promise.all([map(options), array.read(undefined, options)]).then(([cells, stored]) => {
      if (cells.identity) return { text: Array.from(stored, String), mask: new Uint8Array(nObs) };
      const text = new Array(nObs);
      const mask = new Uint8Array(nObs);
      for (let cell = 0; cell < nObs; cell++) {
        const row = cells.rows[cell];
        text[cell] = row < 0 ? '' : String(stored[row]);
        mask[cell] = row < 0 ? 1 : 0;
      }
      return { text, mask };
    });
    placed.catch(() => { placed = null; });
    return placed;
  };
  return viewGroup({
    path,
    attrs: encodingAttrs('nullable-string-array'),
    children: new Map([
      ['values', () => computedArray({
        path: joinPath(path, 'values'),
        dtype: stringDtype({ variable: true, encoding: 'utf-8' }),
        shape: [nObs],
        attrs: encodingAttrs('string-array'),
        compute: async options => (await values(options)).text,
      })],
      ['mask', () => computedArray({
        path: joinPath(path, 'mask'),
        dtype: Object.freeze({ kind: 'bool', name: 'bool', bytes: 1, littleEndian: null }),
        shape: [nObs],
        attrs: encodingAttrs('array'),
        compute: async options => (await values(options)).mask,
      })],
    ]),
  });
}

/**
 * One obs column of a modality, placed on the store's cells, or null for a
 * column of a kind that is not placed (a nullable integer, an awkward
 * array).
 *
 * @param {Object} node - The column (array or group) in the modality's obs
 * @param {Function} map - `cellMapOf(modality, nObs)`
 * @param {number} nObs
 * @param {string} path - Where the placed column is presented
 * @returns {Object|null}
 */
export function placedObsColumn(node, map, nObs, path) {
  if (isGroup(node)) {
    if (encodingType(node) === 'categorical' && isArrayNode(node.get('codes'))) return placedCategorical(node, map, nObs, path);
    return null;
  }
  if (!isArrayNode(node) || node.shape.length !== 1) return null;
  const kind = node.dtype.kind;
  if (kind === 'string') return placedText(node, map, nObs, path);
  if (kind === 'int' || kind === 'uint' || kind === 'float' || kind === 'bool') return placedNumbers(node, map, nObs, path);
  return null;
}

/**
 * One sparse graph of a modality (`obsp`) on the store's cells: its edges
 * between cells the modality measured, every other cell without edges.
 * Read whole, as graphs are; only a graph whose every row is one of the
 * store's cells is placed (each edge needs both ends).
 */
export function placedGraph(group, map, nObs, path) {
  const shape = attributeValue(group, 'shape');
  const csr = encodingType(group) === 'csr_matrix';
  let built = null;
  const build = options => {
    built ??= (async () => {
      const [cells, data, indices, indptr] = await Promise.all([
        map(options),
        group.get('data').read(undefined, options),
        group.get('indices').read(undefined, options),
        group.get('indptr').read(undefined, options),
      ]);
      if (cells.identity) return { data, indices, indptr };
      const toCell = new Int32Array(Number(shape[0])).fill(-1);
      for (let cell = 0; cell < nObs; cell++) if (cells.rows[cell] >= 0) toCell[cells.rows[cell]] = cell;
      // A symmetric graph reads the same by row or column: rows of a CSC
      // matrix are its columns.
      const outPointers = new Int32Array(nObs + 1);
      for (let cell = 0; cell < nObs; cell++) {
        const row = cells.rows[cell];
        outPointers[cell + 1] = outPointers[cell] + (row < 0 ? 0 : Number(indptr[row + 1]) - Number(indptr[row]));
      }
      const outIndices = new Int32Array(outPointers[nObs]);
      const outData = new data.constructor(outPointers[nObs]);
      for (let cell = 0; cell < nObs; cell++) {
        const row = cells.rows[cell];
        if (row < 0) continue;
        const entries = [];
        for (let entry = Number(indptr[row]); entry < Number(indptr[row + 1]); entry++) {
          const column = toCell[Number(indices[entry])];
          if (column < 0) throw new RangeError(`${group.path} joins a row that no cell of the dataset is mapped to`);
          entries.push([column, data[entry]]);
        }
        entries.sort((left, right) => left[0] - right[0]);
        entries.forEach(([column, value], offset) => {
          outIndices[outPointers[cell] + offset] = column;
          outData[outPointers[cell] + offset] = value;
        });
      }
      return { data: outData, indices: outIndices, indptr: outPointers };
    })();
    built.catch(() => { built = null; });
    return built;
  };
  const part = (name, dtype, length) => () => computedArray({
    path: joinPath(path, name),
    dtype,
    shape: [length],
    compute: async options => (await build(options))[name],
  });
  const nnz = group.get('data').shape[0];
  return viewGroup({
    path,
    attrs: { ...encodingAttrs(csr ? 'csr_matrix' : 'csc_matrix'), shape: [nObs, nObs] },
    children: new Map([
      ['data', part('data', group.get('data').dtype, nnz)],
      ['indices', part('indices', numericDtype('int', 4), nnz)],
      ['indptr', part('indptr', numericDtype('int', 4), nObs + 1)],
    ]),
  });
}
