/**
 * AnnData sparse matrices (`csr_matrix` / `csc_matrix` 0.1.0 groups of
 * `data`, `indices` and `indptr`): their contract, and reading one whole (a
 * neighbour graph). Expression matrices are read a column at a time instead
 * (`matrix-access.js`).
 *
 * @module data/anndata/sparse
 */

import { isAnnDataMatrixDataKind } from '../anndata-value-kinds.js';
import { isGroup } from '../../formats/store.js';
import {
  attributeValue,
  encodingType,
  requireEncoding,
  shapeFromAttribute,
  validateOneDimensional,
  valueKind,
} from './elements.js';
import { readConvertedRange, readFloat32, readStored } from './values.js';

/**
 * A sparse matrix's arrays and shape, checked; no value is read.
 *
 * @returns {{dataArray: Object, dataKind: string, dataLength: number, encodingType: string,
 *   format: 'csr'|'csc', indicesArray: Object, indptrArray: Object, shape: number[]}}
 */
export function sparseContract(group, format, label = 'Sparse matrix') {
  if (!isGroup(group)) throw new Error(`${label} must be a ${format.storage} group`);
  const declared = encodingType(group);
  if (declared !== 'csr_matrix' && declared !== 'csc_matrix') {
    throw new Error(`${label} encoding-type is required and must be 'csr_matrix' or 'csc_matrix'`);
  }
  requireEncoding(group, declared, '0.1.0', label);
  const shape = shapeFromAttribute(attributeValue(group, 'shape'), label);
  if (shape.length !== 2) throw new Error(`${label} shape must contain exactly two dimensions`);
  for (const key of ['data', 'indices', 'indptr']) {
    if (!group.has(key)) throw new Error(`${label} is missing required '${key}' dataset`);
  }
  const dataArray = group.get('data');
  const indicesArray = group.get('indices');
  const indptrArray = group.get('indptr');
  const dataLength = validateOneDimensional(dataArray, format, `${label} data`);
  const indicesLength = validateOneDimensional(indicesArray, format, `${label} indices`);
  const sparseFormat = declared === 'csr_matrix' ? 'csr' : 'csc';
  const pointerAxis = sparseFormat === 'csr' ? shape[0] : shape[1];
  validateOneDimensional(indptrArray, format, `${label} indptr`, pointerAxis + 1);
  if (dataLength !== indicesLength) {
    throw new Error(`${label} data and indices lengths differ (${dataLength} versus ${indicesLength})`);
  }
  const dataKind = valueKind(dataArray);
  if (!isAnnDataMatrixDataKind(dataKind)) throw new Error(`${label} data must use a numeric dtype`);
  const indicesKind = valueKind(indicesArray);
  const indptrKind = valueKind(indptrArray);
  if (!['int', 'uint'].includes(indicesKind) || !['int', 'uint'].includes(indptrKind)) {
    throw new Error(`${label} indices and indptr must use integer dtypes`);
  }
  return {
    dataArray,
    dataKind,
    dataLength,
    encodingType: declared,
    format: sparseFormat,
    indicesArray,
    indptrArray,
    shape,
  };
}

/**
 * Validated pointers as exact numbers: start at zero, never decrease, end at
 * the non-zero count.
 */
export function checkPointers(pointers, nnz, label) {
  if (pointers[0] !== 0) throw new Error(`${label} indptr must start at zero`);
  for (let i = 1; i < pointers.length; i++) {
    if (!(pointers[i] >= pointers[i - 1])) throw new Error(`${label} indptr must be monotonic`);
  }
  if (pointers[pointers.length - 1] !== nnz) {
    throw new Error(`${label} indptr last value must equal the non-zero count (${nnz})`);
  }
  return pointers;
}

/**
 * Read a whole sparse matrix: `data` exactly as stored (`dataMode: 'exact'`)
 * or as float32, `indices` as int32 within the index axis, `indptr` as exact
 * numbers. The three arrays are fetched together.
 */
export async function readSparseMatrix(group, format, label, dataMode, options = {}) {
  if (dataMode !== 'float32' && dataMode !== 'exact') {
    throw new TypeError(`${label} data mode must be exactly "float32" or "exact"`);
  }
  const contract = sparseContract(group, format, label);
  const { dataArray, dataLength, indicesArray, indptrArray, shape } = contract;
  const indexAxis = contract.format === 'csr' ? shape[1] : shape[0];
  // Pointers are exact integers up to 2^53; Int32 holds them while the
  // non-zero count fits, Float64 beyond.
  const PointerArray = dataLength <= 0x7fffffff ? Int32Array : Float64Array;
  const [data, indices, indptr] = await Promise.all([
    dataMode === 'exact'
      ? readStored(dataArray, 0, dataLength, `${label} data`, options)
      : readFloat32(dataArray, 0, dataLength, `${label} data`, options),
    readConvertedRange(indicesArray, 0, dataLength, Int32Array, `${label} index`, (values, output, offset) => {
      for (let i = 0; i < values.length; i++) {
        const raw = values[i];
        const index = typeof raw === 'bigint' ? Number(raw) : raw;
        if (!(index >= 0 && index < indexAxis) || !Number.isInteger(index)) {
          throw new Error(`${label} index ${String(raw)} is outside axis bounds [0, ${indexAxis})`);
        }
        output[offset + i] = index;
      }
    }, options),
    readConvertedRange(indptrArray, 0, Number(indptrArray.shape[0]), PointerArray, `${label} indptr`, (values, output, offset) => {
      for (let i = 0; i < values.length; i++) {
        const value = Number(values[i]);
        if (!Number.isSafeInteger(value) || value < 0 || value > dataLength) {
          throw new Error(`${label} indptr ${String(values[i])} is outside [0, ${dataLength}]`);
        }
        output[offset + i] = value;
      }
    }, options),
  ]);
  checkPointers(indptr, data.length, label);
  return { cscData: null, data, format: contract.format, indices, indptr, shape };
}

