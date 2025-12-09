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

    /** @type {DatasetMetadata|null} */
    this.activeDatasetMetadata = null;

    /** @type {Set<Function>} */
    this._onDatasetChangeCallbacks = new Set();

    /** @type {Set<Function>} */
    this._onSourcesChangeCallbacks = new Set();

    /** @type {boolean} */
    this._initialized = false;

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
   * Initialize with default sources and load initial dataset
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this._initialized) return;

    // Register default sources
    const demoSource = createLocalDemoDataSource();
    this.registerSource('local-demo', demoSource);

    // Check if demo source is available and load default dataset
    if (await demoSource.isAvailable()) {
      const defaultId = await demoSource.getDefaultDatasetId();
      if (defaultId) {
        await this.switchToDataset('local-demo', defaultId, { silent: true });
      }
    }

    this._initialized = true;
    console.log('[DataSourceManager] Initialized');
  }

  /**
   * Get all available datasets from all sources
   * @returns {Promise<{sourceType: string, datasets: DatasetMetadata[]}[]>}
   */
  async getAllDatasets() {
    console.log('[DataSourceManager] getAllDatasets() called, sources:', [...this.sources.keys()]);
    const results = [];

    for (const [type, source] of this.sources) {
      try {
        console.log(`[DataSourceManager] Checking source '${type}'...`);
        const isAvailable = await source.isAvailable?.();
        console.log(`[DataSourceManager] Source '${type}' available: ${isAvailable}`);

        if (isAvailable) {
          console.log(`[DataSourceManager] Listing datasets from '${type}'...`);
          const datasets = await source.listDatasets();
          console.log(`[DataSourceManager] Got ${datasets?.length || 0} datasets from '${type}'`);
          results.push({ sourceType: type, datasets });
        }
      } catch (err) {
        console.error(`[DataSourceManager] Failed to list datasets from '${type}':`, err);
      }
    }

    console.log(`[DataSourceManager] getAllDatasets() returning ${results.length} source groups`);
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
   * @returns {Promise<{baseUrl: string, metadata: DatasetMetadata}>}
   */
  async switchToDataset(sourceType, datasetId, options = {}) {
    const { silent = false } = options;

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

    // Store previous state for notification
    const previousSource = this.activeSource;
    const previousSourceType = previousSource?.getType?.();
    const previousDatasetId = this.activeDatasetId;

    // Notify previous source it's being deactivated (for cleanup like revoking Object URLs)
    if (previousSource && previousSource !== source) {
      if (typeof previousSource.onDeactivate === 'function') {
        try {
          previousSource.onDeactivate();
        } catch (err) {
          console.warn('[DataSourceManager] Error in source onDeactivate:', err);
        }
      }
    }

    // Update active state
    this.activeSource = source;
    this.activeDatasetId = datasetId;
    this.activeDatasetMetadata = metadata;

    console.log(`[DataSourceManager] Switched to dataset '${datasetId}' from '${sourceType}' (baseUrl: ${baseUrl})`);

    // Notify listeners
    if (!silent) {
      this._notifyDatasetChange({
        sourceType,
        datasetId,
        metadata,
        baseUrl,
        previousSourceType,
        previousDatasetId
      });
    }

    return { baseUrl, metadata };
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
    return this.activeSource?.getType?.() || null;
  }

  /**
   * Get the current dataset ID
   * @returns {string|null}
   */
  getCurrentDatasetId() {
    return this.activeDatasetId;
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
      console.warn(`[DataSourceManager] Cannot restore: source '${state.sourceType}' not registered`);
      return false;
    }

    // Check if this source requires manual reconnection (e.g., user directories, remote servers)
    if (typeof source.requiresManualReconnect === 'function' && source.requiresManualReconnect()) {
      console.log(`[DataSourceManager] Cannot auto-restore '${state.sourceType}' (requires manual reconnection)`);
      return false;
    }

    try {
      await this.switchToDataset(state.sourceType, state.datasetId, options);
      return true;
    } catch (err) {
      console.warn(`[DataSourceManager] Failed to restore dataset '${state.datasetId}':`, err);
      return false;
    }
  }

  /**
   * Add a callback for dataset changes
   * @param {Function} callback - Callback function
   */
  onDatasetChange(callback) {
    this._onDatasetChangeCallbacks.add(callback);
  }

  /**
   * Remove a dataset change callback
   * @param {Function} callback - Callback to remove
   */
  offDatasetChange(callback) {
    this._onDatasetChangeCallbacks.delete(callback);
  }

  /**
   * Add a callback for source registration changes
   * @param {Function} callback - Callback function
   */
  onSourcesChange(callback) {
    this._onSourcesChangeCallbacks.add(callback);
  }

  /**
   * Remove a sources change callback
   * @param {Function} callback - Callback to remove
   */
  offSourcesChange(callback) {
    this._onSourcesChangeCallbacks.delete(callback);
  }

  /**
   * Notify all dataset change listeners
   * @param {Object} event - Change event data
   * @private
   */
  _notifyDatasetChange(event) {
    for (const callback of this._onDatasetChangeCallbacks) {
      try {
        callback(event);
      } catch (err) {
        console.error('[DataSourceManager] Error in dataset change callback:', err);
      }
    }
  }

  /**
   * Notify all sources change listeners
   * @private
   */
  _notifySourcesChange() {
    for (const callback of this._onSourcesChangeCallbacks) {
      try {
        callback();
      } catch (err) {
        console.error('[DataSourceManager] Error in sources change callback:', err);
      }
    }
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
      console.warn(`[DataSourceManager] Protocol should end with '://': ${protocol}`);
    }
    this._protocolHandlers[protocol] = sourceType;
    console.log(`[DataSourceManager] Registered protocol '${protocol}' → '${sourceType}'`);
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
   * @returns {Promise<string>} Standard fetchable URL (http://, https://, blob://, or data://)
   */
  async resolveUrl(url) {
    if (!url) return url;

    const sourceType = this.getSourceTypeForUrl(url);
    if (!sourceType) {
      // Standard HTTP(S) URL, return as-is
      return url;
    }

    const source = this.sources.get(sourceType);
    if (!source) {
      console.warn(`[DataSourceManager] No source registered for protocol in URL: ${url}`);
      return url;
    }

    // Delegate to source's URL resolution (may be async)
    if (typeof source.resolveUrl === 'function') {
      return await source.resolveUrl(url);
    }

    // Fallback: use getFileUrl if available (common for local-user)
    if (typeof source.getFileUrl === 'function') {
      // Parse the path from the custom protocol URL
      const protocol = Object.keys(this._protocolHandlers)
        .find(p => url.startsWith(p));
      if (protocol) {
        const path = url.substring(protocol.length);
        return await source.getFileUrl(path);
      }
    }

    console.warn(`[DataSourceManager] Source '${sourceType}' cannot resolve URL: ${url}`);
    return url;
  }

  /**
   * Fetch a URL, handling custom protocols automatically
   * @param {string} url - URL to fetch (may be custom protocol)
   * @param {RequestInit} [options] - Fetch options
   * @returns {Promise<Response>}
   */
  async fetch(url, options = {}) {
    const resolvedUrl = await this.resolveUrl(url);
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
