/**
 * LocalDemoDataSource - Data source for demo datasets at an exports base URL
 *
 * Reads datasets.json manifest listing available datasets.
 */

import {
  DATA_CONFIG,
  DataSourceError,
  DataSourceErrorCode,
  fetchJson,
  loadDatasetMetadata,
  resolveUrl,
  validateSchemaVersion
} from './data-source.js';

/**
 * @typedef {import('./data-source.js').DatasetMetadata} DatasetMetadata
 */

/**
 * Data source for demo datasets stored in an exports directory.
 *
 * Note: in production, exports are typically hosted outside the web app repo
 * (e.g. a separate `cellucid-datasets` repo/site). The base URL is configured
 * via `DATA_CONFIG.EXPORTS_BASE_URL` (index.html meta tag or query param).
 */
export class LocalDemoDataSource {
  /**
   * @param {string|null} [baseUrl] - Base URL for the exports directory (must end with `/` or will be normalized)
   */
  constructor(baseUrl = DATA_CONFIG.EXPORTS_BASE_URL) {
    const normalized = typeof baseUrl === 'string' ? baseUrl.trim() : '';
    this.baseUrl = normalized ? (normalized.endsWith('/') ? normalized : normalized + '/') : null;
    this.manifestUrl = this.baseUrl ? resolveUrl(this.baseUrl, DATA_CONFIG.DATASETS_MANIFEST) : null;
    this.type = 'local-demo';

    // Cache
    this._manifest = null;
    this._datasets = null;
    this._availabilityChecked = false;
    this._isAvailable = false;
  }

  /**
   * Get the type identifier for this data source
   * @returns {string}
   */
  getType() {
    return this.type;
  }

  /**
   * Check if this data source is available
   * Uses _loadManifest() to cache the manifest on first check, avoiding duplicate fetches.
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    if (!this.manifestUrl) {
      this._availabilityChecked = true;
      this._isAvailable = false;
      return false;
    }

    // Return cached result if already checked
    if (this._availabilityChecked) {
      return this._isAvailable;
    }

    console.log(`[LocalDemoDataSource] isAvailable() checking manifest: ${this.manifestUrl}`);

    try {
      // Try to load manifest - this caches it for later use by listDatasets() etc.
      await this._loadManifest();
      console.log('[LocalDemoDataSource] Manifest loaded and cached, available=true');
      this._availabilityChecked = true;
      this._isAvailable = true;
      return true;
    } catch (err) {
      // If manifest load fails, the demo source is not available.
      console.log('[LocalDemoDataSource] Not available:', err.message);
      this._availabilityChecked = true;
      this._isAvailable = false;
      return false;
    }
  }

  /**
   * Load the datasets manifest
   * @returns {Promise<Object>}
   * @private
   */
  async _loadManifest() {
    if (!this.manifestUrl) {
      throw new DataSourceError(
        'Demo datasets are not configured. Set ?exportsBaseUrl=... (or ?exports=...) or add <meta name="cellucid-exports-base-url" ...> in index.html.',
        DataSourceErrorCode.INVALID_FORMAT,
        this.type,
        { hint: 'configure cellucid-exports-base-url' }
      );
    }

    if (this._manifest !== null) {
      return this._manifest;
    }

    this._manifest = await fetchJson(this.manifestUrl, this.type);

    validateSchemaVersion(
      this._manifest.version,
      DATA_CONFIG.SUPPORTED_MANIFEST_VERSIONS,
      'datasets.json'
    );

    console.log(`[LocalDemoDataSource] Loaded datasets manifest with ${this._manifest.datasets?.length || 0} datasets`);
    return this._manifest;
  }

  /**
   * List all available datasets from this source
   * @returns {Promise<DatasetMetadata[]>}
   */
  async listDatasets() {
    if (this._datasets) {
      return this._datasets;
    }

    const manifest = await this._loadManifest();

    // Multi-dataset mode: load metadata for each dataset in manifest
    const datasets = [];
    for (const entry of (manifest.datasets || [])) {
      try {
        const datasetBaseUrl = resolveUrl(this.baseUrl, entry.path);
        const metadata = await loadDatasetMetadata(datasetBaseUrl, entry.id, this.type);

        // Override name from manifest if provided (allows short names in manifest)
        if (entry.name) {
          metadata.name = entry.name;
        }

        // Merge quick stats from manifest (avoids loading full metadata)
        if (entry.n_cells && !metadata.stats.n_cells) {
          metadata.stats.n_cells = entry.n_cells;
        }
        if (entry.n_genes && !metadata.stats.n_genes) {
          metadata.stats.n_genes = entry.n_genes;
        }

        datasets.push(metadata);
      } catch (err) {
        console.warn(`[LocalDemoDataSource] Failed to load metadata for dataset '${entry.id}':`, err);
      }
    }

    if (datasets.length === 0) {
      throw new DataSourceError(
        'No valid datasets found in demo exports (dataset_identity.json required)',
        DataSourceErrorCode.INVALID_FORMAT,
        this.type,
        { baseUrl: this.baseUrl }
      );
    }

    this._datasets = datasets;
    return this._datasets;
  }

  /**
   * Get the default dataset ID (first dataset or from manifest)
   * @returns {Promise<string|null>}
   */
  async getDefaultDatasetId() {
    const manifest = await this._loadManifest();

    // Check manifest for explicit default
    if (manifest.default) {
      return manifest.default;
    }

    // Fall back to first dataset
    if (manifest.datasets?.length > 0) {
      return manifest.datasets[0].id;
    }

    return null;
  }

  /**
   * Get metadata for a specific dataset
   * @param {string} datasetId - Dataset identifier
   * @returns {Promise<DatasetMetadata>}
   */
  async getMetadata(datasetId) {
    const datasets = await this.listDatasets();
    const dataset = datasets.find(d => d.id === datasetId);

    if (!dataset) {
      throw new DataSourceError(
        `Dataset '${datasetId}' not found`,
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        { datasetId }
      );
    }

    return dataset;
  }

  /**
   * Get the base URL for loading a dataset's files
   * @param {string} datasetId - Dataset identifier
   * @returns {string}
   */
  getBaseUrl(datasetId) {
    // Find dataset path in manifest
    if (this._manifest?.datasets) {
      const entry = this._manifest.datasets.find(d => d.id === datasetId);
      if (entry?.path) {
        return resolveUrl(this.baseUrl, entry.path);
      }
    }

    // Default: assume datasetId is the directory name
    return resolveUrl(this.baseUrl, datasetId + '/');
  }

  /**
   * Check if a specific dataset exists
   * @param {string} datasetId - Dataset identifier
   * @returns {Promise<boolean>}
   */
  async hasDataset(datasetId) {
    try {
      const datasets = await this.listDatasets();
      return datasets.some(d => d.id === datasetId);
    } catch (_err) {
      return false;
    }
  }

  /**
   * Refresh the datasets list (clear cache)
   */
  refresh() {
    this._manifest = null;
    this._datasets = null;
    this._availabilityChecked = false;
    this._isAvailable = false;
  }

  /**
   * Whether this source requires manual reconnection.
   * Demo source uses standard HTTP URLs and doesn't need reconnection.
   * @returns {boolean}
   */
  requiresManualReconnect() {
    return false;
  }

  /**
   * Resolve a URL (no-op for demo source as it uses standard HTTP URLs)
   * @param {string} url - URL to resolve
   * @returns {Promise<string>}
   */
  async resolveUrl(url) {
    return url;
  }

  /**
   * Called when this source is deactivated
   * No cleanup needed for demo source
   */
  onDeactivate() {
    // No cleanup needed for demo source
  }
}

/**
 * Create a LocalDemoDataSource instance with the default configuration
 * @returns {LocalDemoDataSource}
 */
export function createLocalDemoDataSource() {
  return new LocalDemoDataSource(DATA_CONFIG.EXPORTS_BASE_URL);
}
