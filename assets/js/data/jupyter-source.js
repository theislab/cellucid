/**
 * JupyterBridgeDataSource - Data source for Jupyter notebook integration
 *
 * Provides communication between the web viewer (in an iframe)
 * and a Jupyter notebook running the cellucid Python package.
 *
 * Communication flow:
 * 1. Jupyter cell embeds viewer in iframe with special URL params
 * 2. Viewer detects Jupyter mode and creates JupyterBridgeDataSource
 * 3. Source communicates with parent frame via postMessage (Python → Frontend)
 * 4. Source POSTs events to the data server (Frontend → Python)
 *
 * Features:
 * - Data loading from Jupyter server (works everywhere)
 * - Live highlighting from Python (works everywhere)
 * - Selection/hover/click notifications to Python (works everywhere via HTTP POST)
 *
 * Bidirectional communication works in ALL environments:
 * - Python → Frontend: postMessage from notebook to iframe
 * - Frontend → Python: HTTP POST to /_cellucid/events on the data server
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
 * @property {string} viewerToken - Per-viewer authentication token
 */

function requireSingleJupyterParameter(params, key) {
  const values = params.getAll(key);
  if (
    values.length !== 1 ||
    values[0].length === 0 ||
    values[0] !== values[0].trim() ||
    /\s/.test(values[0])
  ) {
    throw new Error(
      'Jupyter configuration requires exactly one non-whitespace ' +
      'viewerId and viewerToken'
    );
  }
  return values[0];
}

/**
 * Check if running in Jupyter iframe context
 * @returns {boolean}
 */
export function isJupyterContext() {
  return getJupyterConfig() !== null;
}

/**
 * Get Jupyter configuration from URL parameters
 * @returns {JupyterConfig|null}
 */
export function getJupyterConfig() {
  const params = new URLSearchParams(window.location.search);
  const declaredKeys = [...params.keys()];
  const modeValues = params.getAll('jupyter');
  if (modeValues.length === 0) {
    return null;
  }
  const annDataValues = params.getAll('anndata');
  if (
    (declaredKeys.length !== 3 && declaredKeys.length !== 4) ||
    declaredKeys.some(
      key =>
        key !== 'jupyter' &&
        key !== 'viewerId' &&
        key !== 'viewerToken' &&
        key !== 'anndata'
    ) ||
    (annDataValues.length !== 0 &&
      (annDataValues.length !== 1 || annDataValues[0] !== 'true'))
  ) {
    throw new Error(
      'Jupyter mode URL must contain exact routing fields and only the ' +
      'optional anndata=true server discriminator'
    );
  }
  if (modeValues.length !== 1 || modeValues[0] !== 'true') {
    throw new Error('Jupyter mode must be declared exactly once as jupyter=true');
  }
  const viewerId = requireSingleJupyterParameter(params, 'viewerId');
  const viewerToken = requireSingleJupyterParameter(params, 'viewerToken');
  const defaultBase = new URL('.', window.location.href).toString().replace(/\/$/, '');

  return {
    serverUrl: defaultBase,
    viewerId,
    viewerToken
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

function requireJupyterRuntimeConfig(config) {
  if (
    config === null ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    Object.keys(config).length !== 3 ||
    !Object.hasOwn(config, 'serverUrl') ||
    !Object.hasOwn(config, 'viewerId') ||
    !Object.hasOwn(config, 'viewerToken')
  ) {
    throw new TypeError(
      'Jupyter configuration must contain exactly serverUrl, viewerId, and viewerToken'
    );
  }
  for (const key of ['serverUrl', 'viewerId', 'viewerToken']) {
    if (
      typeof config[key] !== 'string' ||
      config[key].length === 0 ||
      config[key] !== config[key].trim() ||
      /\s/.test(config[key])
    ) {
      throw new TypeError(`Jupyter ${key} must be exact non-whitespace text`);
    }
  }
  const serverUrl = new URL(config.serverUrl);
  if (
    (serverUrl.protocol !== 'http:' && serverUrl.protocol !== 'https:') ||
    serverUrl.username ||
    serverUrl.password ||
    serverUrl.search ||
    serverUrl.hash ||
    config.serverUrl.endsWith('/')
  ) {
    throw new TypeError(
      'Jupyter serverUrl must be an exact HTTP(S) base URL without credentials, query, fragment, or trailing slash'
    );
  }
  return config;
}

function requireJupyterSuccessPayload(payload, label) {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    Object.keys(payload).length !== 2 ||
    payload.status !== 'ok' ||
    payload.delivered !== true
  ) {
    throw new Error(
      `${label} returned a noncanonical success payload`
    );
  }
}

function isPlainRecord(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function requireExactKeys(value, expectedKeys, label) {
  if (!isPlainRecord(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== expectedKeys.length ||
    expectedKeys.some(key => !Object.hasOwn(value, key))
  ) {
    throw new TypeError(
      `${label} must contain exactly ${expectedKeys.join(', ')}`
    );
  }
  return value;
}

function requireExactText(value, label, { allowWhitespace = false } = {}) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    (!allowWhitespace && /\s/.test(value))
  ) {
    throw new TypeError(`${label} must be exact non-empty text`);
  }
  return value;
}

function requireExactJsonValue(value, label, ancestors = new Set()) {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${label} numbers must be finite`);
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new TypeError(`${label} must contain only exact JSON values`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${label} must not contain cycles`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError(`${label} arrays must not contain holes`);
      }
      requireExactJsonValue(value[index], `${label}[${index}]`, ancestors);
    }
  } else {
    if (!isPlainRecord(value)) {
      throw new TypeError(`${label} objects must be plain JSON objects`);
    }
    for (const [key, entry] of Object.entries(value)) {
      requireExactText(key, `${label} key`, { allowWhitespace: true });
      requireExactJsonValue(entry, `${label}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return value;
}

function requireCellIndices(value, label) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  const seen = new Set();
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) {
      throw new TypeError(`${label} must not contain holes`);
    }
    const cellIndex = requireNonNegativeInteger(
      value[index],
      `${label}[${index}]`
    );
    if (seen.has(cellIndex)) {
      throw new TypeError(`${label} must not contain duplicate cell indices`);
    }
    seen.add(cellIndex);
  }
  return value;
}

function requireJupyterHealthPayload(payload) {
  if (!isPlainRecord(payload)) {
    throw new TypeError('Jupyter health response must be a JSON object');
  }
  if (payload.type === 'exported') {
    requireExactKeys(
      payload,
      ['status', 'type', 'version'],
      'Jupyter exported health response'
    );
  } else if (payload.type === 'anndata') {
    requireExactKeys(
      payload,
      [
        'status',
        'type',
        'version',
        'format',
        'is_backed',
        'n_cells',
        'n_genes'
      ],
      'Jupyter AnnData health response'
    );
    requireExactText(
      payload.format,
      'Jupyter AnnData health format',
      { allowWhitespace: true }
    );
    if (typeof payload.is_backed !== 'boolean') {
      throw new TypeError('Jupyter AnnData health is_backed must be a boolean');
    }
    requireNonNegativeInteger(
      payload.n_cells,
      'Jupyter AnnData health n_cells'
    );
    requireNonNegativeInteger(
      payload.n_genes,
      'Jupyter AnnData health n_genes'
    );
  } else {
    throw new TypeError(
      'Jupyter health response type must be exactly exported or anndata'
    );
  }
  if (payload.status !== 'ok') {
    throw new TypeError('Jupyter health response status must be exactly ok');
  }
  requireExactText(
    payload.version,
    'Jupyter health version',
    { allowWhitespace: true }
  );
  return payload;
}

async function requestJupyterHealth(config) {
  const exactConfig = requireJupyterRuntimeConfig(config);
  const response = await fetch(
    `${exactConfig.serverUrl}/_cellucid/health`,
    { cache: 'no-store' }
  );
  if (!(response instanceof Response)) {
    throw new TypeError('Jupyter health fetch must return a Response');
  }
  if (!response.ok) {
    throw new Error(
      `Jupyter health request failed with HTTP ${response.status}`
    );
  }
  return requireJupyterHealthPayload(await response.json());
}

function requireDatasetCatalogPath(value, label) {
  if (
    typeof value !== 'string' ||
    !/^\/(?:[A-Za-z0-9][A-Za-z0-9._-]{0,179}\/)?$/.test(value) ||
    value.includes('/./') ||
    value.includes('/../')
  ) {
    throw new TypeError(
      `${label} must be "/" or one exact portable dataset directory path`
    );
  }
  const component = value === '/' ? null : value.slice(1, -1);
  if (
    component !== null &&
    (component.endsWith('.') ||
      /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(component))
  ) {
    throw new TypeError(`${label} contains a non-portable dataset directory`);
  }
  return value;
}

function requireDatasetCatalogPayload(payload) {
  requireExactKeys(payload, ['datasets'], 'Jupyter dataset listing');
  if (!Array.isArray(payload.datasets)) {
    throw new TypeError('Jupyter dataset listing datasets must be an array');
  }
  const ids = new Set();
  const paths = new Set();
  return payload.datasets.map((entry, index) => {
    const label = `Jupyter dataset listing datasets[${index}]`;
    requireExactKeys(entry, ['id', 'path', 'name'], label);
    const id = requireExactText(
      entry.id,
      `${label}.id`,
      { allowWhitespace: true }
    );
    const path = requireDatasetCatalogPath(entry.path, `${label}.path`);
    const name = requireExactText(
      entry.name,
      `${label}.name`,
      { allowWhitespace: true }
    );
    if (ids.has(id)) {
      throw new TypeError(`Jupyter dataset listing contains duplicate id ${id}`);
    }
    if (paths.has(path)) {
      throw new TypeError(
        `Jupyter dataset listing contains duplicate path ${path}`
      );
    }
    ids.add(id);
    paths.add(path);
    return Object.freeze({ id, path, name });
  });
}

function requireJupyterSessionUploadPayload(payload, expectedBytes) {
  requireExactKeys(
    payload,
    ['status', 'bytes'],
    'Jupyter session upload response'
  );
  if (payload.status !== 'ok') {
    throw new TypeError(
      'Jupyter session upload response status must be exactly ok'
    );
  }
  requireNonNegativeInteger(
    payload.bytes,
    'Jupyter session upload response bytes'
  );
  if (payload.bytes !== expectedBytes) {
    throw new Error(
      'Jupyter session upload response bytes must match the uploaded bundle'
    );
  }
}

function deliverCallbacks(callbacks, args) {
  const pending = [];
  for (const callback of callbacks) {
    const result = callback(...args);
    if (result instanceof Promise) {
      pending.push(result);
    }
  }
  return pending.length === 0 ? undefined : Promise.all(pending);
}

/**
 * Build and upload one authenticated session bundle for one exact Python request.
 *
 * @param {{
 *   config: JupyterConfig,
 *   message: Object,
 *   createSessionBundle: () => Promise<Blob>,
 *   fetchImpl: typeof fetch,
 * }} options
 */
export async function uploadJupyterSessionBundle(options) {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).length !== 4 ||
    !Object.hasOwn(options, 'config') ||
    !Object.hasOwn(options, 'message') ||
    !Object.hasOwn(options, 'createSessionBundle') ||
    !Object.hasOwn(options, 'fetchImpl')
  ) {
    throw new TypeError(
      'Session upload options must contain exactly config, message, createSessionBundle, and fetchImpl'
    );
  }
  const config = requireJupyterRuntimeConfig(options.config);
  const message = options.message;
  if (
    message === null ||
    typeof message !== 'object' ||
    Array.isArray(message) ||
    Object.keys(message).length !== 4 ||
    message.type !== 'requestSessionBundle' ||
    message.viewerId !== config.viewerId ||
    message.viewerToken !== config.viewerToken
  ) {
    throw new TypeError(
      'Session request must contain exactly authenticated type, requestId, viewerId, and viewerToken'
    );
  }
  if (
    typeof message.requestId !== 'string' ||
    message.requestId.length === 0 ||
    message.requestId !== message.requestId.trim() ||
    /\s/.test(message.requestId)
  ) {
    throw new TypeError('Session requestId must be exact non-empty text without whitespace');
  }
  if (typeof options.createSessionBundle !== 'function') {
    throw new TypeError('createSessionBundle must be a function');
  }
  if (typeof options.fetchImpl !== 'function') {
    throw new TypeError('fetchImpl must be a function');
  }

  const blob = await options.createSessionBundle();
  if (!(blob instanceof Blob) || blob.size <= 0) {
    throw new TypeError('Session serializer must produce one non-empty Blob');
  }
  const query = new URLSearchParams([
    ['viewerId', config.viewerId],
    ['viewerToken', config.viewerToken],
    ['requestId', message.requestId],
  ]);
  const fetchImpl = options.fetchImpl;
  const response = await fetchImpl(
    `${config.serverUrl}/_cellucid/session_bundle?${query.toString()}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob
    }
  );
  if (!(response instanceof Response)) {
    throw new TypeError('Session upload fetch must return a Response');
  }
  if (!response.ok) {
    throw new Error(
      `Jupyter session upload failed with HTTP ${response.status}`
    );
  }
  requireJupyterSessionUploadPayload(
    await response.json(),
    blob.size
  );
}

/**
 * Data source for Jupyter notebook integration
 */
export class JupyterBridgeDataSource {
  constructor() {
    /** @type {JupyterConfig|null} */
    this._config = null;

    /**
     * Captured parent origin for outgoing postMessage.
     * Learned from the first inbound message that passes origin validation.
     * @type {string|null}
     */
    this._parentOrigin = null;

    /** @type {boolean} */
    this._connected = false;

    /** @type {Map<string, DatasetMetadata>} */
    this._datasetCache = new Map();

    /** @type {Map<string, string>} Dataset ID -> base path (from /_cellucid/datasets) */
    this._datasetPaths = new Map();

    /** @type {Set<Function>} */
    this._messageCallbacks = new Set();

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
      return false;
    }

    await requestJupyterHealth(config);

    this._config = config;
    this._connected = true;
    return true;
  }

  /**
   * Validate the live Python server against the current health contract.
   * @returns {Promise<Object>}
   */
  async checkHealth() {
    if (!this._connected) {
      throw new Error('Jupyter health check requires an initialized connection');
    }
    return requestJupyterHealth(this._config);
  }

  /**
   * Handle incoming message from parent frame
   * @param {MessageEvent} event
   * @private
   */
  _handleMessage(event) {
    const data = event.data;
    if (!isPlainRecord(data)) return;

    const config = requireJupyterRuntimeConfig(this._config);

    // Messages without this viewer's secret are unrelated window traffic.
    if (data.viewerToken !== this._config.viewerToken) return;

    if (data.viewerId !== config.viewerId) {
      throw new TypeError(
        'Authenticated Jupyter message viewerId must match this viewer'
      );
    }
    requireExactText(data.type, 'Authenticated Jupyter message type');
    requireExactText(
      event.origin,
      'Authenticated Jupyter message origin',
      { allowWhitespace: true }
    );

    if (!this._parentOrigin) {
      this._parentOrigin = event.origin;
    } else if (event.origin !== this._parentOrigin) {
      throw new Error(
        'Authenticated Jupyter message origin must match the pinned parent origin'
      );
    }

    switch (data.type) {
      case 'ping':
        requireExactKeys(
          data,
          ['type', 'requestId', 'viewerId', 'viewerToken'],
          'Jupyter ping message'
        );
        requireExactText(data.requestId, 'Jupyter ping requestId');
        return this._postEventToPython({
          type: 'pong',
          requestId: data.requestId,
          t: Date.now()
        });

      case 'debug_snapshot':
        requireExactKeys(
          data,
          ['type', 'requestId', 'viewerId', 'viewerToken'],
          'Jupyter debug snapshot message'
        );
        requireExactText(
          data.requestId,
          'Jupyter debug snapshot requestId'
        );
        return this._postEventToPython({
          type: 'debug_snapshot',
          requestId: data.requestId,
          ts: new Date().toISOString(),
          locationHref: window.location.href,
          origin: window.location.origin,
          serverUrl: config.serverUrl,
          connected: this._connected,
          parentOrigin: this._parentOrigin,
          userAgent: (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent : null
        });

      case 'highlight':
        return this._handleHighlight(data);

      case 'setColorBy':
        return this._handleSetColorBy(data);

      case 'setVisibility':
        return this._handleSetVisibility(data);

      case 'clearHighlights':
        requireExactKeys(
          data,
          ['type', 'viewerId', 'viewerToken'],
          'Jupyter clear-highlights message'
        );
        return this._handleClearHighlights();

      case 'resetCamera':
        requireExactKeys(
          data,
          ['type', 'viewerId', 'viewerToken'],
          'Jupyter reset-camera message'
        );
        return this._handleResetCamera(data);

      case 'freeze':
        requireExactKeys(
          data,
          ['type', 'viewerId', 'viewerToken'],
          'Jupyter freeze message'
        );
        return deliverCallbacks(this._messageCallbacks, [data]);

      case 'requestSessionBundle':
        requireExactKeys(
          data,
          ['type', 'requestId', 'viewerId', 'viewerToken'],
          'Jupyter session-bundle request'
        );
        requireExactText(
          data.requestId,
          'Jupyter session-bundle requestId'
        );
        return deliverCallbacks(this._messageCallbacks, [data]);

      default:
        requireExactJsonValue(data, 'Authenticated Jupyter message');
        return deliverCallbacks(this._messageCallbacks, [data]);
    }
  }

  /**
   * Handle highlight command from Python
   * @param {Object} data
   * @private
   */
  _handleHighlight(data) {
    requireExactKeys(
      data,
      ['type', 'cells', 'color', 'viewerId', 'viewerToken'],
      'Jupyter highlight message'
    );
    const { cells, color } = data;
    requireCellIndices(cells, 'Jupyter highlight cells');
    if (cells.length === 0) {
      throw new TypeError(
        'Jupyter highlight cells must be a non-empty array'
      );
    }
    if (
      typeof color !== 'string' ||
      !/^#[0-9a-fA-F]{6}$/.test(color)
    ) {
      throw new TypeError(
        'Jupyter highlight color must be an exact six-digit hex color'
      );
    }
    return deliverCallbacks(this._highlightCallbacks, [cells, color]);
  }

  /**
   * Handle color by command
   * @param {Object} data
   * @private
   */
  _handleSetColorBy(data) {
    requireExactKeys(
      data,
      ['type', 'field', 'viewerId', 'viewerToken'],
      'Jupyter set-color-by message'
    );
    const { field } = data;
    requireExactText(
      field,
      'Jupyter set-color-by field',
      { allowWhitespace: true }
    );
    return deliverCallbacks(this._messageCallbacks, [data]);
  }

  /**
   * Handle visibility command
   * @param {Object} data
   * @private
   */
  _handleSetVisibility(data) {
    requireExactKeys(
      data,
      ['type', 'cells', 'visible', 'viewerId', 'viewerToken'],
      'Jupyter set-visibility message'
    );
    const { cells, visible } = data;
    if (cells !== null) {
      requireCellIndices(cells, 'Jupyter set-visibility cells');
    }
    if (typeof visible !== 'boolean') {
      throw new TypeError(
        'Jupyter set-visibility visible must be a boolean'
      );
    }
    return deliverCallbacks(this._messageCallbacks, [data]);
  }

  /**
   * Handle clear highlights command
   * @private
   */
  _handleClearHighlights() {
    return deliverCallbacks(this._highlightCallbacks, [[], null]);
  }

  /**
   * Handle reset camera command
   * @private
   */
  _handleResetCamera(data) {
    return deliverCallbacks(this._messageCallbacks, [data]);
  }

  /**
   * Post event to Python via HTTP POST to the data server.
   * This enables Frontend → Python communication in ALL environments.
   * @param {Object} event - Event data with a non-empty type
   * @private
   */
  async _postEventToPython(event) {
    const config = requireJupyterRuntimeConfig(this._config);
    if (
      !isPlainRecord(event) ||
      typeof event.type !== 'string' ||
      event.type.length === 0 ||
      event.type !== event.type.trim() ||
      /\s/.test(event.type) ||
      Object.hasOwn(event, 'viewerId') ||
      Object.hasOwn(event, 'viewerToken')
    ) {
      throw new TypeError(
        'Jupyter event must have one exact type and must not supply routing credentials'
      );
    }
    requireExactJsonValue(event, 'Jupyter event');
    const response = await fetch(`${config.serverUrl}/_cellucid/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ...event,
        viewerId: config.viewerId,
        viewerToken: config.viewerToken,
      }),
      keepalive: true
    });
    if (!(response instanceof Response)) {
      throw new TypeError('Jupyter event fetch must return a Response');
    }
    if (!response.ok) {
      throw new Error(
        `Jupyter event delivery failed with HTTP ${response.status}`
      );
    }
    requireJupyterSuccessPayload(
      await response.json(),
      'Jupyter event delivery'
    );
  }

  // =========================================================================
  // PYTHON NOTIFICATION METHODS (Frontend → Python)
  // =========================================================================
  // These methods send events to Python via HTTP POST to the data server.
  // This works in ALL environments (Jupyter, JupyterLab, Colab, VSCode).
  /**
   * Notify Python of cell selection change
   * @param {number[]} cellIndices - Selected cell indices
   * @param {string} source - Selection source ('lasso', 'click', 'range')
   */
  async notifySelection(cellIndices, source) {
    if (!this._connected) {
      throw new Error('Jupyter event source is not connected');
    }
    requireCellIndices(cellIndices, 'Jupyter selection cells');
    requireExactText(source, 'Jupyter selection source');
    const event = {
      type: 'selection',
      cells: cellIndices,
      source: source
    };
    return this._postEventToPython(event);
  }

  /**
   * Notify Python of cell hover (debounced internally)
   * @param {number|null} cellIndex - Hovered cell index, or null if not hovering
   * @param {{x: number, y: number, z: number}|null} position - World coordinates
   */
  async notifyHover(cellIndex, position) {
    if (!this._connected) {
      throw new Error('Jupyter event source is not connected');
    }
    if (cellIndex !== null) {
      requireNonNegativeInteger(cellIndex, 'Jupyter hover cell');
    }
    if (position !== null) {
      requireExactKeys(
        position,
        ['x', 'y', 'z'],
        'Jupyter hover position'
      );
      for (const axis of ['x', 'y', 'z']) {
        if (!Number.isFinite(position[axis])) {
          throw new TypeError(
            `Jupyter hover position ${axis} must be finite`
          );
        }
      }
    }
    return this._postEventToPython({
      type: 'hover',
      cell: cellIndex,
      position
    });
  }

  /**
   * Notify Python of cell click
   * @param {number} cellIndex - Clicked cell index
   * @param {Object} options - Click options
   * @param {number} options.button - Mouse button (0=left, 1=middle, 2=right)
   * @param {boolean} options.shift - Shift key held
   * @param {boolean} options.ctrl - Ctrl/Cmd key held
   */
  async notifyClick(cellIndex, options) {
    if (!this._connected) {
      throw new Error('Jupyter event source is not connected');
    }
    requireNonNegativeInteger(cellIndex, 'Jupyter click cell');
    requireExactKeys(
      options,
      ['button', 'shift', 'ctrl'],
      'Jupyter click options'
    );
    if (
      !Number.isInteger(options.button) ||
      options.button < 0 ||
      options.button > 2
    ) {
      throw new TypeError(
        'Jupyter click button must be the integer 0, 1, or 2'
      );
    }
    if (
      typeof options.shift !== 'boolean' ||
      typeof options.ctrl !== 'boolean'
    ) {
      throw new TypeError(
        'Jupyter click shift and ctrl must be booleans'
      );
    }
    const event = {
      type: 'click',
      cell: cellIndex,
      button: options.button,
      shift: options.shift,
      ctrl: options.ctrl
    };
    return this._postEventToPython(event);
  }

  /**
   * Notify Python that viewer is ready with dataset info
   * @param {Object} info - Dataset info
   * @param {number} info.nCells - Number of cells
   * @param {number} info.dimensions - Embedding dimensions (1, 2, or 3)
   */
  async notifyReady(info) {
    if (!this._connected) {
      throw new Error('Jupyter event source is not connected');
    }
    requireExactKeys(
      info,
      ['nCells', 'dimensions'],
      'Jupyter ready info'
    );
    requireNonNegativeInteger(info.nCells, 'Jupyter ready nCells');
    if (
      info.dimensions !== 1 &&
      info.dimensions !== 2 &&
      info.dimensions !== 3
    ) {
      throw new TypeError(
        'Jupyter ready dimensions must be exactly 1, 2, or 3'
      );
    }
    const event = {
      type: 'ready',
      n_cells: info.nCells,
      dimensions: info.dimensions
    };
    return this._postEventToPython(event);
  }

  /**
   * Send a custom event to Python
   * Use this for app-specific events not covered by the standard hooks.
   * @param {string} eventType - Custom event type name
   * @param {Object} data - Event data
   */
  async notifyCustomEvent(eventType, data) {
    if (!this._connected) {
      throw new Error('Jupyter event source is not connected');
    }
    requireExactText(eventType, 'Jupyter custom event type');
    if (!isPlainRecord(data)) {
      throw new TypeError('Jupyter custom event data must be a JSON object');
    }
    if (
      Object.hasOwn(data, 'type') ||
      Object.hasOwn(data, 'viewerId') ||
      Object.hasOwn(data, 'viewerToken')
    ) {
      throw new TypeError(
        'Jupyter custom event data must not supply type or routing credentials'
      );
    }
    requireExactJsonValue(data, 'Jupyter custom event data');
    const event = {
      type: eventType,
      ...data
    };
    return this._postEventToPython(event);
  }

  // =========================================================================
  // PYTHON EVENT CALLBACKS (Python → Frontend)
  // =========================================================================

  /**
   * Register callback for highlight events from Python
   * @param {Function} callback - Called with (cells, color)
   */
  onHighlight(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Jupyter highlight callback must be a function');
    }
    this._highlightCallbacks.add(callback);
  }

  /**
   * Remove highlight callback
   * @param {Function} callback
   */
  offHighlight(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Jupyter highlight callback must be a function');
    }
    this._highlightCallbacks.delete(callback);
  }

  /**
   * Register callback for generic messages
   * @param {Function} callback
   */
  onMessage(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Jupyter message callback must be a function');
    }
    this._messageCallbacks.add(callback);
  }

  /**
   * List datasets from server
   * @returns {Promise<DatasetMetadata[]>}
   */
  async listDatasets() {
    if (!this._connected || !this._config) {
      throw new DataSourceError(
        'Jupyter dataset listing requires an initialized connection',
        DataSourceErrorCode.NETWORK_ERROR,
        this.type
      );
    }

    const response = await fetch(
      `${this._config.serverUrl}/_cellucid/datasets`
    );
    if (!(response instanceof Response)) {
      throw new TypeError(
        'Jupyter dataset listing fetch must return a Response'
      );
    }
    if (!response.ok) {
      throw new Error(
        `Jupyter dataset listing failed with HTTP ${response.status}`
      );
    }

    const datasetList = requireDatasetCatalogPayload(await response.json());
    const stagedPaths = new Map(
      datasetList.map(dataset => [dataset.id, dataset.path])
    );
    const stagedMetadataEntries = await Promise.all(
      datasetList.map(async dataset => {
        const metadata = await loadDatasetMetadata(
          `${this._config.serverUrl}${dataset.path}`,
          dataset.id,
          this.type
        );
        return [dataset.id, metadata];
      })
    );
    const stagedCache = new Map(stagedMetadataEntries);

    this._datasetPaths = stagedPaths;
    this._datasetCache = stagedCache;
    return stagedMetadataEntries.map(([, metadata]) => metadata);
  }

  _requireDatasetId(datasetId) {
    return requireExactText(
      datasetId,
      'Jupyter dataset id',
      { allowWhitespace: true }
    );
  }

  _requireDeclaredDatasetPath(datasetId) {
    const id = this._requireDatasetId(datasetId);
    if (!this._datasetPaths.has(id)) {
      throw new DataSourceError(
        `Jupyter dataset ${JSON.stringify(id)} is not declared by the current listing`,
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        { datasetId: id }
      );
    }
    return this._datasetPaths.get(id);
  }

  /**
   * Check if a specific dataset exists
   * @param {string} datasetId - Dataset ID
   * @returns {Promise<boolean>}
   */
  async hasDataset(datasetId) {
    if (!this._connected || !this._config) {
      throw new DataSourceError(
        'Jupyter dataset lookup requires an initialized connection',
        DataSourceErrorCode.NETWORK_ERROR,
        this.type
      );
    }
    const id = this._requireDatasetId(datasetId);

    if (this._datasetPaths.has(id)) {
      return true;
    }

    const datasets = await this.listDatasets();
    return datasets.some(dataset => dataset.id === id);
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
    const id = this._requireDatasetId(datasetId);

    if (this._datasetCache.has(id)) {
      return this._datasetCache.get(id);
    }

    const datasetPath = this._requireDeclaredDatasetPath(id);
    const metadata = await loadDatasetMetadata(
      `${this._config.serverUrl}${datasetPath}`,
      id,
      this.type
    );
    this._datasetCache.set(id, metadata);
    return metadata;
  }

  /**
   * Get base URL for dataset files
   * @param {string} datasetId
   * @returns {string}
   */
  getBaseUrl(datasetId) {
    if (!this._connected || !this._config) {
      throw new DataSourceError(
        'Jupyter dataset URL requires an initialized connection',
        DataSourceErrorCode.NETWORK_ERROR,
        this.type
      );
    }

    const datasetPath = this._requireDeclaredDatasetPath(datasetId);
    if (datasetPath === '/') {
      return `jupyter://${this._config.viewerId}/`;
    }
    return `jupyter://${this._config.viewerId}${datasetPath}`;
  }

  /**
   * Resolve a jupyter:// URL to fetchable HTTP URL
   * @param {string} url
   * @returns {Promise<string>}
   */
  async resolveUrl(url) {
    if (!isJupyterUrl(url)) {
      throw new DataSourceError(
        `Jupyter source cannot resolve a non-Jupyter URL: ${url}`,
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
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
    if (parsed.viewerId !== this._config.viewerId) {
      throw new DataSourceError(
        'Jupyter URL viewer id does not match the active viewer',
        DataSourceErrorCode.INVALID_FORMAT,
        this.type,
        {
          expectedViewerId: this._config.viewerId,
          actualViewerId: parsed.viewerId
        }
      );
    }

    const path = parsed.path;
    if (path === '') {
      return `${this._config.serverUrl}/`;
    }
    if (
      path.startsWith('/') ||
      path.endsWith('/') ||
      path.includes('\\') ||
      path.includes('?') ||
      path.includes('#') ||
      /\s/.test(path) ||
      path.split('/').some(part => part === '' || part === '.' || part === '..')
    ) {
      throw new DataSourceError(
        `Invalid Jupyter artifact path: ${path}`,
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
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
    return undefined;
  }

  /**
   * Cleanup and disconnect
   */
  disconnect() {
    window.removeEventListener('message', this._boundMessageHandler);
    this._connected = false;
    this._config = null;
    this._parentOrigin = null;
    this._datasetCache.clear();
    this._datasetPaths.clear();
    this._messageCallbacks.clear();
    this._highlightCallbacks.clear();
  }
}

/**
 * Create a JupyterBridgeDataSource instance
 * @returns {JupyterBridgeDataSource}
 */
export function createJupyterBridgeDataSource() {
  return new JupyterBridgeDataSource();
}
