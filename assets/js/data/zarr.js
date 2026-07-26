/**
 * Zarr Module for Cellucid
 *
 * Client-side JavaScript module for AnnData zarr directory support.
 * Provides sparse matrix support and lazy loading without needing a Python server.
 *
 * This module combines:
 * - ZarrLoader: Core loader for reading zarr directories in the browser
 * - ZarrDataSource: Data source providing the standard Cellucid interface
 * - ZarrDataProvider: Bridge functions for data source manager integration
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FEATURES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * - Reads .zarr directories directly in the browser via FileSystemDirectoryHandle or FileList
 * - Handles sparse matrices (CSR/CSC) with automatic conversion for efficiency
 * - Individual datasets (embeddings, obs fields, genes) loaded on-demand
 * - Lazy loading of gene expression data
 * - Automatic UMAP dimension detection
 * - Provides the same interface as other data sources (local-demo, local-user, remote, h5ad)
 * - Compatible with the Cellucid data format
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ZARR STRUCTURE FOR ANNDATA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ├── .zattrs          # Root attributes (encoding-type, encoding-version)
 * ├── .zgroup          # Group marker
 * ├── X/               # Gene expression matrix (may be sparse)
 * │   ├── .zarray/.zattrs
 * │   └── data/, indices/, indptr/ (for sparse)
 * ├── obs/             # Cell metadata
 * │   ├── .zattrs      # Column order, _index
 * │   └── {field}/     # Each field as separate array
 * ├── var/             # Gene metadata
 * │   ├── .zattrs      # Column order, _index
 * │   └── {field}/     # Each field
 * ├── obsm/            # Embeddings
 * │   └── X_umap_1d/, X_umap_2d/, X_umap_3d/
 * └── obsp/            # Pairwise observations
 *     └── connectivities/ (sparse)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PERFORMANCE CHARACTERISTICS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Zarr has better lazy loading characteristics than h5ad because each array
 * chunk is stored as a separate file. However, all file metadata is still
 * loaded upfront when the directory is opened.
 *
 * For large datasets, consider using prepare() for best performance.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DATA PROVIDER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This module provides a bridge between the standard Cellucid data loaders
 * and the Zarr directory loader. When the active data source is a zarr directory,
 * the provider intercepts data requests and fulfills them directly from
 * the zarr files instead of fetching URLs.
 *
 * This allows the rest of the application to work unchanged while supporting
 * zarr directories as a data source.
 */

import { getNotificationCenter } from '../app/notification-center.js';
import {
  addSparseFloat32,
  buildCscFromCsr,
  getSparseColumn
} from './sparse-utils.js';
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
import {
  getZarrZipEntryExtractionWorkingBytes,
  readZarrZipArchive
} from './zarr-archive.js';
import {
  accountZarrStringStorage,
  decodeZarrChunk,
  estimateZarrChunkWorkingBytes,
  getZarrDtypeInfo,
  MAX_ZARR_CHUNK_BYTES,
  MAX_ZARR_ENCODED_CHUNK_BYTES,
  MAX_ZARR_MATERIALIZED_ARRAY_BYTES,
  MAX_ZARR_METADATA_BYTES,
  validateZarrArrayMetadata,
  validateZarrMaterialization,
  zarrChunkKey
} from './zarr-codecs.js';

// ============================================================================
// ZARR LOADER
// ============================================================================

// Maximum number of gene expression arrays to cache (LRU eviction beyond this)
const MAX_GENE_CACHE_SIZE = 100;
const MAX_GENE_CACHE_BYTES = 256 * 1024 * 1024;
const MAX_CELLUCID_CATEGORIES = 65_535;

// Dense X cache guardrail:
// Caching the full dense X matrix can be multi-GB (n_obs × n_vars × dtype_size).
// Above this threshold we read only the needed chunk-column per gene to keep memory bounded.
const MAX_DENSE_X_CACHE_BYTES = 256 * 1024 * 1024; // 256MB

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
      if (value !== 0 && value !== 1) {
        throw new Error('Zarr boolean values must be encoded as 0 or 1');
      }
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

function obsDtypeFromZarr(dtypeInfo) {
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

function retainedZarrArrayBytes(meta, dtypeInfo) {
  const count = BigInt(meta.shape[0]);
  if (dtypeInfo.category === 'numeric') {
    return count * BigInt(dtypeInfo.materializedBytes ?? dtypeInfo.bytes);
  }

  let bytes = count * 72n; // result slot plus conservative JS string object
  if (dtypeInfo.category === 'fixed-string') {
    const utf16Multiplier = dtypeInfo.encoding === 'bytes' ? 2n : 1n;
    bytes += count * BigInt(dtypeInfo.bytes) * utf16Multiplier;
  }
  return bytes;
}

function transientZarrStringBytes(meta, dtypeInfo) {
  if (dtypeInfo.category !== 'object' &&
      dtypeInfo.category !== 'fixed-string') {
    return 0n;
  }
  const chunkItems = BigInt(meta.chunks[0]);
  let bytes = chunkItems * 72n; // temporary pointer and string object
  if (dtypeInfo.category === 'fixed-string') {
    const utf16Multiplier = dtypeInfo.encoding === 'bytes' ? 2n : 1n;
    bytes += chunkItems * BigInt(dtypeInfo.bytes) * utf16Multiplier;
  } else {
    bytes += BigInt(MAX_ZARR_CHUNK_BYTES) * 2n;
  }
  return bytes;
}

function validateNullableWorkingSet(
  valuesMeta,
  maskMeta,
  valuesInfo,
  maskInfo,
  encodingType,
  label
) {
  const valuesLength = validateZarrMaterialization(valuesMeta, valuesInfo);
  const maskLength = validateZarrMaterialization(maskMeta, maskInfo);
  if (valuesLength !== maskLength) {
    throw new Error(
      `${label} values and mask lengths differ (${valuesLength} versus ${maskLength})`
    );
  }

  const outputBytesPerItem =
    encodingType === 'nullable-integer' ? 4n : 8n;
  const retainedBytes =
    retainedZarrArrayBytes(valuesMeta, valuesInfo) +
    retainedZarrArrayBytes(maskMeta, maskInfo) +
    BigInt(valuesLength) * outputBytesPerItem;
  // Values and masks are deliberately read in sequence below. Their decoder
  // workspaces therefore cannot coexist, while both retained arrays and the
  // public nullable output can. Model that actual lifetime instead of making
  // every Blosc-compressed VLenUTF8 field impossible in the browser.
  const valuesDecoderBytes =
    transientZarrStringBytes(valuesMeta, valuesInfo) +
    estimateZarrChunkWorkingBytes(valuesMeta, valuesInfo);
  const maskDecoderBytes =
    estimateZarrChunkWorkingBytes(maskMeta, maskInfo);
  const peakBytes =
    retainedBytes +
    (valuesDecoderBytes > maskDecoderBytes
      ? valuesDecoderBytes
      : maskDecoderBytes);
  if (peakBytes > BigInt(MAX_ZARR_MATERIALIZED_ARRAY_BYTES)) {
    throw new Error(
      `${label} nullable working set exceeds the ${MAX_ZARR_MATERIALIZED_ARRAY_BYTES}-byte browser limit; use the Cellucid server or prepared format`
    );
  }
  return {
    valuesLength,
    retainedBytes,
    peakBytes
  };
}

function validateCellucidCategoryCount(categoryCount, key) {
  if (!Number.isSafeInteger(categoryCount) || categoryCount < 0) {
    throw new Error(`Categorical categories for '${key}' have an invalid length`);
  }
  if (categoryCount > MAX_CELLUCID_CATEGORIES) {
    throw new Error(
      `Categorical field '${key}' has ` +
      `${categoryCount.toLocaleString('en-US')} categories, but Cellucid supports ` +
      `at most ${MAX_CELLUCID_CATEGORIES.toLocaleString('en-US')}. ` +
      'Reduce or merge categories before loading the dataset.'
    );
  }
  return categoryCount;
}

function maximumBigInt(...values) {
  return values.reduce(
    (maximum, value) => value > maximum ? value : maximum,
    0n
  );
}

function normalizeChunkWorkingBytes(value) {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new Error('Invalid Zarr chunk working-set plan');
    return value;
  }
  if (Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw new Error('Invalid Zarr chunk working-set plan');
}

function validateObservationFieldWorkingSet(
  meta,
  dtypeInfo,
  key,
  axisLabel = 'Observation'
) {
  const elementCount = validateZarrMaterialization(meta, dtypeInfo);
  if (dtypeInfo.category !== 'numeric') {
    return { elementCount };
  }

  const count = BigInt(elementCount);
  const sourceBytes = retainedZarrArrayBytes(meta, dtypeInfo);
  const readPeakBytes =
    sourceBytes + estimateZarrChunkWorkingBytes(meta, dtypeInfo);
  let conversionPeakBytes = sourceBytes;
  let publicPeakBytes = 0n;
  if (dtypeInfo.kind === 'boolean') {
    // The loader converts the byte-backed array to JavaScript booleans. The
    // shared adapter then retains those values while producing Int32 codes and
    // the final Uint8 public categorical buffer.
    conversionPeakBytes += count * 8n;
    publicPeakBytes = count * (8n + 4n + 1n);
  } else if (dtypeInfo.ArrayType !== Float32Array) {
    conversionPeakBytes += count * 4n;
  }

  const peakBytes = maximumBigInt(
    readPeakBytes,
    conversionPeakBytes,
    publicPeakBytes
  );
  if (peakBytes > BigInt(MAX_ZARR_MATERIALIZED_ARRAY_BYTES)) {
    throw new Error(
      `${axisLabel} field '${key}' working set exceeds the ${MAX_ZARR_MATERIALIZED_ARRAY_BYTES}-byte browser limit; use the Cellucid server or prepared format`
    );
  }
  return { elementCount, peakBytes };
}

function estimateNormalizedCategoryBytes(meta, dtypeInfo) {
  const count = BigInt(meta.shape[0]);
  if (dtypeInfo.category === 'object' ||
      dtypeInfo.category === 'fixed-string') {
    return retainedZarrArrayBytes(meta, dtypeInfo);
  }
  // Booleans are canonical primitives. Numeric labels may require boxed
  // numbers in addition to their array slots on some browser engines.
  return count * (dtypeInfo.kind === 'boolean' ? 8n : 24n);
}

function measureNormalizedCategoryBytes(categories, key) {
  validateCellucidCategoryCount(categories.length, key);
  let bytes = BigInt(categories.length) * 8n;
  for (const category of categories) {
    if (typeof category === 'string') {
      bytes += 64n + BigInt(category.length) * 2n;
    } else if (typeof category === 'number') {
      bytes += 16n;
    } else if (typeof category !== 'boolean') {
      throw new Error(
        `Categorical categories for '${key}' must be strings, numbers, or booleans`
      );
    }
  }
  return bytes;
}

function validateDirectCategoryWorkingSet(meta, dtypeInfo, normalizedBytes, key) {
  validateZarrMaterialization(meta, dtypeInfo);
  const sourceBytes = retainedZarrArrayBytes(meta, dtypeInfo);
  // String arrays are already materialized as JavaScript arrays and are reused
  // directly. Numeric and boolean labels require a normalized public array
  // while the source typed array is still alive.
  const normalizationPeakBytes =
    dtypeInfo.category === 'numeric'
      ? sourceBytes + normalizedBytes
      : sourceBytes;
  if (normalizationPeakBytes > BigInt(MAX_ZARR_MATERIALIZED_ARRAY_BYTES)) {
    throw new Error(
      `Categorical categories for '${key}' working set exceeds the ${MAX_ZARR_MATERIALIZED_ARRAY_BYTES}-byte browser limit; use the Cellucid server or prepared format`
    );
  }
}

function validateCategoricalWorkingSet(
  codesMeta,
  codesInfo,
  categoryCount,
  categoryBytes,
  key
) {
  validateCellucidCategoryCount(categoryCount, key);
  const codeCount = validateZarrMaterialization(codesMeta, codesInfo);
  const count = BigInt(codeCount);
  const rawCodeBytes = retainedZarrArrayBytes(codesMeta, codesInfo);
  const normalizedCodeBytes = count * 4n;
  const publicCodeBytes =
    count * BigInt(categoryCount > 254 ? 2 : 1);

  // Categories are loaded first and retained. Code decoding, loader
  // normalization, and adapter-public conversion happen in sequence, so only
  // the arrays live at each phase are combined here.
  const readPeakBytes =
    categoryBytes +
    rawCodeBytes +
    estimateZarrChunkWorkingBytes(codesMeta, codesInfo);
  const normalizationPeakBytes =
    categoryBytes + rawCodeBytes + normalizedCodeBytes;
  const publicPeakBytes =
    categoryBytes + normalizedCodeBytes + publicCodeBytes;
  const peakBytes = maximumBigInt(
    readPeakBytes,
    normalizationPeakBytes,
    publicPeakBytes
  );
  if (peakBytes > BigInt(MAX_ZARR_MATERIALIZED_ARRAY_BYTES)) {
    throw new Error(
      `Categorical field '${key}' working set exceeds the ${MAX_ZARR_MATERIALIZED_ARRAY_BYTES}-byte browser limit; use the Cellucid server or prepared format`
    );
  }
  return { codeCount, peakBytes };
}

function validateEmbeddingMeta(meta, key, expectedRows) {
  const label = `Embedding '${key}'`;
  const dtypeInfo = validateZarrArrayMetadata(meta, label);
  if (dtypeInfo.category !== 'numeric') {
    throw new Error(`${label} must use a numeric dtype`);
  }
  if (meta.shape.length !== 2) {
    throw new Error(`${label} must be a two-dimensional array`);
  }
  if (meta.shape[0] !== expectedRows) {
    throw new Error(
      `${label} has ${meta.shape[0]} rows but expected ${expectedRows} cells`
    );
  }
  const nDims = meta.shape[1];
  if (!Number.isSafeInteger(nDims) || nDims < 1 || nDims > 3) {
    throw new Error(`${label} must have between 1 and 3 positive columns`);
  }
  validateZarrMaterialization(meta, dtypeInfo);
  const { outputBytes } = validateFloat32Materialization(meta, label);
  // BaseAnnDataAdapter retains the loader's raw Float32 coordinates while it
  // materializes and caches a second, normalized Float32 embedding. Guard that
  // public working set before any coordinate payload is read.
  if (outputBytes * 2n > BigInt(MAX_ZARR_MATERIALIZED_ARRAY_BYTES)) {
    throw new Error(
      `${label} public working set exceeds the ${MAX_ZARR_MATERIALIZED_ARRAY_BYTES}-byte browser limit; use the Cellucid server or prepared format`
    );
  }
  return { dtypeInfo, shape: [...meta.shape], nDims };
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

function numericValueToFloat32(value, label, requireExactInteger = false) {
  const number = numericValueToNumber(value, label);
  const narrowed = Math.fround(number);
  if (Number.isFinite(number) && !Number.isFinite(narrowed)) {
    throw new Error(`${label} value is outside the Float32 range`);
  }
  if (requireExactInteger && Number(narrowed) !== number) {
    throw new Error(
      `${label} integer value ${number} cannot be represented exactly in Float32`
    );
  }
  return narrowed;
}

function validateFiniteZarrCoordinates(values, label) {
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

function numericArrayToFloat32(values, label) {
  if (values instanceof Float32Array) return values;

  const requireExactInteger =
    values instanceof Int8Array ||
    values instanceof Uint8Array ||
    values instanceof Int16Array ||
    values instanceof Uint16Array ||
    values instanceof Int32Array ||
    values instanceof Uint32Array ||
    values instanceof BigInt64Array ||
    values instanceof BigUint64Array;
  const result = new Float32Array(values.length);
  for (let index = 0; index < values.length; index++) {
    result[index] = numericValueToFloat32(
      values[index],
      label,
      requireExactInteger
    );
  }
  return result;
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
    return Array.from(values, value => {
      if (value !== 0 && value !== 1 && value !== false && value !== true) {
        throw new Error(`${label} boolean values must be encoded as 0 or 1`);
      }
      return Boolean(value);
    });
  }

  return Array.from(values, value => {
    const number = numericValueToNumber(value, label);
    if (!Number.isFinite(number)) {
      throw new Error(`${label} cannot contain non-finite numeric labels`);
    }
    return number;
  });
}

export function prepareZarrArrayAllocation(
  meta,
  minimumChunkWorkingBytes = 0n
) {
  const dtypeInfo = validateZarrArrayMetadata(meta);
  const fill = normalizeFillValue(meta.fill_value, dtypeInfo);
  const totalElements = validateZarrMaterialization(
    meta,
    dtypeInfo,
    minimumChunkWorkingBytes
  );
  return { dtypeInfo, totalElements, fill };
}

function getFloat32MaterializationBytes(meta, dtypeInfo) {
  const elementCount = meta.shape.reduce(
    (product, dimension) => product * BigInt(dimension),
    1n
  );
  const sourceBytes = elementCount *
    BigInt(dtypeInfo.materializedBytes ?? dtypeInfo.bytes);
  const outputBytes = elementCount * 4n;
  const conversionBytes = dtypeInfo.ArrayType === Float32Array ? 0n : outputBytes;
  return {
    outputBytes,
    workingBytes: sourceBytes + conversionBytes
  };
}

function validateFloat32Materialization(meta, label) {
  const dtypeInfo = validateZarrArrayMetadata(meta, label);
  if (dtypeInfo.category !== 'numeric') {
    throw new Error(`${label} has unsupported dtype: ${meta.dtype}`);
  }
  const sizes = getFloat32MaterializationBytes(meta, dtypeInfo);
  if (sizes.workingBytes > BigInt(MAX_ZARR_MATERIALIZED_ARRAY_BYTES)) {
    throw new Error(
      `${label} working set exceeds the ${MAX_ZARR_MATERIALIZED_ARRAY_BYTES}-byte browser limit; use the Cellucid server or prepared format`
    );
  }
  return { dtypeInfo, ...sizes };
}

export function validateDenseColumnContract(
  meta,
  minimumChunkWorkingBytes = 0n
) {
  const dtypeInfo = validateZarrArrayMetadata(meta, 'Dense X column');
  if (dtypeInfo.category !== 'numeric') {
    throw new Error(`Dense X has unsupported dtype: ${meta.dtype}`);
  }
  if (meta.shape.length !== 2) {
    throw new Error('Dense X must be a two-dimensional Zarr array');
  }

  const nRows = BigInt(meta.shape[0]);
  const chunkElements = BigInt(meta.chunks[0]) * BigInt(meta.chunks[1]);
  const decodedChunkBytes = chunkElements * BigInt(dtypeInfo.bytes);
  const estimatedChunkWorkingBytes =
    estimateZarrChunkWorkingBytes(meta, dtypeInfo);
  const requestedChunkWorkingBytes =
    normalizeChunkWorkingBytes(minimumChunkWorkingBytes);
  const chunkWorkingBytes = maximumBigInt(
    estimatedChunkWorkingBytes,
    requestedChunkWorkingBytes
  );
  const workingBytes =
    nRows * 4n + chunkWorkingBytes;
  if (decodedChunkBytes > BigInt(MAX_ZARR_CHUNK_BYTES) ||
      workingBytes > BigInt(MAX_ZARR_MATERIALIZED_ARRAY_BYTES)) {
    throw new Error(
      requestedChunkWorkingBytes > estimatedChunkWorkingBytes
        ? `Dense X column plus ZIP extraction working set exceeds the ${MAX_ZARR_MATERIALIZED_ARRAY_BYTES}-byte browser limit; use the Cellucid server or prepared format`
        : `Dense X column working set exceeds the ${MAX_ZARR_MATERIALIZED_ARRAY_BYTES}-byte browser limit; use the Cellucid server or prepared format`
    );
  }
  return dtypeInfo;
}

export function validateSparseArrayContract({
  format,
  shape,
  dataMeta,
  indicesMeta,
  indptrMeta,
  dataChunkWorkingBytes = 0n,
  indicesChunkWorkingBytes = 0n,
  indptrChunkWorkingBytes = 0n
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
  if (dataInfo.category !== 'numeric') {
    throw new Error('Sparse data must use a numeric dtype');
  }
  if (indicesInfo.kind !== 'integer' && indicesInfo.kind !== 'bigint') {
    throw new Error('Sparse indices must use an integer dtype');
  }
  if (indptrInfo.kind !== 'integer' && indptrInfo.kind !== 'bigint') {
    throw new Error('Sparse indptr must use an integer dtype');
  }

  const dataLength = validateZarrMaterialization(dataMeta, dataInfo);
  const indicesLength = validateZarrMaterialization(indicesMeta, indicesInfo);
  const indptrLength = validateZarrMaterialization(indptrMeta, indptrInfo);
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

  let workingBytes =
    BigInt(dataLength) * BigInt(dataInfo.bytes) +
    BigInt(indicesLength) * BigInt(indicesInfo.bytes) +
    BigInt(indptrLength) * BigInt(indptrInfo.bytes);

  // Conservatively include normalized Float32/Int32 arrays while source arrays
  // are still retained during validation and conversion.
  workingBytes += BigInt(dataLength + indicesLength + indptrLength) * 4n;

  if (format === 'csr') {
    const columnCount = BigInt(shape[1]);
    // CSC data/indices plus the count, pointer, and position scratch arrays.
    workingBytes += BigInt(dataLength) * 8n + columnCount * 12n + 4n;
  }

  // A requested gene is materialized as one Float32 value per observation.
  workingBytes += BigInt(shape[0]) * 4n;
  const sourceBytes =
    BigInt(dataLength) * BigInt(dataInfo.bytes) +
    BigInt(indicesLength) * BigInt(indicesInfo.bytes) +
    BigInt(indptrLength) * BigInt(indptrInfo.bytes);
  const dataChunkBytes = maximumBigInt(
    estimateZarrChunkWorkingBytes(dataMeta, dataInfo),
    normalizeChunkWorkingBytes(dataChunkWorkingBytes)
  );
  const indicesChunkBytes = maximumBigInt(
    estimateZarrChunkWorkingBytes(indicesMeta, indicesInfo),
    normalizeChunkWorkingBytes(indicesChunkWorkingBytes)
  );
  const indptrChunkBytes = maximumBigInt(
    estimateZarrChunkWorkingBytes(indptrMeta, indptrInfo),
    normalizeChunkWorkingBytes(indptrChunkWorkingBytes)
  );
  const readPeakBytes = [
    BigInt(dataLength) * BigInt(dataInfo.bytes) +
      dataChunkBytes,
    BigInt(dataLength) * BigInt(dataInfo.bytes) +
      BigInt(indicesLength) * BigInt(indicesInfo.bytes) +
      indicesChunkBytes,
    sourceBytes + indptrChunkBytes
  ].reduce((maximum, value) => value > maximum ? value : maximum, 0n);
  if (readPeakBytes > workingBytes) {
    workingBytes = readPeakBytes;
  }
  if (workingBytes > BigInt(MAX_ZARR_MATERIALIZED_ARRAY_BYTES)) {
    throw new Error(
      `Sparse matrix working set exceeds the ${MAX_ZARR_MATERIALIZED_ARRAY_BYTES}-byte browser limit; use the Cellucid server or prepared format`
    );
  }

  return { dataInfo, indicesInfo, indptrInfo };
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
export class ZarrLoader {
  constructor() {
    /** @type {Map<string, File>|null} Map of path -> File objects */
    this._files = null;

    /** @type {Map<string, bigint>|null} ZIP extraction peak by array path */
    this._archiveChunkWorkingBytesByArray = null;

    /** @type {string|null} */
    this._rootName = null;

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

    /** @type {Map<string, Object>} General cache */
    this._cache = new Map();

    /** @type {Map<string, Float32Array>} LRU cache for gene expression */
    this._geneCache = new Map();

    /** @type {number} Bytes retained by the gene-expression LRU */
    this._geneCacheBytes = 0;

    /** @type {Object|null} Sparse X matrix info */
    this._sparseX = null;

    /** @type {Promise|null} Promise for CSR→CSC conversion to prevent race conditions */
    this._sparseXLoadPromise = null;

    /** @type {Float32Array|null} Dense X matrix cache */
    this._denseX = null;

    /** @type {Promise<Float32Array>|null} Shared initialization of the dense X cache */
    this._denseXLoadPromise = null;

    /** @type {boolean} */
    this._xIsSparse = false;

    /** @type {Object|null} Root .zattrs */
    this._rootAttrs = null;

    /** @type {number} Invalidates asynchronous results after clear/replacement */
    this._generation = 0;

    /** @type {number} Ensures the latest directory-selection request wins */
    this._openRequestId = 0;
  }

  _assertOpenRequest(requestId) {
    if (requestId !== this._openRequestId) {
      throw createDatasetReloadSupersededError(
        'Zarr open request was superseded by a newer selection.'
      );
    }
  }

  /**
   * Open a zarr directory from FileList
   * @param {FileList} fileList - Files from <input type="file" webkitdirectory>
   * @param {Object} [options]
   * @param {boolean} [options.showProgress=true]
   * @returns {Promise<void>}
   */
  async open(fileList, options = {}) {
    if (!fileList || fileList.length === 0) {
      throw new Error('No files provided');
    }

    const requestId = ++this._openRequestId;
    const { showProgress = true } = options;
    const notifications = showProgress ? getNotificationCenter() : null;
    const trackerId = notifications
      ? notifications.startDownload('Loading Zarr directory')
      : null;
    let adopted = false;

    try {
      // Build a candidate index without mutating the currently open dataset.
      const files = new Map();

      // Get root directory name from first file's path
      const firstPath = (
        fileList[0].webkitRelativePath || fileList[0].name
      ).replace(/\\/g, '/');
      const pathParts = firstPath.split('/');
      const rootName = pathParts[0];

      let loadedBytes = 0;
      const totalBytes = Array.from(fileList).reduce((sum, f) => sum + f.size, 0);

      for (const file of fileList) {
        const relativePath = (
          file.webkitRelativePath || file.name
        ).replace(/\\/g, '/');
        // Remove root directory from path to get internal path
        const internalPath = relativePath.split('/').slice(1).join('/');
        if (internalPath) {
          files.set(internalPath, file);
        }

        loadedBytes += file.size;
        notifications?.updateDownload(trackerId, loadedBytes, totalBytes);
      }

      if (files.size === 0) {
        throw new Error(
          'No Zarr directory structure was provided. Select the .zarr directory, not an individual file.'
        );
      }
      const hasRequiredMetadata = Array.from(files.keys()).some(
        path => /(^|\/)\.(zgroup|zarray|zattrs)$/.test(path)
      );
      if (!hasRequiredMetadata) {
        throw new Error(
          'This browser omitted the required Zarr v2 metadata files from the selected directory. ' +
          'Load the same store as a Zarr ZIP archive, or use the Cellucid server/prepared format.'
        );
      }
      console.log(`[ZarrLoader] Indexed ${files.size} files from: ${rootName}`);

      await this._openFileMapForRequest(files, rootName, requestId);
      adopted = true;

      if (notifications !== null) {
        notifications.completeDownload(trackerId);
      }
      console.log(`[ZarrLoader] Opened ${this._rootName}: ${this._nObs} cells, ${this._nVars} genes`);

    } catch (error) {
      let terminalError = error instanceof Error
        ? error
        : new TypeError(
            'Zarr directory opening must reject with an Error.',
            { cause: error }
          );
      if (!adopted && notifications !== null) {
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
            'Zarr directory opening and failure reporting both failed.'
          );
        }
      }
      throw terminalError;
    }
  }

  /**
   * Validate and adopt an already indexed Zarr file map transactionally.
   * The existing dataset remains usable if candidate validation fails.
   *
   * @param {Map<string, File|Object>} files
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

    const requestId = ++this._openRequestId;
    await this._openFileMapForRequest(files, rootName, requestId);
  }

  async _openFileMapForRequest(files, rootName, requestId) {
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
      this._varNameIndex = candidate._varNameIndex;
      this._obsmKeys = candidate._obsmKeys;
      this._cache = candidate._cache;
      this._geneCache = candidate._geneCache;
      this._geneCacheBytes = candidate._geneCacheBytes;
      this._sparseX = candidate._sparseX;
      this._sparseXLoadPromise = candidate._sparseXLoadPromise;
      this._denseX = candidate._denseX;
      this._denseXLoadPromise = candidate._denseXLoadPromise;
      this._xIsSparse = candidate._xIsSparse;
      this._rootAttrs = candidate._rootAttrs;
      this._archiveChunkWorkingBytesByArray =
        candidate._archiveChunkWorkingBytesByArray;
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

  _getArchiveChunkWorkingBytes(arrayPath) {
    if (this._archiveChunkWorkingBytesByArray === null) {
      const arrayPaths = new Set();
      for (const path of this._files?.keys() ?? []) {
        if (path === '.zarray') {
          arrayPaths.add('');
        } else if (path.endsWith('/.zarray')) {
          arrayPaths.add(path.slice(0, -'/.zarray'.length));
        }
      }

      const workingBytesByArray = new Map();
      for (const [path, file] of this._files ?? []) {
        const leafName = path.slice(path.lastIndexOf('/') + 1);
        if (leafName.startsWith('.')) continue;
        const extractionBytes =
          getZarrZipEntryExtractionWorkingBytes(file);
        if (extractionBytes === 0n) continue;

        const slashIndex = path.lastIndexOf('/');
        let parentPath =
          slashIndex === -1 ? '' : path.slice(0, slashIndex);
        while (true) {
          if (arrayPaths.has(parentPath)) {
            const previous = workingBytesByArray.get(parentPath) ?? 0n;
            if (extractionBytes > previous) {
              workingBytesByArray.set(parentPath, extractionBytes);
            }
            break;
          }
          const parentSlash = parentPath.lastIndexOf('/');
          if (parentSlash === -1) break;
          parentPath = parentPath.slice(0, parentSlash);
        }
      }
      this._archiveChunkWorkingBytesByArray = workingBytesByArray;
    }
    return this._archiveChunkWorkingBytesByArray.get(arrayPath) ?? 0n;
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
    if (Number.isFinite(file.size) && file.size > MAX_ZARR_METADATA_BYTES) {
      throw new Error(
        `Zarr metadata file '${path}' exceeds the ${MAX_ZARR_METADATA_BYTES}-byte browser limit`
      );
    }
    const text = await file.text();
    this._assertGeneration(generation, `reading metadata '${path}'`);
    if (text.length > MAX_ZARR_METADATA_BYTES) {
      throw new Error(
        `Zarr metadata file '${path}' exceeds the ${MAX_ZARR_METADATA_BYTES}-byte browser limit`
      );
    }
    return JSON.parse(text);
  }

  async _readChunkFile(path) {
    const generation = this._generation;
    const file = this._files?.get(path);
    if (!file) {
      throw new Error(`File not found: ${path}`);
    }
    if (Number.isFinite(file.size) && file.size > MAX_ZARR_ENCODED_CHUNK_BYTES) {
      throw new Error(
        `Zarr chunk file '${path}' exceeds the ${MAX_ZARR_ENCODED_CHUNK_BYTES}-byte browser limit`
      );
    }
    const buffer = await file.arrayBuffer();
    this._assertGeneration(generation, `reading chunk '${path}'`);
    if (buffer.byteLength > MAX_ZARR_ENCODED_CHUNK_BYTES) {
      throw new Error(
        `Zarr chunk file '${path}' exceeds the ${MAX_ZARR_ENCODED_CHUNK_BYTES}-byte browser limit`
      );
    }
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
   * Read a zarr array (all chunks)
   * @param {string} arrayPath - Path to array
   * @returns {Promise<{data: TypedArray, shape: number[], dtype: string}>}
   * @private
   */
  async _readArray(arrayPath) {
    const generation = this._generation;
    const meta = await this._readArrayMeta(arrayPath);
    this._assertGeneration(generation, `reading array '${arrayPath}'`);
    const { dtypeInfo, totalElements, fill } = prepareZarrArrayAllocation(
      meta,
      this._getArchiveChunkWorkingBytes(arrayPath)
    );
    const { shape, dtype, chunks } = meta;
    this._requireDefinedAbsentChunkFill(arrayPath, meta, fill);

    if (dtypeInfo.category !== 'numeric') {
      return this._readStringArray(
        arrayPath,
        meta,
        dtypeInfo,
        totalElements,
        fill,
        generation
      );
    }

    const result = new dtypeInfo.ArrayType(totalElements);
    result.fill(fill);

    const numChunks = shape.map((s, i) => Math.ceil(s / chunks[i]));
    const dimensionSeparator = meta.dimension_separator ?? '.';

    if (shape.length === 1) {
      for (let c = 0; c < numChunks[0]; c++) {
        const chunkPath = `${arrayPath}/${zarrChunkKey([c], dimensionSeparator)}`;
        if (this._exists(chunkPath)) {
          const encoded = await this._readChunkFile(chunkPath);
          const decoded = await decodeZarrChunk(encoded, meta, dtypeInfo, chunks[0]);
          this._assertGeneration(generation, `reading array '${arrayPath}'`);
          const chunkData = typedArrayFromChunk(decoded, dtypeInfo);
          const startIdx = c * chunks[0];
          const copyLen = Math.min(chunks[0], shape[0] - startIdx);
          result.set(chunkData.subarray(0, copyLen), startIdx);
        }
      }
    } else {
      await this._readNDArray(
        arrayPath,
        meta,
        result,
        dtypeInfo,
        numChunks,
        generation
      );
    }

    this._assertGeneration(generation, `reading array '${arrayPath}'`);
    return { data: result, shape, dtype };
  }

  /**
   * Read an N-dimensional array
   * @private
   */
  async _readNDArray(
    arrayPath,
    meta,
    result,
    dtypeInfo,
    numChunks,
    generation = this._generation
  ) {
    const { shape, chunks, order } = meta;
    const [nRows, nCols] = shape;
    const [chunkRows, chunkCols] = chunks;
    const chunkElementCount = chunkRows * chunkCols;
    const dimensionSeparator = meta.dimension_separator ?? '.';

    for (let cr = 0; cr < numChunks[0]; cr++) {
      for (let cc = 0; cc < numChunks[1]; cc++) {
        const chunkKey = zarrChunkKey([cr, cc], dimensionSeparator);
        const chunkPath = `${arrayPath}/${chunkKey}`;
        if (!this._exists(chunkPath)) continue;

        const encoded = await this._readChunkFile(chunkPath);
        const decoded = await decodeZarrChunk(
          encoded,
          meta,
          dtypeInfo,
          chunkElementCount
        );
        this._assertGeneration(generation, `reading array '${arrayPath}'`);
        const chunkData = typedArrayFromChunk(decoded, dtypeInfo);

        const rowStart = cr * chunkRows;
        const colStart = cc * chunkCols;
        const rowEnd = Math.min(rowStart + chunkRows, nRows);
        const colEnd = Math.min(colStart + chunkCols, nCols);
        const actualChunkCols = colEnd - colStart;

        if (order === 'C') {
          for (let row = rowStart; row < rowEnd; row++) {
            const chunkRow = row - rowStart;
            const sourceOffset = chunkRow * chunkCols;
            const destinationOffset = row * nCols + colStart;
            result.set(
              chunkData.subarray(sourceOffset, sourceOffset + actualChunkCols),
              destinationOffset
            );
          }
        } else {
          for (let row = rowStart; row < rowEnd; row++) {
            for (let column = colStart; column < colEnd; column++) {
              const chunkRow = row - rowStart;
              const chunkColumn = column - colStart;
              const chunkIndex = chunkColumn * chunkRows + chunkRow;
              result[row * nCols + column] = chunkData[chunkIndex];
            }
          }
        }
      }
    }
  }

  /**
   * Read a string array
   * @private
   */
  async _readStringArray(
    arrayPath,
    meta,
    dtypeInfo,
    totalElements,
    fill,
    generation = this._generation
  ) {
    const { shape, dtype, chunks } = meta;
    if (shape.length !== 1) {
      throw new Error(`Unsupported ${shape.length}D string array at '${arrayPath}'`);
    }

    const result = new Array(totalElements);
    result.fill(fill);
    const reservedStringWorkingBytes = Number(
      BigInt(chunks[0]) * 8n +
      estimateZarrChunkWorkingBytes(meta, dtypeInfo)
    );
    let retainedStringBytes = totalElements * 8;
    if (totalElements > 0) {
      retainedStringBytes = accountZarrStringStorage(
        retainedStringBytes,
        [fill],
        reservedStringWorkingBytes
      );
    }
    const dimensionSeparator = meta.dimension_separator ?? '.';
    const numChunks = Math.ceil(shape[0] / chunks[0]);

    for (let chunkIndex = 0; chunkIndex < numChunks; chunkIndex++) {
      const chunkKey = zarrChunkKey([chunkIndex], dimensionSeparator);
      const chunkPath = `${arrayPath}/${chunkKey}`;
      if (!this._exists(chunkPath)) continue;

      const encoded = await this._readChunkFile(chunkPath);
      const decoded = await decodeZarrChunk(encoded, meta, dtypeInfo, chunks[0]);
      this._assertGeneration(generation, `reading array '${arrayPath}'`);
      const strings = dtypeInfo.category === 'object'
        ? decoded
        : decodeFixedStringChunk(decoded, dtypeInfo, chunks[0]);
      // First guard the actual transient chunk strings while encoded/decoded
      // buffers and the chunk pointer array are still live.
      accountZarrStringStorage(
        retainedStringBytes,
        strings,
        reservedStringWorkingBytes
      );
      const startIndex = chunkIndex * chunks[0];
      const copyLength = Math.min(chunks[0], shape[0] - startIndex);
      // Only logical edge values survive in the result. Do not accumulate
      // overhanging padding strings as though they remained live forever.
      retainedStringBytes = accountZarrStringStorage(
        retainedStringBytes,
        strings,
        0,
        copyLength
      );
      for (let itemIndex = 0; itemIndex < copyLength; itemIndex++) {
        result[startIndex + itemIndex] = strings[itemIndex];
      }
    }

    this._assertGeneration(generation, `reading array '${arrayPath}'`);
    return { data: result, shape, dtype };
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
    this._varNameIndex.clear();
    this._obsmKeys = [];
    this._xIsSparse = false;

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
      this._xIsSparse = false;
      const xMeta = await this._readCurrentAnnDataArrayMeta(
        'X',
        'Dense X',
        'array'
      );
      validateDenseColumnContract(
        xMeta,
        this._getArchiveChunkWorkingBytes('X')
      );
      xShape = [...xMeta.shape];
    } else if (hasSparseXRepresentation) {
      const sparseMetadata = await this._readSparseMetadataContract('X');
      this._xIsSparse = true;
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

    // Build the lookup only after the complete typed index and axis length have
    // passed validation.
    this._varNameIndex.clear();
    for (let i = 0; i < this._varNames.length; i++) {
      const name = this._varNames[i];
      if (this._varNameIndex.has(name)) {
        throw new Error(
          `Duplicate var name '${name}'; call adata.var_names_make_unique() before browser loading`
        );
      }
      this._varNameIndex.set(name, i);
    }

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
      // List obsm keys by finding subdirectories with .zarray
      this._obsmKeys = [];
      for (const path of this._files.keys()) {
        if (path.startsWith('obsm/') && path.endsWith('/.zarray')) {
          const key = path.split('/')[1];
          if (!this._obsmKeys.includes(key)) {
            this._obsmKeys.push(key);
          }
        }
      }
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
  get obsmKeys() { return [...this._obsmKeys]; }
  get isOpen() { return this._files !== null && this._files.size > 0; }
  get hasExpressionMatrix() {
    return this._files !== null &&
      (this._exists('X/.zarray') || this._exists('X/.zgroup'));
  }

  /**
   * Get embedding shape without loading full array data.
   * Used for dimension detection to avoid loading large embeddings just to get nDims.
   * @param {string} key - Exact obsm key (for example, 'X_umap_3d')
   * @returns {Promise<{shape: number[], nDims: number}>}
   */
  async getEmbeddingShape(key) {
    this._ensureOpen();
    const generation = this._generation;

    await this._readCurrentAnnDataGroupAttrs(
      'obsm',
      'AnnData obsm mapping',
      'dict',
      '0.1.0'
    );
    this._assertGeneration(generation, `reading embedding '${key}'`);

    const arrayPath = `obsm/${key}`;
    if (!this._exists(`${arrayPath}/.zarray`)) {
      throw new Error(`Embedding '${key}' not found in obsm. Available: ${this._obsmKeys.join(', ')}`);
    }

    // Read and validate only .zarray metadata; no coordinate chunk is loaded.
    const meta = await this._readCurrentAnnDataArrayMeta(
      arrayPath,
      `Embedding '${key}'`,
      'array'
    );
    this._assertGeneration(generation, `reading embedding '${key}'`);
    const { shape, nDims } = validateEmbeddingMeta(meta, key, this._nObs);
    return { shape, nDims };
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

    const arrayPath = `obsm/${key}`;
    if (!this._exists(`${arrayPath}/.zarray`)) {
      throw new Error(`Embedding '${key}' not found in obsm. Available: ${this._obsmKeys.join(', ')}`);
    }

    const { shape: validatedShape, nDims } = await this.getEmbeddingShape(key);
    this._assertGeneration(generation, `loading embedding '${key}'`);
    const { data, shape: loadedShape } = await this._readArray(arrayPath);
    this._assertGeneration(generation, `loading embedding '${key}'`);
    if (loadedShape[0] !== validatedShape[0] ||
        loadedShape[1] !== validatedShape[1]) {
      throw new Error(`Embedding '${key}' metadata changed while it was loading`);
    }
    validateFiniteZarrCoordinates(
      data,
      `Embedding '${key}'`
    );
    const result = {
      data: numericArrayToFloat32(data, `Embedding '${key}'`),
      shape: loadedShape,
      nDims
    };

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

    // Check LRU cache
    if (this._geneCache.has(geneName)) {
      const cached = this._geneCache.get(geneName);
      this._geneCache.delete(geneName);
      this._geneCache.set(geneName, cached);
      return cached;
    }

    let result;

    if (this._xIsSparse) {
      result = await this._getSparseColumn(geneIdx);
    } else {
      result = await this._getDenseColumn(geneIdx);
    }
    this._assertGeneration(
      generation,
      `loading gene expression '${geneName}'`
    );

    // LRU cache management is bounded by retained bytes as well as item count.
    const resultBytes = result?.byteLength;
    if (Number.isSafeInteger(resultBytes) && resultBytes >= 0 &&
        resultBytes <= MAX_GENE_CACHE_BYTES) {
      while (this._geneCache.size > 0 &&
             (this._geneCache.size >= MAX_GENE_CACHE_SIZE ||
              this._geneCacheBytes + resultBytes > MAX_GENE_CACHE_BYTES)) {
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
   * Get a column from sparse X matrix
   * @private
   */
  async _getSparseColumn(colIdx) {
    const generation = this._generation;
    let sparseMatrix = this._sparseX;
    // Load sparse matrix if not cached
    // Use Promise-based lock to prevent race conditions when multiple concurrent calls
    // both see !this._sparseX and start the expensive CSR→CSC conversion simultaneously
    if (!sparseMatrix) {
      if (!this._sparseXLoadPromise) {
        this._sparseXLoadPromise = (async () => {
          const sparse = await this._readSparseMatrix(
            'X',
            'float32'
          );

          // If CSR, convert to CSC for efficient column access using shared utility
          if (sparse.format === 'csr') {
            const nnz = sparse.data?.length || 0;
            console.log(`[ZarrLoader] Converting CSR to CSC (${(nnz / 1e6).toFixed(1)}M non-zeros) for efficient gene access...`);
            const startTime = performance.now();
            sparse.cscData = buildCscFromCsr(sparse);
            console.log(`[ZarrLoader] CSR→CSC conversion complete in ${(performance.now() - startTime).toFixed(0)}ms`);

            // MEMORY OPTIMIZATION: Release original CSR arrays since we only use CSC for column access
            sparse.data = null;
            sparse.indices = null;
            sparse.indptr = null;
          }
          return sparse;
        })();
      }
      const loadPromise = this._sparseXLoadPromise;
      try {
        sparseMatrix = await loadPromise;
        this._assertGeneration(generation, 'loading sparse X');
        if (this._sparseXLoadPromise === loadPromise) {
          this._sparseX = sparseMatrix;
        }
      } finally {
        if (this._sparseXLoadPromise === loadPromise) {
          this._sparseXLoadPromise = null;
        }
      }
    }

    if (!Number.isSafeInteger(colIdx) ||
        colIdx < 0 ||
        colIdx >= sparseMatrix.shape[1]) {
      throw new Error(`Sparse X column index ${colIdx} is out of bounds`);
    }
    if (this._nObs !== sparseMatrix.shape[0]) {
      throw new Error(
        `Sparse X row dimension ${sparseMatrix.shape[0]} does not match obs dimension ${this._nObs}`
      );
    }

    if (sparseMatrix.format === 'csr') {
      // Use CSC format via shared utility
      return getSparseColumn(sparseMatrix.cscData, colIdx, this._nObs);
    } else {
      // CSC - direct column access
      const { data, indices, indptr } = sparseMatrix;
      const result = new Float32Array(this._nObs);
      const start = indptr[colIdx];
      const end = indptr[colIdx + 1];

      for (let j = start; j < end; j++) {
        const rowIndex = indices[j];
        result[rowIndex] = addSparseFloat32(
          result[rowIndex],
          data[j],
          'Sparse X column',
          sparseMatrix.exactInteger === true
        );
      }
      return result;
    }
  }

  /**
   * Get a column from dense X matrix
   * @private
   */
  async _getDenseColumn(colIdx) {
    const generation = this._generation;
    // For dense gene expression, avoid allocating the entire X matrix for large datasets.
    // Instead, read only the chunk-column that contains `colIdx` for each chunk-row.

    const metaCacheKey = 'meta:X';
    /** @type {{shape: number[], dtype: string, chunks: number[], compressor: any, order?: string, fill_value?: any}|null} */
    let meta = this._cache.get(metaCacheKey) || null;
    if (!meta) {
      meta = await this._readCurrentAnnDataArrayMeta(
        'X',
        'Dense X',
        'array'
      );
      this._assertGeneration(generation, 'loading dense X metadata');
      this._cache.set(metaCacheKey, meta);
    }

    const dtypeInfo = validateDenseColumnContract(
      meta,
      this._getArchiveChunkWorkingBytes('X')
    );
    const { shape, chunks, order, fill_value } = meta;

    const [nRows, nCols] = shape;
    const [chunkRows, chunkCols] = chunks;
    if (!Number.isSafeInteger(colIdx) || colIdx < 0 || colIdx >= nCols) {
      throw new Error(`Dense X column index ${colIdx} is out of bounds`);
    }
    const denseSizes = getFloat32MaterializationBytes(meta, dtypeInfo);
    const denseCachePeakBytes = denseSizes.workingBytes + BigInt(nRows) * 4n;
    const canCacheDense =
      denseSizes.outputBytes > 0n &&
      denseSizes.outputBytes <= BigInt(MAX_DENSE_X_CACHE_BYTES) &&
      denseCachePeakBytes <= BigInt(MAX_ZARR_MATERIALIZED_ARRAY_BYTES);

    if (canCacheDense) {
      // Fast path for small datasets.
      if (!this._denseX) {
        const loadPromise = this._denseXLoadPromise ??= (async () => {
          const { data } = await this._readArray('X');
          return numericArrayToFloat32(data, 'Dense X');
        })();
        let denseMatrix;
        try {
          denseMatrix = await loadPromise;
          this._assertGeneration(generation, 'loading dense X');
          if (this._denseXLoadPromise === loadPromise) {
            this._denseX = denseMatrix;
          }
        } finally {
          if (this._denseXLoadPromise === loadPromise) {
            this._denseXLoadPromise = null;
          }
        }
        if (!this._denseX) this._denseX = denseMatrix;
      }

      this._assertGeneration(generation, 'loading dense X');
      const out = new Float32Array(nRows);
      for (let i = 0; i < nRows; i++) {
        out[i] = this._denseX[i * nCols + colIdx];
      }
      return out;
    }

    const fill = normalizeFillValue(fill_value, dtypeInfo);
    const colChunk = Math.floor(colIdx / chunkCols);
    const colInChunk = colIdx - (colChunk * chunkCols);
    const numChunkRows = Math.ceil(nRows / chunkRows);
    const dimensionSeparator = meta.dimension_separator ?? '.';
    if (fill === null) {
      for (let chunkRow = 0; chunkRow < numChunkRows; chunkRow++) {
        const chunkKey = zarrChunkKey(
          [chunkRow, colChunk],
          dimensionSeparator
        );
        if (!this._exists(`X/${chunkKey}`)) {
          throw new Error(
            "Dense X has an absent required chunk while fill_value is null, so its contents are undefined"
          );
        }
      }
    }
    const exactInteger =
      dtypeInfo.kind === 'integer' || dtypeInfo.kind === 'bigint';
    const floatFill = numericValueToFloat32(
      fill,
      'Dense X',
      exactInteger
    );
    const out = new Float32Array(nRows);
    out.fill(floatFill);

    const isFortran = order === 'F';
    const chunkElementCount = chunkRows * chunkCols;

    for (let cr = 0; cr < numChunkRows; cr++) {
      const chunkKey = zarrChunkKey([cr, colChunk], dimensionSeparator);
      const chunkPath = `X/${chunkKey}`;
      const rowStart = cr * chunkRows;
      const rowEnd = Math.min(rowStart + chunkRows, nRows);

      if (!this._exists(chunkPath)) {
        continue;
      }

      const encoded = await this._readChunkFile(chunkPath);
      const decoded = await decodeZarrChunk(
        encoded,
        meta,
        dtypeInfo,
        chunkElementCount
      );
      this._assertGeneration(generation, 'loading dense X column');
      const chunkData = typedArrayFromChunk(decoded, dtypeInfo);

      if (!isFortran) {
        // C-order: contiguous rows; pick one value per row at colInChunk.
        for (let r = rowStart; r < rowEnd; r++) {
          const chunkR = r - rowStart;
          const srcIdx = chunkR * chunkCols + colInChunk;
          out[r] = numericValueToFloat32(
            chunkData[srcIdx],
            'Dense X',
            exactInteger
          );
        }
      } else {
        // Fortran order: column-major within chunk.
        for (let r = rowStart; r < rowEnd; r++) {
          const chunkR = r - rowStart;
          const srcIdx = colInChunk * chunkRows + chunkR;
          out[r] = numericValueToFloat32(
            chunkData[srcIdx],
            'Dense X',
            exactInteger
          );
        }
      }
    }

    this._assertGeneration(generation, 'loading dense X column');
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
      dataChunkWorkingBytes:
        this._getArchiveChunkWorkingBytes(`${groupPath}/data`),
      indicesChunkWorkingBytes:
        this._getArchiveChunkWorkingBytes(`${groupPath}/indices`),
      indptrChunkWorkingBytes:
        this._getArchiveChunkWorkingBytes(`${groupPath}/indptr`)
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
   * Read a sparse matrix from zarr
   * @private
   */
  async _readSparseMatrix(groupPath, dataMode) {
    if (dataMode !== 'float32' && dataMode !== 'exact') {
      throw new TypeError(
        `Sparse matrix data mode must be exactly "float32" or "exact"`
      );
    }
    const {
      format,
      shape,
      dataInfo
    } = await this._readSparseMetadataContract(groupPath);

    const { data: dataArr } = await this._readArray(`${groupPath}/data`);
    const { data: indicesArr } = await this._readArray(`${groupPath}/indices`);
    const { data: indptrArr } = await this._readArray(`${groupPath}/indptr`);

    if (dataArr.length !== indicesArr.length) {
      throw new Error(
        `Sparse data and indices lengths differ (${dataArr.length} versus ${indicesArr.length})`
      );
    }

    const data = dataMode === 'exact'
      ? dataArr
      : numericArrayToFloat32(dataArr, 'Sparse data');
    const indices = toSparseInt32Array(indicesArr, 'index');
    const indptr = toSparseInt32Array(indptrArr, 'indptr');

    const pointerAxis = format === 'csr' ? shape[0] : shape[1];
    const indexAxis = format === 'csr' ? shape[1] : shape[0];
    if (indptr.length !== pointerAxis + 1) {
      throw new Error(
        `Sparse indptr length ${indptr.length} does not match ${format.toUpperCase()} axis size ${pointerAxis}`
      );
    }
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

    // Sanity check: prevent OOM from corrupted data with unreasonably large shape
    // Typical single-cell datasets have < 10M cells, sparse matrices < 100M non-zeros
    const MAX_REASONABLE_DIM = 50_000_000;  // 50M cells
    const MAX_REASONABLE_NNZ = 500_000_000; // 500M non-zeros
    if (shape[0] > MAX_REASONABLE_DIM || shape[1] > MAX_REASONABLE_DIM) {
      throw new Error(
        `Sparse matrix shape (${shape[0]}×${shape[1]}) exceeds reasonable limits. ` +
        `Data may be corrupted. Max dimension: ${MAX_REASONABLE_DIM.toLocaleString()}`
      );
    }
    if (data.length > MAX_REASONABLE_NNZ) {
      throw new Error(
        `Sparse matrix has ${data.length.toLocaleString()} non-zeros, exceeding limit of ${MAX_REASONABLE_NNZ.toLocaleString()}. ` +
        `Data may be corrupted.`
      );
    }

    return {
      data,
      indices,
      indptr,
      shape,
      format,
      cscData: null,
      exactInteger:
        dataInfo.kind === 'integer' || dataInfo.kind === 'bigint'
    };
  }

  // Note: CSR→CSC conversion uses the shared buildCscFromCsr() from sparse-utils.js

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
    const workingSet = validateNullableWorkingSet(
      valuesMeta,
      maskMeta,
      valuesInfo,
      maskInfo,
      encodingType,
      `Field '${key}'`
    );
    return { valuesMeta, maskMeta, valuesInfo, maskInfo, workingSet };
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
      const categoryBytes = estimateNormalizedCategoryBytes(
        categoriesMeta,
        categoriesInfo
      );
      validateDirectCategoryWorkingSet(
        categoriesMeta,
        categoriesInfo,
        categoryBytes,
        key
      );
      return {
        kind: 'array',
        categoriesPath,
        categoriesMeta,
        categoriesInfo,
        categoryCount,
        categoryBytes
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
      categoryBytes: estimateNormalizedCategoryBytes(
        nullableContract.valuesMeta,
        nullableContract.valuesInfo
      ),
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
      const codesInfo = validateCategoricalCodesMeta(
        codesMeta,
        key,
        expectedLength,
        expectedAxis
      );
      const categoryContract =
        await this._readCategoricalCategoriesContract(fieldPath, key);
      validateCategoricalWorkingSet(
        codesMeta,
        codesInfo,
        categoryContract.categoryCount,
        categoryContract.categoryBytes,
        key
      );
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
              : obsDtypeFromZarr(valuesInfo))
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
      validateObservationFieldWorkingSet(
        meta,
        dtypeInfo,
        key,
        axisLabel
      );
      result = { dtype: obsDtypeFromZarr(dtypeInfo) };
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
      const codesInfo =
        validateCategoricalCodesMeta(codesMeta, key, this._nObs);
      const categoryContract =
        await this._readCategoricalCategoriesContract(fieldPath, key);
      validateCategoricalWorkingSet(
        codesMeta,
        codesInfo,
        categoryContract.categoryCount,
        categoryContract.categoryBytes,
        key
      );
      const categories = await this._readCategoricalCategories(
        fieldPath,
        key,
        categoryContract
      );
      validateCategoricalWorkingSet(
        codesMeta,
        codesInfo,
        categories.length,
        measureNormalizedCategoryBytes(categories, key),
        key
      );
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
              : obsDtypeFromZarr(valuesInfo))
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
      validateObservationFieldWorkingSet(meta, dtypeInfo, key);
      result = { dtype: obsDtypeFromZarr(dtypeInfo) };
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
      const codesInfo =
        validateCategoricalCodesMeta(codesMeta, key, this._nObs);
      const cachedInfo = this._cache.get(`obs_info:${key}`);
      let categories;
      if (cachedInfo?.dtype === 'categorical' &&
          Array.isArray(cachedInfo.categories)) {
        categories = cachedInfo.categories;
      } else {
        const categoryContract =
          await this._readCategoricalCategoriesContract(fieldPath, key);
        validateCategoricalWorkingSet(
          codesMeta,
          codesInfo,
          categoryContract.categoryCount,
          categoryContract.categoryBytes,
          key
        );
        // Load the bounded category dictionary first. Its exact string storage
        // is then known before any potentially large code payload is requested.
        categories = await this._readCategoricalCategories(
          fieldPath,
          key,
          categoryContract
        );
      }
      validateCategoricalWorkingSet(
        codesMeta,
        codesInfo,
        categories.length,
        measureNormalizedCategoryBytes(categories, key),
        key
      );
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
        result = {
          dtype: 'bool',
          values: Array.from(
            rawValues,
            (value, index) => mask[index] ? null : Boolean(value)
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
          dtype: obsDtypeFromZarr(valuesInfo),
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
      validateObservationFieldWorkingSet(meta, dtypeInfo, key);
      const { data } = await this._readArray(fieldPath);
      const fieldDtype = obsDtypeFromZarr(dtypeInfo);
      let values;
      if (fieldDtype === 'bool') {
        values = Array.from(data, value => Boolean(value));
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
   * Validate optional connectivity metadata without loading matrix payloads.
   * @returns {Promise<Object|null>}
   */
  async _getConnectivityMetadata() {
    this._ensureOpen();
    const generation = this._generation;

    if (this._cache.has('connectivity:metadata')) {
      return this._cache.get('connectivity:metadata');
    }

    const connPath = 'obsp/connectivities';
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
      this._cache.set('connectivity:metadata', null);
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
      this._cache.set('connectivity:metadata', null);
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
      if (dtypeInfo.category !== 'numeric') {
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
      validateZarrMaterialization(meta, dtypeInfo);
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
    this._cache.set('connectivity:metadata', result);
    return result;
  }

  /**
   * Report whether an explicit connectivity representation is available
   * without materializing its payload.
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
    if (metadata === null) {
      return null;
    }

    const connPath = 'obsp/connectivities';
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
    this._cache.set('connectivities', result);
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

    // Detect available UMAP dimensions using shape metadata only (no full array loading)
    const availableDimensions = new Set();
    const embeddingKeysByDimension = {};

    for (const dim of [1, 2, 3]) {
      const key = `X_umap_${dim}d`;
      if (!this._obsmKeys.includes(key)) continue;
      const { nDims } = await this.getEmbeddingShape(key);
      this._assertGeneration(generation, 'building dataset metadata');
      if (nDims !== dim) {
        throw new Error(
          `Embedding '${key}' has ${nDims} columns, but its ${dim}D suffix requires exactly ${dim}`
        );
      }
      availableDimensions.add(dim);
      embeddingKeysByDimension[`${dim}d`] = key;
    }

    this._assertGeneration(generation, 'building dataset metadata');
    const availableDimensionsList = Array.from(availableDimensions);
    if (availableDimensionsList.length === 0) {
      throw new Error(
        'AnnData Zarr requires an exact UMAP embedding in obsm: ' +
        'X_umap_1d, X_umap_2d, or X_umap_3d'
      );
    }

    availableDimensionsList.sort((a, b) => a - b);
    const defaultDimension =
      availableDimensionsList[availableDimensionsList.length - 1];

    // Count field types
    let nCategorical = 0;
    let nContinuous = 0;

    for (const key of this._obsKeys) {
      const info = await this._getObsFieldTypeInfo(key);
      this._assertGeneration(generation, 'building dataset metadata');
      if (info.dtype === 'categorical') nCategorical++;
      else if (info.dtype === 'float' || info.dtype === 'int' || info.dtype === 'uint') nContinuous++;
    }

    const hasConnectivity = await this.hasConnectivities();
    this._assertGeneration(generation, 'building dataset metadata');

    // This is an adapter-construction descriptor, not a public dataset
    // identity. ZarrDataSource publishes the sole validated v2 identity only
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
   * Clear all cached data
   */
  clearCache() {
    this._generation++;
    this._cache.clear();
    this._geneCache.clear();
    this._geneCacheBytes = 0;
    this._sparseX = null;
    this._sparseXLoadPromise = null;  // Clear conversion promise to allow fresh conversion
    this._denseX = null;
    this._denseXLoadPromise = null;
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
    this._archiveChunkWorkingBytesByArray = null;

    this._rootName = null;

    // Clear all caches (including gene cache and sparse matrices)
    this.clearCache();

    // Reset all state
    this._nObs = 0;
    this._nVars = 0;
    this._obsKeys = [];
    this._varNames = [];
    this._varNameIndex.clear();
    this._obsmKeys = [];
    this._xIsSparse = false;
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

/**
 * Check if a FileList appears to be a zarr directory
 * @param {FileList} files - FileList to check
 * @returns {boolean}
 */
export function isZarrDirectory(files) {
  if (!files || files.length === 0) return false;

  // Check if any file has .zarr in the path
  for (const file of files) {
    const path = file.webkitRelativePath || file.name;
    if (path.includes('.zarr/') || path.endsWith('.zarr')) {
      return true;
    }
    // Also check for .zarray or .zgroup files (indicates zarr structure)
    if (path.endsWith('.zarray') || path.endsWith('.zgroup')) {
      return true;
    }
  }
  return false;
}

/**
 * Create a ZarrLoader instance
 * @returns {ZarrLoader}
 */
export function createZarrLoader() {
  return new ZarrLoader();
}

// ============================================================================
// ZARR DATA SOURCE
// ============================================================================

/**
 * Zarr-specific adapter extending the shared BaseAnnDataAdapter.
 * Any zarr-specific overrides would go here.
 */
class ZarrDataAdapter extends BaseAnnDataAdapter {
  /**
   * @param {ZarrLoader} loader - The zarr loader
   */
  constructor(loader) {
    super(loader);
  }

  // ZarrDataAdapter uses all methods from BaseAnnDataAdapter without modification.
  // Any zarr-specific overrides can be added here if needed in the future.
}

/**
 * Zarr Data Source for Cellucid
 * Provides the same interface as LocalUserDirDataSource but for zarr directories
 */
export class ZarrDataSource {
  constructor() {
    /** @type {ZarrLoader|null} */
    this._loader = null;

    /** @type {ZarrDataAdapter|null} */
    this._adapter = null;

    /** @type {string|null} */
    this.datasetId = null;

    /** @type {string|null} */
    this.dirname = null;

    /** @type {Object|null} */
    this._metadata = null;

    /** @type {Map<string, string>} Blob URLs for virtual files */
    this._blobUrls = new Map();

    /** @type {number} Latest directory-selection request identity */
    this._loadRequestId = 0;

    this.type = 'zarr';
  }

  _assertLoadRequest(requestId) {
    if (requestId !== this._loadRequestId) {
      throw createDatasetReloadSupersededError(
        'Zarr load request was superseded by a newer selection.'
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

  _showDirectLoadWarning(kind) {
    const notifications = getNotificationCenter();
    notifications.warning(
      `Loaded a Zarr ${kind} directly in the browser. Note: ` +
      '(1) File metadata is loaded upfront, ' +
      '(2) No quantization means larger gene-expression memory use, and ' +
      '(3) Gene-expression reads may be slower than prepared data. ' +
      'For large datasets, use the Cellucid server or prepared format.',
      { duration: 15000 }
    );
  }

  async _runLoadTransaction(
    requestId,
    progressName,
    showProgress,
    operation
  ) {
    const notifications = showProgress ? getNotificationCenter() : null;
    const trackerId = notifications
      ? notifications.startDownload(progressName)
      : null;
    let adopted = false;
    try {
      const result = await operation();
      this._assertLoadRequest(requestId);
      adopted = true;
      if (notifications !== null) {
        notifications.completeDownload(trackerId);
      }
      return result;
    } catch (error) {
      let terminalError = error instanceof Error
        ? error
        : new TypeError(
            'Zarr source loading must reject with an Error.',
            { cause: error }
          );
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
            'Zarr source loading and failure reporting both failed.'
          );
        }
      }
      throw terminalError;
    }
  }

  async _loadCandidate(
    requestId,
    candidateDirname,
    openCandidate,
    identityOptions
  ) {
    const candidateLoader = createZarrLoader();
    let candidateAdapter = null;
    let adopted = false;
    try {
      await openCandidate(candidateLoader);
      this._assertLoadRequest(requestId);
      candidateAdapter = new ZarrDataAdapter(candidateLoader);
      await candidateAdapter.initialize();
      this._assertLoadRequest(requestId);

      const candidateDatasetId =
        identityOptions.datasetId ??
        `zarr_${candidateDirname.replace(/\.zarr$/i, '')}`;
      const candidateMetadata =
        await candidateAdapter.finalizeDirectIdentity({
          id: candidateDatasetId,
          name: candidateDirname.replace(/\.zarr$/i, ''),
          description: identityOptions.description,
          cellucidDataVersion: 'zarr_loader',
          source: identityOptions.source,
        });
      this._assertLoadRequest(requestId);

      this._releaseCurrentSource();
      this._loader = candidateLoader;
      this._adapter = candidateAdapter;
      this.dirname = candidateDirname;
      this.datasetId = candidateDatasetId;
      this._metadata = candidateMetadata;
      adopted = true;

      console.log(
        `[ZarrDataSource] Loaded ${this.dirname}: ` +
        `${this._loader.nObs} cells, ${this._loader.nVars} genes`
      );
      return this._metadata;
    } catch (error) {
      let terminalError = error instanceof Error
        ? error
        : new TypeError(
            'Zarr candidate loading must reject with an Error.',
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
            'Zarr candidate loading and cleanup both failed.'
          );
        }
      }
      throw terminalError;
    }
  }

  /**
   * Load a zarr directory from FileList
   * @param {FileList} fileList - FileList from <input type="file" webkitdirectory>
   * @param {Object} [options]
   * @param {boolean} [options.showProgress=true]
   * @param {string} [options.datasetId]
   * @param {string} [options.description]
   * @param {Object} [options.source]
   * @returns {Promise<Object>}
   */
  async loadFromFileList(fileList, options = {}) {
    if (!isZarrDirectory(fileList)) {
      throw new DataSourceError(
        'Not a zarr directory',
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
    }

    const requestId = ++this._loadRequestId;
    const {
      showProgress = true,
      datasetId = null,
      description = 'Loaded directly from Zarr directory',
      source = {
        name: 'Zarr directory',
      },
    } = options;
    const firstPath = (
      fileList[0].webkitRelativePath || fileList[0].name
    ).replace(/\\/g, '/');
    const candidateDirname = firstPath.split('/')[0];
    const result = await this._runLoadTransaction(
      requestId,
      `Loading ${candidateDirname}`,
      showProgress,
      () => this._loadCandidate(
        requestId,
        candidateDirname,
        candidateLoader => candidateLoader.open(
          fileList,
          { showProgress: false }
        ),
        { datasetId, description, source }
      )
    );
    if (showProgress) this._showDirectLoadWarning('directory');
    return result;
  }

  /**
   * Load one portable ZIP archive containing a Zarr v2 store.
   * Archive parsing and source adoption share the same latest-request identity.
   *
   * @param {File|Blob} file
   * @param {Object} [options]
   * @param {boolean} [options.showProgress=true]
   * @param {string} [options.datasetId]
   * @param {string} [options.description]
   * @param {Object} [options.source]
   * @returns {Promise<Object>}
   */
  async loadFromArchiveFile(file, options = {}) {
    if (!file || typeof file.arrayBuffer !== 'function') {
      throw new DataSourceError(
        'Not a Zarr ZIP archive',
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
    }

    const requestId = ++this._loadRequestId;
    const {
      showProgress = true,
      datasetId = null,
      description = 'Loaded directly from Zarr ZIP archive',
      source = {
        name: 'Zarr ZIP archive',
        ...(typeof file.name === 'string'
          ? { filename: file.name }
          : {}),
      },
    } = options;
    const result = await this._runLoadTransaction(
      requestId,
      `Loading ${file.name || 'Zarr ZIP archive'}`,
      showProgress,
      async () => {
        const { files, rootName } = await readZarrZipArchive(file, {
          archiveName: file.name || 'dataset.zarr.zip'
        });
        this._assertLoadRequest(requestId);
        return this._loadCandidate(
          requestId,
          rootName,
          candidateLoader => candidateLoader.openFileMap(files, rootName),
          { datasetId, description, source }
        );
      }
    );
    if (showProgress) this._showDirectLoadWarning('ZIP archive');
    return result;
  }

  /**
   * Load an already indexed Zarr v2 store transactionally.
   * Primarily used by archive/container adapters.
   *
   * @param {Map<string, File|Object>} files
   * @param {string} rootName
   * @param {Object} [options]
   * @param {boolean} [options.showProgress=true]
   * @param {string} [options.datasetId]
   * @param {string} [options.description]
   * @param {Object} [options.source]
   * @returns {Promise<Object>}
   */
  async loadFromFileMap(files, rootName, options = {}) {
    const requestId = ++this._loadRequestId;
    const {
      showProgress = true,
      datasetId = null,
      description = 'Loaded directly from Zarr store',
      source = {
        name: 'Zarr store',
      },
    } = options;
    const result = await this._runLoadTransaction(
      requestId,
      `Loading ${rootName}`,
      showProgress,
      () => this._loadCandidate(
        requestId,
        rootName,
        candidateLoader => candidateLoader.openFileMap(files, rootName),
        { datasetId, description, source }
      )
    );
    if (showProgress) this._showDirectLoadWarning('store');
    return result;
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
        'No zarr directory loaded',
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
        `Zarr dataset "${String(datasetId)}" is not the adopted dataset ` +
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
        `Zarr dataset "${String(datasetId)}" is not the adopted dataset ` +
        `"${String(this.datasetId)}"`,
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        {
          requestedId: datasetId,
          currentId: this.datasetId,
        }
      );
    }
    return `zarr://${this.datasetId}/`;
  }

  /**
   * Get the Zarr data adapter (for direct data access)
   * @returns {ZarrDataAdapter|null}
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
      throw new DataSourceError('No zarr directory loaded', DataSourceErrorCode.NOT_FOUND, this.type);
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
      throw new DataSourceError('No zarr directory loaded', DataSourceErrorCode.NOT_FOUND, this.type);
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
      throw new DataSourceError('No zarr directory loaded', DataSourceErrorCode.NOT_FOUND, this.type);
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
        'No zarr directory loaded',
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
      throw new DataSourceError('No zarr directory loaded', DataSourceErrorCode.NOT_FOUND, this.type);
    }
    return this._adapter.getObsManifest();
  }

  /**
   * Get var manifest
   * @returns {Object}
   */
  getVarManifest() {
    if (!this._adapter) {
      throw new DataSourceError('No zarr directory loaded', DataSourceErrorCode.NOT_FOUND, this.type);
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
      'Zarr connectivity manifest'
    );
    throwIfMetadataAborted(signal, 'Zarr connectivity manifest loading');
    if (!this._adapter) {
      throw new DataSourceError(
        'No zarr directory loaded',
        DataSourceErrorCode.NOT_FOUND,
        this.type
      );
    }
    const manifest = this._adapter.getConnectivityManifest();
    throwIfMetadataAborted(signal, 'Zarr connectivity manifest loading');
    return manifest;
  }

  /**
   * Resolve zarr:// URL (not really used, data is accessed directly)
   * @param {string} url
   * @returns {Promise<string>}
   */
  async resolveUrl(url) {
    throw new DataSourceError(
      'zarr source does not support URL resolution. Use direct data access methods.',
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
   * Release the active source without changing the selection epoch.
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
    this.dirname = null;
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
   * Clear the current directory
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
    console.log('[ZarrDataSource] Cleared caches to free memory');
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
 * Create a ZarrDataSource instance
 * @returns {ZarrDataSource}
 */
export function createZarrDataSource() {
  return new ZarrDataSource();
}

// ============================================================================
// ZARR DATA PROVIDER
// ============================================================================

/**
 * Check if the current data source is a zarr directory
 * @returns {boolean}
 */
export function isZarrActive() {
  const manager = getDataSourceManager();
  const source = manager.activeSource;

  if (!source) return false;

  // Check if source is local-user in zarr mode
  if (source.getType?.() === 'local-user') {
    return source.isZarrMode?.() === true;
  }

  // Check if source is zarr type directly
  return source.getType?.() === 'zarr';
}

/**
 * Get the active zarr source adapter
 * @returns {Object|null} Zarr source or adapter
 */
export function getZarrAdapter() {
  const manager = getDataSourceManager();
  const source = manager.activeSource;

  if (!source) return null;

  // If local-user in zarr mode
  if (source.getType?.() === 'local-user' && source.isZarrMode?.()) {
    return source.getZarrSource?.()?.getAdapter?.() || null;
  }

  // If zarr source directly
  if (source.getType?.() === 'zarr') {
    return source.getAdapter?.() || null;
  }

  return null;
}

/**
 * Get the active zarr source
 * @returns {Object|null}
 */
export function getZarrSource() {
  const manager = getDataSourceManager();
  const source = manager.activeSource;

  if (!source) return null;

  // If local-user in zarr mode
  if (source.getType?.() === 'local-user' && source.isZarrMode?.()) {
    return source.getZarrSource?.() || null;
  }

  // If zarr source directly
  if (source.getType?.() === 'zarr') {
    return source;
  }

  return null;
}

/**
 * Load points (embedding) from zarr source
 * @param {number} dim - Dimension (1, 2, or 3)
 * @returns {Promise<Float32Array>}
 */
export async function zarrLoadPoints(dim) {
  const adapter = getZarrAdapter();
  if (!adapter) {
    throw new Error('No zarr adapter available');
  }

  return adapter.getEmbedding(dim);
}

/**
 * Load obs manifest from zarr source
 * @returns {Object}
 */
export function zarrGetObsManifest() {
  const adapter = getZarrAdapter();
  if (!adapter) {
    throw new Error('No zarr adapter available');
  }

  return adapter.getObsManifest();
}

/**
 * Load var manifest from zarr source
 * @returns {Object}
 */
export function zarrGetVarManifest() {
  const adapter = getZarrAdapter();
  if (!adapter) {
    throw new Error('No zarr adapter available');
  }

  return adapter.getVarManifest();
}

/**
 * Load obs field data from zarr source
 * @param {string} fieldKey - Field name
 * @returns {Promise<{data: ArrayBuffer, kind: string, categories?: (string|number|boolean)[]}>}
 */
export async function zarrLoadObsField(fieldKey) {
  const adapter = getZarrAdapter();
  if (!adapter) {
    throw new Error('No zarr adapter available');
  }

  return adapter.getObsFieldData(fieldKey);
}

/**
 * Load gene expression from zarr source
 * @param {string} geneName - Gene name
 * @returns {Promise<Float32Array>}
 */
export async function zarrLoadGeneExpression(geneName) {
  const adapter = getZarrAdapter();
  if (!adapter) {
    throw new Error('No zarr adapter available');
  }

  return adapter.getGeneExpression(geneName);
}

/**
 * Load connectivity edges from zarr source
 * @returns {Promise<{sources: Uint32Array, destinations: Uint32Array, weights: Float64Array, nEdges: number}|null>}
 */
export async function zarrLoadConnectivity() {
  const adapter = getZarrAdapter();
  if (!adapter) {
    return null;
  }

  return adapter.getConnectivityEdges();
}

/**
 * Get connectivity manifest from zarr source
 * @param {{signal?: AbortSignal|null}} [options]
 * @returns {Promise<Object|null>}
 */
export async function zarrGetConnectivityManifest(options = {}) {
  const source = getZarrSource();
  if (!source) {
    throw new Error('No zarr source available');
  }
  return source.getConnectivityManifest(options);
}

/**
 * Get dataset identity from zarr source
 * @returns {Object}
 */
export function zarrGetDatasetIdentity() {
  const adapter = getZarrAdapter();
  if (!adapter) {
    throw new Error('No zarr adapter available');
  }

  return adapter.getMetadata();
}

/**
 * Check if a URL is a zarr:// URL
 * @param {string} url
 * @returns {boolean}
 */
export function isZarrUrl(url) {
  return url?.startsWith('zarr://');
}

/**
 * Parse a zarr:// URL
 * @param {string} url
 * @returns {{datasetId: string, path: string}|null}
 */
export function parseZarrUrl(url) {
  if (!isZarrUrl(url)) return null;

  // Format: zarr://datasetId/path
  const withoutProtocol = url.substring('zarr://'.length);
  const slashIdx = withoutProtocol.indexOf('/');

  if (slashIdx === -1) {
    return { datasetId: withoutProtocol, path: '' };
  }

  return {
    datasetId: withoutProtocol.substring(0, slashIdx),
    path: withoutProtocol.substring(slashIdx + 1)
  };
}
