/**
 * RemoteDataSource - Data source for remote server connections
 *
 * Connects to a cellucid data server running on a remote machine
 * (or localhost via SSH tunnel). Supports both HTTP/HTTPS for data loading
 * and WebSocket/WSS for live updates.
 *
 * Protocol handling:
 * - remote://host:port  - Uses HTTP/WS (auto-upgrades to HTTPS/WSS if page is HTTPS)
 * - remotes://host:port - Explicitly uses HTTPS/WSS (secure)
 * - When the web app is served over HTTPS, all connections automatically use
 *   secure protocols to avoid mixed-content blocking.
 *
 * Usage modes:
 * 1. Direct connection: Server running on accessible host:port
 * 2. SSH tunnel: Server on remote machine, accessed via port forwarding
 * 3. Jupyter: Server running alongside Jupyter notebook
 *
 * Connection flow:
 * 1. User enters server URL (e.g., http://localhost:8765)
 * 2. RemoteDataSource.connect() validates connection
 * 3. On success, source is activated and datasets are listed
 * 4. Data is loaded via HTTP/HTTPS from server
 */

import {
  DATA_CONFIG,
  DataSourceError,
  DataSourceErrorCode,
  loadDatasetMetadata,
  validateDatasetStructure,
  validateSchemaVersion
} from './data-source.js';
import { expandObsManifest, expandVarManifest } from './data-loaders.js';

/**
 * @typedef {import('./data-source.js').DatasetMetadata} DatasetMetadata
 */

/**
 * @typedef {Object} RemoteServerInfo
 * @property {string} version - Server version
 * @property {string} data_dir - Data directory on server
 * @property {string} host - Server host
 * @property {number} port - Server port
 * @property {string} mode - Server mode ('standalone', 'async', 'jupyter')
 */

/**
 * @typedef {Object} ConnectionConfig
 * @property {string} url - Server base URL (e.g., 'http://localhost:8765')
 * @property {number} [timeout=5000] - Connection timeout in ms
 * @property {boolean} [autoReconnect=true] - Attempt auto-reconnect on connection loss
 */

/**
 * Determine if secure protocols (HTTPS/WSS) should be used.
 * Returns true if the current page is served over HTTPS.
 * This prevents mixed-content blocking in browsers.
 * @returns {boolean}
 */
function shouldUseSecureProtocol() {
  // In browser context, check the current page's protocol
  if (typeof window !== 'undefined' && window.location) {
    return window.location.protocol === 'https:';
  }
  // Default to insecure for non-browser contexts (e.g., Node.js testing)
  return false;
}

/**
 * Check if a URL uses the remote:// protocol
 * @param {string} url - URL to check
 * @returns {boolean}
 */
export function isRemoteUrl(url) {
  return url?.startsWith('remote://') || url?.startsWith('remotes://');
}

/**
 * Check if a URL explicitly requests secure connection (remotes://)
 * @param {string} url - URL to check
 * @returns {boolean}
 */
export function isSecureRemoteUrl(url) {
  return url?.startsWith('remotes://');
}

/**
 * Parse a remote:// or remotes:// URL into its components.
 * - remote:// uses HTTP/WS (but upgrades to HTTPS/WSS if page is HTTPS)
 * - remotes:// explicitly requests HTTPS/WSS
 * @param {string} url - URL to parse
 * @returns {{serverUrl: string, path: string, secure: boolean}|null}
 */
export function parseRemoteUrl(url) {
  if (!isRemoteUrl(url)) return null;

  // Match both remote:// and remotes://
  const match = url.match(/^remotes?:\/\/([^/]+)(\/.*)?$/);
  if (!match) return null;

  const hostPort = match[1];
  const path = (match[2] || '/').substring(1); // Remove leading /

  // Use secure protocol if:
  // 1. URL explicitly uses remotes:// OR
  // 2. Current page is served over HTTPS (to avoid mixed-content blocking)
  const secure = isSecureRemoteUrl(url) || shouldUseSecureProtocol();
  const protocol = secure ? 'https' : 'http';

  return {
    serverUrl: `${protocol}://${hostPort}`,
    path,
    secure
  };
}

/**
 * Data source for remote server connections
 */
export class RemoteDataSource {
  constructor() {
    /** @type {string|null} Server base URL */
    this._serverUrl = null;

    /** @type {RemoteServerInfo|null} */
    this._serverInfo = null;

    /** @type {boolean} */
    this._connected = false;

    /** @type {Map<string, DatasetMetadata>} */
    this._datasetCache = new Map();

    /** @type {string|null} */
    this._activeDatasetId = null;

    /** @type {WebSocket|null} */
    this._ws = null;

    /** @type {Set<Function>} */
    this._connectionLostCallbacks = new Set();

    /** @type {Set<Function>} */
    this._messageCallbacks = new Set();

    /** @type {boolean} */
    this._autoReconnect = true;

    /** @type {number} */
    this._reconnectAttempts = 0;

    /** @type {number} */
    this._maxReconnectAttempts = 5;

    /** @type {boolean} Flag to prevent concurrent reconnection attempts */
    this._reconnecting = false;

    this.type = 'remote';
  }

  /**
   * Get the type identifier for this data source
   * @returns {string}
   */
  getType() {
    return this.type;
  }

  /**
   * Check if this data source is available (connected)
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    return this._connected;
  }

  /**
   * Connect to a remote server
   * @param {ConnectionConfig} config - Connection configuration
   * @returns {Promise<RemoteServerInfo>}
   */
  async connect(config) {
    const { url, timeout = 5000, autoReconnect = true } = config;

    // Normalize URL
    let serverUrl = url.trim();
    if (!serverUrl.startsWith('http://') && !serverUrl.startsWith('https://')) {
      // If no protocol specified, use https:// when page is served over HTTPS
      // to avoid mixed-content blocking
      const protocol = shouldUseSecureProtocol() ? 'https://' : 'http://';
      serverUrl = protocol + serverUrl;
    }
    // Remove trailing slash
    serverUrl = serverUrl.replace(/\/+$/, '');

    this._serverUrl = serverUrl;
    this._autoReconnect = autoReconnect;

    console.log(`[RemoteDataSource] Connecting to ${serverUrl}...`);

    // Test connection with health check
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(`${serverUrl}/_cellucid/health`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new DataSourceError(
          `Server returned ${response.status}: ${response.statusText}`,
          DataSourceErrorCode.NETWORK_ERROR,
          this.type,
          { url: serverUrl, status: response.status }
        );
      }

      const health = await response.json();
      if (health.status !== 'ok') {
        throw new DataSourceError(
          'Server health check failed',
          DataSourceErrorCode.VALIDATION_ERROR,
          this.type,
          { health }
        );
      }

      // Get server info
      const infoResponse = await fetch(`${serverUrl}/_cellucid/info`);
      this._serverInfo = await infoResponse.json();

      this._connected = true;
      this._reconnectAttempts = 0;

      console.log(`[RemoteDataSource] Connected to ${serverUrl}`, this._serverInfo);

      // Try to connect WebSocket for live updates (optional)
      this._connectWebSocket();

      return this._serverInfo;
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new DataSourceError(
          `Connection timeout after ${timeout}ms`,
          DataSourceErrorCode.NETWORK_ERROR,
          this.type,
          { url: serverUrl, timeout }
        );
      }

      if (err instanceof DataSourceError) {
        throw err;
      }

      throw new DataSourceError(
        `Failed to connect: ${err.message}`,
        DataSourceErrorCode.NETWORK_ERROR,
        this.type,
        { url: serverUrl, originalError: err.message }
      );
    }
  }

  /**
   * Connect WebSocket for live updates
   * @private
   */
  _connectWebSocket() {
    if (!this._serverInfo?.ws_port) {
      console.log('[RemoteDataSource] Server does not support WebSocket');
      return;
    }

    // Use wss:// if the server URL is https:// (to avoid mixed-content blocking)
    const serverUrlObj = new URL(this._serverUrl);
    const wsProtocol = serverUrlObj.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${wsProtocol}://${serverUrlObj.hostname}:${this._serverInfo.ws_port}`;

    try {
      this._ws = new WebSocket(wsUrl);

      this._ws.onopen = () => {
        console.log('[RemoteDataSource] WebSocket connected');
      };

      this._ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this._handleMessage(data);
        } catch (err) {
          console.warn('[RemoteDataSource] Invalid WebSocket message:', err);
        }
      };

      this._ws.onclose = () => {
        console.log('[RemoteDataSource] WebSocket disconnected');
        this._ws = null;

        if (this._autoReconnect && this._connected) {
          this._attemptReconnect();
        }
      };

      this._ws.onerror = (err) => {
        console.warn('[RemoteDataSource] WebSocket error:', err);
      };
    } catch (err) {
      console.warn('[RemoteDataSource] Failed to connect WebSocket:', err);
    }
  }

  /**
   * Handle incoming WebSocket message
   * @param {Object} data - Message data
   * @private
   */
  _handleMessage(data) {
    for (const callback of this._messageCallbacks) {
      try {
        callback(data);
      } catch (err) {
        console.error('[RemoteDataSource] Message handler error:', err);
      }
    }
  }

  /**
   * Attempt to reconnect after connection loss
   * @private
   */
  async _attemptReconnect() {
    // Prevent concurrent reconnection attempts
    if (this._reconnecting) {
      return;
    }

    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      console.log('[RemoteDataSource] Max reconnect attempts reached');
      this._connected = false;
      this._reconnecting = false;
      this._notifyConnectionLost();
      return;
    }

    this._reconnecting = true;
    this._reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts - 1), 30000);

    console.log(`[RemoteDataSource] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts})...`);

    await new Promise(resolve => setTimeout(resolve, delay));

    // Check if user called disconnect() during the delay
    // Note: disconnect() sets both _connected = false AND _reconnecting = false
    if (!this._reconnecting) {
      return;
    }

    try {
      await this.connect({
        url: this._serverUrl,
        autoReconnect: this._autoReconnect
      });
      this._reconnecting = false;
    } catch (err) {
      console.warn('[RemoteDataSource] Reconnect failed:', err.message);
      // Keep _reconnecting = true to prevent concurrent attempts during recursive call
      // Schedule next attempt (recursive call will reset _reconnecting at start if needed)
      setTimeout(() => {
        this._reconnecting = false;
        this._attemptReconnect();
      }, 0);
    }
  }

  /**
   * Notify listeners of connection loss
   * @private
   */
  _notifyConnectionLost() {
    for (const callback of this._connectionLostCallbacks) {
      try {
        callback();
      } catch (err) {
        console.error('[RemoteDataSource] Connection lost handler error:', err);
      }
    }
  }

  /**
   * Disconnect from the server
   */
  disconnect() {
    this._connected = false;
    this._reconnecting = false;
    this._reconnectAttempts = 0;

    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }

    this._serverUrl = null;
    this._serverInfo = null;
    this._datasetCache.clear();
    this._activeDatasetId = null;

    console.log('[RemoteDataSource] Disconnected');
  }

  /**
   * Check if currently connected
   * @returns {boolean}
   */
  isConnected() {
    return this._connected;
  }

  /**
   * Get connection info
   * @returns {{url: string, serverInfo: RemoteServerInfo|null, status: string}}
   */
  getConnectionInfo() {
    return {
      url: this._serverUrl,
      serverInfo: this._serverInfo,
      status: this._connected ? 'connected' : 'disconnected'
    };
  }

  /**
   * Register callback for connection loss
   * @param {Function} callback
   */
  onConnectionLost(callback) {
    this._connectionLostCallbacks.add(callback);
  }

  /**
   * Remove connection loss callback
   * @param {Function} callback
   */
  offConnectionLost(callback) {
    this._connectionLostCallbacks.delete(callback);
  }

  /**
   * Register callback for WebSocket messages
   * @param {Function} callback
   */
  onMessage(callback) {
    this._messageCallbacks.add(callback);
  }

  /**
   * Remove message callback
   * @param {Function} callback
   */
  offMessage(callback) {
    this._messageCallbacks.delete(callback);
  }

  /**
   * Send a message via WebSocket
   * @param {Object} message
   */
  sendMessage(message) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      console.warn('[RemoteDataSource] WebSocket not connected');
      return;
    }
    this._ws.send(JSON.stringify(message));
  }

  /**
   * List all available datasets from the server
   * @returns {Promise<DatasetMetadata[]>}
   */
  async listDatasets() {
    if (!this._connected) {
      return [];
    }

    try {
      const response = await fetch(`${this._serverUrl}/_cellucid/datasets`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const datasetList = data.datasets || [];

      // Load metadata for all datasets in parallel
      const metadataPromises = datasetList.map(async (ds) => {
        try {
          const baseUrl = `${this._serverUrl}${ds.path}`;
          const metadata = await loadDatasetMetadata(baseUrl, ds.id, this.type);
          this._datasetCache.set(ds.id, metadata);
          return metadata;
        } catch (err) {
          console.warn(`[RemoteDataSource] Failed to load metadata for ${ds.id}:`, err);
          // Return minimal metadata on failure
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
      console.error('[RemoteDataSource] Failed to list datasets:', err);
      return [];
    }
  }

  /**
   * Check if a specific dataset exists
   * @param {string} datasetId - Dataset ID
   * @returns {Promise<boolean>}
   */
  async hasDataset(datasetId) {
    if (!this._connected) {
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
   * Get metadata for a specific dataset
   * @param {string} datasetId - Dataset ID
   * @returns {Promise<DatasetMetadata>}
   */
  async getMetadata(datasetId) {
    if (!this._connected) {
      throw new DataSourceError(
        'Not connected to server',
        DataSourceErrorCode.NETWORK_ERROR,
        this.type
      );
    }

    // Check cache
    if (this._datasetCache.has(datasetId)) {
      return this._datasetCache.get(datasetId);
    }

    // Determine base URL
    const baseUrl = this._getDatasetBaseUrl(datasetId);

    try {
      const metadata = await loadDatasetMetadata(baseUrl, datasetId, this.type);
      this._datasetCache.set(datasetId, metadata);
      return metadata;
    } catch (err) {
      throw new DataSourceError(
        `Failed to load metadata for dataset '${datasetId}': ${err.message}`,
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        { datasetId }
      );
    }
  }

  /**
   * Get base URL for a dataset
   * @param {string} datasetId - Dataset ID
   * @returns {string}
   * @private
   */
  _getDatasetBaseUrl(datasetId) {
    if (!this._serverUrl) {
      throw new DataSourceError(
        'Not connected to server',
        DataSourceErrorCode.NETWORK_ERROR,
        this.type
      );
    }
    // If single dataset mode (data_dir is the dataset), use root
    if (this._serverInfo?.data_dir?.endsWith(datasetId)) {
      return `${this._serverUrl}/`;
    }
    return `${this._serverUrl}/${datasetId}/`;
  }

  /**
   * Get the base URL for loading a dataset's files
   * Returns a remote:// protocol URL for proper handling
   * @param {string} datasetId - Dataset ID
   * @returns {string}
   */
  getBaseUrl(datasetId) {
    if (!this._serverUrl) {
      throw new DataSourceError(
        'Not connected to server',
        DataSourceErrorCode.NETWORK_ERROR,
        this.type
      );
    }

    this._activeDatasetId = datasetId;

    // Return remote:// protocol URL
    // This will be resolved by resolveUrl() to actual HTTP URL
    const urlHost = new URL(this._serverUrl).host;

    // If single dataset mode, use root path
    if (this._serverInfo?.data_dir?.endsWith(datasetId)) {
      return `remote://${urlHost}/`;
    }
    return `remote://${urlHost}/${datasetId}/`;
  }

  /**
   * Resolve a remote:// URL to a fetchable HTTP URL
   * @param {string} url - remote:// URL
   * @returns {Promise<string>}
   */
  async resolveUrl(url) {
    if (!isRemoteUrl(url)) {
      return url;
    }

    const parsed = parseRemoteUrl(url);
    if (!parsed) {
      throw new DataSourceError(
        `Invalid remote URL: ${url}`,
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
    }

    // Construct full HTTP URL, avoiding double slashes
    const path = parsed.path;
    if (!path || path === '') {
      return `${parsed.serverUrl}/`;
    }
    return `${parsed.serverUrl}/${path}`;
  }

  /**
   * Whether this source requires manual reconnection
   * Remote servers may need re-authentication or could have lost connection
   * @returns {boolean}
   */
  requiresManualReconnect() {
    // If we're connected, auto-restore can work
    // If disconnected, need manual reconnection
    return !this._connected;
  }

  /**
   * Refresh cached data
   */
  refresh() {
    this._datasetCache.clear();
  }

  /**
   * Called when this source is deactivated
   */
  onDeactivate() {
    // Keep connection alive when switching sources
    // User might switch back
    console.log('[RemoteDataSource] Deactivated (connection kept alive)');
  }
}

/**
 * Create a RemoteDataSource instance
 * @returns {RemoteDataSource}
 */
export function createRemoteDataSource() {
  return new RemoteDataSource();
}
