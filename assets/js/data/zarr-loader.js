/**
 * Zarr Loader for Cellucid
 *
 * Client-side JavaScript loader for AnnData zarr directories.
 * Provides sparse matrix support and lazy loading without needing a Python server.
 *
 * Features:
 * - Reads .zarr directories directly in the browser via FileSystemDirectoryHandle or FileList
 * - Handles sparse matrices (CSR/CSC) transparently
 * - Individual datasets (embeddings, obs fields, genes) loaded on-demand
 * - Compatible with the Cellucid data format
 *
 * Zarr Structure for AnnData:
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
 * Usage:
 *   const loader = new ZarrLoader();
 *   await loader.open(fileList);  // FileList from <input type="file" webkitdirectory>
 *   const embedding = await loader.getEmbedding('X_umap');
 *   const geneExpr = await loader.getGeneExpression('GAPDH');
 */

import { getNotificationCenter } from '../app/notification-center.js';

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

  // Fallback: assume no compression
  console.warn('[ZarrLoader] Unknown blosc compressor, assuming uncompressed');
  return buffer.slice(16, 16 + nbytes);
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
      const ds = new DecompressionStream(compId);
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

  console.warn(`[ZarrLoader] Unknown compressor: ${compId}, returning raw data`);
  return buffer;
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

    /** @type {string[]} */
    this._obsmKeys = [];

    /** @type {Map<string, Object>} General cache */
    this._cache = new Map();

    /** @type {Map<string, Float32Array>} LRU cache for gene expression */
    this._geneCache = new Map();

    /** @type {Object|null} Sparse X matrix info */
    this._sparseX = null;

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

            for (let r = rowStart; r < rowEnd; r++) {
              for (let c = colStart; c < colEnd; c++) {
                const chunkR = r - rowStart;
                const chunkC = c - colStart;
                const chunkIdx = order === 'F'
                  ? chunkC * (rowEnd - rowStart) + chunkR  // Fortran order
                  : chunkR * (colEnd - colStart) + chunkC; // C order

                const resultIdx = r * nCols + c;  // Result is always C order
                result[resultIdx] = chunkData[chunkIdx];
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
            const strLen = match ? parseInt(match[1]) : 0;
            const decoder = new TextDecoder(dtype.includes('U') ? 'utf-16' : 'utf-8');
            const view = new Uint8Array(buffer);

            const startIdx = c * chunks[0];
            const numStrings = Math.min(chunks[0], buffer.byteLength / strLen);

            for (let i = 0; i < numStrings && startIdx + i < totalElements; i++) {
              const strBytes = view.subarray(i * strLen, (i + 1) * strLen);
              // Find null terminator
              let endIdx = strLen;
              for (let j = 0; j < strLen; j++) {
                if (strBytes[j] === 0) {
                  endIdx = j;
                  break;
                }
              }
              result[startIdx + i] = decoder.decode(strBytes.subarray(0, endIdx));
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
      nDims: shape[1]
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

    const geneIdx = this._varNames.indexOf(geneName);
    if (geneIdx === -1) {
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
    if (!this._sparseX) {
      this._sparseX = await this._readSparseMatrix('X');

      // If CSR, convert to CSC for efficient column access
      if (this._sparseX.format === 'csr') {
        console.log('[ZarrLoader] Converting CSR to CSC for efficient gene access...');
        const startTime = performance.now();
        this._sparseX.cscData = this._buildCscFromCsr(this._sparseX);
        console.log(`[ZarrLoader] CSR→CSC conversion complete in ${(performance.now() - startTime).toFixed(0)}ms`);

        // Release original CSR arrays
        this._sparseX.data = null;
        this._sparseX.indices = null;
        this._sparseX.indptr = null;
      }
    }

    const result = new Float32Array(this._nObs);

    if (this._sparseX.format === 'csr') {
      // Use CSC format
      const { colIndptr, rowIndices, colData } = this._sparseX.cscData;
      const start = colIndptr[colIdx];
      const end = colIndptr[colIdx + 1];

      for (let j = start; j < end; j++) {
        result[rowIndices[j]] = colData[j];
      }
    } else {
      // CSC - direct column access
      const { data, indices, indptr } = this._sparseX;
      const start = indptr[colIdx];
      const end = indptr[colIdx + 1];

      for (let j = start; j < end; j++) {
        result[indices[j]] = data[j];
      }
    }

    return result;
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
    const isCsr = encodingType.includes('csr');
    const isCsc = encodingType.includes('csc');

    const format = isCsr ? 'csr' : (isCsc ? 'csc' : 'csr');

    const { data: dataArr } = await this._readArray(`${groupPath}/data`);
    const { data: indicesArr } = await this._readArray(`${groupPath}/indices`);
    const { data: indptrArr } = await this._readArray(`${groupPath}/indptr`);

    const data = dataArr instanceof Float32Array ? dataArr : new Float32Array(dataArr);
    const indices = indicesArr instanceof Int32Array ? indicesArr : new Int32Array(indicesArr);
    const indptr = indptrArr instanceof Int32Array ? indptrArr : new Int32Array(indptrArr);

    let shape = attrs['shape'] || [0, 0];
    shape = shape.map(Number);

    return { data, indices, indptr, shape, format, cscData: null };
  }

  /**
   * Build CSC from CSR matrix
   * @private
   */
  _buildCscFromCsr(sparse) {
    const { data, indices, indptr, shape } = sparse;
    const nRows = shape[0];
    const nCols = shape[1];
    const nnz = data.length;

    // Count entries per column
    const colCounts = new Int32Array(nCols + 1);
    for (let i = 0; i < nnz; i++) {
      colCounts[indices[i] + 1]++;
    }

    // Build column indptr
    const colIndptr = new Int32Array(nCols + 1);
    for (let c = 0; c < nCols; c++) {
      colIndptr[c + 1] = colIndptr[c] + colCounts[c + 1];
    }

    // Fill row indices and data
    const rowIndices = new Int32Array(nnz);
    const colData = new Float32Array(nnz);
    const colPos = new Int32Array(nCols);

    for (let row = 0; row < nRows; row++) {
      const start = indptr[row];
      const end = indptr[row + 1];
      for (let j = start; j < end; j++) {
        const col = indices[j];
        const destIdx = colIndptr[col] + colPos[col];
        rowIndices[destIdx] = row;
        colData[destIdx] = data[j];
        colPos[col]++;
      }
    }

    return { colIndptr, rowIndices, colData };
  }

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
        codes: codes instanceof Int32Array ? codes : new Int32Array(codes),
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

    const connPath = 'obsp/connectivities';
    if (!this._exists(`${connPath}/.zgroup`) && !this._exists(`${connPath}/data/.zarray`)) {
      return null;
    }

    const result = await this._readSparseMatrix(connPath);
    this._cache.set('connectivities', result);
    return result;
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

    // Detect available UMAP dimensions
    const availableDimensions = [];
    let defaultDimension = 3;

    for (const key of this._obsmKeys) {
      if (key === 'X_umap_3d' || (key === 'X_umap' && !this._obsmKeys.includes('X_umap_3d'))) {
        const emb = await this.getEmbedding(key);
        if (emb.nDims >= 1 && emb.nDims <= 3) availableDimensions.push(emb.nDims);
      }
      if (key === 'X_umap_2d') availableDimensions.push(2);
      if (key === 'X_umap_1d') availableDimensions.push(1);
    }

    if (availableDimensions.length === 0 && this._obsmKeys.includes('X_umap')) {
      const emb = await this.getEmbedding('X_umap');
      availableDimensions.push(emb.nDims);
    }

    if (availableDimensions.length === 0) {
      const fallbacks = ['X_pca', 'X_tsne', 'X_phate'];
      for (const pattern of fallbacks) {
        const key = this._obsmKeys.find(k => k.startsWith(pattern));
        if (key) {
          try {
            const emb = await this.getEmbedding(key);
            if (emb.nDims >= 1 && emb.nDims <= 3) {
              availableDimensions.push(emb.nDims);
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
      else if (info.dtype === 'float' || info.dtype === 'int') nContinuous++;
    }

    const conn = await this.getConnectivities();
    const hasConnectivity = conn !== null;

    return {
      version: 2,
      id: this._rootName.replace('.zarr', ''),
      name: this._rootName.replace('.zarr', ''),
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
    this._denseX = null;
  }

  /**
   * Close and release resources
   */
  close() {
    this._files = null;
    this._rootName = null;
    this.clearCache();
    this._nObs = 0;
    this._nVars = 0;
    this._obsKeys = [];
    this._varNames = [];
    this._obsmKeys = [];
    this._xIsSparse = false;
    this._rootAttrs = null;
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
