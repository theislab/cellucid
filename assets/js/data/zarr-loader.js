/**
 * @fileoverview The Zarr reader: `ZarrLoader` reads one AnnData Zarr v2
 * store (a directory of files, or the entries of a `.zarr.zip`). It runs in
 * the AnnData reader worker (`anndata-reader-worker.js`); the main thread
 * talks to it through `AnnDataReaderClient` and never decodes a chunk.
 *
 * Every read is lazy and chunk-exact: only the chunks covering the requested
 * range are read, several at a time (`CHUNKS_IN_FLIGHT`), each decoded
 * straight into an output allocated once. A chunk's decoded size is the one
 * its array declares (chunk shape x item size); nothing else bounds it.
 * Gene columns of a CSC matrix are read per gene; a CSR matrix, or a dense
 * matrix chunked across many genes, is indexed once by gene in the
 * background (`sparse-column-index.js`).
 *
 * @module data/zarr-loader
 */

import { DecodedBlockCache } from './decoded-block-cache.js';
import {
  DEFAULT_KNN_KEY,
  requireObsmColumnSelection,
  requireObspKey,
} from './data-mapping-candidates.js';
import { geneNameText } from './gene-names.js';
import { compareCodePoints } from './data-mapping.js';
import {
  requireCategoricalCategoryCount,
} from './categorical-storage-contract.js';
import {
  decodeAnnDataBoolean,
  isAnnDataMatrixDataKind,
  isAnnDataNumericValueKind,
} from './anndata-value-kinds.js';
import {
  combineDatasetLifecycleFailures,
  createDatasetReloadSupersededError,
} from './dataset-lifecycle-errors.js';
import {
  decodeZarrChunk,
  validateZarrArrayMetadata,
  zarrChunkKey,
  zarrElementCount,
} from './zarr-codecs.js';
import {
  RowMajorColumnIndex,
  allocateTypedArray,
} from './sparse-column-index.js';
import { yieldToMacrotask } from '../utils/yield-macrotask.js';
import { connectivityEdgesOf } from './sparse-utils.js';
import { createWorkerColumnStoreFactory } from './column-store-placement.js';
import { residencyBudgetBytes } from './memory-budget.js';


/**
 * Swap bytes for big-endian data
 */
function swapBytes(buffer, bytesPerElem) {
  const view = new DataView(buffer);
  const result = new ArrayBuffer(buffer.byteLength);
  const resultView = new DataView(result);
  const n = buffer.byteLength / bytesPerElem;

  for (let i = 0; i < n; i++) {
    const offset = i * bytesPerElem;
    if (bytesPerElem === 2) {
      resultView.setUint16(offset, view.getUint16(offset, false), true);
    } else if (bytesPerElem === 4) {
      resultView.setUint32(offset, view.getUint32(offset, false), true);
    } else if (bytesPerElem === 8) {
      resultView.setBigUint64(offset, view.getBigUint64(offset, false), true);
    }
  }

  return result;
}

function float16BitsToNumber(bits) {
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exponent = (bits >>> 10) & 0x1f;
  const fraction = bits & 0x03ff;
  if (exponent === 0) {
    if (fraction === 0) return sign === 1 ? 0 : -0;
    return sign * (fraction / 1024) * (2 ** -14);
  }
  if (exponent === 0x1f) {
    return fraction === 0
      ? sign * Number.POSITIVE_INFINITY
      : Number.NaN;
  }
  return sign * (1 + fraction / 1024) * (2 ** (exponent - 15));
}

function numberToFloat16Bits(value) {
  const source = new Float32Array(1);
  const sourceBits = new Uint32Array(source.buffer);
  source[0] = value;
  const bits = sourceBits[0];
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  let fraction = bits & 0x7fffff;

  if (exponent === 0xff) {
    return sign | (fraction === 0 ? 0x7c00 : 0x7e00);
  }

  let halfExponent = exponent - 127 + 15;
  if (halfExponent >= 0x1f) return sign | 0x7c00;
  if (halfExponent <= 0) {
    if (halfExponent < -10) return sign;
    fraction |= 0x800000;
    const shift = 14 - halfExponent;
    let halfFraction = fraction >>> shift;
    const remainderMask = (2 ** shift) - 1;
    const remainder = fraction & remainderMask;
    const halfway = 2 ** (shift - 1);
    if (remainder > halfway ||
        (remainder === halfway && (halfFraction & 1) !== 0)) {
      halfFraction++;
    }
    return sign | halfFraction;
  }

  let halfFraction = fraction >>> 13;
  const remainder = fraction & 0x1fff;
  if (remainder > 0x1000 ||
      (remainder === 0x1000 && (halfFraction & 1) !== 0)) {
    halfFraction++;
    if (halfFraction === 0x400) {
      halfFraction = 0;
      halfExponent++;
      if (halfExponent >= 0x1f) return sign | 0x7c00;
    }
  }
  return sign | (halfExponent << 10) | halfFraction;
}

function decodeFloat16Chunk(buffer, bigEndian) {
  if (buffer.byteLength % 2 !== 0) {
    throw new Error('Invalid float16 Zarr chunk byte length');
  }
  const view = new DataView(buffer);
  const values = new Float32Array(buffer.byteLength / 2);
  for (let index = 0; index < values.length; index++) {
    values[index] = float16BitsToNumber(
      view.getUint16(index * 2, !bigEndian)
    );
  }
  return values;
}

function normalizeFillValue(fillValue, dtypeInfo) {
  // Zarr v2 uses JSON null to mean that an absent chunk has undefined
  // contents. Preserve that state so the AnnData reader can reject a missing
  // required chunk instead of synthesizing a plausible scientific zero.
  if (fillValue === null) return null;

  if (dtypeInfo.category === 'object') {
    if (fillValue === 0) return '';
    if (typeof fillValue === 'string') return fillValue;
    throw new Error(`Invalid fill_value for Zarr dtype '${dtypeInfo.dtype}'`);
  }

  if (dtypeInfo.category === 'fixed-string') {
    if (typeof fillValue !== 'string') {
      throw new Error(`Invalid fill_value for Zarr dtype '${dtypeInfo.dtype}'`);
    }
    if (dtypeInfo.encoding === 'utf32') {
      const codePoints = Array.from(fillValue);
      if (codePoints.some(value => {
        const codePoint = value.codePointAt(0);
        return codePoint >= 0xd800 && codePoint <= 0xdfff;
      })) {
        throw new Error(`Invalid Unicode fill_value for Zarr dtype '${dtypeInfo.dtype}'`);
      }
      const truncated = codePoints.slice(0, dtypeInfo.charCount);
      while (truncated.length > 0 && truncated[truncated.length - 1] === '\u0000') {
        truncated.pop();
      }
      return truncated.join('');
    }

    if (fillValue.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(fillValue)) {
      throw new Error(`Invalid Base64 fill_value for Zarr dtype '${dtypeInfo.dtype}'`);
    }
    let binary;
    try {
      binary = atob(fillValue);
    } catch (error) {
      throw new Error(`Invalid Base64 fill_value for Zarr dtype '${dtypeInfo.dtype}'`, { cause: error });
    }
    if (binary.length > dtypeInfo.bytes) {
      throw new Error(`Invalid Base64 fill_value size for Zarr dtype '${dtypeInfo.dtype}'`);
    }
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return decodeFixedStringChunk(bytes.buffer, dtypeInfo, 1)[0];
  }

  if (dtypeInfo.kind === 'bigint') {
    if (typeof fillValue === 'number' && !Number.isSafeInteger(fillValue)) {
      throw new Error(
        `Invalid fill_value for Zarr dtype '${dtypeInfo.dtype}': JSON number is outside the safe integer range`
      );
    }
    let value;
    try {
      value = BigInt(fillValue);
    } catch (error) {
      throw new Error(`Invalid fill_value for Zarr dtype '${dtypeInfo.dtype}'`, { cause: error });
    }
    const bits = BigInt(dtypeInfo.bytes * 8);
    const isUnsigned = dtypeInfo.dtype[1] === 'u';
    const minimum = isUnsigned ? 0n : -(1n << (bits - 1n));
    const maximum = isUnsigned
      ? (1n << bits) - 1n
      : (1n << (bits - 1n)) - 1n;
    if (value < minimum || value > maximum) {
      throw new Error(`Zarr fill_value is outside the range of '${dtypeInfo.dtype}'`);
    }
    return value;
  }

  if (dtypeInfo.kind === 'float' && fillValue === 'NaN') return Number.NaN;
  if (dtypeInfo.kind === 'float' && fillValue === 'Infinity') return Number.POSITIVE_INFINITY;
  if (dtypeInfo.kind === 'float' && fillValue === '-Infinity') return Number.NEGATIVE_INFINITY;

  const numeric = Number(fillValue);
  if (!Number.isFinite(numeric) ||
      (dtypeInfo.kind !== 'float' && !Number.isInteger(numeric))) {
    throw new Error(`Invalid fill_value for Zarr dtype '${dtypeInfo.dtype}'`);
  }

  if (dtypeInfo.kind === 'boolean' && numeric !== 0 && numeric !== 1) {
    throw new Error(`Zarr fill_value is outside the range of '${dtypeInfo.dtype}'`);
  }
  if (dtypeInfo.kind === 'integer') {
    const bits = dtypeInfo.bytes * 8;
    const isUnsigned = dtypeInfo.dtype[1] === 'u';
    const minimum = isUnsigned ? 0 : -(2 ** (bits - 1));
    const maximum = isUnsigned ? (2 ** bits) - 1 : (2 ** (bits - 1)) - 1;
    if (numeric < minimum || numeric > maximum) {
      throw new Error(`Zarr fill_value is outside the range of '${dtypeInfo.dtype}'`);
    }
  }
  if (dtypeInfo.halfFloat) {
    const narrowed = float16BitsToNumber(numberToFloat16Bits(numeric));
    if (Number.isFinite(numeric) && !Number.isFinite(narrowed)) {
      throw new Error('Zarr fill_value is outside the Float16 range');
    }
    return narrowed;
  }
  if (dtypeInfo.kind === 'float' &&
      dtypeInfo.ArrayType === Float32Array) {
    const narrowed = Math.fround(numeric);
    if (!Number.isFinite(narrowed)) {
      throw new Error('Zarr fill_value is outside the Float32 range');
    }
    return narrowed;
  }
  return numeric;
}

function typedArrayFromChunk(buffer, dtypeInfo) {
  if (dtypeInfo.halfFloat) {
    return decodeFloat16Chunk(buffer, dtypeInfo.bigEndian);
  }
  const nativeBuffer = dtypeInfo.bigEndian
    ? swapBytes(buffer, dtypeInfo.bytes)
    : buffer;
  const values = new dtypeInfo.ArrayType(nativeBuffer);
  if (dtypeInfo.kind === 'boolean') {
    for (const value of values) {
      decodeAnnDataBoolean(
        value,
        'Zarr boolean values must be encoded as 0 or 1'
      );
    }
  }
  return values;
}

function decodeFixedStringChunk(buffer, dtypeInfo, itemCount) {
  const bytes = new Uint8Array(buffer);
  const values = new Array(itemCount);
  const decoder = dtypeInfo.encoding === 'bytes'
    ? new TextDecoder('utf-8', { fatal: true })
    : null;

  for (let itemIndex = 0; itemIndex < itemCount; itemIndex++) {
    const start = itemIndex * dtypeInfo.bytes;
    const itemBytes = bytes.subarray(start, start + dtypeInfo.bytes);

    if (dtypeInfo.encoding === 'bytes') {
      let end = itemBytes.length;
      while (end > 0 && itemBytes[end - 1] === 0) end--;
      try {
        values[itemIndex] = decoder.decode(itemBytes.subarray(0, end));
      } catch (error) {
        throw new Error(
          `Invalid fixed-string UTF-8 in Zarr dtype '${dtypeInfo.dtype}'`,
          { cause: error }
        );
      }
      continue;
    }

    const view = new DataView(itemBytes.buffer, itemBytes.byteOffset, itemBytes.byteLength);
    const codePoints = new Array(dtypeInfo.charCount);
    let end = dtypeInfo.charCount;
    for (let charIndex = 0; charIndex < dtypeInfo.charCount; charIndex++) {
      const codePoint = view.getUint32(charIndex * 4, !dtypeInfo.bigEndian);
      if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        throw new Error(`Invalid UTF-32 code point in Zarr dtype '${dtypeInfo.dtype}'`);
      }
      codePoints[charIndex] = codePoint;
    }
    while (end > 0 && codePoints[end - 1] === 0) end--;
    let value = '';
    for (let charIndex = 0; charIndex < end; charIndex++) {
      value += String.fromCodePoint(codePoints[charIndex]);
    }
    values[itemIndex] = value;
  }
  return values;
}

/**
 * Classify a Zarr dtype into the AnnData value kind the H5AD reader uses for
 * the same content.
 * @returns {'float'|'int'|'uint'|'bool'|'string'}
 */
function annDataValueKind(dtypeInfo) {
  if (dtypeInfo.category === 'object' || dtypeInfo.category === 'fixed-string') {
    return 'string';
  }
  if (dtypeInfo.kind === 'boolean') return 'bool';
  if (dtypeInfo.kind === 'float') return 'float';
  return dtypeInfo.dtype[1] === 'u' ? 'uint' : 'int';
}

function requireCurrentZarrEncoding(
  attrs,
  expectedType,
  expectedVersion,
  label
) {
  if (attrs?.['encoding-type'] !== expectedType) {
    throw new Error(
      `${label} encoding-type must be exactly '${expectedType}'`
    );
  }
  if (attrs?.['encoding-version'] !== expectedVersion) {
    throw new Error(
      `${label} encoding-version must be exactly '${expectedVersion}'`
    );
  }
}

function requireCurrentZarrCategorical(attrs, label) {
  requireCurrentZarrEncoding(
    attrs,
    'categorical',
    '0.2.0',
    label
  );
  if (!Object.hasOwn(attrs, 'ordered') ||
      typeof attrs.ordered !== 'boolean') {
    throw new Error(
      `${label} ordered must be an own boolean attribute`
    );
  }
  return attrs.ordered;
}

function validateCurrentZarrArrayEncoding(
  meta,
  attrs,
  label,
  expectedType = null
) {
  const encodingType = attrs?.['encoding-type'];
  if (
    expectedType === null &&
    encodingType !== 'array' &&
    encodingType !== 'string-array'
  ) {
    throw new Error(
      `${label} encoding-type must be exactly 'array' or 'string-array'`
    );
  }
  const requiredType = expectedType ?? encodingType;
  requireCurrentZarrEncoding(
    attrs,
    requiredType,
    '0.2.0',
    label
  );

  const dtypeInfo = validateZarrArrayMetadata(meta, label);
  const isString =
    dtypeInfo.category === 'object' ||
    dtypeInfo.category === 'fixed-string';
  if (requiredType === 'string-array' &&
      dtypeInfo.category !== 'object') {
    throw new Error(
      `${label} string-array must use the exact Zarr object dtype with a VLenUTF8 filter`
    );
  }
  if (requiredType === 'array' && isString) {
    throw new Error(
      `${label} declares array but uses a string dtype`
    );
  }
  return dtypeInfo;
}

function validateOneDimensionalArrayMeta(
  meta,
  label,
  expectedLength = null,
  expectedAxis = 'cells'
) {
  const dtypeInfo = validateZarrArrayMetadata(meta, label);
  if (meta.shape.length !== 1) {
    throw new Error(`${label} must be one-dimensional`);
  }
  if (expectedLength != null && meta.shape[0] !== expectedLength) {
    throw new Error(
      `${label} length ${meta.shape[0]} does not match ${expectedLength} ${expectedAxis}`
    );
  }
  return dtypeInfo;
}

/**
 * The value and mask arrays of one nullable column have one length.
 *
 * @returns {{valuesLength: number}}
 */
function validateNullableLengths(valuesMeta, maskMeta, label) {
  const valuesLength = zarrElementCount(valuesMeta);
  const maskLength = zarrElementCount(maskMeta);
  if (valuesLength !== maskLength) {
    throw new Error(
      `${label} values and mask lengths differ (${valuesLength} versus ${maskLength})`
    );
  }
  return { valuesLength };
}

function validateCellucidCategoryCount(categoryCount, key) {
  return requireCategoricalCategoryCount(
    categoryCount,
    `Categorical field '${key}'`
  );
}

function numericValueToNumber(value, label) {
  if (typeof value === 'bigint') {
    if (value < BigInt(Number.MIN_SAFE_INTEGER) ||
        value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`${label} value is outside the safe numeric range`);
    }
    return Number(value);
  }
  return Number(value);
}

function numericValueToFloat32(value, label) {
  const number = numericValueToNumber(value, label);
  const narrowed = Math.fround(number);
  if (Number.isFinite(number) && !Number.isFinite(narrowed)) {
    throw new Error(`${label} value is outside the Float32 range`);
  }
  return narrowed;
}

function numericArrayToFloat32(values, label) {
  if (values instanceof Float32Array) return values;

  const result = new Float32Array(values.length);
  for (let index = 0; index < values.length; index++) {
    result[index] = numericValueToFloat32(values[index], label);
  }
  return result;
}

/**
 * The NumPy name of one Zarr v2 dtype (`<f4` is `float32`, `|b1` is
 * `bool`, `|O` is `string`), as the data-mapping catalog spells dtypes.
 *
 * @param {unknown} dtype
 * @returns {string}
 */
function zarrNumpyDtypeName(dtype) {
  const match = typeof dtype === 'string'
    ? /^[<>|=]?([biufOSU])(\d+)?$/.exec(dtype)
    : null;
  if (match === null) return 'object';
  const bits = Number(match[2] ?? 0) * 8;
  switch (match[1]) {
    case 'b': return 'bool';
    case 'i': return `int${bits}`;
    case 'u': return `uint${bits}`;
    case 'f': return `float${bits}`;
    default: return 'string';
  }
}

function isNumpyNumericName(dtype) {
  return /^(?:u?int|float)\d+$/.test(dtype);
}

function validateUniqueZarrCategories(categories, key) {
  const seen = new Set();
  for (const category of categories) {
    const type = typeof category;
    if (
      type !== 'string' &&
      type !== 'number' &&
      type !== 'boolean'
    ) {
      throw new Error(
        `Categorical categories for '${key}' contain an unsupported label type`
      );
    }
    if (type === 'number' && !Number.isFinite(category)) {
      throw new Error(
        `Categorical categories for '${key}' contain a non-finite numeric label`
      );
    }
    if (seen.has(category)) {
      throw new Error(
        `Categorical categories for '${key}' contain a duplicate label`
      );
    }
    seen.add(category);
  }
  return categories;
}

function normalizeCategoricalCategories(values, dtypeInfo, label) {
  if (dtypeInfo.category === 'object' ||
      dtypeInfo.category === 'fixed-string') {
    return Array.isArray(values) ? values : Array.from(values);
  }
  if (dtypeInfo.category !== 'numeric') {
    throw new Error(
      `${label} must use a numeric, boolean, or string dtype`
    );
  }

  if (dtypeInfo.kind === 'boolean') {
    const message = `${label} boolean values must be encoded as 0 or 1`;
    return Array.from(values, value => decodeAnnDataBoolean(value, message));
  }

  return Array.from(values, value => {
    const number = numericValueToNumber(value, label);
    if (!Number.isFinite(number)) {
      throw new Error(`${label} cannot contain non-finite numeric labels`);
    }
    return number;
  });
}

/**
 * The checked dtype, element count and fill value of one array.
 *
 * @param {Object} meta
 * @returns {{dtypeInfo: Object, totalElements: number, fill: unknown}}
 */
export function prepareZarrArrayAllocation(meta) {
  const dtypeInfo = validateZarrArrayMetadata(meta);
  const fill = normalizeFillValue(meta.fill_value, dtypeInfo);
  return { dtypeInfo, totalElements: zarrElementCount(meta), fill };
}

/**
 * The dtype of a dense expression matrix, which must be numeric and 2-D.
 *
 * @param {Object} meta
 * @returns {Object} dtype info
 */
export function validateDenseColumnContract(meta) {
  const dtypeInfo = validateZarrArrayMetadata(meta, 'Dense X column');
  if (!isAnnDataNumericValueKind(annDataValueKind(dtypeInfo))) {
    throw new Error(`Dense X has unsupported dtype: ${meta.dtype}`);
  }
  if (meta.shape.length !== 2) {
    throw new Error('Dense X must be a two-dimensional Zarr array');
  }
  return dtypeInfo;
}

/**
 * The structure of one sparse matrix: component kinds and lengths that agree
 * with its format and shape.
 */
export function validateSparseArrayContract({
  format,
  shape,
  dataMeta,
  indicesMeta,
  indptrMeta,
}) {
  if (format !== 'csr' && format !== 'csc') {
    throw new Error(`Unsupported sparse matrix format '${format}'`);
  }
  if (!Array.isArray(shape) || shape.length !== 2 ||
      shape.some(dimension => !Number.isSafeInteger(dimension) || dimension < 0)) {
    throw new Error('Sparse matrix shape dimensions must be non-negative safe integers');
  }

  const dataInfo = validateZarrArrayMetadata(dataMeta);
  const indicesInfo = validateZarrArrayMetadata(indicesMeta);
  const indptrInfo = validateZarrArrayMetadata(indptrMeta);
  if (dataMeta.shape.length !== 1 ||
      indicesMeta.shape.length !== 1 ||
      indptrMeta.shape.length !== 1) {
    throw new Error('Sparse matrix components must be one-dimensional Zarr arrays');
  }
  if (!isAnnDataMatrixDataKind(annDataValueKind(dataInfo))) {
    throw new Error('Sparse data must use a numeric dtype');
  }
  if (indicesInfo.kind !== 'integer' && indicesInfo.kind !== 'bigint') {
    throw new Error('Sparse indices must use an integer dtype');
  }
  if (indptrInfo.kind !== 'integer' && indptrInfo.kind !== 'bigint') {
    throw new Error('Sparse indptr must use an integer dtype');
  }

  const dataLength = zarrElementCount(dataMeta);
  const indicesLength = zarrElementCount(indicesMeta);
  const indptrLength = zarrElementCount(indptrMeta);
  if (dataLength !== indicesLength) {
    throw new Error(
      `Sparse data and indices lengths differ (${dataLength} versus ${indicesLength})`
    );
  }

  const pointerAxis = format === 'csr' ? shape[0] : shape[1];
  if (pointerAxis === Number.MAX_SAFE_INTEGER ||
      indptrLength !== pointerAxis + 1) {
    throw new Error(
      `Sparse indptr length ${indptrLength} does not match ${format.toUpperCase()} axis size ${pointerAxis}`
    );
  }
  return { dataInfo, indicesInfo, indptrInfo, dataLength };
}

function toCategoricalCodes(values, categoryCount) {
  const result = new Int32Array(values.length);
  const maximum = BigInt(categoryCount - 1);
  for (let index = 0; index < values.length; index++) {
    const rawValue = values[index];
    let value;
    if (typeof rawValue === 'bigint') {
      if (rawValue < -1n || rawValue > maximum) {
        throw new Error(
          `Categorical code ${rawValue} is outside bounds [-1, ${categoryCount})`
        );
      }
      value = Number(rawValue);
    } else {
      value = Number(rawValue);
      if (!Number.isSafeInteger(value) || value < -1 || value >= categoryCount) {
        throw new Error(
          `Categorical code ${rawValue} is outside bounds [-1, ${categoryCount})`
        );
      }
    }
    result[index] = value;
  }
  return result;
}

function validateCategoricalCodesMeta(
  meta,
  key,
  expectedLength,
  expectedAxis = 'cells'
) {
  const codesInfo = validateOneDimensionalArrayMeta(
    meta,
    `Categorical codes for '${key}'`,
    expectedLength,
    expectedAxis
  );
  const isSignedInteger =
    (codesInfo.kind === 'integer' || codesInfo.kind === 'bigint') &&
    codesInfo.dtype[1] === 'i';
  if (!isSignedInteger) {
    throw new Error(
      `Categorical codes for '${key}' must use a signed integer dtype`
    );
  }
  return codesInfo;
}

function toSparseInt32Array(values, label) {
  const result = new Int32Array(values.length);
  for (let index = 0; index < values.length; index++) {
    const rawValue = values[index];
    let value;
    if (typeof rawValue === 'bigint') {
      if (rawValue < 0n || rawValue > 2147483647n) {
        throw new Error(`Sparse ${label} value is outside the Int32 range`);
      }
      value = Number(rawValue);
    } else {
      value = Number(rawValue);
      if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647) {
        throw new Error(`Sparse ${label} value is outside the Int32 range`);
      }
    }
    result[index] = value;
  }
  return result;
}

/**
 * Zarr Loader for AnnData format stored in Zarr
 */
/**
 * A metadata file as text. A document longer than the engine's longest
 * string (about 2^29 UTF-16 units in V8) cannot be parsed by any reader; that
 * real limit is reported with the file it concerns, never a fixed cap.
 */
async function readFileText(file, path) {
  try {
    return await file.text();
  } catch (error) {
    if (error instanceof RangeError) {
      throw new RangeError(
        `Zarr metadata file '${path}' (${Number(file.size).toLocaleString('en-US')} bytes) is longer ` +
        'than the longest text this browser can hold.',
        { cause: error }
      );
    }
    throw error;
  }
}

function addFloat32(current, value, label) {
  const sum = current + value;
  const narrowed = Math.fround(sum);
  if (Number.isFinite(sum) && !Number.isFinite(narrowed)) {
    throw new Error(`${label} value is outside the Float32 range`);
  }
  return narrowed;
}

/**
 * Chunks read and decoded at once: enough to overlap file reads with native
 * inflation, few enough that the transient chunks stay small. A scheduling
 * choice, never a limit on what is read.
 */
const CHUNKS_IN_FLIGHT = Math.max(
  2,
  Math.min(8, Number(globalThis.navigator?.hardwareConcurrency) || 4)
);

/** Run `task` over `items`, at most `limit` at a time; the first failure rejects. */
async function forEachInPool(items, limit, task) {
  let next = 0;
  let failed = false;
  const runners = [];
  for (let worker = 0; worker < Math.min(limit, items.length); worker++) {
    runners.push((async () => {
      while (!failed && next < items.length) {
        const item = items[next++];
        try {
          await task(item);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    })());
  }
  await Promise.all(runners);
}

export class ZarrLoader {
  constructor() {
    /** @type {Map<string, Blob>|null} Store paths -> files (or ZIP entries) */
    this._files = null;

    /** @type {string|null} */
    this._rootName = null;

    /** @type {number} */
    this._nObs = 0;

    /** @type {number} */
    this._nVars = 0;

    /** @type {string[]} */
    this._obsKeys = [];

    /**
     * The var index as stored: names, possibly repeated. The adapter makes
     * them unique with the data-mapping rule (`makeUniqueNames`).
     * @type {string[]}
     */
    this._varNames = [];

    /** @type {Map<string, Object>} Metadata cache: field types, categories, names */
    this._cache = new Map();

    /**
     * The one expression matrix whose columns are being read (`X`,
     * `layers/<k>` or `raw/X`) and how its columns are reached. Reading
     * another matrix releases it. Gene columns themselves are not cached
     * here: the caller's field cache is their one owner.
     * @type {{element: string, columns: Object|null, loadPromise: Promise|null}|null}
     */
    this._matrix = null;

    /** @type {DecodedBlockCache} Decoded dense chunks shared by genes of one strip */
    this._decodedXBlocks = new DecodedBlockCache();

    /** @type {Object|null} Root .zattrs */
    this._rootAttrs = null;

    /** @type {number} Invalidates asynchronous results after clear/replacement */
    this._generation = 0;

    /** @type {number} Ensures the latest open request wins */
    this._openRequestId = 0;

    /** @type {((event: Object) => void)|null} Progress of long reads (indexing) */
    this.onProgress = null;

    /** Where gene-column indexes are kept (memory, else disk). */
    this.columnStoreFactory = createWorkerColumnStoreFactory();
  }

  _assertOpenRequest(requestId) {
    if (requestId !== this._openRequestId) {
      throw createDatasetReloadSupersededError(
        'Zarr open request was superseded by a newer selection.'
      );
    }
  }

  /**
   * Validate and adopt one indexed Zarr store transactionally: the open
   * dataset stays usable if the candidate fails.
   *
   * @param {Map<string, Blob>} files - Store-relative path -> file or ZIP entry
   * @param {string} rootName
   * @returns {Promise<void>}
   */
  async openFileMap(files, rootName) {
    if (!(files instanceof Map) || files.size === 0) {
      throw new Error('Zarr file map must be a non-empty Map');
    }
    if (typeof rootName !== 'string' || rootName.trim() === '') {
      throw new Error('Zarr root directory name is required');
    }
    const hasRequiredMetadata = Array.from(files.keys()).some(
      path => /(^|\/)\.(zgroup|zarray|zattrs)$/.test(path)
    );
    if (!hasRequiredMetadata) {
      throw new Error(
        'This browser omitted the required Zarr v2 metadata files from the selected directory. ' +
        'Load the same store as a Zarr ZIP archive instead.'
      );
    }

    const requestId = ++this._openRequestId;
    const candidate = new ZarrLoader();
    candidate._files = new Map(files);
    candidate._rootName = rootName;
    try {
      await candidate._readStructure();
      this._assertOpenRequest(requestId);

      // Release the previous state only after the complete candidate
      // structure has passed validation, then transfer the candidate state.
      this._releaseCurrentState();
      this._files = candidate._files;
      this._rootName = candidate._rootName;
      this._nObs = candidate._nObs;
      this._nVars = candidate._nVars;
      this._obsKeys = candidate._obsKeys;
      this._varNames = candidate._varNames;
      this._cache = candidate._cache;
      this._matrix = candidate._matrix;
      this._rootAttrs = candidate._rootAttrs;
      console.log(`[ZarrLoader] Opened ${this._rootName}: ${this._nObs} cells, ${this._nVars} genes`);
    } catch (error) {
      let terminalError = error instanceof Error
        ? error
        : new TypeError(
            'Zarr file-map opening must reject with an Error.',
            { cause: error }
          );
      try {
        candidate.close();
      } catch (cleanupFailure) {
        terminalError = combineDatasetLifecycleFailures(
          terminalError,
          cleanupFailure,
          'Zarr file-map opening and candidate cleanup both failed.'
        );
      }
      throw terminalError;
    }
  }

  _assertGeneration(generation, operation = 'loading Zarr data') {
    if (generation !== this._generation) {
      throw new Error(
        `Zarr dataset changed while ${operation}; the request was superseded`
      );
    }
  }

  /**
   * Read a JSON file from the zarr
   * @param {string} path - Path relative to zarr root
   * @returns {Promise<Object>}
   * @private
   */
  async _readJson(path) {
    const generation = this._generation;
    const file = this._files?.get(path);
    if (!file) {
      throw new Error(`File not found: ${path}`);
    }
    const text = await readFileText(file, path);
    this._assertGeneration(generation, `reading metadata '${path}'`);
    return JSON.parse(text);
  }

  async _readChunkFile(path) {
    const generation = this._generation;
    const file = this._files?.get(path);
    if (!file) {
      throw new Error(`File not found: ${path}`);
    }
    const buffer = await file.arrayBuffer();
    this._assertGeneration(generation, `reading chunk '${path}'`);
    return buffer;
  }

  /**
   * Check if a path exists
   * @param {string} path
   * @returns {boolean}
   * @private
   */
  _exists(path) {
    return this._files.has(path);
  }

  /**
   * Read array metadata (.zarray)
   * @param {string} groupPath - Path to array group
   * @returns {Promise<Object>}
   * @private
   */
  async _readArrayMeta(groupPath) {
    const zarrayPath = groupPath ? `${groupPath}/.zarray` : '.zarray';
    return this._readJson(zarrayPath);
  }

  /**
   * Read group/array attributes (.zattrs)
   * @param {string} groupPath - Path to group
   * @returns {Promise<Object>}
   * @private
   */
  async _readAttrs(groupPath) {
    const zattrsPath = groupPath ? `${groupPath}/.zattrs` : '.zattrs';
    if (!this._exists(zattrsPath)) {
      return {};
    }
    return this._readJson(zattrsPath);
  }

  /**
   * Require one exact Zarr v2 group marker before reading group attributes or
   * enumerating children.
   *
   * @param {string} groupPath
   * @param {string} label
   * @returns {Promise<Object>}
   * @private
   */
  async _readCurrentZarrGroup(groupPath, label) {
    const zgroupPath = groupPath ? `${groupPath}/.zgroup` : '.zgroup';
    if (!this._exists(zgroupPath)) {
      throw new Error(`${label} .zgroup metadata is required`);
    }

    let group;
    try {
      group = await this._readJson(zgroupPath);
    } catch (cause) {
      throw new Error(`${label} .zgroup must contain valid JSON`, { cause });
    }
    if (
      group === null ||
      typeof group !== 'object' ||
      Array.isArray(group) ||
      group.zarr_format !== 2
    ) {
      throw new Error(
        `${label} .zgroup must declare "zarr_format": 2`
      );
    }
    return group;
  }

  /**
   * Require an AnnData-owned group and its exact encoding identity.
   *
   * @param {string} groupPath
   * @param {string} label
   * @param {string} encodingType
   * @param {string} encodingVersion
   * @returns {Promise<Object>}
   * @private
   */
  async _readCurrentAnnDataGroupAttrs(
    groupPath,
    label,
    encodingType,
    encodingVersion
  ) {
    await this._readCurrentZarrGroup(groupPath, label);
    const zattrsPath = groupPath ? `${groupPath}/.zattrs` : '.zattrs';
    if (!this._exists(zattrsPath)) {
      throw new Error(`${label} .zattrs metadata is required`);
    }
    const attrs = await this._readJson(zattrsPath);
    if (attrs === null ||
        typeof attrs !== 'object' ||
        Array.isArray(attrs)) {
      throw new Error(`${label} .zattrs must contain a JSON object`);
    }
    requireCurrentZarrEncoding(
      attrs,
      encodingType,
      encodingVersion,
      label
    );
    return attrs;
  }

  async _readAnnDataElementAttrs(elementPath, label) {
    const hasArray = this._exists(`${elementPath}/.zarray`);
    const hasGroup = this._exists(`${elementPath}/.zgroup`);
    const hasAttrs = this._exists(`${elementPath}/.zattrs`);
    const hasChildren = Array.from(this._files.keys()).some(
      path => path.startsWith(`${elementPath}/`) &&
        path !== `${elementPath}/.zarray` &&
        path !== `${elementPath}/.zgroup` &&
        path !== `${elementPath}/.zattrs`
    );
    if (!hasArray && !hasGroup && !hasAttrs && !hasChildren) {
      return null;
    }
    if (hasArray && hasGroup) {
      throw new Error(
        `${label} cannot be both a Zarr array and a Zarr group`
      );
    }
    if (!hasArray) {
      await this._readCurrentZarrGroup(elementPath, label);
    }
    return this._readAttrs(elementPath);
  }

  async _readCurrentCategoricalAttrs(fieldPath, label) {
    const attrs = await this._readCurrentAnnDataGroupAttrs(
      fieldPath,
      label,
      'categorical',
      '0.2.0'
    );
    return {
      attrs,
      ordered: requireCurrentZarrCategorical(attrs, label)
    };
  }

  _arrayHasAbsentChunk(arrayPath, meta) {
    const chunkCounts = meta.shape.map(
      (dimension, index) =>
        Math.ceil(dimension / meta.chunks[index])
    );
    const dimensionSeparator = meta.dimension_separator ?? '.';

    if (meta.shape.length === 1) {
      for (let first = 0; first < chunkCounts[0]; first++) {
        const key = zarrChunkKey([first], dimensionSeparator);
        if (!this._exists(`${arrayPath}/${key}`)) return true;
      }
      return false;
    }

    for (let first = 0; first < chunkCounts[0]; first++) {
      for (let second = 0; second < chunkCounts[1]; second++) {
        const key = zarrChunkKey(
          [first, second],
          dimensionSeparator
        );
        if (!this._exists(`${arrayPath}/${key}`)) return true;
      }
    }
    return false;
  }

  _requireDefinedAbsentChunkFill(arrayPath, meta, fill) {
    if (fill !== null || !this._arrayHasAbsentChunk(arrayPath, meta)) {
      return;
    }
    throw new Error(
      `Zarr array '${arrayPath}' has an absent chunk while fill_value is null, so its contents are undefined`
    );
  }

  /**
   * Read one AnnData-owned array contract and require its exact current
   * encoding metadata before any payload is decoded.
   *
   * @param {string} arrayPath
   * @param {string} label
   * @param {'array'|'string-array'|null} expectedType
   * @returns {Promise<Object>}
   * @private
   */
  async _readCurrentAnnDataArrayMeta(
    arrayPath,
    label,
    expectedType = null
  ) {
    const [meta, attrs] = await Promise.all([
      this._readArrayMeta(arrayPath),
      this._readAttrs(arrayPath)
    ]);
    validateCurrentZarrArrayEncoding(
      meta,
      attrs,
      label,
      expectedType
    );
    return meta;
  }

  /**
   * Read one chunk and decode it to its values (a typed array of the
   * array's dtype, or strings), or null when the chunk is absent.
   * @private
   */
  async _readDecodedChunk(arrayPath, meta, dtypeInfo, coords, elementCount) {
    const chunkPath = `${arrayPath}/${zarrChunkKey(coords, meta.dimension_separator ?? '.')}`;
    if (!this._exists(chunkPath)) return null;
    const encoded = await this._readChunkFile(chunkPath);
    const decoded = await decodeZarrChunk(encoded, meta, dtypeInfo, elementCount);
    if (dtypeInfo.category === 'numeric') return typedArrayFromChunk(decoded, dtypeInfo);
    return dtypeInfo.category === 'object'
      ? decoded
      : decodeFixedStringChunk(decoded, dtypeInfo, elementCount);
  }

  /**
   * Read a zarr array (all chunks), several chunks at a time.
   * @param {string} arrayPath - Path to array
   * @returns {Promise<{data: TypedArray|Array, shape: number[], dtype: string}>}
   * @private
   */
  async _readArray(arrayPath) {
    const generation = this._generation;
    const meta = await this._readArrayMeta(arrayPath);
    this._assertGeneration(generation, `reading array '${arrayPath}'`);
    const { dtypeInfo, fill } = prepareZarrArrayAllocation(meta);
    const { shape, dtype } = meta;
    this._requireDefinedAbsentChunkFill(arrayPath, meta, fill);
    if (shape.length === 1) {
      const data = await this._readRange1D(
        arrayPath, meta, dtypeInfo, fill, 0, shape[0], generation
      );
      return { data, shape, dtype };
    }
    if (dtypeInfo.category !== 'numeric') {
      throw new Error(`Unsupported ${shape.length}D string array at '${arrayPath}'`);
    }
    const result = allocateTypedArray(
      dtypeInfo.ArrayType,
      zarrElementCount(meta),
      `Zarr array '${arrayPath}'`
    );
    result.fill(fill);
    await this._readNDArray(arrayPath, meta, result, dtypeInfo, generation);
    this._assertGeneration(generation, `reading array '${arrayPath}'`);
    return { data: result, shape, dtype };
  }

  /**
   * Read elements `[start, end)` of a one-dimensional array: only the chunks
   * covering the range, `CHUNKS_IN_FLIGHT` at a time, each decoded straight
   * into one output allocated up front.
   * @private
   */
  async _readRange1D(arrayPath, meta, dtypeInfo, fill, start, end, generation) {
    const chunk = meta.chunks[0];
    const length = end - start;
    let output;
    if (dtypeInfo.category === 'numeric') {
      output = allocateTypedArray(dtypeInfo.ArrayType, length, `Zarr array '${arrayPath}'`);
      if (fill !== 0 && fill !== 0n && length > 0) output.fill(fill);
    } else {
      output = new Array(length).fill(fill);
    }
    if (length === 0) return output;
    const first = Math.floor(start / chunk);
    const last = Math.floor((end - 1) / chunk);
    const indices = [];
    for (let c = first; c <= last; c++) indices.push(c);
    await forEachInPool(indices, CHUNKS_IN_FLIGHT, async c => {
      const values = await this._readDecodedChunk(arrayPath, meta, dtypeInfo, [c], chunk);
      this._assertGeneration(generation, `reading array '${arrayPath}'`);
      if (values === null) return;
      const from = Math.max(start, c * chunk);
      const to = Math.min(end, (c + 1) * chunk, meta.shape[0]);
      if (dtypeInfo.category === 'numeric') {
        output.set(values.subarray(from - c * chunk, to - c * chunk), from - start);
      } else {
        for (let index = from; index < to; index++) {
          output[index - start] = values[index - c * chunk];
        }
      }
    });
    return output;
  }

  /**
   * A reader of ranges of one 1-D numeric array, with its metadata read once.
   * Integer values come back as numbers (int64 as exact Float64).
   * @private
   */
  async _rangeReader(arrayPath, { asFloat32 = false } = {}) {
    const meta = await this._readArrayMeta(arrayPath);
    const { dtypeInfo, fill } = prepareZarrArrayAllocation(meta);
    this._requireDefinedAbsentChunkFill(arrayPath, meta, fill);
    const label = `Zarr array '${arrayPath}'`;
    return async (start, end) => {
      const generation = this._generation;
      const raw = await this._readRange1D(arrayPath, meta, dtypeInfo, fill, start, end, generation);
      if (asFloat32) return numericArrayToFloat32(raw, label);
      if (raw instanceof BigInt64Array || raw instanceof BigUint64Array) {
        const values = allocateTypedArray(Float64Array, raw.length, label);
        for (let index = 0; index < raw.length; index++) {
          values[index] = numericValueToNumber(raw[index], label);
        }
        return values;
      }
      return raw;
    };
  }

  /**
   * Read a two-dimensional numeric array into `result` (row-major).
   * @private
   */
  async _readNDArray(arrayPath, meta, result, dtypeInfo, generation = this._generation) {
    const { shape, chunks, order } = meta;
    const [nRows, nCols] = shape;
    const [chunkRows, chunkCols] = chunks;
    const chunkElementCount = chunkRows * chunkCols;
    const coords = [];
    for (let cr = 0; cr < Math.ceil(nRows / chunkRows); cr++) {
      for (let cc = 0; cc < Math.ceil(nCols / chunkCols); cc++) coords.push([cr, cc]);
    }
    await forEachInPool(coords, CHUNKS_IN_FLIGHT, async ([cr, cc]) => {
      const chunkData = await this._readDecodedChunk(
        arrayPath, meta, dtypeInfo, [cr, cc], chunkElementCount
      );
      this._assertGeneration(generation, `reading array '${arrayPath}'`);
      if (chunkData === null) return;
      const rowStart = cr * chunkRows;
      const colStart = cc * chunkCols;
      const rowEnd = Math.min(rowStart + chunkRows, nRows);
      const colEnd = Math.min(colStart + chunkCols, nCols);
      const actualChunkCols = colEnd - colStart;
      if (order === 'C') {
        for (let row = rowStart; row < rowEnd; row++) {
          const sourceOffset = (row - rowStart) * chunkCols;
          result.set(
            chunkData.subarray(sourceOffset, sourceOffset + actualChunkCols),
            row * nCols + colStart
          );
        }
      } else {
        for (let row = rowStart; row < rowEnd; row++) {
          for (let column = colStart; column < colEnd; column++) {
            result[row * nCols + column] =
              chunkData[(column - colStart) * chunkRows + (row - rowStart)];
          }
        }
      }
    });
  }

  async _readDataFrameIndex(
    indexPath,
    label,
    materializeValues = false
  ) {
    if (this._exists(`${indexPath}/.zarray`)) {
      const meta = await this._readCurrentAnnDataArrayMeta(
        indexPath,
        label,
        'string-array'
      );
      const info = validateOneDimensionalArrayMeta(meta, label);
      if (info.category !== 'object' &&
          info.category !== 'fixed-string') {
        throw new Error(`${label} must use a string dtype`);
      }
      if (!materializeValues) {
        return { length: meta.shape[0], values: null };
      }
      const { data } = await this._readArray(indexPath);
      const values = Array.from(data, value => {
        if (value === null || value === undefined) {
          throw new Error(`${label} cannot contain missing names`);
        }
        return String(value);
      });
      return { length: meta.shape[0], values };
    }

    const hasIndexNode =
      this._exists(`${indexPath}/.zgroup`) ||
      this._exists(`${indexPath}/.zattrs`) ||
      Array.from(this._files.keys()).some(
        path => path.startsWith(`${indexPath}/`)
      );
    if (!hasIndexNode) {
      throw new Error(`${label} is missing`);
    }

    const contract = await this._readNullableObsContract(
      indexPath,
      label,
      'nullable-string-array',
      null
    );
    const { data: mask } =
      await this._readArray(`${indexPath}/mask`);
    if (Array.from(mask).some(value => value !== 0)) {
      throw new Error(`${label} cannot contain missing names`);
    }
    if (!materializeValues) {
      return { length: contract.valuesMeta.shape[0], values: null };
    }
    const { data: rawValues } =
      await this._readArray(`${indexPath}/values`);
    return {
      length: contract.valuesMeta.shape[0],
      values: Array.from(rawValues, value => String(value))
    };
  }

  /**
   * Read the basic structure of the zarr AnnData
   * @private
   */
  async _readStructure() {
    this._nObs = 0;
    this._nVars = 0;
    this._obsKeys = [];
    this._varNames = [];

    // AnnData Zarr v2 is a root group with an explicit, exact AnnData
    // encoding identity. Treat these files as the format boundary rather than
    // inferring identity from child arrays or a substring match.
    await this._readCurrentZarrGroup('', 'AnnData Zarr root');
    if (!this._exists('.zattrs')) {
      throw new Error('AnnData Zarr root .zattrs metadata is required');
    }
    this._rootAttrs = await this._readJson('.zattrs');
    if (
      this._rootAttrs === null ||
      typeof this._rootAttrs !== 'object' ||
      Array.isArray(this._rootAttrs) ||
      this._rootAttrs['encoding-type'] !== 'anndata'
    ) {
      throw new Error(
        'AnnData Zarr root .zattrs must declare encoding-type exactly "anndata"'
      );
    }
    if (this._rootAttrs['encoding-version'] !== '0.1.0') {
      throw new Error(
        'AnnData Zarr root .zattrs must declare encoding-version exactly "0.1.0"'
      );
    }

    // Check for X matrix and its format. Keep the shape separately so a
    // legitimate zero-length axis is not confused with an unknown dimension.
    let xShape = null;
    const hasDenseX = this._exists('X/.zarray');
    const hasSparseXRepresentation =
      this._exists('X/.zgroup') ||
      (!hasDenseX && (
        this._exists('X/.zattrs') ||
        this._exists('X/data/.zarray') ||
        this._exists('X/indices/.zarray') ||
        this._exists('X/indptr/.zarray')
      ));
    if (hasDenseX && this._exists('X/.zgroup')) {
      throw new Error(
        'AnnData X cannot be both a dense Zarr array and a sparse Zarr group'
      );
    }
    if (hasDenseX) {
      // Dense X matrix
      const xMeta = await this._readCurrentAnnDataArrayMeta(
        'X',
        'Dense X',
        'array'
      );
      validateDenseColumnContract(xMeta);
      xShape = [...xMeta.shape];
    } else if (hasSparseXRepresentation) {
      const sparseMetadata = await this._readSparseMetadataContract('X');
      xShape = [...sparseMetadata.shape];
      console.log(`[ZarrLoader] X is sparse (${sparseMetadata.encodingType})`);
    }
    if (xShape) {
      [this._nObs, this._nVars] = xShape;
    }

    // AnnData obs is a required dataframe group. Enforce the exact currently
    // supported dataframe identity and its declared index before inspecting
    // any public columns, so future/incompatible encodings cannot be adopted
    // and interpreted as the current layout.
    await this._readCurrentZarrGroup('obs', 'AnnData obs');
    if (!this._exists('obs/.zattrs')) {
      throw new Error('AnnData obs .zattrs metadata is required');
    }
    const obsAttrs = await this._readJson('obs/.zattrs');
    if (
      obsAttrs === null ||
      typeof obsAttrs !== 'object' ||
      Array.isArray(obsAttrs) ||
      obsAttrs['encoding-type'] !== 'dataframe'
    ) {
      throw new Error(
        'AnnData obs .zattrs must declare encoding-type exactly "dataframe"'
      );
    }
    if (obsAttrs['encoding-version'] !== '0.2.0') {
      throw new Error(
        'AnnData obs .zattrs must declare encoding-version exactly "0.2.0"'
      );
    }

    const indexKey = obsAttrs['_index'];
    if (typeof indexKey !== 'string' || indexKey.length === 0) {
      throw new Error(
        'AnnData obs _index must be a non-empty string'
      );
    }

    const columnOrder = obsAttrs['column-order'];
    if (!Array.isArray(columnOrder)) {
      throw new Error('AnnData obs column-order must be an array');
    }
    const seenObsKeys = new Set();
    for (const key of columnOrder) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error(
          'Every AnnData obs column-order member must be a non-empty string'
        );
      }
      if (seenObsKeys.has(key)) {
        throw new Error(
          'AnnData obs column-order members must be unique'
        );
      }
      if (key === indexKey) {
        throw new Error(
          `AnnData obs column-order cannot also declare its index '${indexKey}' as an observation field`
        );
      }
      seenObsKeys.add(key);
    }
    this._obsKeys = [...columnOrder];

    // Read the axis length even when X already supplied it so contradictions
    // fail before the candidate data source becomes active.
    const index = await this._readDataFrameIndex(
      `obs/${indexKey}`,
      'AnnData obs index'
    );
    const obsCount = index.length;

    if (xShape && obsCount != null && xShape[0] !== obsCount) {
      throw new Error(
        `X row dimension ${xShape[0]} does not match obs index dimension ${obsCount}`
      );
    }
    if (!xShape && obsCount != null) {
      this._nObs = obsCount;
    }

    // `column-order` is the dataframe's public schema. Validate every declared
    // field before adoption so missing, unsupported, or incomplete columns are
    // never silently omitted later by metadata discovery.
    for (const key of this._obsKeys) {
      let info;
      try {
        info = await this._getObsFieldTypeInfo(key);
      } catch (error) {
        throw new Error(
          `Declared observation column '${key}' is invalid: ${error.message}`,
          { cause: error }
        );
      }
      if (info.dtype === 'unknown') {
        const fieldPath = `obs/${key}`;
        const hasFieldMetadata =
          this._exists(`${fieldPath}/.zarray`) ||
          this._exists(`${fieldPath}/.zgroup`) ||
          this._exists(`${fieldPath}/.zattrs`);
        if (hasFieldMetadata) {
          throw new Error(
            `Declared observation column '${key}' uses an unsupported AnnData Zarr encoding`
          );
        }
        throw new Error(
          `Declared observation column '${key}' is missing from the Zarr store`
        );
      }
    }

    // AnnData var is the required dataframe for the variable axis, including
    // X=None datasets. Apply the same exact current dataframe identity and
    // declared-schema boundary as obs instead of deriving genes from X alone.
    await this._readCurrentZarrGroup('var', 'AnnData var');
    if (!this._exists('var/.zattrs')) {
      throw new Error('AnnData var .zattrs metadata is required');
    }
    const varAttrs = await this._readJson('var/.zattrs');
    if (
      varAttrs === null ||
      typeof varAttrs !== 'object' ||
      Array.isArray(varAttrs) ||
      varAttrs['encoding-type'] !== 'dataframe'
    ) {
      throw new Error(
        'AnnData var .zattrs must declare encoding-type exactly "dataframe"'
      );
    }
    if (varAttrs['encoding-version'] !== '0.2.0') {
      throw new Error(
        'AnnData var .zattrs must declare encoding-version exactly "0.2.0"'
      );
    }

    const varIndexKey = varAttrs['_index'];
    if (typeof varIndexKey !== 'string' || varIndexKey.length === 0) {
      throw new Error(
        'AnnData var _index must be a non-empty string'
      );
    }

    const varColumnOrder = varAttrs['column-order'];
    if (!Array.isArray(varColumnOrder)) {
      throw new Error('AnnData var column-order must be an array');
    }
    const seenVarKeys = new Set();
    for (const key of varColumnOrder) {
      if (typeof key !== 'string' || key.length === 0) {
        throw new Error(
          'Every AnnData var column-order member must be a non-empty string'
        );
      }
      if (seenVarKeys.has(key)) {
        throw new Error(
          'AnnData var column-order members must be unique'
        );
      }
      if (key === varIndexKey) {
        throw new Error(
          `AnnData var column-order cannot also declare its index '${varIndexKey}' as a variable field`
        );
      }
      seenVarKeys.add(key);
    }

    const varIndex = await this._readDataFrameIndex(
      `var/${varIndexKey}`,
      'AnnData var index',
      true
    );
    const varCount = varIndex.length;
    this._varNames = varIndex.values;

    if (xShape && xShape[1] !== varCount) {
      throw new Error(
        `X column dimension ${xShape[1]} does not match var index dimension ${varCount}`
      );
    }
    if (!xShape) {
      this._nVars = varCount;
    }

    // A repeated name is kept as stored: the adapter makes the gene list
    // unique with the data-mapping rule, as cellucid serve does.

    for (const key of varColumnOrder) {
      let info;
      try {
        info = await this._getDataFrameFieldTypeInfo(
          'var',
          key,
          varCount
        );
      } catch (error) {
        throw new Error(
          `Declared variable column '${key}' is invalid: ${error.message}`,
          { cause: error }
        );
      }
      if (info.dtype === 'unknown') {
        const fieldPath = `var/${key}`;
        const hasFieldMetadata =
          this._exists(`${fieldPath}/.zarray`) ||
          this._exists(`${fieldPath}/.zgroup`) ||
          this._exists(`${fieldPath}/.zattrs`);
        if (hasFieldMetadata) {
          throw new Error(
            `Declared variable column '${key}' uses an unsupported AnnData Zarr encoding`
          );
        }
        throw new Error(
          `Declared variable column '${key}' is missing from the Zarr store`
        );
      }
    }

    // Read obsm structure only after the exact mapping owner is established.
    const hasObsmRepresentation = Array.from(this._files.keys()).some(
      path => path === 'obsm/.zgroup' ||
        path === 'obsm/.zattrs' ||
        path.startsWith('obsm/')
    );
    if (hasObsmRepresentation) {
      await this._readCurrentAnnDataGroupAttrs(
        'obsm',
        'AnnData obsm mapping',
        'dict',
        '0.1.0'
      );
      // Its entries are described by probeMapping().
    }

    // Edge case validation: empty AnnData
    if (this._nObs === 0) {
      console.warn('[ZarrLoader] AnnData has 0 cells - this may cause issues');
    }

    // Edge case: no X matrix
    const hasX = this._exists('X/.zarray') || this._exists('X/.zgroup');
    if (!hasX) {
      console.warn('[ZarrLoader] No X matrix found in AnnData - gene expression will not be available');
    }
  }

  // =========================================================================
  // Public API (matches H5adLoader interface)
  // =========================================================================

  get nObs() { return this._nObs; }
  get nVars() { return this._nVars; }
  get obsKeys() { return [...this._obsKeys]; }
  get varNames() { return [...this._varNames]; }
  get isOpen() { return this._files !== null && this._files.size > 0; }
  get hasExpressionMatrix() {
    return this._files !== null &&
      (this._exists('X/.zarray') || this._exists('X/.zgroup'));
  }

  /**
   * Describe one AnnData element from its Zarr metadata, for the data-mapping
   * catalog. Nothing is read and nothing is refused: an element this reader
   * cannot classify is storage `other`.
   *
   * @param {string} path
   * @param {string} key
   * @returns {Promise<{key: string, storage: string, shape: number[]|null, dtype: string, numeric: boolean, nnz: number|null}>}
   * @private
   */
  async _probeZarrElement(path, key) {
    const other = { key, storage: 'other', shape: null, dtype: 'object', numeric: false, nnz: null };
    try {
      if (this._exists(`${path}/.zarray`)) {
        const [meta, attrs] = await Promise.all([
          this._readArrayMeta(path),
          this._readAttrs(path)
        ]);
        const dtype = attrs['encoding-type'] === 'string-array'
          ? 'string'
          : zarrNumpyDtypeName(meta.dtype);
        return {
          key,
          storage: 'dense',
          shape: meta.shape.map(Number),
          dtype,
          numeric: isNumpyNumericName(dtype),
          nnz: null
        };
      }
      if (!this._exists(`${path}/.zgroup`)) return other;
      const attrs = await this._readAttrs(path);
      const encoding = attrs['encoding-type'];
      if (encoding === 'csr_matrix' || encoding === 'csc_matrix') {
        const storage = encoding.slice(0, 3);
        const shape = Array.isArray(attrs.shape) ? attrs.shape.map(Number) : null;
        if (!this._exists(`${path}/data/.zarray`)) return { ...other, storage, shape };
        const dataMeta = await this._readArrayMeta(`${path}/data`);
        const dtype = zarrNumpyDtypeName(dataMeta.dtype);
        return {
          key,
          storage,
          shape,
          dtype,
          numeric: isNumpyNumericName(dtype),
          nnz: Number(dataMeta.shape[0])
        };
      }
      if (encoding === 'dataframe') {
        const indexKey = attrs._index;
        const columns = Array.isArray(attrs['column-order'])
          ? attrs['column-order'].length
          : null;
        let rows = null;
        if (typeof indexKey === 'string' && this._exists(`${path}/${indexKey}/.zarray`)) {
          rows = Number((await this._readArrayMeta(`${path}/${indexKey}`)).shape[0]);
        }
        return {
          ...other,
          storage: 'dataframe',
          shape: rows === null || columns === null ? null : [rows, columns]
        };
      }
    } catch {
      return other;
    }
    return other;
  }

  /**
   * The keys of one AnnData mapping group, in code-point order (the order a
   * Zarr store lists its children in).
   *
   * @param {string} groupPath
   * @returns {string[]}
   * @private
   */
  _zarrChildKeys(groupPath) {
    const keys = new Set();
    for (const path of this._files.keys()) {
      if (!path.startsWith(`${groupPath}/`)) continue;
      const parts = path.split('/');
      if (parts.length >= 3) keys.add(parts[1]);
    }
    return [...keys].sort(compareCodePoints);
  }

  /**
   * The columns of one AnnData dataframe and the dtype each holds.
   *
   * @param {string} dataframePath
   * @returns {Promise<Array<{key: string, dtype: string}>>}
   * @private
   */
  async _probeZarrDataFrameColumns(dataframePath) {
    const attrs = await this._readAttrs(dataframePath);
    const columnOrder = Array.isArray(attrs['column-order']) ? attrs['column-order'] : [];
    const columns = [];
    for (const key of columnOrder) {
      const path = `${dataframePath}/${key}`;
      if (this._exists(`${path}/.zarray`)) {
        const probe = await this._probeZarrElement(path, key);
        columns.push({ key, dtype: probe.dtype });
        continue;
      }
      const encoding = (await this._readAttrs(path))['encoding-type'];
      const dtype = {
        categorical: 'categorical',
        'nullable-integer': 'Int64',
        'nullable-boolean': 'boolean',
        'nullable-string-array': 'string'
      }[encoding] ?? 'object';
      columns.push({ key, dtype });
    }
    return columns;
  }

  /**
   * Describe, from Zarr metadata alone, every element the data-mapping catalog
   * lists: the `obsm` and `obsp` entries, the var columns, `X`, the layers and
   * `raw`. No chunk is read.
   *
   * @returns {Promise<import('./data-mapping-candidates.js').AnnDataProbes>}
   */
  async probeMapping() {
    this._ensureOpen();
    const generation = this._generation;
    const mappingProbes = async (name) => {
      if (!this._exists(`${name}/.zgroup`) && !this._exists(`${name}/.zattrs`)) {
        return [];
      }
      await this._readCurrentAnnDataGroupAttrs(
        name,
        `AnnData ${name} mapping`,
        'dict',
        '0.1.0'
      );
      const probes = [];
      for (const key of this._zarrChildKeys(name)) {
        probes.push(await this._probeZarrElement(`${name}/${key}`, key));
      }
      return probes;
    };
    const obsm = await mappingProbes('obsm');
    const obsp = await mappingProbes('obsp');
    const layers = await mappingProbes('layers');
    const varColumns = await this._probeZarrDataFrameColumns('var');
    let matrixX = null;
    if (this._exists('X/.zarray') || this._exists('X/.zgroup')) {
      const probe = await this._probeZarrElement('X', 'X');
      matrixX = { storage: probe.storage, dtype: probe.dtype };
    }
    let raw = null;
    if (this._exists('raw/X/.zarray') || this._exists('raw/X/.zgroup')) {
      const rawX = await this._probeZarrElement('raw/X', 'X');
      raw = {
        nVars: rawX.shape?.length === 2 ? rawX.shape[1] : 0,
        X: { storage: rawX.storage, dtype: rawX.dtype },
        varColumns: this._exists('raw/var/.zgroup')
          ? await this._probeZarrDataFrameColumns('raw/var')
          : []
      };
    }
    this._assertGeneration(generation, 'probing the data-mapping catalog');
    return {
      nObs: this._nObs,
      nVars: this._nVars,
      obsm,
      obsp,
      varColumns,
      X: matrixX,
      layers,
      raw
    };
  }

  /**
   * Read the selected columns of one dense `obsm` array, unnormalized, one row
   * per cell. Only the chunks that hold a selected column are decoded. A
   * one-dimensional array is one column.
   *
   * @param {string} key - Exact obsm key
   * @param {ReadonlyArray<number>} columns - Distinct 0-based columns, in output order
   * @returns {Promise<Float64Array>} `n_obs * columns.length` values, row-major
   */
  /**
   * One dense numeric `obsm` array's metadata, checked: one row per cell, one
   * or two dimensions.
   * @private
   */
  async _obsmArrayMeta(key, generation) {
    const label = `obsm['${key}']`;
    const arrayPath = `obsm/${key}`;
    if (!this._exists(`${arrayPath}/.zarray`)) {
      throw new Error(`${label} is not a dense array in this store`);
    }
    const meta = await this._readCurrentAnnDataArrayMeta(arrayPath, label, 'array');
    this._assertGeneration(generation, `reading ${label}`);
    const dtypeInfo = validateZarrArrayMetadata(meta, label);
    if (!isAnnDataNumericValueKind(annDataValueKind(dtypeInfo))) {
      throw new Error(`${label} must use a numeric dtype`);
    }
    if (meta.shape.length !== 1 && meta.shape.length !== 2) {
      throw new Error(`${label} must be a one- or two-dimensional array`);
    }
    const nRows = meta.shape[0];
    if (nRows !== this._nObs) {
      throw new Error(
        `${label} has ${nRows} rows but the dataset has ${this._nObs} cells`
      );
    }
    const width = meta.shape.length === 1 ? 1 : meta.shape[1];
    return { label, arrayPath, meta, dtypeInfo, nRows, width };
  }

  /**
   * Every row of `obsm[key]`, every column, in row order, one chunk row at a
   * time, so the array is never held whole: `visit(block, rowStart, rowEnd)`
   * receives row-major values (numbers, or BigInts for 64-bit integers) and
   * runs synchronously. The column chunks of one chunk row are decoded
   * together.
   *
   * @param {string} key
   * @param {(block: ArrayLike<number|bigint>, rowStart: number, rowEnd: number) => void} visit
   * @returns {Promise<number>} The array's width
   */
  async forEachObsmRowSlab(key, visit) {
    this._ensureOpen();
    const generation = this._generation;
    const { label, arrayPath, meta, dtypeInfo, nRows, width } =
      await this._obsmArrayMeta(key, generation);
    const fill = normalizeFillValue(meta.fill_value, dtypeInfo);
    if (meta.shape.length === 1) {
      this._requireDefinedAbsentChunkFill(arrayPath, meta, fill);
      const chunk = meta.chunks[0];
      for (let rowStart = 0; rowStart < nRows; rowStart += chunk) {
        const rowEnd = Math.min(nRows, rowStart + chunk);
        const block = await this._readRange1D(
          arrayPath, meta, dtypeInfo, fill, rowStart, rowEnd, generation
        );
        this._assertGeneration(generation, `reading ${label}`);
        visit(block, rowStart, rowEnd);
      }
      return width;
    }
    const [chunkRows, chunkCols] = meta.chunks;
    const chunkElementCount = chunkRows * chunkCols;
    const isFortran = meta.order === 'F';
    const nColumnChunks = Math.ceil(width / chunkCols);
    const columnChunks = Array.from({ length: nColumnChunks }, (_, index) => index);
    for (let chunkRow = 0; chunkRow * chunkRows < nRows; chunkRow++) {
      const rowStart = chunkRow * chunkRows;
      const rowEnd = Math.min(rowStart + chunkRows, nRows);
      const blockRows = rowEnd - rowStart;
      const block = allocateTypedArray(
        dtypeInfo.ArrayType ?? Float64Array,
        blockRows * width,
        label
      );
      await forEachInPool(columnChunks, CHUNKS_IN_FLIGHT, async columnChunk => {
        const chunkData = await this._readDecodedChunk(
          arrayPath, meta, dtypeInfo, [chunkRow, columnChunk], chunkElementCount
        );
        this._assertGeneration(generation, `reading ${label}`);
        if (chunkData === null && fill === null) {
          throw new Error(
            `${label} has an absent chunk while fill_value is null, so its contents are undefined`
          );
        }
        const columnStart = columnChunk * chunkCols;
        const columnEnd = Math.min(width, columnStart + chunkCols);
        for (let row = 0; row < blockRows; row++) {
          for (let column = columnStart; column < columnEnd; column++) {
            const columnInChunk = column - columnStart;
            block[row * width + column] = chunkData === null
              ? fill
              : chunkData[
                isFortran
                  ? columnInChunk * chunkRows + row
                  : row * chunkCols + columnInChunk
              ];
          }
        }
      });
      visit(block, rowStart, rowEnd);
    }
    return width;
  }

  async readObsmColumns(key, columns) {
    this._ensureOpen();
    const generation = this._generation;
    const { label, arrayPath, meta, dtypeInfo, nRows, width } =
      await this._obsmArrayMeta(key, generation);
    const selected = requireObsmColumnSelection(columns, width, label);
    const nColumns = selected.length;
    const result = allocateTypedArray(Float64Array, nRows * nColumns, label);
    const toNumber = value => (typeof value === 'bigint' ? Number(value) : value);
    if (meta.shape.length === 1) {
      const { data } = await this._readArray(arrayPath);
      this._assertGeneration(generation, `reading ${label}`);
      for (let row = 0; row < nRows; row++) result[row] = toNumber(data[row]);
      return result;
    }

    const fill = normalizeFillValue(meta.fill_value, dtypeInfo);
    const [chunkRows, chunkCols] = meta.chunks;
    const chunkElementCount = chunkRows * chunkCols;
    const dimensionSeparator = meta.dimension_separator ?? '.';
    const isFortran = meta.order === 'F';
    const columnChunks = [...new Set(selected.map(column => Math.floor(column / chunkCols)))];
    const work = [];
    for (let chunkRow = 0; chunkRow * chunkRows < nRows; chunkRow++) {
      for (const columnChunk of columnChunks) work.push([chunkRow, columnChunk]);
    }
    await forEachInPool(work, CHUNKS_IN_FLIGHT, async ([chunkRow, columnChunk]) => {
      const rowStart = chunkRow * chunkRows;
      const rowEnd = Math.min(rowStart + chunkRows, nRows);
      {
        const chunkPath =
          `${arrayPath}/${zarrChunkKey([chunkRow, columnChunk], dimensionSeparator)}`;
        let chunkData = null;
        if (this._exists(chunkPath)) {
          const encoded = await this._readChunkFile(chunkPath);
          const decoded = await decodeZarrChunk(encoded, meta, dtypeInfo, chunkElementCount);
          this._assertGeneration(generation, `reading ${label}`);
          chunkData = typedArrayFromChunk(decoded, dtypeInfo);
        } else if (fill === null) {
          throw new Error(
            `${label} has an absent chunk while fill_value is null, so its contents are undefined`
          );
        }
        selected.forEach((column, outputColumn) => {
          if (Math.floor(column / chunkCols) !== columnChunk) return;
          const columnInChunk = column - columnChunk * chunkCols;
          for (let row = rowStart; row < rowEnd; row++) {
            const rowInChunk = row - rowStart;
            const value = chunkData === null
              ? fill
              : chunkData[
                isFortran
                  ? columnInChunk * chunkRows + rowInChunk
                  : rowInChunk * chunkCols + columnInChunk
              ];
            result[row * nColumns + outputColumn] = toNumber(value);
          }
        });
      }
    });
    this._assertGeneration(generation, `reading ${label}`);
    return result;
  }

  /**
   * The gene names of one var axis, as stored: the var index, or the values
   * of one var column as text (null where a value is missing), together with
   * the index that names the genes a column leaves empty. `axis` is `X` (shared by `X` and
   * every layer) or `raw`. Nothing is made unique here; the adapter applies
   * `makeUniqueNames`.
   *
   * @param {'X'|'raw'} axis
   * @param {string|null} column - A var column, or null for the index.
   * @returns {Promise<{index: string[], values: Array<string|null>}>}
   */
  async readVarNames(axis, column) {
    this._ensureOpen();
    const generation = this._generation;
    const cacheKey = `var_names:${axis}:${column === null ? '' : `column:${column}`}`;
    if (this._cache.has(cacheKey)) return this._cache.get(cacheKey);
    let frame;
    let label;
    let index;
    if (axis === 'X') {
      frame = 'var';
      label = 'var';
      index = this._varNames;
    } else if (axis === 'raw') {
      frame = 'raw/var';
      label = 'raw.var';
      const { nVars } = await this._requireMatrixElement('raw/X');
      if (!this._exists('raw/var/.zattrs')) {
        throw new Error('This file has no raw var axis');
      }
      const attrs = await this._readJson('raw/var/.zattrs');
      const indexKey = attrs?.['_index'];
      if (typeof indexKey !== 'string' || indexKey.length === 0) {
        throw new Error('AnnData raw.var must declare its _index');
      }
      const rawIndex = await this._readDataFrameIndex(`raw/var/${indexKey}`, 'AnnData raw.var index', true);
      if (rawIndex.length !== nVars) {
        throw new Error(`raw.var holds ${rawIndex.length} names, but raw.X has ${nVars} genes`);
      }
      index = rawIndex.values;
    } else {
      throw new TypeError(`Unknown var axis '${String(axis)}'`);
    }
    const values = column === null
      ? index
      : await this._readGeneNameColumn(`${frame}/${column}`, column, `${label}['${column}']`, index.length);
    this._assertGeneration(generation, `reading the gene names of ${label}`);
    const result = Object.freeze({ index, values });
    this._cache.set(cacheKey, result);
    return result;
  }

  /**
   * Read one dataframe column as gene-name text (`gene-names.js`): strings,
   * categories and integers name genes; a missing value is null.
   *
   * @param {string} fieldPath
   * @param {string} key
   * @param {string} label
   * @param {number} nRows
   * @returns {Promise<Array<string|null>>}
   * @private
   */
  async _readGeneNameColumn(fieldPath, key, label, nRows) {
    const attrs = await this._readAnnDataElementAttrs(fieldPath, label);
    if (attrs === null) {
      throw new Error(`${label} was not found`);
    }
    const encoding = attrs['encoding-type'];
    if (encoding === 'categorical') {
      await this._readCurrentCategoricalAttrs(fieldPath, label);
      const contract = await this._readCategoricalCategoriesContract(fieldPath, key);
      const isFloat = contract.kind === 'array' && annDataValueKind(contract.categoriesInfo) === 'float';
      const categories = (await this._readCategoricalCategories(fieldPath, key, contract))
        .map(category => geneNameText(category, { isFloat }));
      const codesMeta = await this._readCurrentAnnDataArrayMeta(
        `${fieldPath}/codes`,
        `Categorical codes for '${key}'`,
        'array'
      );
      validateCategoricalCodesMeta(codesMeta, key, nRows);
      const { data } = await this._readArray(`${fieldPath}/codes`);
      const codes = toCategoricalCodes(data, categories.length);
      return Array.from(codes, code => (code < 0 ? null : categories[code]));
    }
    if (encoding === 'nullable-string-array' || encoding === 'nullable-integer') {
      await this._readNullableObsContract(fieldPath, key, encoding, nRows, 'genes');
      const { data: rawValues } = await this._readArray(`${fieldPath}/values`);
      const { data: mask } = await this._readArray(`${fieldPath}/mask`);
      return Array.from(rawValues, (value, row) => (mask[row] ? null : geneNameText(
        encoding === 'nullable-string-array' ? String(value) : value
      )));
    }
    if (encoding !== 'array' && encoding !== 'string-array') {
      throw new Error(`${label} cannot name genes`);
    }
    const meta = await this._readCurrentAnnDataArrayMeta(fieldPath, label);
    const info = validateOneDimensionalArrayMeta(meta, label, nRows);
    const kind = annDataValueKind(info);
    if (kind !== 'string' && kind !== 'int' && kind !== 'uint') {
      throw new Error(`${label} cannot name genes: its values are ${kind}`);
    }
    const { data } = await this._readArray(fieldPath);
    return Array.from(data, value => geneNameText(kind === 'string' ? String(value) : value));
  }

  /**
   * The Zarr path, label and gene count of one expression matrix: `X`,
   * `layers/<name>` or `raw/X`, and whether it is stored sparse.
   *
   * @param {string} element
   * @returns {Promise<{path: string, label: string, sparse: boolean, nVars: number}>}
   * @private
   */
  async _requireMatrixElement(element) {
    let path;
    let label;
    if (element === 'X' || element === 'raw/X') {
      path = element;
      label = element === 'X' ? 'X' : 'raw.X';
    } else if (typeof element === 'string' && element.startsWith('layers/')) {
      const name = element.slice('layers/'.length);
      if (name.length === 0 || name.includes('/')) {
        throw new Error(`This file has no layer '${name}'`);
      }
      path = element;
      label = `layers['${name}']`;
    } else {
      throw new TypeError(`Unknown expression matrix '${String(element)}'`);
    }
    const dense = this._exists(`${path}/.zarray`);
    const sparse = !dense && (this._exists(`${path}/.zgroup`) || this._exists(`${path}/data/.zarray`));
    if (!dense && !sparse) {
      throw new Error(`This file has no ${label} expression matrix`);
    }
    let shape;
    if (dense) {
      const meta = await this._readCurrentAnnDataArrayMeta(path, `Dense ${label}`, 'array');
      shape = meta.shape;
    } else {
      shape = (await this._readSparseMetadataContract(path)).shape;
    }
    if (!Array.isArray(shape) || shape.length !== 2 || shape[0] !== this._nObs) {
      throw new Error(`${label} must hold one row per cell (${this._nObs})`);
    }
    if (element !== 'raw/X' && shape[1] !== this._nVars) {
      throw new Error(`${label} must hold one column per gene (${this._nVars})`);
    }
    return { path, label, sparse, nVars: shape[1] };
  }

  /**
   * Read one column of one expression matrix -- one gene's value in every
   * cell -- as float32. `element` is `X`, `layers/<name>` or `raw/X`; `index`
   * is the gene's position on that matrix's var axis.
   *
   * Only what one gene needs is read: a CSC matrix reads that gene's
   * entries; a dense matrix reads the chunk strip holding it; a CSR matrix,
   * or a dense one whose chunks span many genes, is indexed once by gene in
   * the background. One matrix is resident at a time.
   *
   * @param {string} element
   * @param {number} index
   * @returns {Promise<Float32Array>}
   */
  async getMatrixColumn(element, index) {
    this._ensureOpen();
    const generation = this._generation;
    const matrix = await this._requireMatrixElement(element);
    this._assertGeneration(generation, `opening ${element}`);
    if (!Number.isSafeInteger(index) || index < 0 || index >= matrix.nVars) {
      throw new RangeError(`${matrix.label} has no gene column ${String(index)}`);
    }
    const columns = await this._matrixColumns(element, matrix, generation);
    const result = await columns.column(index, generation);
    this._assertGeneration(
      generation,
      `loading gene column ${index} of ${matrix.label}`
    );
    return result;
  }

  /**
   * Start indexing one expression matrix by gene in the background when its
   * layout needs it, so the first gene shown does not wait for a whole
   * index. Returns at once; a failure reaches the gene reads.
   *
   * @param {string} element
   */
  prepareMatrix(element) {
    this._ensureOpen();
    const generation = this._generation;
    this._requireMatrixElement(element)
      .then(matrix => this._matrixColumns(element, matrix, generation))
      .then(columns => columns.prepare?.())
      .catch(() => {});
  }

  /**
   * The column access of one matrix, opened once and shared. Opening
   * another matrix releases the previous one.
   * @private
   */
  async _matrixColumns(element, matrix, generation) {
    if (this._matrix?.element !== element) {
      this._releaseMatrix();
      this._matrix = { element, columns: null, loadPromise: null };
    }
    const state = this._matrix;
    if (state.columns) return state.columns;
    state.loadPromise ??= this._openMatrixColumns(matrix, generation);
    const loadPromise = state.loadPromise;
    let columns;
    try {
      columns = await loadPromise;
    } finally {
      if (state.loadPromise === loadPromise) state.loadPromise = null;
    }
    this._assertGeneration(generation, `loading ${matrix.label}`);
    if (this._matrix !== state) {
      // Another matrix was asked for while this one opened: this read is
      // still answered, then the columns are let go.
      return {
        column: async (index, columnGeneration) => {
          try {
            return await columns.column(index, columnGeneration);
          } finally {
            (columns.retire ?? columns.dispose)?.();
          }
        },
      };
    }
    if (state.columns === null) {
      // A failed read is not kept: the next read of this matrix starts over.
      state.columns = {
        ...columns,
        column: async (index, columnGeneration) => {
          try {
            return await columns.column(index, columnGeneration);
          } catch (error) {
            if (this._matrix === state && state.columns?.source === columns) {
              state.columns = null;
              columns.dispose?.();
            }
            throw error;
          }
        },
        source: columns,
      };
    } else if (state.columns.source !== columns) {
      columns.dispose?.();
    }
    return state.columns;
  }

  /** Release the resident matrix and any index it holds. @private */
  _releaseMatrix() {
    const state = this._matrix;
    this._matrix = null;
    // Reads already under way are answered; nothing new reaches it.
    if (state?.columns) (state.columns.retire ?? state.columns.dispose)?.();
    this._decodedXBlocks.clear();
  }

  /**
   * How the columns of one matrix are read.
   * @private
   */
  async _openMatrixColumns(matrix, generation) {
    const { path, label } = matrix;
    const nObs = this._nObs;
    const indexOptions = {
      nRows: nObs,
      nCols: matrix.nVars,
      storeFactory: this.columnStoreFactory,
      // Pass 1's indices are kept for pass 2 within an eighth of the index
      // budget, saving one read of them.
      retainIndicesBytes: residencyBudgetBytes('columnIndex') / 8,
      yieldControl: yieldToMacrotask,
      onProgress: event => this.onProgress?.(event),
      label,
    };
    const fromIndex = index => ({
      column: gene => index.column(gene),
      prepare: () => index.start(),
      retire: () => index.retire(),
      dispose: () => index.dispose(),
    });

    if (matrix.sparse) {
      const sparse = await this._readSparseMetadataContract(path);
      if (sparse.shape[0] !== nObs) {
        throw new Error(
          `Sparse ${label} row dimension ${sparse.shape[0]} does not match obs dimension ${nObs}`
        );
      }
      const readValues = await this._rangeReader(`${path}/data`, { asFloat32: true });
      const readIndices = await this._rangeReader(`${path}/indices`);
      const readPointers = await this._rangeReader(`${path}/indptr`);
      this._assertGeneration(generation, `opening ${label}`);
      if (sparse.format === 'csc') {
        // Column pointers once; each gene then reads only its own entries.
        const raw = await readPointers(0, matrix.nVars + 1);
        const pointers = Float64Array.from(raw);
        if (pointers[0] !== 0) throw new Error('Sparse indptr must start at zero');
        for (let i = 1; i < pointers.length; i++) {
          if (!(pointers[i] >= pointers[i - 1])) throw new Error('Sparse indptr must be monotonic');
        }
        if (pointers[matrix.nVars] !== sparse.dataLength) {
          throw new Error(
            `Sparse indptr last value must equal the non-zero count (${sparse.dataLength})`
          );
        }
        return {
          column: async gene => {
            const start = pointers[gene];
            const end = pointers[gene + 1];
            const result = new Float32Array(nObs);
            if (end === start) return result;
            const [rows, values] = await Promise.all([
              readIndices(start, end),
              readValues(start, end),
            ]);
            for (let entry = 0; entry < rows.length; entry++) {
              const row = rows[entry];
              if (!(row >= 0 && row < nObs) || !Number.isInteger(row)) {
                throw new RangeError(
                  `Sparse column row index ${row} at entry ${start + entry} is outside its ` +
                  `${nObs}-row shape`
                );
              }
              result[row] = addFloat32(result[row], values[entry], `Sparse ${label} column`);
            }
            return result;
          },
        };
      }
      return fromIndex(new RowMajorColumnIndex({
        ...indexOptions,
        label: `Sparse ${label}`,
        layout: 'sparse',
        nnz: sparse.dataLength,
        readRowPointers: readPointers,
        readIndices,
        readValues,
      }));
    }

    const meta = await this._readCurrentAnnDataArrayMeta(path, `Dense ${label}`, 'array');
    this._assertGeneration(generation, `loading dense ${label} metadata`);
    const dtypeInfo = validateDenseColumnContract(meta);
    const [nRows, nCols] = meta.shape;
    const [chunkRows, chunkCols] = meta.chunks;
    const fill = normalizeFillValue(meta.fill_value, dtypeInfo);
    this._requireDefinedAbsentChunkFill(path, meta, fill);
    const stripBytes = nRows * Math.min(chunkCols, nCols) * 4;
    if (stripBytes <= this._decodedXBlocks.capacityBytes) {
      // Narrow chunks: each gene decodes its chunk strip, shared with the
      // other genes of that strip through the decoded-block cache.
      return { column: gene => this._readDenseStripColumn(path, label, meta, dtypeInfo, fill, gene) };
    }
    // Chunks spanning many genes: a strip does not fit the block cache, so
    // every gene would decode the whole matrix again. Index it once.
    const chunkElementCount = chunkRows * chunkCols;
    return fromIndex(new RowMajorColumnIndex({
      ...indexOptions,
      label: `Dense ${label}`,
      layout: 'dense',
      slabEntries: Math.max(nCols * chunkRows, 1),
      readRows: async (rowStart, rowEnd) => {
        const block = allocateTypedArray(Float32Array, (rowEnd - rowStart) * nCols, `Dense ${label}`);
        block.fill(numericValueToFloat32(fill, `Dense ${label}`));
        const firstChunkRow = Math.floor(rowStart / chunkRows);
        const lastChunkRow = Math.floor((rowEnd - 1) / chunkRows);
        const work = [];
        for (let cr = firstChunkRow; cr <= lastChunkRow; cr++) {
          for (let cc = 0; cc < Math.ceil(nCols / chunkCols); cc++) work.push([cr, cc]);
        }
        await forEachInPool(work, CHUNKS_IN_FLIGHT, async ([cr, cc]) => {
          const chunk = await this._readDecodedChunk(path, meta, dtypeInfo, [cr, cc], chunkElementCount);
          if (chunk === null) return;
          const r0 = Math.max(rowStart, cr * chunkRows);
          const r1 = Math.min(rowEnd, (cr + 1) * chunkRows);
          const c0 = cc * chunkCols;
          const c1 = Math.min(nCols, c0 + chunkCols);
          for (let row = r0; row < r1; row++) {
            for (let column = c0; column < c1; column++) {
              const source = meta.order === 'F'
                ? (column - c0) * chunkRows + (row - cr * chunkRows)
                : (row - cr * chunkRows) * chunkCols + (column - c0);
              block[(row - rowStart) * nCols + column] =
                numericValueToFloat32(chunk[source], `Dense ${label}`);
            }
          }
        });
        return block;
      },
    }));
  }

  /**
   * One column of a dense matrix read from its chunk strip.
   * @private
   */
  async _readDenseStripColumn(path, label, meta, dtypeInfo, fill, colIdx) {
    const generation = this._generation;
    const [nRows] = meta.shape;
    const [chunkRows, chunkCols] = meta.chunks;
    const colChunk = Math.floor(colIdx / chunkCols);
    const colInChunk = colIdx - colChunk * chunkCols;
    const out = new Float32Array(nRows);
    out.fill(numericValueToFloat32(fill, `Dense ${label}`));
    const isFortran = meta.order === 'F';
    const chunkElementCount = chunkRows * chunkCols;
    const stripKey = `${path}/${colChunk}`;
    const chunkRowsIndex = [];
    for (let cr = 0; cr < Math.ceil(nRows / chunkRows); cr++) chunkRowsIndex.push(cr);
    await forEachInPool(chunkRowsIndex, CHUNKS_IN_FLIGHT, async cr => {
      const chunkPath = `${path}/${zarrChunkKey([cr, colChunk], meta.dimension_separator ?? '.')}`;
      if (!this._exists(chunkPath)) return;
      // Every chunk of this strip also holds the strip's other genes.
      const chunkData = await this._decodedXBlocks.read(
        chunkPath,
        stripKey,
        () => this._readDecodedChunk(path, meta, dtypeInfo, [cr, colChunk], chunkElementCount)
      );
      this._assertGeneration(generation, `loading dense ${label} column`);
      const rowStart = cr * chunkRows;
      const rowEnd = Math.min(rowStart + chunkRows, nRows);
      for (let r = rowStart; r < rowEnd; r++) {
        const chunkR = r - rowStart;
        const srcIdx = isFortran
          ? colInChunk * chunkRows + chunkR
          : chunkR * chunkCols + colInChunk;
        out[r] = numericValueToFloat32(chunkData[srcIdx], `Dense ${label}`);
      }
    });
    this._assertGeneration(generation, `loading dense ${label} column`);
    return out;
  }

  /**
   * Read and validate sparse matrix metadata without materializing components.
   * @private
   */
  async _readSparseMetadataContract(groupPath) {
    await this._readCurrentZarrGroup(
      groupPath,
      `Sparse matrix at '${groupPath}'`
    );
    const attrsPath = `${groupPath}/.zattrs`;
    if (!this._exists(attrsPath)) {
      throw new Error(
        `Sparse matrix at '${groupPath}' .zattrs metadata is required`
      );
    }
    const attrs = await this._readJson(attrsPath);
    if (attrs === null ||
        typeof attrs !== 'object' ||
        Array.isArray(attrs)) {
      throw new Error(
        `Sparse matrix at '${groupPath}' .zattrs must contain a JSON object`
      );
    }
    const encodingType = attrs['encoding-type'];
    let format;
    if (encodingType === 'csr_matrix') {
      format = 'csr';
    } else if (encodingType === 'csc_matrix') {
      format = 'csc';
    } else {
      throw new Error(
        `Sparse encoding-type is required and must be 'csr_matrix' or 'csc_matrix' at '${groupPath}'`
      );
    }
    requireCurrentZarrEncoding(
      attrs,
      encodingType,
      '0.1.0',
      `Sparse matrix at '${groupPath}'`
    );

    if (!Object.prototype.hasOwnProperty.call(attrs, 'shape')) {
      throw new Error(`Sparse shape metadata is required at '${groupPath}'`);
    }
    let shape = attrs['shape'];
    if (!Array.isArray(shape) || shape.length !== 2) {
      throw new Error('Sparse matrix shape must contain exactly two dimensions');
    }
    shape = shape.map(Number);
    if (shape.some(dimension => !Number.isSafeInteger(dimension) || dimension < 0)) {
      throw new Error('Sparse matrix shape dimensions must be non-negative safe integers');
    }

    // Sparse components are raw Zarr storage members whose identity is owned
    // by the exact csr/csc parent encoding. They are not standalone AnnData
    // elements and current writers do not attach child encoding attributes.
    const [dataMeta, indicesMeta, indptrMeta] = await Promise.all([
      this._readArrayMeta(`${groupPath}/data`),
      this._readArrayMeta(`${groupPath}/indices`),
      this._readArrayMeta(`${groupPath}/indptr`)
    ]);
    const dtypeContract = validateSparseArrayContract({
      format,
      shape,
      dataMeta,
      indicesMeta,
      indptrMeta,
    });
    return {
      encodingType,
      format,
      shape,
      dataMeta,
      indicesMeta,
      indptrMeta,
      ...dtypeContract
    };
  }

  /**
   * Read a whole sparse matrix (a neighbour graph); every component is read
   * through the chunk pool and checked as it is read.
   * @private
   */
  async _readSparseMatrix(groupPath, dataMode) {
    if (dataMode !== 'float32' && dataMode !== 'exact') {
      throw new TypeError(
        `Sparse matrix data mode must be exactly "float32" or "exact"`
      );
    }
    const { format, shape, dataLength } =
      await this._readSparseMetadataContract(groupPath);
    const [dataArr, indicesArr, indptrArr] = await Promise.all([
      this._readArray(`${groupPath}/data`).then(result => result.data),
      this._readArray(`${groupPath}/indices`).then(result => result.data),
      this._readArray(`${groupPath}/indptr`).then(result => result.data),
    ]);
    const data = dataMode === 'exact'
      ? dataArr
      : numericArrayToFloat32(dataArr, 'Sparse data');
    const indices = toSparseInt32Array(indicesArr, 'index');
    // Pointers are exact up to 2^53: Int32 while the non-zero count fits.
    const indptr = dataLength <= 0x7fffffff
      ? toSparseInt32Array(indptrArr, 'indptr')
      : Float64Array.from(indptrArr, value => numericValueToNumber(value, 'Sparse indptr'));

    const indexAxis = format === 'csr' ? shape[1] : shape[0];
    if (indptr[0] !== 0) {
      throw new Error('Sparse indptr must start at zero');
    }
    for (let index = 1; index < indptr.length; index++) {
      if (indptr[index] < indptr[index - 1]) {
        throw new Error('Sparse indptr must be monotonic');
      }
    }
    if (indptr[indptr.length - 1] !== data.length) {
      throw new Error(
        `Sparse indptr last value must equal the non-zero count (${data.length})`
      );
    }
    for (let index = 0; index < indices.length; index++) {
      if (indices[index] >= indexAxis) {
        throw new Error(
          `Sparse index ${indices[index]} is outside axis bounds [0, ${indexAxis})`
        );
      }
    }
    return { data, indices, indptr, shape, format, cscData: null };
  }

  async _readNullableObsContract(
    fieldPath,
    key,
    encodingType,
    expectedLength = this._nObs,
    expectedAxis = 'cells'
  ) {
    await this._readCurrentAnnDataGroupAttrs(
      fieldPath,
      `Nullable field '${key}'`,
      encodingType,
      '0.1.0',
    );
    const [valuesMeta, maskMeta] = await Promise.all([
      this._readCurrentAnnDataArrayMeta(
        `${fieldPath}/values`,
        `Nullable values for '${key}'`,
        encodingType === 'nullable-string-array'
          ? 'string-array'
          : 'array'
      ),
      this._readCurrentAnnDataArrayMeta(
        `${fieldPath}/mask`,
        `Nullable mask for '${key}'`,
        'array'
      )
    ]);
    const valuesInfo = validateOneDimensionalArrayMeta(
      valuesMeta,
      `Nullable values for '${key}'`,
      expectedLength,
      expectedAxis
    );
    const maskInfo = validateOneDimensionalArrayMeta(
      maskMeta,
      `Nullable mask for '${key}'`,
      expectedLength ?? valuesMeta.shape[0],
      expectedAxis
    );
    if (maskInfo.kind !== 'boolean') {
      throw new Error(`Nullable mask for '${key}' must use a boolean dtype`);
    }
    if (encodingType === 'nullable-boolean') {
      if (valuesInfo.kind !== 'boolean') {
        throw new Error(`Nullable boolean values for '${key}' must use a boolean dtype`);
      }
    } else if (encodingType === 'nullable-string-array') {
      if (valuesInfo.category !== 'object' &&
          valuesInfo.category !== 'fixed-string') {
        throw new Error(`Nullable string values for '${key}' must use a string dtype`);
      }
    } else if (
      valuesInfo.kind !== 'integer' &&
      valuesInfo.kind !== 'bigint'
    ) {
      throw new Error(`Nullable integer values for '${key}' must use an integer dtype`);
    }
    validateNullableLengths(valuesMeta, maskMeta, `Field '${key}'`);
    return { valuesMeta, maskMeta, valuesInfo, maskInfo };
  }

  async _readCategoricalCategoriesContract(fieldPath, key) {
    const categoriesPath = `${fieldPath}/categories`;
    if (this._exists(`${categoriesPath}/.zarray`)) {
      const categoriesMeta =
        await this._readCurrentAnnDataArrayMeta(
          categoriesPath,
          `Categorical categories for '${key}'`
        );
      const categoriesInfo = validateOneDimensionalArrayMeta(
        categoriesMeta,
        `Categorical categories for '${key}'`
      );
      const categoryCount = validateCellucidCategoryCount(
        categoriesMeta.shape[0],
        key
      );
      return {
        kind: 'array',
        categoriesPath,
        categoriesMeta,
        categoriesInfo,
        categoryCount
      };
    }

    const categoriesAttrs = await this._readAttrs(categoriesPath);
    requireCurrentZarrEncoding(
      categoriesAttrs,
      'nullable-string-array',
      '0.1.0',
      `Categorical categories for '${key}'`
    );
    const nullableContract = await this._readNullableObsContract(
      categoriesPath,
      `${key}' categories`,
      'nullable-string-array',
      null
    );
    const categoryCount = validateCellucidCategoryCount(
      nullableContract.valuesMeta.shape[0],
      key
    );
    return {
      kind: 'nullable-string-array',
      categoriesPath,
      categoryCount,
      nullableContract
    };
  }

  async _readCategoricalCategories(fieldPath, key, contract = null) {
    const categoryContract =
      contract ?? await this._readCategoricalCategoriesContract(fieldPath, key);
    const { categoriesPath } = categoryContract;
    if (categoryContract.kind === 'array') {
      const { data } = await this._readArray(categoriesPath);
      return validateUniqueZarrCategories(
        normalizeCategoricalCategories(
          data,
          categoryContract.categoriesInfo,
          `Categorical categories for '${key}'`
        ),
        key
      );
    }

    const { data: rawValues } =
      await this._readArray(`${categoriesPath}/values`);
    const { data: mask } =
      await this._readArray(`${categoriesPath}/mask`);
    const categories = new Array(rawValues.length);
    for (let index = 0; index < rawValues.length; index++) {
      if (mask[index]) {
        throw new Error(`Categorical categories for '${key}' cannot contain missing labels`);
      }
      categories[index] = String(rawValues[index]);
    }
    return validateUniqueZarrCategories(categories, key);
  }

  /**
   * Inspect one dataframe field using metadata only. In particular this does
   * not decode category labels, allowing schema validation and dataset-stat
   * counting to remain bounded before any public field materialization.
   *
   * @param {'obs'|'var'} axis
   * @param {string} key
   * @param {number} expectedLength
   * @returns {Promise<{dtype: string, categoryCount?: number}>}
   * @private
   */
  async _getDataFrameFieldTypeInfo(axis, key, expectedLength) {
    this._ensureOpen();
    const generation = this._generation;
    const cacheKey = `${axis}_type:${key}`;
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey);
    }

    const fieldPath = `${axis}/${key}`;
    const axisLabel = axis === 'obs' ? 'Observation' : 'Variable';
    const expectedAxis = axis === 'obs' ? 'cells' : 'variables';
    const fieldLabel = `${axisLabel} field '${key}'`;
    const attrs = await this._readAnnDataElementAttrs(
      fieldPath,
      fieldLabel
    );
    this._assertGeneration(
      generation,
      `reading ${axis} dataframe field '${key}'`
    );
    if (attrs === null) {
      const result = { dtype: 'unknown' };
      this._cache.set(cacheKey, result);
      return result;
    }
    const encodingType = attrs['encoding-type'];
    let result;

    if (encodingType === 'categorical') {
      const { ordered } = await this._readCurrentCategoricalAttrs(
        fieldPath,
        fieldLabel
      );
      const codesMeta = await this._readCurrentAnnDataArrayMeta(
        `${fieldPath}/codes`,
        `Categorical codes for '${key}'`,
        'array'
      );
      validateCategoricalCodesMeta(
        codesMeta,
        key,
        expectedLength,
        expectedAxis
      );
      const categoryContract =
        await this._readCategoricalCategoriesContract(fieldPath, key);
      validateCellucidCategoryCount(categoryContract.categoryCount, key);
      result = {
        dtype: 'categorical',
        categoryCount: categoryContract.categoryCount,
        ordered
      };
    } else if (
      encodingType === 'nullable-integer' ||
      encodingType === 'nullable-boolean' ||
      encodingType === 'nullable-string-array'
    ) {
      const { valuesInfo } = await this._readNullableObsContract(
        fieldPath,
        key,
        encodingType,
        expectedLength,
        expectedAxis
      );
      result = {
        dtype: encodingType === 'nullable-boolean'
          ? 'bool'
          : (encodingType === 'nullable-string-array'
              ? 'string'
              : annDataValueKind(valuesInfo))
      };
    } else if (
      encodingType === 'array' ||
      encodingType === 'string-array'
    ) {
      const meta = await this._readCurrentAnnDataArrayMeta(
        fieldPath,
        `${axisLabel} field '${key}'`
      );
      const dtypeInfo = validateOneDimensionalArrayMeta(
        meta,
        `${axisLabel} field '${key}'`,
        expectedLength,
        expectedAxis
      );
      result = { dtype: annDataValueKind(dtypeInfo) };
    } else {
      throw new Error(
        `${axisLabel} field '${key}' encoding-type is missing or unsupported`
      );
    }

    this._assertGeneration(
      generation,
      `reading ${axis} dataframe field type '${key}'`
    );
    this._cache.set(cacheKey, result);
    return result;
  }

  /**
   * Inspect one observation field using metadata only.
   *
   * @param {string} key
   * @returns {Promise<{dtype: string, categoryCount?: number}>}
   * @private
   */
  async _getObsFieldTypeInfo(key) {
    return this._getDataFrameFieldTypeInfo('obs', key, this._nObs);
  }

  /**
   * Get obs field info (metadata only)
   * @param {string} key - Field name
   * @returns {Promise<{dtype: string, categories?: (string|number|boolean)[]}>}
   */
  async getObsFieldInfo(key) {
    this._ensureOpen();
    const generation = this._generation;

    const cacheKey = `obs_info:${key}`;
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey);
    }

    const fieldPath = `obs/${key}`;
    const fieldLabel = `Observation field '${key}'`;
    const attrs = await this._readAnnDataElementAttrs(
      fieldPath,
      fieldLabel
    );
    this._assertGeneration(generation, `reading observation field '${key}'`);
    if (attrs === null) {
      throw new Error(`Observation field '${key}' was not found`);
    }
    let result;

    const encodingType = attrs['encoding-type'];

    if (encodingType === 'categorical') {
      const { ordered } = await this._readCurrentCategoricalAttrs(
        fieldPath,
        fieldLabel
      );
      const codesMeta = await this._readCurrentAnnDataArrayMeta(
        `${fieldPath}/codes`,
        `Categorical codes for '${key}'`,
        'array'
      );
      validateCategoricalCodesMeta(codesMeta, key, this._nObs);
      const categoryContract =
        await this._readCategoricalCategoriesContract(fieldPath, key);
      validateCellucidCategoryCount(categoryContract.categoryCount, key);
      const categories = await this._readCategoricalCategories(
        fieldPath,
        key,
        categoryContract
      );
      validateCellucidCategoryCount(categories.length, key);
      result = {
        dtype: 'categorical',
        categories,
        ordered
      };
    } else if (
      encodingType === 'nullable-integer' ||
      encodingType === 'nullable-boolean' ||
      encodingType === 'nullable-string-array'
    ) {
      const { valuesInfo } = await this._readNullableObsContract(
        fieldPath,
        key,
        encodingType
      );
      result = {
        dtype: encodingType === 'nullable-boolean'
          ? 'bool'
          : (encodingType === 'nullable-string-array'
              ? 'string'
              : annDataValueKind(valuesInfo))
      };
    } else if (
      encodingType === 'array' ||
      encodingType === 'string-array'
    ) {
      const meta = await this._readCurrentAnnDataArrayMeta(
        fieldPath,
        `Observation field '${key}'`
      );
      const dtypeInfo = validateOneDimensionalArrayMeta(
        meta,
        `Observation field '${key}'`,
        this._nObs
      );
      result = { dtype: annDataValueKind(dtypeInfo) };
    } else {
      throw new Error(
        `Observation field '${key}' encoding-type is missing or unsupported`
      );
    }

    this._assertGeneration(
      generation,
      `reading observation field metadata '${key}'`
    );
    this._cache.set(cacheKey, result);
    return result;
  }

  /**
   * Get obs field values
   * @param {string} key - Field name
   * @returns {Promise<Object>}
   */
  async getObsField(key) {
    this._ensureOpen();
    const generation = this._generation;

    const cacheKey = `obs:${key}`;
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey);
    }

    const fieldPath = `obs/${key}`;
    const fieldLabel = `Observation field '${key}'`;
    const attrs = await this._readAnnDataElementAttrs(
      fieldPath,
      fieldLabel
    );
    this._assertGeneration(generation, `reading observation field '${key}'`);
    if (attrs === null) {
      throw new Error(`Observation field '${key}' was not found`);
    }
    let result;

    const encodingType = attrs['encoding-type'];

    if (encodingType === 'categorical') {
      const { ordered } = await this._readCurrentCategoricalAttrs(
        fieldPath,
        fieldLabel
      );
      const codesMeta = await this._readCurrentAnnDataArrayMeta(
        `${fieldPath}/codes`,
        `Categorical codes for '${key}'`,
        'array'
      );
      validateCategoricalCodesMeta(codesMeta, key, this._nObs);
      const cachedInfo = this._cache.get(`obs_info:${key}`);
      let categories;
      if (cachedInfo?.dtype === 'categorical' &&
          Array.isArray(cachedInfo.categories)) {
        categories = cachedInfo.categories;
      } else {
        const categoryContract =
          await this._readCategoricalCategoriesContract(fieldPath, key);
        validateCellucidCategoryCount(categoryContract.categoryCount, key);
        // Load the bounded category dictionary first. Its exact string storage
        // is then known before any potentially large code payload is requested.
        categories = await this._readCategoricalCategories(
          fieldPath,
          key,
          categoryContract
        );
      }
      validateCellucidCategoryCount(categories.length, key);
      const { data: codes } = await this._readArray(`${fieldPath}/codes`);

      result = {
        dtype: 'categorical',
        codes: toCategoricalCodes(codes, categories.length),
        categories,
        ordered,
        get values() {
          const computed = Array.from(this.codes, c => c >= 0 ? this.categories[c] : null);
          Object.defineProperty(this, 'values', { value: computed, writable: false });
          return computed;
        }
      };
    } else if (
      encodingType === 'nullable-integer' ||
      encodingType === 'nullable-boolean' ||
      encodingType === 'nullable-string-array'
    ) {
      const { valuesInfo } = await this._readNullableObsContract(
        fieldPath,
        key,
        encodingType
      );
      const { data: rawValues } =
        await this._readArray(`${fieldPath}/values`);
      const { data: mask } =
        await this._readArray(`${fieldPath}/mask`);
      if (encodingType === 'nullable-string-array') {
        result = {
          dtype: 'string',
          values: Array.from(
            rawValues,
            (value, index) => mask[index] ? null : String(value)
          )
        };
      } else if (encodingType === 'nullable-boolean') {
        const booleanMessage =
          `Nullable boolean values for '${key}' must contain only boolean values`;
        result = {
          dtype: 'bool',
          values: Array.from(
            rawValues,
            (value, index) => mask[index]
              ? null
              : decodeAnnDataBoolean(value, booleanMessage)
          )
        };
      } else {
        const values = new Float32Array(rawValues.length);
        for (let index = 0; index < values.length; index++) {
          values[index] = mask[index]
            ? Number.NaN
            : numericValueToFloat32(
                rawValues[index],
                `Observation field '${key}'`,
                true
              );
        }
        result = {
          dtype: annDataValueKind(valuesInfo),
          values
        };
      }
    } else if (
      encodingType === 'array' ||
      encodingType === 'string-array'
    ) {
      const meta = await this._readCurrentAnnDataArrayMeta(
        fieldPath,
        `Observation field '${key}'`
      );
      const dtypeInfo = validateOneDimensionalArrayMeta(
        meta,
        `Observation field '${key}'`,
        this._nObs
      );
      const { data } = await this._readArray(fieldPath);
      const fieldDtype = annDataValueKind(dtypeInfo);
      let values;
      if (fieldDtype === 'bool') {
        const message =
          `Observation field '${key}' contains a non-boolean value`;
        values = Array.from(
          data,
          value => decodeAnnDataBoolean(value, message)
        );
      } else if (fieldDtype === 'float' ||
                 fieldDtype === 'int' ||
                 fieldDtype === 'uint') {
        values = numericArrayToFloat32(data, `Observation field '${key}'`);
      } else {
        values = data;
      }

      result = {
        dtype: fieldDtype,
        values: fieldDtype === 'string' && !Array.isArray(values)
          ? Array.from(values)
          : values
      };
    } else {
      throw new Error(
        `Observation field '${key}' encoding-type is missing or unsupported`
      );
    }

    this._assertGeneration(generation, `reading observation field '${key}'`);
    if (result.dtype === 'categorical' &&
        !this._cache.has(`obs_info:${key}`)) {
      this._cache.set(`obs_info:${key}`, {
        dtype: 'categorical',
        categories: result.categories,
        ordered: result.ordered
      });
    }
    this._cache.set(cacheKey, result);
    return result;
  }

  /**
   * Hand one observation payload to the caller: the loader forgets it but
   * keeps the field's categories and type, so the payload can be transferred
   * out of the worker without leaving a detached buffer in this cache.
   *
   * @param {string} key
   * @param {Object} field - The exact payload `getObsField(key)` returned
   */
  detachObsField(key, field) {
    const cacheKey = `obs:${key}`;
    if (this._cache.get(cacheKey) === field) this._cache.delete(cacheKey);
  }

  /**
   * Restore the canonical category dictionary retained by the adapter after
   * the loader's transient caches were cleared.
   *
   * @param {string} key
   * @param {ReadonlyArray<unknown>} categories
   * @param {boolean} ordered
   */
  seedObsFieldCategories(key, categories, ordered) {
    this._ensureOpen();
    if (!Array.isArray(categories)) return;
    if (typeof ordered !== 'boolean') {
      throw new Error(
        `Categorical field '${key}' ordered must be a boolean`
      );
    }
    const infoKey = `obs_info:${key}`;
    if (!this._cache.has(infoKey)) {
      this._cache.set(infoKey, {
        dtype: 'categorical',
        categories,
        ordered
      });
    }
  }

  /**
   * Release one loader-owned observation payload plus a category alias already
   * retained by the adapter. Delete only the exact result consumed so a newer
   * independent result is never evicted by stale cleanup.
   *
   * @param {string} key
   * @param {Object} [expected]
   */
  releaseObsField(key, expected = undefined) {
    const cacheKey = `obs:${key}`;
    const cached = this._cache.get(cacheKey);
    if (
      expected !== undefined &&
      cached !== expected
    ) {
      return;
    }
    this._cache.delete(cacheKey);
    const categories = cached?.dtype === 'categorical'
      ? cached.categories
      : null;
    if (!Array.isArray(categories)) return;

    const infoKey = `obs_info:${key}`;
    const info = this._cache.get(infoKey);
    if (info?.dtype === 'categorical' &&
        info.categories === categories) {
      this._cache.delete(infoKey);
    }
  }

  /**
   * Validate one neighbour graph's metadata (`obsp[key]`) without loading its
   * payload, or return null when `obsp` has no such key.
   * @param {string} key - An `obsp` key.
   * @returns {Promise<Object|null>}
   */
  async _getConnectivityMetadata(key) {
    this._ensureOpen();
    requireObspKey(key);
    const generation = this._generation;
    const cacheKey = `connectivity:metadata:${key}`;

    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey);
    }

    const connPath = `obsp/${key}`;
    const hasObspRepresentation =
      this._exists('obsp/.zgroup') ||
      this._exists('obsp/.zattrs') ||
      this._exists(`${connPath}/.zarray`) ||
      this._exists(`${connPath}/.zgroup`) ||
      this._exists(`${connPath}/.zattrs`) ||
      this._exists(`${connPath}/data/.zarray`) ||
      this._exists(`${connPath}/indices/.zarray`) ||
      this._exists(`${connPath}/indptr/.zarray`);
    if (!hasObspRepresentation) {
      this._assertGeneration(generation, 'reading connectivity metadata');
      this._cache.set(cacheKey, null);
      return null;
    }
    await this._readCurrentAnnDataGroupAttrs(
      'obsp',
      'AnnData obsp mapping',
      'dict',
      '0.1.0'
    );
    this._assertGeneration(generation, 'reading connectivity metadata');

    const hasDense = this._exists(`${connPath}/.zarray`);
    const hasSparse =
      this._exists(`${connPath}/.zgroup`) ||
      this._exists(`${connPath}/data/.zarray`) ||
      this._exists(`${connPath}/indices/.zarray`) ||
      this._exists(`${connPath}/indptr/.zarray`);
    const hasAttrs = this._exists(`${connPath}/.zattrs`);
    if (!hasDense && !hasSparse && !hasAttrs) {
      this._assertGeneration(generation, 'reading connectivity metadata');
      this._cache.set(cacheKey, null);
      return null;
    }
    if (hasDense && hasSparse) {
      throw new Error(
        'Connectivity storage must contain exactly one dense or sparse representation'
      );
    }

    let result;
    if (hasDense) {
      const meta = await this._readCurrentAnnDataArrayMeta(
        connPath,
        'Dense connectivity matrix',
        'array'
      );
      const dtypeInfo = validateZarrArrayMetadata(
        meta,
        'Dense connectivity matrix'
      );
      if (!isAnnDataMatrixDataKind(annDataValueKind(dtypeInfo))) {
        throw new Error('Dense connectivity matrix must use a numeric dtype');
      }
      if (meta.shape.length !== 2) {
        throw new Error('Connectivity matrix must be two-dimensional');
      }
      if (meta.shape[0] !== this._nObs || meta.shape[1] !== this._nObs) {
        throw new Error(
          `Connectivity matrix shape ${meta.shape[0]}×${meta.shape[1]} does not match ${this._nObs} cells`
        );
      }
      result = {
        kind: 'dense',
        shape: [...meta.shape]
      };
    } else {
      const sparse = await this._readSparseMetadataContract(connPath);
      if (sparse.shape[0] !== this._nObs ||
          sparse.shape[1] !== this._nObs) {
        throw new Error(
          `Connectivity matrix shape ${sparse.shape[0]}×${sparse.shape[1]} does not match ${this._nObs} cells`
        );
      }
      result = {
        kind: 'sparse',
        ...sparse
      };
    }

    this._assertGeneration(generation, 'reading connectivity metadata');
    this._cache.set(cacheKey, result);
    return result;
  }

  /**
   * Report whether `obsp[key]` holds a neighbour graph, without
   * materializing its payload.
   * @param {string} key - An `obsp` key.
   * @returns {Promise<boolean>}
   */
  async hasConnectivities(key) {
    const generation = this._generation;
    const metadata = await this._getConnectivityMetadata(key);
    this._assertGeneration(generation, 'checking connectivity metadata');
    return metadata !== null;
  }

  /**
   * Read one neighbour graph, `obsp[key]`.
   *
   * The raw matrix is not cached: its only consumer extracts and caches the
   * edge list, after which the matrix (often the largest payload in the file)
   * would be dead weight for the lifetime of the dataset.
   * @param {string} key - An `obsp` key.
   * @returns {Promise<Object|null>}
   */
  /**
   * The edges of `obsp[key]`, checked and extracted here, beside the matrix
   * (in the AnnData reader worker), so the page never walks a large graph.
   *
   * @param {string} key - An `obsp` key.
   * @returns {Promise<Object|null>}
   */
  async getConnectivityEdges(key) {
    return connectivityEdgesOf(await this.getConnectivities(key), this._nObs);
  }

  async getConnectivities(key) {
    this._ensureOpen();
    const generation = this._generation;

    const metadata = await this._getConnectivityMetadata(key);
    this._assertGeneration(generation, 'loading connectivity data');
    if (metadata === null) {
      return null;
    }

    const connPath = `obsp/${key}`;
    let result;
    if (metadata.kind === 'dense') {
      const { data, shape } = await this._readArray(connPath);
      for (let index = 0; index < data.length; index++) {
        const value = Number(data[index]);
        if (!Number.isFinite(value)) {
          throw new Error('Dense connectivity matrix contains a non-finite value');
        }
      }
      result = { format: 'dense', data, shape };
    } else {
      result = await this._readSparseMatrix(connPath, 'exact');
    }

    this._assertGeneration(generation, 'loading connectivity data');
    return result;
  }

  /**
   * Ensure zarr is open
   * @private
   */
  _ensureOpen() {
    if (!this._files || this._files.size === 0) {
      throw new Error('No zarr directory is open. Call open() first.');
    }
  }

  /**
   * Get dataset metadata
   * @returns {Promise<Object>}
   */
  async getDatasetMetadata() {
    this._ensureOpen();
    const generation = this._generation;

    // Which embedding each dimension shows is the adapter's decision, made
    // from these probes by the data-mapping rules (default, then best guess).
    const probes = await this.probeMapping();
    this._assertGeneration(generation, 'building dataset metadata');

    // Count field types
    let nCategorical = 0;
    let nContinuous = 0;

    for (const key of this._obsKeys) {
      const info = await this._getObsFieldTypeInfo(key);
      this._assertGeneration(generation, 'building dataset metadata');
      if (info.dtype === 'categorical') nCategorical++;
      else if (info.dtype === 'float' || info.dtype === 'int' || info.dtype === 'uint') nContinuous++;
    }

    // The graph a file opens with is obsp['connectivities'] (the data
    // mapping's default); any other is read only when it is chosen.
    const hasConnectivity = await this.hasConnectivities(DEFAULT_KNN_KEY);
    this._assertGeneration(generation, 'building dataset metadata');

    // This is an adapter-construction descriptor, not a public dataset
    // identity. ZarrDataSource publishes the sole validated v3 identity only
    // after the adapter and every required payload have validated.
    return {
      stats: {
        n_cells: this._nObs,
        n_genes: this.hasExpressionMatrix ? this._nVars : 0,
        n_obs_fields: this._obsKeys.length,
        n_categorical_fields: nCategorical,
        n_continuous_fields: nContinuous,
        has_connectivity: hasConnectivity,
      },
      probes,
      obs_fields: this._obsKeys.map(key => ({ key, kind: 'unknown' })),
    };
  }

  /**
   * Clear all cached data
   */
  clearCache() {
    this._generation++;
    this._cache.clear();
    this._releaseMatrix();
  }

  /**
   * Release the current dataset without changing the open-request epoch.
   * Used only by the synchronous adoption step after a candidate validates.
   * @private
   */
  _releaseCurrentState() {
    // Clear the files Map explicitly (releases File object references)
    if (this._files) {
      this._files.clear();
      this._files = null;
    }
    this._rootName = null;

    // Clear all caches (including gene cache and sparse matrices)
    this.clearCache();

    // Reset all state
    this._nObs = 0;
    this._nVars = 0;
    this._obsKeys = [];
    this._varNames = [];
    this._rootAttrs = null;
  }

  /**
   * Close and release resources
   * IMPORTANT: This properly releases all memory to prevent leaks
   */
  close() {
    // A pending open must never reactivate a loader the caller explicitly closed.
    this._openRequestId++;
    this._releaseCurrentState();
    console.log('[ZarrLoader] Resources released');
  }
}

