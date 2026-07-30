// Fetch helpers for loading binary positions and obs payloads (manifest + per-field data).
// Supports quantized data with transparent dequantization and gzip-compressed files.
// Supports custom protocols (local-user://, remote://, jupyter://) via DataSourceManager.
// Includes progress tracking with download speed for the notification center.

import { getDataSourceManager } from './data-source-manager.js';
import { fetchSampleArtifact, isLocalUserUrl, resolveUrl } from './data-source.js';
import { getNotificationCenter } from '../app/notification-center.js';
import { setOwnDataProperty } from '../utils/exact-record.js';
import {
  QUANTIZATION_BACKEND,
  dequantizeToFloat32InWorker,
  selectQuantizationBackend,
} from './quantization-worker-pool.js';
import { validateQuantizationMetadata } from './quantization-contract.js';
import {
  CONNECTIVITY_MANIFEST_CONTEXT,
  validateConnectivityEdgeData,
  validateConnectivityManifest,
} from './connectivity-manifest-contract.js';
import {
  getMetadataLoadSignal,
  throwIfMetadataAborted,
} from './metadata-load-contract.js';
// Unified AnnData provider handles both h5ad and zarr sources
import {
  isAnnDataUrl,
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
 * Direct access is selected only by an explicit direct-source protocol.
 * @param {string} url - URL to check
 * @returns {boolean}
 */
function shouldUseAnnData(url) {
  return isAnnDataUrl(url);
}

// ============================================================================
// UNIFIED URL RESOLUTION (delegates to DataSourceManager)
// ============================================================================

/**
 * Resolve any URL (including custom protocols) to a fetchable URL.
 * Delegates to DataSourceManager for all protocol handling.
 * @param {string} url - URL to resolve (may be local-user://, remote://, jupyter://, etc.)
 * @param {AbortSignal|null} signal - Exact request owner
 * @returns {Promise<string>} Standard fetchable URL (http://, https://, blob://, data://)
 */
async function resolveAnyUrl(url, signal, stagedSource = null) {
  const manager = getDataSourceManager();
  if (stagedSource === null) {
    return manager.resolveUrl(url, signal);
  }
  return manager.resolveUrlWithSource(url, signal, stagedSource);
}

/**
 * Fetch JSON with automatic custom protocol handling
 * @param {string} url - URL to fetch (may use custom protocol)
 * @returns {Promise<any>}
 */
async function fetchJsonWithProtocol(
  url,
  init,
  stagedSource = null
) {
  const response = await fetchOk(url, init, stagedSource);
  return response.json();
}

function getStagedMetadataLoadOwner(options, label) {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    (
      Object.getPrototypeOf(options) !== Object.prototype &&
      Object.getPrototypeOf(options) !== null
    )
  ) {
    throw new TypeError(`${label} options must be an object`);
  }
  const supported = new Set([
    'candidateAnnDataBinding',
    'signal',
    'stagedSource',
  ]);
  const ownKeys = Reflect.ownKeys(options);
  const unexpected = ownKeys.filter(
    key => typeof key !== 'string' || !supported.has(key)
  );
  if (unexpected.length > 0) {
    throw new TypeError(
      `${label} options contain unexpected key(s): ` +
      unexpected.map(key => String(key)).join(', ')
    );
  }
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      throw new TypeError(
        `${label} options.${key} must be an enumerable own data field.`
      );
    }
  }
  const signalOptions = Object.hasOwn(options, 'signal')
    ? { signal: options.signal }
    : {};
  const signal = getMetadataLoadSignal(signalOptions, label);
  const candidateAnnDataBinding =
    Object.hasOwn(options, 'candidateAnnDataBinding')
      ? options.candidateAnnDataBinding
      : null;
  const stagedSource = Object.hasOwn(options, 'stagedSource')
    ? options.stagedSource
    : null;
  if (
    candidateAnnDataBinding !== null &&
    (
      typeof candidateAnnDataBinding !== 'object' ||
      stagedSource !== null
    )
  ) {
    throw new TypeError(
      `${label} requires at most one exact candidate AnnData binding or ` +
      'staged custom-protocol source.'
    );
  }
  if (
    stagedSource !== null &&
    typeof stagedSource !== 'object'
  ) {
    throw new TypeError(
      `${label} stagedSource must be an object or exact null.`
    );
  }
  return {
    candidateAnnDataBinding,
    signal,
    stagedSource,
  };
}

function requireStagedOwnerForUrl(
  url,
  candidateAnnDataBinding,
  stagedSource,
  label
) {
  if (shouldUseAnnData(url)) {
    if (stagedSource !== null) {
      throw new TypeError(
        `${label} direct AnnData URL cannot use a custom-protocol source.`
      );
    }
    return;
  }
  if (candidateAnnDataBinding !== null) {
    throw new TypeError(
      `${label} candidate AnnData binding requires an h5ad:// or zarr:// URL.`
    );
  }
  if (
    stagedSource !== null &&
    !getDataSourceManager().isCustomProtocolUrl(url)
  ) {
    throw new TypeError(
      `${label} staged source requires one custom-protocol URL.`
    );
  }
}

function requireGzipDecompressionStream(url) {
  const GzipDecompressionStream = globalThis.DecompressionStream;
  if (typeof GzipDecompressionStream !== 'function') {
    throw new Error(
      `Gzip payload ${url} requires browser DecompressionStream support`
    );
  }
  return GzipDecompressionStream;
}

/**
 * Convert ArrayBuffer to typed array based on dtype.
 * @param {ArrayBuffer} buffer - Raw binary data
 * @param {string} dtype - Exact prepared scalar dtype
 * @param {string} url - URL for error messages
 * @returns {TypedArray} Appropriate typed array
 */
function typedArrayFromBuffer(buffer, dtype, url) {
  switch (dtype) {
    case 'float64':
      return new Float64Array(buffer);
    case 'float32':
      return new Float32Array(buffer);
    case 'uint8':
      return new Uint8Array(buffer);
    case 'uint16':
      return new Uint16Array(buffer);
    case 'uint32':
      return new Uint32Array(buffer);
    default:
      throw new Error(`Unsupported dtype "${dtype}" for ${url}`);
  }
}

function validateCategoricalCodesDtype(dtype, fieldKey) {
  if (dtype !== 'uint8' && dtype !== 'uint16') {
    throw new Error(
      `Unsupported categorical codes dtype "${dtype}" for field "${fieldKey}"; ` +
      'expected "uint8" or "uint16". Reduce or merge categories before loading.'
    );
  }
  return dtype;
}

function validateCategoricalStorage({
  categories,
  dtype,
  missingValue,
  fieldKey,
}) {
  validateCategoricalCodesDtype(dtype, fieldKey);
  if (!Array.isArray(categories)) {
    throw new Error(
      `Invalid categorical field "${fieldKey}": categories must be an array`
    );
  }

  const seen = new Set();
  for (const category of categories) {
    const type = typeof category;
    if (
      category === null ||
      (type !== 'string' && type !== 'boolean' && type !== 'number') ||
      (type === 'number' && !Number.isFinite(category))
    ) {
      throw new Error(
        `Invalid categorical field "${fieldKey}": every category must be a finite JSON scalar`
      );
    }
    if (seen.has(category)) {
      throw new Error(
        `Invalid categorical field "${fieldKey}": categories must be unique`
      );
    }
    seen.add(category);
  }

  const expectedMissingValue = dtype === 'uint8' ? 255 : 65_535;
  const maxCategories = dtype === 'uint8' ? 255 : 65_535;
  if (missingValue !== expectedMissingValue) {
    throw new Error(
      `Invalid categorical field "${fieldKey}": ${dtype} codes require ` +
      `the exact missing sentinel ${expectedMissingValue}`
    );
  }
  if (categories.length > maxCategories) {
    throw new Error(
      `Invalid categorical field "${fieldKey}": ${dtype} has capacity for ` +
      `at most ${maxCategories} categories`
    );
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
  const dtype = quantized instanceof Uint8Array
    ? 'uint8'
    : quantized instanceof Uint16Array
      ? 'uint16'
      : null;
  validateQuantizationMetadata({
    dtype,
    bits,
    minValue,
    maxValue,
  }, 'Field quantization codec');
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
 * Adopt a prepared categorical-outlier payload into DataState's exact domain.
 *
 * Prepared files represent a scientifically unavailable quantile as NaN (or
 * the declared terminal integer marker before dequantization). DataState uses
 * exactly -1 for that same unavailable value so its hot visibility loop can
 * distinguish it from the valid [0, 1] quantile interval without non-finite
 * values. This is the sole wire-to-runtime representation boundary.
 *
 * @param {Float32Array} quantiles
 * @param {string} fieldKey
 * @returns {Float32Array}
 */
function adoptRuntimeOutlierQuantiles(quantiles, fieldKey) {
  if (!(quantiles instanceof Float32Array)) {
    throw new TypeError(
      `Outlier quantiles for "${fieldKey}" must decode to Float32Array.`
    );
  }
  for (let index = 0; index < quantiles.length; index++) {
    const quantile = quantiles[index];
    if (Number.isNaN(quantile)) {
      quantiles[index] = -1;
      continue;
    }
    if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) {
      throw new RangeError(
        `Outlier quantile ${index} for "${fieldKey}" must be -1 or a finite value from 0 through 1.`
      );
    }
  }
  return quantiles;
}

/**
 * @typedef {'uint8'|'uint16'} QuantizedDType
 */

/**
 * Dequantize quantized uint8/uint16 values with one preselected backend.
 *
 * @param {Object} options
 * @param {'main-thread'|'worker'} options.backend
 * @param {ArrayBuffer} options.buffer
 * @param {QuantizedDType} options.dtype
 * @param {number} options.minValue
 * @param {number} options.maxValue
 * @param {8|16} options.bits
 * @returns {Promise<Float32Array>}
 */
async function dequantizeToFloat32(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('dequantizeToFloat32: options must be an object');
  }
  const {
    backend,
    buffer,
    dtype,
    minValue,
    maxValue,
    bits,
  } = options;

  if (!(buffer instanceof ArrayBuffer)) {
    throw new Error('dequantizeToFloat32: missing ArrayBuffer');
  }
  validateQuantizationMetadata({
    dtype,
    bits,
    minValue,
    maxValue,
  }, 'Field quantization codec');

  if (backend === QUANTIZATION_BACKEND.WORKER) {
    return dequantizeToFloat32InWorker({
      buffer,
      dtype,
      minValue,
      maxValue,
      bits,
    });
  }
  if (backend !== QUANTIZATION_BACKEND.MAIN_THREAD) {
    throw new Error(
      `dequantizeToFloat32: unsupported backend ${String(backend)}`
    );
  }

  const raw = dtype === 'uint8' ? new Uint8Array(buffer) : new Uint16Array(buffer);
  return dequantize(raw, minValue, maxValue, bits);
}


/**
 * @param {string} url
 * @param {RequestInit} [init]
 */
async function fetchOk(url, init, stagedSource = null) {
  const signal = init?.signal ?? null;
  throwIfMetadataAborted(signal, 'URL resolution');
  const resolvedUrl = await resolveAnyUrl(
    url,
    signal,
    stagedSource
  );
  throwIfMetadataAborted(signal, 'URL resolution');
  const response = await fetchSampleArtifact(resolvedUrl, init);
  if (!response.ok) {
    const err = new Error('Failed to load ' + url + ': ' + response.statusText);
    err.status = response.status;
    throw err;
  }
  return response;
}

/**
 * Fetch binary data, automatically decompressing gzip if URL ends with .gz
 * Uses the browser DecompressionStream API.
 * Supports local-user:// protocol for user directories.
 *
 * @param {string} url - URL to fetch
 * @param {RequestInit} [init]
 * @returns {Promise<ArrayBuffer>} Decompressed binary data
 */
async function fetchBinary(url, init, stagedSource = null) {
  const isGzipped = url.endsWith('.gz');
  const GzipDecompressionStream = isGzipped
    ? requireGzipDecompressionStream(url)
    : null;
  const response = await fetchOk(url, init, stagedSource);

  if (isGzipped) {
    const decompressedStream = response.body.pipeThrough(
      new GzipDecompressionStream('gzip')
    );
    return new Response(decompressedStream).arrayBuffer();
  }

  return response.arrayBuffer();
}

/**
 * Load the one cell-position payload advertised by dataset metadata.
 * Compression is determined solely by the advertised filename.
 * Supports all custom protocols (local-user://, remote://, jupyter://) via DataSourceManager.
 *
 * @param {string} url - URL to fetch
 * @param {Object} options - Optional settings
 * @param {boolean} options.showProgress - Show progress notification (default: false)
 * @param {string} options.displayName - Display name for notification
 * @param {AbortSignal|null} options.signal - Optional cancellation signal
 * @param {string|null} options.progressTrackerId - Optional caller-owned tracker
 */
export async function loadPointsBinary(url, options = {}) {
  const {
    candidateAnnDataBinding = null,
    showProgress = false,
    displayName = null,
    dimension = 3,
    signal = null,
    progressTrackerId = null,
    stagedSource = null
  } = options;
  requireStagedOwnerForUrl(
    url,
    candidateAnnDataBinding,
    stagedSource,
    'Cell position loader'
  );
  const notifications = getNotificationCenter();
  const name = displayName || 'Cell positions';
  let trackerId = progressTrackerId;
  const ownsTracker = showProgress && !trackerId;

  if (ownsTracker) {
    trackerId = notifications.startDownload(name);
  }

  // Check if AnnData source (h5ad or zarr) is active - use direct loading
  if (shouldUseAnnData(url)) {
    try {
      throwIfAborted(signal);

      // Extract dimension from URL if not provided (e.g., points_3d.bin -> 3)
      let dim = dimension;
      const dimMatch = url.match(/points_(\d)d\.bin/);
      if (dimMatch) {
        dim = parseInt(dimMatch[1], 10);
      }

      // H5AD/Zarr adapters do not currently accept an AbortSignal. Race the
      // decoder with the caller's signal so dataset replacement can reject
      // promptly; the detached decoder is still observed by waitForAbort().
      const result = await waitForAbort(
        anndataLoadPoints(url, dim, candidateAnnDataBinding),
        signal
      );
      throwIfAborted(signal);
      if (ownsTracker) notifications.completeDownload(trackerId);
      return result;
    } catch (err) {
      finishOwnedTrackerWithError({
        error: err,
        notifications,
        signal,
        trackerId: ownsTracker ? trackerId : null
      });
      throw err;
    }
  }

  try {
    throwIfAborted(signal);

    const arrayBuffer = await fetchBinaryWithProgressInternal(
      url,
      trackerId,
      notifications,
      signal,
      stagedSource
    );
    throwIfAborted(signal);
    const positions = float32PositionsFromBuffer(arrayBuffer, url);
    if (ownsTracker) notifications.completeDownload(trackerId);
    return positions;
  } catch (error) {
    finishOwnedTrackerWithError({
      error,
      notifications,
      signal,
      trackerId: ownsTracker ? trackerId : null
    });
    throw error;
  }
}

function float32PositionsFromBuffer(arrayBuffer, url) {
  if (
    !(arrayBuffer instanceof ArrayBuffer) ||
    arrayBuffer.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0
  ) {
    throw new Error(
      `Invalid cell-position payload from ${url}: byte length must be a multiple of 4`
    );
  }
  return new Float32Array(arrayBuffer);
}

function createAbortError() {
  const error = new Error('Cell position loading was cancelled.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

/**
 * Observe a promise while allowing its consumer to stop waiting on abort.
 *
 * The underlying operation may not itself be cancellable. Both settlement
 * handlers remain attached so a late resolve/reject cannot become stale
 * application work or an unhandled rejection.
 *
 * @template T
 * @param {Promise<T>|T} promise
 * @param {AbortSignal|null} signal
 * @returns {Promise<T>}
 */
function waitForAbort(promise, signal) {
  if (!signal) {
    return Promise.resolve(promise);
  }
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(createAbortError());
    };

    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      value => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      }
    );
  });
}

function rethrowIfAborted(error, signal) {
  if (error?.name === 'AbortError' || signal?.aborted) {
    if (error?.name === 'AbortError') throw error;
    throw createAbortError();
  }
}

function finishOwnedTrackerWithError({
  error,
  notifications,
  signal,
  trackerId
}) {
  if (!trackerId) return;
  if (error?.name === 'AbortError' || signal?.aborted) {
    notifications.dismissDownload(trackerId);
  } else {
    notifications.failDownload(trackerId, error?.message || String(error));
  }
}

/**
 * Internal helper for progress-tracked binary fetch
 */
async function fetchBinaryWithProgressInternal(
  url,
  trackerId,
  notifications,
  signal = null,
  stagedSource = null
) {
  throwIfAborted(signal);
  const isGzipped = url.endsWith('.gz');
  const GzipDecompressionStream = isGzipped
    ? requireGzipDecompressionStream(url)
    : null;
  const resolvedUrl = await resolveAnyUrl(
    url,
    signal,
    stagedSource
  );
  throwIfAborted(signal);
  const response = await fetchSampleArtifact(
    resolvedUrl,
    signal ? { signal } : undefined
  );
  throwIfAborted(signal);

  if (!response.ok) {
    const err = new Error('Failed to load ' + url + ': ' + response.statusText);
    err.status = response.status;
    throw err;
  }

  const contentEncoding = response.headers.get('content-encoding');
  const contentLength = response.headers.get('content-length');
  const totalBytes = contentEncoding === null && contentLength !== null
    ? Number(contentLength)
    : null;
  if (
    totalBytes !== null &&
    (!Number.isSafeInteger(totalBytes) || totalBytes < 0)
  ) {
    throw new Error(
      `Invalid Content-Length for ${url}: ${contentLength}`
    );
  }

  if (trackerId && response.body) {
    const reader = response.body.getReader();
    let loadedBytes = 0;

    // Stream into a new ReadableStream so we can:
    // - track progress without buffering all chunks twice
    // - stream gzip decompression through the selected browser backend
    const monitoredStream = new ReadableStream({
      async pull(controller) {
        throwIfAborted(signal);
        const { done, value } = await reader.read();
        throwIfAborted(signal);
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
          reader.cancel(createAbortError());
        } catch (_err) {
          // Ignore cancel errors
        }
      }
    });

    if (isGzipped) {
      const decompressedStream = monitoredStream.pipeThrough(
        new GzipDecompressionStream('gzip')
      );
      return new Response(decompressedStream).arrayBuffer();
    }

    return new Response(monitoredStream).arrayBuffer();
  }

  if (isGzipped) {
    const decompressedStream = response.body.pipeThrough(
      new GzipDecompressionStream('gzip')
    );
    return new Response(decompressedStream).arrayBuffer();
  }

  return response.arrayBuffer();
}

/**
 * Convert filename to safe version (must match Python _safe_filename_component)
 */
function safeFilenameComponent(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('Compact manifest field keys must be non-empty strings');
  }
  let safe = name.replace(/[^A-Za-z0-9._-]+/g, '_');
  safe = safe.replace(/^[._]+|[._]+$/g, '');
  if (safe.length === 0) {
    throw new Error(
      `Compact manifest field key "${name}" has no valid filename characters`
    );
  }
  return safe;
}

function isRecord(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  );
}

function requireRecord(value, label) {
  if (!isRecord(value)) {
    throw new Error(`Invalid compact_v1 ${label}: expected an object`);
  }
}

function requireExactKeys(value, expectedKeys, label) {
  requireRecord(value, label);
  const actualKeys = Object.keys(value);
  const expected = new Set(expectedKeys);
  const missing = expectedKeys.filter(key => !Object.hasOwn(value, key));
  const extra = actualKeys.filter(key => !expected.has(key));
  if (missing.length > 0 || extra.length > 0) {
    const details = [];
    if (missing.length > 0) {
      details.push(`missing ${missing.join(', ')}`);
    }
    if (extra.length > 0) {
      details.push(`unexpected ${extra.join(', ')}`);
    }
    throw new Error(
      `Invalid compact_v1 ${label} properties: ${details.join('; ')}`
    );
  }
}

function requirePositivePointCount(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `Invalid compact_v1 ${label}: n_points must be a positive safe integer`
    );
  }
}

function requireCompression(value, label) {
  if (
    value !== null &&
    (!Number.isInteger(value) || value < 1 || value > 9)
  ) {
    throw new Error(
      `Invalid compact_v1 ${label}: compression must be null or an integer from 1 to 9`
    );
  }
}

function requireRelativePayloadPath(path, label) {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('%') ||
    path.includes('?') ||
    path.includes('#') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)
  ) {
    throw new Error(
      `Invalid compact_v1 ${label}: payload path must be a relative POSIX path`
    );
  }
  const components = path.split('/');
  if (
    components.some(
      component =>
        component.length === 0 ||
        component === '.' ||
        component === '..'
    )
  ) {
    throw new Error(
      `Invalid compact_v1 ${label}: payload path contains an invalid component`
    );
  }
}

function validatePathTemplate({
  template,
  placeholders,
  requiredTail,
  compression,
  label,
}) {
  if (typeof template !== 'string' || template.length === 0) {
    throw new Error(
      `Invalid compact_v1 ${label}: path template must be a non-empty string`
    );
  }

  const tokens = template.match(/\{[^{}]*\}/g) ?? [];
  if (
    tokens.length !== placeholders.length ||
    placeholders.some(
      placeholder =>
        tokens.filter(token => token === `{${placeholder}}`).length !== 1
    ) ||
    tokens.some(token => !placeholders.includes(token.slice(1, -1))) ||
    template.replace(/\{[^{}]*\}/g, '').includes('{') ||
    template.replace(/\{[^{}]*\}/g, '').includes('}')
  ) {
    throw new Error(
      `Invalid compact_v1 ${label}: expected exactly the placeholders ` +
      placeholders.map(value => `{${value}}`).join(', ')
    );
  }

  const gzipSuffix = compression === null ? '' : '.gz';
  if (!template.endsWith(`${requiredTail}${gzipSuffix}`)) {
    throw new Error(
      `Invalid compact_v1 ${label}: path must end with ` +
      `"${requiredTail}${gzipSuffix}" and match compression metadata`
    );
  }

  let concrete = template;
  for (const placeholder of placeholders) {
    concrete = concrete.replace(
      `{${placeholder}}`,
      placeholder === 'key' ? 'FIELD' : 'u8'
    );
  }
  requireRelativePayloadPath(concrete, label);
}

function validateContinuousSchema(schema, {
  compression,
  label,
  includeKind,
}) {
  requireRecord(schema, label);
  if (typeof schema.quantized !== 'boolean') {
    throw new Error(
      `Invalid compact_v1 ${label}: quantized must be a boolean`
    );
  }

  const baseKeys = includeKind
    ? ['kind', 'pathPattern', 'ext', 'dtype', 'quantized']
    : ['pathPattern', 'ext', 'dtype', 'quantized'];
  const expectedKeys = schema.quantized
    ? [...baseKeys, 'quantizationBits']
    : baseKeys;
  requireExactKeys(schema, expectedKeys, label);
  if (includeKind && schema.kind !== 'continuous') {
    throw new Error(
      `Invalid compact_v1 ${label}: kind must be "continuous"`
    );
  }

  if (schema.quantized) {
    const expected = schema.quantizationBits === 8
      ? { dtype: 'uint8', ext: 'u8' }
      : schema.quantizationBits === 16
        ? { dtype: 'uint16', ext: 'u16' }
        : null;
    if (
      expected === null ||
      schema.dtype !== expected.dtype ||
      schema.ext !== expected.ext
    ) {
      throw new Error(
        `Invalid compact_v1 ${label}: quantizationBits, dtype, and ext ` +
        'must be exactly 8/uint8/u8 or 16/uint16/u16'
      );
    }
  } else if (schema.dtype !== 'float32' || schema.ext !== 'f32') {
    throw new Error(
      `Invalid compact_v1 ${label}: an unquantized schema must use float32/f32`
    );
  }

  validatePathTemplate({
    template: schema.pathPattern,
    placeholders: ['key'],
    requiredTail: `{key}.values.${schema.ext}`,
    compression,
    label: `${label} pathPattern`,
  });
}

function validateCategoricalSchema(schema, compression) {
  const label = 'obs categorical schema';
  requireExactKeys(schema, [
    'codesPathPattern',
    'outlierPathPattern',
    'outlierExt',
    'outlierDtype',
    'outlierQuantized',
  ], label);
  if (typeof schema.outlierQuantized !== 'boolean') {
    throw new Error(
      `Invalid compact_v1 ${label}: outlierQuantized must be a boolean`
    );
  }

  const outlierPayloadMembers = [
    schema.outlierPathPattern,
    schema.outlierExt,
    schema.outlierDtype,
  ];
  const hasNoOutlierPayload = outlierPayloadMembers.every(
    value => value === null
  );
  const hasPartialOutlierPayload = outlierPayloadMembers.some(
    value => value === null
  );
  if (hasPartialOutlierPayload && !hasNoOutlierPayload) {
    throw new Error(
      `Invalid compact_v1 ${label}: outlier path, ext, and dtype must be ` +
      'all present or all null'
    );
  }
  if (hasNoOutlierPayload && schema.outlierQuantized !== false) {
    throw new Error(
      `Invalid compact_v1 ${label}: absent outlier data requires ` +
      'outlierQuantized false'
    );
  }

  validatePathTemplate({
    template: schema.codesPathPattern,
    placeholders: ['key', 'ext'],
    requiredTail: '{key}.codes.{ext}',
    compression,
    label: `${label} codesPathPattern`,
  });
  if (hasNoOutlierPayload) {
    return;
  }

  if (schema.outlierQuantized) {
    const validPair =
      (schema.outlierDtype === 'uint8' && schema.outlierExt === 'u8') ||
      (schema.outlierDtype === 'uint16' && schema.outlierExt === 'u16');
    if (!validPair) {
      throw new Error(
        `Invalid compact_v1 ${label}: quantized outliers must use ` +
        'uint8/u8 or uint16/u16'
      );
    }
  } else if (
    schema.outlierDtype !== 'float32' ||
    schema.outlierExt !== 'f32'
  ) {
    throw new Error(
      `Invalid compact_v1 ${label}: unquantized outliers must use float32/f32`
    );
  }

  validatePathTemplate({
    template: schema.outlierPathPattern,
    placeholders: ['key'],
    requiredTail: `{key}.outliers.${schema.outlierExt}`,
    compression,
    label: `${label} outlierPathPattern`,
  });
}

function validateFieldKey(key, {
  rawKeys,
  safeKeys,
  label,
}) {
  const safeKey = safeFilenameComponent(key);
  if (rawKeys.has(key)) {
    throw new Error(
      `Invalid compact_v1 ${label}: field key "${key}" is duplicated`
    );
  }
  const collidingKey = safeKeys.get(safeKey);
  if (collidingKey !== undefined) {
    throw new Error(
      `Invalid compact_v1 ${label}: field keys "${collidingKey}" and ` +
      `"${key}" collide at payload path component "${safeKey}"`
    );
  }
  rawKeys.add(key);
  safeKeys.set(safeKey, key);
  return safeKey;
}

function requireQuantizedBounds(minValue, maxValue, label) {
  if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
    throw new Error(
      `Invalid compact_v1 ${label}: quantization bounds must be finite`
    );
  }
  if (!(minValue < maxValue)) {
    throw new Error(
      `Invalid compact_v1 ${label}: minValue must be less than maxValue`
    );
  }
}

function validateCentroids(centroidsByDim, categories, nPoints, fieldKey) {
  requireRecord(
    centroidsByDim,
    `categorical field "${fieldKey}" centroids`
  );
  const categorySet = new Set(categories);
  for (const [dimensionKey, centroids] of Object.entries(centroidsByDim)) {
    if (!/^[123]$/.test(dimensionKey)) {
      throw new Error(
        `Invalid compact_v1 categorical field "${fieldKey}" centroid ` +
        `dimension "${dimensionKey}": expected 1, 2, or 3`
      );
    }
    if (!Array.isArray(centroids)) {
      throw new Error(
        `Invalid compact_v1 categorical field "${fieldKey}" centroids for ` +
        `${dimensionKey}D: expected an array`
      );
    }
    const dimension = Number(dimensionKey);
    const seenCategories = new Set();
    for (const centroid of centroids) {
      requireExactKeys(
        centroid,
        ['category', 'position', 'n_points'],
        `categorical field "${fieldKey}" centroid`
      );
      if (
        !categorySet.has(centroid.category) ||
        seenCategories.has(centroid.category)
      ) {
        throw new Error(
          `Invalid compact_v1 categorical field "${fieldKey}" centroid ` +
          'category must reference one unique declared category'
        );
      }
      seenCategories.add(centroid.category);
      if (
        !Array.isArray(centroid.position) ||
        centroid.position.length !== dimension ||
        centroid.position.some(value => !Number.isFinite(value))
      ) {
        throw new Error(
          `Invalid compact_v1 categorical field "${fieldKey}" centroid ` +
          `position must contain exactly ${dimension} finite values`
        );
      }
      if (
        !Number.isSafeInteger(centroid.n_points) ||
        centroid.n_points < 0 ||
        centroid.n_points > nPoints
      ) {
        throw new Error(
          `Invalid compact_v1 categorical field "${fieldKey}" centroid ` +
          'n_points must be a non-negative safe integer no greater than n_points'
        );
      }
    }
  }
}

function validateObsManifestHeader(manifest) {
  requireExactKeys(manifest, [
    '_format',
    'n_points',
    'centroid_outlier_quantile',
    'latent_key',
    'compression',
    '_obsSchemas',
    '_continuousFields',
    '_categoricalFields',
  ], 'obs manifest');
  if (manifest._format !== 'compact_v1') {
    throw new Error(
      'Invalid obs manifest: expected the current compact_v1 contract'
    );
  }
  requirePositivePointCount(manifest.n_points, 'obs manifest');
  requireCompression(manifest.compression, 'obs manifest');
  if (
    manifest.centroid_outlier_quantile !== null &&
    (
      !Number.isFinite(manifest.centroid_outlier_quantile) ||
      manifest.centroid_outlier_quantile <= 0 ||
      manifest.centroid_outlier_quantile >= 1
    )
  ) {
    throw new Error(
      'Invalid compact_v1 obs manifest: centroid_outlier_quantile must be null or a finite number between 0 and 1'
    );
  }
  if (
    manifest.latent_key !== null &&
    (
      typeof manifest.latent_key !== 'string' ||
      manifest.latent_key.length === 0
    )
  ) {
    throw new Error(
      'Invalid compact_v1 obs manifest: latent_key must be null or a non-empty string'
    );
  }
  requireRecord(manifest._obsSchemas, 'obs schemas');
  if (!Array.isArray(manifest._continuousFields)) {
    throw new Error(
      'Invalid compact_v1 obs manifest: _continuousFields must be an array'
    );
  }
  if (!Array.isArray(manifest._categoricalFields)) {
    throw new Error(
      'Invalid compact_v1 obs manifest: _categoricalFields must be an array'
    );
  }

  const expectedSchemaKeys = [];
  if (manifest._continuousFields.length > 0) {
    expectedSchemaKeys.push('continuous');
  }
  if (manifest._categoricalFields.length > 0) {
    expectedSchemaKeys.push('categorical');
  }
  requireExactKeys(
    manifest._obsSchemas,
    expectedSchemaKeys,
    'obs schemas'
  );
}

function validateVarManifestHeader(manifest) {
  requireExactKeys(manifest, [
    '_format',
    'n_points',
    'var_gene_id_column',
    'compression',
    'quantization',
    '_varSchema',
    'fields',
  ], 'var manifest');
  if (manifest._format !== 'compact_v1') {
    throw new Error(
      'Invalid var manifest: expected the current compact_v1 contract'
    );
  }
  requirePositivePointCount(manifest.n_points, 'var manifest');
  requireCompression(manifest.compression, 'var manifest');
  if (
    manifest.var_gene_id_column !== null &&
    (
      typeof manifest.var_gene_id_column !== 'string' ||
      manifest.var_gene_id_column.length === 0
    )
  ) {
    throw new Error(
      'Invalid compact_v1 var manifest: var_gene_id_column must be null or a non-empty string'
    );
  }
  if (
    manifest.quantization !== null &&
    manifest.quantization !== 8 &&
    manifest.quantization !== 16
  ) {
    throw new Error(
      'Invalid compact_v1 var manifest: quantization must be null, 8, or 16'
    );
  }
  if (!Array.isArray(manifest.fields)) {
    throw new Error(
      'Invalid compact_v1 var manifest: fields must be an array'
    );
  }
}

/**
 * Expand the sole current compact var manifest into the runtime field shape.
 * Compact format uses _varSchema + field tuples [key, minValue, maxValue].
 * @param {Object} manifest - Raw manifest (possibly compact)
 * @returns {Object} Expanded manifest with fields array
 */
export function expandVarManifest(manifest) {
  validateVarManifestHeader(manifest);
  const schema = manifest._varSchema;
  validateContinuousSchema(schema, {
    compression: manifest.compression,
    label: 'var schema',
    includeKind: true,
  });
  const expectedQuantization = schema.quantized
    ? schema.quantizationBits
    : null;
  if (manifest.quantization !== expectedQuantization) {
    throw new Error(
      'Invalid compact_v1 var manifest: quantization must exactly match the var schema'
    );
  }

  const fields = [];
  const rawKeys = new Set();
  const safeKeys = new Map();
  for (const fieldTuple of manifest.fields) {
    if (
      !Array.isArray(fieldTuple) ||
      fieldTuple.length !== (schema.quantized ? 3 : 1)
    ) {
      throw new Error(
        `Invalid compact_v1 var field tuple: expected exactly ` +
        (schema.quantized ? '[key, minValue, maxValue]' : '[key]')
      );
    }
    const key = fieldTuple[0];
    const safeKey = validateFieldKey(key, {
      rawKeys,
      safeKeys,
      label: 'var manifest',
    });

    const field = {
      key,
      kind: schema.kind,
      valuesPath: schema.pathPattern.replace('{key}', safeKey),
      valuesDtype: schema.dtype,
      quantized: schema.quantized,
    };

    if (schema.quantized) {
      requireQuantizedBounds(
        fieldTuple[1],
        fieldTuple[2],
        `var field "${key}"`
      );
      field.quantizationBits = schema.quantizationBits;
      field.minValue = fieldTuple[1];
      field.maxValue = fieldTuple[2];
    }

    fields.push(field);
  }

  return {
    n_points: manifest.n_points,
    var_gene_id_column: manifest.var_gene_id_column,
    compression: manifest.compression,
    quantization: manifest.quantization,
    fields,
  };
}

/**
 * Expand the sole current compact obs manifest into the runtime field shape.
 * Compact format uses _obsSchemas + _continuousFields + _categoricalFields.
 * @param {Object} manifest - Raw manifest (possibly compact)
 * @returns {Object} Expanded manifest with fields array
 */
export function expandObsManifest(manifest) {
  validateObsManifestHeader(manifest);
  const schemas = manifest._obsSchemas;
  const fields = [];
  const rawKeys = new Set();
  const safeKeys = new Map();

  if (manifest._continuousFields.length > 0) {
    const contSchema = schemas.continuous;
    validateContinuousSchema(contSchema, {
      compression: manifest.compression,
      label: 'obs continuous schema',
      includeKind: false,
    });
    for (const fieldTuple of manifest._continuousFields) {
      if (
        !Array.isArray(fieldTuple) ||
        fieldTuple.length !== (contSchema.quantized ? 3 : 1)
      ) {
        throw new Error(
          `Invalid compact_v1 continuous field tuple: expected exactly ` +
          (contSchema.quantized
            ? '[key, minValue, maxValue]'
            : '[key]')
        );
      }
      const key = fieldTuple[0];
      const safeKey = validateFieldKey(key, {
        rawKeys,
        safeKeys,
        label: 'obs manifest',
      });

      const field = {
        key,
        kind: 'continuous',
        valuesPath: contSchema.pathPattern.replace('{key}', safeKey),
        valuesDtype: contSchema.dtype,
        quantized: contSchema.quantized,
        centroids: null,
        outlierQuantilesPath: null,
      };

      if (contSchema.quantized) {
        requireQuantizedBounds(
          fieldTuple[1],
          fieldTuple[2],
          `continuous field "${key}"`
        );
        field.quantizationBits = contSchema.quantizationBits;
        field.minValue = fieldTuple[1];
        field.maxValue = fieldTuple[2];
      }

      fields.push(field);
    }
  }

  if (manifest._categoricalFields.length > 0) {
    const catSchema = schemas.categorical;
    validateCategoricalSchema(catSchema, manifest.compression);
    for (const fieldTuple of manifest._categoricalFields) {
      if (
        !Array.isArray(fieldTuple) ||
        fieldTuple.length !== (catSchema.outlierQuantized ? 7 : 5)
      ) {
        throw new Error(
          `Invalid compact_v1 categorical field tuple: expected exactly ` +
          (catSchema.outlierQuantized
            ? '[key, categories, codesDtype, codesMissingValue, centroidsByDim, outlierMinValue, outlierMaxValue]'
            : '[key, categories, codesDtype, codesMissingValue, centroidsByDim]')
        );
      }
      const key = fieldTuple[0];
      const safeKey = validateFieldKey(key, {
        rawKeys,
        safeKeys,
        label: 'obs manifest',
      });
      const categories = fieldTuple[1];
      const codesDtype = fieldTuple[2];
      const codesMissingValue = fieldTuple[3];
      const centroidsData = fieldTuple[4];
      validateCategoricalStorage({
        categories,
        dtype: codesDtype,
        missingValue: codesMissingValue,
        fieldKey: key,
      });
      validateCentroids(
        centroidsData,
        categories,
        manifest.n_points,
        key
      );

      const codesExt = codesDtype === 'uint8' ? 'u8' : 'u16';

      const field = {
        key,
        kind: 'category',
        categories,
        codesPath: catSchema.codesPathPattern.replace('{key}', safeKey).replace('{ext}', codesExt),
        codesDtype,
        codesMissingValue,
        outlierQuantilesPath: catSchema.outlierPathPattern === null
          ? null
          : catSchema.outlierPathPattern.replace('{key}', safeKey),
        outlierDtype: catSchema.outlierDtype,
        outlierQuantized: catSchema.outlierQuantized,
        centroidsByDim: centroidsData,
      };

      if (catSchema.outlierQuantized) {
        requireQuantizedBounds(
          fieldTuple[5],
          fieldTuple[6],
          `categorical field "${key}" outliers`
        );
        field.outlierMinValue = fieldTuple[5];
        field.outlierMaxValue = fieldTuple[6];
      }

      fields.push(field);
    }
  }

  return {
    n_points: manifest.n_points,
    centroid_outlier_quantile: manifest.centroid_outlier_quantile,
    latent_key: manifest.latent_key,
    compression: manifest.compression,
    fields,
  };
}

function validateExpandedContinuousField(
  field,
  label,
  { observationField = false } = {}
) {
  const expectedKeys = [
    'key',
    'kind',
    'valuesPath',
    'valuesDtype',
    'quantized',
    ...(observationField
      ? ['centroids', 'outlierQuantilesPath']
      : []),
    ...(field?.quantized
      ? ['quantizationBits', 'minValue', 'maxValue']
      : []),
  ];
  requireExactKeys(field, expectedKeys, label);
  if (
    typeof field.key !== 'string' ||
    field.key.length === 0 ||
    field.kind !== 'continuous' ||
    typeof field.valuesPath !== 'string' ||
    field.valuesPath.length === 0 ||
    typeof field.quantized !== 'boolean'
  ) {
    throw new Error(
      `Invalid ${label}: expected an exact continuous field definition`
    );
  }
  if (
    observationField &&
    (field.centroids !== null || field.outlierQuantilesPath !== null)
  ) {
    throw new Error(
      `Invalid ${label}: continuous fields require null categorical metadata`
    );
  }
  requireRelativePayloadPath(field.valuesPath, `${label} valuesPath`);

  if (field.quantized) {
    validateQuantizationMetadata({
      dtype: field.valuesDtype,
      bits: field.quantizationBits,
      minValue: field.minValue,
      maxValue: field.maxValue,
    }, `${label} quantization codec`);
  } else {
    if (field.valuesDtype !== 'float32') {
      throw new Error(
        `Invalid ${label}: unquantized values must use float32`
      );
    }
    if (
      Object.hasOwn(field, 'quantizationBits') ||
      Object.hasOwn(field, 'minValue') ||
      Object.hasOwn(field, 'maxValue')
    ) {
      throw new Error(
        `Invalid ${label}: unquantized values cannot declare quantization metadata`
      );
    }
  }
}

function validateExpandedCategoricalField(field, label) {
  requireExactKeys(field, [
    'key',
    'kind',
    'categories',
    'codesPath',
    'codesDtype',
    'codesMissingValue',
    'outlierQuantilesPath',
    'outlierDtype',
    'outlierQuantized',
    'centroidsByDim',
    ...(field?.outlierQuantized
      ? ['outlierMinValue', 'outlierMaxValue']
      : []),
  ], label);
  if (
    typeof field.key !== 'string' ||
    field.key.length === 0 ||
    field.kind !== 'category' ||
    typeof field.codesPath !== 'string' ||
    field.codesPath.length === 0 ||
    typeof field.outlierQuantized !== 'boolean'
  ) {
    throw new Error(
      `Invalid ${label}: expected an exact categorical field definition`
    );
  }
  requireRelativePayloadPath(field.codesPath, `${label} codesPath`);
  validateCategoricalStorage({
    categories: field.categories,
    dtype: field.codesDtype,
    missingValue: field.codesMissingValue,
    fieldKey: field.key,
  });
  requireRecord(field.centroidsByDim, `${label} centroidsByDim`);

  const hasNoOutlierPayload =
    field.outlierQuantilesPath === null &&
    field.outlierDtype === null;
  if (hasNoOutlierPayload) {
    if (
      field.outlierQuantized !== false ||
      Object.hasOwn(field, 'outlierMinValue') ||
      Object.hasOwn(field, 'outlierMaxValue')
    ) {
      throw new Error(
        `Invalid ${label}: absent outlier data requires an exact all-null unquantized state`
      );
    }
    return;
  }
  if (
    typeof field.outlierQuantilesPath !== 'string' ||
    field.outlierQuantilesPath.length === 0 ||
    field.outlierDtype === null
  ) {
    throw new Error(
      `Invalid ${label}: outlier path and dtype must be both present or both null`
    );
  }
  requireRelativePayloadPath(
    field.outlierQuantilesPath,
    `${label} outlierQuantilesPath`
  );

  if (field.outlierQuantized) {
    const bits = field.outlierDtype === 'uint8'
      ? 8
      : field.outlierDtype === 'uint16'
        ? 16
        : null;
    validateQuantizationMetadata({
      dtype: field.outlierDtype,
      bits,
      minValue: field.outlierMinValue,
      maxValue: field.outlierMaxValue,
    }, `${label} outlier quantization codec`);
  } else {
    if (field.outlierDtype !== 'float32') {
      throw new Error(
        `Invalid ${label}: unquantized outliers must use float32`
      );
    }
    if (
      Object.hasOwn(field, 'outlierMinValue') ||
      Object.hasOwn(field, 'outlierMaxValue')
    ) {
      throw new Error(
        `Invalid ${label}: unquantized outliers cannot declare quantization bounds`
      );
    }
  }
}

function validateCategoricalCodeValues({
  codes,
  categories,
  missingValue,
  fieldKey,
}) {
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index];
    if (code !== missingValue && code >= categories.length) {
      throw new Error(
        `Invalid categorical payload for field "${fieldKey}": code ${code} ` +
        `at index ${index} exceeds ${categories.length} declared categories`
      );
    }
  }
}

/**
 * @param {string} url
 * @param {{signal?: AbortSignal|null}} [options]
 */
export async function loadObsManifest(url, options = {}) {
  const {
    candidateAnnDataBinding,
    signal,
    stagedSource,
  } = getStagedMetadataLoadOwner(
    options,
    'Observation manifest loader'
  );
  requireStagedOwnerForUrl(
    url,
    candidateAnnDataBinding,
    stagedSource,
    'Observation manifest loader'
  );
  throwIfMetadataAborted(signal, 'Observation manifest loading');
  const fetchInit = signal ? { signal } : undefined;

  // Handle AnnData source (h5ad or zarr) - unified handling
  if (shouldUseAnnData(url)) {
    const manifest = anndataGetObsManifest(
      url,
      { signal },
      candidateAnnDataBinding
    );
    throwIfMetadataAborted(signal, 'Observation manifest loading');
    return expandObsManifest(manifest);
  }

  // Handle local-user:// URLs
  if (isLocalUserUrl(url)) {
    const manifest = await fetchJsonWithProtocol(
      url,
      fetchInit,
      stagedSource
    );
    throwIfMetadataAborted(signal, 'Observation manifest loading');
    return expandObsManifest(manifest);
  }

  const response = await fetchOk(url, fetchInit, stagedSource);
  const manifest = await response.json();
  throwIfMetadataAborted(signal, 'Observation manifest loading');
  return expandObsManifest(manifest);
}

/**
 * Load obs field data with automatic dequantization for quantized fields.
 * Handles gzip-compressed files automatically.
 * 
 * @param {string} manifestUrl - Base URL for resolving paths
 * @param {object} field - Field metadata from manifest
 * @returns {object} Loaded data with declared values, codes, or outlier quantiles
 */
export async function loadObsFieldData(manifestUrl, field, options = {}) {
  if (!field) throw new Error('No field metadata provided for obs field fetch.');

  const {
    fetchInit,
    signal = fetchInit?.signal ?? null
  } = options;
  throwIfAborted(signal);
  const hasValues = Object.hasOwn(field, 'valuesPath');
  const hasCodes = Object.hasOwn(field, 'codesPath');
  if (hasValues === hasCodes) {
    throw new Error(
      'Invalid obs field: expected exactly one continuous or categorical payload'
    );
  }
  if (hasValues) {
    validateExpandedContinuousField(
      field,
      `obs field "${field.key}"`,
      { observationField: true }
    );
  } else {
    validateExpandedCategoricalField(field, `obs field "${field.key}"`);
  }

  // Handle AnnData source (h5ad or zarr) - unified handling
  if (shouldUseAnnData(manifestUrl)) {
    const anndataData = await anndataLoadObsField(
      manifestUrl,
      field.key
    );
    throwIfAborted(signal);
    const outputs = { loaded: true };

    if (hasValues && anndataData.kind === 'continuous') {
      if (!(anndataData.data instanceof ArrayBuffer)) {
        throw new Error(
          `Invalid direct AnnData continuous payload for field "${field.key}"`
        );
      }
      outputs.values = new Float32Array(anndataData.data);
    } else if (hasCodes && anndataData.kind === 'category') {
      const codesDtype = validateCategoricalCodesDtype(
        anndataData.dtype,
        field.key
      );
      validateCategoricalStorage({
        categories: anndataData.categories,
        dtype: codesDtype,
        missingValue: anndataData.missingValue,
        fieldKey: field.key,
      });
      if (
        codesDtype !== field.codesDtype ||
        anndataData.missingValue !== field.codesMissingValue ||
        anndataData.categories.length !== field.categories.length ||
        anndataData.categories.some(
          (category, index) => category !== field.categories[index]
        )
      ) {
        throw new Error(
          `Invalid direct AnnData categorical payload for field "${field.key}": ` +
          'payload metadata must exactly match the adopted manifest'
        );
      }
      if (!(anndataData.data instanceof ArrayBuffer)) {
        throw new Error(
          `Invalid direct AnnData categorical payload for field "${field.key}"`
        );
      }
      const TypedArrayClass =
        codesDtype === 'uint8' ? Uint8Array : Uint16Array;
      const raw = new TypedArrayClass(anndataData.data);
      validateCategoricalCodeValues({
        codes: raw,
        categories: anndataData.categories,
        missingValue: anndataData.missingValue,
        fieldKey: field.key,
      });

      // Convert uint8 to uint16 for consistency
      if (codesDtype === 'uint8') {
        const u16 = new Uint16Array(raw.length);
        const missingU8 = anndataData.missingValue;
        const missingU16 = 65_535;
        for (let i = 0; i < raw.length; i++) {
          u16[i] = raw[i] === missingU8 ? missingU16 : raw[i];
        }
        outputs.codes = u16;
      } else {
        outputs.codes = raw;
      }
    } else {
      throw new Error(
        `Invalid direct AnnData field "${field.key}": payload kind must match the adopted manifest`
      );
    }

    return outputs;
  }

  // Note: Notifications are handled by the caller (state.js) to avoid duplicates
  const outputs = { loaded: true };

  // Load continuous values
  if (hasValues) {
    const url = resolveUrl(manifestUrl, field.valuesPath);
    const quantizationBackend = field.quantized
      ? await selectQuantizationBackend()
      : null;
    const buffer = await fetchBinary(url, fetchInit);
    const dtype = field.valuesDtype;

    if (field.quantized) {
      outputs.values = await dequantizeToFloat32({
        backend: quantizationBackend,
        buffer,
        dtype,
        minValue: field.minValue,
        maxValue: field.maxValue,
        bits: field.quantizationBits,
      });
    } else {
      // Non-quantized or already float32
      outputs.values = typedArrayFromBuffer(buffer, dtype, url);
    }
  }

  // Load categorical codes
  if (hasCodes) {
    const url = resolveUrl(manifestUrl, field.codesPath);
    const buffer = await fetchBinary(url, fetchInit);
    const dtype = validateCategoricalCodesDtype(
      field.codesDtype,
      field.key
    );
    const raw = typedArrayFromBuffer(buffer, dtype, url);
    validateCategoricalCodeValues({
      codes: raw,
      categories: field.categories,
      missingValue: field.codesMissingValue,
      fieldKey: field.key,
    });

    // If uint8 codes, convert to uint16 for consistency with rest of app
    if (dtype === 'uint8') {
      const u16 = new Uint16Array(raw.length);
      const missingU8 = field.codesMissingValue;
      const missingU16 = 65_535;
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
    const quantizationBackend = field.outlierQuantized
      ? await selectQuantizationBackend()
      : null;
    const buffer = await fetchBinary(url, fetchInit);
    const dtype = field.outlierDtype;

    let decodedOutlierQuantiles;
    if (field.outlierQuantized) {
      const bits = dtype === 'uint8' ? 8 : 16;
      decodedOutlierQuantiles = await dequantizeToFloat32({
        backend: quantizationBackend,
        buffer,
        dtype,
        minValue: field.outlierMinValue,
        maxValue: field.outlierMaxValue,
        bits,
      });
    } else {
      decodedOutlierQuantiles = typedArrayFromBuffer(buffer, dtype, url);
    }
    outputs.outlierQuantiles = adoptRuntimeOutlierQuantiles(
      decodedOutlierQuantiles,
      field.key
    );
  }

  return outputs;
}

// Var/gene expression manifest loader
/**
 * @param {string} url
 * @param {{signal?: AbortSignal|null}} [options]
 */
export async function loadVarManifest(url, options = {}) {
  const {
    candidateAnnDataBinding,
    signal,
    stagedSource,
  } = getStagedMetadataLoadOwner(
    options,
    'Variable manifest loader'
  );
  requireStagedOwnerForUrl(
    url,
    candidateAnnDataBinding,
    stagedSource,
    'Variable manifest loader'
  );
  throwIfMetadataAborted(signal, 'Variable manifest loading');
  const fetchInit = signal ? { signal } : undefined;

  // Handle AnnData source (h5ad or zarr) - unified handling
  if (shouldUseAnnData(url)) {
    const manifest = anndataGetVarManifest(
      url,
      { signal },
      candidateAnnDataBinding
    );
    throwIfMetadataAborted(signal, 'Variable manifest loading');
    return expandVarManifest(manifest);
  }

  // Handle local-user:// URLs
  if (isLocalUserUrl(url)) {
    const manifest = await fetchJsonWithProtocol(
      url,
      fetchInit,
      stagedSource
    );
    throwIfMetadataAborted(signal, 'Variable manifest loading');
    return expandVarManifest(manifest);
  }

  const response = await fetchOk(url, fetchInit, stagedSource);
  const manifest = await response.json();
  throwIfMetadataAborted(signal, 'Variable manifest loading');
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

  const {
    fetchInit,
    signal = fetchInit?.signal ?? null
  } = options || {};
  throwIfAborted(signal);

  // Handle AnnData source (h5ad or zarr) - unified handling
  if (shouldUseAnnData(manifestUrl)) {
    const values = await anndataLoadGeneExpression(
      manifestUrl,
      field.key
    );
    throwIfAborted(signal);
    return { loaded: true, values };
  }

  validateExpandedContinuousField(field, `var field "${field.key}"`);

  // Note: Notifications are handled by the caller (state.js) to avoid duplicates
  const outputs = { loaded: true };

  const url = resolveUrl(manifestUrl, field.valuesPath);
  const quantizationBackend = field.quantized
    ? await selectQuantizationBackend()
    : null;
  const buffer = await fetchBinary(url, fetchInit);
  const dtype = field.valuesDtype;

  if (field.quantized) {
    outputs.values = await dequantizeToFloat32({
      backend: quantizationBackend,
      buffer,
      dtype,
      minValue: field.minValue,
      maxValue: field.maxValue,
      bits: field.quantizationBits,
    });
  } else {
    outputs.values = typedArrayFromBuffer(buffer, dtype, url);
  }

  return outputs;
}

/**
 * @typedef {{
 *   fetchInit?: RequestInit,
 *   signal?: AbortSignal|null
 * }} FieldLoaderOptions
 */

function mergeFieldLoaderOptions(baseOptions, runtimeOptions) {
  const runtimeSignal = runtimeOptions?.signal ?? null;
  if (
    runtimeSignal !== null
    && !(runtimeSignal instanceof AbortSignal)
  ) {
    throw new TypeError(
      'Field loader runtime signal must be an AbortSignal or null.'
    );
  }
  const baseFetchInit = baseOptions.fetchInit ?? {};
  const configuredSignal = baseOptions.signal ?? null;
  if (
    configuredSignal !== null
    && !(configuredSignal instanceof AbortSignal)
  ) {
    throw new TypeError(
      'Field loader configured signal must be an AbortSignal or null.'
    );
  }
  const configuredFetchSignal = baseFetchInit.signal ?? null;
  if (
    configuredFetchSignal !== null
    && !(configuredFetchSignal instanceof AbortSignal)
  ) {
    throw new TypeError(
      'Field loader configured fetch signal must be an AbortSignal or null.'
    );
  }
  const signals = [
    configuredSignal,
    configuredFetchSignal,
    runtimeSignal
  ].filter((signal, index, owners) => (
    signal !== null && owners.indexOf(signal) === index
  ));
  const signal = signals.length === 0
    ? null
    : (
        signals.length === 1
          ? signals[0]
          : AbortSignal.any(signals)
      );
  const fetchInit = signal === null
    ? baseFetchInit
    : (
        baseFetchInit.signal === signal
          ? baseFetchInit
          : { ...baseFetchInit, signal }
      );
  return {
    ...baseOptions,
    fetchInit,
    signal
  };
}

/**
 * Create a field loader closure with shared options (DRY).
 * @param {string} manifestUrl
 * @param {FieldLoaderOptions} [options]
 * @returns {(field: any) => Promise<any>}
 */
export function createObsFieldLoader(manifestUrl, options = {}) {
  return (field, runtimeOptions = {}) => loadObsFieldData(
    manifestUrl,
    field,
    mergeFieldLoaderOptions(options, runtimeOptions)
  );
}

/**
 * Create a var field loader closure with shared options (DRY).
 * @param {string} manifestUrl
 * @param {FieldLoaderOptions} [options]
 * @returns {(field: any) => Promise<any>}
 */
export function createVarFieldLoader(manifestUrl, options = {}) {
  return (field, runtimeOptions = {}) => loadVarFieldData(
    manifestUrl,
    field,
    mergeFieldLoaderOptions(options, runtimeOptions)
  );
}

// ============================================================================
// CONNECTIVITY / EDGE DATA LOADERS
// ============================================================================
// GPU-optimized edge format for instanced rendering with:
// - Direct GPU upload (no CPU processing)
// - Instanced rendering with texture lookups
// - Visibility filtering in shader
// - Exact uint16 or uint32 prepared indices; direct readers publish uint32

function connectivityContextForUrl(url) {
  return shouldUseAnnData(url)
    ? CONNECTIVITY_MANIFEST_CONTEXT.DIRECT
    : CONNECTIVITY_MANIFEST_CONTEXT.FILE;
}

function requireConnectivityManifestForUrl(manifestUrl, manifest) {
  const context = connectivityContextForUrl(manifestUrl);
  const validated = validateConnectivityManifest(manifest, context);
  if (validated === null) {
    throw new Error(
      'No connectivity data is available for this direct AnnData dataset'
    );
  }
  return { context, manifest: validated };
}

function readFileConnectivityIndices(buffer, manifest, url) {
  const expectedBytes = manifest.n_edges * manifest.index_bytes;
  if (
    !(buffer instanceof ArrayBuffer) ||
    buffer.byteLength !== expectedBytes
  ) {
    throw new Error(
      `Invalid connectivity payload from ${url}: expected exactly ` +
      `${expectedBytes} bytes for ${manifest.n_edges} ${manifest.index_dtype} indices`
    );
  }
  return typedArrayFromBuffer(buffer, manifest.index_dtype, url);
}

function readFileConnectivityWeights(buffer, manifest, url) {
  const expectedBytes = manifest.n_edges * manifest.weight_bytes;
  if (
    !(buffer instanceof ArrayBuffer) ||
    buffer.byteLength !== expectedBytes
  ) {
    throw new Error(
      `Invalid connectivity payload from ${url}: expected exactly ` +
      `${expectedBytes} bytes for ${manifest.n_edges} ${manifest.weight_dtype} weights`
    );
  }
  return typedArrayFromBuffer(buffer, manifest.weight_dtype, url);
}

function normalizeConnectivityIndices(indices) {
  if (indices instanceof Uint32Array) {
    return indices;
  }
  if (indices instanceof Uint16Array) {
    return Uint32Array.from(indices);
  }
  throw new TypeError(
    'Connectivity indices must use the exact uint16 or uint32 manifest dtype'
  );
}

async function loadDirectConnectivityEdges(
  manifestUrl,
  manifest,
  signal
) {
  const edgeData = await anndataLoadConnectivity(
    manifestUrl,
    { signal }
  );
  if (edgeData === null) {
    throw new Error(
      'Direct AnnData connectivity payload is absent despite its manifest'
    );
  }
  return validateConnectivityEdgeData(edgeData, manifest);
}

async function loadFileConnectivityIndices(
  manifestUrl,
  manifest,
  path,
  signal
) {
  const url = resolveUrl(manifestUrl, path);
  const buffer = await fetchBinary(url, { signal });
  throwIfMetadataAborted(signal, 'Connectivity edge loading');
  return readFileConnectivityIndices(buffer, manifest, url);
}

async function loadFileConnectivityWeights(
  manifestUrl,
  manifest,
  signal
) {
  const url = resolveUrl(manifestUrl, manifest.weightsPath);
  const buffer = await fetchBinary(url, { signal });
  throwIfMetadataAborted(signal, 'Connectivity edge loading');
  return readFileConnectivityWeights(buffer, manifest, url);
}

/**
 * Load connectivity manifest
 * @param {string} url - URL to connectivity manifest JSON
 * @param {{signal?: AbortSignal|null}} [options]
 * @returns {Promise<Object|null>} Connectivity manifest or exact direct absence
 */
export async function loadConnectivityManifest(url, options = {}) {
  const {
    candidateAnnDataBinding,
    signal,
    stagedSource,
  } = getStagedMetadataLoadOwner(
    options,
    'Connectivity manifest loader'
  );
  requireStagedOwnerForUrl(
    url,
    candidateAnnDataBinding,
    stagedSource,
    'Connectivity manifest loader'
  );
  throwIfMetadataAborted(signal, 'Connectivity manifest loading');
  const context = connectivityContextForUrl(url);

  // Handle AnnData source (h5ad or zarr) - unified handling
  if (context === CONNECTIVITY_MANIFEST_CONTEXT.DIRECT) {
    const manifest = await anndataGetConnectivityManifest(
      url,
      { signal },
      candidateAnnDataBinding
    );
    throwIfMetadataAborted(signal, 'Connectivity manifest loading');
    return validateConnectivityManifest(manifest, context);
  }

  const fetchInit = signal ? { signal } : undefined;
  const manifest = isLocalUserUrl(url)
    ? await fetchJsonWithProtocol(url, fetchInit, stagedSource)
    : await (await fetchOk(url, fetchInit, stagedSource)).json();
  throwIfMetadataAborted(signal, 'Connectivity manifest loading');
  return validateConnectivityManifest(manifest, context);
}

/**
 * Load both edge arrays in parallel
 * @param {string} manifestUrl - Base URL for manifest
 * @param {Object} manifest - Connectivity manifest
 * @param {{signal: AbortSignal}} options - Required load owner
 * @returns {Promise<{sources: Uint32Array, destinations: Uint32Array, weights: Float64Array, nEdges: number, nCells: number, maxNeighbors: number}>}
 */
export async function loadEdges(manifestUrl, manifest, options) {
  const signal = getMetadataLoadSignal(
    options,
    'Connectivity edge loader'
  );
  if (signal === null) {
    throw new TypeError(
      'Connectivity edge loader options.signal is required'
    );
  }
  throwIfMetadataAborted(signal, 'Connectivity edge loading');
  const validated = requireConnectivityManifestForUrl(
    manifestUrl,
    manifest
  );

  if (validated.context === CONNECTIVITY_MANIFEST_CONTEXT.DIRECT) {
    const edgeData = await loadDirectConnectivityEdges(
      manifestUrl,
      validated.manifest,
      signal
    );
    throwIfMetadataAborted(signal, 'Connectivity edge loading');
    return {
      sources: edgeData.sources,
      destinations: edgeData.destinations,
      weights: edgeData.weights,
      nEdges: edgeData.nEdges,
      nCells: edgeData.nCells,
      maxNeighbors: edgeData.maxNeighbors
    };
  }

  const [rawSources, rawDestinations, weights] = await Promise.all([
    loadFileConnectivityIndices(
      manifestUrl,
      validated.manifest,
      validated.manifest.sourcesPath,
      signal
    ),
    loadFileConnectivityIndices(
      manifestUrl,
      validated.manifest,
      validated.manifest.destinationsPath,
      signal
    ),
    loadFileConnectivityWeights(
      manifestUrl,
      validated.manifest,
      signal
    ),
  ]);
  throwIfMetadataAborted(signal, 'Connectivity edge loading');
  const edgeData = {
    sources: normalizeConnectivityIndices(rawSources),
    destinations: normalizeConnectivityIndices(rawDestinations),
    weights,
    nEdges: validated.manifest.n_edges,
    nCells: validated.manifest.n_cells,
    maxNeighbors: validated.manifest.max_neighbors,
  };
  validateConnectivityEdgeData(edgeData, validated.manifest);
  throwIfMetadataAborted(signal, 'Connectivity edge loading');
  return {
    sources: edgeData.sources,
    destinations: edgeData.destinations,
    weights: edgeData.weights,
    nEdges: edgeData.nEdges,
    nCells: edgeData.nCells,
    maxNeighbors: edgeData.maxNeighbors
  };
}

// ============================================================================
// DATASET IDENTITY LOADER (includes multi-dimensional embeddings metadata)
// ============================================================================

/**
 * Load dataset identity JSON (includes embeddings metadata for multi-dimensional support)
 * @param {string} url - URL to dataset_identity.json
 * @param {{signal?: AbortSignal|null}} [options]
 * @returns {Promise<Object>} Dataset identity with embeddings metadata
 */
export async function loadDatasetIdentity(url, options = {}) {
  const {
    candidateAnnDataBinding,
    signal,
    stagedSource,
  } = getStagedMetadataLoadOwner(
    options,
    'Dataset identity loader'
  );
  requireStagedOwnerForUrl(
    url,
    candidateAnnDataBinding,
    stagedSource,
    'Dataset identity loader'
  );
  throwIfMetadataAborted(signal, 'Dataset identity loading');
  const fetchInit = signal ? { signal } : undefined;

  // Handle AnnData source (h5ad or zarr) - unified handling
  if (shouldUseAnnData(url)) {
    const identity = anndataGetDatasetIdentity(
      url,
      { signal },
      candidateAnnDataBinding
    );
    throwIfMetadataAborted(signal, 'Dataset identity loading');
    return identity;
  }

  // Handle local-user:// URLs
  if (isLocalUserUrl(url)) {
    const identity = await fetchJsonWithProtocol(
      url,
      fetchInit,
      stagedSource
    );
    throwIfMetadataAborted(signal, 'Dataset identity loading');
    return identity;
  }

  const response = await fetchOk(url, fetchInit, stagedSource);
  const identity = await response.json();
  throwIfMetadataAborted(signal, 'Dataset identity loading');
  return identity;
}

/**
 * Extract embeddings metadata from dataset identity
 * @param {Object} identity - Dataset identity object
 * @returns {Object|null} Embeddings metadata or null if not present
 */
export function getEmbeddingsMetadata(identity) {
  if (!identity?.embeddings) {
    throw new Error('dataset_identity.json is missing required embeddings metadata');
  }
  return identity.embeddings;
}

// ============================================================================
// ANALYSIS-SPECIFIC BULK DATA LOADER
// ============================================================================

function requireExactAnalysisLoadOptions(
  options,
  requiredKeys,
  optionalKeys,
  label
) {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options)
  ) {
    throw new TypeError(`${label} options must be an object`);
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const missing = requiredKeys.filter(key => !Object.hasOwn(options, key));
  const unexpected = Object.keys(options).filter(key => !allowed.has(key));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new TypeError(
      `${label} options must contain the exact current keys; ` +
      `missing=[${missing.join(', ')}], unexpected=[${unexpected.join(', ')}]`
    );
  }
}

function requireAnalysisManifestSelection({
  manifest,
  requestedKeys,
  variableLabel,
  manifestLabel,
}) {
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    !Array.isArray(manifest.fields)
  ) {
    throw new TypeError(`${manifestLabel} must contain a fields array`);
  }
  if (!Array.isArray(requestedKeys) || requestedKeys.length === 0) {
    throw new TypeError(
      `${variableLabel} list must be a non-empty array`
    );
  }

  const fieldsByKey = new Map();
  for (const [index, field] of manifest.fields.entries()) {
    if (
      field === null ||
      typeof field !== 'object' ||
      Array.isArray(field) ||
      typeof field.key !== 'string' ||
      field.key.length === 0 ||
      field.key !== field.key.trim()
    ) {
      throw new TypeError(
        `${manifestLabel} fields[${index}].key must be exact non-empty text`
      );
    }
    if (fieldsByKey.has(field.key)) {
      throw new Error(
        `${manifestLabel} contains duplicate field "${field.key}"`
      );
    }
    fieldsByKey.set(field.key, field);
  }

  const seen = new Set();
  for (const [index, key] of requestedKeys.entries()) {
    if (
      typeof key !== 'string' ||
      key.length === 0 ||
      key !== key.trim()
    ) {
      throw new TypeError(
        `Requested ${variableLabel} at index ${index} must be exact non-empty text`
      );
    }
    if (seen.has(key)) {
      throw new Error(`Requested ${variableLabel} "${key}" is duplicated`);
    }
    seen.add(key);
    if (!fieldsByKey.has(key)) {
      throw new Error(
        `Requested ${variableLabel} "${key}" is not declared by ${manifestLabel}`
      );
    }
  }
  return fieldsByKey;
}

function requireAnalysisBatchOptions({
  manifestUrl,
  batchSize,
  onProgress,
  suppressNotifications,
  label,
}) {
  if (
    typeof manifestUrl !== 'string' ||
    manifestUrl.length === 0 ||
    manifestUrl !== manifestUrl.trim()
  ) {
    throw new TypeError(`${label} manifestUrl must be exact non-empty text`);
  }
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new TypeError(`${label} batchSize must be a positive safe integer`);
  }
  if (onProgress !== undefined && typeof onProgress !== 'function') {
    throw new TypeError(`${label} onProgress must be a function or undefined`);
  }
  if (typeof suppressNotifications !== 'boolean') {
    throw new TypeError(`${label} suppressNotifications must be a boolean`);
  }
}

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
 * @returns {Promise<Object>} { genes: { geneName: Float32Array }, loadedCount }
 */
export async function loadAnalysisBulkData(options) {
  requireExactAnalysisLoadOptions(
    options,
    ['manifestUrl', 'varManifest', 'geneList'],
    ['batchSize', 'onProgress', 'suppressNotifications'],
    'Bulk gene loader'
  );
  const {
    manifestUrl,
    varManifest,
    geneList,
    batchSize = 20,
    onProgress,
    suppressNotifications = false
  } = options;
  requireAnalysisBatchOptions({
    manifestUrl,
    batchSize,
    onProgress,
    suppressNotifications,
    label: 'Bulk gene loader',
  });
  const fieldsByKey = requireAnalysisManifestSelection({
    manifest: varManifest,
    requestedKeys: geneList,
    variableLabel: 'gene',
    manifestLabel: 'var_manifest.json',
  });

  const notifications = suppressNotifications ? null : getNotificationCenter();
  const trackerId = notifications?.show({
    type: 'progress',
    category: 'data',
    title: 'Loading Gene Expression',
    message: `Preparing ${geneList.length} genes...`,
    progress: 0
  }) ?? null;
  const result = {
    genes: {},
    loadedCount: 0,
  };

  try {
    let loadedCount = 0;
    const totalGenes = geneList.length;

    for (let i = 0; i < geneList.length; i += batchSize) {
      const batch = geneList.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(async geneName => {
          const data = await loadVarFieldData(
            manifestUrl,
            fieldsByKey.get(geneName)
          );
          if (!(data.values instanceof Float32Array)) {
            throw new TypeError(
              `Gene "${geneName}" must load as a Float32Array`
            );
          }
          return { geneName, values: data.values };
        })
      );

      for (const res of batchResults) {
        setOwnDataProperty(result.genes, res.geneName, res.values);
        result.loadedCount++;
      }

      loadedCount += batch.length;
      const progress = Math.round((loadedCount / totalGenes) * 100);
      notifications?.updateProgress(trackerId, progress, {
        message: `Loaded ${loadedCount} of ${totalGenes} genes...`
      });
      onProgress?.(progress);
    }

    notifications?.complete(
      trackerId,
      `Loaded ${result.loadedCount} genes`
    );
    return result;
  } catch (error) {
    notifications?.fail(trackerId, `Failed: ${error.message}`);
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

  if (!Number.isInteger(dimension) || dimension < 1 || dimension > 3) {
    throw new Error(
      `Requested embedding dimension must be exactly 1, 2, or 3; received ${String(dimension)}`
    );
  }

  const embeddings = getEmbeddingsMetadata(identity);
  const available = embeddings.available_dimensions;
  if (
    !Array.isArray(available) ||
    available.length === 0 ||
    available.some(
      value => !Number.isInteger(value) || value < 1 || value > 3
    ) ||
    new Set(available).size !== available.length
  ) {
    throw new Error(
      'Embeddings metadata must declare unique numeric available_dimensions from 1, 2, or 3'
    );
  }
  if (!available.includes(dimension)) {
    throw new Error(
      `Requested ${dimension}D embedding is not available; ` +
      `available dimensions: ${available.map(value => `${value}D`).join(', ')}`
    );
  }

  const dimKey = `${dimension}d`;
  const files = embeddings.files;
  const filePath = files?.[dimKey];
  if (
    !files ||
    typeof files !== 'object' ||
    Array.isArray(files) ||
    !Object.hasOwn(files, dimKey) ||
    typeof filePath !== 'string' ||
    filePath.length === 0
  ) {
    throw new Error(
      `Embeddings metadata for ${dimension}D must advertise one non-empty file path`
    );
  }

  const notifications = getNotificationCenter();
  const trackerId = notifications.startDownload(`${dimension}D Embeddings`);
  try {
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
 * @param {boolean} [options.suppressNotifications=false] - Suppress progress UI
 * @returns {Promise<Object>} { genes: { geneName: { values, indices } }, cellCount }
 */
export async function loadAnalysisSubset(options) {
  requireExactAnalysisLoadOptions(
    options,
    ['manifestUrl', 'varManifest', 'geneList', 'cellIndices'],
    ['batchSize', 'onProgress', 'suppressNotifications'],
    'Analysis subset loader'
  );
  const {
    manifestUrl,
    varManifest,
    geneList,
    cellIndices,
    batchSize = 20,
    onProgress,
    suppressNotifications = false
  } = options;

  requireAnalysisBatchOptions({
    manifestUrl,
    batchSize,
    onProgress,
    suppressNotifications,
    label: 'Analysis subset loader',
  });
  if (!Array.isArray(cellIndices)) {
    throw new TypeError(
      'Analysis subset loader cellIndices must be an array'
    );
  }
  const seenCellIndices = new Set();
  for (const [index, cellIndex] of cellIndices.entries()) {
    if (!Number.isSafeInteger(cellIndex) || cellIndex < 0) {
      throw new TypeError(
        `Analysis subset loader cellIndices[${index}] must be a non-negative safe integer`
      );
    }
    if (seenCellIndices.has(cellIndex)) {
      throw new Error(
        `Analysis subset loader cell index ${cellIndex} is duplicated`
      );
    }
    seenCellIndices.add(cellIndex);
  }

  const notifications = suppressNotifications ? null : getNotificationCenter();
  const trackerId = notifications?.show({
    type: 'progress',
    category: 'data',
    title: 'Loading Subset Data',
    message: `Loading ${geneList.length} genes for ${cellIndices.length} cells...`,
    progress: 0
  }) ?? null;

  try {
    // First load all gene data
    const bulkResult = await loadAnalysisBulkData({
      manifestUrl,
      varManifest,
      geneList,
      batchSize,
      suppressNotifications: true,
      onProgress: (p) => {
        notifications?.updateProgress(trackerId, Math.round(p * 0.8), {
          message: `Loading genes (${Math.round(p)}%)...`
        });
        onProgress?.(Math.round(p * 0.8));
      }
    });

    // Extract values for specified cell indices
    notifications?.updateProgress(trackerId, 85, {
      message: 'Extracting cell values...'
    });

    const loadedGenes = Object.keys(bulkResult.genes);
    if (
      loadedGenes.length !== geneList.length ||
      geneList.some(geneName => !Object.hasOwn(bulkResult.genes, geneName))
    ) {
      throw new Error(
        'Analysis subset loader did not receive every requested gene'
      );
    }
    for (const geneName of geneList) {
      const fullValues = bulkResult.genes[geneName];
      if (!(fullValues instanceof Float32Array)) {
        throw new TypeError(
          `Analysis subset gene "${geneName}" must be a Float32Array`
        );
      }
      for (const cellIndex of cellIndices) {
        if (cellIndex >= fullValues.length) {
          throw new RangeError(
            `Cell index ${cellIndex} is outside gene "${geneName}" values length ` +
            `${fullValues.length}`
          );
        }
      }
    }

    const result = {
      genes: {},
      cellCount: cellIndices.length,
      cellIndices: [...cellIndices]
    };

    const indexArray = [...cellIndices];
    for (const geneName of geneList) {
      const fullValues = bulkResult.genes[geneName];
      const subsetValues = new Float32Array(cellIndices.length);

      for (let i = 0; i < indexArray.length; i++) {
        const cellIdx = indexArray[i];
        subsetValues[i] = fullValues[cellIdx];
      }

      setOwnDataProperty(result.genes, geneName, {
        values: subsetValues,
        indices: [...indexArray]
      });
    }

    notifications?.complete(trackerId,
      `Loaded ${Object.keys(result.genes).length} genes for ${cellIndices.length} cells`
    );

    onProgress?.(100);

    return result;

  } catch (error) {
    notifications?.fail(trackerId, `Failed: ${error.message}`);
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
 * @returns {Promise<Object>} { fields: { fieldKey: { values?, codes?, categories?, kind } }, loadedCount }
 */
export async function loadAnalysisBulkObsData(options) {
  requireExactAnalysisLoadOptions(
    options,
    ['manifestUrl', 'obsManifest', 'fieldList'],
    ['batchSize', 'onProgress', 'suppressNotifications'],
    'Bulk observation loader'
  );
  const {
    manifestUrl,
    obsManifest,
    fieldList,
    batchSize = 10,
    onProgress,
    suppressNotifications = false
  } = options;
  requireAnalysisBatchOptions({
    manifestUrl,
    batchSize,
    onProgress,
    suppressNotifications,
    label: 'Bulk observation loader',
  });
  const fieldsByKey = requireAnalysisManifestSelection({
    manifest: obsManifest,
    requestedKeys: fieldList,
    variableLabel: 'observation field',
    manifestLabel: 'obs_manifest.json',
  });

  const notifications = suppressNotifications ? null : getNotificationCenter();
  const trackerId = notifications ? notifications.show({
    type: 'progress',
    category: 'data',
    title: 'Loading Observation Fields',
    message: `Preparing ${fieldList.length} fields...`,
    progress: 0
  }) : null;

  const result = {
    fields: {},
    loadedCount: 0,
  };

  try {
    let loadedCount = 0;
    const totalFields = fieldList.length;

    for (let i = 0; i < fieldList.length; i += batchSize) {
      const batch = fieldList.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(async fieldKey => {
          const field = fieldsByKey.get(fieldKey);
          const data = await loadObsFieldData(manifestUrl, field);
          if (field.kind !== 'continuous' && field.kind !== 'category') {
            throw new TypeError(
              `Observation field "${fieldKey}" must declare its exact kind`
            );
          }
          if (
            field.kind === 'continuous' &&
            !(data.values instanceof Float32Array)
          ) {
            throw new TypeError(
              `Continuous observation field "${fieldKey}" must load as Float32Array`
            );
          }
          if (
            field.kind === 'category' &&
            (!(data.codes instanceof Uint16Array) ||
              !Array.isArray(field.categories))
          ) {
            throw new TypeError(
              `Categorical observation field "${fieldKey}" must load exact codes and categories`
            );
          }
          const fieldResult = {
            kind: field.kind,
            categories: field.kind === 'category' ? field.categories : null
          };

          if (field.kind === 'continuous') {
            fieldResult.values = data.values;
          } else {
            fieldResult.codes = data.codes;
          }

          return { fieldKey, data: fieldResult };
        })
      );

      for (const res of batchResults) {
        setOwnDataProperty(result.fields, res.fieldKey, res.data);
        result.loadedCount++;
      }

      loadedCount += batch.length;
      const progress = Math.round((loadedCount / totalFields) * 100);

      if (notifications && trackerId) {
        notifications.updateProgress(trackerId, progress, {
          message: `Loaded ${loadedCount} of ${totalFields} fields...`
        });
      }

      onProgress?.(progress);
    }

    if (notifications && trackerId) {
      notifications.complete(
        trackerId,
        `Loaded ${result.loadedCount} fields`
      );
    }

    return result;

  } catch (error) {
    if (notifications && trackerId) {
      notifications.fail(trackerId, `Failed: ${error.message}`);
    }
    throw error;
  }
}
