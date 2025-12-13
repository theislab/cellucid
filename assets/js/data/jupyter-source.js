/**
 * JupyterBridgeDataSource - Data source for Jupyter notebook integration
 *
 * Provides bidirectional communication between the web viewer (in an iframe)
 * and a Jupyter notebook running the cellucid Python package.
 *
 * Communication flow:
 * 1. Jupyter cell embeds viewer in iframe with special URL params
 * 2. Viewer detects Jupyter mode and creates JupyterBridgeDataSource
 * 3. Source communicates with parent frame via postMessage
 * 4. Python side handles requests and sends data
 *
 * Features:
 * - Data loading from Jupyter server
 * - Live highlighting from Python
 * - Bidirectional selection sync
 * - Compute requests (filtering, recoloring)
 */

import {
  DataSourceError,
  DataSourceErrorCode,
  loadDatasetMetadata
} from './data-source.js';

/**
 * @typedef {import('./data-source.js').DatasetMetadata} DatasetMetadata
 */

/**
 * @typedef {Object} JupyterConfig
 * @property {string} serverUrl - URL of the cellucid data server (from Python side)
 * @property {string} viewerId - Unique viewer ID for message routing
 * @property {string} [kernelId] - Jupyter kernel ID (optional)
 */

/**
 * Check if running in Jupyter iframe context
 * @returns {boolean}
 */
export function isJupyterContext() {
  // Check URL parameters
  const params = new URLSearchParams(window.location.search);
  return params.get('jupyter') === 'true';
}

/**
 * Get Jupyter configuration from URL parameters
 * @returns {JupyterConfig|null}
 */
export function getJupyterConfig() {
  const params = new URLSearchParams(window.location.search);

  if (!params.get('jupyter')) {
    return null;
  }

  const remote = params.get('remote');
  const viewerId = params.get('viewerId');

  if (!remote) {
    console.warn('[JupyterBridge] Missing remote parameter');
    return null;
  }

  return {
    serverUrl: remote,
    viewerId: viewerId || 'default',
    kernelId: params.get('kernelId') || null
  };
}

/**
 * Check if a URL uses the jupyter:// protocol
 * @param {string} url - URL to check
 * @returns {boolean}
 */
export function isJupyterUrl(url) {
  return url?.startsWith('jupyter://');
}

/**
 * Parse a jupyter:// URL
 * @param {string} url - URL to parse
 * @returns {{viewerId: string, path: string}|null}
 */
export function parseJupyterUrl(url) {
  if (!isJupyterUrl(url)) return null;

  const match = url.match(/^jupyter:\/\/([^/]+)(\/.*)?$/);
  if (!match) return null;

  return {
    viewerId: match[1],
    path: (match[2] || '/').substring(1)
  };
}

/**
 * Data source for Jupyter notebook integration
 */
export class JupyterBridgeDataSource {
  constructor() {
    /** @type {JupyterConfig|null} */
    this._config = null;

    /** @type {boolean} */
    this._connected = false;

    /** @type {Map<string, DatasetMetadata>} */
    this._datasetCache = new Map();

    /** @type {string|null} */
    this._activeDatasetId = null;

    /** @type {Map<string, Function>} Pending request callbacks */
    this._pendingRequests = new Map();

    /** @type {number} */
    this._requestId = 0;

    /** @type {Set<Function>} */
    this._messageCallbacks = new Set();

    /** @type {Set<Function>} */
    this._selectionCallbacks = new Set();

    /** @type {Set<Function>} */
    this._highlightCallbacks = new Set();

    this.type = 'jupyter';

    // Set up message listener
    this._boundMessageHandler = this._handleMessage.bind(this);
    window.addEventListener('message', this._boundMessageHandler);
  }

  /**
   * Get the type identifier
   * @returns {string}
   */
  getType() {
    return this.type;
  }

  /**
   * Check if available (in Jupyter context)
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    return isJupyterContext() && this._connected;
  }

  /**
   * Initialize from URL parameters
   * @returns {Promise<boolean>} True if successfully initialized
   */
  async initialize() {
    const config = getJupyterConfig();
    if (!config) {
      console.log('[JupyterBridge] Not in Jupyter context');
      return false;
    }

    this._config = config;
    console.log('[JupyterBridge] Initializing with config:', config);

    // Test connection to server
    try {
      const response = await fetch(`${config.serverUrl}/_cellucid/health`);
      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }
      this._connected = true;

      // Notify parent that we're ready
      this._postToParent({
        type: 'ready',
        viewerId: config.viewerId
      });

      console.log('[JupyterBridge] Connected to server');
      return true;
    } catch (err) {
      console.error('[JupyterBridge] Failed to connect:', err);
      return false;
    }
  }

  /**
   * Handle incoming message from parent frame
   * @param {MessageEvent} event
   * @private
   */
  _handleMessage(event) {
    // Verify origin (should be Jupyter server or localhost)
    const allowedOrigins = [
      'http://localhost',
      'http://127.0.0.1',
      window.location.origin
    ];

    // Allow any localhost port
    const isLocalhost = event.origin.startsWith('http://localhost:') ||
                        event.origin.startsWith('http://127.0.0.1:');

    if (!isLocalhost && !allowedOrigins.includes(event.origin)) {
      return;
    }

    const data = event.data;
    if (!data || typeof data !== 'object') return;

    // Check viewer ID if present
    if (data.viewerId && this._config && data.viewerId !== this._config.viewerId) {
      return;
    }

    console.log('[JupyterBridge] Received message:', data.type);

    switch (data.type) {
      case 'response':
        this._handleResponse(data);
        break;

      case 'highlight':
        this._handleHighlight(data);
        break;

      case 'setColorBy':
        this._handleSetColorBy(data);
        break;

      case 'setVisibility':
        this._handleSetVisibility(data);
        break;

      case 'clearHighlights':
        this._handleClearHighlights();
        break;

      case 'resetCamera':
        this._handleResetCamera();
        break;

      default:
        // Pass to generic handlers
        for (const callback of this._messageCallbacks) {
          try {
            callback(data);
          } catch (err) {
            console.error('[JupyterBridge] Message handler error:', err);
          }
        }
    }
  }

  /**
   * Handle response to a pending request
   * @param {Object} data
   * @private
   */
  _handleResponse(data) {
    const { requestId, result, error } = data;

    const callback = this._pendingRequests.get(requestId);
    if (!callback) {
      console.warn('[JupyterBridge] No pending request for ID:', requestId);
      return;
    }

    this._pendingRequests.delete(requestId);
    callback({ result, error });
  }

  /**
   * Handle highlight command from Python
   * @param {Object} data
   * @private
   */
  _handleHighlight(data) {
    const { cells, color } = data;
    for (const callback of this._highlightCallbacks) {
      try {
        callback(cells, color);
      } catch (err) {
        console.error('[JupyterBridge] Highlight handler error:', err);
      }
    }
  }

  /**
   * Handle color by command
   * @param {Object} data
   * @private
   */
  _handleSetColorBy(data) {
    const { field } = data;
    for (const callback of this._messageCallbacks) {
      try {
        callback({ type: 'setColorBy', field });
      } catch (err) {
        console.error('[JupyterBridge] Handler error:', err);
      }
    }
  }

  /**
   * Handle visibility command
   * @param {Object} data
   * @private
   */
  _handleSetVisibility(data) {
    const { cells, visible } = data;
    for (const callback of this._messageCallbacks) {
      try {
        callback({ type: 'setVisibility', cells, visible });
      } catch (err) {
        console.error('[JupyterBridge] Handler error:', err);
      }
    }
  }

  /**
   * Handle clear highlights command
   * @private
   */
  _handleClearHighlights() {
    for (const callback of this._highlightCallbacks) {
      try {
        callback([], null); // Empty highlight
      } catch (err) {
        console.error('[JupyterBridge] Handler error:', err);
      }
    }
  }

  /**
   * Handle reset camera command
   * @private
   */
  _handleResetCamera() {
    for (const callback of this._messageCallbacks) {
      try {
        callback({ type: 'resetCamera' });
      } catch (err) {
        console.error('[JupyterBridge] Handler error:', err);
      }
    }
  }

  /**
   * Post message to parent frame (Jupyter)
   * @param {Object} message
   * @private
   */
  _postToParent(message) {
    if (window.parent === window) {
      console.warn('[JupyterBridge] Not in iframe, cannot post to parent');
      return;
    }

    // Note: Using '*' as targetOrigin because Jupyter notebooks can be served
    // from various origins (localhost, jupyter hub, etc.). The message handler
    // validates incoming messages using origin checking to prevent unauthorized access.
    window.parent.postMessage(message, '*');
  }

  /**
   * Send a request to Python side and wait for response
   * @param {string} type - Request type
   * @param {Object} params - Request parameters
   * @returns {Promise<any>}
   */
  async sendRequest(type, params = {}) {
    const requestId = `req_${++this._requestId}`;

    return new Promise((resolve, reject) => {
      // Set up response handler
      this._pendingRequests.set(requestId, ({ result, error }) => {
        if (error) {
          reject(new Error(error));
        } else {
          resolve(result);
        }
      });

      // Send request
      this._postToParent({
        type: 'request',
        requestId,
        requestType: type,
        params,
        viewerId: this._config?.viewerId
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this._pendingRequests.has(requestId)) {
          this._pendingRequests.delete(requestId);
          reject(new Error('Request timeout'));
        }
      }, 30000);
    });
  }

  /**
   * Notify Python of cell selection change
   * @param {number[]} cellIndices - Selected cell indices
   */
  notifySelection(cellIndices) {
    this._postToParent({
      type: 'selection',
      cells: cellIndices,
      viewerId: this._config?.viewerId
    });
  }

  /**
   * Register callback for highlight events from Python
   * @param {Function} callback - Called with (cells, color)
   */
  onHighlight(callback) {
    this._highlightCallbacks.add(callback);
  }

  /**
   * Remove highlight callback
   * @param {Function} callback
   */
  offHighlight(callback) {
    this._highlightCallbacks.delete(callback);
  }

  /**
   * Register callback for selection sync from Python
   * @param {Function} callback
   */
  onSelectionSync(callback) {
    this._selectionCallbacks.add(callback);
  }

  /**
   * Register callback for generic messages
   * @param {Function} callback
   */
  onMessage(callback) {
    this._messageCallbacks.add(callback);
  }

  /**
   * List datasets from server
   * @returns {Promise<DatasetMetadata[]>}
   */
  async listDatasets() {
    if (!this._connected || !this._config) {
      return [];
    }

    try {
      const response = await fetch(`${this._config.serverUrl}/_cellucid/datasets`);
      if (!response.ok) {
        return [];
      }

      const data = await response.json();
      const datasetList = data.datasets || [];

      // Load metadata for all datasets in parallel
      const metadataPromises = datasetList.map(async (ds) => {
        try {
          const baseUrl = `${this._config.serverUrl}${ds.path}`;
          const metadata = await loadDatasetMetadata(baseUrl, ds.id, this.type);
          this._datasetCache.set(ds.id, metadata);
          return metadata;
        } catch (err) {
          console.warn(`[JupyterBridge] Failed to load metadata for ${ds.id}:`, err);
          return {
            id: ds.id,
            name: ds.name || ds.id,
            description: '',
            stats: { n_cells: 0 }
          };
        }
      });

      return Promise.all(metadataPromises);
    } catch (err) {
      console.error('[JupyterBridge] Failed to list datasets:', err);
      return [];
    }
  }

  /**
   * Check if a specific dataset exists
   * @param {string} datasetId - Dataset ID
   * @returns {Promise<boolean>}
   */
  async hasDataset(datasetId) {
    if (!this._connected || !this._config) {
      return false;
    }

    // Check cache first
    if (this._datasetCache.has(datasetId)) {
      return true;
    }

    // Check against server
    const datasets = await this.listDatasets();
    return datasets.some(d => d.id === datasetId);
  }

  /**
   * Get metadata for a dataset
   * @param {string} datasetId
   * @returns {Promise<DatasetMetadata>}
   */
  async getMetadata(datasetId) {
    if (!this._connected || !this._config) {
      throw new DataSourceError(
        'Not connected',
        DataSourceErrorCode.NETWORK_ERROR,
        this.type
      );
    }

    if (this._datasetCache.has(datasetId)) {
      return this._datasetCache.get(datasetId);
    }

    const baseUrl = `${this._config.serverUrl}/${datasetId}/`;
    const metadata = await loadDatasetMetadata(baseUrl, datasetId, this.type);
    this._datasetCache.set(datasetId, metadata);
    return metadata;
  }

  /**
   * Get base URL for dataset files
   * @param {string} datasetId
   * @returns {string}
   */
  getBaseUrl(datasetId) {
    if (!this._config) {
      throw new DataSourceError(
        'Not initialized',
        DataSourceErrorCode.NETWORK_ERROR,
        this.type
      );
    }

    this._activeDatasetId = datasetId;

    // Use jupyter:// protocol for consistent handling
    return `jupyter://${this._config.viewerId}/${datasetId}/`;
  }

  /**
   * Resolve a jupyter:// URL to fetchable HTTP URL
   * @param {string} url
   * @returns {Promise<string>}
   */
  async resolveUrl(url) {
    if (!isJupyterUrl(url)) {
      return url;
    }

    if (!this._config) {
      throw new DataSourceError(
        'Not initialized',
        DataSourceErrorCode.NETWORK_ERROR,
        this.type
      );
    }

    const parsed = parseJupyterUrl(url);
    if (!parsed) {
      throw new DataSourceError(
        `Invalid jupyter URL: ${url}`,
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
    }

    // Convert to HTTP URL, avoiding double slashes
    const path = parsed.path;
    if (!path || path === '') {
      return `${this._config.serverUrl}/`;
    }
    return `${this._config.serverUrl}/${path}`;
  }

  /**
   * Check if currently connected
   * @returns {boolean}
   */
  isConnected() {
    return this._connected && this._config !== null;
  }

  /**
   * Get connection info
   * @returns {{serverUrl: string|null, viewerId: string|null, status: string}}
   */
  getConnectionInfo() {
    return {
      serverUrl: this._config?.serverUrl || null,
      viewerId: this._config?.viewerId || null,
      status: this._connected ? 'connected' : 'disconnected'
    };
  }

  /**
   * Requires manual reconnect (Jupyter context needed)
   * @returns {boolean}
   */
  requiresManualReconnect() {
    return true;
  }

  /**
   * Refresh cached data
   */
  refresh() {
    this._datasetCache.clear();
  }

  /**
   * Cleanup on deactivation
   */
  onDeactivate() {
    console.log('[JupyterBridge] Deactivated');
  }

  /**
   * Cleanup and disconnect
   */
  disconnect() {
    window.removeEventListener('message', this._boundMessageHandler);
    this._connected = false;
    this._config = null;
    this._datasetCache.clear();
    this._pendingRequests.clear();
    this._messageCallbacks.clear();
    this._highlightCallbacks.clear();
    this._selectionCallbacks.clear();
  }
}

/**
 * Create a JupyterBridgeDataSource instance
 * @returns {JupyterBridgeDataSource}
 */
export function createJupyterBridgeDataSource() {
  return new JupyterBridgeDataSource();
}
