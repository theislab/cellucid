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
 * │   └── X_umap/, X_umap_3d/, etc.
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
import { buildCscFromCsr, getSparseColumn, toInt32Array, toFloat32Array } from './sparse-utils.js';
import { DataSourceError, DataSourceErrorCode } from './data-source.js';
import { BaseAnnDataAdapter } from './base-anndata-adapter.js';
import { getDataSourceManager } from './data-source-manager.js';

// ============================================================================
// ZARR LOADER
// ============================================================================

// Maximum number of gene expression arrays to cache (LRU eviction beyond this)
const MAX_GENE_CACHE_SIZE = 100;

/**
 * Zarr dtype mapping to TypedArray
 */
const DTYPE_MAP = {
  '|b1': Uint8Array,    // bool
  '<i1': Int8Array,
  '<i2': Int16Array,
  '<i4': Int32Array,
  '<i8': BigInt64Array,
  '<u1': Uint8Array,
  '<u2': Uint16Array,
  '<u4': Uint32Array,
  '<u8': BigUint64Array,
  '<f4': Float32Array,
  '<f8': Float64Array,
  '>i2': Int16Array,    // Big-endian (will need byte swap)
  '>i4': Int32Array,
  '>i8': BigInt64Array,
  '>u2': Uint16Array,
  '>u4': Uint32Array,
  '>u8': BigUint64Array,
  '>f4': Float32Array,
  '>f8': Float64Array,
  '|S': 'string',       // Fixed-length string
  '|O': 'object',       // Object (strings in zarr)
  '<U': 'string',       // Unicode string
  '>U': 'string',
};

/**
 * Get bytes per element for a dtype
 */
function bytesPerElement(dtype) {
  if (dtype.includes('1')) return 1;
  if (dtype.includes('2')) return 2;
  if (dtype.includes('4')) return 4;
  if (dtype.includes('8')) return 8;
  return 4; // default
}

/**
 * Check if dtype is big-endian and needs byte swap
 */
function isBigEndian(dtype) {
  return dtype.startsWith('>');
}

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

/**
 * Decompress data using Blosc (via pako for zlib, or native for others)
 */
async function decompressBlosc(buffer) {
  const view = new DataView(buffer);

  // Blosc header: 16 bytes
  // byte 0: version (should be 2)
  // byte 1: versionlz (version of the internal compressor)
  // byte 2: flags
  // byte 3: typesize (element size)
  // bytes 4-7: nbytes (uncompressed size, little-endian)
  // bytes 8-11: blocksize
  // bytes 12-15: ctbytes (compressed size)

  const version = view.getUint8(0);
  const flags = view.getUint8(2);
  const typesize = view.getUint8(3);
  const nbytes = view.getUint32(4, true);
  const ctbytes = view.getUint32(12, true);

  const compressor = (flags >> 5) & 0x7;
  // 0 = blosclz, 1 = lz4, 2 = lz4hc, 3 = snappy, 4 = zlib, 5 = zstd

  // For now, we only support uncompressed blosc (compressor 0 with no shuffle)
  // or zlib-compressed blosc
  const compressedData = new Uint8Array(buffer, 16);

  if (compressor === 0 && flags === 0) {
    // No compression, just copy
    return buffer.slice(16, 16 + nbytes);
  }

  if (compressor === 4) {
    // zlib - use DecompressionStream or pako
    if (typeof DecompressionStream !== 'undefined') {
      try {
        const ds = new DecompressionStream('deflate');
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(compressedData);
            controller.close();
          }
        });
        const decompressed = await new Response(stream.pipeThrough(ds)).arrayBuffer();
        return decompressed;
      } catch (e) {
        console.warn('[ZarrLoader] DecompressionStream failed for blosc/zlib:', e);
      }
    }
    if (typeof pako !== 'undefined') {
      const decompressed = pako.inflate(compressedData);
      return decompressed.buffer.slice(decompressed.byteOffset, decompressed.byteOffset + decompressed.byteLength);
    }
    throw new Error('Blosc/zlib decompression not supported - need DecompressionStream or pako');
  }

  if (compressor === 5) {
    // zstd - not natively supported, would need external library
    throw new Error('Blosc/zstd compression not supported in browser. Use uncompressed or zlib-compressed zarr.');
  }

  if (compressor === 1 || compressor === 2) {
    // lz4 - not natively supported
    throw new Error('Blosc/lz4 compression not supported in browser. Use uncompressed or zlib-compressed zarr.');
  }

  if (compressor === 3) {
    // snappy - not natively supported
    throw new Error('Blosc/snappy compression not supported in browser. Use uncompressed or zlib-compressed zarr.');
  }

  // Unknown compressor - throw error to prevent silent data corruption
  // Previously this would return raw bytes which produced garbage data
  const compressorNames = ['blosclz', 'lz4', 'lz4hc', 'snappy', 'zlib', 'zstd'];
  const compressorName = compressorNames[compressor] || `unknown(${compressor})`;
  throw new Error(
    `Blosc compressor '${compressorName}' (code ${compressor}) not supported in browser. ` +
    `Use uncompressed or zlib-compressed zarr for browser compatibility.`
  );
}

/**
 * Decompress chunk data based on compressor settings
 */
async function decompressChunk(buffer, compressor) {
  if (!compressor || compressor.id === 'null') {
    return buffer;
  }

  const compId = compressor.id || compressor;

  if (compId === 'blosc') {
    return decompressBlosc(buffer);
  }

  if (compId === 'zlib' || compId === 'gzip') {
    if (typeof DecompressionStream !== 'undefined') {
      // DecompressionStream only accepts 'gzip', 'deflate', 'deflate-raw'
      // 'zlib' format uses deflate compression with zlib header/trailer
      const decompressionFormat = compId === 'zlib' ? 'deflate' : compId;
      const ds = new DecompressionStream(decompressionFormat);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(buffer));
          controller.close();
        }
      });
      return new Response(stream.pipeThrough(ds)).arrayBuffer();
    }
    if (typeof pako !== 'undefined') {
      const decompressed = pako.inflate(new Uint8Array(buffer));
      return decompressed.buffer.slice(decompressed.byteOffset, decompressed.byteOffset + decompressed.byteLength);
    }
    throw new Error('Zlib decompression not supported');
  }

  // Unknown compressor - throw error to prevent silent data corruption
  throw new Error(
    `Zarr compressor '${compId}' not supported in browser. ` +
    `Supported compressors: null, zlib, gzip, blosc (with zlib sub-compressor). ` +
    `Re-export your data with a supported compressor for browser compatibility.`
  );
}

/**
 * Zarr Loader for AnnData format stored in Zarr
 */
export class ZarrLoader {
  constructor() {
    /** @type {Map<string, File>|null} Map of path -> File objects */
    this._files = null;

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

    /** @type {Object|null} Sparse X matrix info */
    this._sparseX = null;

    /** @type {Promise|null} Promise for CSR→CSC conversion to prevent race conditions */
    this._sparseXLoadPromise = null;

    /** @type {Float32Array|null} Dense X matrix cache */
    this._denseX = null;

    /** @type {boolean} */
    this._xIsSparse = false;

    /** @type {Object|null} Root .zattrs */
    this._rootAttrs = null;
  }

  /**
   * Open a zarr directory from FileList
   * @param {FileList} fileList - Files from <input type="file" webkitdirectory>
   * @returns {Promise<void>}
   */
  async open(fileList) {
    if (!fileList || fileList.length === 0) {
      throw new Error('No files provided');
    }

    const notifications = getNotificationCenter();
    const trackerId = notifications.startDownload('Loading Zarr directory');

    try {
      // Index files by relative path
      this._files = new Map();

      // Get root directory name from first file's path
      const firstPath = fileList[0].webkitRelativePath || fileList[0].name;
      const pathParts = firstPath.split('/');
      this._rootName = pathParts[0];

      let loadedBytes = 0;
      const totalBytes = Array.from(fileList).reduce((sum, f) => sum + f.size, 0);

      for (const file of fileList) {
        const relativePath = file.webkitRelativePath || file.name;
        // Remove root directory from path to get internal path
        const internalPath = relativePath.split('/').slice(1).join('/');
        if (internalPath) {
          this._files.set(internalPath, file);
        }

        loadedBytes += file.size;
        notifications.updateDownload(trackerId, loadedBytes, totalBytes);
      }

      console.log(`[ZarrLoader] Indexed ${this._files.size} files from: ${this._rootName}`);

      // Read basic structure
      await this._readStructure();

      notifications.completeDownload(trackerId);
      console.log(`[ZarrLoader] Opened ${this._rootName}: ${this._nObs} cells, ${this._nVars} genes`);

    } catch (err) {
      notifications.failDownload(trackerId, err.message);
      throw err;
    }
  }

  /**
   * Read a JSON file from the zarr
   * @param {string} path - Path relative to zarr root
   * @returns {Promise<Object>}
   * @private
   */
  async _readJson(path) {
    const file = this._files.get(path);
    if (!file) {
      throw new Error(`File not found: ${path}`);
    }
    const text = await file.text();
    return JSON.parse(text);
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
   * Read a zarr array (all chunks)
   * @param {string} arrayPath - Path to array
   * @returns {Promise<{data: TypedArray, shape: number[], dtype: string}>}
   * @private
   */
  async _readArray(arrayPath) {
    const meta = await this._readArrayMeta(arrayPath);
    const { shape, dtype, chunks, compressor, order, fill_value } = meta;

    const TypedArrayClass = DTYPE_MAP[dtype];
    if (!TypedArrayClass || TypedArrayClass === 'string' || TypedArrayClass === 'object') {
      // Handle string arrays
      return this._readStringArray(arrayPath, meta);
    }

    // Calculate total elements and allocate result
    const totalElements = shape.reduce((a, b) => a * b, 1);
    const result = new TypedArrayClass(totalElements);

    // Read all chunks
    const numChunks = shape.map((s, i) => Math.ceil(s / chunks[i]));

    // For 1D arrays (most common case for obs fields)
    if (shape.length === 1) {
      for (let c = 0; c < numChunks[0]; c++) {
        const chunkPath = `${arrayPath}/${c}`;
        if (this._exists(chunkPath)) {
          const file = this._files.get(chunkPath);
          let buffer = await file.arrayBuffer();

          // Decompress if needed
          buffer = await decompressChunk(buffer, compressor);

          // Handle byte order
          if (isBigEndian(dtype)) {
            buffer = swapBytes(buffer, bytesPerElement(dtype));
          }

          const chunkData = new TypedArrayClass(buffer);
          const startIdx = c * chunks[0];
          const copyLen = Math.min(chunks[0], shape[0] - startIdx);
          result.set(chunkData.subarray(0, copyLen), startIdx);
        }
      }
    } else {
      // For 2D arrays (embeddings, gene expression)
      await this._readNDArray(arrayPath, meta, result, shape, chunks, numChunks, TypedArrayClass);
    }

    return { data: result, shape, dtype };
  }

  /**
   * Read an N-dimensional array
   * @private
   */
  async _readNDArray(arrayPath, meta, result, shape, chunks, numChunks, TypedArrayClass) {
    const { compressor, dtype, order } = meta;

    // For 2D: shape = [nRows, nCols], chunks = [chunkRows, chunkCols]
    if (shape.length === 2) {
      const [nRows, nCols] = shape;
      const [chunkRows, chunkCols] = chunks;

      for (let cr = 0; cr < numChunks[0]; cr++) {
        for (let cc = 0; cc < numChunks[1]; cc++) {
          const chunkPath = `${arrayPath}/${cr}.${cc}`;
          if (this._exists(chunkPath)) {
            const file = this._files.get(chunkPath);
            let buffer = await file.arrayBuffer();

            buffer = await decompressChunk(buffer, compressor);

            if (isBigEndian(dtype)) {
              buffer = swapBytes(buffer, bytesPerElement(dtype));
            }

            const chunkData = new TypedArrayClass(buffer);

            // Copy chunk data to result
            const rowStart = cr * chunkRows;
            const colStart = cc * chunkCols;
            const rowEnd = Math.min(rowStart + chunkRows, nRows);
            const colEnd = Math.min(colStart + chunkCols, nCols);
            const actualChunkCols = colEnd - colStart;
            const actualChunkRows = rowEnd - rowStart;

            // Optimize for C-order (row-major) - use row-wise block copies
            // This is significantly faster than element-by-element for large chunks
            if (order !== 'F') {
              // C-order: rows are contiguous in both source and destination
              for (let r = rowStart; r < rowEnd; r++) {
                const chunkR = r - rowStart;
                const srcOffset = chunkR * chunkCols;  // Source row start in chunk
                const dstOffset = r * nCols + colStart;  // Destination row start in result
                // Use subarray + set for fast block copy
                result.set(chunkData.subarray(srcOffset, srcOffset + actualChunkCols), dstOffset);
              }
            } else {
              // Fortran order (column-major): must copy element by element
              for (let r = rowStart; r < rowEnd; r++) {
                for (let c = colStart; c < colEnd; c++) {
                  const chunkR = r - rowStart;
                  const chunkC = c - colStart;
                  const chunkIdx = chunkC * actualChunkRows + chunkR;
                  const resultIdx = r * nCols + c;
                  result[resultIdx] = chunkData[chunkIdx];
                }
              }
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
  async _readStringArray(arrayPath, meta) {
    const { shape, dtype, chunks, compressor } = meta;
    const totalElements = shape.reduce((a, b) => a * b, 1);
    const result = new Array(totalElements);

    // Check if it's variable-length strings (stored as JSON or vlen)
    const attrs = await this._readAttrs(arrayPath);

    // For 1D string arrays
    if (shape.length === 1) {
      const numChunks = Math.ceil(shape[0] / chunks[0]);

      for (let c = 0; c < numChunks; c++) {
        const chunkPath = `${arrayPath}/${c}`;
        if (this._exists(chunkPath)) {
          const file = this._files.get(chunkPath);
          let buffer = await file.arrayBuffer();

          buffer = await decompressChunk(buffer, compressor);

          // Try to parse as JSON (for vlen-utf8 or object arrays)
          try {
            const text = new TextDecoder().decode(buffer);
            // Check if it's JSON array
            if (text.trim().startsWith('[')) {
              const strings = JSON.parse(text);
              const startIdx = c * chunks[0];
              for (let i = 0; i < strings.length && startIdx + i < totalElements; i++) {
                result[startIdx + i] = strings[i];
              }
              continue;
            }
          } catch (e) {
            // Not JSON, try fixed-length or null-terminated
          }

          // Fixed-length strings
          if (dtype.includes('S') || dtype.includes('U')) {
            const match = dtype.match(/(\d+)/);
            const charCount = match ? parseInt(match[1]) : 0;
            const isUnicode = dtype.includes('U');
            const isLittleEndian = dtype.startsWith('<') || dtype.startsWith('|');

            // NumPy string dtypes:
            // - |S<n>: Fixed-length byte string, n bytes per string
            // - <U<n> / >U<n>: Fixed-length unicode, n characters × 4 bytes (UCS-4/UTF-32)
            const bytesPerString = isUnicode ? charCount * 4 : charCount;
            const view = new Uint8Array(buffer);

            const startIdx = c * chunks[0];
            const numStrings = Math.min(chunks[0], Math.floor(buffer.byteLength / bytesPerString));

            for (let i = 0; i < numStrings && startIdx + i < totalElements; i++) {
              const strBytes = view.subarray(i * bytesPerString, (i + 1) * bytesPerString);

              if (isUnicode) {
                // Decode UCS-4 (UTF-32) - JavaScript doesn't have native UTF-32 decoder
                // so we read 4-byte code points manually
                const codePoints = [];
                const dataView = new DataView(strBytes.buffer, strBytes.byteOffset, strBytes.byteLength);
                for (let j = 0; j < charCount; j++) {
                  const codePoint = isLittleEndian
                    ? dataView.getUint32(j * 4, true)  // little-endian
                    : dataView.getUint32(j * 4, false); // big-endian
                  if (codePoint === 0) break; // null terminator
                  codePoints.push(codePoint);
                }
                result[startIdx + i] = String.fromCodePoint(...codePoints);
              } else {
                // Byte strings (|S<n>) - UTF-8/ASCII
                let endIdx = bytesPerString;
                for (let j = 0; j < bytesPerString; j++) {
                  if (strBytes[j] === 0) {
                    endIdx = j;
                    break;
                  }
                }
                result[startIdx + i] = new TextDecoder('utf-8').decode(strBytes.subarray(0, endIdx));
              }
            }
          }
        }
      }
    }

    return { data: result, shape, dtype };
  }

  /**
   * Read the basic structure of the zarr AnnData
   * @private
   */
  async _readStructure() {
    // Read root attributes
    this._rootAttrs = await this._readAttrs('');

    // Check if this is an AnnData
    const encodingType = this._rootAttrs['encoding-type'];
    if (encodingType && !encodingType.includes('anndata')) {
      console.warn(`[ZarrLoader] Not an AnnData file: encoding-type = ${encodingType}`);
    }

    // Check for X matrix and its format
    if (this._exists('X/.zarray')) {
      // Dense X matrix
      this._xIsSparse = false;
      const xMeta = await this._readArrayMeta('X');
      this._nObs = xMeta.shape[0];
      this._nVars = xMeta.shape[1];
    } else if (this._exists('X/.zgroup')) {
      // Check for sparse X (has data, indices, indptr subdirectories)
      const xAttrs = await this._readAttrs('X');
      const encodingType = xAttrs['encoding-type'] || '';

      if (encodingType.includes('csr') || encodingType.includes('csc') ||
          this._exists('X/data/.zarray')) {
        this._xIsSparse = true;

        // Get shape from attributes
        const shape = xAttrs['shape'];
        if (shape) {
          this._nObs = Number(shape[0]);
          this._nVars = Number(shape[1]);
        }

        console.log(`[ZarrLoader] X is sparse (${encodingType})`);
      }
    }

    // Read obs structure
    if (this._exists('obs/.zattrs')) {
      const obsAttrs = await this._readAttrs('obs');
      this._obsKeys = obsAttrs['column-order'] || [];

      // Get n_obs from obs index if not set
      if (this._nObs === 0 && obsAttrs['_index']) {
        const indexKey = obsAttrs['_index'];
        const indexPath = `obs/${indexKey}`;
        if (this._exists(`${indexPath}/.zarray`)) {
          const indexMeta = await this._readArrayMeta(indexPath);
          this._nObs = indexMeta.shape[0];
        }
      }
    }

    // Read var structure
    if (this._exists('var/.zattrs')) {
      const varAttrs = await this._readAttrs('var');

      // Get variable names from _index
      const indexKey = varAttrs['_index'] || '_index';
      const indexPath = `var/${indexKey}`;

      if (this._exists(`${indexPath}/.zarray`) || this._exists(`${indexPath}/0`)) {
        const { data: names } = await this._readArray(indexPath);
        this._varNames = Array.from(names);
        // Build O(1) lookup index for gene names
        this._varNameIndex.clear();
        for (let i = 0; i < this._varNames.length; i++) {
          this._varNameIndex.set(this._varNames[i], i);
        }
      }

      if (this._nVars === 0) {
        this._nVars = this._varNames.length;
      }
    }

    // Read obsm structure
    if (this._exists('obsm/.zgroup') || this._exists('obsm/.zattrs')) {
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

  /**
   * Get embedding shape without loading full array data.
   * Used for dimension detection to avoid loading large embeddings just to get nDims.
   * @param {string} key - Embedding key (e.g., 'X_umap', 'X_umap_3d')
   * @returns {Promise<{shape: number[], nDims: number}>}
   */
  async getEmbeddingShape(key) {
    this._ensureOpen();

    const arrayPath = `obsm/${key}`;
    if (!this._exists(`${arrayPath}/.zarray`)) {
      throw new Error(`Embedding '${key}' not found in obsm. Available: ${this._obsmKeys.join(', ')}`);
    }

    // Read only the .zarray metadata to get shape without loading chunk data
    const meta = await this._readArrayMeta(arrayPath);
    const shape = meta.shape;
    return { shape, nDims: shape[1] || 1 };
  }

  /**
   * Get an embedding from obsm
   * @param {string} key - Embedding key (e.g., 'X_umap', 'X_umap_3d')
   * @returns {Promise<{data: Float32Array, shape: number[], nDims: number}>}
   */
  async getEmbedding(key) {
    this._ensureOpen();

    const cacheKey = `obsm:${key}`;
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey);
    }

    const arrayPath = `obsm/${key}`;
    if (!this._exists(`${arrayPath}/.zarray`)) {
      throw new Error(`Embedding '${key}' not found in obsm. Available: ${this._obsmKeys.join(', ')}`);
    }

    const { data, shape } = await this._readArray(arrayPath);
    const result = {
      data: data instanceof Float32Array ? data : new Float32Array(data),
      shape,
      nDims: shape[1] || 1  // Fallback to 1 for 1D embeddings
    };

    this._cache.set(cacheKey, result);
    return result;
  }

  /**
   * Get gene expression values for a single gene
   * @param {string} geneName - Gene name
   * @returns {Promise<Float32Array>}
   */
  async getGeneExpression(geneName) {
    this._ensureOpen();

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

    // LRU cache management
    if (this._geneCache.size >= MAX_GENE_CACHE_SIZE) {
      const oldestKey = this._geneCache.keys().next().value;
      this._geneCache.delete(oldestKey);
    }
    this._geneCache.set(geneName, result);

    return result;
  }

  /**
   * Get a column from sparse X matrix
   * @private
   */
  async _getSparseColumn(colIdx) {
    // Load sparse matrix if not cached
    // Use Promise-based lock to prevent race conditions when multiple concurrent calls
    // both see !this._sparseX and start the expensive CSR→CSC conversion simultaneously
    if (!this._sparseX) {
      if (!this._sparseXLoadPromise) {
        this._sparseXLoadPromise = (async () => {
          const sparse = await this._readSparseMatrix('X');

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
      this._sparseX = await this._sparseXLoadPromise;
    }

    if (this._sparseX.format === 'csr') {
      // Use CSC format via shared utility
      return getSparseColumn(this._sparseX.cscData, colIdx, this._nObs);
    } else {
      // CSC - direct column access
      const { data, indices, indptr } = this._sparseX;
      const result = new Float32Array(this._nObs);
      const start = indptr[colIdx];
      const end = indptr[colIdx + 1];

      for (let j = start; j < end; j++) {
        result[indices[j]] = data[j];
      }
      return result;
    }
  }

  /**
   * Get a column from dense X matrix
   * @private
   */
  async _getDenseColumn(colIdx) {
    // For dense, we need to read the full matrix or specific chunks
    // This is expensive, so we cache it
    if (!this._denseX) {
      const { data } = await this._readArray('X');
      this._denseX = data instanceof Float32Array ? data : new Float32Array(data);
    }

    const result = new Float32Array(this._nObs);
    for (let i = 0; i < this._nObs; i++) {
      result[i] = this._denseX[i * this._nVars + colIdx];
    }
    return result;
  }

  /**
   * Read a sparse matrix from zarr
   * @private
   */
  async _readSparseMatrix(groupPath) {
    const attrs = await this._readAttrs(groupPath);
    const encodingType = attrs['encoding-type'] || '';

    // Detect format - be lenient
    let isCsr = encodingType.includes('csr');
    let isCsc = encodingType.includes('csc');

    // If no encoding type, check for sparse structure and assume CSR
    if (!isCsr && !isCsc) {
      const hasData = this._exists(`${groupPath}/data/.zarray`);
      const hasIndices = this._exists(`${groupPath}/indices/.zarray`);
      const hasIndptr = this._exists(`${groupPath}/indptr/.zarray`);

      if (hasData && hasIndices && hasIndptr) {
        isCsr = true;
        console.log(`[ZarrLoader] Sparse matrix at ${groupPath} has no encoding-type, assuming CSR`);
      } else {
        throw new Error(`Unknown sparse format at ${groupPath}. encoding-type='${encodingType}'`);
      }
    }

    const format = isCsr ? 'csr' : 'csc';

    const { data: dataArr } = await this._readArray(`${groupPath}/data`);
    const { data: indicesArr } = await this._readArray(`${groupPath}/indices`);
    const { data: indptrArr } = await this._readArray(`${groupPath}/indptr`);

    // Use safe conversion functions to handle BigInt64Array/BigUint64Array
    // (int64/uint64 dtypes). Direct construction like new Int32Array(BigInt64Array) throws.
    const data = toFloat32Array(dataArr);
    const indices = toInt32Array(indicesArr);
    const indptr = toInt32Array(indptrArr);

    let shape = attrs['shape'] || [0, 0];
    shape = shape.map(Number);

    // If shape not in attrs, try to infer it
    if (shape[0] === 0 && shape[1] === 0) {
      // For sparse matrices:
      // - CSR: indptr has length (n_rows + 1), indices are column indices
      // - CSC: indptr has length (n_cols + 1), indices are row indices
      const indptrDim = indptr.length - 1;
      let maxIdx = 0;
      if (indices.length > 0) {
        for (let i = 0; i < indices.length; i++) {
          if (indices[i] > maxIdx) maxIdx = indices[i];
        }
      }
      const indicesDim = maxIdx + 1;

      if (isCsr) {
        // CSR: rows from indptr, cols from indices
        shape[0] = indptrDim;   // n_rows
        shape[1] = indicesDim;  // n_cols
      } else {
        // CSC: cols from indptr, rows from indices
        shape[0] = indicesDim;  // n_rows
        shape[1] = indptrDim;   // n_cols
      }
      console.log(`[ZarrLoader] Inferred ${format.toUpperCase()} sparse matrix shape: ${shape[0]}x${shape[1]}`);
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

    return { data, indices, indptr, shape, format, cscData: null };
  }

  // Note: CSR→CSC conversion uses the shared buildCscFromCsr() from sparse-utils.js

  /**
   * Get obs field info (metadata only)
   * @param {string} key - Field name
   * @returns {Promise<{dtype: string, categories?: string[]}>}
   */
  async getObsFieldInfo(key) {
    this._ensureOpen();

    const cacheKey = `obs_info:${key}`;
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey);
    }

    const fieldPath = `obs/${key}`;
    const attrs = await this._readAttrs(fieldPath);
    let result;

    // Check if categorical
    if (attrs['encoding-type'] === 'categorical' || this._exists(`${fieldPath}/categories/.zarray`)) {
      const { data: categories } = await this._readArray(`${fieldPath}/categories`);
      result = {
        dtype: 'categorical',
        categories: Array.from(categories)
      };
    } else if (this._exists(`${fieldPath}/.zarray`)) {
      const meta = await this._readArrayMeta(fieldPath);
      const dtype = meta.dtype;

      if (dtype.includes('f')) {
        result = { dtype: 'float' };
      } else if (dtype.includes('i') && !dtype.includes('u')) {
        result = { dtype: 'int' };
      } else if (dtype.includes('u')) {
        result = { dtype: 'uint' };
      } else if (dtype.includes('S') || dtype.includes('U') || dtype.includes('O')) {
        result = { dtype: 'string' };
      } else {
        result = { dtype: 'unknown' };
      }
    } else {
      result = { dtype: 'unknown' };
    }

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

    const cacheKey = `obs:${key}`;
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey);
    }

    const fieldPath = `obs/${key}`;
    const attrs = await this._readAttrs(fieldPath);
    let result;

    // Check if categorical
    if (attrs['encoding-type'] === 'categorical' || this._exists(`${fieldPath}/categories/.zarray`)) {
      const { data: codes } = await this._readArray(`${fieldPath}/codes`);
      const { data: categories } = await this._readArray(`${fieldPath}/categories`);

      result = {
        dtype: 'categorical',
        // Use safe conversion to handle int64 dtypes from zarr
        codes: toInt32Array(codes),
        categories: Array.from(categories),
        get values() {
          const computed = Array.from(this.codes, c => c >= 0 ? this.categories[c] : null);
          Object.defineProperty(this, 'values', { value: computed, writable: false });
          return computed;
        }
      };
    } else {
      const { data, dtype } = await this._readArray(fieldPath);
      const inferredDtype = this._inferDtype(data, dtype);

      result = {
        dtype: inferredDtype,
        values: inferredDtype === 'string' ? Array.from(data) : data
      };
    }

    this._cache.set(cacheKey, result);
    return result;
  }

  /**
   * Get connectivity data from obsp
   * @returns {Promise<Object|null>}
   */
  async getConnectivities() {
    this._ensureOpen();

    if (this._cache.has('connectivities')) {
      return this._cache.get('connectivities');
    }

    // Check if obsp exists
    const hasObsp = this._exists('obsp/.zgroup') || this._exists('obsp/.zattrs');
    if (!hasObsp) {
      console.log('[ZarrLoader] No obsp group found in zarr');
      return null;
    }

    // List what's in obsp for debugging
    const obspKeys = [];
    for (const path of this._files.keys()) {
      if (path.startsWith('obsp/') && !path.startsWith('obsp/.')) {
        const subpath = path.substring('obsp/'.length);
        const key = subpath.split('/')[0];
        if (key && !obspKeys.includes(key)) {
          obspKeys.push(key);
        }
      }
    }
    console.log(`[ZarrLoader] obsp contains: ${obspKeys.join(', ') || '(none)'}`);

    // Check if connectivities exists - try multiple detection methods
    const connPath = 'obsp/connectivities';
    const hasConnGroup = this._exists(`${connPath}/.zgroup`);
    const hasConnAttrs = this._exists(`${connPath}/.zattrs`);
    const hasConnData = this._exists(`${connPath}/data/.zarray`);
    const hasConnIndptr = this._exists(`${connPath}/indptr/.zarray`);

    if (!hasConnGroup && !hasConnAttrs && !hasConnData && !hasConnIndptr) {
      console.log('[ZarrLoader] No connectivities found in obsp');
      return null;
    }

    console.log(`[ZarrLoader] connectivities found: .zgroup=${hasConnGroup}, .zattrs=${hasConnAttrs}, data/.zarray=${hasConnData}, indptr/.zarray=${hasConnIndptr}`);

    try {
      const result = await this._readSparseMatrix(connPath);
      console.log(`[ZarrLoader] Loaded connectivity matrix: ${result.shape[0]}x${result.shape[1]}, ${result.indices.length} non-zeros, format=${result.format}`);
      this._cache.set('connectivities', result);
      return result;
    } catch (err) {
      console.error('[ZarrLoader] Failed to read connectivity matrix:', err);
      return null;
    }
  }

  /**
   * Infer dtype from values
   * @private
   */
  _inferDtype(values, zarrDtype) {
    if (values instanceof Float32Array || values instanceof Float64Array) return 'float';
    if (values instanceof Int32Array || values instanceof Int16Array) return 'int';
    if (values instanceof Uint32Array || values instanceof Uint16Array || values instanceof Uint8Array) return 'uint';
    if (Array.isArray(values) && values.length > 0 && typeof values[0] === 'string') return 'string';
    if (zarrDtype?.includes('f')) return 'float';
    if (zarrDtype?.includes('S') || zarrDtype?.includes('U')) return 'string';
    return 'unknown';
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

    // Detect available UMAP dimensions using shape metadata only (no full array loading)
    const availableDimensions = [];
    let defaultDimension = 3;

    for (const key of this._obsmKeys) {
      if (key === 'X_umap_3d' || (key === 'X_umap' && !this._obsmKeys.includes('X_umap_3d'))) {
        // Use getEmbeddingShape() to avoid loading full array just for dimension detection
        const { nDims } = await this.getEmbeddingShape(key);
        if (nDims >= 1 && nDims <= 3) availableDimensions.push(nDims);
      }
      if (key === 'X_umap_2d') availableDimensions.push(2);
      if (key === 'X_umap_1d') availableDimensions.push(1);
    }

    if (availableDimensions.length === 0 && this._obsmKeys.includes('X_umap')) {
      const { nDims } = await this.getEmbeddingShape('X_umap');
      availableDimensions.push(nDims);
    }

    if (availableDimensions.length === 0) {
      const fallbacks = ['X_pca', 'X_tsne', 'X_phate'];
      for (const pattern of fallbacks) {
        const key = this._obsmKeys.find(k => k.startsWith(pattern));
        if (key) {
          try {
            const { nDims } = await this.getEmbeddingShape(key);
            if (nDims >= 1 && nDims <= 3) {
              availableDimensions.push(nDims);
              console.warn(`[ZarrLoader] No UMAP found, using ${key} as fallback`);
              break;
            }
          } catch (e) { /* skip */ }
        }
      }
    }

    if (availableDimensions.length === 0) {
      throw new Error('No suitable embeddings found in obsm');
    }

    availableDimensions.sort((a, b) => b - a);
    defaultDimension = availableDimensions[0];

    // Count field types
    let nCategorical = 0;
    let nContinuous = 0;

    for (const key of this._obsKeys) {
      const info = await this.getObsFieldInfo(key);
      if (info.dtype === 'categorical') nCategorical++;
      else if (info.dtype === 'float' || info.dtype === 'int' || info.dtype === 'uint') nContinuous++;
    }

    const conn = await this.getConnectivities();
    const hasConnectivity = conn !== null;

    // Use case-insensitive regex for extension stripping to handle .ZARR, .zarr, etc.
    const baseName = this._rootName.replace(/\.zarr$/i, '');
    return {
      version: 2,
      id: baseName,
      name: baseName,
      description: 'Loaded directly from zarr directory',
      cellucid_data_version: 'zarr_loader',
      stats: {
        n_cells: this._nObs,
        n_genes: this._nVars,
        n_obs_fields: this._obsKeys.length,
        n_categorical_fields: nCategorical,
        n_continuous_fields: nContinuous,
        has_connectivity: hasConnectivity,
      },
      embeddings: {
        available_dimensions: availableDimensions,
        default_dimension: defaultDimension,
      },
      obs_fields: this._obsKeys.map(key => ({ key, kind: 'unknown' })),
      source: {
        type: 'zarr_loader',
        dirname: this._rootName,
      },
      _zarr_loader: true,
    };
  }

  /**
   * Clear all cached data
   */
  clearCache() {
    this._cache.clear();
    this._geneCache.clear();
    this._sparseX = null;
    this._sparseXLoadPromise = null;  // Clear conversion promise to allow fresh conversion
    this._denseX = null;
  }

  /**
   * Close and release resources
   * IMPORTANT: This properly releases all memory to prevent leaks
   */
  close() {
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
    this._varNameIndex.clear();
    this._obsmKeys = [];
    this._xIsSparse = false;
    this._rootAttrs = null;

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

    this.type = 'zarr';
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
   * Load a zarr directory from FileList
   * @param {FileList} fileList - FileList from <input type="file" webkitdirectory>
   * @returns {Promise<Object>}
   */
  async loadFromFileList(fileList) {
    if (!isZarrDirectory(fileList)) {
      throw new DataSourceError(
        'Not a zarr directory',
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
    }

    // Show performance warning - zarr loading has similar limitations to h5ad
    const notifications = getNotificationCenter();
    notifications.warning(
      'Loading zarr directory directly in browser. Note: (1) All file metadata is loaded upfront, ' +
      '(2) No quantization - larger memory usage for gene expression, ' +
      '(3) Gene expression loads may be slower than prepare format. ' +
      'For large datasets, use prepare() instead.',
      { duration: 15000 }
    );

    // Clear previous state
    this._cleanup();

    // Create loader and open directory
    this._loader = createZarrLoader();
    await this._loader.open(fileList);

    // Create adapter
    this._adapter = new ZarrDataAdapter(this._loader);
    await this._adapter.initialize();

    // Get directory name from first file
    const firstPath = fileList[0].webkitRelativePath || fileList[0].name;
    this.dirname = firstPath.split('/')[0];
    this.datasetId = `zarr_${this.dirname.replace(/\.zarr$/i, '')}`;
    this._metadata = this._adapter.getMetadata();
    this._metadata.id = this.datasetId;

    console.log(`[ZarrDataSource] Loaded ${this.dirname}: ${this._loader.nObs} cells, ${this._loader.nVars} genes`);

    return this._metadata;
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
   * @param {string} _datasetId
   * @returns {string}
   */
  getBaseUrl(_datasetId) {
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
      return null;
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
   * @returns {Promise<Object|null>}
   */
  async getConnectivityManifest() {
    const edges = await this.getConnectivityEdges();
    if (!edges) return null;

    return {
      format: 'edge_pairs',
      n_cells: this._loader.nObs,
      n_edges: edges.nEdges,
      index_dtype: 'uint32',
      index_bytes: 4,
    };
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
  }

  /**
   * Cleanup resources
   * @private
   */
  _cleanup() {
    if (this._adapter) {
      this._adapter.close();
      this._adapter = null;
    }
    if (this._loader) {
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
      // Clear adapter caches (embeddings, obs data, connectivity)
      this._adapter._embeddingCache?.clear();
      this._adapter._obsFieldDataCache?.clear();
      this._adapter._normInfo?.clear();
      this._adapter._connectivityCache = undefined;
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
 * @returns {Promise<{data: ArrayBuffer, kind: string, categories?: string[]}>}
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
 * @returns {Promise<{sources: Uint32Array, destinations: Uint32Array, nEdges: number}|null>}
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
 * @returns {Promise<Object|null>}
 */
export async function zarrGetConnectivityManifest() {
  const source = getZarrSource();
  if (!source) {
    return null;
  }

  return source.getConnectivityManifest?.() || null;
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
