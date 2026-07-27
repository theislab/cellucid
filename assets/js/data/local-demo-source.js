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

function invalidDemoManifest(message, source, details = {}) {
  return new DataSourceError(
    `Invalid datasets.json: ${message}`,
    DataSourceErrorCode.INVALID_FORMAT,
    source,
    details
  );
}

function validateDemoDatasetPath(value, id, source) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw invalidDemoManifest(
      `dataset '${id}' must declare a safe relative path`,
      source,
      { id, path: value }
    );
  }
  if (!value.endsWith('/')) {
    throw invalidDemoManifest(
      `dataset '${id}' path must be a relative directory ending in '/'`,
      source,
      { id, path: value }
    );
  }
  const parts = value.split('/');
  if (parts.at(-1) === '') parts.pop();
  if (
    parts.length === 0 ||
    parts.some(part => part === '' || part === '.' || part === '..')
  ) {
    throw invalidDemoManifest(
      `dataset '${id}' must declare a safe relative path`,
      source,
      { id, path: value }
    );
  }
  return value;
}

function validateDemoManifestContract(manifest, source) {
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    !Array.isArray(manifest.datasets) ||
    manifest.datasets.length === 0
  ) {
    throw invalidDemoManifest(
      'datasets must be a non-empty array',
      source
    );
  }

  const ids = new Set();
  const paths = new Set();
  for (const entry of manifest.datasets) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      typeof entry.id !== 'string' ||
      entry.id.length === 0 ||
      ids.has(entry.id)
    ) {
      throw invalidDemoManifest(
        'every dataset requires a unique non-empty string id',
        source
      );
    }
    ids.add(entry.id);
    const path = validateDemoDatasetPath(entry.path, entry.id, source);
    if (paths.has(path)) {
      throw invalidDemoManifest(
        `dataset '${entry.id}' reuses path '${path}'`,
        source,
        { id: entry.id, path }
      );
    }
    paths.add(path);
    if (
      Object.hasOwn(entry, 'name') &&
      (typeof entry.name !== 'string' || entry.name.length === 0)
    ) {
      throw invalidDemoManifest(
        `dataset '${entry.id}' has an invalid name`,
        source,
        { id: entry.id }
      );
    }
    for (const countKey of ['n_cells', 'n_genes']) {
      if (
        Object.hasOwn(entry, countKey) &&
        (
          !Number.isSafeInteger(entry[countKey]) ||
          entry[countKey] < 0
        )
      ) {
        throw invalidDemoManifest(
          `dataset '${entry.id}' has an invalid ${countKey}`,
          source,
          { id: entry.id, key: countKey, value: entry[countKey] }
        );
      }
    }
    const hasStateManifest = Object.hasOwn(entry, 'state_manifest');
    const hasStateSha256 = Object.hasOwn(entry, 'state_sha256');
    if (hasStateManifest !== hasStateSha256) {
      throw invalidDemoManifest(
        `dataset '${entry.id}' state_manifest and state_sha256 must be declared together`,
        source,
        { id: entry.id }
      );
    }
    if (
      hasStateManifest
      && entry.state_manifest !== 'state-snapshots.json'
    ) {
      throw invalidDemoManifest(
        `dataset '${entry.id}' state_manifest must be exactly state-snapshots.json`,
        source,
        { id: entry.id, stateManifest: entry.state_manifest }
      );
    }
    if (
      hasStateSha256
      && (
        typeof entry.state_sha256 !== 'string'
        || !/^[0-9a-f]{64}$/.test(entry.state_sha256)
      )
    ) {
      throw invalidDemoManifest(
        `dataset '${entry.id}' state_sha256 must be one lowercase SHA-256 digest`,
        source,
        { id: entry.id, stateSha256: entry.state_sha256 }
      );
    }
  }

  if (
    typeof manifest.default !== 'string' ||
    manifest.default.length === 0
  ) {
    throw invalidDemoManifest(
      'an explicit default dataset id is required',
      source
    );
  }
  if (!ids.has(manifest.default)) {
    throw invalidDemoManifest(
      `default '${manifest.default}' is not present in datasets`,
      source,
      { default: manifest.default }
    );
  }
  return manifest;
}

/**
 * Data source for demo datasets stored in an exports directory.
 *
 * Note: in production, exports are typically hosted outside the web app repo
 * (e.g. a separate `cellucid-datasets` repo/site). The base URL is configured
 * via `DATA_CONFIG.EXPORTS_BASE_URL` (index.html meta tag or query param).
 */
export class LocalDemoDataSource {
  /**
   * @param {string|null} [baseUrl] - Exact exports directory URL
   * @param {Error|null} [configurationError] - Parsed startup configuration failure
   */
  constructor(
    baseUrl = DATA_CONFIG.EXPORTS_BASE_URL,
    configurationError = DATA_CONFIG.EXPORTS_CONFIGURATION_ERROR
  ) {
    if (
      baseUrl !== null &&
      (
        typeof baseUrl !== 'string' ||
        baseUrl.length === 0 ||
        baseUrl !== baseUrl.trim() ||
        !baseUrl.endsWith('/') ||
        new URL(baseUrl).href !== baseUrl
      )
    ) {
      throw new TypeError(
        'LocalDemoDataSource baseUrl must be one exact absolute directory URL or null.'
      );
    }
    if (
      configurationError !== null &&
      !(configurationError instanceof Error)
    ) {
      throw new TypeError(
        'LocalDemoDataSource configurationError must be an Error or null.'
      );
    }
    this.baseUrl = baseUrl;
    this.configurationError = configurationError;
    this.manifestUrl = this.baseUrl === null
      ? null
      : resolveUrl(
          this.baseUrl,
          DATA_CONFIG.DATASETS_MANIFEST
        );
    this.type = 'local-demo';

    // Cache
    this._manifest = null;
    this._datasets = null;
    this._datasetError = null;
    this._availabilityChecked = false;
    this._isAvailable = false;
    this._availabilityError = null;
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
    if (
      this.manifestUrl === null &&
      this.configurationError === null
    ) {
      this._availabilityChecked = true;
      this._isAvailable = false;
      return false;
    }

    if (this._availabilityChecked) {
      if (this._availabilityError !== null) {
        throw this._availabilityError;
      }
      return this._isAvailable;
    }

    console.log(`[LocalDemoDataSource] isAvailable() checking manifest: ${this.manifestUrl}`);

    try {
      await this._loadManifest();
      console.log('[LocalDemoDataSource] Manifest loaded and cached, available=true');
      this._availabilityChecked = true;
      this._isAvailable = true;
      return true;
    } catch (err) {
      this._availabilityChecked = true;
      this._isAvailable = false;
      this._availabilityError = err;
      throw err;
    }
  }

  /**
   * Load the datasets manifest
   * @returns {Promise<Object>}
   * @private
   */
  async _loadManifest() {
    if (this.configurationError !== null) {
      throw new DataSourceError(
        this.configurationError.message,
        DataSourceErrorCode.INVALID_FORMAT,
        this.type,
        { cause: this.configurationError }
      );
    }
    if (!this.manifestUrl) {
      throw new DataSourceError(
        'Sample datasets are not configured. Set exactly one ?exportsBaseUrl=https://host/exports/ query field or one cellucid-exports-base-url meta element.',
        DataSourceErrorCode.INVALID_FORMAT,
        this.type,
        { hint: 'configure cellucid-exports-base-url' }
      );
    }

    if (this._manifest !== null) {
      return this._manifest;
    }

    const candidateManifest = await fetchJson(
      this.manifestUrl,
      this.type
    );

    validateSchemaVersion(
      candidateManifest.version,
      DATA_CONFIG.SUPPORTED_MANIFEST_VERSIONS,
      'datasets.json'
    );
    validateDemoManifestContract(candidateManifest, this.type);
    this._manifest = candidateManifest;

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
    if (this._datasetError !== null) {
      throw this._datasetError;
    }

    const manifest = await this._loadManifest();
    validateDemoManifestContract(manifest, this.type);

    // Multi-dataset mode: load metadata for each dataset in manifest
    const datasets = [];
    for (const entry of manifest.datasets) {
      try {
        const datasetBaseUrl = resolveUrl(this.baseUrl, entry.path);
        const metadata = await loadDatasetMetadata(datasetBaseUrl, entry.id, this.type);

        // Override name from manifest if provided (allows short names in manifest)
        if (entry.name) {
          metadata.name = entry.name;
        }

        // Catalog counts are duplicate assertions, never metadata defaults.
        for (const countKey of ['n_cells', 'n_genes']) {
          if (
            Object.hasOwn(entry, countKey) &&
            entry[countKey] !== metadata.stats[countKey]
          ) {
            throw new DataSourceError(
              `Dataset '${entry.id}' catalog ${countKey}=${entry[countKey]} does not match dataset_identity.json ${countKey}=${metadata.stats[countKey]}`,
              DataSourceErrorCode.INVALID_FORMAT,
              this.type,
              {
                datasetId: entry.id,
                key: countKey,
                catalogValue: entry[countKey],
                identityValue: metadata.stats[countKey],
              }
            );
          }
        }

        datasets.push(metadata);
      } catch (err) {
        this._datasetError = new DataSourceError(
          `Dataset '${entry.id}' is invalid: ${err?.message || err}`,
          DataSourceErrorCode.INVALID_FORMAT,
          this.type,
          { datasetId: entry.id, cause: err }
        );
        throw this._datasetError;
      }
    }

    this._datasets = datasets;
    return this._datasets;
  }

  /**
   * Get the explicit current default dataset ID.
   * @returns {Promise<string>}
   */
  async getDefaultDatasetId() {
    const manifest = await this._loadManifest();
    validateDemoManifestContract(manifest, this.type);
    return manifest.default;
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
    if (!this._manifest) {
      throw new DataSourceError(
        'Dataset catalog has not been loaded',
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
    }
    validateDemoManifestContract(this._manifest, this.type);
    const entry = this._manifest.datasets.find(
      dataset => dataset.id === datasetId
    );
    if (!entry) {
      throw new DataSourceError(
        `Dataset '${datasetId}' not found in datasets.json`,
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        { datasetId }
      );
    }
    return resolveUrl(this.baseUrl, entry.path);
  }

  /**
   * Resolve the explicitly advertised default-state manifest for a dataset.
   * Catalogs without this current optional capability are never probed.
   *
   * @param {string} datasetId - Dataset identifier
   * @returns {string|null}
   */
  getStateDescriptor(datasetId) {
    const baseUrl = this.getBaseUrl(datasetId);
    const entry = this._manifest.datasets.find(
      dataset => dataset.id === datasetId
    );
    if (!Object.hasOwn(entry, 'state_manifest')) return null;
    return {
      manifestUrl: resolveUrl(baseUrl, entry.state_manifest),
      stateSha256: entry.state_sha256,
    };
  }

  /**
   * Check if a specific dataset exists
   * @param {string} datasetId - Dataset identifier
   * @returns {Promise<boolean>}
   */
  async hasDataset(datasetId) {
    const datasets = await this.listDatasets();
    return datasets.some(d => d.id === datasetId);
  }

  /**
   * Refresh the datasets list (clear cache)
   */
  refresh() {
    this._manifest = null;
    this._datasets = null;
    this._datasetError = null;
    this._availabilityChecked = false;
    this._isAvailable = false;
    this._availabilityError = null;
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
  return new LocalDemoDataSource(
    DATA_CONFIG.EXPORTS_BASE_URL,
    DATA_CONFIG.EXPORTS_CONFIGURATION_ERROR
  );
}
