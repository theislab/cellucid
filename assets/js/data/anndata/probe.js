/**
 * Describing an AnnData store and its elements from their metadata, with
 * at most a first chunk read: what a dataset catalog lists about a store
 * (`describeAnnDataStore`), a matrix as the default expression rule reads
 * it (`storedMatrix`, `regionReader`), what its first stored values tell
 * (`storedValueFacts`), and one element for the data-mapping catalog
 * (`probeElement`). Nothing here refuses a file or opens a reader: the
 * reader's mapping probe (`probeMapping`) and the reader worker
 * use it.
 *
 * @module data/anndata/probe
 */

import { defaultExpression, expressionRuleInputs } from '../data-mapping.js';
import { isAnnDataNumericValueKind } from '../anndata-value-kinds.js';
import { isGroup } from '../../formats/store.js';
import {
  ANNDATA_OPENING_PATHS,
  AnnDataFormatError,
  attributeValue,
  child,
  encodingType,
  numpyDtypeName,
  requireExactStringAttribute,
  shapeFromAttribute,
  shapeOf,
  validateDataFrame,
  valueKind,
} from './elements.js';
import { loadFrameStructure } from './dataframe.js';
import { sparseContract } from './sparse.js';
import { readStored } from './values.js';
import { currentLayoutView, isOlderAnnDataLayout } from './older-layouts.js';
import { readUnsCellucid, readUnsTitle } from './uns.js';

/**
 * What a dataset catalog lists about one AnnData store, read from its
 * metadata and `uns` alone: its cell and gene counts (from the shape of the
 * expression matrix it opens with, `defaultExpression`, else the dataframe
 * indexes' shapes), `uns['title']` and `uns['cellucid']` as stored. No index, matrix or column is read, so
 * describing a large remote store costs its metadata and a few small reads.
 *
 * @param {Object} store - An opened store root (`openHdf5` / `openZarr`)
 * @param {{format: import('./elements.js').AnnDataFormat}} options
 * @param {Object} [readOptions]
 * @returns {Promise<{nObs: number, nVars: number, hasExpressionMatrix: boolean,
 *   title: string|null, cellucid: Object|null}>}
 */
export async function describeAnnDataStore(store, { format }, readOptions = {}) {
  if (!isGroup(store)) throw new TypeError('An AnnData store is described by its root group.');
  const root = isOlderAnnDataLayout(store) ? await currentLayoutView(store, readOptions) : store;
  // What opening reads, and all of uns/cellucid (`readUnsCellucid`).
  await root.load(ANNDATA_OPENING_PATHS, readOptions);
  requireExactStringAttribute(root, 'encoding-type', 'anndata', `${format.file} root`);
  if (!root.has('obs') || !root.has('var')) {
    throw new AnnDataFormatError(`${format.file} obs and var are required and must be current AnnData dataframes`);
  }
  await Promise.all([child(root, 'obs'), child(root, 'var')].map(frame => loadFrameStructure(frame, readOptions)));
  const extentOf = (frame, label) => {
    const { indexKey } = validateDataFrame(frame, format, label);
    return shapeOf(frame.get(indexKey), `${label} index`, 1)[0];
  };
  let nObs;
  let nVars;
  const hasExpressionMatrix = root.has('X');
  if (hasExpressionMatrix) {
    const X = root.get('X');
    [nObs, nVars] = isGroup(X) ? sparseContract(X, format, 'Sparse X').shape : shapeOf(X, 'Dense X', 2);
    // The genes the dataset opens with: raw's, when the default expression
    // rule reads raw (`defaultExpression`: more genes than X, or X scaled).
    const rawX = child(child(root, 'raw'), 'X');
    if (rawX !== null) {
      const rawShape = isGroup(rawX) ? sparseContract(rawX, format, 'Sparse raw.X').shape : shapeOf(rawX, 'Dense raw.X', 2);
      const inputs = await expressionRuleInputs({ X: storedMatrix(X, [nObs, nVars]), rawX: { shape: rawShape }, read: region => X.read(region) });
      if (defaultExpression({ ...inputs, layers: [] }).expression === 'raw') nVars = rawShape[1];
    }
  } else {
    nObs = extentOf(root.get('obs'), `${format.file} obs`);
    nVars = extentOf(root.get('var'), `${format.file} var`);
  }
  const unsCellucid = child(child(root, 'uns'), 'cellucid');
  const [title, cellucid] = await Promise.all([
    readUnsTitle(root, readOptions),
    unsCellucid === null ? null : readUnsCellucid(unsCellucid, readOptions),
  ]);
  return { nObs, nVars, hasExpressionMatrix, title, cellucid };
}

/**
 * A matrix as the default expression rule reads it (`expressionRuleInputs`):
 * dense or not, float or not, its shape and chunks (null: stored in one
 * piece).
 *
 * @param {Object} node
 * @param {ReadonlyArray<number>} shape
 */
export function storedMatrix(node, shape) {
  const dense = node?.kind === 'array';
  return {
    dense,
    floating: dense && node.dtype?.kind === 'float',
    shape,
    chunks: dense && Array.isArray(node.chunks) ? node.chunks : null,
  };
}

/**
 * Regions of one dense array read once each, however many rules ask for
 * them (`expressionRuleInputs` and `storedValueFacts` read the same first chunk).
 *
 * @param {Object} node
 * @returns {(region: [[number, number], [number, number]]) => Promise<ArrayLike<number>>}
 */
export function regionReader(node) {
  const read = new Map();
  return region => {
    const key = JSON.stringify(region);
    if (!read.has(key)) read.set(key, node.read(region));
    return read.get(key);
  };
}

/**
 * The largest finite value of each float dtype a matrix is stored in: the
 * values a `log1p` was applied to were held in the same type (`sc.pp.log1p`
 * keeps the dtype), so once the log1p is undone no cell's total can exceed it.
 */
const FLOAT_DTYPE_MAX = Object.freeze({ float16: 65504, float32: 3.4028234663852886e38, float64: Number.MAX_VALUE });

/**
 * What a matrix's first stored values tell -- a dense matrix's first chunk
 * (stored in one piece: its first row), a sparse one's first chunk of stored
 * values; one small read, shared with the default expression rule:
 *
 * - `counts`: whether it holds counts, an integer dtype or float values all
 *   whole and non-negative (raw counts written as float32, as CELLxGENE and
 *   10x conversions write them); data mapping and the analyses say so (a
 *   fold change on counts is not normalized by each cell's depth);
 * - `notLog1p` (only with `log1pBase`, the base the file's `uns['log1p']`
 *   records, null for e): whether the values refute that record. Undo the
 *   log1p of each value (`expm1` in that base) and sum each cell's: that is
 *   the cell's total before the transform, at least (a dense chunk holds part
 *   of each row; a sparse matrix's first values are taken one by one, their
 *   rows unread). A total past the largest finite value of the matrix's own
 *   float type (`FLOAT_DTYPE_MAX`) is no total any data held, so the values
 *   are not log1p, whatever the record says: EBI SCEA's E-ANND-5 stores
 *   per-million values (252 to 1,118) under an empty `uns['log1p']`, and
 *   `expm1(252)` is 1e109 where float32 ends at 3.4e38. Null when they do
 *   not refute it, else `{value, dtype, total}`: the largest value read,
 *   the type, and the total it implies (null past float64).
 *
 * Null for a matrix holding no number or no value; `notLog1p` null without
 * a record.
 *
 * @param {Object} node - A dense array, or a `csr_matrix` / `csc_matrix` group
 * @param {{read?: (region: [[number, number], [number, number]]) => Promise<ArrayLike<number>>, stored?: Object, log1pBase?: number|null|undefined}} [options] -
 *   `read`: a dense matrix's region read (`regionReader`: the one read the
 *   default expression rule shares); `stored`: the same matrix as the store
 *   holds it, before a subsample's view (a sparse matrix's stored values are
 *   read there: a view reads a CSR matrix's values only by its kept rows);
 *   `log1pBase`: undefined when the file records no log1p
 * @returns {Promise<{counts: boolean, notLog1p: {value: number, dtype: string, total: number|null}|null}|null>}
 */
export async function storedValueFacts(node, { read = region => node.read(region), stored = node, log1pBase = undefined } = {}) {
  const values = isGroup(node) ? child(stored, 'data') : node;
  if (values?.kind !== 'array') return null;
  const kind = values.dtype?.kind;
  // An integer dtype holds counts, which a log1p never writes (`defaultLog1p` reads it as stored).
  if (kind === 'int' || kind === 'uint') return { counts: true, notLog1p: null };
  if (kind !== 'float' || !Array.isArray(values.shape) || !values.shape.every(extent => extent > 0)) return null;
  let sample;
  let rowLength;
  if (values.shape.length === 1) {
    // A sparse matrix's stored values: their first chunk, or, stored in one
    // piece or in chunks read in part (`partialChunks`: raw, as a served
    // store's are), as many as one full row of the matrix holds. Their rows
    // are not read: each value stands alone.
    const length = values.shape[0];
    const nColumns = attributeValue(node, 'shape')?.[1] ?? length;
    const first = Array.isArray(values.chunks) && values.partialChunks !== true ? values.chunks[0] : Math.max(1, Number(nColumns));
    sample = await readStored(values, 0, Math.min(length, first), 'Matrix values');
    rowLength = 1;
  } else {
    const [nRows, nColumns] = values.shape;
    const [rows, columns] = Array.isArray(values.chunks) ? values.chunks : [1, nColumns];
    sample = await read([[0, Math.min(nRows, rows)], [0, Math.min(nColumns, columns)]]);
    rowLength = Math.min(nColumns, columns);
  }
  let counts = true;
  for (let i = 0; i < sample.length; i++) {
    const value = sample[i];
    if (!(value >= 0) || value !== Math.floor(value)) {
      counts = false;
      break;
    }
  }
  let notLog1p = null;
  const ceiling = FLOAT_DTYPE_MAX[numpyDtypeName(values)];
  if (log1pBase !== undefined && ceiling !== undefined) {
    const scale = log1pBase === null ? 1 : Math.log(log1pBase);
    let largest = -Infinity;
    let refuting = -Infinity;
    for (let start = 0; start < sample.length; start += rowLength) {
      let total = 0;
      let rowLargest = -Infinity;
      for (let i = start; i < Math.min(sample.length, start + rowLength); i++) {
        const value = sample[i];
        if (!(value > 0)) continue;
        total += Math.expm1(value * scale);
        if (value > rowLargest) rowLargest = value;
      }
      if (rowLargest > largest) largest = rowLargest;
      if (total > ceiling && total > refuting) refuting = total;
    }
    if (refuting > ceiling) {
      notLog1p = { value: largest, dtype: numpyDtypeName(values), total: Number.isFinite(refuting) ? refuting : null };
    }
  }
  return { counts, notLog1p };
}

/**
 * Describe one AnnData element from its metadata, for the data-mapping
 * catalog. Nothing is read and nothing is refused: an element this reader
 * cannot classify is storage `other`, and one whose metadata it cannot read
 * carries the reason (`problem`), which the catalog shows.
 */
export function probeElement(key, node) {
  const other = { key, storage: 'other', shape: null, dtype: 'object', numeric: false, nnz: null };
  try {
    if (node?.kind === 'array') {
      return {
        key,
        storage: 'dense',
        shape: shapeOf(node, key),
        dtype: numpyDtypeName(node),
        numeric: isAnnDataNumericValueKind(valueKind(node)),
        nnz: null,
      };
    }
    if (!isGroup(node)) return other;
    const declared = encodingType(node);
    if (declared === 'csr_matrix' || declared === 'csc_matrix') {
      const shape = shapeFromAttribute(attributeValue(node, 'shape'), key);
      // A subsample's CSR matrix not read yet: its stored values are not
      // known (its kept rows' pointers are read with the matrix).
      if (node.rowPointersPending?.() === true) {
        const stored = node.storedData();
        return {
          key,
          storage: declared.slice(0, 3),
          shape,
          dtype: numpyDtypeName(stored),
          numeric: isAnnDataNumericValueKind(valueKind(stored)),
          nnz: null,
        };
      }
      const data = child(node, 'data');
      if (data?.kind !== 'array') return { ...other, storage: declared.slice(0, 3), shape };
      return {
        key,
        storage: declared.slice(0, 3),
        shape,
        dtype: numpyDtypeName(data),
        numeric: isAnnDataNumericValueKind(valueKind(data)),
        nnz: shapeOf(data, key)[0] ?? null,
      };
    }
    if (declared === 'dataframe') {
      const indexKey = attributeValue(node, '_index');
      const columnOrder = attributeValue(node, 'column-order');
      const index = typeof indexKey === 'string' ? child(node, indexKey) : null;
      const rows = index?.kind === 'array' ? shapeOf(index, key)[0] : null;
      const columns = Array.isArray(columnOrder) ? columnOrder.length : null;
      return {
        ...other,
        storage: 'dataframe',
        shape: rows === null || rows === undefined || columns === null ? null : [rows, columns],
      };
    }
  } catch (error) {
    // Its metadata is malformed: the catalog lists it as unusable, saying why.
    return { ...other, problem: error?.message ?? String(error) };
  }
  return other;
}
