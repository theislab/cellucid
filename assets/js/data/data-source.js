/**
 * Data Source Interface and Base Utilities
 *
 * Provides a unified abstraction for data access that allows the app
 * to work with different data backends (local demo, user directory, remote server, Jupyter).
 */

/**
 * @typedef {Object} DatasetStats
 * @property {number} n_cells - Number of cells/points
 * @property {number} [n_genes] - Number of genes (if available)
 * @property {number} [n_obs_fields] - Number of observation fields
 * @property {number} [n_categorical_fields] - Number of categorical fields
 * @property {number} [n_continuous_fields] - Number of continuous fields
 * @property {boolean} [has_connectivity] - Whether KNN data exists
 * @property {number} [n_edges] - Number of edges (if connectivity exists)
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
 * @property {string} obs_categorical_dtype - Categorical dtype ('auto', 'uint8', 'uint16')
 */

/**
 * @typedef {Object} DatasetSource
 * @property {string} [name] - Source name
 * @property {string} [url] - Source URL
 * @property {string} [citation] - Citation text
 */

/**
 * @typedef {Object} DatasetMetadata
 * @property {string} id - Unique identifier (directory name)
 * @property {string} name - Human-readable display name
 * @property {string} [description] - Optional description
 * @property {string} [created_at] - ISO timestamp of export
 * @property {string} [cellucid_data_version] - Version of cellucid-data used
 * @property {DatasetStats} stats - Dataset statistics
 * @property {DatasetObsField[]} [obs_fields] - List of observation fields
 * @property {DatasetExportSettings} [export_settings] - Export configuration
 * @property {DatasetSource} [source] - Data source information
 */

/**
 * Configuration constants for data loading
 */
export const DATA_CONFIG = {
  // Base paths
  EXPORTS_BASE_URL: 'assets/exports/',
  DATASETS_MANIFEST: 'datasets.json',

  // Required files for a valid dataset
  REQUIRED_FILES: [
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
  INVALID_FORMAT: 'INVALID_FORMAT',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  NETWORK_ERROR: 'NETWORK_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNSUPPORTED: 'UNSUPPORTED'
};

/**
 * User-friendly error messages
 */
export const ERROR_MESSAGES = {
  [DataSourceErrorCode.NOT_FOUND]: 'Dataset not found. Check that the directory exists.',
  [DataSourceErrorCode.INVALID_FORMAT]: 'Invalid dataset format. Missing required files.',
  [DataSourceErrorCode.PERMISSION_DENIED]: 'Cannot access directory. Please grant permission.',
  [DataSourceErrorCode.NETWORK_ERROR]: 'Failed to load dataset. Check your connection.',
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
  try {
    const baseUrl = base ? new URL(base, window.location.href) : new URL(window.location.href);
    return new URL(relative, baseUrl).toString();
  } catch (_err) {
    // Fallback for simple path joining
    const baseClean = base.endsWith('/') ? base : base + '/';
    return baseClean + relative;
  }
}

/**
 * Check if a URL exists (returns ok status)
 * @param {string} url - URL to check
 * @returns {Promise<boolean>}
 */
export async function urlExists(url) {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    if (response.ok) return true;
    // Some servers don't support HEAD, try GET with minimal data transfer
    if (response.status === 405 || response.status === 501) {
      // Use Range header to request only 1 byte, and abort after headers received
      // fetch() resolves once headers arrive, so we can check status then abort to skip body
      const controller = new AbortController();
      const getResponse = await fetch(url, {
        headers: { 'Range': 'bytes=0-0' },
        signal: controller.signal
      });
      const exists = getResponse.ok || getResponse.status === 206;
      // Abort to prevent downloading body data (we only needed headers)
      controller.abort();
      return exists;
    }
    return false;
  } catch (_err) {
    return false;
  }
}

/**
 * Fetch JSON data from a URL with error handling
 * @param {string} url - URL to fetch
 * @param {string} [sourceType] - Source type for error context
 * @returns {Promise<any>}
 */
export async function fetchJson(url, sourceType) {
  try {
    const response = await fetch(url);
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
    return response.json();
  } catch (err) {
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

/**
 * Load dataset metadata from dataset_identity.json or construct from manifests
 * @param {string} baseUrl - Base URL of the dataset
 * @param {string} datasetId - Dataset identifier
 * @param {string} [sourceType] - Source type for context
 * @returns {Promise<DatasetMetadata>}
 */
export async function loadDatasetMetadata(baseUrl, datasetId, sourceType) {
  // Try to load dataset_identity.json first
  const identityUrl = resolveUrl(baseUrl, DATA_CONFIG.DATASET_IDENTITY_FILE);

  try {
    const identity = await fetchJson(identityUrl, sourceType);

    // Validate identity version
    validateSchemaVersion(
      identity.version,
      DATA_CONFIG.SUPPORTED_IDENTITY_VERSIONS,
      'dataset_identity.json'
    );

    return {
      id: datasetId,
      name: identity.name || datasetId,
      description: identity.description || '',
      created_at: identity.created_at,
      cellucid_data_version: identity.cellucid_data_version,
      stats: identity.stats || { n_cells: 0 },
      obs_fields: identity.obs_fields || [],
      export_settings: identity.export_settings || {},
      source: identity.source || {}
    };
  } catch (err) {
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
