/**
 * AnnData sparse matrices (`csr_matrix` / `csc_matrix` 0.1.0 groups of
 * `data`, `indices` and `indptr`): their contract and pointers. Expression
 * matrices are read a column at a time (`matrix-access.js`), neighbour
 * graphs line by line (`graph-lines.js`).
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
