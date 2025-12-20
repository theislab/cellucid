// Fetch helpers for loading binary positions and obs payloads (manifest + per-field data).
// Supports quantized data with transparent dequantization and gzip-compressed files.
// Supports custom protocols (local-user://, remote://, jupyter://) via DataSourceManager.
// Includes progress tracking with download speed for the notification center.

import { getDataSourceManager } from './data-source-manager.js';
import { isLocalUserUrl, resolveUrl } from './data-source.js';
import { getNotificationCenter } from '../app/notification-center.js';
import { toUint32Array } from './sparse-utils.js';
import { tryDequantizeToFloat32 } from './quantization-worker-pool.js';
// Unified AnnData provider handles both h5ad and zarr sources
import {
  isH5adActive,
  isZarrActive,
  isH5adUrl,
  isZarrUrl,
  isAnnDataActive,
  anndataLoadPoints,
  anndataGetObsManifest,
  anndataGetVarManifest,
  anndataLoadObsField,
  anndataLoadGeneExpression,
  anndataLoadConnectivity,
  anndataGetConnectivityManifest,
  anndataGetDatasetIdentity,
} from './anndata-provider.js';
// Note: remote:// and jupyter:// protocols are handled by DataSourceManager.resolveUrl()
// via the registered protocol handlers - no explicit imports needed here.

/**
 * Check if we should use AnnData data loading (h5ad or zarr) for this URL.
 * Returns true if either h5ad/zarr source is active OR the URL uses h5ad:// or zarr:// protocol.
 * @param {string} url - URL to check
 * @returns {boolean}
 */
function shouldUseAnnData(url) {
  // Check if any AnnData source is active (h5ad or zarr)
  if (isAnnDataActive()) {
    return true;
  }
  // Also check if URL uses h5ad:// or zarr:// protocol
  return isH5adUrl(url) || isZarrUrl(url);
}

// ============================================================================
// UNIFIED URL RESOLUTION (delegates to DataSourceManager)
// ============================================================================

/**
 * Resolve any URL (including custom protocols) to a fetchable URL.
 * Delegates to DataSourceManager for all protocol handling.
 * @param {string} url - URL to resolve (may be local-user://, remote://, jupyter://, etc.)
 * @returns {Promise<string>} Standard fetchable URL (http://, https://, blob://, data://)
 */
async function resolveAnyUrl(url) {
  return getDataSourceManager().resolveUrl(url);
}

/**
 * Fetch JSON with automatic custom protocol handling
 * @param {string} url - URL to fetch (may use custom protocol)
 * @returns {Promise<any>}
 */
async function fetchJsonWithProtocol(url) {
  const resolvedUrl = await resolveAnyUrl(url);
  const response = await fetch(resolvedUrl);

  if (!response.ok) {
    throw new Error(`Failed to load: ${url}`);
  }

  return response.json();
}

// Internal alias for JSON fetching with protocol support
const fetchLocalUserJson = fetchJsonWithProtocol;

// ============================================================================
// BROWSER CAPABILITY CHECK
// ============================================================================

// Check browser capabilities at startup
const HAS_DECOMPRESSION_STREAM = typeof DecompressionStream !== 'undefined';
const HAS_PAKO = typeof pako !== 'undefined';
if (!HAS_DECOMPRESSION_STREAM && !HAS_PAKO) {
  console.warn('Neither DecompressionStream nor pako available. Gzip-compressed files will not work.');
  console.warn('Use a modern browser (Chrome 80+, Firefox 113+, Safari 16.4+) or include pako library.');
}

/**
 * Convert ArrayBuffer to typed array based on dtype.
 * @param {ArrayBuffer} buffer - Raw binary data
 * @param {string} dtype - Data type ('float32', 'uint8', 'uint16', 'uint32', 'uint64')
 * @param {string} url - URL for error messages
 * @returns {TypedArray} Appropriate typed array
 */
function typedArrayFromBuffer(buffer, dtype, url) {
  switch (dtype) {
    case 'float32':
      return new Float32Array(buffer);
    case 'uint8':
      return new Uint8Array(buffer);
    case 'uint16':
      return new Uint16Array(buffer);
    case 'uint32':
      return new Uint32Array(buffer);
    case 'uint64':
      return new BigUint64Array(buffer);
    default:
      throw new Error(`Unsupported dtype "${dtype}" for ${url}`);
  }
}

/**
 * Dequantize uint8/uint16 values back to float32.
 * This is transparent to the rest of the application.
 * 
 * @param {Uint8Array|Uint16Array} quantized - Quantized values
 * @param {number} minValue - Original minimum value
 * @param {number} maxValue - Original maximum value
 * @param {number} bits - Quantization bits (8 or 16)
 * @returns {Float32Array} Dequantized float32 values
 */
function dequantize(quantized, minValue, maxValue, bits) {
  const n = quantized.length;
  const result = new Float32Array(n);
  
  // Determine max quantized value and NaN marker
  const maxQuant = bits === 8 ? 254 : 65534;
  const nanMarker = bits === 8 ? 255 : 65535;
  const range = maxValue - minValue;
  const scale = range / maxQuant;
  
  for (let i = 0; i < n; i++) {
    const q = quantized[i];
    if (q === nanMarker) {
      result[i] = NaN;
    } else {
      result[i] = minValue + q * scale;
    }
  }
  
  return result;
}

/**
 * @typedef {'uint8'|'uint16'} QuantizedDType
 */

const WORKER_DEQUANTIZE_MIN_BYTES = 256 * 1024;

/**
 * Dequantize quantized uint8/uint16 values into Float32Array, preferring worker decode.
 * IMPORTANT: worker decode transfers the input ArrayBuffer; if worker decode fails, callers
 * should provide refetchBuffer() so we can safely fall back to sync decode.
 *
 * @param {Object} options
 * @param {ArrayBuffer} options.buffer
 * @param {QuantizedDType} options.dtype
 * @param {number} options.minValue
 * @param {number} options.maxValue
 * @param {8|16} options.bits
 * @param {string} [options.urlForError]
 * @param {(() => Promise<ArrayBuffer>)} [options.refetchBuffer]
 * @returns {Promise<Float32Array>}
 */
async function dequantizeToFloat32(options) {
  const { buffer, dtype, minValue, maxValue, bits, urlForError, refetchBuffer } = options || {};

  if (!(buffer instanceof ArrayBuffer)) {
    throw new Error('dequantizeToFloat32: missing ArrayBuffer');
  }
  if (dtype !== 'uint8' && dtype !== 'uint16') {
    throw new Error(`dequantizeToFloat32: unsupported dtype "${String(dtype)}"`);
  }

  const shouldTryWorker = buffer.byteLength >= WORKER_DEQUANTIZE_MIN_BYTES;
  if (shouldTryWorker) {
    try {
      const decoded = await tryDequantizeToFloat32({ buffer, dtype, minValue, maxValue, bits });
      if (decoded) return decoded;
    } catch (err) {
      console.warn('[data-loaders] Worker dequantize failed:', urlForError || '(buffer)', err);
      if (typeof refetchBuffer === 'function') {
        const fresh = await refetchBuffer();
        const raw = dtype === 'uint8' ? new Uint8Array(fresh) : new Uint16Array(fresh);
        return dequantize(raw, minValue, maxValue, bits);
      }
      throw err;
    }
  }

  const raw = dtype === 'uint8' ? new Uint8Array(buffer) : new Uint16Array(buffer);
  return dequantize(raw, minValue, maxValue, bits);
}


/**
 * @param {string} url
 * @param {RequestInit} [init]
 */
async function fetchOk(url, init) {
  const resolvedUrl = await resolveAnyUrl(url);
  const response = await fetch(resolvedUrl, init);
  if (!response.ok) {
    const err = new Error('Failed to load ' + url + ': ' + response.statusText);
    err.status = response.status;
    throw err;
  }
  return response;
}

/**
 * Fetch binary data, automatically decompressing gzip if URL ends with .gz
 * Uses native DecompressionStream API (modern browsers).
 * Supports local-user:// protocol for user directories.
 *
 * @param {string} url - URL to fetch
 * @param {RequestInit} [init]
 * @returns {Promise<ArrayBuffer>} Decompressed binary data
 */
async function fetchBinary(url, init) {
  const response = await fetchOk(url, init);

  // Check if this is a gzipped file by URL extension
  const isGzipped = url.endsWith('.gz');

  if (isGzipped && typeof DecompressionStream !== 'undefined') {
    // Use native DecompressionStream API for decompression
    try {
      const ds = new DecompressionStream('gzip');
      const decompressedStream = response.body.pipeThrough(ds);
      const decompressedResponse = new Response(decompressedStream);
      return decompressedResponse.arrayBuffer();
    } catch (e) {
      console.error('DecompressionStream failed for:', url, e);
      throw e;
    }
  } else if (isGzipped) {
    // Fallback: try to use pako if available (for older browsers)
    const compressedBuffer = await response.arrayBuffer();
    if (typeof pako !== 'undefined') {
      const decompressed = pako.inflate(new Uint8Array(compressedBuffer));
      // Safety: slice the buffer in case pako returns a view with non-zero byteOffset
      return decompressed.buffer.slice(decompressed.byteOffset, decompressed.byteOffset + decompressed.byteLength);
    } else {
      console.error('Gzip decompression not supported: DecompressionStream unavailable and pako not loaded');
      console.error('Either use a modern browser or include pako library, or regenerate data without compression');
      throw new Error('Gzip decompression not supported in this browser. Regenerate data with compression=None');
    }
  }

  // Not gzipped, return as-is
  return response.arrayBuffer();
}

/**
 * Fetch binary data with progress tracking for the notification center.
 * Tracks download progress and speed, reporting to the UI.
 *
 * @param {string} url - URL to fetch
 * @param {string} displayName - Human-readable name for the notification
 * @param {boolean} showNotification - Whether to show notification (default: true)
 * @param {RequestInit} [init]
 * @returns {Promise<ArrayBuffer>} Decompressed binary data
 */
async function fetchBinaryWithProgress(url, displayName = null, showNotification = true, init) {
  const notifications = getNotificationCenter();
  const name = displayName || url.split('/').pop().replace('.gz', '').replace('.bin', '');
  let trackerId = null;

  if (showNotification) {
    trackerId = notifications.startDownload(name);
  }

  try {
    const resolvedUrl = await resolveAnyUrl(url);
    const response = await fetch(resolvedUrl, init);

    if (!response.ok) {
      const err = new Error('Failed to load ' + url + ': ' + response.statusText);
      err.status = response.status;
      throw err;
    }

    // Get content length for progress tracking
    const contentLength = response.headers.get('content-length');
    const totalBytes = contentLength ? parseInt(contentLength, 10) : null;

    // Check if this is a gzipped file by URL extension
    const isGzipped = url.endsWith('.gz');

    // For streaming progress, we need to read the body manually
    if (response.body && showNotification) {
      const reader = response.body.getReader();
      const chunks = [];
      let loadedBytes = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        chunks.push(value);
        loadedBytes += value.length;

        if (trackerId) {
          notifications.updateDownload(trackerId, loadedBytes, totalBytes);
        }
      }

      // Combine chunks into single ArrayBuffer
      const allChunks = new Uint8Array(loadedBytes);
      let position = 0;
      for (const chunk of chunks) {
        allChunks.set(chunk, position);
        position += chunk.length;
      }

      // Handle decompression
      let result;
      if (isGzipped) {
        if (typeof DecompressionStream !== 'undefined') {
          const ds = new DecompressionStream('gzip');
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(allChunks);
              controller.close();
            }
          });
          const decompressedStream = stream.pipeThrough(ds);
          const decompressedResponse = new Response(decompressedStream);
          result = await decompressedResponse.arrayBuffer();
        } else if (typeof pako !== 'undefined') {
          const decompressed = pako.inflate(allChunks);
          result = decompressed.buffer.slice(decompressed.byteOffset, decompressed.byteOffset + decompressed.byteLength);
        } else {
          throw new Error('Gzip decompression not supported');
        }
      } else {
        result = allChunks.buffer;
      }

      if (trackerId) {
        notifications.completeDownload(trackerId);
      }
      return result;
    }

    // Fallback for when streaming is not available or notifications disabled
    if (isGzipped && typeof DecompressionStream !== 'undefined') {
      try {
        const ds = new DecompressionStream('gzip');
        const decompressedStream = response.body.pipeThrough(ds);
        const decompressedResponse = new Response(decompressedStream);
        const result = await decompressedResponse.arrayBuffer();
        if (trackerId) notifications.completeDownload(trackerId);
        return result;
      } catch (e) {
        if (trackerId) notifications.failDownload(trackerId, e.message);
        throw e;
      }
    } else if (isGzipped) {
      const compressedBuffer = await response.arrayBuffer();
      if (typeof pako !== 'undefined') {
        const decompressed = pako.inflate(new Uint8Array(compressedBuffer));
        if (trackerId) notifications.completeDownload(trackerId);
        return decompressed.buffer.slice(decompressed.byteOffset, decompressed.byteOffset + decompressed.byteLength);
      } else {
        const err = new Error('Gzip decompression not supported');
        if (trackerId) notifications.failDownload(trackerId, err.message);
        throw err;
      }
    }

    const result = await response.arrayBuffer();
    if (trackerId) notifications.completeDownload(trackerId);
    return result;

  } catch (error) {
    if (trackerId) {
      notifications.failDownload(trackerId, error.message);
    }
    throw error;
  }
}

/**
 * Load points binary, trying .gz version first if the URL doesn't already end in .gz
 * This handles both compressed and uncompressed data transparently.
 * Supports all custom protocols (local-user://, remote://, jupyter://) via DataSourceManager.
 *
 * @param {string} url - URL to fetch
 * @param {Object} options - Optional settings
 * @param {boolean} options.showProgress - Show progress notification (default: false)
 * @param {string} options.displayName - Display name for notification
 */
export async function loadPointsBinary(url, options = {}) {
  const { showProgress = false, displayName = null, dimension = 3 } = options;
  const notifications = getNotificationCenter();
  const name = displayName || 'Cell positions';
  let trackerId = null;

  // Check if AnnData source (h5ad or zarr) is active - use direct loading
  if (shouldUseAnnData(url)) {
    if (showProgress) {
      trackerId = notifications.startDownload(name);
    }
    try {
      // Extract dimension from URL if not provided (e.g., points_3d.bin -> 3)
      let dim = dimension;
      const dimMatch = url.match(/points_(\d)d\.bin/);
      if (dimMatch) {
        dim = parseInt(dimMatch[1], 10);
      }

      const result = await anndataLoadPoints(dim);
      if (trackerId) notifications.completeDownload(trackerId);
      return result;
    } catch (err) {
      if (trackerId) notifications.failDownload(trackerId, err.message);
      throw err;
    }
  }

  if (showProgress) {
    trackerId = notifications.startDownload(name);
  }

  try {
    // If URL already ends with .gz, just fetch it directly
    if (url.endsWith('.gz')) {
      const arrayBuffer = await fetchBinaryWithProgressInternal(url, trackerId, notifications);
      if (trackerId) notifications.completeDownload(trackerId);
      return new Float32Array(arrayBuffer);
    }

    const supportsGzip = HAS_DECOMPRESSION_STREAM || HAS_PAKO;

    // For local-user:// URLs, check if .gz version exists in the file list
    if (isLocalUserUrl(url)) {
      if (!supportsGzip) {
        console.log('Loading uncompressed points file:', url);
        const arrayBuffer = await fetchBinaryWithProgressInternal(url, trackerId, notifications);
        if (trackerId) notifications.completeDownload(trackerId);
        return new Float32Array(arrayBuffer);
      }

      const gzUrl = url + '.gz';
      try {
        const arrayBuffer = await fetchBinaryWithProgressInternal(gzUrl, trackerId, notifications);
        console.log('Found compressed points file:', gzUrl);
        if (trackerId) notifications.completeDownload(trackerId);
        return new Float32Array(arrayBuffer);
      } catch (_e) {
        console.log('Loading uncompressed points file:', url);
        const arrayBuffer = await fetchBinaryWithProgressInternal(url, trackerId, notifications);
        if (trackerId) notifications.completeDownload(trackerId);
        return new Float32Array(arrayBuffer);
      }
    }

    // For all other URLs (including custom protocols like remote://, jupyter://),
    // resolve the protocol first, then try .gz version
    const gzUrl = url + '.gz';
    try {
      if (!supportsGzip) {
        throw new Error('Gzip decompression not supported');
      }
      const resolvedGzUrl = await resolveAnyUrl(gzUrl);
      const response = await fetch(resolvedGzUrl);
      if (response.ok) {
        console.log('Found compressed points file:', gzUrl);

        // Track progress if enabled
        const contentLength = response.headers.get('content-length');
        const totalBytes = contentLength ? parseInt(contentLength, 10) : null;

        if (trackerId && response.body) {
          const reader = response.body.getReader();
          const chunks = [];
          let loadedBytes = 0;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loadedBytes += value.length;
            notifications.updateDownload(trackerId, loadedBytes, totalBytes);
          }

          const allChunks = new Uint8Array(loadedBytes);
          let position = 0;
          for (const chunk of chunks) {
            allChunks.set(chunk, position);
            position += chunk.length;
          }

          // Decompress
          if (HAS_DECOMPRESSION_STREAM) {
            const ds = new DecompressionStream('gzip');
            const stream = new ReadableStream({
              start(controller) {
                controller.enqueue(allChunks);
                controller.close();
              }
            });
            const decompressedStream = stream.pipeThrough(ds);
            const decompressedResponse = new Response(decompressedStream);
            const arrayBuffer = await decompressedResponse.arrayBuffer();
            notifications.completeDownload(trackerId);
            return new Float32Array(arrayBuffer);
          } else if (HAS_PAKO) {
            const decompressed = pako.inflate(allChunks);
            notifications.completeDownload(trackerId);
            // Use slice() to create a properly aligned copy - pako may return views with
            // non-4-byte-aligned byteOffset which causes Float32Array constructor to throw
            const alignedBuffer = decompressed.buffer.slice(
              decompressed.byteOffset,
              decompressed.byteOffset + decompressed.byteLength
            );
            return new Float32Array(alignedBuffer);
          }
        }

        // Fallback without progress tracking
        if (HAS_DECOMPRESSION_STREAM) {
          const ds = new DecompressionStream('gzip');
          const decompressedStream = response.body.pipeThrough(ds);
          const decompressedResponse = new Response(decompressedStream);
          const arrayBuffer = await decompressedResponse.arrayBuffer();
          if (trackerId) notifications.completeDownload(trackerId);
          return new Float32Array(arrayBuffer);
        } else if (HAS_PAKO) {
          const compressedBuffer = await response.arrayBuffer();
          const decompressed = pako.inflate(new Uint8Array(compressedBuffer));
          if (trackerId) notifications.completeDownload(trackerId);
          // Use slice() to create a properly aligned copy - pako may return views with
          // non-4-byte-aligned byteOffset which causes Float32Array constructor to throw
          const alignedBuffer = decompressed.buffer.slice(
            decompressed.byteOffset,
            decompressed.byteOffset + decompressed.byteLength
          );
          return new Float32Array(alignedBuffer);
        } else {
          console.warn('DecompressionStream not available and pako not loaded, trying uncompressed file');
        }
      }
    } catch (e) {
      console.log('Compressed file not available or failed:', e.message || e);
    }

    // Fall back to original URL (non-gzipped)
    console.log('Loading uncompressed points file:', url);
    const arrayBuffer = await fetchBinaryWithProgressInternal(url, trackerId, notifications);
    if (trackerId) notifications.completeDownload(trackerId);
    return new Float32Array(arrayBuffer);

  } catch (error) {
    if (trackerId) {
      notifications.failDownload(trackerId, error.message);
    }
    throw error;
  }
}

/**
 * Internal helper for progress-tracked binary fetch
 */
async function fetchBinaryWithProgressInternal(url, trackerId, notifications) {
  const resolvedUrl = await resolveAnyUrl(url);
  const response = await fetch(resolvedUrl);

  if (!response.ok) {
    const err = new Error('Failed to load ' + url + ': ' + response.statusText);
    err.status = response.status;
    throw err;
  }

  const contentLength = response.headers.get('content-length');
  const totalBytes = contentLength ? parseInt(contentLength, 10) : null;
  const isGzipped = url.endsWith('.gz');

  if (trackerId && response.body) {
    const reader = response.body.getReader();
    let loadedBytes = 0;

    // Stream into a new ReadableStream so we can:
    // - track progress without buffering all chunks twice
    // - support streaming gzip decompression when available
    const monitoredStream = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        loadedBytes += value?.byteLength ?? value?.length ?? 0;
        notifications.updateDownload(trackerId, loadedBytes, totalBytes);
        controller.enqueue(value);
      },
      cancel() {
        try {
          reader.cancel();
        } catch (_err) {
          // Ignore cancel errors
        }
      }
    });

    if (isGzipped) {
      if (typeof DecompressionStream !== 'undefined') {
        const ds = new DecompressionStream('gzip');
        const decompressedStream = monitoredStream.pipeThrough(ds);
        const decompressedResponse = new Response(decompressedStream);
        return decompressedResponse.arrayBuffer();
      } else if (typeof pako !== 'undefined') {
        const compressedBuffer = await new Response(monitoredStream).arrayBuffer();
        const decompressed = pako.inflate(new Uint8Array(compressedBuffer));
        return decompressed.buffer.slice(decompressed.byteOffset, decompressed.byteOffset + decompressed.byteLength);
      }
      throw new Error('Gzip decompression not supported');
    }

    return new Response(monitoredStream).arrayBuffer();
  }

  // Fallback without progress tracking
  if (isGzipped && typeof DecompressionStream !== 'undefined') {
    const ds = new DecompressionStream('gzip');
    const decompressedStream = response.body.pipeThrough(ds);
    const decompressedResponse = new Response(decompressedStream);
    return decompressedResponse.arrayBuffer();
  } else if (isGzipped && typeof pako !== 'undefined') {
    const compressedBuffer = await response.arrayBuffer();
    const decompressed = pako.inflate(new Uint8Array(compressedBuffer));
    return decompressed.buffer.slice(decompressed.byteOffset, decompressed.byteOffset + decompressed.byteLength);
  } else if (isGzipped) {
    throw new Error('Gzip decompression not supported');
  }

  return response.arrayBuffer();
}

/**
 * Convert filename to safe version (must match Python _safe_filename_component)
 */
function safeFilenameComponent(name) {
  let safe = String(name).replace(/[^A-Za-z0-9._-]+/g, '_');
  safe = safe.replace(/^[._]+|[._]+$/g, '');
  return safe || 'field';
}

/**
 * Expand compact var manifest to original verbose format.
 * Compact format uses _varSchema + field tuples [key, minValue, maxValue].
 * @param {Object} manifest - Raw manifest (possibly compact)
 * @returns {Object} Expanded manifest with fields array
 */
export function expandVarManifest(manifest) {
  if (manifest._format !== 'compact_v1' || !manifest._varSchema) {
    return manifest; // Already in original format
  }

  const schema = manifest._varSchema;
  const fields = [];

  for (const fieldTuple of (manifest.fields || [])) {
    const key = fieldTuple[0];
    const safeKey = safeFilenameComponent(key);

    const field = {
      key: key,
      kind: schema.kind,
      valuesPath: schema.pathPattern.replace('{key}', safeKey),
      valuesDtype: schema.dtype,
    };

    if (schema.quantized) {
      field.quantized = true;
      field.quantizationBits = schema.quantizationBits;
      field.minValue = fieldTuple[1];
      field.maxValue = fieldTuple[2];
    }

    fields.push(field);
  }

  // Return expanded manifest without underscore-prefixed keys
  const result = {};
  for (const [k, v] of Object.entries(manifest)) {
    if (!k.startsWith('_')) {
      result[k] = v;
    }
  }
  result.fields = fields;
  return result;
}

/**
 * Expand compact obs manifest to original verbose format.
 * Compact format uses _obsSchemas + _continuousFields + _categoricalFields.
 * @param {Object} manifest - Raw manifest (possibly compact)
 * @returns {Object} Expanded manifest with fields array
 */
export function expandObsManifest(manifest) {
  if (manifest._format !== 'compact_v1' || !manifest._obsSchemas) {
    return manifest; // Already in original format
  }

  const schemas = manifest._obsSchemas;
  const fields = [];

  // Expand continuous fields
  const contSchema = schemas.continuous;
  if (contSchema) {
    for (const fieldTuple of (manifest._continuousFields || [])) {
      const key = fieldTuple[0];
      const safeKey = safeFilenameComponent(key);

      const field = {
        key: key,
        kind: 'continuous',
        valuesPath: contSchema.pathPattern.replace('{key}', safeKey),
        valuesDtype: contSchema.dtype,
        centroids: null,
        outlierQuantilesPath: null,
      };

      if (contSchema.quantized) {
        field.quantized = true;
        field.quantizationBits = contSchema.quantizationBits;
        field.minValue = fieldTuple[1];
        field.maxValue = fieldTuple[2];
      }

      fields.push(field);
    }
  }

  // Expand categorical fields
  const catSchema = schemas.categorical;
  if (catSchema) {
    for (const fieldTuple of (manifest._categoricalFields || [])) {
      // [key, categories, codesDtype, codesMissingValue, centroidsByDim, outlierMin?, outlierMax?]
      // centroidsByDim is a dict: {"1": [...], "2": [...], "3": [...]} for per-dimension centroids
      // OR legacy format: [{category, position, n_points}, ...] for single dimension (3D)
      const key = fieldTuple[0];
      const safeKey = safeFilenameComponent(key);
      const categories = fieldTuple[1];
      const codesDtype = fieldTuple[2];
      const codesMissingValue = fieldTuple[3];
      const centroidsData = fieldTuple[4];

      // Determine codes extension from dtype
      const codesExt = codesDtype === 'uint8' ? 'u8' : 'u16';

      // Handle both legacy (array) and new (dict by dimension) centroid formats
      let centroidsByDim;
      if (Array.isArray(centroidsData)) {
        // Legacy format: single array of centroids (assume 3D)
        centroidsByDim = { '3': centroidsData };
      } else if (centroidsData && typeof centroidsData === 'object') {
        // New format: dict keyed by dimension
        centroidsByDim = centroidsData;
      } else {
        centroidsByDim = {};
      }

      const field = {
        key: key,
        kind: 'category',
        categories: categories,
        codesPath: catSchema.codesPathPattern.replace('{key}', safeKey).replace('{ext}', codesExt),
        codesDtype: codesDtype,
        codesMissingValue: codesMissingValue,
        outlierQuantilesPath: catSchema.outlierPathPattern.replace('{key}', safeKey),
        outlierDtype: catSchema.outlierDtype,
        centroidsByDim: centroidsByDim,
        // For backward compatibility, provide centroids as highest available dimension (3D -> 2D -> 1D).
        // Higher dimensions are preferred because they can be projected down to lower dimensions.
        // Note: state.js correctly looks up centroids by current dimension first via centroidsByDim,
        // so this is only used as a last-resort fallback for legacy code paths.
        centroids: centroidsByDim['3'] || centroidsByDim['2'] || centroidsByDim['1'] || [],
      };

      if (catSchema.outlierQuantized) {
        field.outlierQuantized = true;
        field.outlierMinValue = fieldTuple[5];
        field.outlierMaxValue = fieldTuple[6];
      }

      fields.push(field);
    }
  }

  // Return expanded manifest without underscore-prefixed keys
  const result = {};
  for (const [k, v] of Object.entries(manifest)) {
    if (!k.startsWith('_')) {
      result[k] = v;
    }
  }
  result.fields = fields;
  return result;
}

export async function loadObsManifest(url) {
  // Handle AnnData source (h5ad or zarr) - unified handling
  if (shouldUseAnnData(url)) {
    const manifest = anndataGetObsManifest();
    return expandObsManifest(manifest);
  }

  // Handle local-user:// URLs
  if (isLocalUserUrl(url)) {
    const manifest = await fetchLocalUserJson(url);
    return expandObsManifest(manifest);
  }

  const response = await fetchOk(url);
  const manifest = await response.json();
  return expandObsManifest(manifest);
}

/**
 * Load obs field data with automatic dequantization for quantized fields.
 * Fully backward compatible with existing non-quantized data.
 * Handles gzip-compressed files automatically.
 * 
 * @param {string} manifestUrl - Base URL for resolving paths
 * @param {object} field - Field metadata from manifest
 * @returns {object} Loaded data with values/codes/outlierQuantiles
 */
export async function loadObsFieldData(manifestUrl, field, options = {}) {
  if (!field) throw new Error('No field metadata provided for obs field fetch.');

  const { fetchInit } = options || {};

  // Handle AnnData source (h5ad or zarr) - unified handling
  if (shouldUseAnnData(manifestUrl)) {
    const anndataData = await anndataLoadObsField(field.key);
    const outputs = { loaded: true };

    if (anndataData.kind === 'continuous') {
      outputs.values = new Float32Array(anndataData.data);
    } else {
      // Categorical
      const dtype = anndataData.dtype === 'uint8' ? Uint8Array : Uint16Array;
      const raw = new dtype(anndataData.data);

      // Convert uint8 to uint16 for consistency
      if (anndataData.dtype === 'uint8') {
        const u16 = new Uint16Array(raw.length);
        const missingU8 = 255;
        const missingU16 = anndataData.missingValue || 65535;
        for (let i = 0; i < raw.length; i++) {
          u16[i] = raw[i] === missingU8 ? missingU16 : raw[i];
        }
        outputs.codes = u16;
      } else {
        outputs.codes = raw;
      }

      // No outlier quantiles from AnnData (would need latent space computation)
      outputs.outlierQuantiles = new Float32Array(raw.length);
    }

    return outputs;
  }

  // Note: Notifications are handled by the caller (state.js) to avoid duplicates
  const outputs = { loaded: true };

  // Load continuous values
  if (field.valuesPath) {
    const url = resolveUrl(manifestUrl, field.valuesPath);
    const buffer = await fetchBinary(url, fetchInit);
    const dtype = field.valuesDtype || 'float32';

    // Check if quantized and needs dequantization
    if (field.quantized && (dtype === 'uint8' || dtype === 'uint16') &&
        field.minValue !== undefined && field.maxValue !== undefined) {
      const bits = field.quantizationBits || (dtype === 'uint8' ? 8 : 16);
      outputs.values = await dequantizeToFloat32({
        buffer,
        dtype,
        minValue: field.minValue,
        maxValue: field.maxValue,
        bits,
        urlForError: url,
        refetchBuffer: () => fetchBinary(url, fetchInit)
      });
    } else {
      // Non-quantized or already float32
      outputs.values = typedArrayFromBuffer(buffer, dtype, url);
    }
  }

  // Load categorical codes
  if (field.codesPath) {
    const url = resolveUrl(manifestUrl, field.codesPath);
    const buffer = await fetchBinary(url, fetchInit);
    const dtype = field.codesDtype || 'uint16';
    const raw = typedArrayFromBuffer(buffer, dtype, url);

    // If uint8 codes, convert to uint16 for consistency with rest of app
    if (dtype === 'uint8') {
      const u16 = new Uint16Array(raw.length);
      const missingU8 = 255;
      const missingU16 = field.codesMissingValue !== undefined ? field.codesMissingValue : 65535;
      for (let i = 0; i < raw.length; i++) {
        u16[i] = raw[i] === missingU8 ? missingU16 : raw[i];
      }
      outputs.codes = u16;
    } else {
      outputs.codes = raw;
    }
  }

  // Load outlier quantiles
  if (field.outlierQuantilesPath) {
    const url = resolveUrl(manifestUrl, field.outlierQuantilesPath);
    const buffer = await fetchBinary(url, fetchInit);
    const dtype = field.outlierDtype || 'float32';

    // Check if quantized and needs dequantization
    if (field.outlierQuantized && (dtype === 'uint8' || dtype === 'uint16')) {
      const bits = dtype === 'uint8' ? 8 : 16;
      outputs.outlierQuantiles = await dequantizeToFloat32({
        buffer,
        dtype,
        minValue: field.outlierMinValue !== undefined ? field.outlierMinValue : 0,
        maxValue: field.outlierMaxValue !== undefined ? field.outlierMaxValue : 1,
        bits,
        urlForError: url,
        refetchBuffer: () => fetchBinary(url, fetchInit)
      });
    } else {
      outputs.outlierQuantiles = typedArrayFromBuffer(buffer, dtype, url);
    }
  }

  return outputs;
}

// Var/gene expression manifest loader
export async function loadVarManifest(url) {
  // Handle AnnData source (h5ad or zarr) - unified handling
  if (shouldUseAnnData(url)) {
    const manifest = anndataGetVarManifest();
    return expandVarManifest(manifest);
  }

  // Handle local-user:// URLs
  if (isLocalUserUrl(url)) {
    const manifest = await fetchLocalUserJson(url);
    return expandVarManifest(manifest);
  }

  const response = await fetchOk(url);
  const manifest = await response.json();
  return expandVarManifest(manifest);
}

/**
 * Load gene expression field data with automatic dequantization.
 * Handles gzip-compressed files automatically.
 *
 * @param {string} manifestUrl - Base URL for resolving paths
 * @param {object} field - Field metadata from manifest
 * @returns {object} Loaded data with values as Float32Array
 */
export async function loadVarFieldData(manifestUrl, field, options = {}) {
  if (!field) throw new Error('No field metadata provided for var field fetch.');

  const { fetchInit } = options || {};

  // Handle AnnData source (h5ad or zarr) - unified handling
  if (shouldUseAnnData(manifestUrl)) {
    const values = await anndataLoadGeneExpression(field.key);
    return { loaded: true, values };
  }

  // Note: Notifications are handled by the caller (state.js) to avoid duplicates
  const outputs = { loaded: true };

  if (field.valuesPath) {
    const url = resolveUrl(manifestUrl, field.valuesPath);
    const buffer = await fetchBinary(url, fetchInit);
    const dtype = field.valuesDtype || 'float32';

    // Check if quantized and needs dequantization
    if (field.quantized && (dtype === 'uint8' || dtype === 'uint16') &&
        field.minValue !== undefined && field.maxValue !== undefined) {
      const bits = field.quantizationBits || (dtype === 'uint8' ? 8 : 16);
      outputs.values = await dequantizeToFloat32({
        buffer,
        dtype,
        minValue: field.minValue,
        maxValue: field.maxValue,
        bits,
        urlForError: url,
        refetchBuffer: () => fetchBinary(url, fetchInit)
      });
    } else {
      outputs.values = typedArrayFromBuffer(buffer, dtype, url);
    }
  }

  return outputs;
}

/**
 * @typedef {{
 *   fetchInit?: RequestInit
 * }} FieldLoaderOptions
 */

/**
 * Create a field loader closure with shared options (DRY).
 * @param {string} manifestUrl
 * @param {FieldLoaderOptions} [options]
 * @returns {(field: any) => Promise<any>}
 */
export function createObsFieldLoader(manifestUrl, options = {}) {
  return (field) => loadObsFieldData(manifestUrl, field, options);
}

/**
 * Create a var field loader closure with shared options (DRY).
 * @param {string} manifestUrl
 * @param {FieldLoaderOptions} [options]
 * @returns {(field: any) => Promise<any>}
 */
export function createVarFieldLoader(manifestUrl, options = {}) {
  return (field) => loadVarFieldData(manifestUrl, field, options);
}

// Legacy loader kept for backward compatibility (single large JSON payload).
export async function loadObsJson(url) {
  // Handle local-user:// URLs
  if (isLocalUserUrl(url)) {
    return fetchLocalUserJson(url);
  }

  const response = await fetchOk(url);
  return response.json();
}

// ============================================================================
// CONNECTIVITY / EDGE DATA LOADERS
// ============================================================================
// GPU-optimized edge format for instanced rendering with:
// - Direct GPU upload (no CPU processing)
// - Instanced rendering with texture lookups
// - Visibility filtering in shader
// - Support for uint16, uint32, and uint64 indices

/**
 * Load connectivity manifest
 * @param {string} url - URL to connectivity manifest JSON
 * @returns {Promise<Object>} Connectivity manifest
 */
export async function loadConnectivityManifest(url) {
  // Handle AnnData source (h5ad or zarr) - unified handling
  if (shouldUseAnnData(url)) {
    const manifest = await anndataGetConnectivityManifest();
    return manifest;
  }

  // Handle local-user:// URLs
  if (isLocalUserUrl(url)) {
    return fetchLocalUserJson(url);
  }

  const response = await fetchOk(url);
  return response.json();
}

/**
 * Check if manifest has valid edge format
 * @param {Object} manifest - Connectivity manifest
 * @returns {boolean} True if edge format is available
 */
export function hasEdgeFormat(manifest) {
  if (!manifest || manifest.format !== 'edge_pairs') {
    return false;
  }
  // For file-based sources: need sourcesPath and destinationsPath
  // For anndata sources: just need n_edges > 0 (edges loaded directly from adapter)
  const hasFilePaths = manifest.sourcesPath && manifest.destinationsPath;
  const hasAnndataEdges = manifest.n_edges > 0 && !manifest.sourcesPath;
  return hasFilePaths || hasAnndataEdges;
}

/**
 * Load edge sources array (sorted for optimal compression)
 * @param {string} manifestUrl - Base URL for manifest
 * @param {Object} manifest - Connectivity manifest
 * @returns {Promise<Uint16Array|Uint32Array|BigUint64Array>} Edge source indices
 */
export async function loadEdgeSources(manifestUrl, manifest) {
  if (!hasEdgeFormat(manifest)) {
    throw new Error('Invalid connectivity manifest: missing edge format.');
  }
  // AnnData sources load edges directly from the adapter (no file paths).
  if (shouldUseAnnData(manifestUrl)) {
    const edgeData = await anndataLoadConnectivity();
    if (!edgeData) {
      throw new Error('No connectivity data in AnnData file');
    }
    return edgeData.sources;
  }
  const url = resolveUrl(manifestUrl, manifest.sourcesPath);
  const buffer = await fetchBinary(url);
  return typedArrayFromBuffer(buffer, manifest.index_dtype, url);
}

/**
 * Load edge destinations array (sorted for optimal compression)
 * @param {string} manifestUrl - Base URL for manifest
 * @param {Object} manifest - Connectivity manifest
 * @returns {Promise<Uint16Array|Uint32Array|BigUint64Array>} Edge destination indices
 */
export async function loadEdgeDestinations(manifestUrl, manifest) {
  if (!hasEdgeFormat(manifest)) {
    throw new Error('Invalid connectivity manifest: missing edge format.');
  }
  // AnnData sources load edges directly from the adapter (no file paths).
  if (shouldUseAnnData(manifestUrl)) {
    const edgeData = await anndataLoadConnectivity();
    if (!edgeData) {
      throw new Error('No connectivity data in AnnData file');
    }
    return edgeData.destinations;
  }
  const url = resolveUrl(manifestUrl, manifest.destinationsPath);
  const buffer = await fetchBinary(url);
  return typedArrayFromBuffer(buffer, manifest.index_dtype, url);
}

/**
 * Load both edge arrays in parallel
 * @param {string} manifestUrl - Base URL for manifest
 * @param {Object} manifest - Connectivity manifest
 * @returns {Promise<{sources: TypedArray, destinations: TypedArray, nEdges: number, nCells: number, maxNeighbors: number, indexDtype: string}>}
 */
export async function loadEdges(manifestUrl, manifest) {
  // Handle AnnData source (h5ad or zarr) - unified handling
  if (shouldUseAnnData(manifestUrl)) {
    const edgeData = await anndataLoadConnectivity();
    if (!edgeData) {
      throw new Error('No connectivity data in AnnData file');
    }
    return {
      sources: edgeData.sources,
      destinations: edgeData.destinations,
      nEdges: edgeData.nEdges,
      nCells: manifest?.n_cells || edgeData.sources.length,
      maxNeighbors: manifest?.max_neighbors || 0,
      indexDtype: 'uint32'
    };
  }

  if (!hasEdgeFormat(manifest)) {
    throw new Error('Invalid connectivity manifest: missing edge format.');
  }
  const [rawSources, rawDestinations] = await Promise.all([
    loadEdgeSources(manifestUrl, manifest),
    loadEdgeDestinations(manifestUrl, manifest)
  ]);

  // Convert to Uint32Array to handle uint64 dtypes (BigUint64Array cannot be
  // assigned to regular typed arrays, and WebGL textures use uint32 anyway).
  // This is safe because cell counts > 4 billion are unrealistic.
  const sources = toUint32Array(rawSources);
  const destinations = toUint32Array(rawDestinations);

  return {
    sources,
    destinations,
    nEdges: manifest.n_edges,
    nCells: manifest.n_cells,
    maxNeighbors: manifest.max_neighbors,
    indexDtype: 'uint32' // Always uint32 after conversion
  };
}

// ============================================================================
// DATASET IDENTITY LOADER (includes multi-dimensional embeddings metadata)
// ============================================================================

/**
 * Load dataset identity JSON (includes embeddings metadata for multi-dimensional support)
 * @param {string} url - URL to dataset_identity.json
 * @returns {Promise<Object>} Dataset identity with embeddings metadata
 */
export async function loadDatasetIdentity(url) {
  // Handle AnnData source (h5ad or zarr) - unified handling
  if (shouldUseAnnData(url)) {
    return anndataGetDatasetIdentity();
  }

  // Handle local-user:// URLs
  if (isLocalUserUrl(url)) {
    return fetchLocalUserJson(url);
  }

  const response = await fetchOk(url);
  return response.json();
}

/**
 * Extract embeddings metadata from dataset identity
 * @param {Object} identity - Dataset identity object
 * @returns {Object|null} Embeddings metadata or null if not present
 */
export function getEmbeddingsMetadata(identity) {
  if (!identity) return null;

  // Version 2+ has explicit embeddings field
  if (identity.embeddings) {
    return identity.embeddings;
  }

  // Version 1 (legacy): assume only 3D is available
  // Note: points.bin is deprecated, use points_3d.bin for new exports
  return {
    available_dimensions: [3],
    default_dimension: 3,
    files: {
      '3d': 'points_3d.bin'
    }
  };
}

// ============================================================================
// ANALYSIS-SPECIFIC BULK DATA LOADER
// ============================================================================

/**
 * Load bulk analysis data: multiple gene expressions in parallel batches.
 * Optimized for analysis workflows requiring many genes at once.
 * Uses notification center for progress tracking.
 *
 * @param {Object} options
 * @param {string} options.manifestUrl - Base URL for var manifest
 * @param {Object} options.varManifest - Pre-loaded var manifest (fields array)
 * @param {string[]} options.geneList - Genes to load
 * @param {number} [options.batchSize=20] - Number of genes to load in parallel
 * @param {Function} [options.onProgress] - Progress callback (0-100)
 * @returns {Promise<Object>} { genes: { geneName: Float32Array }, loadedCount, failedCount }
 */
export async function loadAnalysisBulkData(options) {
  const {
    manifestUrl,
    varManifest,
    geneList,
    batchSize = 20,
    onProgress
  } = options;

  const notifications = getNotificationCenter();
  const trackerId = notifications.show({
    type: 'progress',
    category: 'data',
    title: 'Loading Gene Expression',
    message: `Preparing ${geneList.length} genes...`,
    progress: 0
  });

  const result = {
    genes: {},
    loadedCount: 0,
    failedCount: 0,
    failedGenes: []
  };

  try {
    // Build gene field lookup
    const fieldLookup = new Map();
    if (varManifest && varManifest.fields) {
      for (const field of varManifest.fields) {
        fieldLookup.set(field.key, field);
      }
    }

    // Filter to genes that exist in manifest
    const validGenes = geneList.filter(gene => fieldLookup.has(gene));
    const missingGenes = geneList.filter(gene => !fieldLookup.has(gene));

    if (missingGenes.length > 0) {
      result.failedGenes.push(...missingGenes);
      result.failedCount += missingGenes.length;
    }

    if (validGenes.length === 0) {
      notifications.complete(trackerId, 'No valid genes found');
      return result;
    }

    // Load genes in parallel batches
    let loadedCount = 0;
    const totalGenes = validGenes.length;

    for (let i = 0; i < validGenes.length; i += batchSize) {
      const batch = validGenes.slice(i, i + batchSize);

      // Load batch in parallel
      const batchPromises = batch.map(async (geneName) => {
        const field = fieldLookup.get(geneName);
        try {
          const data = await loadVarFieldData(manifestUrl, field);
          return { geneName, values: data.values, success: true };
        } catch (error) {
          console.warn(`[loadAnalysisBulkData] Failed to load gene ${geneName}:`, error.message);
          return { geneName, values: null, success: false, error: error.message };
        }
      });

      const batchResults = await Promise.all(batchPromises);

      // Process batch results
      for (const res of batchResults) {
        if (res.success && res.values) {
          result.genes[res.geneName] = res.values;
          result.loadedCount++;
        } else {
          result.failedGenes.push(res.geneName);
          result.failedCount++;
        }
      }

      // Update progress
      loadedCount += batch.length;
      const progress = Math.round((loadedCount / totalGenes) * 100);

      notifications.updateProgress(trackerId, progress, {
        message: `Loaded ${loadedCount} of ${totalGenes} genes...`
      });

      if (onProgress) {
        onProgress(progress);
      }
    }

    // Complete notification
    const message = result.failedCount > 0
      ? `Loaded ${result.loadedCount} genes (${result.failedCount} failed)`
      : `Loaded ${result.loadedCount} genes`;

    notifications.complete(trackerId, message);

    return result;

  } catch (error) {
    notifications.fail(trackerId, `Failed: ${error.message}`);
    throw error;
  }
}

/**
 * Load latent embeddings for analysis (e.g., for clustering, UMAP visualization).
 * Supports multiple embedding types (PCA, UMAP, t-SNE, etc.)
 *
 * @param {Object} options
 * @param {string} options.baseUrl - Base URL for data files
 * @param {Object} options.identity - Dataset identity object
 * @param {number} [options.dimension=2] - Dimension to load (1, 2, or 3)
 * @returns {Promise<Object>} { points: Float32Array, dimension, cellCount }
 */
export async function loadLatentEmbeddings(options) {
  const { baseUrl, identity, dimension = 2 } = options;

  const notifications = getNotificationCenter();
  const trackerId = notifications.startDownload(`${dimension}D Embeddings`);

  try {
    const embeddings = getEmbeddingsMetadata(identity);

    if (!embeddings) {
      throw new Error('No embeddings metadata available');
    }

    // Check if requested dimension is available
    const available = embeddings.available_dimensions || [3];
    if (!available.includes(dimension)) {
      // Fall back to highest available dimension
      const fallbackDim = Math.max(...available);
      console.warn(`[loadLatentEmbeddings] Dimension ${dimension} not available, using ${fallbackDim}`);
    }

    // Determine file path
    const dimKey = `${dimension}d`;
    const filePath = embeddings.files?.[dimKey] || `points_${dimension}d.bin`;
    const url = resolveUrl(baseUrl, filePath);

    // Load the points
    const points = await loadPointsBinary(url, {
      dimension,
      showProgress: false
    });

    const cellCount = Math.floor(points.length / dimension);

    notifications.completeDownload(trackerId);

    return {
      points,
      dimension,
      cellCount
    };

  } catch (error) {
    notifications.failDownload(trackerId, error.message);
    throw error;
  }
}

/**
 * Load analysis data for specific cell indices only.
 * More efficient when analyzing a subset of cells (e.g., highlighted pages).
 *
 * @param {Object} options
 * @param {string} options.manifestUrl - Base URL for var manifest
 * @param {Object} options.varManifest - Pre-loaded var manifest
 * @param {string[]} options.geneList - Genes to load
 * @param {number[]} options.cellIndices - Cell indices to extract
 * @param {number} [options.batchSize=20] - Batch size for parallel loading
 * @param {Function} [options.onProgress] - Progress callback
 * @returns {Promise<Object>} { genes: { geneName: { values, indices } }, cellCount }
 */
export async function loadAnalysisSubset(options) {
  const {
    manifestUrl,
    varManifest,
    geneList,
    cellIndices,
    batchSize = 20,
    onProgress
  } = options;

  const notifications = getNotificationCenter();
  const trackerId = notifications.show({
    type: 'progress',
    category: 'data',
    title: 'Loading Subset Data',
    message: `Loading ${geneList.length} genes for ${cellIndices.length} cells...`,
    progress: 0
  });

  try {
    // First load all gene data
    const bulkResult = await loadAnalysisBulkData({
      manifestUrl,
      varManifest,
      geneList,
      batchSize,
      onProgress: (p) => {
        notifications.updateProgress(trackerId, Math.round(p * 0.8), {
          message: `Loading genes (${Math.round(p)}%)...`
        });
        if (onProgress) onProgress(Math.round(p * 0.8));
      }
    });

    // Extract values for specified cell indices
    notifications.updateProgress(trackerId, 85, {
      message: 'Extracting cell values...'
    });

    const result = {
      genes: {},
      cellCount: cellIndices.length,
      cellIndices
    };

    // Create index set for fast lookup
    const indexSet = new Set(cellIndices);
    const indexArray = Array.from(cellIndices);

    for (const [geneName, fullValues] of Object.entries(bulkResult.genes)) {
      const subsetValues = new Float32Array(cellIndices.length);

      for (let i = 0; i < indexArray.length; i++) {
        const cellIdx = indexArray[i];
        if (cellIdx < fullValues.length) {
          subsetValues[i] = fullValues[cellIdx];
        } else {
          subsetValues[i] = NaN;
        }
      }

      result.genes[geneName] = {
        values: subsetValues,
        indices: indexArray
      };
    }

    notifications.complete(trackerId,
      `Loaded ${Object.keys(result.genes).length} genes for ${cellIndices.length} cells`
    );

    if (onProgress) onProgress(100);

    return result;

  } catch (error) {
    notifications.fail(trackerId, `Failed: ${error.message}`);
    throw error;
  }
}

// ============================================================================
// ANALYSIS-SPECIFIC BULK OBS LOADER
// ============================================================================
//
// This function is integrated into EnhancedDataLayer.fetchMultiFieldData()
// in enhanced-data-layer.js for multi-variable analysis workflows.
// ============================================================================

/**
 * Load bulk observation field data: multiple obs fields in parallel.
 * Optimized for analysis workflows requiring many obs fields at once.
 * Uses notification center for progress tracking.
 *
 * Supports all data sources:
 * - HTTP/HTTPS (standard web)
 * - local-user:// (user's local filesystem)
 * - remote:// (remote server sources)
 * - jupyter:// (Jupyter notebook server)
 * - h5ad files (via shouldUseAnnData check in loadObsFieldData)
 * - zarr directories (via shouldUseAnnData check in loadObsFieldData)
 *
 * @param {Object} options
 * @param {string} options.manifestUrl - Base URL for obs manifest
 * @param {Object} options.obsManifest - Pre-loaded obs manifest (fields array)
 * @param {string[]} options.fieldList - Field keys to load
 * @param {number} [options.batchSize=10] - Number of fields to load in parallel (lower than genes due to larger data)
 * @param {Function} [options.onProgress] - Progress callback (0-100)
 * @returns {Promise<Object>} { fields: { fieldKey: { values?, codes?, categories?, kind } }, loadedCount, failedCount }
 */
export async function loadAnalysisBulkObsData(options) {
  const {
    manifestUrl,
    obsManifest,
    fieldList,
    batchSize = 10, // Lower batch size than genes - obs fields can be larger
    onProgress
  } = options;

  const notifications = getNotificationCenter();
  const trackerId = notifications.show({
    type: 'progress',
    category: 'data',
    title: 'Loading Observation Fields',
    message: `Preparing ${fieldList.length} fields...`,
    progress: 0
  });

  const result = {
    fields: {},
    loadedCount: 0,
    failedCount: 0,
    failedFields: []
  };

  try {
    // Build field lookup from manifest
    const fieldLookup = new Map();
    if (obsManifest && obsManifest.fields) {
      for (const field of obsManifest.fields) {
        fieldLookup.set(field.key, field);
      }
    }

    // Filter to fields that exist in manifest
    const validFields = fieldList.filter(key => fieldLookup.has(key));
    const missingFields = fieldList.filter(key => !fieldLookup.has(key));

    if (missingFields.length > 0) {
      result.failedFields.push(...missingFields);
      result.failedCount += missingFields.length;
      console.warn('[loadAnalysisBulkObsData] Fields not found in manifest:', missingFields);
    }

    if (validFields.length === 0) {
      notifications.complete(trackerId, 'No valid fields found');
      return result;
    }

    // Load fields in parallel batches
    let loadedCount = 0;
    const totalFields = validFields.length;

    for (let i = 0; i < validFields.length; i += batchSize) {
      const batch = validFields.slice(i, i + batchSize);

      // Load batch in parallel
      const batchPromises = batch.map(async (fieldKey) => {
        const field = fieldLookup.get(fieldKey);
        try {
          const data = await loadObsFieldData(manifestUrl, field);

          // Determine field kind and structure result
          const fieldResult = {
            kind: field.kind || (data.codes ? 'category' : 'continuous'),
            categories: field.categories || null
          };

          if (data.values) {
            fieldResult.values = data.values;
          }
          if (data.codes) {
            fieldResult.codes = data.codes;
          }

          return { fieldKey, data: fieldResult, success: true };
        } catch (error) {
          console.warn(`[loadAnalysisBulkObsData] Failed to load field ${fieldKey}:`, error.message);
          return { fieldKey, data: null, success: false, error: error.message };
        }
      });

      const batchResults = await Promise.all(batchPromises);

      // Process batch results
      for (const res of batchResults) {
        if (res.success && res.data) {
          result.fields[res.fieldKey] = res.data;
          result.loadedCount++;
        } else {
          result.failedFields.push(res.fieldKey);
          result.failedCount++;
        }
      }

      // Update progress
      loadedCount += batch.length;
      const progress = Math.round((loadedCount / totalFields) * 100);

      notifications.updateProgress(trackerId, progress, {
        message: `Loaded ${loadedCount} of ${totalFields} fields...`
      });

      if (onProgress) {
        onProgress(progress);
      }
    }

    // Complete notification
    const message = result.failedCount > 0
      ? `Loaded ${result.loadedCount} fields (${result.failedCount} failed)`
      : `Loaded ${result.loadedCount} fields`;

    notifications.complete(trackerId, message);

    return result;

  } catch (error) {
    notifications.fail(trackerId, `Failed: ${error.message}`);
    throw error;
  }
}
