/**
 * DataSourceManager - Central coordinator for data sources and dataset switching
 *
 * Manages:
 * - Registration of data sources (local-demo, local-user, remote, jupyter)
 * - Active dataset tracking
 * - Dataset switching with callbacks
 * - State serialization hooks
 */

import { DataSourceError, DataSourceErrorCode } from './data-source.js';
import { createLocalDemoDataSource } from './local-demo-source.js';
import { createGitHubDataSource } from './github-data-source.js';
import {
  throwIfMetadataAborted,
  validateAbortSignalOrNull,
  waitForMetadata,
} from './metadata-load-contract.js';
import { debug } from '../utils/debug.js';

function readSourceType(source, label) {
  if (source === null) return null;
  if (
    typeof source !== 'object'
    || typeof source.getType !== 'function'
  ) {
    throw new TypeError(`${label} must implement getType().`);
  }
  const sourceType = source.getType();
  if (
    typeof sourceType !== 'string' ||
    sourceType.length === 0 ||
    sourceType !== sourceType.trim()
  ) {
    throw new TypeError(
      `${label} getType() must return a non-empty trimmed string.`
    );
  }
  return sourceType;
}

function requireListener(callback, label) {
  if (typeof callback !== 'function') {
    throw new TypeError(`${label} must be a function.`);
  }
  return callback;
}

function notifyListeners(listeners, event, label) {
  const errors = [];
  for (const callback of [...listeners]) {
    try {
      callback(event);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `${label} listener publication failed.`
    );
  }
}

/**
 * @typedef {import('./data-source.js').DatasetMetadata} DatasetMetadata
 */

/**
 * @typedef {Object} DataSourceState
 * @property {string|null} sourceType - Type of active data source
 * @property {string|null} datasetId - Active dataset ID
 * @property {string|null} userPath - Path for user directories (for display only)
 */

/**
 * Central manager for data sources
 */
export class DataSourceManager {
  constructor() {
    /** @type {Map<string, Object>} */
    this.sources = new Map();

    /** @type {Object|null} */
    this.activeSource = null;

    /** @type {string|null} */
    this.activeDatasetId = null;

    /** @type {string|null} */
    this.activeIdentityId = null;

    /** @type {DatasetMetadata|null} */
    this.activeDatasetMetadata = null;

    /** @type {Set<Function>} */
    this._onDatasetChangeCallbacks = new Set();

    /** @type {Set<Function>} */
    this._onSourcesChangeCallbacks = new Set();

    /** @type {boolean} */
    this._initialized = false;

    /** @type {string|null} */
    this.lastLoadMethod = null;

    /** @type {Object<string, string>} Protocol handlers (protocol → sourceType) */
    this._protocolHandlers = { ...DataSourceManager.DEFAULT_PROTOCOL_HANDLERS };
  }

  /**
   * Register a data source
   * @param {string} type - Source type identifier
   * @param {Object} source - Data source instance
   */
  registerSource(type, source) {
    this.sources.set(type, source);
    this._notifySourcesChange();
  }

  /**
   * Unregister a data source
   * @param {string} type - Source type identifier
   */
  unregisterSource(type) {
    this.sources.delete(type);
    this._notifySourcesChange();
  }

  /**
   * Get a registered data source
   * @param {string} type - Source type identifier
   * @returns {Object|null}
   */
  getSource(type) {
    return this.sources.get(type) || null;
  }

  /**
   * Get all registered source types
   * @returns {string[]}
   */
  getSourceTypes() {
    return Array.from(this.sources.keys());
  }

  /**
   * Register the current built-in sources without selecting a dataset.
   * Dataset loading requires a user selection or an explicit launch parameter.
   *
   * @param {Object} [options]
   * @param {boolean} [options.registerDemoCatalog=true]
   * @returns {Promise<void>}
   */
  async initialize(options = {}) {
    if (this._initialized) return;
    if (
      options === null ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.getPrototypeOf(options) !== Object.prototype
    ) {
      throw new TypeError(
        'DataSourceManager initialization options must be a plain object'
      );
    }
    const unsupported = Object.keys(options).filter(
      key => key !== 'registerDemoCatalog'
    );
    if (unsupported.length > 0) {
      throw new TypeError(
        `DataSourceManager initialization contains unsupported option(s): ${unsupported.join(', ')}`
      );
    }
    const registerDemoCatalog = Object.hasOwn(
      options,
      'registerDemoCatalog'
    )
      ? options.registerDemoCatalog
      : true;
    if (typeof registerDemoCatalog !== 'boolean') {
      throw new TypeError(
        'DataSourceManager registerDemoCatalog must be a boolean'
      );
    }

    if (registerDemoCatalog) {
      this.registerSource(
        'local-demo',
        createLocalDemoDataSource()
      );
    }

    // GitHub is an explicit connection workflow and performs no catalog I/O
    // until the user supplies a repository.
    const githubSource = createGitHubDataSource();
    this.registerSource('github-repo', githubSource);

    this._initialized = true;
    debug.log('[DataSourceManager] Initialized');
  }

  /**
   * Get all available datasets from all sources
   * Uses parallel checks for better performance.
   * @returns {Promise<{sourceType: string, datasets: DatasetMetadata[]}[]>}
   */
  async getAllDatasets() {
    debug.log('[DataSourceManager] getAllDatasets', { sources: [...this.sources.keys()] });

    const sourceEntries = [...this.sources.entries()];
    const checkPromises = sourceEntries.map(async ([sourceType, source]) => {
      if (
        typeof source?.isAvailable !== 'function' ||
        typeof source?.listDatasets !== 'function'
      ) {
        throw new TypeError(
          `Data source '${sourceType}' must implement isAvailable() and listDatasets().`
        );
      }
      const isAvailable = await source.isAvailable();
      if (typeof isAvailable !== 'boolean') {
        throw new TypeError(
          `Data source '${sourceType}' isAvailable() must resolve to a boolean.`
        );
      }
      if (!isAvailable) return null;
      const datasets = await source.listDatasets();
      if (!Array.isArray(datasets)) {
        throw new TypeError(
          `Data source '${sourceType}' listDatasets() must resolve to an array.`
        );
      }
      return { sourceType, datasets };
    });

    const allResults = await Promise.all(checkPromises);
    const results = allResults.filter(result => result !== null);

    debug.log('[DataSourceManager] getAllDatasets complete', { sourceGroups: results.length });
    return results;
  }

  /**
   * Get datasets from a specific source
   * @param {string} sourceType - Source type
   * @returns {Promise<DatasetMetadata[]>}
   */
  async getDatasets(sourceType) {
    const source = this.sources.get(sourceType);
    if (!source) {
      throw new DataSourceError(
        `Unknown source type: ${sourceType}`,
        DataSourceErrorCode.NOT_FOUND,
        null,
        { sourceType }
      );
    }
    return source.listDatasets();
  }

  /**
   * Switch to a different dataset
   * @param {string} sourceType - Source type
   * @param {string} datasetId - Dataset ID
   * @param {Object} [options]
   * @param {boolean} [options.silent=false] - Don't notify listeners
   * @param {string} [options.loadMethod] - Analytics hint for how the dataset was chosen
   * @returns {Promise<{baseUrl: string, metadata: DatasetMetadata}>}
   */
  async switchToDataset(sourceType, datasetId, options = {}) {
    const { silent = false, loadMethod = null } = options;

    const source = this.sources.get(sourceType);
    if (!source) {
      throw new DataSourceError(
        `Unknown source type: ${sourceType}`,
        DataSourceErrorCode.NOT_FOUND,
        null,
        { sourceType }
      );
    }

    // Get dataset metadata
    const metadata = await source.getMetadata(datasetId);
    const baseUrl = source.getBaseUrl(datasetId);
    const identityId = sourceType === 'local-user'
      ? source.getIdentityId(datasetId)
      : datasetId;
    if (typeof identityId !== 'string' || identityId.length === 0) {
      throw new DataSourceError(
        'The selected source did not provide an exact dataset identity id.',
        DataSourceErrorCode.INVALID_FORMAT,
        sourceType,
        { datasetId, identityId }
      );
    }

    // Store previous state for notification
    const previousSource = this.activeSource;
    const previousSourceType = readSourceType(
      previousSource,
      'Previous active data source'
    );
    const previousDatasetId = this.activeDatasetId;

    // Notify previous source it's being deactivated (for cleanup like revoking Object URLs)
    if (previousSource && previousSource !== source) {
      if (typeof previousSource.onDeactivate === 'function') {
        previousSource.onDeactivate();
      }
    }

    // Update active state
    this.activeSource = source;
    this.activeDatasetId = datasetId;
    this.activeIdentityId = identityId;
    this.activeDatasetMetadata = metadata;
    this.lastLoadMethod = loadMethod;

    debug.log('[DataSourceManager] Switched dataset', { sourceType, datasetId, baseUrl, loadMethod });

    // Notify listeners
    if (!silent) {
      this._notifyDatasetChange({
        sourceType,
        datasetId,
        metadata,
        baseUrl,
        previousSourceType,
        previousDatasetId,
        loadMethod
      });
    }

    return { baseUrl, metadata };
  }

  /**
   * Clear the active dataset selection (no dataset loaded)
   * @param {Object} [options]
   * @param {boolean} [options.silent=false] - Don't notify listeners
   */
  clearActiveDataset(options = {}) {
    const { silent = false, loadMethod = null } = options;

    if (
      !this.activeSource &&
      !this.activeDatasetId &&
      !this.activeIdentityId
    ) {
      return;
    }

    const previousSource = this.activeSource;
    const previousSourceType = readSourceType(
      previousSource,
      'Previous active data source'
    );
    const previousDatasetId = this.activeDatasetId;

    if (previousSource && typeof previousSource.onDeactivate === 'function') {
      previousSource.onDeactivate();
    }

    this.activeSource = null;
    this.activeDatasetId = null;
    this.activeIdentityId = null;
    this.activeDatasetMetadata = null;
    this.lastLoadMethod = null;

    if (!silent) {
      this._notifyDatasetChange({
        sourceType: null,
        datasetId: null,
        metadata: null,
        baseUrl: null,
        previousSourceType,
        previousDatasetId,
        loadMethod
      });
    }
  }

  /**
   * Get the base URL for the current dataset
   * @returns {string|null}
   */
  getCurrentBaseUrl() {
    if (!this.activeSource || !this.activeDatasetId) return null;
    return this.activeSource.getBaseUrl(this.activeDatasetId);
  }

  /**
   * Get metadata for the current dataset
   * @returns {DatasetMetadata|null}
   */
  getCurrentMetadata() {
    return this.activeDatasetMetadata;
  }

  /**
   * Get the current source type
   * @returns {string|null}
   */
  getCurrentSourceType() {
    return readSourceType(this.activeSource, 'Active data source');
  }

  /**
   * Get the current dataset ID
   * @returns {string|null}
   */
  getCurrentDatasetId() {
    return this.activeDatasetId;
  }

  /**
   * Get the exact dataset_identity.json id for the current generation.
   * @returns {string|null}
   */
  getCurrentIdentityId() {
    return this.activeIdentityId;
  }

  /**
   * Get the last recorded load method (for analytics)
   * @returns {string|null}
   */
  getLastLoadMethod() {
    return this.lastLoadMethod;
  }

  /**
   * Check if a dataset is currently loaded
   * @returns {boolean}
   */
  hasActiveDataset() {
    return this.activeSource !== null && this.activeDatasetId !== null;
  }

  /**
   * Get state snapshot for serialization
   * @returns {DataSourceState}
   */
  getStateSnapshot() {
    return {
      sourceType: this.activeSource?.getType?.() || null,
      datasetId: this.activeDatasetId,
      userPath: this.activeSource?.getType?.() === 'local-user'
        ? this.activeSource.getPath?.() || null
        : null
    };
  }

  /**
   * Restore state from a snapshot
   * @param {DataSourceState} state - State to restore
   * @param {Object} [options]
   * @param {boolean} [options.silent=false] - Don't notify listeners
   * @returns {Promise<boolean>} - True if restoration succeeded
   */
  async restoreState(state, options = {}) {
    if (!state?.sourceType || !state?.datasetId) {
      return false;
    }

    const source = this.sources.get(state.sourceType);
    if (!source) {
      debug.warn(`[DataSourceManager] Cannot restore: source '${state.sourceType}' not registered`);
      return false;
    }

    // Check if this source requires manual reconnection (e.g., user directories, remote servers)
    if (typeof source.requiresManualReconnect === 'function' && source.requiresManualReconnect()) {
      debug.warn(`[DataSourceManager] Cannot auto-restore '${state.sourceType}' (requires manual reconnection)`);
      return false;
    }

    try {
      await this.switchToDataset(state.sourceType, state.datasetId, options);
      return true;
    } catch (err) {
      debug.warn(`[DataSourceManager] Failed to restore dataset '${state.datasetId}':`, err);
      return false;
    }
  }

  /**
   * Add a callback for dataset changes
   * @param {Function} callback - Callback function
   */
  onDatasetChange(callback) {
    this._onDatasetChangeCallbacks.add(
      requireListener(callback, 'Dataset-change listener')
    );
  }

  /**
   * Remove a dataset change callback
   * @param {Function} callback - Callback to remove
   */
  offDatasetChange(callback) {
    this._onDatasetChangeCallbacks.delete(
      requireListener(callback, 'Dataset-change listener')
    );
  }

  /**
   * Add a callback for source registration changes
   * @param {Function} callback - Callback function
   */
  onSourcesChange(callback) {
    this._onSourcesChangeCallbacks.add(
      requireListener(callback, 'Sources-change listener')
    );
  }

  /**
   * Remove a sources change callback
   * @param {Function} callback - Callback to remove
   */
  offSourcesChange(callback) {
    this._onSourcesChangeCallbacks.delete(
      requireListener(callback, 'Sources-change listener')
    );
  }

  /**
   * Notify all dataset change listeners
   * @param {Object} event - Change event data
   * @private
   */
  _notifyDatasetChange(event) {
    notifyListeners(
      this._onDatasetChangeCallbacks,
      event,
      'Dataset-change'
    );
  }

  /**
   * Notify all sources change listeners
   * @private
   */
  _notifySourcesChange() {
    notifyListeners(
      this._onSourcesChangeCallbacks,
      undefined,
      'Sources-change'
    );
  }

  /**
   * Refresh all sources (clear caches)
   */
  refreshAll() {
    for (const source of this.sources.values()) {
      if (typeof source.refresh === 'function') {
        source.refresh();
      }
    }
  }

  /**
   * Default protocol handlers for custom URL schemes.
   * Maps protocol prefix to source type that handles it.
   * @type {Object<string, string>}
   */
  static DEFAULT_PROTOCOL_HANDLERS = {
    'local-user://': 'local-user',
    'remote://': 'remote',
    'remotes://': 'remote',
    'jupyter://': 'jupyter',
  };

  /**
   * Register a custom protocol handler
   * Allows new data source types to register their own URL protocols.
   * @param {string} protocol - Protocol prefix (e.g., 'remote://', 'jupyter://')
   * @param {string} sourceType - Source type that handles this protocol
   * @example
   * manager.registerProtocol('remote://', 'remote-server');
   * manager.registerProtocol('jupyter://', 'jupyter-bridge');
   */
  registerProtocol(protocol, sourceType) {
    if (!protocol.endsWith('://')) {
      debug.warn(`[DataSourceManager] Protocol should end with '://': ${protocol}`);
    }
    this._protocolHandlers[protocol] = sourceType;
    debug.log('[DataSourceManager] Registered protocol', { protocol, sourceType });
  }

  /**
   * Unregister a custom protocol handler
   * @param {string} protocol - Protocol prefix to remove
   */
  unregisterProtocol(protocol) {
    delete this._protocolHandlers[protocol];
  }

  /**
   * Get all registered protocol handlers
   * @returns {Object<string, string>} Map of protocol → sourceType
   */
  getProtocolHandlers() {
    return { ...this._protocolHandlers };
  }

  /**
   * Check if a URL uses a custom protocol handled by a data source
   * @param {string} url - URL to check
   * @returns {boolean}
   */
  isCustomProtocolUrl(url) {
    if (!url) return false;
    for (const protocol of Object.keys(this._protocolHandlers)) {
      if (url.startsWith(protocol)) return true;
    }
    return false;
  }

  /**
   * Get the source type for a custom protocol URL
   * @param {string} url - Custom protocol URL
   * @returns {string|null} Source type or null if not a custom protocol
   */
  getSourceTypeForUrl(url) {
    if (!url) return null;
    for (const [protocol, sourceType] of Object.entries(this._protocolHandlers)) {
      if (url.startsWith(protocol)) return sourceType;
    }
    return null;
  }

  /**
   * Resolve a custom protocol URL to a fetchable URL (async version)
   * Handles local-user://, remote://, jupyter://, etc.
   * @param {string} url - URL that may use a custom protocol
   * @param {AbortSignal|null} signal - Exact request owner
   * @returns {Promise<string>} Standard fetchable URL (http://, https://, blob://, or data://)
   */
  async resolveUrl(url, signal) {
    validateAbortSignalOrNull(signal, 'URL resolution signal');
    throwIfMetadataAborted(signal, 'URL resolution');
    if (!url) return url;

    const sourceType = this.getSourceTypeForUrl(url);
    if (!sourceType) {
      // Standard HTTP(S) URL, return as-is
      return url;
    }

    const source = this.sources.get(sourceType);
    if (!source) {
      throw new DataSourceError(
        `Custom protocol URL requires registered source '${sourceType}': ${url}`,
        DataSourceErrorCode.NOT_FOUND,
        sourceType,
        { sourceType, url }
      );
    }

    if (typeof source.resolveUrl !== 'function') {
      throw new DataSourceError(
        `Registered source '${sourceType}' must expose resolveUrl(url, signal) ` +
        `to handle custom protocol URLs`,
        DataSourceErrorCode.UNSUPPORTED,
        sourceType,
        { sourceType, url }
      );
    }

    const resolvedUrl = await waitForMetadata(
      source.resolveUrl(url, signal),
      signal,
      'URL resolution'
    );
    throwIfMetadataAborted(signal, 'URL resolution');
    return resolvedUrl;
  }

  /**
   * Fetch a URL, handling custom protocols automatically
   * @param {string} url - URL to fetch (may be custom protocol)
   * @param {RequestInit} [options] - Fetch options
   * @returns {Promise<Response>}
   */
  async fetch(url, options = {}) {
    const resolvedUrl = await this.resolveUrl(
      url,
      options.signal ?? null
    );
    return fetch(resolvedUrl, options);
  }

  /**
   * Fetch a URL as JSON, handling custom protocols automatically
   * @param {string} url - URL to fetch (may be custom protocol)
   * @returns {Promise<any>}
   */
  async fetchJson(url) {
    const response = await this.fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.json();
  }
}

// Singleton instance
let _instance = null;

/**
 * Get the singleton DataSourceManager instance
 * @returns {DataSourceManager}
 */
export function getDataSourceManager() {
  if (!_instance) {
    _instance = new DataSourceManager();
  }
  return _instance;
}

/**
 * Create a new DataSourceManager (for testing or custom instances)
 * @returns {DataSourceManager}
 */
export function createDataSourceManager() {
  return new DataSourceManager();
}
