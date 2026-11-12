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

import { BOOL_DTYPE, isArrayNode, isGroup, numericDtype, valueArrayClass } from '../../../formats/store.js';
import { AnnDataFormatError, NULLABLE_ENCODINGS, attributeValue, encodingType } from '../elements.js';
import { computedArray, encodingAttrs, joinPath, viewGroup } from './view-nodes.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { sharedOnce } from '../../../utils/abort.js';
import { allocateTypedArray } from '../../sparse-column-index.js';
import { sparseGraphLines } from '../graph-lines.js';

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
  // Read once, shared by every read asking meanwhile: it stops only once
  // every one of them withdrew (`sharedOnce`).
  const map = sharedOnce(async options => {
    if (modality.obsmap === null) {
      if (modality.nCells !== nObs) {
        throw new AnnDataFormatError(
          `Modality '${modality.name}' has ${formatCountOf(modality.nCells, 'cell')} and the dataset ${nObs}, and no cell map (obsmap) says which they are`
        );
      }
      return { rows: null, identity: true, measured: nObs };
    }
    const stored = await modality.obsmap.read(undefined, options);
    if (stored.length !== nObs) throw new AnnDataFormatError(`obsmap['${modality.name}'] has ${formatCountOf(stored.length, 'row')} for ${formatCountOf(nObs, 'cell')}`);
    const rows = allocateTypedArray(Int32Array, nObs, `obsmap['${modality.name}']`);
    let identity = modality.nCells === nObs;
    let measured = 0;
    for (let cell = 0; cell < nObs; cell++) {
      const row = Number(stored[cell]) - 1;
      if (!(row >= -1 && row < modality.nCells) || !Number.isInteger(row)) {
        throw new AnnDataFormatError(`obsmap['${modality.name}'] places cell ${cell} at row ${row + 1}, outside its ${formatCountOf(modality.nCells, 'row')}`);
      }
      rows[cell] = row;
      if (row >= 0) measured++;
      if (row !== cell) identity = false;
    }
    return { rows: identity ? null : rows, identity, measured };
  });
  /**
   * The modality rows of cells `[r0, r1)` (an `Int32Array`, -1 where not
   * measured), or null when they are those cells' own rows: from the whole
   * map when it is read, else from those cells' entries of the cell map
   * alone (a subsample's runs of cells read no more of it).
   */
  map.rowsIn = async (options, r0, r1) => {
    if (map.asked()) {
      const whole = await map(options);
      return whole.identity ? null : whole.rows.subarray(r0, r1);
    }
    // No cell map: every cell is its own row (checked by `map`).
    if (modality.obsmap === null) {
      await map(options);
      return null;
    }
    const stored = await modality.obsmap.read([[r0, r1]], options);
    const rows = allocateTypedArray(Int32Array, r1 - r0, `obsmap['${modality.name}']`);
    for (let i = 0; i < rows.length; i++) {
      const row = Number(stored[i]) - 1;
      if (!(row >= -1 && row < modality.nCells) || !Number.isInteger(row)) {
        throw new AnnDataFormatError(`obsmap['${modality.name}'] places cell ${r0 + i} at row ${row + 1}, outside its ${formatCountOf(modality.nCells, 'row')}`);
      }
      rows[i] = row;
    }
    return rows;
  };
  return map;
}

/**
 * Rows `[r0, r1)` of a modality array placed on the store's cells: only the
 * modality rows those cells measured are read (the span between the least
 * and the greatest of them; a modality's rows follow its cells' order), so a
 * subsample's runs of cells read their own rows, not the whole array.
 */
async function placedRowsOf(array, map, options, r0, r1, width, Output, fill) {
  const rows = map.rowsIn === undefined ? (await map(options)).rows?.subarray(r0, r1) ?? null : await map.rowsIn(options, r0, r1);
  const tail = array.shape.length === 2 ? [[0, array.shape[1]]] : [];
  if (rows === null) {
    const values = await array.read([[r0, r1], ...tail], options);
    return values instanceof Output ? values : numbersAs(Output, values);
  }
  let low = Infinity;
  let high = -1;
  for (const row of rows) {
    if (row < 0) continue;
    if (row < low) low = row;
    if (row > high) high = row;
  }
  const out = allocateTypedArray(Output, (r1 - r0) * width, 'Modality values by cell').fill(fill);
  if (high < 0) return out;
  const values = await array.read([[low, high + 1], ...tail], options);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row < 0) continue;
    for (let column = 0; column < width; column++) out[i * width + column] = Number(values[(row - low) * width + column]);
  }
  return out;
}

/** `values` as numbers in an `ArrayType` of their own: `ArrayType.from(values, Number)` at any size. */
function numbersAs(ArrayType, values) {
  const out = allocateTypedArray(ArrayType, values.length, 'Modality values');
  for (let i = 0; i < values.length; i++) out[i] = Number(values[i]);
  return out;
}

/** One value per modality row, placed on the store's cells (`fill` where absent). */
function placeRows(values, rows, width, Output, fill) {
  const out = allocateTypedArray(Output, rows.length * width, 'Modality values by cell');
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
      if (cells.identity) return float32 ? values : numbersAs(Float64Array, values);
      return placeRows(values, cells.rows, width, float32 ? Float32Array : Float64Array, Number.NaN);
    },
    computeRows: (options, r0, r1) => placedRowsOf(array, map, options, r0, r1, width, float32 ? Float32Array : Float64Array, Number.NaN),
    // A modality's integer column stays exact on the cells, as the
    // dataset's own does.
    wideIntegers: (array.dtype.kind === 'int' || array.dtype.kind === 'uint') && array.dtype.bytes > 2,
  });
}

/**
 * A categorical column of one modality on the store's cells: code -1 where
 * not measured. Its parts are the stored group's, listed once that is
 * loaded (`formats/store.js`, `Group.load`).
 */
function placedCategorical(group, map, nObs, path) {
  return viewGroup({
    path,
    attrs: { ...encodingAttrs('categorical'), ordered: attributeValue(group, 'ordered') === true || attributeValue(group, 'ordered') === 1 },
    sources: [group],
    children: () => {
      const codes = group.get('codes');
      if (!isArrayNode(codes)) throw new AnnDataFormatError(`${group.path} is a categorical column without an array of codes`);
      return new Map([
        ['codes', () => computedArray({
          path: joinPath(path, 'codes'),
          dtype: numericDtype('int', 4),
          shape: [nObs],
          attrs: encodingAttrs('array'),
          compute: async options => {
            const [cells, values] = await Promise.all([map(options), codes.read(undefined, options)]);
            if (cells.identity) return numbersAs(Int32Array, values);
            return placeRows(values, cells.rows, 1, Int32Array, -1);
          },
          computeRows: (options, r0, r1) => placedRowsOf(codes, map, options, r0, r1, 1, Int32Array, -1),
        })],
        ['categories', () => group.get('categories')],
      ]);
    },
  });
}

/**
 * One stored column of a modality as the elements it stores, on the store's
 * cells: `fill` where the modality did not measure a cell. Rows of some
 * cells read only the modality rows those cells measured (`placedRowsOf`).
 */
function placedElements(array, map, nObs, path, fill) {
  const text = array.dtype.kind === 'string';
  const Output = text ? null : valueArrayClass(array.dtype);
  const wide = Output === BigInt64Array || Output === BigUint64Array;
  const empty = length => (text
    ? new Array(length).fill(fill)
    : allocateTypedArray(Output, length, 'Modality values by cell').fill(wide ? BigInt(fill) : fill));
  /** `values` (modality rows from `low`) placed on cells whose rows are `rows`. */
  const place = (values, rows, low) => {
    const out = empty(rows.length);
    for (let i = 0; i < rows.length; i++) if (rows[i] >= 0) out[i] = values[rows[i] - low];
    return out;
  };
  return computedArray({
    path,
    dtype: array.dtype,
    shape: [nObs],
    attrs: encodingAttrs(text ? 'string-array' : 'array'),
    compute: async options => {
      const [cells, values] = await Promise.all([map(options), array.read(undefined, options)]);
      return cells.identity ? values : place(values, cells.rows, 0);
    },
    computeRows: async (options, r0, r1) => {
      const rows = map.rowsIn === undefined ? (await map(options)).rows?.subarray(r0, r1) ?? null : await map.rowsIn(options, r0, r1);
      if (rows === null) return array.read([[r0, r1]], options);
      let low = Infinity;
      let high = -1;
      for (const row of rows) {
        if (row < 0) continue;
        if (row < low) low = row;
        if (row > high) high = row;
      }
      return place(high < 0 ? [] : await array.read([[low, high + 1]], options), rows, low);
    },
  });
}

/**
 * Which cells have no value: a cell the modality did not measure, else the
 * stored mask's (none when it stores none).
 */
function placedMask(mask, map, nObs, path) {
  if (mask !== null) return placedElements(mask, map, nObs, path, 1);
  const unmeasured = rows => {
    const out = allocateTypedArray(Uint8Array, rows.length, 'Modality mask');
    for (let i = 0; i < rows.length; i++) out[i] = rows[i] < 0 ? 1 : 0;
    return out;
  };
  return computedArray({
    path,
    dtype: BOOL_DTYPE,
    shape: [nObs],
    attrs: encodingAttrs('array'),
    compute: async options => {
      const cells = await map(options);
      return cells.identity ? allocateTypedArray(Uint8Array, nObs, 'Modality mask') : unmeasured(cells.rows);
    },
    computeRows: async (options, r0, r1) => {
      const rows = map.rowsIn === undefined ? (await map(options)).rows?.subarray(r0, r1) ?? null : await map.rowsIn(options, r0, r1);
      return rows === null ? allocateTypedArray(Uint8Array, r1 - r0, 'Modality mask') : unmeasured(rows);
    },
  });
}

/** The nullable encoding of a column whose stored elements are of `kind`. */
const NULLABLE_OF_KIND = Object.freeze({ int: 'nullable-integer', uint: 'nullable-integer', bool: 'nullable-boolean', string: 'nullable-string-array' });

/**
 * An integer, boolean or text column of one modality on the store's cells,
 * as the nullable column of its kind: a cell the modality did not measure
 * has no value (masked), every other cell its stored value -- or none,
 * where a nullable column stores none. Read exactly as the dataset's own
 * column of that kind: integers stay exact integers, booleans and text are
 * categories with a missing value. `source` is the stored column: a plain
 * array, or a nullable group (its parts listed once it is loaded).
 */
function placedNullable(source, encoding, map, nObs, path) {
  const fill = encoding === 'nullable-string-array' ? '' : 0;
  return viewGroup({
    path,
    attrs: encodingAttrs(encoding),
    sources: isGroup(source) ? [source] : [],
    children: () => {
      const values = isGroup(source) ? source.get('values') : source;
      const mask = isGroup(source) ? source.get('mask') : null;
      if (!isArrayNode(values) || (isGroup(source) && !isArrayNode(mask))) {
        throw new AnnDataFormatError(`${source.path} is a nullable column without arrays of values and mask`);
      }
      return new Map([
        ['values', () => placedElements(values, map, nObs, joinPath(path, 'values'), fill)],
        ['mask', () => placedMask(mask, map, nObs, joinPath(path, 'mask'))],
      ]);
    },
  });
}

/**
 * One obs column of a modality, placed on the store's cells, or null for a
 * column of a kind that is not placed (an awkward array, a column of more
 * than one dimension). Each is read as the dataset's own column of its kind
 * is: a categorical keeps its categories, an integer, boolean or text
 * column (plain or nullable) is the nullable column of its kind with the
 * cells the modality did not measure missing, and a float column is NaN
 * there.
 *
 * @param {Object} node - The column (array or group) in the modality's obs
 * @param {Function} map - `cellMapOf(modality, nObs)`
 * @param {number} nObs
 * @param {string} path - Where the placed column is presented
 * @returns {Object|null}
 */
export function placedObsColumn(node, map, nObs, path) {
  if (isGroup(node)) {
    // Its parts are checked when it is loaded (`placedCategorical`,
    // `placedNullable`).
    const encoding = encodingType(node);
    if (encoding === 'categorical') return placedCategorical(node, map, nObs, path);
    if (NULLABLE_ENCODINGS.has(encoding)) return placedNullable(node, encoding, map, nObs, path);
    return null;
  }
  if (!isArrayNode(node) || node.shape.length !== 1) return null;
  const kind = node.dtype.kind;
  if (kind === 'float') return placedNumbers(node, map, nObs, path);
  if (Object.hasOwn(NULLABLE_OF_KIND, kind)) return placedNullable(node, NULLABLE_OF_KIND[kind], map, nObs, path);
  return null;
}

/**
 * One sparse graph of a modality (`obsp`) on the store's cells: its edges
 * between cells the modality measured, every other cell without edges. Only
 * a graph whose every row is one of the store's cells is placed (each edge
 * needs both ends).
 *
 * The neighbor graph's readers never hold it whole: `graphPlacement` names
 * the stored graph and how its rows lie on the store's cells (`cellOfRow`,
 * 4 bytes a modality row, made once from the cell map; `rowOfCell`, null
 * when they are the same), and `graph-lines.js` reads it in its own rows
 * from that: streamed as lines over the store's cells (`placedGraphLines`,
 * the edges), some cells' rows (`readPlacedGraphRows`, the k-NN tool), a
 * subsample's induced subgraph (`inducedGraphLines`). Its arrays
 * (`indptr`, `indices`, `data`), for a caller that reads the matrix whole,
 * are built on first read from the stored graph's lines and kept.
 */
export function placedGraph(group, map, nObs, path) {
  const csr = encodingType(group) === 'csr_matrix';
  const label = `Modality graph ${group.path}`;
  const placement = sharedOnce(async options => {
    const cells = await map(options);
    const nRows = group.get('indptr').shape[0] - 1;
    const cellOfRow = allocateTypedArray(Int32Array, nRows, `${label} cells`).fill(-1);
    if (cells.identity) {
      for (let row = 0; row < nRows; row++) cellOfRow[row] = row;
    } else {
      for (let cell = 0; cell < nObs; cell++) if (cells.rows[cell] >= 0) cellOfRow[cells.rows[cell]] = cell;
    }
    return { group, cellOfRow, rowOfCell: cells.identity ? null : cells.rows, nRows };
  });
  const build = sharedOnce(async options => {
    const cells = await map(options);
    const lines = await sparseGraphLines(group, { storage: 'store', file: group.path }, `Modality graph ${group.path}`, options);
    const nRows = lines.pointers.length - 1;
    // The store's cell of each modality row (a symmetric graph reads the
    // same by row or column: rows of a CSC matrix are its columns).
    const toCell = allocateTypedArray(Int32Array, nRows, 'Modality graph cells').fill(-1);
    if (cells.identity) {
      for (let row = 0; row < nRows; row++) toCell[row] = row;
    } else {
      for (let cell = 0; cell < nObs; cell++) if (cells.rows[cell] >= 0) toCell[cells.rows[cell]] = cell;
    }
    const outPointers = allocateTypedArray(Int32Array, nObs + 1, 'Modality graph indptr');
    for (let row = 0; row < nRows; row++) {
      const count = lines.pointers[row + 1] - lines.pointers[row];
      if (toCell[row] < 0) {
        if (count > 0) throw new AnnDataFormatError(`${group.path} joins a row that no cell of the dataset is mapped to`);
        continue;
      }
      outPointers[toCell[row] + 1] = count;
    }
    // The pointers are int32: a placed graph past 2^31 - 1 entries (8 GiB
    // of indices, more than one array of a page holds) is refused, never
    // wrapped into wrong pointers.
    for (let cell = 0; cell < nObs; cell++) {
      const total = outPointers[cell] + outPointers[cell + 1];
      if (total > 0x7fffffff) throw new RangeError(`${group.path} places more than ${formatCountOf(0x7fffffff, 'entry', 'entries')} on the dataset's cells, more than one array holds.`);
      outPointers[cell + 1] = total;
    }
    const outIndices = allocateTypedArray(Int32Array, outPointers[nObs], 'Modality graph indices');
    let outData = null;
    for await (const slab of lines.slabs) {
      outData ??= allocateTypedArray(slab.data.constructor, outPointers[nObs], 'Modality graph values');
      for (let row = slab.start; row < slab.end; row++) {
        const cell = toCell[row];
        if (cell < 0) continue;
        let at = outPointers[cell];
        let ordered = true;
        for (let entry = slab.pointers[row - slab.start]; entry < slab.pointers[row - slab.start + 1]; entry++) {
          const column = toCell[slab.indices[entry]];
          if (column < 0) throw new AnnDataFormatError(`${group.path} joins a row that no cell of the dataset is mapped to`);
          if (at > outPointers[cell] && column < outIndices[at - 1]) ordered = false;
          outIndices[at] = column;
          outData[at] = slab.data[entry];
          at++;
        }
        if (!ordered) sortLine(outIndices, outData, outPointers[cell], at);
      }
    }
    return { data: outData ?? new Float64Array(0), indices: outIndices, indptr: outPointers };
  });
  const part = (name, dtype, length) => () => computedArray({
    path: joinPath(path, name),
    dtype,
    shape: [length],
    compute: async options => (await build(options))[name],
  });
  return viewGroup({
    path,
    attrs: { ...encodingAttrs(csr ? 'csr_matrix' : 'csc_matrix'), shape: [nObs, nObs] },
    // Its stored arrays are known once the stored graph is loaded.
    sources: [group],
    extra: { graphPlacement: options => placement(options) },
    children: () => {
      const { dtype: stored, shape: [nnz] } = group.get('data');
      return new Map([
        // Weights as `graph-lines.js` reads them: 64-bit integers as float64.
        ['data', part('data', stored.bytes === 8 && stored.kind !== 'float' ? numericDtype('float', 8) : stored, nnz)],
        ['indices', part('indices', numericDtype('int', 4), nnz)],
        ['indptr', part('indptr', numericDtype('int', 4), nObs + 1)],
      ]);
    },
  });
}

/** One line's entries `[start, end)` put in ascending column order, in place (stable). */
function sortLine(indices, data, start, end) {
  const order = Uint32Array.from({ length: end - start }, (_, i) => start + i)
    .sort((left, right) => indices[left] - indices[right] || left - right);
  const lineIndices = Int32Array.from(order, at => indices[at]);
  const lineData = data.constructor.from(order, at => data[at]);
  indices.set(lineIndices, start);
  data.set(lineData, start);
}
