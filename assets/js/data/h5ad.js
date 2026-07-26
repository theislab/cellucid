/**
 * H5AD Module for Cellucid
 *
 * Client-side JavaScript module for AnnData h5ad file support.
 * Provides sparse matrix support without needing a Python server.
 *
 * This module combines:
 * - H5adLoader: Core loader using h5wasm for reading h5ad files
 * - H5adDataSource: Data source providing the standard Cellucid interface
 * - H5adDataProvider: Bridge functions for data source manager integration
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FEATURES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * - Reads h5ad files directly in the browser using h5wasm
 * - Handles sparse matrices (CSR/CSC) with automatic conversion for efficiency
 * - Individual datasets (embeddings, obs fields, genes) loaded on-demand
 * - Lazy loading of gene expression data
 * - Automatic UMAP dimension detection
 * - Provides the same interface as other data sources (local-demo, local-user, remote)
 * - Compatible with the Cellucid data format
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IMPORTANT: PERFORMANCE LIMITATIONS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Browser h5ad loading is NOT truly lazy. Due to browser limitations, the
 * entire h5ad file must be loaded into memory before data can be accessed.
 *
 * For large datasets (>100k cells), consider these alternatives:
 * - prepare() in Python for pre-processed binary files
 * - serve_anndata() Python server which supports true lazy loading via backed mode
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DATA PROVIDER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This module provides a bridge between the standard Cellucid data loaders
 * and the H5AD file loader. When the active data source is an h5ad file,
 * the provider intercepts data requests and fulfills them directly from
 * the h5ad file instead of fetching URLs.
 *
 * This allows the rest of the application to work unchanged while supporting
 * h5ad files as a data source.
 */

import { getNotificationCenter } from '../app/notification-center.js';
import { buildCscFromCsr, getSparseColumn, toInt32Array, toFloat32Array } from './sparse-utils.js';
import { DataSourceError, DataSourceErrorCode } from './data-source.js';
import { BaseAnnDataAdapter } from './base-anndata-adapter.js';
import { getDataSourceManager } from './data-source-manager.js';
import {
  combineDatasetLifecycleFailures,
  createDatasetReloadSupersededError,
} from './dataset-lifecycle-errors.js';
import {
  getMetadataLoadSignal,
  throwIfMetadataAborted,
} from './metadata-load-contract.js';

// ============================================================================
// H5AD LOADER
// ============================================================================

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

/**
 * Check if h5wasm is available
 * @returns {boolean}
 */
export function isH5wasmAvailable() {
  return h5wasm !== null;
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

const MAX_H5AD_MATERIALIZED_ARRAY_BYTES = 512 * 1024 * 1024;
const MAX_H5AD_BROWSER_FILE_BYTES = 512 * 1024 * 1024;
const MAX_REASONABLE_SPARSE_DIMENSION = 50_000_000;
const MAX_REASONABLE_SPARSE_NNZ = 500_000_000;
const MAX_CELLUCID_CATEGORIES = 65_535;
const JS_ARRAY_ELEMENT_BYTES = 8;
const ESTIMATED_JS_STRING_VALUE_BYTES = 64;
const HDF5_SIGNATURE = new Uint8Array([
  0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const MIN_HDF5_SUPERBLOCK_BYTES = 48;

class H5adMaterializationLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'H5adMaterializationLimitError';
  }
}

/**
 * Validate the browser-side H5AD copy before initializing h5wasm or touching
 * the File payload.
 * @param {File|Object} file
 * @returns {number}
 */
export function validateH5adBrowserFileSize(file) {
  const size = file?.size;
  if (!Number.isSafeInteger(size) ||
      size <= 0 ||
      size > MAX_H5AD_BROWSER_FILE_BYTES) {
    throw new Error(
      'H5AD direct browser files must have a positive safe size no larger than 512 MiB; use the Cellucid server or prepared format'
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

async function validateH5adBrowserFileSignature(file, totalBytes) {
  if (typeof file?.slice !== 'function') {
    if (typeof file?.arrayBuffer !== 'function') {
      throw new Error(
        'The selected file is not a valid HDF5/H5AD file. Choose an AnnData .h5ad file or regenerate it with AnnData.'
      );
    }
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const signatureOffset = findHdf5SignatureOffset(bytes);
    if (signatureOffset >= 0) {
      if (
        totalBytes - signatureOffset < MIN_HDF5_SUPERBLOCK_BYTES
      ) {
        throw unreadableH5adError();
      }
      return;
    }
  } else {
    for (const offset of hdf5SignatureOffsets(totalBytes)) {
      const signatureSlice = file.slice(
        offset,
        offset + HDF5_SIGNATURE.length
      );
      const signatureBytes = new Uint8Array(
        await signatureSlice.arrayBuffer()
      );
      if (bytesContainHdf5SignatureAt(signatureBytes, 0)) {
        if (totalBytes - offset < MIN_HDF5_SUPERBLOCK_BYTES) {
          throw unreadableH5adError();
        }
        return;
      }
    }
  }

  throw new Error(
    'The selected file is not a valid HDF5/H5AD file. Choose an AnnData .h5ad file or regenerate it with AnnData.'
  );
}

function h5AttributeValue(node, key) {
  const attribute = node?.attrs?.[key];
  return attribute && typeof attribute === 'object' &&
    'value' in attribute
    ? attribute.value
    : attribute;
}

function decodeExactH5BooleanAttribute(node, key, label) {
  const fail = () => {
    throw new Error(
      `${label} ${key} must be an own boolean attribute encoded as a scalar HDF5 enum`
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
    metadata.littleEndian !== true ||
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

function validateH5Materialization(
  shape,
  dataset,
  label,
  outputBytesPerElement = 4
) {
  const count = h5ElementCount(shape, label);
  validateH5WorkingSet(
    count,
    h5DatasetElementBytes(dataset) + outputBytesPerElement,
    label
  );
  return count;
}

function validateH5WorkingSet(elementCount, bytesPerElement, label) {
  const peakBytes = BigInt(elementCount) * BigInt(bytesPerElement);
  if (peakBytes > BigInt(MAX_H5AD_MATERIALIZED_ARRAY_BYTES)) {
    throw new H5adMaterializationLimitError(
      `${label} working set exceeds the ${MAX_H5AD_MATERIALIZED_ARRAY_BYTES}-byte browser limit; use the Cellucid server or prepared format`
    );
  }
}

function validateMaterializedH5StringPayload(
  rawValues,
  expectedLength,
  label,
  {
    retainedBytes = 0n,
    sourceBytesPerElement = JS_ARRAY_ELEMENT_BYTES,
    rejectMissing = false,
  } = {}
) {
  let peakBytes =
    BigInt(retainedBytes) +
    BigInt(expectedLength) *
      BigInt(sourceBytesPerElement + JS_ARRAY_ELEMENT_BYTES);
  for (let index = 0; index < expectedLength; index++) {
    const value = rawValues[index];
    if (rejectMissing && (value === null || value === undefined)) {
      throw new Error(`${label} cannot contain missing names`);
    }
    const stringValue = String(value);
    peakBytes +=
      BigInt(ESTIMATED_JS_STRING_VALUE_BYTES) +
      BigInt(stringValue.length) * 2n;
    if (peakBytes > BigInt(MAX_H5AD_MATERIALIZED_ARRAY_BYTES)) {
      throw new H5adMaterializationLimitError(
        `${label} working set exceeds the ${MAX_H5AD_MATERIALIZED_ARRAY_BYTES}-byte browser limit; use the Cellucid server or prepared format`
      );
    }
  }
}

function validateDenseH5ColumnMaterialization(
  dataset,
  elementCount,
  kind
) {
  const sourceBytes = h5DatasetElementBytes(dataset);
  // h5wasm returns a Float32Array for f4 slices, which toFloat32Array can
  // retain directly. Every other numeric dtype needs a separate f32 output.
  const conversionBytes =
    kind === 'float' && sourceBytes === Float32Array.BYTES_PER_ELEMENT
      ? 0
      : Float32Array.BYTES_PER_ELEMENT;
  validateH5WorkingSet(
    elementCount,
    sourceBytes + conversionBytes,
    'Dense X column'
  );
}

function validatePrimitiveH5ObservationMaterialization(
  dataset,
  elementCount,
  kind,
  key
) {
  const sourceBytes = h5DatasetElementBytes(dataset);
  let bytesPerElement;
  if (kind === 'string') {
    // Variable-length HDF5 strings decode to individual JavaScript strings,
    // then Array.from retains a second array of references. Their lengths are
    // unavailable until payload access, so use a conservative object estimate.
    bytesPerElement =
      ESTIMATED_JS_STRING_VALUE_BYTES + (2 * JS_ARRAY_ELEMENT_BYTES);
  } else if (kind === 'bool') {
    bytesPerElement = sourceBytes + JS_ARRAY_ELEMENT_BYTES;
  } else if (kind === 'float' &&
      sourceBytes === Float32Array.BYTES_PER_ELEMENT) {
    bytesPerElement = sourceBytes;
  } else if (kind === 'float' || kind === 'int' || kind === 'uint') {
    bytesPerElement = sourceBytes + Float32Array.BYTES_PER_ELEMENT;
  } else {
    throw new Error(
      `Observation field '${key}' uses an unsupported HDF5 dtype`
    );
  }
  validateH5WorkingSet(
    elementCount,
    bytesPerElement,
    `Observation field '${key}'`
  );
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
  if (categoryCount > MAX_CELLUCID_CATEGORIES) {
    throw new Error(
      `Categorical observation field "${key}" has ` +
      `${categoryCount.toLocaleString('en-US')} categories, but Cellucid ` +
      `supports at most ` +
      `${MAX_CELLUCID_CATEGORIES.toLocaleString('en-US')}. ` +
      'Reduce or merge categories before loading the dataset.'
    );
  }
  return categoryCount;
}

function isSignedH5IntegerDataset(dataset) {
  return h5DatasetKind(dataset) === 'int' &&
    typeof dataset?.dtype === 'string' &&
    /^[<>=|]?[bhiq](?:\d+)?$/.test(dataset.dtype);
}

function numericValueToFloat32(value, label, requireExactInteger = false) {
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
  if (requireExactInteger && Number(narrowed) !== numeric) {
    throw new Error(
      `${label} integer value ${numeric} cannot be represented exactly in Float32`
    );
  }
  return narrowed;
}

function validateFiniteH5Coordinates(values, label) {
  const length = Number(values?.length);
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error(`${label} has an invalid coordinate length`);
  }
  for (let index = 0; index < length; index++) {
    const value = values[index];
    if (typeof value === 'bigint') continue;
    if (!Number.isFinite(value)) {
      throw new Error(
        `${label} contains a non-finite component at flat index ${index}`
      );
    }
  }
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
  expectedLength = null,
  { materializeValues = true } = {}
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

  let peakBytes =
    BigInt(maskLength) *
    BigInt(h5DatasetElementBytes(maskDataset) + 1);
  if (materializeValues) {
    const outputBytes =
      encodingType === 'nullable-integer'
        ? 4
        : (
            encodingType === 'nullable-string-array'
              ? ESTIMATED_JS_STRING_VALUE_BYTES + JS_ARRAY_ELEMENT_BYTES
              : JS_ARRAY_ELEMENT_BYTES
          );
    peakBytes +=
      BigInt(valuesLength) *
      BigInt(h5DatasetElementBytes(valuesDataset) + outputBytes);
  }
  if (peakBytes > BigInt(MAX_H5AD_MATERIALIZED_ARRAY_BYTES)) {
    throw new Error(
      `Nullable field '${key}' working set exceeds the ${MAX_H5AD_MATERIALIZED_ARRAY_BYTES}-byte browser limit; use the Cellucid server or prepared format`
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
  const rawMask = maskDataset.value;
  if (!rawMask || rawMask.length !== expectedLength) {
    throw new Error(`${label} payload length does not match its metadata`);
  }
  const mask = new Uint8Array(expectedLength);
  for (let index = 0; index < expectedLength; index++) {
    const value = Number(rawMask[index]);
    if (value !== 0 && value !== 1) {
      throw new Error(`${label} must contain only boolean values`);
    }
    mask[index] = value;
  }
  return mask;
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
  const rawValues = valuesDataset.value;
  if (!rawValues || rawValues.length !== valuesLength) {
    throw new Error(
      `Nullable values for '${key}' payload length does not match its metadata`
    );
  }

  if (encodingType === 'nullable-string-array') {
    let peakBytes =
      BigInt(valuesLength) *
        BigInt(
          h5DatasetElementBytes(valuesDataset) +
          JS_ARRAY_ELEMENT_BYTES
        ) +
      BigInt(valuesLength) *
        BigInt(h5DatasetElementBytes(maskDataset) + 1);
    for (let index = 0; index < valuesLength; index++) {
      const stringValue = String(rawValues[index]);
      peakBytes +=
        BigInt(ESTIMATED_JS_STRING_VALUE_BYTES) +
        BigInt(stringValue.length) * 2n;
      if (peakBytes > BigInt(MAX_H5AD_MATERIALIZED_ARRAY_BYTES)) {
        throw new H5adMaterializationLimitError(
          `Nullable string field '${key}' working set exceeds the ${MAX_H5AD_MATERIALIZED_ARRAY_BYTES}-byte browser limit; use the Cellucid server or prepared format`
        );
      }
    }
  }

  if (encodingType === 'nullable-integer') {
    const values = new Float32Array(valuesLength);
    for (let index = 0; index < valuesLength; index++) {
      values[index] = mask[index]
        ? Number.NaN
        : numericValueToFloat32(
            rawValues[index],
            `Observation field '${key}'`,
            true
          );
    }
    return {
      dtype: valuesKind === 'uint' ? 'uint' : 'int',
      values,
    };
  }
  if (encodingType === 'nullable-boolean') {
    const values = new Array(valuesLength);
    for (let index = 0; index < valuesLength; index++) {
      if (mask[index]) {
        values[index] = null;
        continue;
      }
      const value = Number(rawValues[index]);
      if (value !== 0 && value !== 1) {
        throw new Error(
          `Nullable boolean values for '${key}' must contain only boolean values`
        );
      }
      values[index] = value === 1;
    }
    return { dtype: 'bool', values };
  }

  const values = new Array(valuesLength);
  for (let index = 0; index < valuesLength; index++) {
    values[index] = mask[index] ? null : String(rawValues[index]);
  }
  return { dtype: 'string', values };
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
      expectedLength,
      { materializeValues }
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

    validateH5WorkingSet(
      contract.valuesLength,
      ESTIMATED_JS_STRING_VALUE_BYTES + (2 * JS_ARRAY_ELEMENT_BYTES) + 1,
      label
    );
    const rawValues = contract.valuesDataset.value;
    if (!rawValues || rawValues.length !== contract.valuesLength) {
      throw new Error(`${label} payload length does not match its metadata`);
    }
    validateMaterializedH5StringPayload(
      rawValues,
      contract.valuesLength,
      label,
      {
        retainedBytes:
          BigInt(contract.valuesLength) *
          BigInt(h5DatasetElementBytes(contract.maskDataset) + 1),
        sourceBytesPerElement:
          h5DatasetElementBytes(contract.valuesDataset),
        rejectMissing: true,
      }
    );
    return {
      length: contract.valuesLength,
      values: Array.from(rawValues, value => String(value)),
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

  validateH5WorkingSet(
    length,
    ESTIMATED_JS_STRING_VALUE_BYTES + (2 * JS_ARRAY_ELEMENT_BYTES),
    label
  );
  const rawValues = indexNode.value;
  if (!rawValues || rawValues.length !== length) {
    throw new Error(`${label} payload length does not match its metadata`);
  }
  validateMaterializedH5StringPayload(rawValues, length, label, {
    sourceBytesPerElement: h5DatasetElementBytes(indexNode),
    rejectMissing: true,
  });
  return {
    length,
    values: Array.from(rawValues, value => String(value)),
  };
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
  validateH5Materialization(
    [length],
    categoriesDataset,
    `Categorical categories for '${key}'`,
    8
  );
  const rawCategories = categoriesDataset.value;
  if (!rawCategories || rawCategories.length !== length) {
    throw new Error(
      `Categorical categories for '${key}' payload length does not match its metadata`
    );
  }
  if (kind === 'string') {
    validateMaterializedH5StringPayload(
      rawCategories,
      length,
      `Categorical categories for '${key}'`,
      {
        sourceBytesPerElement:
          h5DatasetElementBytes(categoriesDataset),
      }
    );
    return freezeUniqueH5Categories(
      Array.from(rawCategories, value => String(value)),
      key
    );
  }
  if (kind === 'bool') {
    return freezeUniqueH5Categories(
      Array.from(rawCategories, value => {
        const numeric = Number(value);
        if (numeric !== 0 && numeric !== 1) {
          throw new Error(
            `Categorical categories for '${key}' contain a non-boolean value`
          );
        }
        return numeric === 1;
      }),
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
  const sourceBytes = h5DatasetElementBytes(codesDataset);
  const conversionBytes =
    sourceBytes === Int32Array.BYTES_PER_ELEMENT
      ? 0
      : Int32Array.BYTES_PER_ELEMENT;
  validateH5WorkingSet(
    codeLength,
    sourceBytes + conversionBytes,
    `Categorical codes for '${key}'`
  );
  const codes = toInt32Array(
    codesDataset.value,
    `Categorical code for '${key}'`
  );
  for (const code of codes) {
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
  if (shape[0] > MAX_REASONABLE_SPARSE_DIMENSION ||
      shape[1] > MAX_REASONABLE_SPARSE_DIMENSION) {
    throw new Error(
      `${label} shape (${shape[0]}×${shape[1]}) exceeds reasonable limits`
    );
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
  if (dataLength > MAX_REASONABLE_SPARSE_NNZ) {
    throw new Error(
      `${label} has ${dataLength} non-zeros, exceeding the browser limit`
    );
  }

  const dataKind = h5DatasetKind(dataDataset);
  if (!['float', 'int', 'uint', 'bool'].includes(dataKind)) {
    throw new Error(`${label} data must use a numeric dtype`);
  }
  const indicesKind = h5DatasetKind(indicesDataset);
  const indptrKind = h5DatasetKind(indptrDataset);
  if (!['int', 'uint'].includes(indicesKind) ||
      !['int', 'uint'].includes(indptrKind)) {
    throw new Error(`${label} indices and indptr must use integer dtypes`);
  }

  const sourceBytes =
    BigInt(dataLength) * BigInt(h5DatasetElementBytes(dataDataset)) +
    BigInt(indicesLength) * BigInt(h5DatasetElementBytes(indicesDataset)) +
    BigInt(indptrLength) * BigInt(h5DatasetElementBytes(indptrDataset));
  const normalizedCsrBytes =
    BigInt(dataLength + indicesLength + indptrLength) * 4n;
  let workingBytes = sourceBytes + normalizedCsrBytes;

  if (format === 'csr') {
    const nonzeroCount = BigInt(dataLength);
    const rowCount = BigInt(shape[0]);
    const columnCount = BigInt(shape[1]);
    // buildCscFromCsr retains the normalized CSR arrays while allocating the
    // CSC data/indices and all three column scratch arrays. At its peak,
    // colCounts, colIndptr, and colPos are simultaneously live.
    const conversionPeak =
      nonzeroCount * 16n +
      rowCount * 4n +
      columnCount * 12n +
      12n;
    if (conversionPeak > workingBytes) workingBytes = conversionPeak;

    // After conversion the CSC representation remains live while a requested
    // dense gene column is materialized.
    const genePeak =
      nonzeroCount * 8n +
      (columnCount + 1n) * 4n +
      rowCount * 4n;
    if (genePeak > workingBytes) workingBytes = genePeak;
  } else {
    const genePeak =
      normalizedCsrBytes + BigInt(shape[0]) * 4n;
    if (genePeak > workingBytes) workingBytes = genePeak;
  }

  if (workingBytes > BigInt(MAX_H5AD_MATERIALIZED_ARRAY_BYTES)) {
    throw new Error(
      `${label} working set exceeds the ${MAX_H5AD_MATERIALIZED_ARRAY_BYTES}-byte browser limit; use the Cellucid server or prepared format`
    );
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

function readSparseMatrix(group, label, dataMode) {
  if (dataMode !== 'float32' && dataMode !== 'exact') {
    throw new TypeError(
      `${label} data mode must be exactly "float32" or "exact"`
    );
  }
  const metadata = readSparseMatrixMetadata(group, label);
  const {
    dataDataset,
    dataKind,
    dataLength,
    format,
    indicesDataset,
    indicesLength,
    indptrDataset,
    indptrLength,
    shape,
  } = metadata;
  const rawData = dataDataset.value;
  const rawIndices = indicesDataset.value;
  const rawIndptr = indptrDataset.value;
  if (rawData?.length !== dataLength ||
      rawIndices?.length !== indicesLength ||
      rawIndptr?.length !== indptrLength) {
    throw new Error(`${label} payload lengths do not match dataset metadata`);
  }

  const exactInteger =
    dataKind === 'int' || dataKind === 'uint' || dataKind === 'bool';
  const data = dataMode === 'exact'
    ? rawData
    : toFloat32Array(rawData, `${label} data`, exactInteger);
  const indices = toInt32Array(rawIndices, `${label} index`);
  const indptr = toInt32Array(rawIndptr, `${label} indptr`);

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
  const indexAxis = format === 'csr' ? shape[1] : shape[0];
  for (const index of indices) {
    if (index < 0 || index >= indexAxis) {
      throw new Error(
        `${label} index ${index} is outside axis bounds [0, ${indexAxis})`
      );
    }
  }

  return {
    cscData: null,
    data,
    exactInteger,
    format,
    indices,
    indptr,
    shape,
  };
}

// Maximum number of gene expression arrays to cache (LRU eviction beyond this)
// Each gene array is ~4 bytes * n_cells, so for 500k cells this is ~2MB per gene
// 100 genes = ~200MB max gene cache
const MAX_GENE_CACHE_SIZE = 100;
const MAX_GENE_CACHE_BYTES = 256 * 1024 * 1024;

// Dense X cache guardrail:
// Caching the full dense X matrix can be multi-GB (n_obs × n_vars × dtype_size).
// That is a fast path for small datasets but a common OOM trigger for large ones.
// Above this threshold we fetch gene columns via `Dataset.slice()` instead.
const MAX_DENSE_X_CACHE_BYTES = 256 * 1024 * 1024; // 256MB

/**
 * H5AD file loader for AnnData format
 */
export class H5adLoader {
  constructor() {
    /** @type {Object|null} h5wasm File object */
    this._file = null;

    /** @type {string|null} */
    this._filename = null;

    /** @type {string|null} Path in virtual filesystem */
    this._virtualPath = null;

    /** @type {number} */
    this._nObs = 0;

    /** @type {number} */
    this._nVars = 0;

    /** @type {string[]} */
    this._obsKeys = [];

    /** @type {string[]} */
    this._varNames = [];

    /** @type {Map<string, number>} Gene name to index lookup for O(1) access */
    this._varNameIndex = new Map();

    /** @type {string[]} */
    this._obsmKeys = [];

    /** @type {Map<string, Object>} General cache for embeddings, obs fields, etc. */
    this._cache = new Map();

    /**
     * @type {Map<string, Float32Array>} LRU cache for gene expression
     * Separate from _cache to allow independent size limits
     */
    this._geneCache = new Map();

    /** @type {number} Bytes retained by the gene-expression LRU */
    this._geneCacheBytes = 0;

    /** @type {Object|null} Sparse X matrix info */
    this._sparseX = null;

    /** @type {Promise|null} Promise for CSR→CSC conversion to prevent race conditions */
    this._sparseXLoadPromise = null;

    /** @type {Float32Array|null} Dense X matrix cache */
    this._denseX = null;

    /** @type {boolean} */
    this._xIsSparse = false;

    /** @type {number} Invalidates asynchronous work after cache lifecycle changes */
    this._generation = 0;

    /** @type {number} Latest open request identity */
    this._openRequestId = 0;

    /** @type {boolean} */
    this._closed = false;
  }

  _assertOpenRequest(requestId) {
    if (requestId !== this._openRequestId) {
      throw createDatasetReloadSupersededError(
        'H5AD open request was superseded or closed.'
      );
    }
  }

  /**
   * Open an h5ad file
   * @param {File} file - File object from file input
   * @param {Object} [options]
   * @param {boolean} [options.showProgress=true]
   * @returns {Promise<void>}
   */
  async open(file, options = {}) {
    const totalBytes = validateH5adBrowserFileSize(file);
    const requestId = ++this._openRequestId;
    const { showProgress = true } = options;
    const notifications = showProgress ? getNotificationCenter() : null;
    const trackerId = notifications
      ? notifications.startDownload(`Loading ${file.name}`)
      : null;
    const candidate = new H5adLoader();
    let adopted = false;

    try {
      await this._populateCandidateFromFile(
        candidate,
        file,
        totalBytes,
        requestId,
        (loadedBytes, knownTotalBytes = totalBytes) => {
          notifications?.updateDownload(
            trackerId,
            loadedBytes,
            knownTotalBytes
          );
        }
      );
      this._assertOpenRequest(requestId);

      this._adoptCandidate(candidate);
      adopted = true;

      if (notifications !== null) {
        notifications.completeDownload(trackerId);
      }
      console.log(`[H5adLoader] Opened ${file.name}: ${this._nObs} cells, ${this._nVars} genes`);

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
      if (adopted) {
        throw terminalError;
      }
      try {
        candidate.close();
      } catch (cleanupFailure) {
        terminalError = combineDatasetLifecycleFailures(
          terminalError,
          cleanupFailure,
          'H5AD opening and candidate cleanup both failed.'
        );
      }
      if (notifications !== null && trackerId !== null) {
        try {
          if (requestId !== this._openRequestId) {
            notifications.dismissDownload(trackerId);
          } else {
            notifications.failDownload(trackerId, terminalError.message);
          }
        } catch (reportingFailure) {
          terminalError = combineDatasetLifecycleFailures(
            terminalError,
            reportingFailure,
            'H5AD opening and failure reporting both failed.'
          );
        }
      }
      throw terminalError;
    }
  }

  /**
   * Populate a candidate loader from one browser File. Keeping this work
   * separate from `open()` makes notification ownership independent from the
   * HDF5 transport and lets the outer transaction remain current-aware.
   * @param {H5adLoader} candidate
   * @param {File} file
   * @param {number} totalBytes
   * @param {number} requestId
   * @param {(loadedBytes: number, totalBytes?: number) => void} reportProgress
   * @private
   */
  async _populateCandidateFromFile(
    candidate,
    file,
    totalBytes,
    requestId,
    reportProgress
  ) {
    await validateH5adBrowserFileSignature(file, totalBytes);
    this._assertOpenRequest(requestId);

    await initH5wasm();
    this._assertOpenRequest(requestId);

    // Write to Emscripten virtual filesystem and open with h5wasm.
    const FS = h5wasm.FS;
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const virtualPath =
      `/cellucid_h5ad_${++h5VirtualFileSequence}_${safeName}`;
    candidate._virtualPath = virtualPath;

    // Avoid holding the entire file in a single ArrayBuffer for large files.
    const shouldChunkCopy = totalBytes > (256 * 1024 * 1024);
    if (!shouldChunkCopy) {
      const buffer = await file.arrayBuffer();
      this._assertOpenRequest(requestId);
      FS.writeFile(virtualPath, new Uint8Array(buffer));
      reportProgress(buffer.byteLength, buffer.byteLength);
    } else {
      const chunkBytes = 16 * 1024 * 1024;
      const fd = FS.open(virtualPath, 'w+');
      let written = 0;
      let transferFailure = null;

      try {
        while (written < totalBytes) {
          const end = Math.min(totalBytes, written + chunkBytes);
          const chunk = await file.slice(written, end).arrayBuffer();
          this._assertOpenRequest(requestId);
          const bytes = new Uint8Array(chunk);
          FS.write(fd, bytes, 0, bytes.length, written);
          written += bytes.length;
          reportProgress(written, totalBytes);

          if (written > 0 && written % (chunkBytes * 4) === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        }
      } catch (error) {
        transferFailure = error instanceof Error
          ? error
          : new TypeError(
              'H5AD file transfer must reject with an Error.',
              { cause: error }
            );
      }
      try {
        FS.close(fd);
      } catch (cleanupFailure) {
        const closeError = cleanupFailure instanceof Error
          ? cleanupFailure
          : new TypeError(
              'H5AD virtual file descriptor release must reject with an Error.',
              { cause: cleanupFailure }
            );
        transferFailure = transferFailure === null
          ? closeError
          : combineDatasetLifecycleFailures(
              transferFailure,
              closeError,
              'H5AD file transfer and descriptor release both failed.'
            );
      }
      if (transferFailure !== null) {
        throw transferFailure;
      }
    }

    try {
      candidate._file = new h5wasm.File(virtualPath, 'r');
      // h5wasm may return an invalid File wrapper instead of throwing when the
      // superblock exists but the file is truncated. Touching the root now
      // converts that low-level failure into one stable user-facing boundary.
      candidate._file.keys();
    } catch (cause) {
      throw unreadableH5adError(cause);
    }
    candidate._filename = file.name;
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
    this._virtualPath = candidate._virtualPath;
    this._nObs = candidate._nObs;
    this._nVars = candidate._nVars;
    this._obsKeys = candidate._obsKeys;
    this._varNames = candidate._varNames;
    this._varNameIndex = candidate._varNameIndex;
    this._obsmKeys = candidate._obsmKeys;
    this._cache = candidate._cache;
    this._geneCache = candidate._geneCache;
    this._geneCacheBytes = candidate._geneCacheBytes;
    this._sparseX = candidate._sparseX;
    this._sparseXLoadPromise = candidate._sparseXLoadPromise;
    this._denseX = candidate._denseX;
    this._xIsSparse = candidate._xIsSparse;
    this._closed = false;

    // The active loader now owns these resources; a later candidate close
    // must not release them.
    candidate._file = null;
    candidate._virtualPath = null;
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
    let xIsSparse = false;
    let obsKeys = [...obsSchema.columnOrder];
    let varNames = [];
    let varNameIndex = new Map();
    let obsmKeys = [];

    // Check for X matrix and its format
    if (hasX) {
      const X = root.get('X');

      // Check if X is a group (sparse) or dataset (dense)
      if (X.type === 'Group') {
        // Sparse matrix
        const sparse = readSparseMatrixMetadata(X, 'Sparse X');
        xIsSparse = true;
        const encodingType = sparse.encodingType;
        console.log(`[H5adLoader] X is sparse (${encodingType})`);
        nObs = sparse.shape[0];
        nVars = sparse.shape[1];
      } else {
        // Dense matrix
        validateCurrentH5ArrayEncoding(X, 'Dense X', 'array');
        const shape = h5DatasetShape(X, 'Dense X', 2);
        if (!['float', 'int', 'uint'].includes(h5DatasetKind(X))) {
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
    varNames = rawNames;
    for (let index = 0; index < varNames.length; index++) {
      const name = varNames[index];
      if (varNameIndex.has(name)) {
        throw new Error(
          `Variable index contains duplicate name '${name}'`
        );
      }
      varNameIndex.set(name, index);
    }
    for (const key of varSchema.columnOrder) {
      validateH5DataFrameColumnAxis(
        var_,
        key,
        'Variable dataframe',
        nVars
      );
    }

    // Read obsm (embeddings) structure
    if (rootKeys.includes('obsm')) {
      const obsm = requireCurrentH5Mapping(
        root.get('obsm'),
        'H5AD obsm mapping'
      );
      obsmKeys = obsm.keys();
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
    this._varNameIndex = varNameIndex;
    this._obsmKeys = obsmKeys;
    this._xIsSparse = xIsSparse;
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
   * Get obsm (embedding) keys
   * @returns {string[]}
   */
  get obsmKeys() {
    return [...this._obsmKeys];
  }

  /**
   * Check if file is open
   * @returns {boolean}
   */
  get isOpen() {
    return this._file !== null;
  }

  /**
   * Get embedding shape without loading full array data.
   * Used for dimension detection to avoid loading large embeddings just to get nDims.
   * @param {string} key - Exact obsm key (for example, 'X_umap_3d')
   * @returns {{shape: number[], nDims: number}}
   */
  getEmbeddingShape(key) {
    this._ensureOpen();

    const obsm = requireCurrentH5Mapping(
      this._file.get('obsm'),
      'H5AD obsm mapping'
    );
    if (!obsm || !obsm.keys().includes(key)) {
      throw new Error(`Embedding '${key}' not found in obsm. Available: ${this._obsmKeys.join(', ')}`);
    }

    const dataset = obsm.get(key);
    validateCurrentH5ArrayEncoding(
      dataset,
      `Embedding '${key}'`,
      'array'
    );
    const shape = h5DatasetShape(dataset, `Embedding '${key}'`, 2);
    if (shape[0] !== this._nObs) {
      throw new Error(
        `Embedding '${key}' has ${shape[0]} rows but expected ${this._nObs} cells`
      );
    }
    if (shape[1] < 1 || shape[1] > 3) {
      throw new Error(
        `Embedding '${key}' must have between 1 and 3 columns`
      );
    }
    if (!['float', 'int', 'uint'].includes(h5DatasetKind(dataset))) {
      throw new Error(`Embedding '${key}' must use a numeric dtype`);
    }
    const elementCount = validateH5Materialization(
      shape,
      dataset,
      `Embedding '${key}'`
    );
    // BaseAnnDataAdapter retains these Float32 coordinates while allocating
    // and caching a second normalized Float32 array.
    validateH5WorkingSet(
      elementCount,
      Float32Array.BYTES_PER_ELEMENT * 2,
      `Embedding '${key}' public`
    );
    return { shape, nDims: shape[1] };
  }

  /**
   * Get an embedding from obsm
   * @param {string} key - Exact obsm key (for example, 'X_umap_3d')
   * @returns {Promise<{data: Float32Array, shape: number[], nDims: number}>}
   */
  async getEmbedding(key) {
    this._ensureOpen();
    const generation = this._generation;

    const cacheKey = `obsm:${key}`;
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey);
    }

    const obsm = requireCurrentH5Mapping(
      this._file.get('obsm'),
      'H5AD obsm mapping'
    );
    if (!obsm || !obsm.keys().includes(key)) {
      throw new Error(`Embedding '${key}' not found in obsm. Available: ${this._obsmKeys.join(', ')}`);
    }

    const dataset = obsm.get(key);
    const { shape, nDims } = this.getEmbeddingShape(key);
    const kind = h5DatasetKind(dataset);
    const expectedLength = h5ElementCount(shape, `Embedding '${key}'`);
    const rawData = dataset.value;
    if (!rawData || rawData.length !== expectedLength) {
      throw new Error(
        `Embedding '${key}' payload length does not match its shape`
      );
    }
    validateFiniteH5Coordinates(
      rawData,
      `Embedding '${key}'`
    );
    const data = toFloat32Array(
      rawData,
      `Embedding '${key}'`,
      kind === 'int' || kind === 'uint'
    );

    const result = { data, shape, nDims };
    this._assertGeneration(generation, `loading embedding '${key}'`);
    this._cache.set(cacheKey, result);

    return result;
  }

  /**
   * Release one exact loader-owned raw embedding result. Identity checking
   * prevents stale adapter cleanup from deleting a newer independent result.
   *
   * @param {string} key
   * @param {Object} expected
   * @returns {boolean}
   */
  releaseEmbedding(key, expected) {
    const cacheKey = `obsm:${key}`;
    if (this._cache.get(cacheKey) !== expected) {
      return false;
    }
    this._cache.delete(cacheKey);
    return true;
  }

  /**
   * Get gene expression values for a single gene
   * @param {string} geneName - Gene name
   * @returns {Promise<Float32Array>}
   */
  async getGeneExpression(geneName) {
    this._ensureOpen();
    const generation = this._generation;

    // Use O(1) Map lookup instead of O(n) indexOf for better performance with many genes
    const geneIdx = this._varNameIndex.get(geneName);
    if (geneIdx === undefined) {
      throw new Error(`Gene '${geneName}' not found`);
    }

    // Check LRU gene cache first
    if (this._geneCache.has(geneName)) {
      // Move to end for LRU ordering (delete and re-add)
      const cached = this._geneCache.get(geneName);
      this._geneCache.delete(geneName);
      this._geneCache.set(geneName, cached);
      return cached;
    }

    let result;

    if (this._xIsSparse) {
      // Load sparse matrix components if not cached
      // Use Promise-based lock to prevent race conditions when multiple concurrent calls
      // both see !this._sparseX and start the expensive CSR→CSC conversion simultaneously
      if (!this._sparseX) {
        if (!this._sparseXLoadPromise) {
          const loadPromise = (async () => {
            const X = this._file.get('X');
            const sparse = readSparseMatrix(
              X,
              'Sparse X',
              'float32'
            );
            if (sparse.shape[0] !== this._nObs ||
                sparse.shape[1] !== this._nVars) {
              throw new Error(
                `Sparse X shape ${sparse.shape[0]}×${sparse.shape[1]} does not match ${this._nObs} cells and ${this._nVars} genes`
              );
            }

            // For CSR format, convert to CSC for efficient column access
            // This is a one-time O(nnz) cost that pays off with repeated gene queries
            if (sparse.format === 'csr') {
              const nnz = sparse.data.length;
              console.log(`[H5adLoader] Converting CSR to CSC (${(nnz / 1e6).toFixed(1)}M non-zeros) for efficient gene access...`);
              const startTime = performance.now();
              sparse.cscData = buildCscFromCsr(sparse);
              const elapsed = (performance.now() - startTime).toFixed(0);
              console.log(`[H5adLoader] CSR→CSC conversion complete in ${elapsed}ms`);

              // MEMORY OPTIMIZATION: Release original CSR arrays since we only use CSC for column access
              // This prevents memory duplication (saves ~50% of sparse matrix memory)
              sparse.data = null;
              sparse.indices = null;
              sparse.indptr = null;
            }
            return sparse;
          })();
          this._sparseXLoadPromise = loadPromise;
        }
        const loadPromise = this._sparseXLoadPromise;
        let sparse;
        try {
          sparse = await loadPromise;
          this._assertGeneration(generation, 'loading sparse X');
          if (this._sparseXLoadPromise === loadPromise) {
            this._sparseX = sparse;
          }
        } finally {
          if (this._sparseXLoadPromise === loadPromise) {
            this._sparseXLoadPromise = null;
          }
        }
        this._assertGeneration(generation, 'loading sparse X');
        if (!this._sparseX) this._sparseX = sparse;
      }

      // Extract column using efficient method
      if (this._sparseX.format === 'csr') {
        // Use pre-computed CSC format for O(nnz/n_cols) access via shared utility
        result = getSparseColumn(this._sparseX.cscData, geneIdx, this._nObs);
      } else {
        // CSC - column access is already efficient
        const { data, indices, indptr } = this._sparseX;
        result = getSparseColumn({
          colData: data,
          colIndptr: indptr,
          exactInteger: this._sparseX.exactInteger === true,
          rowIndices: indices,
        }, geneIdx, this._nObs);
      }
    } else {
      // Dense matrix:
      // Prefer slice-based column access for large matrices to avoid caching multi-GB buffers.
      const X = this._file.get('X');
      validateCurrentH5ArrayEncoding(X, 'Dense X', 'array');
      const shape = h5DatasetShape(X, 'Dense X', 2);
      if (shape[0] !== this._nObs || shape[1] !== this._nVars) {
        throw new Error(
          `Dense X shape ${shape[0]}×${shape[1]} does not match ${this._nObs} cells and ${this._nVars} genes`
        );
      }
      const kind = h5DatasetKind(X);
      if (!['float', 'int', 'uint'].includes(kind)) {
        throw new Error('Dense X must use a numeric dtype');
      }
      const exactInteger = kind === 'int' || kind === 'uint';
      const elementCount = h5ElementCount(shape, 'Dense X');
      const sourceBytes =
        BigInt(elementCount) * BigInt(h5DatasetElementBytes(X));
      const outputBytes = BigInt(elementCount) * 4n;
      const canCacheDense =
        outputBytes > 0n &&
        outputBytes <= BigInt(MAX_DENSE_X_CACHE_BYTES) &&
        sourceBytes + outputBytes <=
          BigInt(MAX_H5AD_MATERIALIZED_ARRAY_BYTES);

      if (canCacheDense) {
        // Fast path: cache full matrix for repeated access (small datasets only).
        if (!this._denseX) {
          const raw = X.value;
          if (!raw || raw.length !== elementCount) {
            throw new Error('Dense X payload length does not match its shape');
          }
          this._denseX = toFloat32Array(raw, 'Dense X', exactInteger);
        }

        result = new Float32Array(this._nObs);
        for (let i = 0; i < this._nObs; i++) {
          result[i] = this._denseX[i * this._nVars + geneIdx];
        }
      } else if (typeof X.slice === 'function') {
        // Memory-safe path: read only the requested column.
        validateDenseH5ColumnMaterialization(X, this._nObs, kind);
        const sliced = X.slice([
          [0, this._nObs],
          [geneIdx, geneIdx + 1]
        ]);

        // `slice()` returns a flattened typed array of length n_obs * 1.
        if (!sliced || sliced.length !== this._nObs) {
          throw new Error(
            'Dense X column payload length does not match the cell count'
          );
        }
        result = toFloat32Array(sliced, 'Dense X', exactInteger);
      } else {
        throw new Error(
          'Dense X Dataset.slice support is required when the full matrix is outside the bounded cache'
        );
      }
    }

    this._assertGeneration(generation, `loading gene '${geneName}'`);

    // Bound the LRU by retained bytes as well as entry count.
    const resultBytes = result?.byteLength;
    if (Number.isSafeInteger(resultBytes) && resultBytes >= 0 &&
        resultBytes <= MAX_GENE_CACHE_BYTES) {
      while (this._geneCache.size > 0 &&
             (this._geneCache.size >= MAX_GENE_CACHE_SIZE ||
              this._geneCacheBytes + resultBytes >
                MAX_GENE_CACHE_BYTES)) {
        const oldestKey = this._geneCache.keys().next().value;
        const oldest = this._geneCache.get(oldestKey);
        this._geneCache.delete(oldestKey);
        this._geneCacheBytes -= oldest?.byteLength ?? 0;
      }
      this._geneCache.set(geneName, result);
      this._geneCacheBytes += resultBytes;
    }

    return result;
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
        validateH5Materialization(
          [categoryCount],
          categoriesDataset,
          `Categorical categories for '${key}'`,
          8
        );
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
      validatePrimitiveH5ObservationMaterialization(
        item,
        length,
        metadataDtype,
        key
      );
      const rawValues = item.value;
      if (!rawValues || rawValues.length !== length) {
        throw new Error(
          `Observation field '${key}' payload length does not match its metadata`
        );
      }
      const dtype = metadataDtype;
      let values;
      if (dtype === 'bool') {
        values = Array.from(rawValues, value => {
          const numeric = Number(value);
          if (numeric !== 0 && numeric !== 1) {
            throw new Error(
              `Observation field '${key}' contains a non-boolean value`
            );
          }
          return numeric === 1;
        });
      } else if (dtype === 'float' ||
          dtype === 'int' ||
          dtype === 'uint') {
        values = toFloat32Array(
          rawValues,
          `Observation field '${key}'`,
          dtype === 'int' || dtype === 'uint'
        );
      } else {
        values = rawValues;
      }

      result = {
        dtype,
        values: dtype === 'string' && !Array.isArray(values)
          ? Array.from(values)
          : values
      };
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
   * Validate connectivity metadata without materializing matrix payloads.
   * @returns {Promise<Object|null>}
   * @private
   */
  async _getConnectivityMetadata() {
    this._ensureOpen();
    const generation = this._generation;
    if (this._cache.has('connectivity:metadata')) {
      return this._cache.get('connectivity:metadata');
    }

    const rootKeys = this._file.keys();
    if (!rootKeys.includes('obsp')) {
      this._cache.set('connectivity:metadata', null);
      return null;
    }
    const obsp = this._file.get('obsp');
    requireCurrentH5Mapping(obsp, 'H5AD obsp mapping');
    if (!obsp.keys().includes('connectivities')) {
      this._cache.set('connectivity:metadata', null);
      return null;
    }

    const conn = obsp.get('connectivities');
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
      if (!['float', 'int', 'uint', 'bool'].includes(kind)) {
        throw new Error('Dense connectivity matrix must use a numeric dtype');
      }
      validateH5Materialization(
        shape,
        conn,
        'Dense connectivity matrix'
      );
      result = {
        dataset: conn,
        kind: 'dense',
        shape,
        valueKind: kind,
      };
    }

    this._assertGeneration(generation, 'reading connectivity metadata');
    this._cache.set('connectivity:metadata', result);
    return result;
  }

  /**
   * Report whether an explicit connectivity representation is present.
   * @returns {Promise<boolean>}
   */
  async hasConnectivities() {
    const generation = this._generation;
    const metadata = await this._getConnectivityMetadata();
    this._assertGeneration(generation, 'checking connectivity metadata');
    return metadata !== null;
  }

  /**
   * Get connectivity data from obsp.
   * @returns {Promise<Object|null>}
   */
  async getConnectivities() {
    this._ensureOpen();
    const generation = this._generation;
    if (this._cache.has('connectivities')) {
      return this._cache.get('connectivities');
    }

    const metadata = await this._getConnectivityMetadata();
    this._assertGeneration(generation, 'loading connectivity data');
    if (metadata === null) return null;

    let result;
    if (metadata.kind === 'dense') {
      const expectedLength = h5ElementCount(
        metadata.shape,
        'Dense connectivity matrix'
      );
      const rawData = metadata.dataset.value;
      if (!rawData || rawData.length !== expectedLength) {
        throw new Error(
          'Dense connectivity payload length does not match its shape'
        );
      }
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
        obsp.get('connectivities'),
        'Connectivity matrix',
        'exact'
      );
    }

    this._assertGeneration(generation, 'loading connectivity data');
    this._cache.set('connectivities', result);
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

    // Detect available UMAP dimensions using shape metadata only (no full array loading)
    const availableDimensions = new Set();
    const embeddingKeysByDimension = {};

    for (const dim of [1, 2, 3]) {
      const key = `X_umap_${dim}d`;
      if (!this._obsmKeys.includes(key)) continue;
      const { nDims } = this.getEmbeddingShape(key);
      if (nDims !== dim) {
        throw new Error(
          `Embedding '${key}' has ${nDims} columns, but its ${dim}D suffix requires exactly ${dim}`
        );
      }
      availableDimensions.add(dim);
      embeddingKeysByDimension[`${dim}d`] = key;
    }

    const availableDimensionsList = Array.from(availableDimensions);
    if (availableDimensionsList.length === 0) {
      throw new Error(
        'No exact UMAP embedding found in obsm. Expected one or more of ' +
        'X_umap_1d, X_umap_2d, or X_umap_3d. ' +
        `Available obsm keys: ${this._obsmKeys.join(', ') || '(none)'}.`
      );
    }

    availableDimensionsList.sort((a, b) => a - b);
    const defaultDimension =
      availableDimensionsList[availableDimensionsList.length - 1];

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

    // Check connectivity
    const hasConnectivity = await this.hasConnectivities();
    this._assertGeneration(generation, 'building dataset metadata');

    // This is an adapter-construction descriptor, not a public dataset
    // identity. H5adDataSource publishes the sole validated v2 identity only
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
      embeddings: {
        available_dimensions: availableDimensionsList,
        default_dimension: defaultDimension,
        obsm_keys: embeddingKeysByDimension,
      },
      obs_fields: this._obsKeys.map(key => ({ key, kind: 'unknown' })),
    };
  }

  /**
   * Clear all cached data to free memory
   */
  clearCache() {
    this._generation++;
    this._cache.clear();
    this._geneCache.clear();  // Clear LRU gene expression cache
    this._geneCacheBytes = 0;
    this._sparseX = null;
    this._sparseXLoadPromise = null;  // Clear conversion promise to allow fresh conversion
    this._denseX = null;  // Critical: release dense matrix cache to prevent memory leak
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
    if (this._virtualPath) {
      if (
        h5wasm === null ||
        typeof h5wasm !== 'object' ||
        h5wasm.FS === null ||
        typeof h5wasm.FS !== 'object' ||
        typeof h5wasm.FS.unlink !== 'function'
      ) {
        recordReleaseFailure(
          new Error(
            'H5AD virtual filesystem ownership is unavailable during release.'
          )
        );
      } else {
        try {
          h5wasm.FS.unlink(this._virtualPath);
          this._virtualPath = null;
        } catch (failure) {
          recordReleaseFailure(failure);
        }
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
    this._varNameIndex = new Map();
    this._obsmKeys = [];
    this._xIsSparse = false;
    if (releaseFailure !== null) {
      throw releaseFailure;
    }
  }

  /**
   * Close the file and release resources
   */
  close() {
    if (this._closed && !this._file && !this._virtualPath) return;
    this._openRequestId++;
    this._closed = true;
    this._releaseCurrentState();
  }
}

/**
 * Check if a file appears to be an h5ad file
 * @param {File} file - File to check
 * @returns {boolean}
 */
export function isH5adFile(file) {
  return file.name.toLowerCase().endsWith('.h5ad');
}

/**
 * Create an H5adLoader instance
 * @returns {H5adLoader}
 */
export function createH5adLoader() {
  return new H5adLoader();
}

// ============================================================================
// H5AD DATA SOURCE
// ============================================================================

/**
 * H5AD-specific adapter extending the shared BaseAnnDataAdapter.
 * Any h5ad-specific overrides would go here.
 */
class H5adDataAdapter extends BaseAnnDataAdapter {
  /**
   * @param {H5adLoader} loader - The h5ad loader
   */
  constructor(loader) {
    super(loader);
  }

  // H5adDataAdapter uses all methods from BaseAnnDataAdapter without modification.
  // Any h5ad-specific overrides can be added here if needed in the future.
}

/**
 * H5AD Data Source for Cellucid
 * Provides the same interface as LocalUserDirDataSource but for h5ad files
 */
export class H5adDataSource {
  constructor() {
    /** @type {H5adLoader|null} */
    this._loader = null;

    /** @type {H5adDataAdapter|null} */
    this._adapter = null;

    /** @type {string|null} */
    this.datasetId = null;

    /** @type {string|null} */
    this.filename = null;

    /** @type {Object|null} */
    this._metadata = null;

    /** @type {Map<string, string>} Blob URLs for virtual files */
    this._blobUrls = new Map();

    /** @type {number} Latest file-selection request identity */
    this._loadRequestId = 0;

    this.type = 'h5ad';
  }

  _assertLoadRequest(requestId) {
    if (requestId !== this._loadRequestId) {
      throw createDatasetReloadSupersededError(
        'H5AD load request was superseded by a newer selection'
      );
    }
  }

  /**
   * Get the type identifier
   * @returns {string}
   */
  getType() {
    return this.type;
  }

  /**
   * Check if a file is loaded
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    return this._loader !== null && this._loader.isOpen;
  }

  /**
   * Load an h5ad file
   * @param {File} file - File from file input
   * @param {Object} [options]
   * @param {boolean} [options.showProgress=true]
   * @param {string} [options.datasetId]
   * @param {string} [options.description]
   * @param {Object} [options.source]
   * @returns {Promise<Object>}
   */
  async loadFromFile(file, options = {}) {
    if (!isH5adFile(file)) {
      throw new DataSourceError(
        'Not an h5ad file',
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
    }

    const requestId = ++this._loadRequestId;
    const {
      showProgress = true,
      datasetId = null,
      description = 'Loaded directly from H5AD file',
      source = {
        name: 'H5AD file',
        filename: file.name,
      },
    } = options;
    const notifications = showProgress ? getNotificationCenter() : null;
    const trackerId = notifications
      ? notifications.startDownload(`Loading ${file.name}`)
      : null;

    // Validate a candidate completely before releasing the working dataset.
    const candidateLoader = createH5adLoader();
    let candidateAdapter = null;
    let adopted = false;
    try {
      await candidateLoader.open(file, { showProgress: false });
      this._assertLoadRequest(requestId);
      candidateAdapter = new H5adDataAdapter(candidateLoader);
      await candidateAdapter.initialize();
      this._assertLoadRequest(requestId);

      const candidateFilename = file.name;
      const candidateDatasetId =
        datasetId ??
        `h5ad_${file.name.replace(/\.h5ad$/i, '')}`;
      const candidateMetadata =
        await candidateAdapter.finalizeDirectIdentity({
          id: candidateDatasetId,
          name: file.name.replace(/\.h5ad$/i, ''),
          description,
          cellucidDataVersion: 'h5ad_loader',
          source,
        });
      this._assertLoadRequest(requestId);

      this._releaseCurrentSource();
      this._loader = candidateLoader;
      this._adapter = candidateAdapter;
      this.filename = candidateFilename;
      this.datasetId = candidateDatasetId;
      this._metadata = candidateMetadata;
      adopted = true;

      console.log(`[H5adDataSource] Loaded ${file.name}: ${this._loader.nObs} cells, ${this._loader.nVars} genes`);
      if (notifications !== null) {
        notifications.completeDownload(trackerId);
        notifications.warning(
          'Loaded H5AD directly in the browser. The full file remains in browser memory, ' +
          'gene-expression reads are unquantized, and large datasets can be slower than ' +
          'the Cellucid server or prepared format.',
          { duration: 15000 }
        );
      }

      return this._metadata;
    } catch (error) {
      let terminalError = error instanceof Error
        ? error
        : new TypeError(
            'H5AD source loading must reject with an Error.',
            { cause: error }
          );
      if (!adopted) {
        try {
          if (candidateAdapter !== null) {
            candidateAdapter.close();
          } else {
            candidateLoader.close();
          }
        } catch (cleanupFailure) {
          terminalError = combineDatasetLifecycleFailures(
            terminalError,
            cleanupFailure,
            'H5AD source loading and candidate cleanup both failed.'
          );
        }
      }
      if (!adopted && notifications !== null) {
        try {
          if (requestId !== this._loadRequestId) {
            notifications.dismissDownload(trackerId);
          } else {
            notifications.failDownload(trackerId, terminalError.message);
          }
        } catch (reportingFailure) {
          terminalError = combineDatasetLifecycleFailures(
            terminalError,
            reportingFailure,
            'H5AD source loading and failure reporting both failed.'
          );
        }
      }
      throw terminalError;
    }
  }

  /**
   * List available datasets
   * @returns {Promise<Object[]>}
   */
  async listDatasets() {
    if (!this._metadata) {
      return [];
    }
    return [this._metadata];
  }

  /**
   * Get metadata for a dataset
   * @param {string} datasetId
   * @returns {Promise<Object>}
   */
  async getMetadata(datasetId) {
    if (!this._metadata) {
      throw new DataSourceError(
        'No h5ad file loaded',
        DataSourceErrorCode.NOT_FOUND,
        this.type
      );
    }
    if (
      typeof datasetId !== 'string' ||
      datasetId.length === 0 ||
      datasetId !== this.datasetId
    ) {
      throw new DataSourceError(
        `H5AD dataset "${String(datasetId)}" is not the adopted dataset ` +
        `"${String(this.datasetId)}"`,
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        {
          requestedId: datasetId,
          currentId: this.datasetId,
        }
      );
    }
    return this._metadata;
  }

  /**
   * Check if a dataset exists
   * @param {string} datasetId
   * @returns {Promise<boolean>}
   */
  async hasDataset(datasetId) {
    return this.datasetId !== null && this.datasetId === datasetId;
  }

  /**
   * Get base URL for the dataset
   * @param {string} datasetId
   * @returns {string}
   */
  getBaseUrl(datasetId) {
    if (
      typeof datasetId !== 'string' ||
      datasetId.length === 0 ||
      datasetId !== this.datasetId
    ) {
      throw new DataSourceError(
        `H5AD dataset "${String(datasetId)}" is not the adopted dataset ` +
        `"${String(this.datasetId)}"`,
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        {
          requestedId: datasetId,
          currentId: this.datasetId,
        }
      );
    }
    return `h5ad://${this.datasetId}/`;
  }

  /**
   * Get the H5AD data adapter (for direct data access)
   * @returns {H5adDataAdapter|null}
   */
  getAdapter() {
    return this._adapter;
  }

  /**
   * Get embedding data
   * @param {number} dim - Dimension (1, 2, or 3)
   * @returns {Promise<Float32Array>}
   */
  async getEmbedding(dim) {
    if (!this._adapter) {
      throw new DataSourceError('No h5ad file loaded', DataSourceErrorCode.NOT_FOUND, this.type);
    }
    return this._adapter.getEmbedding(dim);
  }

  /**
   * Get obs field data
   * @param {string} key - Field name
   * @returns {Promise<Object>}
   */
  async getObsFieldData(key) {
    if (!this._adapter) {
      throw new DataSourceError('No h5ad file loaded', DataSourceErrorCode.NOT_FOUND, this.type);
    }
    return this._adapter.getObsFieldData(key);
  }

  /**
   * Get gene expression values
   * @param {string} geneName - Gene name
   * @returns {Promise<Float32Array>}
   */
  async getGeneExpression(geneName) {
    if (!this._adapter) {
      throw new DataSourceError('No h5ad file loaded', DataSourceErrorCode.NOT_FOUND, this.type);
    }
    return this._adapter.getGeneExpression(geneName);
  }

  /**
   * Get connectivity edges
   * @returns {Promise<Object|null>}
   */
  async getConnectivityEdges() {
    if (!this._adapter) {
      throw new DataSourceError(
        'No h5ad file loaded',
        DataSourceErrorCode.NOT_FOUND,
        this.type
      );
    }
    return this._adapter.getConnectivityEdges();
  }

  /**
   * Get obs manifest
   * @returns {Object}
   */
  getObsManifest() {
    if (!this._adapter) {
      throw new DataSourceError('No h5ad file loaded', DataSourceErrorCode.NOT_FOUND, this.type);
    }
    return this._adapter.getObsManifest();
  }

  /**
   * Get var manifest
   * @returns {Object}
   */
  getVarManifest() {
    if (!this._adapter) {
      throw new DataSourceError('No h5ad file loaded', DataSourceErrorCode.NOT_FOUND, this.type);
    }
    return this._adapter.getVarManifest();
  }

  /**
   * Get connectivity manifest
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<Object|null>}
   */
  async getConnectivityManifest(options = {}) {
    const signal = getMetadataLoadSignal(
      options,
      'H5AD connectivity manifest'
    );
    throwIfMetadataAborted(signal, 'H5AD connectivity manifest loading');
    if (!this._adapter) {
      throw new DataSourceError(
        'No h5ad file loaded',
        DataSourceErrorCode.NOT_FOUND,
        this.type
      );
    }
    const manifest = this._adapter.getConnectivityManifest();
    throwIfMetadataAborted(signal, 'H5AD connectivity manifest loading');
    return manifest;
  }

  /**
   * Resolve h5ad:// URL (not really used, data is accessed directly)
   * @param {string} url
   * @returns {Promise<string>}
   */
  async resolveUrl(url) {
    // h5ad source doesn't use URL fetching, data is accessed directly
    throw new DataSourceError(
      'h5ad source does not support URL resolution. Use direct data access methods.',
      DataSourceErrorCode.UNSUPPORTED,
      this.type
    );
  }

  /**
   * Called when source is deactivated
   */
  onDeactivate() {
    // Revoke blob URLs
    for (const url of this._blobUrls.values()) {
      URL.revokeObjectURL(url);
    }
    this._blobUrls.clear();

    this.clearCaches();
  }

  /**
   * Cleanup resources
   * @private
   */
  _releaseCurrentSource() {
    if (this._adapter) {
      this._adapter.close();
      this._adapter = null;
      this._loader = null;
    } else if (this._loader) {
      this._loader.close();
      this._loader = null;
    }

    for (const url of this._blobUrls.values()) {
      URL.revokeObjectURL(url);
    }
    this._blobUrls.clear();

    this.datasetId = null;
    this.filename = null;
    this._metadata = null;
  }

  /**
   * Cleanup resources and supersede pending selections.
   * @private
   */
  _cleanup() {
    this._loadRequestId++;
    this._releaseCurrentSource();
  }

  /**
   * Clear the current file
   */
  clear() {
    this._cleanup();
  }

  /**
   * Clear caches without fully closing the source.
   * Used when deactivating to free memory while keeping the file reference.
   */
  clearCaches() {
    if (this._adapter) {
      this._adapter.clearCaches();
    }
    if (this._loader) {
      // Clear loader caches (gene expression, obs info)
      this._loader.clearCache();
    }
    console.log('[H5adDataSource] Cleared caches to free memory');
  }

  /**
   * Requires manual reconnection (file access)
   * @returns {boolean}
   */
  requiresManualReconnect() {
    return true;
  }
}

/**
 * Create an H5adDataSource instance
 * @returns {H5adDataSource}
 */
export function createH5adDataSource() {
  return new H5adDataSource();
}

// ============================================================================
// H5AD DATA PROVIDER
// ============================================================================

/**
 * Check if the current data source is an h5ad file
 * @returns {boolean}
 */
export function isH5adActive() {
  const manager = getDataSourceManager();
  const source = manager.activeSource;

  if (!source) return false;

  // Check if source is local-user in h5ad mode
  if (source.getType?.() === 'local-user') {
    return source.isH5adMode?.() === true;
  }

  // Check if source is h5ad type directly
  return source.getType?.() === 'h5ad';
}

/**
 * Get the active h5ad source adapter
 * @returns {Object|null} H5AD source or adapter
 */
export function getH5adAdapter() {
  const manager = getDataSourceManager();
  const source = manager.activeSource;

  if (!source) return null;

  // If local-user in h5ad mode
  if (source.getType?.() === 'local-user' && source.isH5adMode?.()) {
    return source.getH5adSource?.()?.getAdapter?.() || null;
  }

  // If h5ad source directly
  if (source.getType?.() === 'h5ad') {
    return source.getAdapter?.() || null;
  }

  return null;
}

/**
 * Get the active h5ad source
 * @returns {Object|null}
 */
export function getH5adSource() {
  const manager = getDataSourceManager();
  const source = manager.activeSource;

  if (!source) return null;

  // If local-user in h5ad mode
  if (source.getType?.() === 'local-user' && source.isH5adMode?.()) {
    return source.getH5adSource?.() || null;
  }

  // If h5ad source directly
  if (source.getType?.() === 'h5ad') {
    return source;
  }

  return null;
}

/**
 * Load points (embedding) from h5ad source
 * @param {number} dim - Dimension (1, 2, or 3)
 * @returns {Promise<Float32Array>}
 */
export async function h5adLoadPoints(dim) {
  const adapter = getH5adAdapter();
  if (!adapter) {
    throw new Error('No h5ad adapter available');
  }

  return adapter.getEmbedding(dim);
}

/**
 * Load obs manifest from h5ad source
 * @returns {Object}
 */
export function h5adGetObsManifest() {
  const adapter = getH5adAdapter();
  if (!adapter) {
    throw new Error('No h5ad adapter available');
  }

  return adapter.getObsManifest();
}

/**
 * Load var manifest from h5ad source
 * @returns {Object}
 */
export function h5adGetVarManifest() {
  const adapter = getH5adAdapter();
  if (!adapter) {
    throw new Error('No h5ad adapter available');
  }

  return adapter.getVarManifest();
}

/**
 * Load obs field data from h5ad source
 * @param {string} fieldKey - Field name
 * @returns {Promise<{data: ArrayBuffer, kind: string, categories?: string[]}>}
 */
export async function h5adLoadObsField(fieldKey) {
  const adapter = getH5adAdapter();
  if (!adapter) {
    throw new Error('No h5ad adapter available');
  }

  return adapter.getObsFieldData(fieldKey);
}

/**
 * Load gene expression from h5ad source
 * @param {string} geneName - Gene name
 * @returns {Promise<Float32Array>}
 */
export async function h5adLoadGeneExpression(geneName) {
  const adapter = getH5adAdapter();
  if (!adapter) {
    throw new Error('No h5ad adapter available');
  }

  return adapter.getGeneExpression(geneName);
}

/**
 * Load connectivity edges from h5ad source
 * @returns {Promise<{sources: Uint32Array, destinations: Uint32Array, weights: Float64Array, nEdges: number}|null>}
 */
export async function h5adLoadConnectivity() {
  const adapter = getH5adAdapter();
  if (!adapter) {
    return null;
  }

  return adapter.getConnectivityEdges();
}

/**
 * Get connectivity manifest from h5ad source
 * @param {{signal?: AbortSignal|null}} [options]
 * @returns {Promise<Object|null>}
 */
export async function h5adGetConnectivityManifest(options = {}) {
  const source = getH5adSource();
  if (!source) {
    throw new Error('No h5ad source available');
  }
  return source.getConnectivityManifest(options);
}

/**
 * Get dataset identity from h5ad source
 * @returns {Object}
 */
export function h5adGetDatasetIdentity() {
  const adapter = getH5adAdapter();
  if (!adapter) {
    throw new Error('No h5ad adapter available');
  }

  return adapter.getMetadata();
}

/**
 * Check if a URL is an h5ad:// URL
 * @param {string} url
 * @returns {boolean}
 */
export function isH5adUrl(url) {
  return url?.startsWith('h5ad://');
}

/**
 * Parse an h5ad:// URL
 * @param {string} url
 * @returns {{datasetId: string, path: string}|null}
 */
export function parseH5adUrl(url) {
  if (!isH5adUrl(url)) return null;

  // Format: h5ad://datasetId/path
  const withoutProtocol = url.substring('h5ad://'.length);
  const slashIdx = withoutProtocol.indexOf('/');

  if (slashIdx === -1) {
    return { datasetId: withoutProtocol, path: '' };
  }

  return {
    datasetId: withoutProtocol.substring(0, slashIdx),
    path: withoutProtocol.substring(slashIdx + 1)
  };
}
