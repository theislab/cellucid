/**
 * LocalDemoDataSource - Data source for demo datasets in the exports/ directory
 *
 * Supports two modes:
 * 1. Multi-dataset mode: reads datasets.json manifest listing available datasets
 * 2. Legacy mode: treats exports/ as a single dataset (backwards compatible)
 */

import {
  DATA_CONFIG,
  DataSourceError,
  DataSourceErrorCode,
  fetchJson,
  loadDatasetMetadata,
  resolveUrl,
  urlExists,
  validateSchemaVersion
} from './data-source.js';

/**
 * @typedef {import('./data-source.js').DatasetMetadata} DatasetMetadata
 */

/**
 * Data source for demo datasets stored in the exports/ directory
 */
export class LocalDemoDataSource {
  /**
   * @param {string} [baseUrl='assets/exports/'] - Base URL for the exports directory
   */
  constructor(baseUrl = DATA_CONFIG.EXPORTS_BASE_URL) {
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    this.manifestUrl = resolveUrl(this.baseUrl, DATA_CONFIG.DATASETS_MANIFEST);
    this.type = 'local-demo';

    // Cache
    this._manifest = null;
    this._datasets = null;
    this._isLegacyMode = null;
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
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    console.log(`[LocalDemoDataSource] isAvailable() checking manifest: ${this.manifestUrl}`);

    // Check if manifest exists OR legacy mode is available
    if (await urlExists(this.manifestUrl)) {
      console.log('[LocalDemoDataSource] Manifest exists, available=true');
      return true;
    }

    // Check legacy mode (obs_manifest.json directly in exports/)
    if (DATA_CONFIG.LEGACY_MODE_FALLBACK) {
      const legacyManifest = resolveUrl(this.baseUrl, 'obs_manifest.json');
      console.log(`[LocalDemoDataSource] Checking legacy mode: ${legacyManifest}`);
      const legacyExists = await urlExists(legacyManifest);
      console.log(`[LocalDemoDataSource] Legacy mode available: ${legacyExists}`);
      return legacyExists;
    }

    console.log('[LocalDemoDataSource] Not available');
    return false;
  }

  /**
   * Load the datasets manifest (or detect legacy mode)
   * @returns {Promise<{isLegacy: boolean, manifest?: Object}>}
   * @private
   */
  async _loadManifest() {
    if (this._manifest !== null || this._isLegacyMode !== null) {
      return { isLegacy: this._isLegacyMode, manifest: this._manifest };
    }

    try {
      this._manifest = await fetchJson(this.manifestUrl, this.type);

      // Validate manifest version
      validateSchemaVersion(
        this._manifest.version,
        DATA_CONFIG.SUPPORTED_MANIFEST_VERSIONS,
        'datasets.json'
      );

      this._isLegacyMode = false;
      console.log(`[LocalDemoDataSource] Loaded datasets manifest with ${this._manifest.datasets?.length || 0} datasets`);
      return { isLegacy: false, manifest: this._manifest };
    } catch (err) {
      // Check for legacy mode
      if (DATA_CONFIG.LEGACY_MODE_FALLBACK) {
        const legacyManifest = resolveUrl(this.baseUrl, 'obs_manifest.json');
        if (await urlExists(legacyManifest)) {
          console.log('[LocalDemoDataSource] No datasets.json found, using legacy single-dataset mode');
          this._isLegacyMode = true;
          return { isLegacy: true };
        }
      }

      throw new DataSourceError(
        'No datasets available',
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        { baseUrl: this.baseUrl }
      );
    }
  }

  /**
   * List all available datasets from this source
   * @returns {Promise<DatasetMetadata[]>}
   */
  async listDatasets() {
    if (this._datasets) {
      return this._datasets;
    }

    const { isLegacy, manifest } = await this._loadManifest();

    if (isLegacy) {
      // Legacy mode: single dataset at baseUrl
      const metadata = await loadDatasetMetadata(this.baseUrl, DATA_CONFIG.LEGACY_DATASET_ID, this.type);
      // Use a more descriptive name for legacy mode
      if (metadata.name === DATA_CONFIG.LEGACY_DATASET_ID) {
        metadata.name = 'Default Dataset';
      }
      this._datasets = [metadata];
      return this._datasets;
    }

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
        // Still include the dataset with minimal info from manifest
        datasets.push({
          id: entry.id,
          name: entry.name || entry.id,
          description: entry.description || '',
          stats: {
            n_cells: entry.n_cells || 0,
            n_genes: entry.n_genes || 0
          }
        });
      }
    }

    this._datasets = datasets;
    return this._datasets;
  }

  /**
   * Get the default dataset ID (first dataset or from manifest)
   * @returns {Promise<string|null>}
   */
  async getDefaultDatasetId() {
    const { isLegacy, manifest } = await this._loadManifest();

    if (isLegacy) {
      return DATA_CONFIG.LEGACY_DATASET_ID;
    }

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
    if (this._isLegacyMode || datasetId === DATA_CONFIG.LEGACY_DATASET_ID) {
      return this.baseUrl;
    }

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
    this._isLegacyMode = null;
  }

  /**
   * Check if currently in legacy mode
   * @returns {boolean|null} - null if not yet determined
   */
  isLegacyMode() {
    return this._isLegacyMode;
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
