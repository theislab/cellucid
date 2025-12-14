/**
 * LocalUserDirDataSource - Data source for user-selected local directories
 *
 * Uses standard file input with webkitdirectory attribute for cross-browser support.
 * All processing happens client-side - no data is uploaded to external servers.
 */

import {
  DATA_CONFIG,
  DataSourceError,
  DataSourceErrorCode,
  isLocalUserUrl,
  parseLocalUserUrl,
  validateSchemaVersion
} from './data-source.js';
import { expandObsManifest, expandVarManifest } from './data-loaders.js';
import { isH5adFile, createH5adLoader } from './h5ad-loader.js';
import { H5adDataSource, createH5adDataSource } from './h5ad-source.js';
import { isZarrDirectory, createZarrLoader } from './zarr-loader.js';
import { ZarrDataSource, createZarrDataSource } from './zarr-source.js';
import { getNotificationCenter } from '../app/notification-center.js';

/**
 * @typedef {import('./data-source.js').DatasetMetadata} DatasetMetadata
 */

/**
 * Simple string hash for generating stable dataset IDs.
 * Uses djb2 algorithm - fast and produces reasonably distributed hashes.
 * @param {string} str - String to hash
 * @returns {string} Hex hash string
 */
function hashString(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  // Convert to unsigned 32-bit and then to hex
  return (hash >>> 0).toString(16);
}

/**
 * Data source for user-selected local directories
 */
export class LocalUserDirDataSource {
  constructor() {
    /** @type {Map<string, File>} Files loaded via file input */
    this._files = new Map();

    /** @type {string|null} */
    this.datasetId = null;

    /** @type {string|null} */
    this.directoryPath = null;

    /** @type {DatasetMetadata|null} */
    this._metadata = null;

    /** @type {Map<string, string>} */
    this._objectUrls = new Map();

    /** @type {H5adDataSource|null} H5AD source for h5ad files */
    this._h5adSource = null;

    /** @type {ZarrDataSource|null} Zarr source for zarr directories */
    this._zarrSource = null;

    /** @type {'directory'|'h5ad'|'zarr'|null} */
    this._sourceMode = null;

    this.type = 'local-user';
  }

  /**
   * Get the type identifier for this data source
   * @returns {string}
   */
  getType() {
    return this.type;
  }

  /**
   * Check if this data source is available (has files loaded)
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    // In h5ad mode, check if h5ad source is available
    if (this._sourceMode === 'h5ad' && this._h5adSource) {
      return this._h5adSource.isAvailable();
    }
    // In zarr mode, check if zarr source is available
    if (this._sourceMode === 'zarr' && this._zarrSource) {
      return this._zarrSource.isAvailable();
    }
    // In directory mode, check if files are loaded
    return this._files.size > 0;
  }

  /**
   * Get the directory path (for display)
   * @returns {string|null}
   */
  getPath() {
    return this.directoryPath;
  }

  /**
   * Load files from a FileList (from <input type="file" webkitdirectory> or single file input)
   * Automatically detects if a single h5ad file or zarr directory is selected
   * @param {FileList} fileList - Files from file input
   * @returns {Promise<DatasetMetadata>}
   */
  async loadFromFileList(fileList) {
    if (!fileList || fileList.length === 0) {
      throw new DataSourceError(
        'No files selected',
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
    }

    // Check if this is a single h5ad file
    const firstFile = fileList[0];
    if (fileList.length === 1 && isH5adFile(firstFile)) {
      return this.loadFromH5adFile(firstFile);
    }

    // Check if this is a zarr directory
    if (isZarrDirectory(fileList)) {
      return this.loadFromZarrDirectory(fileList);
    }

    // Check if any file in the list is an h5ad file (user might have selected h5ad from directory picker)
    for (const file of fileList) {
      if (isH5adFile(file)) {
        // Found an h5ad file, load it directly
        return this.loadFromH5adFile(file);
      }
    }

    // Standard directory loading
    return this._loadFromDirectory(fileList);
  }

  /**
   * Load an h5ad file directly
   * @param {File} file - h5ad file
   * @returns {Promise<DatasetMetadata>}
   */
  async loadFromH5adFile(file) {
    if (!isH5adFile(file)) {
      throw new DataSourceError(
        'Not an h5ad file. Expected .h5ad extension.',
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
    }

    // Clear previous state
    this._cleanup();

    // Create and initialize h5ad source
    this._h5adSource = createH5adDataSource();
    await this._h5adSource.loadFromFile(file);

    this._sourceMode = 'h5ad';
    this.datasetId = this._h5adSource.datasetId;
    this.directoryPath = file.name;
    this._metadata = await this._h5adSource.getMetadata(this.datasetId);

    console.log(`[LocalUserDirDataSource] Loaded h5ad file: ${file.name}`);

    return this._metadata;
  }

  /**
   * Load a zarr directory
   * @param {FileList} fileList - FileList from directory input
   * @returns {Promise<DatasetMetadata>}
   */
  async loadFromZarrDirectory(fileList) {
    if (!isZarrDirectory(fileList)) {
      throw new DataSourceError(
        'Not a zarr directory. Expected .zarr extension or zarr structure files.',
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
    }

    // Clear previous state
    this._cleanup();

    // Create and initialize zarr source
    this._zarrSource = createZarrDataSource();
    await this._zarrSource.loadFromFileList(fileList);

    this._sourceMode = 'zarr';
    this.datasetId = this._zarrSource.datasetId;
    this.directoryPath = this._zarrSource.dirname;
    this._metadata = await this._zarrSource.getMetadata(this.datasetId);

    console.log(`[LocalUserDirDataSource] Loaded zarr directory: ${this.directoryPath}`);

    return this._metadata;
  }

  /**
   * Load from a directory (exported data format)
   * @param {FileList} fileList - Files from directory input
   * @returns {Promise<DatasetMetadata>}
   * @private
   */
  async _loadFromDirectory(fileList) {
    // Clear previous state
    this._cleanup();

    this._sourceMode = 'directory';

    // Extract directory name from the first file's path
    // webkitRelativePath format: "dirname/filename.ext" or "dirname/subdir/filename.ext"
    const firstFile = fileList[0];
    const relativePath = firstFile.webkitRelativePath || firstFile.name;
    const pathParts = relativePath.split('/');
    this.directoryPath = pathParts[0] || 'Selected folder';

    // Generate stable dataset ID using hash of directory path
    // This ensures the same directory always gets the same ID (important for state restoration)
    this.datasetId = `user_${this.directoryPath}_${hashString(relativePath)}`;

    console.log(`[LocalUserDirDataSource] Loading ${fileList.length} files from: ${this.directoryPath}`);

    // Index files by their name (relative to the root directory)
    for (const file of fileList) {
      const relativePath = file.webkitRelativePath || file.name;
      const pathParts = relativePath.split('/');

      // Get filename relative to the root directory
      // For "dirname/obs_manifest.json" -> "obs_manifest.json"
      // For "dirname/obs/field.bin" -> "obs/field.bin"
      const filename = pathParts.slice(1).join('/');

      if (filename) {
        this._files.set(filename, file);
      }
    }

    console.log(`[LocalUserDirDataSource] Indexed ${this._files.size} files`);

    // Validate and load metadata
    await this._validateAndLoadMetadata();

    return this._metadata;
  }

  /**
   * Validate directory structure and load metadata
   * @private
   */
  async _validateAndLoadMetadata() {
    // Check for required files
    const requiredFiles = [...DATA_CONFIG.REQUIRED_FILES];
    const missing = [];

    for (const filename of requiredFiles) {
      const exists = this._fileExists(filename);
      if (!exists) {
        missing.push(filename);
      }
    }

    // Check for dimensional points files (3D preferred, then 2D, then 1D)
    let pointsFile = null;
    for (const candidate of DATA_CONFIG.POINTS_FILES) {
      if (this._fileExists(candidate + '.gz')) {
        pointsFile = candidate + '.gz';
        break;
      } else if (this._fileExists(candidate)) {
        pointsFile = candidate;
        break;
      }
    }
    if (!pointsFile) {
      missing.push('points_Xd.bin (at least one of: ' + DATA_CONFIG.POINTS_FILES.join(', ') + ')');
    }

    if (missing.length > 0) {
      throw new DataSourceError(
        `Invalid dataset: missing required files: ${missing.join(', ')}`,
        DataSourceErrorCode.INVALID_FORMAT,
        this.type,
        { missing }
      );
    }

    // Load metadata from dataset_identity.json or construct from manifests
    await this._loadMetadata(pointsFile);
  }

  /**
   * Check if a file exists
   * @param {string} filename - Filename to check
   * @returns {boolean}
   * @private
   */
  _fileExists(filename) {
    return this._files.has(filename);
  }

  /**
   * Get a File object by filename
   * @param {string} filename - Filename to get
   * @returns {File}
   * @private
   */
  _getFile(filename) {
    const file = this._files.get(filename);
    if (!file) {
      throw new Error(`File not found: ${filename}`);
    }
    return file;
  }

  /**
   * Read a file as text
   * @param {string} filename - Filename to read
   * @returns {Promise<string>}
   * @private
   */
  async _readFileAsText(filename) {
    const file = this._getFile(filename);
    return file.text();
  }

  /**
   * Read a file as JSON
   * @param {string} filename - Filename to read
   * @returns {Promise<any>}
   * @private
   */
  async _readFileAsJson(filename) {
    const text = await this._readFileAsText(filename);
    return JSON.parse(text);
  }

  /**
   * Load dataset metadata
   * @param {string} pointsFile - Name of the points file (e.g., 'points_3d.bin' or 'points_2d.bin.gz')
   * @private
   */
  async _loadMetadata(pointsFile) {
    // Try to load dataset_identity.json first
    try {
      const identity = await this._readFileAsJson(DATA_CONFIG.DATASET_IDENTITY_FILE);

      // Validate schema version for compatibility
      validateSchemaVersion(
        identity.version,
        DATA_CONFIG.SUPPORTED_IDENTITY_VERSIONS,
        'dataset_identity.json'
      );

      this._metadata = {
        id: this.datasetId,
        name: identity.name || this.directoryPath,
        description: identity.description || '',
        created_at: identity.created_at,
        cellucid_data_version: identity.cellucid_data_version,
        stats: identity.stats || { n_cells: 0 },
        obs_fields: identity.obs_fields || [],
        export_settings: identity.export_settings || {},
        source: identity.source || {},
        pointsFile // Store which points file variant exists
      };
      console.log('[LocalUserDirDataSource] Loaded metadata from dataset_identity.json');
      return;
    } catch (_err) {
      console.log('[LocalUserDirDataSource] No dataset_identity.json, constructing from manifests');
    }

    // Fallback: construct from obs_manifest.json
    const rawObsManifest = await this._readFileAsJson('obs_manifest.json');
    // Expand compact manifest format to verbose format with fields array
    const obsManifest = expandObsManifest(rawObsManifest);

    // Try to get gene count from var_manifest
    let n_genes = 0;
    try {
      const rawVarManifest = await this._readFileAsJson('var_manifest.json');
      const varManifest = expandVarManifest(rawVarManifest);
      n_genes = varManifest.fields?.length || 0;
    } catch (_) {
      // No var manifest
    }

    // Check for connectivity
    let has_connectivity = false;
    let n_edges = 0;
    try {
      const connManifest = await this._readFileAsJson('connectivity_manifest.json');
      has_connectivity = true;
      n_edges = connManifest.n_edges || 0;
    } catch (_) {
      // No connectivity
    }

    // Count field types from expanded manifest
    const fields = obsManifest.fields || [];
    const categoricalCount = fields.filter(f => f.kind === 'category').length;
    const continuousCount = fields.filter(f => f.kind === 'continuous').length;

    this._metadata = {
      id: this.datasetId,
      name: this.directoryPath,
      description: 'User-provided dataset',
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
      },
      pointsFile // Store which points file variant exists
    };
  }

  /**
   * List all available datasets from this source
   * @returns {Promise<DatasetMetadata[]>}
   */
  async listDatasets() {
    if (!this._metadata) {
      return [];
    }
    return [this._metadata];
  }

  /**
   * Get metadata for a specific dataset
   * @param {string} datasetId - Dataset identifier
   * @returns {Promise<DatasetMetadata>}
   */
  async getMetadata(datasetId) {
    if (!this._metadata) {
      throw new DataSourceError(
        'No directory selected',
        DataSourceErrorCode.NOT_FOUND,
        this.type
      );
    }
    // Validate datasetId if provided (future-proofing for multi-directory support)
    if (datasetId && datasetId !== this.datasetId) {
      throw new DataSourceError(
        `Dataset '${datasetId}' not found. Current dataset is '${this.datasetId}'.`,
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        { requestedId: datasetId, currentId: this.datasetId }
      );
    }
    return this._metadata;
  }

  /**
   * Check if a specific dataset exists
   * @param {string} datasetId - Dataset identifier
   * @returns {Promise<boolean>}
   */
  async hasDataset(datasetId) {
    // Local user source only supports one dataset at a time
    return this.datasetId !== null && this.datasetId === datasetId;
  }

  /**
   * Get an object URL for a file (for use with fetch)
   * @param {string} filename - Filename
   * @returns {Promise<string>}
   */
  async getFileUrl(filename) {
    if (this._objectUrls.has(filename)) {
      return this._objectUrls.get(filename);
    }

    const file = this._getFile(filename);
    const url = URL.createObjectURL(file);

    this._objectUrls.set(filename, url);
    return url;
  }

  /**
   * Get the base URL for loading a dataset's files
   * For local user directories, this returns a special protocol identifier
   * that the data loaders need to handle specially.
   * @param {string} [_datasetId] - Dataset identifier (unused, kept for interface consistency)
   * @returns {string}
   */
  getBaseUrl(_datasetId) {
    // In h5ad mode, use h5ad:// protocol
    if (this._sourceMode === 'h5ad' && this._h5adSource) {
      return this._h5adSource.getBaseUrl(this.datasetId);
    }
    // In zarr mode, use zarr:// protocol
    if (this._sourceMode === 'zarr' && this._zarrSource) {
      return this._zarrSource.getBaseUrl(this.datasetId);
    }
    // Return a special marker that data-loaders.js will recognize
    // The actual file loading will use getFileUrl()
    // Note: We use this.datasetId since local-user only supports one dataset at a time
    return `local-user://${this.datasetId}/`;
  }

  /**
   * Resolve a local-user:// URL to a fetchable blob URL
   * @param {string} url - local-user:// URL
   * @returns {Promise<string>} Blob URL for fetching
   */
  async resolveUrl(url) {
    if (!isLocalUserUrl(url)) {
      throw new DataSourceError(
        `Not a local-user URL: ${url}`,
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
    }

    const parsed = parseLocalUserUrl(url);
    if (!parsed) {
      throw new DataSourceError(
        `Invalid local-user URL format: ${url}`,
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
    }

    return this.getFileUrl(parsed.filename);
  }

  // Static URL helper methods are exported from data-source.js:
  // - isLocalUserUrl(url)
  // - parseLocalUserUrl(url)

  /**
   * Cleanup resources
   * @private
   */
  _cleanup() {
    // Revoke object URLs
    for (const url of this._objectUrls.values()) {
      URL.revokeObjectURL(url);
    }
    this._objectUrls.clear();

    // Clean up h5ad source if present
    if (this._h5adSource) {
      this._h5adSource.clear();
      this._h5adSource = null;
    }

    // Clean up zarr source if present
    if (this._zarrSource) {
      this._zarrSource.clear();
      this._zarrSource = null;
    }

    this._files.clear();
    this.datasetId = null;
    this.directoryPath = null;
    this._metadata = null;
    this._sourceMode = null;
  }

  /**
   * Check if data is loaded from h5ad file
   * @returns {boolean}
   */
  isH5adMode() {
    return this._sourceMode === 'h5ad';
  }

  /**
   * Get the h5ad data source (if in h5ad mode)
   * @returns {H5adDataSource|null}
   */
  getH5adSource() {
    return this._h5adSource;
  }

  /**
   * Check if data is loaded from zarr directory
   * @returns {boolean}
   */
  isZarrMode() {
    return this._sourceMode === 'zarr';
  }

  /**
   * Get the zarr data source (if in zarr mode)
   * @returns {ZarrDataSource|null}
   */
  getZarrSource() {
    return this._zarrSource;
  }

  /**
   * Clear the current directory selection
   */
  clear() {
    this._cleanup();
  }

  /**
   * Called when this source is deactivated (switching to another source).
   * Revokes Object URLs and clears h5ad/zarr caches to prevent memory leaks.
   */
  onDeactivate() {
    // Only revoke Object URLs, keep the files in case user switches back
    for (const url of this._objectUrls.values()) {
      URL.revokeObjectURL(url);
    }
    this._objectUrls.clear();

    // MEMORY OPTIMIZATION: Clear h5ad caches when deactivating to free memory
    // The h5ad file itself is retained, but computed caches (gene expressions, etc.) are freed
    if (this._h5adSource) {
      this._h5adSource.clearCaches?.();
    }

    // MEMORY OPTIMIZATION: Clear zarr caches when deactivating to free memory
    if (this._zarrSource) {
      this._zarrSource.clearCaches?.();
    }

    console.log('[LocalUserDirDataSource] Deactivated - revoked Object URLs and cleared caches');
  }

  /**
   * Refresh (re-validate and reload metadata)
   */
  async refresh() {
    // In h5ad mode, metadata is immutable (from h5ad file)
    // No refresh needed - reload would require re-reading the file
    if (this._sourceMode === 'h5ad') {
      console.log('[LocalUserDirDataSource] Refresh not applicable for h5ad mode');
      return;
    }
    // In zarr mode, metadata is immutable (from zarr directory)
    // No refresh needed - reload would require re-reading the files
    if (this._sourceMode === 'zarr') {
      console.log('[LocalUserDirDataSource] Refresh not applicable for zarr mode');
      return;
    }
    // In directory mode, re-validate and reload metadata
    if (this._files.size > 0) {
      await this._validateAndLoadMetadata();
    }
  }

  /**
   * Whether this source requires manual reconnection.
   * Local user directories cannot be auto-restored due to browser security restrictions.
   * @returns {boolean}
   */
  requiresManualReconnect() {
    return true;
  }
}

/**
 * Create a LocalUserDirDataSource instance
 * @returns {LocalUserDirDataSource}
 */
export function createLocalUserDirDataSource() {
  return new LocalUserDirDataSource();
}
