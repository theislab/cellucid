/**
 * Data Source Interface and Base Utilities
 *
 * Provides a unified abstraction for data access that allows the app
 * to work with different data backends (local demo, user directory, remote server, Jupyter).
 */

import {
  getMetadataLoadSignal,
  throwIfMetadataAborted,
} from './metadata-load-contract.js';

/**
 * @typedef {Object} DatasetStats
 * @property {number} n_cells - Number of cells/points
 * @property {number} n_genes - Number of genes
 * @property {number} n_obs_fields - Number of observation fields
 * @property {number} n_categorical_fields - Number of categorical fields
 * @property {number} n_continuous_fields - Number of continuous fields
 * @property {boolean} has_connectivity - Whether KNN data exists
 * @property {number|null} n_edges - Edge count, or null without connectivity
 */

/**
 * @typedef {Object} DatasetObsField
 * @property {string} key - Field key/name
 * @property {'category'|'continuous'} kind - Field type
 * @property {number} [n_categories] - Number of categories (for categorical)
 */

/**
 * @typedef {Object} DatasetExportSettings
 * @property {number|null} compression - Gzip compression level
 * @property {number|null} var_quantization - Gene expression quantization bits
 * @property {number|null} obs_continuous_quantization - Continuous obs quantization bits
 * @property {string} obs_categorical_dtype - Categorical dtype ('uint8' or 'uint16')
 */

/**
 * @typedef {Object} DatasetSource
 * @property {string} [name] - Source name
 * @property {string} [url] - Source URL
 * @property {string} [citation] - Citation text
 */

/**
 * @typedef {Object} DatasetMetadata
 * @property {number} version - Exact dataset identity version
 * @property {string} id - Unique identifier (directory name)
 * @property {string} name - Human-readable display name
 * @property {string} description - Description (may be empty)
 * @property {string} [created_at] - ISO timestamp of export
 * @property {string} cellucid_data_version - Version of cellucid-data used
 * @property {DatasetStats} stats - Dataset statistics
 * @property {Object} embeddings - Exact available/default embedding metadata
 * @property {DatasetObsField[]} obs_fields - List of observation fields
 * @property {DatasetExportSettings} [export_settings] - Export configuration
 * @property {DatasetSource} [source] - Data source information
 */

/**
 * Configuration constants for data loading
 */
const EXPORTS_QUERY_KEY = 'exportsBaseUrl';
const EXPORTS_META_SELECTOR =
  'meta[name="cellucid-exports-base-url"]';

function exportsConfigurationError(message) {
  const error = new Error(`Sample dataset configuration: ${message}`);
  error.name = 'ConfigurationError';
  return error;
}

function requireCanonicalPathSegments(
  pathname,
  owner,
  createError = message => new TypeError(message)
) {
  const segments = pathname.split('/').slice(1);
  if (segments.at(-1) === '') segments.pop();
  for (const segment of segments) {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw createError(
        `${owner} contains invalid percent encoding`
      );
    }
    if (
      segment.length === 0 ||
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('%') ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      /[\u0000-\u001f\u007f]/.test(decoded) ||
      encodeURIComponent(decoded) !== segment
    ) {
      throw createError(
        `${owner} contains a non-canonical path segment`
      );
    }
  }
}

function validateExportsBaseUrl(value, owner) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw exportsConfigurationError(
      `${owner} must contain one exact non-empty URL`
    );
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw exportsConfigurationError(
      `${owner} must be an absolute HTTP(S) URL`
    );
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    !parsed.pathname.endsWith('/') ||
    parsed.href !== value
  ) {
    throw exportsConfigurationError(
      `${owner} must be one canonical HTTP(S) directory URL with a trailing /`
    );
  }
  requireCanonicalPathSegments(
    parsed.pathname,
    owner,
    exportsConfigurationError
  );
  return parsed.href;
}

function readExportsConfiguration() {
  if (
    typeof window === 'undefined' ||
    typeof window.location?.href !== 'string'
  ) {
    return { baseUrl: null, error: null };
  }
  try {
    const pageUrl = new URL(window.location.href);
    const queryValues =
      pageUrl.searchParams.getAll(EXPORTS_QUERY_KEY);
    if (queryValues.length > 1) {
      throw exportsConfigurationError(
        `exactly one '${EXPORTS_QUERY_KEY}' query field is allowed`
      );
    }
    if (queryValues.length === 1) {
      return {
        baseUrl: validateExportsBaseUrl(
          queryValues[0],
          EXPORTS_QUERY_KEY
        ),
        error: null,
      };
    }

    if (typeof document === 'undefined') {
      return { baseUrl: null, error: null };
    }
    const metas = document.querySelectorAll(EXPORTS_META_SELECTOR);
    if (metas.length > 1) {
      throw exportsConfigurationError(
        'exactly one cellucid-exports-base-url meta element is allowed'
      );
    }
    if (metas.length === 0) {
      return { baseUrl: null, error: null };
    }
    const content = metas[0].getAttribute('content');
    return {
      baseUrl: validateExportsBaseUrl(
        content,
        'cellucid-exports-base-url meta content'
      ),
      error: null,
    };
  } catch (error) {
    return {
      baseUrl: null,
      error: error instanceof Error
        ? error
        : exportsConfigurationError(String(error)),
    };
  }
}

const exportsConfiguration = readExportsConfiguration();

export const DATA_CONFIG = {
  // Base paths
  EXPORTS_BASE_URL: exportsConfiguration.baseUrl,
  EXPORTS_CONFIGURATION_ERROR: exportsConfiguration.error,
  DATASETS_MANIFEST: 'datasets.json',

  // Required files for a valid dataset
  REQUIRED_FILES: [
    'dataset_identity.json',
    'obs_manifest.json'
  ],

  // Points files - check for dimensional files (3D preferred, then 2D, then 1D)
  POINTS_FILES: ['points_3d.bin', 'points_2d.bin', 'points_1d.bin'],

  // Metadata file name
  DATASET_IDENTITY_FILE: 'dataset_identity.json',

  // Supported schema versions
  SUPPORTED_MANIFEST_VERSIONS: [1],
  SUPPORTED_IDENTITY_VERSIONS: [2]
};

// ============================================================================
// PAYLOAD BYTE CEILINGS
// ============================================================================
// Datasets are untrusted input: a user opens somebody else's GitHub repository
// the same way they open their own directory. Both paths therefore share one
// ceiling, so a payload refused on disk is refused over the network too.

/**
 * Largest single binary payload the browser will materialize from any source.
 */
export const MAX_PREPARED_BROWSER_BYTES = 512 * 1024 * 1024;

/**
 * Largest metadata/manifest JSON document accepted from any source.
 */
export const MAX_METADATA_JSON_BYTES = 64 * 1024 * 1024;

/**
 * The exact error a byte ceiling refuses with.
 *
 * A ceiling fires on well-formed data that is merely too big, so the refusal
 * has to be told apart from a malformed document. It carries a code for the
 * same reason every other loader failure does: the UI names a cause from the
 * code and never from the message text, so a refusal that published no code
 * would be given somebody else's advice — "re-export it", which regenerates a
 * byte-identical file, or "check your network", which worked.
 *
 * @param {string} message
 * @param {Object} [details]
 * @returns {DataSourceError}
 */
function payloadTooLargeError(message, details = {}) {
  return new DataSourceError(
    message,
    DataSourceErrorCode.TOO_LARGE,
    null,
    details
  );
}

/**
 * Validate a manifest-declared payload length against the browser ceiling.
 *
 * Runs before the request is issued, so an over-declared payload costs no
 * network traffic at all.
 *
 * @param {number} expectedBytes - Manifest-declared decoded length
 * @param {string} label - Payload identity for the error message
 * @returns {number} The validated length
 */
export function requirePayloadBudget(expectedBytes, label) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
    // Not a size refusal: nothing was measured against the ceiling, and the
    // caller passed something that is not a length at all.
    throw new RangeError(
      `${label}: declared payload length must be a non-negative safe integer, ` +
      `received ${String(expectedBytes)}`
    );
  }
  if (expectedBytes > MAX_PREPARED_BROWSER_BYTES) {
    throw payloadTooLargeError(
      `${label}: declared payload of ${expectedBytes} bytes exceeds the 512 MiB browser limit`,
      { label, declaredBytes: expectedBytes, maxBytes: MAX_PREPARED_BROWSER_BYTES }
    );
  }
  return expectedBytes;
}

/**
 * Largest gzip member that can legally encode `expectedBytes` of output.
 *
 * DEFLATE's worst case is a stored block per 65535 input bytes, each costing
 * five bytes, plus the ten-byte header, the eight-byte trailer, and room for
 * an optional file name. Anything larger cannot be a faithful encoding of the
 * declared payload, so the transfer is refused without inflating a byte.
 *
 * @param {number} expectedBytes
 * @returns {number}
 */
export function maxGzipTransferBytes(expectedBytes) {
  const storedBlocks = Math.ceil(expectedBytes / 65535) + 1;
  return expectedBytes + storedBlocks * 5 + 18 + 1024;
}

function requireByteCeiling(maxBytes, label) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError(
      `${label}: byte ceiling must be a non-negative safe integer, ` +
      `received ${String(maxBytes)}`
    );
  }
  return maxBytes;
}

/**
 * Read a response body into one Uint8Array, cancelling the source stream the
 * moment it grows past `maxBytes`.
 *
 * This enforces a *ceiling*, which is deliberately not the same contract as
 * the exact-output-length reader owned by the session gzip codec
 * (`app/session/codecs/gzip.js`): a transfer's encoded size is not knowable
 * from a manifest, so it can only be capped. Exact-length enforcement of
 * decompressed payloads is delegated to that codec's `gzipDecompress()`.
 *
 * @param {Response} response
 * @param {Object} options
 * @param {string} options.label - Payload identity for error messages
 * @param {number} options.maxBytes - Hard ceiling on transferred bytes
 * @param {AbortSignal|null} [options.signal]
 * @param {((loadedBytes: number, totalBytes: number|null) => void)|null} [options.onProgress]
 * @param {number|null} [options.totalBytes] - Declared transfer size for progress
 * @returns {Promise<Uint8Array>}
 */
export async function readBoundedBody(response, options) {
  const {
    label,
    maxBytes,
    signal = null,
    onProgress = null,
    totalBytes = null,
  } = options;
  requireByteCeiling(maxBytes, label);

  const body = response.body;
  if (
    body === null ||
    body === undefined ||
    typeof body.getReader !== 'function'
  ) {
    throw new DataSourceError(
      `${label}: response carried no readable body`,
      DataSourceErrorCode.INVALID_FORMAT,
      null,
      { label }
    );
  }

  const chunks = [];
  let loadedBytes = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      throwIfMetadataAborted(signal, label);
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array
        ? value
        : new Uint8Array(value);
      if (chunk.byteLength === 0) continue;
      loadedBytes += chunk.byteLength;
      if (loadedBytes > maxBytes) {
        // Stop the transfer immediately rather than paying for the rest of it.
        await reader.cancel(
          `${label}: transfer exceeded its ${maxBytes}-byte ceiling`
        );
        throw payloadTooLargeError(
          `${label}: transfer of at least ${loadedBytes} bytes exceeds ` +
          `its ${maxBytes}-byte ceiling`,
          { label, loadedBytes, maxBytes }
        );
      }
      chunks.push(chunk);
      if (onProgress !== null) onProgress(loadedBytes, totalBytes);
    }
  } finally {
    reader.releaseLock();
  }
  throwIfMetadataAborted(signal, label);

  if (chunks.length === 1) return chunks[0];
  const merged = new Uint8Array(loadedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * Read a response body as JSON under a hard byte ceiling.
 *
 * @param {Response} response
 * @param {Object} options
 * @param {string} options.label - Payload identity for error messages
 * @param {AbortSignal|null} [options.signal]
 * @param {number} [options.maxBytes]
 * @returns {Promise<any>}
 */
export async function readBoundedJson(response, options) {
  const {
    label,
    signal = null,
    maxBytes = MAX_METADATA_JSON_BYTES,
  } = options;
  const bytes = await readBoundedBody(response, {
    label,
    maxBytes,
    signal,
  });
  return JSON.parse(new TextDecoder().decode(bytes));
}

// ============================================================================
// SAMPLE EXPORT TRANSPORT
// ============================================================================

const REQUEST_METHODS = new Set(['GET', 'HEAD']);
const REQUEST_CACHES = new Set([
  'default',
  'no-store',
  'reload',
  'no-cache',
  'force-cache',
]);
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;
const SAMPLE_CORS_TRANSPORT = Object.freeze({
  credentials: 'omit',
  mode: 'cors',
  redirect: 'error',
});

function getAbsoluteUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    throw new TypeError('Fetch URL must be a non-empty string.');
  }
  const documentUrl =
    typeof globalThis.window?.location?.href === 'string'
      ? globalThis.window.location.href
      : undefined;
  return documentUrl === undefined
    ? new URL(url).href
    : new URL(url, documentUrl).href;
}

function getAbsoluteExportsBaseUrl() {
  const base = DATA_CONFIG.EXPORTS_BASE_URL;
  if (base === null) return null;
  validateExportsBaseUrl(base, 'DATA_CONFIG.EXPORTS_BASE_URL');
  return getAbsoluteUrl(base);
}

function isExportsUrl(url) {
  const exportsBase = getAbsoluteExportsBaseUrl();
  if (!exportsBase) return false;
  const target = new URL(getAbsoluteUrl(url));
  const root = new URL(exportsBase);
  return (
    target.origin === root.origin &&
    target.search === '' &&
    target.hash === '' &&
    target.pathname.startsWith(root.pathname) &&
    target.pathname !== root.pathname
  );
}

function requireCanonicalExportsFileUrl(originalUrl, absoluteUrl) {
  if (originalUrl !== absoluteUrl) {
    throw new TypeError(
      'Sample request URL must be one canonical absolute URL.'
    );
  }
  const exportsBase = getAbsoluteExportsBaseUrl();
  if (exportsBase === null) {
    throw new Error('Sample exports root is not configured.');
  }
  const target = new URL(absoluteUrl);
  const root = new URL(exportsBase);
  if (
    target.origin !== root.origin ||
    target.search !== '' ||
    target.hash !== '' ||
    !target.pathname.startsWith(root.pathname) ||
    target.pathname === root.pathname
  ) {
    throw new TypeError(
      'Sample request URL must identify one file below the exact exports root.'
    );
  }
  const relativePath =
    target.pathname.slice(root.pathname.length);
  requireCanonicalPathSegments(
    `/${relativePath}`,
    'Sample request URL'
  );
  return absoluteUrl;
}

function validateExportsRequestOptions(init) {
  if (
    init !== undefined &&
    (
      init === null ||
      typeof init !== 'object' ||
      Array.isArray(init)
    )
  ) {
    throw new TypeError(
      'Sample request options must be an object when provided.'
    );
  }
  const value = init ?? {};
  const allowedKeys = new Set([
    'method',
    'cache',
    'headers',
    'signal',
  ]);
  const unsupported = Object.keys(value).filter(
    key => !allowedKeys.has(key)
  );
  if (unsupported.length > 0) {
    throw new TypeError(
      `Sample request contains unsupported option(s): ${unsupported.join(', ')}`
    );
  }
  const method = Object.hasOwn(value, 'method')
    ? value.method
    : 'GET';
  const cache = Object.hasOwn(value, 'cache')
    ? value.cache
    : 'default';
  const signal = Object.hasOwn(value, 'signal')
    ? value.signal
    : null;
  if (!REQUEST_METHODS.has(method)) {
    throw new TypeError(
      'Sample request method must be exactly GET or HEAD.'
    );
  }
  if (!REQUEST_CACHES.has(cache)) {
    throw new TypeError(
      'Sample request cache mode is unsupported.'
    );
  }
  if (
    signal !== null &&
    !(signal instanceof AbortSignal)
  ) {
    throw new TypeError(
      'Sample request signal must be an AbortSignal or null.'
    );
  }

  const headersValue = Object.hasOwn(value, 'headers')
    ? value.headers
    : {};
  if (
    headersValue === null ||
    typeof headersValue !== 'object' ||
    Array.isArray(headersValue) ||
    Object.getPrototypeOf(headersValue) !== Object.prototype
  ) {
    throw new TypeError(
      'Sample request headers must be a plain object.'
    );
  }
  const headers = Object.entries(headersValue)
    .sort(([left], [right]) => left.localeCompare(right));
  let previous = null;
  for (const [name, headerValue] of headers) {
    if (
      name !== name.toLowerCase() ||
      !HEADER_NAME.test(name) ||
      previous === name ||
      typeof headerValue !== 'string' ||
      /[\r\n\u0000]/.test(headerValue)
    ) {
      throw new TypeError(
        'Sample request headers require unique lowercase names and string values.'
      );
    }
    previous = name;
  }
  return Object.freeze({
    method,
    cache,
    headers,
    signal,
  });
}

/**
 * Fetch one data artifact. Files owned by the configured sample root use its
 * single current public transport: direct HTTP with browser CORS enforcement.
 * Other data sources retain the caller-provided HTTP transport options.
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export async function fetchSampleArtifact(url, init) {
  const absUrl = getAbsoluteUrl(url);

  if (!isExportsUrl(absUrl)) {
    return fetch(absUrl, init);
  }

  requireCanonicalExportsFileUrl(url, absUrl);
  const request = validateExportsRequestOptions(init);
  return fetch(absUrl, {
    ...SAMPLE_CORS_TRANSPORT,
    method: request.method,
    cache: request.cache,
    headers: request.headers,
    signal: request.signal,
  });
}

/**
 * Validate that a manifest/identity version is supported
 * @param {number|undefined} version - Version from the JSON
 * @param {number[]} supportedVersions - Array of supported versions
 * @param {string} context - Context for error message (e.g., 'datasets.json')
 * @throws {DataSourceError} If version is not supported
 */
export function validateSchemaVersion(version, supportedVersions, context) {
  if (version === undefined) {
    throw new DataSourceError(
      `Missing required version field in ${context}`,
      DataSourceErrorCode.INVALID_FORMAT,
      null,
      { version, supportedVersions, context }
    );
  }

  if (!supportedVersions.includes(version)) {
    throw new DataSourceError(
      `Unsupported ${context} version: ${version}. Supported versions: ${supportedVersions.join(', ')}`,
      DataSourceErrorCode.INVALID_FORMAT,
      null,
      { version, supportedVersions, context }
    );
  }
}

/**
 * Error codes for data source operations
 */
export const DataSourceErrorCode = {
  NOT_FOUND: 'NOT_FOUND',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  INVALID_FORMAT: 'INVALID_FORMAT',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  // A well-formed payload that is simply bigger than a browser ceiling. Kept
  // apart from INVALID_FORMAT because the two need opposite advice: one asks
  // for a re-export, the other says the export is fine and the browser is not.
  TOO_LARGE: 'TOO_LARGE',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNSUPPORTED: 'UNSUPPORTED'
};

/**
 * User-friendly error messages
 */
export const ERROR_MESSAGES = {
  [DataSourceErrorCode.NOT_FOUND]: 'Dataset not found. Check that the directory exists.',
  [DataSourceErrorCode.FILE_NOT_FOUND]: 'Dataset file not found.',
  [DataSourceErrorCode.INVALID_FORMAT]: 'Invalid dataset format. Missing required files.',
  [DataSourceErrorCode.PERMISSION_DENIED]: 'Cannot access directory. Please grant permission.',
  [DataSourceErrorCode.NETWORK_ERROR]: 'Failed to load dataset. Check your connection.',
  [DataSourceErrorCode.TOO_LARGE]: 'Dataset is larger than Cellucid opens in a browser.',
  [DataSourceErrorCode.VALIDATION_ERROR]: 'Dataset validation failed.',
  [DataSourceErrorCode.UNSUPPORTED]: 'This operation is not supported.'
};

/**
 * Custom error class for data source operations
 */
export class DataSourceError extends Error {
  /**
   * @param {string} message - Error message
   * @param {string} code - Error code from DataSourceErrorCode
   * @param {string} [source] - Source type that generated the error
   * @param {Object} [details] - Additional error details
   */
  constructor(message, code, source, details = {}) {
    super(message);
    this.name = 'DataSourceError';
    this.code = code;
    this.source = source;
    this.details = details;
  }

  /**
   * Get a user-friendly error message
   * @returns {string}
   */
  getUserMessage() {
    return ERROR_MESSAGES[this.code] || this.message;
  }
}

/**
 * Resolve a relative URL against a base URL
 * @param {string} base - Base URL
 * @param {string} relative - Relative path
 * @returns {string} Resolved absolute URL
 */
export function resolveUrl(base, relative) {
  if (typeof base !== 'string' || base.length === 0) {
    throw new TypeError('URL base must be a non-empty string');
  }
  if (typeof relative !== 'string' || relative.length === 0) {
    throw new TypeError('URL relative path must be a non-empty string');
  }

  const documentUrl = (
    typeof globalThis.window?.location?.href === 'string'
  )
    ? globalThis.window.location.href
    : undefined;
  const baseUrl = documentUrl === undefined
    ? new URL(base)
    : new URL(base, documentUrl);
  return new URL(relative, baseUrl).toString();
}

/**
 * Check if a URL exists (returns ok status)
 * @param {string} url - URL to check
 * @returns {Promise<boolean>}
 */
export async function urlExists(url) {
  const response = await fetchSampleArtifact(
    url,
    { method: 'HEAD' }
  );
  return response.ok;
}

/**
 * Fetch JSON data from a URL with error handling
 * @param {string} url - URL to fetch
 * @param {string} [sourceType] - Source type for error context
 * @param {{signal?: AbortSignal|null}} [options] - Exact request owner
 * @returns {Promise<any>}
 */
export async function fetchJson(url, sourceType, options = {}) {
  const signal = getMetadataLoadSignal(options, 'JSON loader');
  try {
    throwIfMetadataAborted(signal, 'JSON loading');
    const response = await fetchSampleArtifact(
      url,
      signal === null ? undefined : { signal }
    );
    throwIfMetadataAborted(signal, 'JSON loading');
    if (!response.ok) {
      if (response.status === 404) {
        throw new DataSourceError(
          `Resource not found: ${url}`,
          DataSourceErrorCode.NOT_FOUND,
          sourceType,
          { url, status: response.status }
        );
      }
      throw new DataSourceError(
        `Failed to fetch: ${response.statusText}`,
        DataSourceErrorCode.NETWORK_ERROR,
        sourceType,
        { url, status: response.status }
      );
    }
    const payload = await readBoundedJson(response, {
      label: `Metadata ${url}`,
      signal,
    });
    throwIfMetadataAborted(signal, 'JSON loading');
    return payload;
  } catch (err) {
    throwIfMetadataAborted(signal, 'JSON loading');
    if (err instanceof DataSourceError) throw err;
    throw new DataSourceError(
      `Network error: ${err.message}`,
      DataSourceErrorCode.NETWORK_ERROR,
      sourceType,
      { url, originalError: err.message }
    );
  }
}

/**
 * Validate that a dataset directory has required files
 * @param {string} baseUrl - Base URL of the dataset
 * @param {string} [_sourceType] - Source type for error context (reserved for future use)
 * @returns {Promise<{valid: boolean, missing: string[], pointsFile: string}>}
 */
export async function validateDatasetStructure(baseUrl, _sourceType) {
  const missing = [];
  let pointsFile = null;

  // Build all URL check promises in parallel
  // For points files: check both .gz and non-.gz variants for each candidate
  const pointsChecks = DATA_CONFIG.POINTS_FILES.map(candidate => {
    const pointsUrl = resolveUrl(baseUrl, candidate);
    const pointsGzUrl = pointsUrl + '.gz';
    return Promise.all([
      urlExists(pointsGzUrl).then(exists => ({ candidate, gz: true, exists })),
      urlExists(pointsUrl).then(exists => ({ candidate, gz: false, exists }))
    ]);
  });

  // Check required files in parallel
  const requiredChecks = DATA_CONFIG.REQUIRED_FILES.map(file => {
    const url = resolveUrl(baseUrl, file);
    return urlExists(url).then(exists => ({ file, exists }));
  });

  // Wait for all checks to complete in parallel
  const [pointsResults, requiredResults] = await Promise.all([
    Promise.all(pointsChecks),
    Promise.all(requiredChecks)
  ]);

  // Find the highest priority points file that exists (3D > 2D > 1D, prefer .gz)
  for (const [gzResult, plainResult] of pointsResults) {
    if (gzResult.exists) {
      pointsFile = gzResult.candidate + '.gz';
      break;
    } else if (plainResult.exists) {
      pointsFile = plainResult.candidate;
      break;
    }
  }

  if (!pointsFile) {
    missing.push('points_Xd.bin (at least one of: ' + DATA_CONFIG.POINTS_FILES.join(', ') + ')');
  }

  // Collect missing required files
  for (const result of requiredResults) {
    if (!result.exists) {
      missing.push(result.file);
    }
  }

  return {
    valid: missing.length === 0,
    missing,
    pointsFile
  };
}

function invalidDatasetIdentity(message, sourceType, details = {}) {
  return new DataSourceError(
    `Invalid dataset_identity.json: ${message}`,
    DataSourceErrorCode.INVALID_FORMAT,
    sourceType,
    details
  );
}

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, required, optional, label, sourceType) {
  if (!isPlainRecord(value)) {
    throw invalidDatasetIdentity(
      `${label} must be an object`,
      sourceType,
      { label, value }
    );
  }

  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw invalidDatasetIdentity(
        `${label} is missing required field '${key}'`,
        sourceType,
        { label, key }
      );
    }
  }

  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw invalidDatasetIdentity(
        `${label} contains unsupported field '${key}'`,
        sourceType,
        { label, key }
      );
    }
  }
}

function requireNonEmptyString(value, label, sourceType) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidDatasetIdentity(
      `${label} must be a non-empty string`,
      sourceType,
      { label, value }
    );
  }
}

/**
 * Validate one exact dataset id shared by catalogs, identities, manager
 * selections, and browser URL publication.
 *
 * @param {unknown} value
 * @param {string} [label]
 * @returns {string}
 */
export function validateDatasetId(value, label = 'Dataset id') {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(
      `${label} must be one non-empty, unpadded string without control characters.`
    );
  }
  return value;
}

function requireCount(value, label, sourceType) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalidDatasetIdentity(
      `${label} must be a non-negative safe integer`,
      sourceType,
      { label, value }
    );
  }
}

function requireIdentityPayloadPath(value, label, sourceType) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#') ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.split('/').some(part => part.length === 0)
  ) {
    throw invalidDatasetIdentity(
      `${label} must be a safe relative file path`,
      sourceType,
      { label, value }
    );
  }
  for (const part of value.split('/')) {
    let decoded;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      throw invalidDatasetIdentity(
        `${label} must be a safe relative file path`,
        sourceType,
        { label, value }
      );
    }
    if (
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('%') ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      /[\u0000-\u001f\u007f]/.test(decoded) ||
      encodeURIComponent(decoded) !== part
    ) {
      throw invalidDatasetIdentity(
        `${label} must be a safe relative file path`,
        sourceType,
        { label, value }
      );
    }
  }
}

function validateIdentityStats(stats, sourceType) {
  const countKeys = [
    'n_cells',
    'n_genes',
    'n_obs_fields',
    'n_categorical_fields',
    'n_continuous_fields',
  ];
  assertExactKeys(
    stats,
    [...countKeys, 'has_connectivity', 'n_edges'],
    [],
    'stats',
    sourceType
  );
  for (const key of countKeys) {
    requireCount(stats[key], `stats.${key}`, sourceType);
  }
  if (
    stats.n_obs_fields !==
    stats.n_categorical_fields + stats.n_continuous_fields
  ) {
    throw invalidDatasetIdentity(
      'stats.n_obs_fields must equal categorical plus continuous fields',
      sourceType,
      {
        n_obs_fields: stats.n_obs_fields,
        n_categorical_fields: stats.n_categorical_fields,
        n_continuous_fields: stats.n_continuous_fields,
      }
    );
  }
  if (typeof stats.has_connectivity !== 'boolean') {
    throw invalidDatasetIdentity(
      'stats.has_connectivity must be a boolean',
      sourceType,
      { value: stats.has_connectivity }
    );
  }
  if (stats.has_connectivity) {
    requireCount(stats.n_edges, 'stats.n_edges', sourceType);
  } else if (stats.n_edges !== null) {
    throw invalidDatasetIdentity(
      'stats.n_edges must be null when has_connectivity is false',
      sourceType,
      { value: stats.n_edges }
    );
  }
}

function validateIdentityEmbeddings(embeddings, sourceType) {
  assertExactKeys(
    embeddings,
    ['available_dimensions', 'default_dimension', 'files'],
    [],
    'embeddings',
    sourceType
  );
  const dimensions = embeddings.available_dimensions;
  if (!Array.isArray(dimensions) || dimensions.length === 0) {
    throw invalidDatasetIdentity(
      'embeddings.available_dimensions must be a non-empty array',
      sourceType
    );
  }
  const dimensionSet = new Set();
  for (let index = 0; index < dimensions.length; index++) {
    const dimension = dimensions[index];
    if (
      !Number.isSafeInteger(dimension) ||
      dimension < 1 ||
      dimension > 3 ||
      dimensionSet.has(dimension) ||
      (index > 0 && dimensions[index - 1] >= dimension)
    ) {
      throw invalidDatasetIdentity(
        'embeddings.available_dimensions must contain strictly increasing unique 1D, 2D, or 3D integers',
        sourceType,
        { dimensions }
      );
    }
    dimensionSet.add(dimension);
  }
  if (
    !Number.isSafeInteger(embeddings.default_dimension) ||
    !dimensionSet.has(embeddings.default_dimension)
  ) {
    throw invalidDatasetIdentity(
      'embeddings.default_dimension must be one of the available dimensions',
      sourceType,
      {
        default_dimension: embeddings.default_dimension,
        available_dimensions: dimensions,
      }
    );
  }

  const files = embeddings.files;
  if (!isPlainRecord(files)) {
    throw invalidDatasetIdentity(
      'embeddings.files must be an object',
      sourceType
    );
  }
  const expectedFileKeys = dimensions.map(dimension => `${dimension}d`);
  const actualFileKeys = Object.keys(files);
  if (
    actualFileKeys.length !== expectedFileKeys.length ||
    actualFileKeys.some(key => !expectedFileKeys.includes(key))
  ) {
    throw invalidDatasetIdentity(
      'embeddings.files must contain exactly one path per available dimension',
      sourceType,
      { expected: expectedFileKeys, actual: actualFileKeys }
    );
  }
  for (const key of expectedFileKeys) {
    requireIdentityPayloadPath(
      files[key],
      `embeddings.files.${key}`,
      sourceType
    );
  }

}

function validateIdentityExportSettings(settings, sourceType) {
  assertExactKeys(
    settings,
    [
      'compression',
      'var_quantization',
      'obs_continuous_quantization',
      'obs_categorical_dtype',
    ],
    [],
    'export_settings',
    sourceType
  );
  if (
    settings.compression !== null &&
    (
      !Number.isSafeInteger(settings.compression) ||
      settings.compression < 1 ||
      settings.compression > 9
    )
  ) {
    throw invalidDatasetIdentity(
      'export_settings.compression must be null or an integer from 1 to 9',
      sourceType
    );
  }
  for (const key of [
    'var_quantization',
    'obs_continuous_quantization',
  ]) {
    if (
      settings[key] !== null &&
      settings[key] !== 8 &&
      settings[key] !== 16
    ) {
      throw invalidDatasetIdentity(
        `export_settings.${key} must be null, 8, or 16`,
        sourceType
      );
    }
  }
  if (
    settings.obs_categorical_dtype !== 'uint8' &&
    settings.obs_categorical_dtype !== 'uint16'
  ) {
    throw invalidDatasetIdentity(
      'export_settings.obs_categorical_dtype must be uint8 or uint16',
      sourceType
    );
  }
}

function validateIdentitySource(source, sourceType) {
  assertExactKeys(
    source,
    ['name'],
    ['url', 'citation', 'filename'],
    'source',
    sourceType
  );
  requireNonEmptyString(source.name, 'source.name', sourceType);
  for (const key of ['url', 'citation', 'filename']) {
    if (Object.hasOwn(source, key)) {
      requireNonEmptyString(
        source[key],
        `source.${key}`,
        sourceType
      );
    }
  }
}

/**
 * The sole `vector_fields` rule.
 *
 * `dataset_identity.json["vector_fields"]` is validated here and nowhere else,
 * so the hosted-catalog reader, the local prepared-export reader, and the
 * runtime VectorFieldManager cannot drift apart. Every rule below is stated by
 * the output format specification:
 *
 * - `vector_fields` holds exactly `default_field` and `fields`, and `fields`
 *   is a non-empty object;
 * - a field entry holds exactly `label`, `basis`, `available_dimensions`,
 *   `default_dimension`, and `files` — `files` is the only path map an export
 *   may declare;
 * - `available_dimensions` is strictly increasing over 1/2/3 and, when the
 *   dataset's embedding dimensions are known, a subset of them: a vector field
 *   cannot advertise a dimension the dataset has no points file for;
 * - `files` holds exactly one path per advertised dimension;
 * - `default_dimension` is the **largest** advertised dimension, not merely one
 *   of them. This is where the vector rule is strictly tighter than
 *   `embeddings.default_dimension`, which accepts any available dimension.
 *
 * @param {unknown} vectorFields
 * @param {{availableDimensions?: number[]|null, sourceType?: string}} [options]
 *   `availableDimensions` is the dataset's `embeddings.available_dimensions`,
 *   or null for a caller that has no embeddings context.
 * @returns {Object} the validated vector_fields object
 */
export function validateVectorFieldsMetadata(vectorFields, options = {}) {
  const {
    availableDimensions = null,
    sourceType = undefined,
  } = options;
  assertExactKeys(
    vectorFields,
    ['default_field', 'fields'],
    [],
    'vector_fields',
    sourceType
  );
  if (
    !isPlainRecord(vectorFields.fields) ||
    Object.keys(vectorFields.fields).length === 0
  ) {
    throw invalidDatasetIdentity(
      'vector_fields.fields must be a non-empty object',
      sourceType
    );
  }
  if (vectorFields.default_field !== null) {
    requireNonEmptyString(
      vectorFields.default_field,
      'vector_fields.default_field',
      sourceType
    );
    if (!Object.hasOwn(
      vectorFields.fields,
      vectorFields.default_field
    )) {
      throw invalidDatasetIdentity(
        'vector_fields.default_field must be null or name a declared field',
        sourceType
      );
    }
  }
  for (const [fieldId, field] of Object.entries(vectorFields.fields)) {
    requireNonEmptyString(
      fieldId,
      'vector field id',
      sourceType
    );
    const label = `vector_fields.fields.${fieldId}`;
    assertExactKeys(
      field,
      [
        'label',
        'basis',
        'available_dimensions',
        'default_dimension',
        'files',
      ],
      [],
      label,
      sourceType
    );
    requireNonEmptyString(field.label, `${label}.label`, sourceType);
    requireNonEmptyString(field.basis, `${label}.basis`, sourceType);

    const dimensions = field.available_dimensions;
    if (!Array.isArray(dimensions) || dimensions.length === 0) {
      throw invalidDatasetIdentity(
        `${label}.available_dimensions must be a non-empty array`,
        sourceType
      );
    }
    const dimensionSet = new Set();
    for (let index = 0; index < dimensions.length; index++) {
      const dimension = dimensions[index];
      if (
        !Number.isSafeInteger(dimension) ||
        dimension < 1 ||
        dimension > 3 ||
        dimensionSet.has(dimension) ||
        (index > 0 && dimensions[index - 1] >= dimension)
      ) {
        throw invalidDatasetIdentity(
          `${label}.available_dimensions must contain strictly increasing ` +
          'unique 1D, 2D, or 3D integers',
          sourceType,
          { dimensions }
        );
      }
      dimensionSet.add(dimension);
    }
    if (
      Array.isArray(availableDimensions) &&
      dimensions.some(dimension => !availableDimensions.includes(dimension))
    ) {
      throw invalidDatasetIdentity(
        `${label}.available_dimensions must be a subset of ` +
        'embeddings.available_dimensions',
        sourceType,
        { dimensions, availableDimensions }
      );
    }
    if (field.default_dimension !== dimensions[dimensions.length - 1]) {
      throw invalidDatasetIdentity(
        `${label}.default_dimension must be the largest advertised dimension`,
        sourceType,
        {
          default_dimension: field.default_dimension,
          available_dimensions: dimensions,
        }
      );
    }

    const files = field.files;
    if (!isPlainRecord(files)) {
      throw invalidDatasetIdentity(
        `${label}.files must be an object`,
        sourceType
      );
    }
    const expectedFileKeys = dimensions.map(dimension => `${dimension}d`);
    const actualFileKeys = Object.keys(files);
    if (
      actualFileKeys.length !== expectedFileKeys.length ||
      actualFileKeys.some(key => !expectedFileKeys.includes(key))
    ) {
      throw invalidDatasetIdentity(
        `${label}.files must contain exactly one path per advertised dimension`,
        sourceType,
        { expected: expectedFileKeys, actual: actualFileKeys }
      );
    }
    for (const key of expectedFileKeys) {
      requireIdentityPayloadPath(
        files[key],
        `${label}.files.${key}`,
        sourceType
      );
    }
  }
  return vectorFields;
}

function validateIdentityObsFields(obsFields, stats, sourceType) {
  if (!Array.isArray(obsFields)) {
    throw invalidDatasetIdentity(
      'obs_fields must be an array',
      sourceType
    );
  }
  if (obsFields.length !== stats.n_obs_fields) {
    throw invalidDatasetIdentity(
      'obs_fields length must equal stats.n_obs_fields',
      sourceType,
      { actual: obsFields.length, expected: stats.n_obs_fields }
    );
  }

  const keys = new Set();
  let categoricalCount = 0;
  let continuousCount = 0;
  for (let index = 0; index < obsFields.length; index++) {
    const field = obsFields[index];
    const label = `obs_fields[${index}]`;
    if (!isPlainRecord(field)) {
      throw invalidDatasetIdentity(
        `${label} must be an object`,
        sourceType
      );
    }
    if (field.kind === 'category') {
      assertExactKeys(
        field,
        ['key', 'kind', 'n_categories'],
        [],
        label,
        sourceType
      );
      requireCount(
        field.n_categories,
        `${label}.n_categories`,
        sourceType
      );
      categoricalCount++;
    } else if (field.kind === 'continuous') {
      assertExactKeys(
        field,
        ['key', 'kind'],
        [],
        label,
        sourceType
      );
      continuousCount++;
    } else {
      throw invalidDatasetIdentity(
        `${label}.kind must be 'category' or 'continuous'`,
        sourceType,
        { value: field.kind }
      );
    }
    requireNonEmptyString(field.key, `${label}.key`, sourceType);
    if (keys.has(field.key)) {
      throw invalidDatasetIdentity(
        `obs_fields contains duplicate key '${field.key}'`,
        sourceType,
        { key: field.key }
      );
    }
    keys.add(field.key);
  }
  if (
    categoricalCount !== stats.n_categorical_fields ||
    continuousCount !== stats.n_continuous_fields
  ) {
    throw invalidDatasetIdentity(
      'obs_fields kinds must agree with categorical and continuous stats',
      sourceType,
      {
        categoricalCount,
        continuousCount,
        expectedCategorical: stats.n_categorical_fields,
        expectedContinuous: stats.n_continuous_fields,
      }
    );
  }
}

/**
 * Validate the sole current dataset_identity.json v2 contract.
 *
 * @param {unknown} identity
 * @param {string} datasetId
 * @param {string} [sourceType]
 * @returns {Object}
 */
export function validateDatasetIdentity(
  identity,
  datasetId,
  sourceType
) {
  try {
    validateDatasetId(datasetId, 'Catalog dataset id');
  } catch (error) {
    throw invalidDatasetIdentity(
      error.message,
      sourceType,
      { datasetId }
    );
  }
  assertExactKeys(
    identity,
    [
      'version',
      'id',
      'name',
      'description',
      'cellucid_data_version',
      'stats',
      'embeddings',
      'obs_fields',
    ],
    [
      'created_at',
      'export_settings',
      'source',
      'vector_fields',
    ],
    'dataset identity',
    sourceType
  );
  validateSchemaVersion(
    identity.version,
    DATA_CONFIG.SUPPORTED_IDENTITY_VERSIONS,
    'dataset_identity.json'
  );
  requireNonEmptyString(identity.name, 'name', sourceType);
  if (typeof identity.description !== 'string') {
    throw invalidDatasetIdentity(
      'description must be a string',
      sourceType,
      { value: identity.description }
    );
  }
  requireNonEmptyString(
    identity.cellucid_data_version,
    'cellucid_data_version',
    sourceType
  );

  try {
    validateDatasetId(identity.id, 'Dataset identity id');
  } catch (error) {
    throw invalidDatasetIdentity(
      error.message,
      sourceType,
      { value: identity.id }
    );
  }
  if (identity.id !== datasetId) {
    throw invalidDatasetIdentity(
      `id '${identity.id}' does not match catalog id '${datasetId}'`,
      sourceType,
      { identityId: identity.id, datasetId }
    );
  }

  validateIdentityStats(identity.stats, sourceType);
  validateIdentityEmbeddings(identity.embeddings, sourceType);
  validateIdentityObsFields(
    identity.obs_fields,
    identity.stats,
    sourceType
  );

  if (Object.hasOwn(identity, 'created_at')) {
    if (
      typeof identity.created_at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(
        identity.created_at
      ) ||
      !Number.isFinite(Date.parse(identity.created_at)) ||
      new Date(identity.created_at).toISOString().replace('.000Z', 'Z') !==
        identity.created_at
    ) {
      throw invalidDatasetIdentity(
        'created_at must be a valid UTC timestamp',
        sourceType,
        { value: identity.created_at }
      );
    }
  }
  if (Object.hasOwn(identity, 'export_settings')) {
    validateIdentityExportSettings(
      identity.export_settings,
      sourceType
    );
  }
  if (Object.hasOwn(identity, 'source')) {
    validateIdentitySource(identity.source, sourceType);
  }
  if (Object.hasOwn(identity, 'vector_fields')) {
    validateVectorFieldsMetadata(identity.vector_fields, {
      availableDimensions: identity.embeddings.available_dimensions,
      sourceType,
    });
  }
  return identity;
}

/**
 * Load and validate exact metadata from dataset_identity.json.
 * @param {string} baseUrl - Base URL of the dataset
 * @param {string} datasetId - Dataset identifier
 * @param {string} [sourceType] - Source type for context
 * @param {{signal?: AbortSignal|null}} [options] - Exact request owner
 * @returns {Promise<DatasetMetadata>}
 */
export async function loadDatasetMetadata(
  baseUrl,
  datasetId,
  sourceType,
  options = {}
) {
  const signal = getMetadataLoadSignal(
    options,
    'Dataset metadata loader'
  );
  // Try to load dataset_identity.json first
  const identityUrl = resolveUrl(baseUrl, DATA_CONFIG.DATASET_IDENTITY_FILE);

  try {
    const identity = await fetchJson(
      identityUrl,
      sourceType,
      { signal }
    );
    throwIfMetadataAborted(signal, 'Dataset metadata loading');
    validateDatasetIdentity(identity, datasetId, sourceType);
    return { ...identity, id: datasetId };
  } catch (err) {
    throwIfMetadataAborted(signal, 'Dataset metadata loading');
    if (err instanceof DataSourceError && err.code === DataSourceErrorCode.NOT_FOUND) {
      throw new DataSourceError(
        'Missing required dataset_identity.json',
        DataSourceErrorCode.INVALID_FORMAT,
        sourceType,
        { datasetId, baseUrl, identityUrl }
      );
    }
    throw err;
  }
}

/**
 * Format a cell/gene count for display (e.g., 162259 -> "162K")
 * Named specifically to avoid collision with benchmark.js formatNumber
 * @param {number} n - Number to format
 * @returns {string}
 */
export function formatCellCount(n) {
  if (n == null) return '–';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(0) + 'K';
  return String(n);
}

/**
 * Check if a URL uses the local-user:// protocol
 * @param {string} url - URL to check
 * @returns {boolean}
 */
export function isLocalUserUrl(url) {
  return url?.startsWith('local-user://');
}

/**
 * Parse a local-user:// URL into its components
 * @param {string} url - URL to parse
 * @returns {{datasetId: string, filename: string}|null}
 */
export function parseLocalUserUrl(url) {
  if (!isLocalUserUrl(url)) return null;
  const match = url.match(/^local-user:\/\/([^/]+)\/(.*)$/);
  if (!match) return null;
  return { datasetId: match[1], filename: match[2] };
}

/**
 * Data Source Interface Documentation
 *
 * This module uses duck typing - data sources don't need to extend a base class.
 * Any object implementing the following methods can be used as a data source:
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * REQUIRED METHODS (must implement)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * getType(): string
 *   Returns the source type identifier (e.g., 'local-demo', 'local-user', 'remote', 'jupyter')
 *
 * listDatasets(): Promise<DatasetMetadata[]>
 *   Lists all available datasets from this source
 *
 * getMetadata(datasetId): Promise<DatasetMetadata>
 *   Gets full metadata for a specific dataset
 *
 * getBaseUrl(datasetId): string
 *   Gets the base URL for loading dataset files. May return custom protocol URLs
 *   (e.g., 'local-user://datasetId/', 'remote://host/path/', 'jupyter://kernel/')
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * OPTIONAL METHODS (recommended)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * isAvailable(): Promise<boolean>
 *   Checks if the source is available/accessible (default: true)
 *
 * hasDataset(datasetId): Promise<boolean>
 *   Checks if a specific dataset exists
 *
 * refresh(): void
 *   Clears any cached data (manifests, metadata, etc.)
 *
 * requiresManualReconnect(): boolean
 *   Returns true if this source cannot be auto-restored from saved state
 *   (e.g., user directories require re-selection due to browser security,
 *    remote servers may need re-authentication)
 *
 * resolveUrl(url): Promise<string>
 *   Resolves a custom protocol URL (e.g., 'local-user://...') to a fetchable URL
 *   Called by DataSourceManager.resolveUrl() for protocol handling
 *
 * getFileUrl(filename): Promise<string>
 *   Gets a fetchable URL for a specific file within the current dataset
 *   Useful for sources that need to create Object URLs or signed URLs
 *
 * onDeactivate(): void
 *   Called when switching away from this source. Use for cleanup like:
 *   - Revoking Object URLs
 *   - Closing connections
 *   - Clearing temporary caches
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * REMOTE SERVER SOURCE INTERFACE (future: RemoteDataSource)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * For sources that connect to remote servers (SSH tunnels, WebSocket APIs):
 *
 * connect(config): Promise<void>
 *   Establish connection to remote server
 *   @param config - Connection configuration (host, port, credentials, etc.)
 *
 * disconnect(): void
 *   Close connection cleanly
 *
 * isConnected(): boolean
 *   Check if currently connected
 *
 * getConnectionInfo(): {host: string, port: number, status: string}
 *   Get current connection details for debugging/display
 *
 * onConnectionLost(callback): void
 *   Register callback for connection loss events (for auto-reconnect UI)
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * JUPYTER BRIDGE SOURCE INTERFACE (future: JupyterBridgeDataSource)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * For sources that communicate with a Jupyter kernel via the cellucid-data package:
 *
 * connectToKernel(kernelId): Promise<void>
 *   Connect to a specific Jupyter kernel
 *
 * sendCommand(command, params): Promise<any>
 *   Send a command to the Python side (e.g., recompute, filter, export)
 *
 * onMessage(callback): void
 *   Register callback for messages from Python side (updates, progress, errors)
 *
 * getKernelStatus(): {kernelId: string, status: 'idle'|'busy'|'disconnected'}
 *   Get current kernel connection status
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * STREAMING/CHUNKED DATA INTERFACE (future extension)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * For large datasets that need progressive loading:
 *
 * supportsStreaming(): boolean
 *   Returns true if this source supports chunked/streaming data
 *
 * loadChunk(datasetId, chunkSpec): Promise<ArrayBuffer>
 *   Load a specific chunk of data (e.g., range of points, subset of genes)
 *   @param chunkSpec - {type: 'points'|'obs'|'var', offset: number, limit: number}
 *
 * getChunkManifest(datasetId): Promise<ChunkManifest>
 *   Get information about available chunks for progressive loading
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * PROTOCOL REGISTRATION
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Data sources using custom URL protocols should register them with DataSourceManager:
 *
 *   const manager = getDataSourceManager();
 *   manager.registerSource('remote', remoteSource);
 *   manager.registerProtocol('remote://', 'remote');
 *
 * This allows data-loaders.js to automatically resolve URLs like:
 *   'remote://server.example.com/dataset/points_3d.bin'
 */

/**
 * Example base class showing the interface (not required to extend)
 * @abstract
 */
export class BaseDataSource {
  constructor() {
    if (new.target === BaseDataSource) {
      throw new Error('BaseDataSource is abstract - use duck typing instead');
    }
  }

  /** @returns {string} */
  getType() {
    throw new Error('getType() must be implemented');
  }

  /** @returns {Promise<boolean>} */
  async isAvailable() {
    return true;
  }

  /** @returns {Promise<DatasetMetadata[]>} */
  async listDatasets() {
    throw new Error('listDatasets() must be implemented');
  }

  /** @param {string} _datasetId @returns {Promise<DatasetMetadata>} */
  async getMetadata(_datasetId) {
    throw new Error('getMetadata() must be implemented');
  }

  /** @param {string} _datasetId @returns {string} */
  getBaseUrl(_datasetId) {
    throw new Error('getBaseUrl() must be implemented');
  }

  /**
   * Whether this source requires manual reconnection (cannot be auto-restored from saved state).
   * Override this in sources like local-user or remote servers that need re-authentication.
   * @returns {boolean}
   */
  requiresManualReconnect() {
    return false;
  }
}
