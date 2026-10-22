/**
 * @fileoverview The h5ad reader: `H5adLoader` reads one AnnData `.h5ad` file
 * with h5wasm. It runs in the AnnData reader worker
 * (`anndata-reader-worker.js`); the main thread talks to it through
 * `AnnDataReaderClient` and never blocks on HDF5.
 *
 * The file is never copied: it is mounted as a range-backed file
 * (`range-source.js`), so HDF5 reads only the bytes of the datasets asked
 * for, and every dataset is read in hyperslabs of at most `SLAB_BYTES`, so
 * the 2 GiB WASM heap holds one slab at a time whatever the array's size.
 * Gene columns of a CSC matrix are read per gene; a CSR or contiguous dense
 * matrix is transposed once, streaming, into a column store
 * (`sparse-column-index.js`).
 *
 * @module data/h5ad-loader
 */

import { connectivityEdgesOf, toInt32Array, toFloat32Array } from './sparse-utils.js';
import { geneNameText } from './gene-names.js';
import { DecodedBlockCache } from './decoded-block-cache.js';
import {
  DEFAULT_KNN_KEY,
  requireObsmColumnSelection,
  requireObspKey,
} from './data-mapping-candidates.js';
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
import { mountRangeSource, requireRangeSource } from './range-source.js';
import {
  RowMajorColumnIndex,
  allocateTypedArray,
} from './sparse-column-index.js';
import { yieldToMacrotask } from '../utils/yield-macrotask.js';
import { createWorkerColumnStoreFactory } from './column-store-placement.js';
import { residencyBudgetBytes } from './memory-budget.js';


// h5wasm module - will be loaded dynamically
let h5wasm = null;
let h5wasmInitializationPromise = null;
let h5VirtualFileSequence = 0;

/**
 * Initialize h5wasm library (lazy load)
 * @returns {Promise<void>}
 */
async function initH5wasm() {
  if (h5wasm !== null) return;

  if (!h5wasmInitializationPromise) {
    h5wasmInitializationPromise = (async () => {
      const module = await import('../../external/hdf5_hl.js');
      await module.ready;
      h5wasm = module;
      console.log('[H5adLoader] h5wasm initialized successfully');
    })();
  }
  const initialization = h5wasmInitializationPromise;
  try {
    await initialization;
  } catch (err) {
    if (h5wasmInitializationPromise === initialization) {
      h5wasmInitializationPromise = null;
    }
    console.error('[H5adLoader] Failed to load h5wasm:', err);
    throw err;
  }
}

function isBooleanEnum(metadata) {
  const members = metadata?.enum_type?.members;
  if (!members || typeof members !== 'object') return false;

  const entries = Object.entries(members);
  if (entries.length !== 2) return false;

  const normalized = new Map(
    entries.map(([name, value]) => [
      name.toLowerCase(),
      Number(value)
    ])
  );
  return normalized.get('false') === 0 && normalized.get('true') === 1;
}

/**
 * Map h5wasm's NumPy-style dtype codes to Cellucid observation kinds.
 *
 * h5wasm reports primitive datasets as codes such as "<f", "<i", or "<I";
 * it does not spell out "float" or "int". HDF5 booleans are two-member enum
 * datasets and therefore require their metadata as well as the dtype string.
 *
 * The leading NumPy byte-order character is matched and then deliberately
 * discarded, and callers must not reintroduce it: it describes how the value
 * is stored in the file, not how it arrives here. HDF5 converts to the host
 * byte order while reading, so h5wasm hands back host-order data for both
 * ">f4" and "<f4" — the same is true of `metadata.littleEndian`, which
 * likewise reports file layout and never the layout of the returned buffer.
 * A big-endian `.h5ad` therefore yields exactly the numbers a little-endian
 * one does, and needs no byte swap anywhere downstream. (Zarr is the opposite
 * case: its chunks are raw stored bytes, so `zarr-codecs.js` records
 * `bigEndian` and `zarr.js` swaps on it.)
 *
 * The same rule makes `metadata.littleEndian` unusable as a validation input:
 * no reader in this module may accept or reject a value because of it. Doing
 * so rejects a readable file for a property of its storage that cannot reach
 * the caller, and reports it as a malformed value.
 *
 * `tests/h5ad-byte-order-contract.test.mjs` pins this against a real
 * big-endian HDF5 file and its little-endian twin, so the guarantee is
 * measured rather than assumed.
 *
 * @param {unknown} hdf5Dtype
 * @param {Object|null} [metadata]
 * @returns {'float'|'int'|'uint'|'string'|'bool'|'unknown'}
 */
export function classifyH5WasmDtype(hdf5Dtype, metadata = null) {
  if (isBooleanEnum(metadata)) return 'bool';
  if (typeof hdf5Dtype !== 'string') return 'unknown';

  const match = hdf5Dtype.match(/^[<>=|]?([A-Za-z?])(?:\d+)?$/);
  if (!match) return 'unknown';

  const typeCode = match[1];
  if (['e', 'f', 'd'].includes(typeCode)) return 'float';
  if (['b', 'h', 'i', 'q'].includes(typeCode)) return 'int';
  if (['B', 'H', 'I', 'Q'].includes(typeCode)) return 'uint';
  if (['S', 'U', 'O'].includes(typeCode)) return 'string';
  if (typeCode === '?') return 'bool';
  return 'unknown';
}

const HDF5_SIGNATURE = new Uint8Array([
  0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const MIN_HDF5_SUPERBLOCK_BYTES = 48;

/**
 * Bytes one hyperslab read may stage in the WASM heap. A scheduling choice,
 * not a limit: any dataset is read as consecutive slabs of at most this size
 * into an array outside the heap, so the heap (2 GiB in this h5wasm build)
 * never bounds the size of an array.
 */
const SLAB_BYTES = 64 * 1024 * 1024;

/**
 * The exact size of one source as a validated positive safe integer.
 *
 * @param {{size: number}} source
 * @returns {number}
 */
export function validateH5adSourceSize(source) {
  const size = source?.size;
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error(
      'The selected H5AD file is empty or does not report its size. Choose an AnnData .h5ad file or regenerate it with AnnData.'
    );
  }
  return size;
}

function hdf5SignatureOffsets(totalBytes) {
  const offsets = [];
  if (totalBytes >= HDF5_SIGNATURE.length) offsets.push(0);
  for (
    let offset = 512;
    offset + HDF5_SIGNATURE.length <= totalBytes;
    offset *= 2
  ) {
    offsets.push(offset);
  }
  return offsets;
}

function bytesContainHdf5SignatureAt(bytes, offset) {
  if (offset < 0 || offset + HDF5_SIGNATURE.length > bytes.length) {
    return false;
  }
  for (let index = 0; index < HDF5_SIGNATURE.length; index++) {
    if (bytes[offset + index] !== HDF5_SIGNATURE[index]) return false;
  }
  return true;
}

function findHdf5SignatureOffset(bytes) {
  return hdf5SignatureOffsets(bytes.byteLength).find(
    offset => bytesContainHdf5SignatureAt(bytes, offset)
  ) ?? -1;
}

/**
 * Detect the HDF5 superblock signature at every offset permitted by the HDF5
 * file-format specification (byte zero or powers of two beginning at 512).
 * This keeps legitimate files with an HDF5 user block compatible.
 *
 * @param {ArrayBuffer|ArrayBufferView} input
 * @returns {boolean}
 */
export function hasHdf5Signature(input) {
  let bytes;
  if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else if (ArrayBuffer.isView(input)) {
    bytes = new Uint8Array(
      input.buffer,
      input.byteOffset,
      input.byteLength
    );
  } else {
    return false;
  }

  return findHdf5SignatureOffset(bytes) >= 0;
}

function unreadableH5adError(cause = undefined) {
  return new Error(
    'The H5AD file could not be read. It may be corrupted or truncated; regenerate it with AnnData and try again.',
    cause === undefined ? undefined : { cause }
  );
}

/**
 * Check the HDF5 signature at each offset the format allows, reading eight
 * bytes per offset (at most about 2 log2(size) reads).
 *
 * @param {{size: number, readInto: Function}} source
 */
function validateH5adSourceSignature(source) {
  const totalBytes = source.size;
  const signature = new Uint8Array(HDF5_SIGNATURE.length);
  for (const offset of hdf5SignatureOffsets(totalBytes)) {
    source.readInto(signature, offset);
    if (bytesContainHdf5SignatureAt(signature, 0)) {
      if (totalBytes - offset < MIN_HDF5_SUPERBLOCK_BYTES) {
        throw unreadableH5adError();
      }
      return;
    }
  }
  throw new Error(
    'The selected file is not a valid HDF5/H5AD file. Choose an AnnData .h5ad file or regenerate it with AnnData.'
  );
}

/**
 * Elements per hyperslab of a dataset whose rows hold `rowElements` elements.
 *
 * @param {Object} dataset
 * @param {number} rowElements
 * @returns {number} Rows per slab (at least one)
 */
function slabRows(dataset, rowElements) {
  const bytesPerRow = Math.max(1, rowElements * h5DatasetElementBytes(dataset));
  let rows = Math.max(1, Math.floor(SLAB_BYTES / bytesPerRow));
  // Align to the dataset's chunk rows, so each compressed chunk is decoded
  // once rather than once per slab it straddles.
  const chunkRows = Number(dataset?.metadata?.chunks?.[0]);
  if (Number.isSafeInteger(chunkRows) && chunkRows > 0 && rows > chunkRows) {
    rows -= rows % chunkRows;
  }
  return rows;
}

/**
 * Read rows `[start, end)` of a one-dimensional numeric dataset, in slabs,
 * converting each slab with `convert(slab, output, offset)` into an output
 * array allocated once. The heap holds one slab at a time.
 *
 * @template T
 * @param {Object} dataset - h5wasm Dataset
 * @param {number} start
 * @param {number} end
 * @param {(length: number) => T} allocate
 * @param {(slab: ArrayLike<number|bigint>, output: T, offset: number) => void} convert
 * @param {string} label
 * @returns {T}
 */
function readH5Range1D(dataset, start, end, allocate, convert, label) {
  const output = allocate(end - start);
  const step = slabRows(dataset, 1);
  for (let at = start; at < end; at += step) {
    const stop = Math.min(end, at + step);
    const slab = dataset.slice([[at, stop]]);
    if (!slab || slab.length !== stop - at) {
      throw new Error(`${label} payload length does not match its metadata`);
    }
    convert(slab, output, at - start);
  }
  return output;
}

/**
 * Read entries `[start, end)` of a one-dimensional numeric dataset, keeping
 * h5wasm's typed-array type (exact stored values), in slabs.
 */
function readH5Numeric1DRange(dataset, start, end, label) {
  if (end <= start) return new Int32Array(0);
  let output = null;
  const step = slabRows(dataset, 1);
  for (let at = start; at < end; at += step) {
    const stop = Math.min(end, at + step);
    const slab = dataset.slice([[at, stop]]);
    if (!ArrayBuffer.isView(slab) || slab.length !== stop - at) {
      throw new Error(`${label} payload length does not match its metadata`);
    }
    if (output === null) {
      if (stop === end) return slab;
      output = allocateTypedArray(slab.constructor, end - start, label);
    }
    output.set(slab, at - start);
  }
  return output;
}

/**
 * Read entries `[start, end)` of a one-dimensional integer dataset as plain
 * numbers: int64 values (BigInt64Array) become an exact Float64Array, every
 * narrower integer type is kept as read.
 */
function readH5IntegerRange(dataset, start, end, label) {
  const raw = readH5Numeric1DRange(dataset, start, end, label);
  if (!(raw instanceof BigInt64Array) && !(raw instanceof BigUint64Array)) return raw;
  const values = allocateTypedArray(Float64Array, raw.length, label);
  for (let index = 0; index < raw.length; index++) {
    const value = raw[index];
    if (value > 9007199254740991n || value < -9007199254740991n) {
      throw new RangeError(`${label} ${value} is outside the safe integer range`);
    }
    values[index] = Number(value);
  }
  return values;
}

function addSparseFloat32(current, value) {
  const sum = current + value;
  const narrowed = Math.fround(sum);
  if (Number.isFinite(sum) && !Number.isFinite(narrowed)) {
    throw new Error('Sparse column value is outside the Float32 range');
  }
  return narrowed;
}

/** Copy a slab into a Float32Array, narrowing exactly as `toFloat32Array`. */
function convertSlabToFloat32(slab, output, offset, label) {
  if (slab instanceof Float32Array) {
    output.set(slab, offset);
    return;
  }
  output.set(toFloat32Array(slab, label), offset);
}

/** Copy a slab into an Int32Array, checking the range as `toInt32Array`. */
function convertSlabToInt32(slab, output, offset, label) {
  output.set(toInt32Array(slab, label), offset);
}

/** Read a whole one-dimensional numeric dataset as float32. */
function readH5Float32(dataset, length, label) {
  return readH5Range1D(
    dataset,
    0,
    length,
    count => allocateTypedArray(Float32Array, count, label),
    (slab, output, offset) => convertSlabToFloat32(slab, output, offset, label),
    label
  );
}

/** Read a whole one-dimensional integer dataset as int32. */
function readH5Int32(dataset, length, label) {
  return readH5Range1D(
    dataset,
    0,
    length,
    count => allocateTypedArray(Int32Array, count, label),
    (slab, output, offset) => convertSlabToInt32(slab, output, offset, label),
    label
  );
}

/**
 * Read a whole one-dimensional dataset of any primitive kind as a plain
 * array of values (strings, booleans, numbers), slab by slab.
 */
function readH5Values1D(dataset, length, label) {
  const output = new Array(length);
  const step = slabRows(dataset, 1);
  for (let at = 0; at < length; at += step) {
    const stop = Math.min(length, at + step);
    const slab = dataset.slice([[at, stop]]);
    if (!slab || slab.length !== stop - at) {
      throw new Error(`${label} payload length does not match its metadata`);
    }
    for (let index = 0; index < slab.length; index++) {
      output[at + index] = slab[index];
    }
  }
  return output;
}

/** Read a one-dimensional numeric dataset in row slabs. */
function readH5RowSlabs1D(dataset, nRows, onSlab) {
  const step = slabRows(dataset, 1);
  for (let rowStart = 0; rowStart < nRows; rowStart += step) {
    const rowEnd = Math.min(nRows, rowStart + step);
    const block = dataset.slice([[rowStart, rowEnd]]);
    if (!ArrayBuffer.isView(block) || block.length !== rowEnd - rowStart) {
      throw new Error('One-dimensional slab does not match its selection');
    }
    onSlab(block, rowStart, rowEnd);
  }
}

/**
 * Read a whole row-major two-dimensional numeric dataset in row slabs as
 * float64 values `output[row * width + column]` for the selected columns
 * `[first, last)`.
 */
function readH5RowSlabs2D(dataset, nRows, first, last, onSlab) {
  const width = last - first;
  const step = slabRows(dataset, width);
  for (let rowStart = 0; rowStart < nRows; rowStart += step) {
    const rowEnd = Math.min(nRows, rowStart + step);
    const block = dataset.slice([[rowStart, rowEnd], [first, last]]);
    if (!ArrayBuffer.isView(block) || block.length !== (rowEnd - rowStart) * width) {
      throw new Error('Two-dimensional slab does not match its selection');
    }
    onSlab(block, rowStart, rowEnd);
  }
}

function h5AttributeValue(node, key) {
  const attribute = node?.attrs?.[key];
  return attribute && typeof attribute === 'object' &&
    'value' in attribute
    ? attribute.value
    : attribute;
}

/**
 * Read one HDF5 boolean attribute written as AnnData writes it.
 *
 * Byte order is deliberately absent from these checks. The value is a single
 * signed byte drawn from a two-member enum whose members are pinned to
 * `FALSE = 0` and `TRUE = 1`, so `size`, `signed`, the member map and the
 * `0 | 1` value check already determine it completely; there is no second byte
 * for an ordering to apply to. `metadata.littleEndian` describes the datatype
 * recorded in the file, never the layout of what h5wasm returns — see the
 * byte-order contract on `classifyH5WasmDtype` above. Requiring it here once
 * rejected a perfectly readable file: an `ordered` attribute built on
 * `H5T_STD_I8BE` reports `littleEndian: false` while still returning the
 * correct `1`, and the sibling recogniser `isBooleanEnum` accepts exactly that
 * attribute, so the two readers disagreed about the same construct.
 */
function decodeExactH5BooleanAttribute(node, key, label) {
  const fail = () => {
    throw new Error(
      `${label} ${key} must be a scalar HDF5 enum boolean with exactly ` +
      'FALSE = 0 and TRUE = 1, as AnnData writes it'
    );
  };
  const attrs = node?.attrs;
  if (
    attrs === null ||
    typeof attrs !== 'object' ||
    !Object.hasOwn(attrs, key)
  ) {
    fail();
  }

  const attribute = attrs[key];
  const metadata = attribute?.metadata;
  const enumType = metadata?.enum_type;
  const members = enumType?.members;
  if (
    attribute === null ||
    typeof attribute !== 'object' ||
    Array.isArray(attribute) ||
    attribute.dtype !== 'unknown' ||
    !Array.isArray(attribute.shape) ||
    attribute.shape.length !== 0 ||
    metadata === null ||
    typeof metadata !== 'object' ||
    metadata.type !== 8 ||
    metadata.signed !== true ||
    metadata.vlen !== false ||
    metadata.size !== 1 ||
    metadata.total_size !== 1 ||
    !Array.isArray(metadata.shape) ||
    metadata.shape.length !== 0 ||
    !Array.isArray(metadata.maxshape) ||
    metadata.maxshape.length !== 0 ||
    metadata.chunks !== null ||
    enumType === null ||
    typeof enumType !== 'object' ||
    enumType.type !== 0 ||
    enumType.nmembers !== 2 ||
    members === null ||
    typeof members !== 'object' ||
    Array.isArray(members) ||
    Object.keys(members).length !== 2 ||
    !Object.hasOwn(members, 'FALSE') ||
    !Object.hasOwn(members, 'TRUE') ||
    members.FALSE !== 0 ||
    members.TRUE !== 1
  ) {
    fail();
  }

  const value = attribute.value;
  if (value !== 0 && value !== 1) {
    fail();
  }
  return value === 1;
}

function h5EncodingType(node) {
  let value = h5AttributeValue(node, 'encoding-type');
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    if (value.length !== 1) return '';
    value = value[0];
  }
  return typeof value === 'string' ? value : '';
}

function requireExactH5StringAttribute(
  node,
  key,
  expected,
  label
) {
  const value = h5AttributeValue(node, key);
  if (typeof value !== 'string' || value !== expected) {
    throw new Error(
      `${label} ${key} must be exactly '${expected}'`
    );
  }
  return value;
}

function requireCurrentH5Encoding(
  node,
  expectedType,
  expectedVersion,
  label
) {
  requireExactH5StringAttribute(
    node,
    'encoding-type',
    expectedType,
    label
  );
  requireExactH5StringAttribute(
    node,
    'encoding-version',
    expectedVersion,
    label
  );
}

function requireCurrentH5Mapping(group, label) {
  if (!group || group.type !== 'Group' ||
      typeof group.keys !== 'function' ||
      typeof group.get !== 'function') {
    throw new Error(`${label} must be an HDF5 mapping group`);
  }
  requireCurrentH5Encoding(
    group,
    'dict',
    '0.1.0',
    label
  );
  return group;
}

function requireCurrentH5Categorical(group, label) {
  requireCurrentH5Encoding(
    group,
    'categorical',
    '0.2.0',
    label
  );
  return decodeExactH5BooleanAttribute(
    group,
    'ordered',
    label
  );
}

function requireH5VLenUtf8Dataset(dataset, label) {
  if (dataset?.metadata?.vlen !== true ||
      dataset?.metadata?.cset !== 1) {
    throw new Error(
      `${label} string-array must use variable-length UTF-8 HDF5 storage`
    );
  }
}

function validateCurrentH5ArrayEncoding(
  dataset,
  label,
  expectedType = null
) {
  if (!dataset || dataset.type !== 'Dataset') {
    throw new Error(`${label} must be an HDF5 dataset`);
  }

  const encodingType = h5EncodingType(dataset);
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
  requireCurrentH5Encoding(
    dataset,
    requiredType,
    '0.2.0',
    label
  );

  const kind = h5DatasetKind(dataset);
  if (requiredType === 'string-array' && kind !== 'string') {
    throw new Error(
      `${label} declares string-array but does not use a string dtype`
    );
  }
  if (requiredType === 'string-array') {
    requireH5VLenUtf8Dataset(dataset, label);
  }
  if (requiredType === 'array' && kind === 'string') {
    throw new Error(
      `${label} declares array but uses a string dtype`
    );
  }
  return requiredType;
}

function validateCurrentH5DataFrame(group, label) {
  if (!group || group.type !== 'Group' ||
      typeof group.keys !== 'function' ||
      typeof group.get !== 'function') {
    throw new Error(`${label} is required and must be an HDF5 dataframe group`);
  }
  requireExactH5StringAttribute(
    group,
    'encoding-type',
    'dataframe',
    label
  );
  requireExactH5StringAttribute(
    group,
    'encoding-version',
    '0.2.0',
    label
  );

  const indexKey = h5AttributeValue(group, '_index');
  if (typeof indexKey !== 'string' || indexKey.length === 0) {
    throw new Error(`${label} _index must be a non-empty string`);
  }

  const rawColumnOrder = h5AttributeValue(group, 'column-order');
  const isColumnOrderSequence =
    Array.isArray(rawColumnOrder) || ArrayBuffer.isView(rawColumnOrder);
  const columnOrder = isColumnOrderSequence
    ? Array.from(rawColumnOrder)
    : [];
  if (!isColumnOrderSequence ||
      columnOrder.some(
        key => typeof key !== 'string' || key.length === 0
      )) {
    throw new Error(
      `${label} column-order must be an array or typed array of non-empty strings`
    );
  }
  const seenColumns = new Set();
  for (const key of columnOrder) {
    if (seenColumns.has(key)) {
      throw new Error(
        `${label} column-order contains duplicate column '${key}'`
      );
    }
    if (key === indexKey) {
      throw new Error(
        `${label} column-order cannot also declare its index '${indexKey}'`
      );
    }
    seenColumns.add(key);
  }

  const childKeys = group.keys();
  if (!Array.isArray(childKeys)) {
    throw new Error(`${label} children could not be enumerated`);
  }
  if (!childKeys.includes(indexKey) || !group.get(indexKey)) {
    throw new Error(
      `${label} index child '${indexKey}' was not found`
    );
  }
  for (const key of columnOrder) {
    if (!childKeys.includes(key) || !group.get(key)) {
      throw new Error(
        `${label} declared column '${key}' was not found`
      );
    }
  }

  if (childKeys.includes('__categories')) {
    throw new Error(
      `${label} uses the unsupported dataframe 0.1 '__categories' layout; rewrite the file with the current AnnData dataframe encoding`
    );
  }

  return { columnOrder, indexKey };
}

function normalizeH5Shape(rawShape, label) {
  if (!rawShape || typeof rawShape[Symbol.iterator] !== 'function') {
    throw new Error(`${label} shape is required`);
  }
  const shape = Array.from(rawShape, dimension => Number(dimension));
  if (shape.some(
    dimension => !Number.isSafeInteger(dimension) || dimension < 0
  )) {
    throw new Error(
      `${label} shape dimensions must be non-negative safe integers`
    );
  }
  return shape;
}

function h5DatasetShape(dataset, label, expectedDimensions = null) {
  const shape = normalizeH5Shape(dataset?.shape, label);
  if (expectedDimensions !== null && shape.length !== expectedDimensions) {
    throw new Error(
      `${label} must have exactly ${expectedDimensions} dimension${expectedDimensions === 1 ? '' : 's'}`
    );
  }
  return shape;
}

function h5DatasetKind(dataset) {
  return classifyH5WasmDtype(dataset?.dtype, dataset?.metadata);
}

function requireSupportedPrimitiveH5Dtype(dataset, label) {
  const kind = h5DatasetKind(dataset);
  if (!['string', 'float', 'int', 'uint', 'bool'].includes(kind)) {
    throw new Error(`${label} uses an unsupported HDF5 dtype`);
  }
  return kind;
}

function h5DatasetElementBytes(dataset) {
  const metadataBytes = Number(dataset?.metadata?.size);
  if (Number.isSafeInteger(metadataBytes) && metadataBytes > 0) {
    return metadataBytes;
  }
  if (typeof dataset?.dtype === 'string') {
    const match = dataset.dtype.match(/\d+$/);
    if (match) {
      const bytes = Number(match[0]);
      if (Number.isSafeInteger(bytes) && bytes > 0) return bytes;
    }
  }
  return 8;
}

function h5ElementCount(shape, label) {
  let count = 1n;
  for (const dimension of shape) count *= BigInt(dimension);
  if (count > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} element count exceeds the safe numeric range`);
  }
  return Number(count);
}

/**
 * Exact two-dimensional chunk shape of a chunked dense X, or null for
 * contiguous storage.
 *
 * @param {Object} dataset - h5wasm Dataset
 * @param {number[]} shape - Exact `[n_obs, n_vars]`
 * @returns {number[]|null}
 */
function h5DenseChunkShape(dataset, shape) {
  const chunks = dataset?.metadata?.chunks ?? null;
  if (chunks === null) return null;
  if (
    !Array.isArray(chunks) ||
    chunks.length !== 2 ||
    !chunks.every(size => Number.isSafeInteger(size) && size > 0)
  ) {
    throw new Error('Dense X HDF5 chunk shape must be two positive integers');
  }
  return [Math.min(chunks[0], shape[0]), Math.min(chunks[1], shape[1])];
}

function validateOneDimensionalH5Dataset(
  dataset,
  label,
  expectedLength = null
) {
  if (!dataset || dataset.type === 'Group') {
    throw new Error(`${label} must be an HDF5 dataset`);
  }
  const shape = h5DatasetShape(dataset, label, 1);
  if (expectedLength !== null && shape[0] !== expectedLength) {
    throw new Error(
      `${label} length ${shape[0]} does not match ${expectedLength}`
    );
  }
  return shape[0];
}

function validateH5CategoryCount(categoryCount, key) {
  return requireCategoricalCategoryCount(
    categoryCount,
    `Categorical observation field "${key}"`
  );
}

function isSignedH5IntegerDataset(dataset) {
  return h5DatasetKind(dataset) === 'int' &&
    typeof dataset?.dtype === 'string' &&
    /^[<>=|]?[bhiq](?:\d+)?$/.test(dataset.dtype);
}

function numericValueToFloat32(value, label) {
  let numeric;
  if (typeof value === 'bigint') {
    if (value < BigInt(Number.MIN_SAFE_INTEGER) ||
        value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`${label} integer is outside the safe numeric range`);
    }
    numeric = Number(value);
  } else {
    numeric = Number(value);
  }
  const narrowed = Math.fround(numeric);
  if (Number.isFinite(numeric) && !Number.isFinite(narrowed)) {
    throw new Error(`${label} value is outside the Float32 range`);
  }
  return narrowed;
}

/**
 * Resolve a categorical column in the current AnnData dataframe layout.
 *
 * @param {Object} obs - h5wasm observation group
 * @param {string} key - Observation column name
 * @returns {{codes: Object, categories: Object}|null}
 */
export function resolveH5adCategoricalColumn(obs, key) {
  if (!obs || typeof obs.keys !== 'function' || typeof obs.get !== 'function') {
    return null;
  }

  const obsKeys = obs.keys();
  if (!obsKeys.includes(key)) return null;

  const item = obs.get(key);
  if (item?.type === 'Group' &&
      h5EncodingType(item) === 'categorical' &&
      typeof item.keys === 'function') {
    const ordered = requireCurrentH5Categorical(
      item,
      `Categorical field '${key}'`
    );
    const itemKeys = item.keys();
    if (itemKeys.includes('codes') && itemKeys.includes('categories')) {
      const codes = item.get('codes');
      const categories = item.get('categories');
      validateCurrentH5ArrayEncoding(
        codes,
        `Categorical codes for '${key}'`,
        'array'
      );
      if (categories?.type === 'Group') {
        if (h5EncodingType(categories) !== 'nullable-string-array') {
          throw new Error(
            `Categorical categories for '${key}' must use a current array or nullable-string-array encoding`
          );
        }
        validateNullableH5Contract(
          categories,
          `${key}' categories`,
          'nullable-string-array',
          null,
          { materializeValues: false }
        );
      } else {
        validateCurrentH5ArrayEncoding(
          categories,
          `Categorical categories for '${key}'`
        );
      }
      return {
        codes,
        categories,
        ordered
      };
    }
    throw new Error(
      `Categorical field '${key}' must contain codes and categories`
    );
  }

  return null;
}

function validateCurrentH5DataFrameColumnEncoding(item, label) {
  if (item?.type !== 'Group') {
    return validateCurrentH5ArrayEncoding(item, label);
  }

  const encodingType = h5EncodingType(item);
  if (encodingType === 'categorical') {
    requireCurrentH5Categorical(
      item,
      label
    );
    return encodingType;
  }
  if (
    encodingType === 'nullable-integer' ||
    encodingType === 'nullable-boolean' ||
    encodingType === 'nullable-string-array'
  ) {
    requireCurrentH5Encoding(
      item,
      encodingType,
      '0.1.0',
      label
    );
    return encodingType;
  }
  throw new Error(
    `${label} uses unsupported encoding '${encodingType || 'unknown'}'`
  );
}

function validateH5DataFrameColumnAxis(
  frame,
  key,
  frameLabel,
  expectedLength
) {
  const item = frame.get(key);
  const label = `${frameLabel} column '${key}'`;
  const encodingType =
    validateCurrentH5DataFrameColumnEncoding(item, label);
  const categoricalColumn = resolveH5adCategoricalColumn(frame, key);
  if (categoricalColumn) {
    validateCurrentH5ArrayEncoding(
      categoricalColumn.codes,
      `${label} categorical codes`,
      'array'
    );
    validateOneDimensionalH5Dataset(
      categoricalColumn.codes,
      `${label} categorical codes`,
      expectedLength
    );
    if (!isSignedH5IntegerDataset(categoricalColumn.codes)) {
      throw new Error(
        `${label} categorical codes must use a signed integer dtype`
      );
    }
    const categories = categoricalColumn.categories;
    if (categories?.type === 'Group') {
      const categoryEncoding = h5EncodingType(categories);
      if (categoryEncoding !== 'nullable-string-array') {
        throw new Error(
          `${label} categorical categories use unsupported encoding '${categoryEncoding || 'unknown'}'`
        );
      }
      validateNullableH5Contract(
        categories,
        `${key}' categories`,
        categoryEncoding,
        null,
        { materializeValues: false }
      );
    } else {
      validateCurrentH5ArrayEncoding(
        categories,
        `${label} categorical categories`
      );
      validateOneDimensionalH5Dataset(
        categories,
        `${label} categorical categories`
      );
    }
    return;
  }

  if (item?.type === 'Group') {
    if (
      encodingType === 'nullable-integer' ||
      encodingType === 'nullable-boolean' ||
      encodingType === 'nullable-string-array'
    ) {
      validateNullableH5Contract(
        item,
        key,
        encodingType,
        expectedLength,
        { materializeValues: false }
      );
      return;
    }
    throw new Error(
      `${label} uses unsupported encoding '${encodingType || 'unknown'}'`
    );
  }

  validateOneDimensionalH5Dataset(item, label, expectedLength);
  requireSupportedPrimitiveH5Dtype(item, label);
}

function validateNullableH5Contract(
  item,
  key,
  encodingType,
  expectedLength = null
) {
  if (!item || item.type !== 'Group' ||
      typeof item.keys !== 'function' ||
      typeof item.get !== 'function') {
    throw new Error(`Nullable field '${key}' must be an HDF5 group`);
  }
  requireCurrentH5Encoding(
    item,
    encodingType,
    '0.1.0',
    `Nullable field '${key}'`
  );
  const keys = item.keys();
  if (!keys.includes('values') || !keys.includes('mask')) {
    throw new Error(
      `Nullable field '${key}' must contain values and mask datasets`
    );
  }
  const valuesDataset = item.get('values');
  const maskDataset = item.get('mask');
  validateCurrentH5ArrayEncoding(
    valuesDataset,
    `Nullable values for '${key}'`,
    encodingType === 'nullable-string-array'
      ? 'string-array'
      : 'array'
  );
  validateCurrentH5ArrayEncoding(
    maskDataset,
    `Nullable mask for '${key}'`,
    'array'
  );
  const valuesLength = validateOneDimensionalH5Dataset(
    valuesDataset,
    `Nullable values for '${key}'`,
    expectedLength
  );
  const maskLength = validateOneDimensionalH5Dataset(
    maskDataset,
    `Nullable mask for '${key}'`,
    expectedLength ?? valuesLength
  );
  if (valuesLength !== maskLength) {
    throw new Error(
      `Nullable values and mask lengths differ for '${key}'`
    );
  }

  const valuesKind = h5DatasetKind(valuesDataset);
  const maskKind = h5DatasetKind(maskDataset);
  if (maskKind !== 'bool') {
    throw new Error(`Nullable mask for '${key}' must use a boolean dtype`);
  }
  if (encodingType === 'nullable-integer') {
    if (valuesKind !== 'int' && valuesKind !== 'uint') {
      throw new Error(
        `Nullable integer values for '${key}' must use an integer dtype`
      );
    }
  } else if (encodingType === 'nullable-boolean') {
    if (valuesKind !== 'bool') {
      throw new Error(
        `Nullable boolean values for '${key}' must use a boolean dtype`
      );
    }
  } else if (encodingType === 'nullable-string-array') {
    if (valuesKind !== 'string') {
      throw new Error(
        `Nullable string values for '${key}' must use a string dtype`
      );
    }
  } else {
    throw new Error(
      `Unsupported nullable encoding-type '${encodingType}' for '${key}'`
    );
  }

  return {
    maskDataset,
    valuesDataset,
    valuesKind,
    valuesLength,
  };
}

function readBooleanMask(maskDataset, expectedLength, label) {
  const message = `${label} must contain only boolean values`;
  return readH5Range1D(
    maskDataset,
    0,
    expectedLength,
    count => allocateTypedArray(Uint8Array, count, label),
    (slab, output, offset) => {
      for (let index = 0; index < slab.length; index++) {
        output[offset + index] = decodeAnnDataBoolean(slab[index], message) ? 1 : 0;
      }
    },
    label
  );
}

function readNullableH5Values(
  item,
  key,
  encodingType,
  expectedLength = null,
  validatedContract = null
) {
  const contract = validatedContract ?? validateNullableH5Contract(
    item,
    key,
    encodingType,
    expectedLength
  );
  const {
    maskDataset,
    valuesDataset,
    valuesKind,
    valuesLength,
  } = contract;
  const mask = readBooleanMask(
    maskDataset,
    valuesLength,
    `Nullable mask for '${key}'`
  );
  const valuesLabel = `Nullable values for '${key}'`;
  if (encodingType === 'nullable-integer') {
    const label = `Observation field '${key}'`;
    const values = readH5Range1D(
      valuesDataset,
      0,
      valuesLength,
      count => allocateTypedArray(Float32Array, count, valuesLabel),
      (slab, output, offset) => {
        for (let index = 0; index < slab.length; index++) {
          output[offset + index] = mask[offset + index]
            ? Number.NaN
            : numericValueToFloat32(slab[index], label);
        }
      },
      valuesLabel
    );
    return {
      dtype: valuesKind === 'uint' ? 'uint' : 'int',
      values,
    };
  }
  const rawValues = readH5Values1D(valuesDataset, valuesLength, valuesLabel);
  if (encodingType === 'nullable-boolean') {
    const message =
      `Nullable boolean values for '${key}' must contain only boolean values`;
    for (let index = 0; index < valuesLength; index++) {
      rawValues[index] = mask[index]
        ? null
        : decodeAnnDataBoolean(rawValues[index], message);
    }
    return { dtype: 'bool', values: rawValues };
  }

  for (let index = 0; index < valuesLength; index++) {
    rawValues[index] = mask[index] ? null : String(rawValues[index]);
  }
  return { dtype: 'string', values: rawValues };
}

function readH5DataFrameIndex(
  indexNode,
  label,
  expectedLength = null,
  materializeValues = false
) {
  if (indexNode?.type === 'Group') {
    const encodingType = h5EncodingType(indexNode);
    if (encodingType !== 'nullable-string-array') {
      throw new Error(
        `${label} group uses unsupported encoding '${encodingType || 'unknown'}'`
      );
    }
    const contract = validateNullableH5Contract(
      indexNode,
      label,
      encodingType,
      expectedLength
    );
    const mask = readBooleanMask(
      contract.maskDataset,
      contract.valuesLength,
      `Nullable mask for '${label}'`
    );
    if (mask.some(value => value !== 0)) {
      throw new Error(`${label} cannot contain missing names`);
    }
    if (!materializeValues) {
      return { length: contract.valuesLength, values: null };
    }

    return {
      length: contract.valuesLength,
      values: readH5Names(contract.valuesDataset, contract.valuesLength, label),
    };
  }

  validateCurrentH5ArrayEncoding(
    indexNode,
    label,
    'string-array'
  );
  const length = validateOneDimensionalH5Dataset(
    indexNode,
    label,
    expectedLength
  );
  if (h5DatasetKind(indexNode) !== 'string') {
    throw new Error(`${label} must use a string dtype`);
  }
  if (!materializeValues) return { length, values: null };
  return { length, values: readH5Names(indexNode, length, label) };
}

/**
 * Read a string dataset of names (an index): every value present, as text.
 */
function readH5Names(dataset, length, label) {
  const values = readH5Values1D(dataset, length, label);
  for (let index = 0; index < length; index++) {
    const value = values[index];
    if (value === null || value === undefined) {
      throw new Error(`${label} cannot contain missing names`);
    }
    values[index] = String(value);
  }
  return values;
}

function freezeUniqueH5Categories(categories, key) {
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
  return Object.freeze(categories);
}

function readH5CategoricalCategories(categoriesDataset, key) {
  if (categoriesDataset?.type === 'Group') {
    const encodingType = h5EncodingType(categoriesDataset);
    if (encodingType !== 'nullable-string-array') {
      throw new Error(
        `Categorical categories for '${key}' use unsupported encoding '${encodingType}'`
      );
    }
    const nullableKey = `${key}' categories`;
    const contract = validateNullableH5Contract(
      categoriesDataset,
      nullableKey,
      encodingType,
      null
    );
    validateH5CategoryCount(contract.valuesLength, key);
    const result = readNullableH5Values(
      categoriesDataset,
      nullableKey,
      encodingType,
      null,
      contract
    );
    if (result.values.some(value => value === null)) {
      throw new Error(
        `Categorical categories for '${key}' cannot contain missing labels`
      );
    }
    return freezeUniqueH5Categories(result.values, key);
  }

  validateCurrentH5ArrayEncoding(
    categoriesDataset,
    `Categorical categories for '${key}'`
  );
  const length = validateOneDimensionalH5Dataset(
    categoriesDataset,
    `Categorical categories for '${key}'`
  );
  validateH5CategoryCount(length, key);
  const kind = h5DatasetKind(categoriesDataset);
  if (!['string', 'float', 'int', 'uint', 'bool'].includes(kind)) {
    throw new Error(
      `Categorical categories for '${key}' must use a numeric, boolean, or string dtype`
    );
  }
  const rawCategories = readH5Values1D(
    categoriesDataset,
    length,
    `Categorical categories for '${key}'`
  );
  if (kind === 'string') {
    return freezeUniqueH5Categories(
      Array.from(rawCategories, value => String(value)),
      key
    );
  }
  if (kind === 'bool') {
    return freezeUniqueH5Categories(
      Array.from(rawCategories, value => decodeAnnDataBoolean(
        value,
        `Categorical categories for '${key}' contain a non-boolean value`
      )),
      key
    );
  }
  return freezeUniqueH5Categories(
    Array.from(rawCategories, value => {
      let numeric;
      if (typeof value === 'bigint') {
        if (value < BigInt(Number.MIN_SAFE_INTEGER) ||
            value > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error(
            `Categorical categories for '${key}' contain an integer outside the safe numeric range`
          );
        }
        numeric = Number(value);
      } else {
        numeric = Number(value);
      }
      if (!Number.isFinite(numeric)) {
        throw new Error(
          `Categorical categories for '${key}' cannot contain non-finite numeric labels`
        );
      }
      return numeric;
    }),
    key
  );
}

function readH5CategoricalCodes(codesDataset, categoriesLength, key, nObs) {
  validateCurrentH5ArrayEncoding(
    codesDataset,
    `Categorical codes for '${key}'`,
    'array'
  );
  const codeLength = validateOneDimensionalH5Dataset(
    codesDataset,
    `Categorical codes for '${key}'`,
    nObs
  );
  if (!isSignedH5IntegerDataset(codesDataset)) {
    throw new Error(
      `Categorical codes for '${key}' must use a signed integer dtype`
    );
  }
  const codes = readH5Int32(
    codesDataset,
    codeLength,
    `Categorical code for '${key}'`
  );
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index];
    if (code < -1 || code >= categoriesLength) {
      throw new Error(
        `Categorical code ${code} for '${key}' is outside missing-or-category bounds`
      );
    }
  }
  return codes;
}

/**
 * Read a sparse matrix (CSR or CSC) from h5ad
 * @param {Object} group - h5wasm group containing sparse matrix
 * @returns {{data: Float32Array, indices: Int32Array, indptr: Int32Array, shape: number[], format: string, cscData?: Object}}
 */
function readSparseMatrixMetadata(group, label = 'Sparse matrix') {
  if (!group || group.type !== 'Group' ||
      typeof group.keys !== 'function' ||
      typeof group.get !== 'function') {
    throw new Error(`${label} must be an HDF5 group`);
  }

  const encodingType = h5EncodingType(group);
  let format;
  if (encodingType === 'csr_matrix') {
    format = 'csr';
  } else if (encodingType === 'csc_matrix') {
    format = 'csc';
  } else {
    throw new Error(
      `${label} encoding-type is required and must be 'csr_matrix' or 'csc_matrix'`
    );
  }
  requireCurrentH5Encoding(
    group,
    encodingType,
    '0.1.0',
    label
  );

  const shape = normalizeH5Shape(h5AttributeValue(group, 'shape'), label);
  if (shape.length !== 2) {
    throw new Error(`${label} shape must contain exactly two dimensions`);
  }

  const keys = group.keys();
  for (const key of ['data', 'indices', 'indptr']) {
    if (!keys.includes(key)) {
      throw new Error(`${label} is missing required '${key}' dataset`);
    }
  }
  const dataDataset = group.get('data');
  const indicesDataset = group.get('indices');
  const indptrDataset = group.get('indptr');
  // In the AnnData sparse-array encoding, these are format-internal storage
  // members owned by the exact csr/csc parent, not independently encoded
  // AnnData elements. Current writers therefore emit plain HDF5 datasets.
  for (const [key, dataset] of [
    ['data', dataDataset],
    ['indices', indicesDataset],
    ['indptr', indptrDataset],
  ]) {
    if (!dataset || dataset.type !== 'Dataset') {
      throw new Error(`${label} ${key} must be an HDF5 dataset`);
    }
  }
  const dataLength = validateOneDimensionalH5Dataset(
    dataDataset,
    `${label} data`
  );
  const indicesLength = validateOneDimensionalH5Dataset(
    indicesDataset,
    `${label} indices`
  );
  const pointerAxis = format === 'csr' ? shape[0] : shape[1];
  const indptrLength = validateOneDimensionalH5Dataset(
    indptrDataset,
    `${label} indptr`,
    pointerAxis + 1
  );
  if (dataLength !== indicesLength) {
    throw new Error(
      `${label} data and indices lengths differ (${dataLength} versus ${indicesLength})`
    );
  }

  const dataKind = h5DatasetKind(dataDataset);
  if (!isAnnDataMatrixDataKind(dataKind)) {
    throw new Error(`${label} data must use a numeric dtype`);
  }
  const indicesKind = h5DatasetKind(indicesDataset);
  const indptrKind = h5DatasetKind(indptrDataset);
  if (!['int', 'uint'].includes(indicesKind) ||
      !['int', 'uint'].includes(indptrKind)) {
    throw new Error(`${label} indices and indptr must use integer dtypes`);
  }

  return {
    dataDataset,
    dataKind,
    dataLength,
    encodingType,
    format,
    indicesDataset,
    indicesLength,
    indptrDataset,
    indptrLength,
    shape,
  };
}

/**
 * The NumPy name of one HDF5 dataset's dtype (`float32`, `int64`, `bool`,
 * `string`), as the data-mapping catalog spells dtypes.
 *
 * @param {Object} dataset - h5wasm Dataset
 * @returns {string}
 */
function h5NumpyDtypeName(dataset) {
  const kind = h5DatasetKind(dataset);
  const bits = h5DatasetElementBytes(dataset) * 8;
  if (kind === 'float') return `float${bits}`;
  if (kind === 'int') return `int${bits}`;
  if (kind === 'uint') return `uint${bits}`;
  if (kind === 'bool') return 'bool';
  if (kind === 'string') return 'string';
  return 'object';
}

/**
 * Describe one AnnData element from its HDF5 metadata, for the data-mapping
 * catalog. Nothing is read and nothing is refused: an element this reader
 * cannot classify is storage `other`.
 *
 * @param {string} key
 * @param {Object} node - h5wasm Dataset or Group
 * @returns {{key: string, storage: string, shape: number[]|null, dtype: string, numeric: boolean, nnz: number|null}}
 */
function probeH5Element(key, node) {
  const other = { key, storage: 'other', shape: null, dtype: 'object', numeric: false, nnz: null };
  try {
    if (node?.type === 'Dataset') {
      const kind = h5DatasetKind(node);
      return {
        key,
        storage: 'dense',
        shape: normalizeH5Shape(node.shape, key),
        dtype: h5NumpyDtypeName(node),
        numeric: isAnnDataNumericValueKind(kind),
        nnz: null,
      };
    }
    if (node?.type !== 'Group') return other;
    const encoding = h5EncodingType(node);
    if (encoding === 'csr_matrix' || encoding === 'csc_matrix') {
      const shape = normalizeH5Shape(h5AttributeValue(node, 'shape'), key);
      const data = node.keys().includes('data') ? node.get('data') : null;
      if (data?.type !== 'Dataset') return { ...other, storage: encoding.slice(0, 3), shape };
      return {
        key,
        storage: encoding.slice(0, 3),
        shape,
        dtype: h5NumpyDtypeName(data),
        numeric: isAnnDataNumericValueKind(h5DatasetKind(data)),
        nnz: normalizeH5Shape(data.shape, key)[0] ?? null,
      };
    }
    if (encoding === 'dataframe') {
      const indexKey = h5AttributeValue(node, '_index');
      const columnOrder = h5AttributeValue(node, 'column-order');
      const index = typeof indexKey === 'string' ? node.get(indexKey) : null;
      const rows = index?.type === 'Dataset' ? normalizeH5Shape(index.shape, key)[0] : null;
      const columns = Array.isArray(columnOrder) || ArrayBuffer.isView(columnOrder)
        ? columnOrder.length
        : null;
      return {
        ...other,
        storage: 'dataframe',
        shape: rows === null || rows === undefined || columns === null ? null : [rows, columns],
      };
    }
  } catch {
    return other;
  }
  return other;
}

/**
 * The columns of one AnnData dataframe and the dtype each holds, for the
 * gene-name choices of the data-mapping catalog.
 *
 * @param {Object} dataframe - h5wasm Group with the dataframe encoding
 * @returns {Array<{key: string, dtype: string}>}
 */
function probeH5VarColumns(dataframe) {
  const { columnOrder } = validateCurrentH5DataFrame(dataframe, 'H5AD var');
  return columnOrder.map(key => {
    const node = dataframe.get(key);
    if (node?.type === 'Dataset') return { key, dtype: h5NumpyDtypeName(node) };
    const encoding = h5EncodingType(node);
    if (encoding === 'categorical') return { key, dtype: 'categorical' };
    if (encoding === 'nullable-integer') return { key, dtype: 'Int64' };
    if (encoding === 'nullable-boolean') return { key, dtype: 'boolean' };
    if (encoding === 'nullable-string-array') return { key, dtype: 'string' };
    return { key, dtype: 'object' };
  });
}

/**
 * Read one dataframe column as gene-name text (`gene-names.js`): strings,
 * categories and integers name genes; a missing value is null. Float and
 * boolean columns cannot name genes (the catalog lists them as unusable).
 *
 * @param {Object} frame - h5wasm dataframe group
 * @param {string} key
 * @param {string} label
 * @param {number} nRows
 * @returns {Array<string|null>}
 */
function readH5GeneNameColumn(frame, key, label, nRows) {
  const categorical = resolveH5adCategoricalColumn(frame, key);
  if (categorical) {
    const categoriesNode = categorical.categories;
    const isFloat = categoriesNode?.type === 'Dataset' && h5DatasetKind(categoriesNode) === 'float';
    const categories = readH5CategoricalCategories(categoriesNode, key)
      .map(category => geneNameText(category, { isFloat }));
    const codes = readH5CategoricalCodes(categorical.codes, categories.length, key, nRows);
    return Array.from(codes, code => (code < 0 ? null : categories[code]));
  }
  const item = frame.get(key);
  const encoding = item?.type === 'Group' ? h5EncodingType(item) : null;
  if (encoding === 'nullable-string-array' || encoding === 'nullable-integer') {
    const contract = validateNullableH5Contract(item, key, encoding, nRows);
    const mask = readBooleanMask(contract.maskDataset, contract.valuesLength, `Nullable mask for '${key}'`);
    const rawValues = readH5Values1D(contract.valuesDataset, contract.valuesLength, label);
    return Array.from(rawValues, (value, row) => (mask[row] ? null : geneNameText(
      encoding === 'nullable-string-array' ? String(value) : value
    )));
  }
  if (item?.type !== 'Dataset') {
    throw new Error(`${label} cannot name genes`);
  }
  const length = validateOneDimensionalH5Dataset(item, label, nRows);
  const kind = h5DatasetKind(item);
  if (kind !== 'string' && kind !== 'int' && kind !== 'uint') {
    throw new Error(`${label} cannot name genes: its values are ${kind}`);
  }
  const rawValues = readH5Values1D(item, length, label);
  return Array.from(rawValues, value => geneNameText(kind === 'string' ? String(value) : value));
}

function readSparseMatrix(group, label, dataMode) {
  if (dataMode !== 'float32' && dataMode !== 'exact') {
    throw new TypeError(
      `${label} data mode must be exactly "float32" or "exact"`
    );
  }
  const metadata = readSparseMatrixMetadata(group, label);
  const {
    dataDataset,
    dataLength,
    format,
    indicesDataset,
    indicesLength,
    indptrDataset,
    indptrLength,
    shape,
  } = metadata;
  const indexAxis = format === 'csr' ? shape[1] : shape[0];
  const data = dataMode === 'exact'
    ? readH5Numeric1DRange(dataDataset, 0, dataLength, `${label} data`)
    : readH5Float32(dataDataset, dataLength, `${label} data`);
  const indices = readH5Range1D(
    indicesDataset,
    0,
    indicesLength,
    count => allocateTypedArray(Int32Array, count, `${label} index`),
    (slab, output, offset) => {
      convertSlabToInt32(slab, output, offset, `${label} index`);
      for (let at = offset; at < offset + slab.length; at++) {
        const index = output[at];
        if (index < 0 || index >= indexAxis) {
          throw new Error(
            `${label} index ${index} is outside axis bounds [0, ${indexAxis})`
          );
        }
      }
    },
    `${label} index`
  );
  // Pointers are exact integers up to 2^53; Int32 holds them while the
  // non-zero count fits, Float64 beyond.
  const PointerArray = dataLength <= 0x7fffffff ? Int32Array : Float64Array;
  const indptr = readH5Range1D(
    indptrDataset,
    0,
    indptrLength,
    count => allocateTypedArray(PointerArray, count, `${label} indptr`),
    (slab, output, offset) => {
      for (let index = 0; index < slab.length; index++) {
        const value = Number(slab[index]);
        if (!Number.isSafeInteger(value) || value < 0 || value > dataLength) {
          throw new Error(`${label} indptr ${String(slab[index])} is outside [0, ${dataLength}]`);
        }
        output[offset + index] = value;
      }
    },
    `${label} indptr`
  );

  if (indptr[0] !== 0) {
    throw new Error(`${label} indptr must start at zero`);
  }
  for (let index = 1; index < indptr.length; index++) {
    if (indptr[index] < indptr[index - 1]) {
      throw new Error(`${label} indptr must be monotonic`);
    }
  }
  if (indptr[indptr.length - 1] !== data.length) {
    throw new Error(
      `${label} indptr last value must equal the non-zero count (${data.length})`
    );
  }

  return {
    cscData: null,
    data,
    format,
    indices,
    indptr,
    shape,
  };
}

/**
 * H5AD file loader for AnnData format. One instance reads one file; it lives
 * in the AnnData reader worker.
 */
export class H5adLoader {
  constructor() {
    /** @type {Object|null} h5wasm File object */
    this._file = null;

    /** @type {string|null} */
    this._filename = null;

    /** @type {(() => void)|null} Unmounts the range-backed virtual file */
    this._unmount = null;

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
     * `layers/<k>` or `raw/X`) and how its columns are reached: a CSC
     * matrix's pointers (genes are read per gene), or the column store a CSR
     * or contiguous dense matrix was transposed into once. Reading another
     * matrix releases it. Gene columns themselves are not cached here: the
     * caller's field cache is their one owner.
     * @type {{element: string, columns: Object|null, loadPromise: Promise|null}|null}
     */
    this._matrix = null;

    /** @type {DecodedBlockCache} Decoded dense chunk blocks shared by genes of one strip */
    this._decodedXBlocks = new DecodedBlockCache();

    /** @type {number} Invalidates asynchronous work after cache lifecycle changes */
    this._generation = 0;

    /** @type {number} Latest open request identity */
    this._openRequestId = 0;

    /** @type {boolean} */
    this._closed = false;

    /** @type {((event: Object) => void)|null} Progress of long reads (transposes) */
    this.onProgress = null;

    /** Where gene-column indexes are kept (memory, else disk). */
    this.columnStoreFactory = createWorkerColumnStoreFactory();
  }

  _assertOpenRequest(requestId) {
    if (requestId !== this._openRequestId) {
      throw createDatasetReloadSupersededError(
        'H5AD open request was superseded or closed.'
      );
    }
  }

  /**
   * Open one h5ad file through a range source (`range-source.js`). Nothing
   * is copied: HDF5 reads the byte ranges of the datasets it is asked for.
   *
   * @param {{size: number, name: string, identity: Object, readInto: Function}} source
   * @returns {Promise<void>}
   */
  async open(source) {
    requireRangeSource(source);
    validateH5adSourceSize(source);
    const requestId = ++this._openRequestId;
    const candidate = new H5adLoader();
    try {
      await this._populateCandidate(candidate, source, requestId);
      this._assertOpenRequest(requestId);
      this._adoptCandidate(candidate);
      console.log(`[H5adLoader] Opened ${source.name}: ${this._nObs} cells, ${this._nVars} genes`);
    } catch (error) {
      let terminalError = (
        error instanceof Error &&
        error.message.length > 0
      )
        ? error
        : new TypeError(
            'H5AD opening must reject with a non-empty Error.',
            { cause: error }
          );
      try {
        candidate.close();
      } catch (cleanupFailure) {
        terminalError = combineDatasetLifecycleFailures(
          terminalError,
          cleanupFailure,
          'H5AD opening and candidate cleanup both failed.'
        );
      }
      throw terminalError;
    }
  }

  /**
   * Validate and open one source into a candidate loader.
   * @param {H5adLoader} candidate
   * @param {Object} source
   * @param {number} requestId
   * @private
   */
  async _populateCandidate(candidate, source, requestId) {
    validateH5adSourceSignature(source);
    this._assertOpenRequest(requestId);

    await initH5wasm();
    this._assertOpenRequest(requestId);

    const safeName = source.name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'file.h5ad';
    const virtualPath = `/cellucid_h5ad_${++h5VirtualFileSequence}_${safeName}`;
    candidate._unmount = mountRangeSource(h5wasm.FS, virtualPath, source);
    try {
      candidate._file = new h5wasm.File(virtualPath, 'r');
      // h5wasm may return an invalid File wrapper instead of throwing when the
      // superblock exists but the file is truncated. Touching the root now
      // converts that low-level failure into one stable user-facing boundary.
      candidate._file.keys();
    } catch (cause) {
      throw unreadableH5adError(cause);
    }
    candidate._filename = source.name;
    await candidate._readStructure();
    this._assertOpenRequest(requestId);
  }

  /**
   * Adopt a completely validated candidate while preserving ownership and
   * cache-accounting invariants.
   * @param {H5adLoader} candidate
   * @private
   */
  _adoptCandidate(candidate) {
    this._releaseCurrentState();
    this._file = candidate._file;
    this._filename = candidate._filename;
    this._unmount = candidate._unmount;
    this._nObs = candidate._nObs;
    this._nVars = candidate._nVars;
    this._obsKeys = candidate._obsKeys;
    this._varNames = candidate._varNames;
    this._cache = candidate._cache;
    this._matrix = candidate._matrix;
    this._closed = false;

    // The active loader now owns these resources; a later candidate close
    // must not release them.
    candidate._file = null;
    candidate._unmount = null;
  }

  /**
   * Read the basic structure of the h5ad file
   * @private
   */
  async _readStructure() {
    const root = this._file;
    if (!root || root.type !== 'Group' ||
        typeof root.keys !== 'function' ||
        typeof root.get !== 'function') {
      throw new Error('H5AD root must be an HDF5 group');
    }
    requireExactH5StringAttribute(
      root,
      'encoding-type',
      'anndata',
      'H5AD root'
    );
    requireExactH5StringAttribute(
      root,
      'encoding-version',
      '0.1.0',
      'H5AD root'
    );

    const rootKeys = root.keys();
    if (!rootKeys.includes('obs')) {
      throw new Error(
        'H5AD obs is required and must be a current AnnData dataframe'
      );
    }
    if (!rootKeys.includes('var')) {
      throw new Error(
        'H5AD var is required and must be a current AnnData dataframe'
      );
    }
    const obs = root.get('obs');
    const var_ = root.get('var');
    const obsSchema = validateCurrentH5DataFrame(obs, 'H5AD obs');
    const varSchema = validateCurrentH5DataFrame(var_, 'H5AD var');

    const hasX = rootKeys.includes('X');
    let nObs = 0;
    let nVars = 0;
    let obsKeys = [...obsSchema.columnOrder];
    let varNames = [];

    // Check for X matrix and its format
    if (hasX) {
      const X = root.get('X');

      // Check if X is a group (sparse) or dataset (dense)
      if (X.type === 'Group') {
        // Sparse matrix
        const sparse = readSparseMatrixMetadata(X, 'Sparse X');
        const encodingType = sparse.encodingType;
        console.log(`[H5adLoader] X is sparse (${encodingType})`);
        nObs = sparse.shape[0];
        nVars = sparse.shape[1];
      } else {
        // Dense matrix
        validateCurrentH5ArrayEncoding(X, 'Dense X', 'array');
        const shape = h5DatasetShape(X, 'Dense X', 2);
        if (!isAnnDataNumericValueKind(h5DatasetKind(X))) {
          throw new Error('Dense X must use a numeric dtype');
        }
        nObs = shape[0];
        nVars = shape[1];
      }
    }

    const { length: obsLength } = readH5DataFrameIndex(
      obs.get(obsSchema.indexKey),
      'Observation index',
      hasX ? nObs : null
    );
    if (!hasX) nObs = obsLength;
    for (const key of obsKeys) {
      validateH5DataFrameColumnAxis(
        obs,
        key,
        'Observation dataframe',
        nObs
      );
    }

    const { length: varLength, values: rawNames } =
      readH5DataFrameIndex(
        var_.get(varSchema.indexKey),
        'Variable index',
        hasX ? nVars : null,
        true
      );
    if (!hasX) nVars = varLength;
    // A repeated name is kept as stored: the adapter makes the gene list
    // unique with the data-mapping rule, as cellucid serve does.
    varNames = rawNames;
    for (const key of varSchema.columnOrder) {
      validateH5DataFrameColumnAxis(
        var_,
        key,
        'Variable dataframe',
        nVars
      );
    }

    // obsm, when present, must be a current AnnData mapping; its entries are
    // described by probeMapping().
    if (rootKeys.includes('obsm')) {
      requireCurrentH5Mapping(root.get('obsm'), 'H5AD obsm mapping');
    }

    // Edge case validation: empty AnnData
    if (nObs === 0) {
      console.warn('[H5adLoader] AnnData has 0 cells - this may cause issues');
    }

    // Edge case: no X matrix
    if (!hasX) {
      console.warn('[H5adLoader] No X matrix found in AnnData - gene expression will not be available');
    }

    this._nObs = nObs;
    this._nVars = nVars;
    this._obsKeys = obsKeys;
    this._varNames = varNames;
  }

  /**
   * Get number of observations (cells)
   * @returns {number}
   */
  get nObs() {
    return this._nObs;
  }

  /**
   * Get number of variables (genes)
   * @returns {number}
   */
  get nVars() {
    return this._nVars;
  }

  /**
   * Get observation metadata keys
   * @returns {string[]}
   */
  get obsKeys() {
    return [...this._obsKeys];
  }

  /**
   * Get variable (gene) names
   * @returns {string[]}
   */
  get varNames() {
    return [...this._varNames];
  }

  /**
   * Whether this AnnData object contains an expression matrix.
   * Variable metadata may exist independently when AnnData.X is None.
   * @returns {boolean}
   */
  get hasExpressionMatrix() {
    return this._file?.keys?.().includes('X') === true;
  }

  /**
   * Check if file is open
   * @returns {boolean}
   */
  get isOpen() {
    return this._file !== null;
  }

  /**
   * Describe, from HDF5 metadata alone, every element the data-mapping
   * catalog lists: the `obsm` and `obsp` entries, the var columns, `X`, the
   * layers and `raw`. No array value is read. An element this reader cannot
   * classify is listed as storage `other` rather than refused: the catalog
   * reports it as unusable with its reason.
   *
   * @returns {Promise<import('./data-mapping-candidates.js').AnnDataProbes>}
   */
  async probeMapping() {
    this._ensureOpen();
    const root = this._file;
    const rootKeys = root.keys();
    const mappingProbes = (name) => {
      if (!rootKeys.includes(name)) return [];
      const group = requireCurrentH5Mapping(root.get(name), `H5AD ${name} mapping`);
      return group.keys().map(key => probeH5Element(key, group.get(key)));
    };
    let raw = null;
    if (rootKeys.includes('raw')) {
      const rawGroup = root.get('raw');
      const rawKeys = rawGroup?.type === 'Group' ? rawGroup.keys() : [];
      if (rawKeys.includes('X')) {
        const rawX = probeH5Element('X', rawGroup.get('X'));
        raw = {
          nVars: rawX.shape?.length === 2 ? rawX.shape[1] : 0,
          X: { storage: rawX.storage, dtype: rawX.dtype },
          varColumns: rawKeys.includes('var')
            ? probeH5VarColumns(rawGroup.get('var'))
            : [],
        };
      }
    }
    let matrixX = null;
    if (rootKeys.includes('X')) {
      const probe = probeH5Element('X', root.get('X'));
      matrixX = { storage: probe.storage, dtype: probe.dtype };
    }
    return {
      nObs: this._nObs,
      nVars: this._nVars,
      obsm: mappingProbes('obsm'),
      obsp: mappingProbes('obsp'),
      varColumns: probeH5VarColumns(root.get('var')),
      X: matrixX,
      layers: mappingProbes('layers'),
      raw,
    };
  }

  /**
   * Read the selected columns of one dense `obsm` array, unnormalized, one row
   * per cell. A one-dimensional array is one column. All columns are read in
   * one pass when they span the whole array; otherwise one hyperslab is read,
   * covering the selected columns when that slab is at most twice as wide as
   * the selection, or one hyperslab per column when it is not.
   *
   * @param {string} key - Exact obsm key
   * @param {ReadonlyArray<number>} columns - Distinct 0-based columns, in output order
   * @returns {Promise<Float64Array>} `n_obs * columns.length` values, row-major
   */
  /**
   * One dense numeric `obsm` array, checked: one row per cell, one or two
   * dimensions.
   * @private
   */
  _obsmDataset(key) {
    const label = `obsm['${key}']`;
    const obsm = requireCurrentH5Mapping(
      this._file.get('obsm'),
      'H5AD obsm mapping'
    );
    if (!obsm.keys().includes(key)) {
      throw new Error(`${label} does not exist in this file`);
    }
    const dataset = obsm.get(key);
    validateCurrentH5ArrayEncoding(dataset, label, 'array');
    const shape = h5DatasetShape(dataset, label);
    if (shape.length !== 1 && shape.length !== 2) {
      throw new Error(`${label} must be a one- or two-dimensional array`);
    }
    if (shape[0] !== this._nObs) {
      throw new Error(
        `${label} has ${shape[0]} rows but the dataset has ${this._nObs} cells`
      );
    }
    if (!isAnnDataNumericValueKind(h5DatasetKind(dataset))) {
      throw new Error(`${label} must use a numeric dtype`);
    }
    const width = shape.length === 1 ? 1 : shape[1];
    return { dataset, shape, width, label };
  }

  /**
   * Every row of `obsm[key]`, every column, in row order, one slab at a
   * time, so the array is never held whole: `visit(block, rowStart, rowEnd)`
   * receives row-major values (numbers, or BigInts for 64-bit integers) and
   * runs synchronously. The WASM heap holds one slab at a time.
   *
   * @param {string} key
   * @param {(block: ArrayLike<number|bigint>, rowStart: number, rowEnd: number) => void} visit
   * @returns {Promise<number>} The array's width
   */
  async forEachObsmRowSlab(key, visit) {
    this._ensureOpen();
    const generation = this._generation;
    const { dataset, shape, width, label } = this._obsmDataset(key);
    if (shape.length === 1) {
      readH5RowSlabs1D(dataset, shape[0], (block, rowStart) => {
        visit(block, rowStart, rowStart + block.length);
      });
    } else {
      readH5RowSlabs2D(dataset, shape[0], 0, width, visit);
    }
    this._assertGeneration(generation, `reading ${label}`);
    return width;
  }

  async readObsmColumns(key, columns) {
    this._ensureOpen();
    const generation = this._generation;
    const { dataset, shape, width, label } = this._obsmDataset(key);
    const selected = requireObsmColumnSelection(columns, width, label);
    const nRows = shape[0];
    const nColumns = selected.length;
    const result = allocateTypedArray(Float64Array, nRows * nColumns, label);
    const toNumber = value => (typeof value === 'bigint' ? Number(value) : value);
    if (shape.length === 1) {
      readH5RowSlabs1D(dataset, nRows, (block, rowStart) => {
        for (let row = 0; row < block.length; row++) {
          result[rowStart + row] = toNumber(block[row]);
        }
      });
    } else {
      const first = Math.min(...selected);
      const last = Math.max(...selected) + 1;
      // One slab spanning the selection when it is at most twice as wide as
      // the selection, else one hyperslab per column; either way in row
      // slabs, so the WASM heap holds one slab at a time.
      const ranges = last - first <= 2 * nColumns
        ? [[first, last, selected.map((column, index) => [column, index])]]
        : selected.map((column, index) => [column, column + 1, [[column, index]]]);
      for (const [from, to, picks] of ranges) {
        const blockWidth = to - from;
        readH5RowSlabs2D(dataset, nRows, from, to, (block, rowStart, rowEnd) => {
          for (const [column, outputColumn] of picks) {
            const offset = column - from;
            for (let row = rowStart; row < rowEnd; row++) {
              result[row * nColumns + outputColumn] =
                toNumber(block[(row - rowStart) * blockWidth + offset]);
            }
          }
        });
      }
    }
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
      frame = this._file.get('var');
      label = 'var';
      index = this._varNames;
    } else if (axis === 'raw') {
      const raw = this._file.keys().includes('raw') ? this._file.get('raw') : null;
      if (raw?.type !== 'Group' || !raw.keys().includes('var') || !raw.keys().includes('X')) {
        throw new Error('This file has no raw var axis');
      }
      frame = raw.get('var');
      label = 'raw.var';
      const rawX = raw.get('X');
      const nRawVars = rawX.type === 'Group'
        ? readSparseMatrixMetadata(rawX, 'raw.X').shape[1]
        : h5DatasetShape(rawX, 'raw.X', 2)[1];
      const { indexKey } = validateCurrentH5DataFrame(frame, 'H5AD raw.var');
      index = readH5DataFrameIndex(frame.get(indexKey), 'Raw variable index', nRawVars, true).values;
    } else {
      throw new TypeError(`Unknown var axis '${String(axis)}'`);
    }
    let values;
    if (column === null) {
      values = index;
    } else {
      const { columnOrder } = validateCurrentH5DataFrame(frame, `H5AD ${label}`);
      if (!columnOrder.includes(column)) {
        throw new Error(`${label} has no column '${column}'`);
      }
      values = readH5GeneNameColumn(frame, column, `${label}['${column}']`, index.length);
    }
    this._assertGeneration(generation, `reading the gene names of ${label}`);
    const result = Object.freeze({ index, values });
    this._cache.set(cacheKey, result);
    return result;
  }

  /**
   * The HDF5 node, shape and label of one expression matrix: `X`,
   * `layers/<name>` or `raw/X`.
   *
   * @param {string} element
   * @returns {{node: Object, label: string, nVars: number}}
   * @private
   */
  _requireMatrixElement(element) {
    const root = this._file;
    const rootKeys = root.keys();
    if (element === 'X') {
      if (!rootKeys.includes('X')) {
        throw new Error('This file has no X expression matrix');
      }
      return { node: root.get('X'), label: 'X', nVars: this._nVars };
    }
    if (element === 'raw/X') {
      const raw = rootKeys.includes('raw') ? root.get('raw') : null;
      if (raw?.type !== 'Group' || !raw.keys().includes('X')) {
        throw new Error('This file has no raw.X expression matrix');
      }
      const node = raw.get('X');
      const shape = node.type === 'Group'
        ? readSparseMatrixMetadata(node, 'raw.X').shape
        : h5DatasetShape(node, 'raw.X', 2);
      return { node, label: 'raw.X', nVars: shape[1] };
    }
    if (typeof element === 'string' && element.startsWith('layers/')) {
      const name = element.slice('layers/'.length);
      const layers = rootKeys.includes('layers')
        ? requireCurrentH5Mapping(root.get('layers'), 'H5AD layers mapping')
        : null;
      if (name.length === 0 || name.includes('/') || layers === null || !layers.keys().includes(name)) {
        throw new Error(`This file has no layer '${name}'`);
      }
      return { node: layers.get(name), label: `layers['${name}']`, nVars: this._nVars };
    }
    throw new TypeError(`Unknown expression matrix '${String(element)}'`);
  }

  /**
   * Read one column of one expression matrix -- one gene's value in every
   * cell -- as float32. `element` is `X`, `layers/<name>` or `raw/X`; `index`
   * is the gene's position on that matrix's var axis.
   *
   * How a column is reached depends on the layout, and only what one gene
   * needs is read: a CSC matrix reads that gene's entries; a chunked dense
   * matrix reads the chunk strip holding it; a CSR or contiguous dense matrix
   * is transposed once, streaming, into a column store. One matrix is
   * resident at a time; reading another releases the previous one.
   *
   * @param {string} element
   * @param {number} index
   * @returns {Promise<Float32Array>}
   */
  async getMatrixColumn(element, index) {
    this._ensureOpen();
    const generation = this._generation;
    const { label, nVars } = this._requireMatrixElement(element);
    if (!Number.isSafeInteger(index) || index < 0 || index >= nVars) {
      throw new RangeError(`${label} has no gene column ${String(index)}`);
    }
    const columns = await this._matrixColumns(element, generation);
    const result = await columns.column(index, generation);
    this._assertGeneration(generation, `loading gene column ${index} of ${label}`);
    return result;
  }

  /**
   * Start indexing one expression matrix by gene in the background, when its
   * layout needs it (CSR, contiguous dense), so the first gene shown does not
   * wait for the whole build: called as soon as the dataset says which matrix
   * its genes come from. Returns at once; a failure reaches the gene reads.
   *
   * @param {string} element
   */
  prepareMatrix(element) {
    this._ensureOpen();
    const generation = this._generation;
    this._matrixColumns(element, generation)
      .then(columns => columns.prepare?.())
      .catch(() => {});
  }

  /**
   * The column access of one matrix, opened once and shared: concurrent
   * first reads must not each start an index. Opening another matrix
   * releases the previous one.
   *
   * @private
   */
  async _matrixColumns(element, generation) {
    const { node: matrix, label, nVars } = this._requireMatrixElement(element);
    if (this._matrix?.element !== element) {
      this._releaseMatrix();
      this._matrix = { element, columns: null, loadPromise: null };
    }
    const state = this._matrix;
    if (state.columns) return state.columns;
    state.loadPromise ??= this._openMatrixColumns(
      matrix,
      label,
      nVars,
      element,
      generation
    );
    const loadPromise = state.loadPromise;
    let columns;
    try {
      columns = await loadPromise;
    } finally {
      if (state.loadPromise === loadPromise) state.loadPromise = null;
    }
    this._assertGeneration(generation, `loading ${label}`);
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
      // A failed read is not kept: the next read of this matrix starts over
      // (a transient read error must not stick to the dataset).
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
    // An index still opening is disposed when it lands (`_matrixColumns`).
    this._decodedXBlocks.clear();
  }

  /**
   * How the columns of one matrix are read.
   *
   * @returns {Promise<{column: (index: number, generation: number) => Float32Array|Promise<Float32Array>}>}
   * @private
   */
  async _openMatrixColumns(matrix, label, nVars, element, generation) {
    const nObs = this._nObs;
    // Between slabs, queued requests (field reads) get their turn: an index
    // build never blocks the reader.
    const indexOptions = {
      nRows: nObs,
      nCols: nVars,
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

    if (matrix.type === 'Group') {
      const sparse = readSparseMatrixMetadata(matrix, `Sparse ${label}`);
      if (sparse.shape[0] !== nObs || sparse.shape[1] !== nVars) {
        throw new Error(
          `Sparse ${label} shape ${sparse.shape[0]}×${sparse.shape[1]} does not match ${nObs} cells and ${nVars} genes`
        );
      }
      const dataLabel = `Sparse ${label} data`;
      const indexLabel = `Sparse ${label} index`;
      const readValues = (start, end) => readH5Range1D(
        sparse.dataDataset,
        start,
        end,
        count => allocateTypedArray(Float32Array, count, dataLabel),
        (slab, output, offset) => convertSlabToFloat32(slab, output, offset, dataLabel),
        dataLabel
      );
      const readIndices = (start, end) => readH5IntegerRange(
        sparse.indicesDataset,
        start,
        end,
        indexLabel
      );
      const readPointers = (start, end) => readH5IntegerRange(
        sparse.indptrDataset,
        start,
        end,
        `Sparse ${label} indptr`
      );

      if (sparse.format === 'csc') {
        // Column pointers once; each gene then reads only its own entries.
        const pointers = readH5Range1D(
          sparse.indptrDataset,
          0,
          nVars + 1,
          count => allocateTypedArray(Float64Array, count, `Sparse ${label} indptr`),
          (slab, output, offset) => {
            for (let i = 0; i < slab.length; i++) output[offset + i] = Number(slab[i]);
          },
          `Sparse ${label} indptr`
        );
        if (pointers[0] !== 0) {
          throw new Error(`Sparse ${label} indptr must start at zero`);
        }
        for (let i = 1; i < pointers.length; i++) {
          if (!(pointers[i] >= pointers[i - 1])) {
            throw new Error(`Sparse ${label} indptr must be monotonic`);
          }
        }
        if (pointers[nVars] !== sparse.dataLength) {
          throw new Error(
            `Sparse ${label} indptr last value must equal the non-zero count (${sparse.dataLength})`
          );
        }
        return {
          column: (gene) => {
            const start = pointers[gene];
            const end = pointers[gene + 1];
            const result = new Float32Array(nObs);
            if (end === start) return result;
            const rows = readIndices(start, end);
            const values = readValues(start, end);
            for (let entry = 0; entry < rows.length; entry++) {
              const row = Number(rows[entry]);
              if (!(row >= 0 && row < nObs) || !Number.isInteger(row)) {
                throw new RangeError(
                  `Sparse column row index ${row} at entry ${start + entry} is outside its ` +
                  `${nObs}-row shape`
                );
              }
              result[row] = addSparseFloat32(result[row], values[entry]);
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

    // Dense matrix.
    validateCurrentH5ArrayEncoding(matrix, `Dense ${label}`, 'array');
    const shape = h5DatasetShape(matrix, `Dense ${label}`, 2);
    if (shape[0] !== nObs || shape[1] !== nVars) {
      throw new Error(
        `Dense ${label} shape ${shape[0]}×${shape[1]} does not match ${nObs} cells and ${nVars} genes`
      );
    }
    const kind = h5DatasetKind(matrix);
    if (!isAnnDataNumericValueKind(kind)) {
      throw new Error(`Dense ${label} must use a numeric dtype`);
    }
    if (typeof matrix.slice !== 'function') {
      throw new Error(`Dense ${label} Dataset.slice support is required`);
    }
    const chunks = h5DenseChunkShape(matrix, shape);
    // Narrow chunks: a gene's chunk strip fits the decoded-block cache and
    // is shared with its neighbours. Chunks spanning many genes (or none, a
    // contiguous matrix) would make every gene decode the whole matrix again,
    // so those are indexed once instead.
    if (chunks !== null && nObs * chunks[1] * 4 <= this._decodedXBlocks.capacityBytes) {
      // Chunked: each gene decodes the chunk strip holding it, shared with
      // the other genes of that strip through the decoded-block cache.
      return {
        column: async (gene, columnGeneration) => {
          const column = await this._readChunkedDenseColumn(
            matrix,
            shape,
            chunks,
            gene,
            columnGeneration,
            element
          );
          if (!column || column.length !== nObs) {
            throw new Error(
              `Dense ${label} column payload length does not match the cell count`
            );
          }
          return toFloat32Array(column, `Dense ${label}`);
        },
      };
    }
    // Row-major storage read in row slabs (aligned to the chunk rows when
    // chunked), indexed once; every gene is then a copy.
    return fromIndex(new RowMajorColumnIndex({
      ...indexOptions,
      label: `Dense ${label}`,
      layout: 'dense',
      slabEntries: Math.max(nVars, Math.floor(SLAB_BYTES / h5DatasetElementBytes(matrix))),
      readRows: (rowStart, rowEnd) => {
        const block = matrix.slice([[rowStart, rowEnd], [0, nVars]]);
        if (!ArrayBuffer.isView(block) || block.length !== (rowEnd - rowStart) * nVars) {
          throw new Error(`Dense ${label} row slab does not match its selection`);
        }
        return toFloat32Array(block, `Dense ${label}`);
      },
    }));
  }

  /**
   * Read one column of a chunked dense X through the decoded-block cache.
   *
   * HDF5 decodes a filtered chunk whole even when only one column of it is
   * selected, so each chunk-aligned block of the column's strip is read once
   * and kept for the other genes of that strip.
   *
   * @param {Object} X - h5wasm Dataset
   * @param {number[]} shape - Exact `[n_obs, n_vars]`
   * @param {number[]} chunks - Exact HDF5 chunk shape `[rows, cols]`
   * @param {number} geneIdx
   * @param {number} generation
   * @param {string} element - The matrix the column belongs to
   * @returns {Promise<ArrayLike<number|bigint>>}
   * @private
   */
  async _readChunkedDenseColumn(X, shape, chunks, geneIdx, generation, element) {
    const [nRows, nCols] = shape;
    const [chunkRows, chunkCols] = chunks;
    const colStart = Math.floor(geneIdx / chunkCols) * chunkCols;
    const colEnd = Math.min(colStart + chunkCols, nCols);
    const blockWidth = colEnd - colStart;
    const colInBlock = geneIdx - colStart;
    const stripKey = `${element}/${colStart}`;
    let column = null;
    for (let rowStart = 0; rowStart < nRows; rowStart += chunkRows) {
      const rowEnd = Math.min(rowStart + chunkRows, nRows);
      const blockLength = (rowEnd - rowStart) * blockWidth;
      const block = await this._decodedXBlocks.read(
        `${element}/${rowStart}/${colStart}`,
        stripKey,
        () => {
          const values = X.slice([
            [rowStart, rowEnd],
            [colStart, colEnd]
          ]);
          if (!ArrayBuffer.isView(values) || values.length !== blockLength) {
            throw new Error(
              `Dense ${element} chunk block payload length does not match its selection`
            );
          }
          return values;
        }
      );
      this._assertGeneration(generation, 'loading a dense X column');
      column ??= new block.constructor(nRows);
      for (let row = rowStart; row < rowEnd; row++) {
        column[row] = block[(row - rowStart) * blockWidth + colInBlock];
      }
    }
    return column;
  }

  /**
   * Read categorical labels once per loader generation.
   * @param {{categories: Object}} categoricalColumn
   * @param {string} key
   * @param {number} generation
   * @returns {ReadonlyArray<unknown>}
   * @private
   */
  _getCategoricalCategories(categoricalColumn, key, generation) {
    const cacheKey = `obs_categories:${key}`;
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey);
    }

    const categories = readH5CategoricalCategories(
      categoricalColumn.categories,
      key
    );
    this._assertGeneration(
      generation,
      `reading categorical labels for '${key}'`
    );
    this._cache.set(cacheKey, categories);
    return categories;
  }

  /**
   * Inspect an observation field's logical type without materializing category
   * labels or values. Dataset statistics use this path so source validation
   * cannot eagerly retain every category dictionary.
   *
   * @param {string} key
   * @returns {Promise<{dtype: string, categoryCount?: number}>}
   * @private
   */
  async _getObsFieldTypeInfo(key) {
    this._ensureOpen();
    const generation = this._generation;
    const cacheKey = `obs_type:${key}`;
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey);
    }

    const obs = this._file.get('obs');
    if (!obs || !obs.keys().includes(key)) {
      throw new Error(`Obs field '${key}' not found`);
    }
    const item = obs.get(key);
    const currentEncoding =
      validateCurrentH5DataFrameColumnEncoding(
        item,
        `Observation field '${key}'`
      );
    const categoricalColumn = resolveH5adCategoricalColumn(obs, key);
    const encodingType = currentEncoding;
    let result;

    if (categoricalColumn) {
      validateCurrentH5ArrayEncoding(
        categoricalColumn.codes,
        `Categorical codes for '${key}'`,
        'array'
      );
      validateOneDimensionalH5Dataset(
        categoricalColumn.codes,
        `Categorical codes for '${key}'`,
        this._nObs
      );
      if (!isSignedH5IntegerDataset(categoricalColumn.codes)) {
        throw new Error(
          `Categorical codes for '${key}' must use a signed integer dtype`
        );
      }

      let categoryCount;
      const categoriesDataset = categoricalColumn.categories;
      if (categoriesDataset?.type === 'Group') {
        const categoryEncoding = h5EncodingType(categoriesDataset);
        if (categoryEncoding !== 'nullable-string-array') {
          throw new Error(
            `Categorical categories for '${key}' use unsupported encoding '${categoryEncoding}'`
          );
        }
        const contract = validateNullableH5Contract(
          categoriesDataset,
          `${key}' categories`,
          categoryEncoding,
          null
        );
        categoryCount = validateH5CategoryCount(
          contract.valuesLength,
          key
        );
      } else {
        validateCurrentH5ArrayEncoding(
          categoriesDataset,
          `Categorical categories for '${key}'`
        );
        categoryCount = validateH5CategoryCount(
          validateOneDimensionalH5Dataset(
            categoriesDataset,
            `Categorical categories for '${key}'`
          ),
          key
        );
        const kind = h5DatasetKind(categoriesDataset);
        if (!['string', 'float', 'int', 'uint', 'bool'].includes(kind)) {
          throw new Error(
            `Categorical categories for '${key}' must use a numeric, boolean, or string dtype`
          );
        }
      }
      result = {
        dtype: 'categorical',
        categoryCount,
        ordered: categoricalColumn.ordered
      };
    } else if (
      encodingType === 'nullable-integer' ||
      encodingType === 'nullable-boolean' ||
      encodingType === 'nullable-string-array'
    ) {
      const contract = validateNullableH5Contract(
        item,
        key,
        encodingType,
        this._nObs
      );
      result = {
        dtype: encodingType === 'nullable-integer'
          ? (contract.valuesKind === 'uint' ? 'uint' : 'int')
          : (encodingType === 'nullable-boolean' ? 'bool' : 'string')
      };
    } else {
      validateOneDimensionalH5Dataset(
        item,
        `Observation field '${key}'`,
        this._nObs
      );
      result = {
        dtype: classifyH5WasmDtype(item.dtype, item.metadata)
      };
    }

    this._assertGeneration(
      generation,
      `reading observation field type '${key}'`
    );
    this._cache.set(cacheKey, result);
    return result;
  }

  /**
   * Get obs field metadata without loading all values (for lazy loading)
   * @param {string} key - Field name
   * @returns {Promise<{dtype: string, categories?: string[]}>}
   */
  async getObsFieldInfo(key) {
    this._ensureOpen();
    const generation = this._generation;

    const cacheKey = `obs_info:${key}`;
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey);
    }

    const obs = this._file.get('obs');
    if (!obs || !obs.keys().includes(key)) {
      throw new Error(`Obs field '${key}' not found`);
    }

    const item = obs.get(key);
    const currentEncoding =
      validateCurrentH5DataFrameColumnEncoding(
        item,
        `Observation field '${key}'`
      );
    const categoricalColumn = resolveH5adCategoricalColumn(obs, key);
    const encodingType = currentEncoding;
    let result;

    if (categoricalColumn) {
      // Only load categories, not codes (codes are large)
      validateCurrentH5ArrayEncoding(
        categoricalColumn.codes,
        `Categorical codes for '${key}'`,
        'array'
      );
      validateOneDimensionalH5Dataset(
        categoricalColumn.codes,
        `Categorical codes for '${key}'`,
        this._nObs
      );
      if (!isSignedH5IntegerDataset(categoricalColumn.codes)) {
        throw new Error(
          `Categorical codes for '${key}' must use a signed integer dtype`
        );
      }
      const categories = this._getCategoricalCategories(
        categoricalColumn,
        key,
        generation
      );
      result = {
        dtype: 'categorical',
        categories,
        ordered: categoricalColumn.ordered,
      };
    } else if (
      encodingType === 'nullable-integer' ||
      encodingType === 'nullable-boolean' ||
      encodingType === 'nullable-string-array'
    ) {
      const contract = validateNullableH5Contract(
        item,
        key,
        encodingType,
        this._nObs
      );
      result = {
        dtype: encodingType === 'nullable-integer'
          ? (contract.valuesKind === 'uint' ? 'uint' : 'int')
          : (encodingType === 'nullable-boolean' ? 'bool' : 'string')
      };
    } else {
      validateOneDimensionalH5Dataset(
        item,
        `Observation field '${key}'`,
        this._nObs
      );
      result = {
        dtype: classifyH5WasmDtype(item.dtype, item.metadata)
      };
    }

    this._assertGeneration(
      generation,
      `reading observation field metadata '${key}'`
    );
    this._cache.set(cacheKey, result);
    return result;
  }

  /**
   * Get obs (cell metadata) field values
   * @param {string} key - Field name
   * @returns {Promise<{values: any[], dtype: string, categories?: string[], codes?: Int32Array}>}
   */
  async getObsField(key) {
    this._ensureOpen();
    const generation = this._generation;

    const cacheKey = `obs:${key}`;
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey);
    }

    const obs = this._file.get('obs');
    if (!obs || !obs.keys().includes(key)) {
      throw new Error(`Obs field '${key}' not found`);
    }

    const item = obs.get(key);
    const currentEncoding =
      validateCurrentH5DataFrameColumnEncoding(
        item,
        `Observation field '${key}'`
      );
    const categoricalColumn = resolveH5adCategoricalColumn(obs, key);
    const encodingType = currentEncoding;
    let result;

    if (categoricalColumn) {
      // Categorical column - use safe conversion for int64 dtypes
      const categories = this._getCategoricalCategories(
        categoricalColumn,
        key,
        generation
      );
      const codes = readH5CategoricalCodes(
        categoricalColumn.codes,
        categories.length,
        key,
        this._nObs
      );

      // MEMORY OPTIMIZATION: Don't eagerly compute values array for categorical fields.
      // Most code paths use codes + categories directly. Only compute values on-demand.
      result = {
        dtype: 'categorical',
        codes,
        categories,
        ordered: categoricalColumn.ordered,
        // Lazy getter for values, computed only if accessed.
        get values() {
          // Cache the computed values on first access
          const computed = Array.from(codes, c => c >= 0 ? categories[c] : null);
          Object.defineProperty(this, 'values', { value: computed, writable: false });
          return computed;
        }
      };
    } else if (
      encodingType === 'nullable-integer' ||
      encodingType === 'nullable-boolean' ||
      encodingType === 'nullable-string-array'
    ) {
      result = readNullableH5Values(
        item,
        key,
        encodingType,
        this._nObs
      );
    } else {
      // Regular column
      const length = validateOneDimensionalH5Dataset(
        item,
        `Observation field '${key}'`,
        this._nObs
      );
      const metadataDtype = requireSupportedPrimitiveH5Dtype(
        item,
        `Observation field '${key}'`
      );
      const dtype = metadataDtype;
      const label = `Observation field '${key}'`;
      let values;
      if (dtype === 'float' || dtype === 'int' || dtype === 'uint') {
        values = readH5Float32(item, length, label);
      } else {
        values = readH5Values1D(item, length, label);
        if (dtype === 'bool') {
          const message =
            `Observation field '${key}' contains a non-boolean value`;
          for (let index = 0; index < length; index++) {
            values[index] = decodeAnnDataBoolean(values[index], message);
          }
        }
      }
      result = { dtype, values };
    }

    this._assertGeneration(generation, `reading observation field '${key}'`);
    this._cache.set(cacheKey, result);
    return result;
  }

  /**
   * Restore a category dictionary retained by the adapter after this loader's
   * transient caches were cleared. The canonical immutable array is shared by
   * identity, so labels are not decoded and retained a second time.
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
    const categoriesKey = `obs_categories:${key}`;
    const infoKey = `obs_info:${key}`;
    if (!this._cache.has(categoriesKey)) {
      this._cache.set(categoriesKey, categories);
    }
    if (!this._cache.has(infoKey)) {
      this._cache.set(infoKey, {
        dtype: 'categorical',
        categories,
        ordered
      });
    }
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
   * Release one loader-owned observation payload and category aliases already
   * retained by the adapter. Identity protects a newer independent result.
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

    const categoriesKey = `obs_categories:${key}`;
    if (this._cache.get(categoriesKey) === categories) {
      this._cache.delete(categoriesKey);
    }
    const infoKey = `obs_info:${key}`;
    const info = this._cache.get(infoKey);
    if (info?.dtype === 'categorical' &&
        info.categories === categories) {
      this._cache.delete(infoKey);
    }
  }

  /**
   * Validate one neighbour graph's metadata (`obsp[key]`) without
   * materializing its payload, or return null when `obsp` has no such key.
   * @param {string} key - An `obsp` key.
   * @returns {Promise<Object|null>}
   * @private
   */
  async _getConnectivityMetadata(key) {
    this._ensureOpen();
    requireObspKey(key);
    const generation = this._generation;
    const cacheKey = `connectivity:metadata:${key}`;
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey);
    }

    const rootKeys = this._file.keys();
    if (!rootKeys.includes('obsp')) {
      this._cache.set(cacheKey, null);
      return null;
    }
    const obsp = this._file.get('obsp');
    requireCurrentH5Mapping(obsp, 'H5AD obsp mapping');
    if (!obsp.keys().includes(key)) {
      this._cache.set(cacheKey, null);
      return null;
    }

    const conn = obsp.get(key);
    let result;
    if (conn?.type === 'Group') {
      const sparse = readSparseMatrixMetadata(
        conn,
        'Connectivity matrix'
      );
      if (sparse.shape[0] !== this._nObs ||
          sparse.shape[1] !== this._nObs) {
        throw new Error(
          `Connectivity matrix shape ${sparse.shape[0]}×${sparse.shape[1]} does not match ${this._nObs} cells`
        );
      }
      result = {
        kind: 'sparse',
        sparse,
      };
    } else {
      validateCurrentH5ArrayEncoding(
        conn,
        'Dense connectivity matrix',
        'array'
      );
      const shape = h5DatasetShape(conn, 'Dense connectivity matrix', 2);
      if (shape[0] !== this._nObs || shape[1] !== this._nObs) {
        throw new Error(
          `Connectivity matrix shape ${shape[0]}×${shape[1]} does not match ${this._nObs} cells`
        );
      }
      const kind = h5DatasetKind(conn);
      if (!isAnnDataMatrixDataKind(kind)) {
        throw new Error('Dense connectivity matrix must use a numeric dtype');
      }
      result = {
        dataset: conn,
        kind: 'dense',
        shape,
        valueKind: kind,
      };
    }

    this._assertGeneration(generation, 'reading connectivity metadata');
    this._cache.set(cacheKey, result);
    return result;
  }

  /**
   * Report whether `obsp[key]` holds a neighbour graph.
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
    if (metadata === null) return null;

    let result;
    if (metadata.kind === 'dense') {
      const expectedLength = h5ElementCount(
        metadata.shape,
        'Dense connectivity matrix'
      );
      const [nRows, nCols] = metadata.shape;
      let rawData = null;
      readH5RowSlabs2D(metadata.dataset, nRows, 0, nCols, (block, rowStart) => {
        rawData ??= allocateTypedArray(
          block.constructor,
          expectedLength,
          'Dense connectivity matrix'
        );
        rawData.set(block, rowStart * nCols);
      });
      rawData ??= new Float64Array(0);
      result = {
        data: rawData,
        format: 'dense',
        shape: metadata.shape,
      };
    } else {
      const obsp = requireCurrentH5Mapping(
        this._file.get('obsp'),
        'H5AD obsp mapping'
      );
      result = readSparseMatrix(
        obsp.get(key),
        'Connectivity matrix',
        'exact'
      );
    }

    this._assertGeneration(generation, 'loading connectivity data');
    return result;
  }

  /**
   * Ensure file is open
   * @private
   */
  _ensureOpen() {
    if (this._closed || !this._file) {
      throw new Error('No h5ad file is open. Call open() first.');
    }
  }

  /**
   * Reject work completed against an earlier cache or dataset lifecycle.
   * @param {number} generation
   * @param {string} operation
   * @private
   */
  _assertGeneration(generation, operation = 'loading H5AD data') {
    if (this._closed || generation !== this._generation) {
      throw new Error(
        `H5AD dataset changed, cache was cleared, or file was closed while ${operation}; the request was superseded`
      );
    }
  }

  /**
   * Get dataset metadata for Cellucid format
   * @returns {Promise<Object>}
   */
  async getDatasetMetadata() {
    this._ensureOpen();
    const generation = this._generation;

    // Which embedding each dimension shows is the adapter's decision, made
    // from these probes by the data-mapping rules (default, then best guess).
    const probes = await this.probeMapping();
    this._assertGeneration(generation, 'building dataset metadata');

    // Count logical field types without materializing category dictionaries.
    let nCategorical = 0;
    let nContinuous = 0;

    for (const key of this._obsKeys) {
      const fieldInfo = await this._getObsFieldTypeInfo(key);
      this._assertGeneration(generation, 'building dataset metadata');
      if (fieldInfo.dtype === 'categorical') {
        nCategorical++;
      } else if (fieldInfo.dtype === 'float' || fieldInfo.dtype === 'int' || fieldInfo.dtype === 'uint') {
        nContinuous++;
      }
    }

    // The graph a file opens with is obsp['connectivities'] (the data
    // mapping's default); any other is read only when it is chosen.
    const hasConnectivity = await this.hasConnectivities(DEFAULT_KNN_KEY);
    this._assertGeneration(generation, 'building dataset metadata');

    // This is an adapter-construction descriptor, not a public dataset
    // identity. H5adDataSource publishes the sole validated v3 identity only
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
   * Clear all cached data to free memory
   */
  clearCache() {
    this._generation++;
    this._cache.clear();
    this._releaseMatrix();
  }

  /**
   * Release the active HDF5 file without changing the open-request epoch.
   * @private
   */
  _releaseCurrentState() {
    let releaseFailure = null;
    const recordReleaseFailure = failure => {
      const exactFailure = failure instanceof Error
        ? failure
        : new TypeError(
            'H5AD resource release must reject with an Error.',
            { cause: failure }
          );
      releaseFailure = releaseFailure === null
        ? exactFailure
        : combineDatasetLifecycleFailures(
            releaseFailure,
            exactFailure,
            'Multiple H5AD resources failed to release.'
          );
    };

    if (this._file) {
      try {
        this._file.close();
        this._file = null;
      } catch (failure) {
        recordReleaseFailure(failure);
      }
    }
    if (this._unmount) {
      try {
        this._unmount();
        this._unmount = null;
      } catch (failure) {
        recordReleaseFailure(failure);
      }
    }
    try {
      this.clearCache();
    } catch (failure) {
      recordReleaseFailure(failure);
    }
    this._filename = null;
    this._nObs = 0;
    this._nVars = 0;
    this._obsKeys = [];
    this._varNames = [];
    if (releaseFailure !== null) {
      throw releaseFailure;
    }
  }

  /**
   * Close the file and release resources
   */
  close() {
    if (this._closed && !this._file && !this._unmount) return;
    this._openRequestId++;
    this._closed = true;
    this._releaseCurrentState();
  }
}
