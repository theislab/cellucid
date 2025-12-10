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

  // Legacy support - if no datasets.json, treat exports/ as single dataset
  LEGACY_MODE_FALLBACK: true,

  // Default dataset ID for legacy mode
  LEGACY_DATASET_ID: '__legacy__',

  // Supported schema versions
  SUPPORTED_MANIFEST_VERSIONS: [1],
  SUPPORTED_IDENTITY_VERSIONS: [1, 2]
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
    // Allow missing version for backward compatibility, but warn
    console.warn(`[DataSource] No version field in ${context}, assuming version 1`);
    return;
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
    // Some servers don't support HEAD, try GET
    if (response.status === 405 || response.status === 501) {
      const getResponse = await fetch(url);
      return getResponse.ok;
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

  // Check for dimensional points files (3D preferred, then 2D, then 1D)
  for (const candidate of DATA_CONFIG.POINTS_FILES) {
    const pointsUrl = resolveUrl(baseUrl, candidate);
    const pointsGzUrl = pointsUrl + '.gz';

    if (await urlExists(pointsGzUrl)) {
      pointsFile = candidate + '.gz';
      break;
    } else if (await urlExists(pointsUrl)) {
      pointsFile = candidate;
      break;
    }
  }

  if (!pointsFile) {
    missing.push('points_Xd.bin (at least one of: ' + DATA_CONFIG.POINTS_FILES.join(', ') + ')');
  }

  // Check required files
  for (const file of DATA_CONFIG.REQUIRED_FILES) {
    const url = resolveUrl(baseUrl, file);
    if (!await urlExists(url)) {
      missing.push(file);
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
    // Fallback: construct minimal metadata from obs_manifest.json
    console.log(`[DataSource] No dataset_identity.json found, constructing from manifests...`);

    try {
      const obsManifestUrl = resolveUrl(baseUrl, 'obs_manifest.json');
      const obsManifest = await fetchJson(obsManifestUrl, sourceType);

      // Try to get gene count from var_manifest
      let n_genes = 0;
      try {
        const varManifestUrl = resolveUrl(baseUrl, 'var_manifest.json');
        const varManifest = await fetchJson(varManifestUrl, sourceType);
        n_genes = varManifest.fields?.length || 0;
      } catch (_) {
        // No var manifest
      }

      // Check for connectivity
      let has_connectivity = false;
      let n_edges = 0;
      try {
        const connManifestUrl = resolveUrl(baseUrl, 'connectivity_manifest.json');
        const connManifest = await fetchJson(connManifestUrl, sourceType);
        has_connectivity = true;
        n_edges = connManifest.n_edges || 0;
      } catch (_) {
        // No connectivity
      }

      // Count field types from expanded manifest
      const fields = obsManifest.fields || [];
      const categoricalCount = fields.filter(f => f.kind === 'category').length;
      const continuousCount = fields.filter(f => f.kind === 'continuous').length;

      return {
        id: datasetId,
        name: datasetId,
        description: '',
        stats: {
          n_cells: obsManifest.n_points || 0,
          n_genes,
          n_obs_fields: fields.length,
          n_categorical_fields: categoricalCount,
          n_continuous_fields: continuousCount,
          has_connectivity,
          n_edges
        },
        obs_fields: fields.map(f => ({
          key: f.key,
          kind: f.kind,
          n_categories: f.categories?.length
        })),
        export_settings: {
          compression: obsManifest.compression,
          obs_continuous_quantization: obsManifest._obsSchemas?.continuous?.quantizationBits || null
        }
      };
    } catch (manifestErr) {
      throw new DataSourceError(
        `Could not load dataset metadata: ${manifestErr.message}`,
        DataSourceErrorCode.INVALID_FORMAT,
        sourceType,
        { datasetId, baseUrl }
      );
    }
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
