/**
 * Exact remote Cellucid server data source.
 *
 * A connection is adopted only after the health response, server information,
 * dataset catalog, and any advertised WebSocket have all satisfied the current
 * contract. Remote failures are terminal; this source never retries,
 * reconnects, fabricates dataset metadata, or rewrites caller-supplied URLs.
 *
 * A Cellucid server (`cellucid serve` of an .h5ad or Zarr store,
 * `serve_anndata()`) serves one AnnData store and declares it in its catalog
 * entry (`anndata`, see `served-anndata.js`); the browser's AnnData reader
 * reads it in place under the server's dataset id and name, and
 * `getAnnDataSource()` exposes it.
 */

import {
  DataSourceError,
  DataSourceErrorCode,
  readBoundedJson
} from './data-source.js';
import {
  loadMetadataBatchAtomically,
} from './metadata-load-contract.js';
import {
  describeServedAnnData,
  openServedAnnData,
  requireServedAnnData,
  servedStoreKey
} from './served-anndata.js';

/**
 * @typedef {import('./data-source.js').DatasetMetadata} DatasetMetadata
 */

const DEFAULT_CONNECTION_TIMEOUT_MS = 5000;
const MAX_CONNECTION_TIMEOUT_MS = 120000;
const REMOTE_MESSAGE_KEYS = Object.freeze(['type', 'payload']);

function isPlainRecord(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function requireExactKeys(value, requiredKeys, optionalKeys, label) {
  if (!isPlainRecord(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
  const actualKeys = Object.keys(value);
  const missing = requiredKeys.filter(key => !Object.hasOwn(value, key));
  const unsupported = actualKeys.filter(key => !allowedKeys.has(key));
  if (missing.length > 0 || unsupported.length > 0) {
    const details = [];
    if (missing.length > 0) details.push(`missing ${missing.join(', ')}`);
    if (unsupported.length > 0) {
      details.push(`unsupported ${unsupported.join(', ')}`);
    }
    throw new TypeError(
      `${label} has noncanonical fields (${details.join('; ')})`
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

function requireNonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function requirePort(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new TypeError(`${label} must be an integer from 1 through 65535`);
  }
  return value;
}

function requireCanonicalPathSegments(pathname, label) {
  const segments = pathname.split('/').slice(1);
  if (segments.at(-1) === '') segments.pop();
  for (const segment of segments) {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new TypeError(`${label} contains invalid percent encoding`);
    }
    if (
      segment.length === 0 ||
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('%') ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      /[\u0000-\u001f\u007f]/.test(decoded) ||
      encodeURIComponent(decoded) !== segment
    ) {
      throw new TypeError(`${label} contains a noncanonical path segment`);
    }
  }
}

function requireConnectionConfig(config) {
  requireExactKeys(
    config,
    ['url'],
    ['timeout'],
    'Remote connection configuration'
  );
  const url = validateRemoteServerUrl(config.url);
  const timeout = Object.hasOwn(config, 'timeout')
    ? config.timeout
    : DEFAULT_CONNECTION_TIMEOUT_MS;
  if (
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > MAX_CONNECTION_TIMEOUT_MS
  ) {
    throw new TypeError(
      `Remote connection timeout must be an integer from 1 through ${MAX_CONNECTION_TIMEOUT_MS}`
    );
  }
  return Object.freeze({ url, timeout });
}

export function validateRemoteServerUrl(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u0020\u007f]/.test(value) ||
    value.endsWith('/')
  ) {
    throw new TypeError(
      'Remote server URL must be one exact HTTP(S) base URL without whitespace or a trailing slash'
    );
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('Remote server URL must be an absolute HTTP(S) URL');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TypeError(
      'Remote server URL must use HTTP(S) without credentials, query, or fragment'
    );
  }

  const canonical = `${parsed.origin}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  if (canonical !== value) {
    throw new TypeError('Remote server URL must use one canonical spelling');
  }
  requireCanonicalPathSegments(parsed.pathname, 'Remote server URL');

  if (
    typeof globalThis.window?.location?.protocol === 'string' &&
    globalThis.window.location.protocol === 'https:' &&
    parsed.protocol !== 'https:'
  ) {
    throw new TypeError(
      'An HTTPS Cellucid page requires an explicit HTTPS remote server URL'
    );
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

function requireRemoteMessage(value) {
  requireExactKeys(value, REMOTE_MESSAGE_KEYS, [], 'Remote WebSocket message');
  requireExactText(value.type, 'Remote WebSocket message type');
  requireExactJsonValue(value.payload, 'Remote WebSocket message payload');
  return value;
}

function requireRemoteHealthPayload(payload) {
  requireExactKeys(
    payload,
    ['status', 'type', 'version', 'format', 'n_cells', 'n_genes'],
    [],
    'Remote health response'
  );
  if (payload.status !== 'ok') {
    throw new TypeError('Remote health response status must be exactly ok');
  }
  if (payload.type !== 'anndata') {
    throw new TypeError('Remote health response type must be exactly anndata');
  }
  if (!['h5ad', 'zarr'].includes(payload.format)) {
    throw new TypeError('Remote health format must be exactly h5ad or zarr');
  }
  requireNonNegativeSafeInteger(payload.n_cells, 'Remote health n_cells');
  requireNonNegativeSafeInteger(payload.n_genes, 'Remote health n_genes');
  requireExactText(payload.version, 'Remote health version');
  return Object.freeze({ ...payload });
}

function requireRemoteServerInfo(payload, health) {
  const websocketKeys = isPlainRecord(payload) && Object.hasOwn(payload, 'ws_port')
    ? ['ws_port']
    : [];
  requireExactKeys(
    payload,
    ['version', 'type', 'format', 'host', 'port', 'n_cells', 'n_genes'],
    websocketKeys,
    'Remote server info'
  );
  if (payload.type !== 'anndata') {
    throw new TypeError('Remote server info type must be exactly anndata');
  }
  requireExactText(payload.version, 'Remote server version');
  if (payload.version !== health.version) {
    throw new TypeError(
      'Remote health and server info versions must match exactly'
    );
  }
  if (
    payload.format !== health.format ||
    payload.n_cells !== health.n_cells ||
    payload.n_genes !== health.n_genes
  ) {
    throw new TypeError(
      'Remote health and server info must describe the same dataset'
    );
  }
  requireExactText(payload.host, 'Remote server host');
  requirePort(payload.port, 'Remote server port');
  if (Object.hasOwn(payload, 'ws_port')) {
    requirePort(payload.ws_port, 'Remote WebSocket port');
  }
  return Object.freeze({ ...payload });
}

/**
 * The server's catalog: exactly one dataset, the AnnData store it serves.
 */
function requireDatasetCatalogPayload(payload) {
  requireExactKeys(payload, ['datasets'], [], 'Remote dataset listing');
  if (!Array.isArray(payload.datasets) || payload.datasets.length !== 1) {
    throw new TypeError(
      'Remote dataset listing must declare exactly one dataset'
    );
  }
  const label = 'Remote dataset listing datasets[0]';
  const entry = requireExactKeys(
    payload.datasets[0],
    ['id', 'name', 'anndata'],
    [],
    label
  );
  return Object.freeze([Object.freeze({
    id: requireExactText(entry.id, `${label}.id`, { allowWhitespace: true }),
    name: requireExactText(entry.name, `${label}.name`, { allowWhitespace: true }),
    anndata: requireServedAnnData(entry.anndata, `${label}.anndata`),
  })]);
}

/**
 * Whether a Cellucid server answers at one base address: its health endpoint
 * replies with a valid health document within the connection deadline. The
 * address bar asks this of a web address that names no file, so a server and
 * a dataset folder on a web host are told apart by what answers, not by how
 * the address looks. Any failure (nothing there, not a server, no reply in
 * time) is a plain no.
 *
 * @param {string} url - A base URL `validateRemoteServerUrl` accepts
 * @param {{signal?: AbortSignal|null}} [options]
 * @returns {Promise<boolean>}
 */
export async function probeRemoteServer(url, { signal = null } = {}) {
  validateRemoteServerUrl(url);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_CONNECTION_TIMEOUT_MS);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    requireRemoteHealthPayload(
      await requestJson(`${url}/_cellucid/health`, controller.signal, 'Remote health')
    );
    return true;
  } catch {
    if (signal?.aborted) throw signal.reason;
    return false;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abort);
  }
}

async function requestJson(url, signal, label) {
  let response;
  try {
    response = await fetch(url, {
      signal,
      cache: 'no-store',
      redirect: 'error'
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new DataSourceError(
      `${label} request failed: ${error instanceof Error ? error.message : String(error)}`,
      DataSourceErrorCode.NETWORK_ERROR,
      'remote',
      { url }
    );
  }
  if (!(response instanceof Response)) {
    throw new DataSourceError(
      `${label} fetch must return a Response`,
      DataSourceErrorCode.VALIDATION_ERROR,
      'remote',
      { url }
    );
  }
  if (response.status !== 200) {
    throw new DataSourceError(
      `${label} request failed with HTTP ${response.status}`,
      DataSourceErrorCode.NETWORK_ERROR,
      'remote',
      { url, status: response.status }
    );
  }
  if (response.headers.get('Content-Type') !== 'application/json') {
    throw new DataSourceError(
      `${label} response Content-Type must be exactly application/json`,
      DataSourceErrorCode.INVALID_FORMAT,
      'remote',
      { url, contentType: response.headers.get('Content-Type') }
    );
  }
  // The body read owns four distinguishable outcomes and they are not
  // interchangeable: the caller's own cancellation, a payload that exceeded the
  // metadata byte ceiling, a transfer that broke mid-body, and genuinely
  // malformed JSON. Reporting all four as "must contain valid JSON" accuses the
  // server of sending bad data when the user cancelled, when the response was
  // refused for its size, or when the connection dropped — three lies a user
  // cannot tell from the truth. The signal is threaded in so a cancelled listing
  // stops reading rather than draining a body nobody will use.
  //
  // The size refusal is not re-labelled here: `readBoundedBody()` owns the
  // ceiling and already publishes TOO_LARGE, so it arrives as a DataSourceError
  // and passes straight through. Naming it a second time here is how it came to
  // be reported as a failed contract validation, which reaches the user as
  // "re-export it with cellucid prepare" — advice that reproduces the identical
  // file and meets the identical ceiling (CEL-0219).
  try {
    return await readBoundedJson(response, { label, signal });
  } catch (error) {
    if (signal.aborted || error?.name === 'AbortError') {
      throw error;
    }
    if (error instanceof DataSourceError) {
      throw error;
    }
    if (error instanceof SyntaxError) {
      throw new DataSourceError(
        `${label} response must contain valid JSON`,
        DataSourceErrorCode.INVALID_FORMAT,
        'remote',
        { url, cause: error.message }
      );
    }
    throw new DataSourceError(
      `${label} response body transfer failed: ${error instanceof Error ? error.message : String(error)}`,
      DataSourceErrorCode.NETWORK_ERROR,
      'remote',
      {
        url,
        cause: error instanceof Error ? error.message : String(error)
      }
    );
  }
}

function createWebSocketUrl(serverUrl, wsPort) {
  const parsed = new URL(serverUrl);
  const protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${parsed.hostname}:${wsPort}/`;
}

function closeSocket(socket) {
  if (!socket) return;
  socket.onopen = null;
  socket.onmessage = null;
  socket.onerror = null;
  socket.onclose = null;
  const closing = globalThis.WebSocket?.CLOSING ?? 2;
  const closed = globalThis.WebSocket?.CLOSED ?? 3;
  if (socket.readyState !== closing && socket.readyState !== closed) {
    socket.close(1000, 'Cellucid remote connection closed');
  }
}

function deliverCallbacks(callbacks, args) {
  const pending = [];
  for (const callback of callbacks) {
    const result = callback(...args);
    if (result instanceof Promise) pending.push(result);
  }
  return pending.length === 0 ? undefined : Promise.all(pending);
}

/**
 * Data source for one explicit remote Cellucid server.
 */
export class RemoteDataSource {
  constructor() {
    /** @type {string|null} */
    this._serverUrl = null;
    /** @type {Object|null} */
    this._serverInfo = null;
    /** @type {Object|null} The adopted health response */
    this._health = null;
    this._connected = false;
    /**
     * The open AnnData store of a server that serves one (`anndata` in its
     * catalog entry), read in place by the browser's reader.
     * @type {{key: string, datasetId: string, source: Object, metadata: Object, release: () => void}|null}
     */
    this._annData = null;
    /** @type {string|null} Dataset whose base URL was handed out last */
    this.datasetId = null;
    /** @type {Map<string, Object>} Catalog entries by dataset id */
    this._datasetEntries = new Map();
    /** @type {Map<string, DatasetMetadata>} */
    this._datasetCache = new Map();
    /**
     * What the dataset list shows of each served store, by store
     * (`servedStoreKey`): the list is read more than once (startup, then the
     * data controls), and a store the server declares unchanged is described
     * once. Cleared with the connection and on refresh.
     * @type {Map<string, Promise<Object>>}
     */
    this._summaries = new Map();
    /** @type {Map<string, Object>} */
    this._metadataInFlight = new Map();
    /** @type {WebSocket|null} */
    this._ws = null;
    this._connectionLostCallbacks = new Set();
    this._messageCallbacks = new Set();
    this._connecting = false;
    this._operationId = 0;
    /** @type {AbortController|null} */
    this._pendingController = null;
    this._catalogRevision = 0;
    /** @type {AbortController|null} */
    this._catalogController = null;
    this.type = 'remote';
  }

  getType() {
    return this.type;
  }

  /**
   * Create an isolated connection candidate. Connection attempts never mutate
   * the currently registered transport owner.
   *
   * @returns {RemoteDataSource}
   */
  createConnectionCandidate() {
    return new RemoteDataSource();
  }

  async isAvailable() {
    return this._connected;
  }

  async _requestDatasetCatalog(serverUrl, signal) {
    const payload = await requestJson(
      `${serverUrl}/_cellucid/datasets`,
      signal,
      'Remote dataset listing'
    );
    return requireDatasetCatalogPayload(payload);
  }

  /**
   * Open a served AnnData store (once per connection and store) and return
   * the metadata the reader reads from it.
   *
   * @private
   */
  async _openAnnDataMetadata(serverUrl, dataset) {
    const key = servedStoreKey(serverUrl, dataset);
    if (this._annData?.key === key) return this._annData.metadata;
    const operationId = this._operationId;
    const opened = await openServedAnnData({
      serverUrl,
      dataset,
      sourceType: this.type
    });
    if (
      !this._connected ||
      this._operationId !== operationId ||
      this._serverUrl !== serverUrl
    ) {
      opened.release();
      throw new DataSourceError(
        'Remote connection changed before the AnnData store was adopted',
        DataSourceErrorCode.NETWORK_ERROR,
        this.type
      );
    }
    this._releaseAnnData();
    this._annData = { key, datasetId: dataset.id, ...opened };
    return opened.metadata;
  }

  /**
   * One served store as the dataset list shows it, described once per store.
   * A failed description is forgotten, so listing again retries it.
   * @private
   */
  _describeStore(serverUrl, dataset, signal) {
    const key = servedStoreKey(serverUrl, dataset);
    let summary = this._summaries.get(key);
    if (summary === undefined) {
      summary = describeServedAnnData({ serverUrl, dataset, sourceType: this.type, signal });
      this._summaries.set(key, summary);
      summary.catch(() => {
        if (this._summaries.get(key) === summary) this._summaries.delete(key);
      });
    }
    return summary;
  }

  _releaseAnnData() {
    const previous = this._annData;
    this._annData = null;
    if (this.datasetId === previous?.datasetId) this.datasetId = null;
    previous?.release();
  }

  _beginCatalogGeneration(reason) {
    const previousController = this._catalogController;
    const controller = new AbortController();
    this._catalogController = controller;
    const revision = ++this._catalogRevision;
    previousController?.abort(new Error(reason));
    return { controller, revision };
  }

  _endCatalogGeneration(reason) {
    const previousController = this._catalogController;
    this._catalogController = null;
    this._catalogRevision += 1;
    this._metadataInFlight = new Map();
    previousController?.abort(new Error(reason));
  }

  async _openAdvertisedWebSocket(serverUrl, serverInfo, signal) {
    if (!Object.hasOwn(serverInfo, 'ws_port')) return null;
    if (typeof globalThis.WebSocket !== 'function') {
      throw new DataSourceError(
        'Remote server advertises WebSocket updates, but this runtime has no WebSocket implementation',
        DataSourceErrorCode.UNSUPPORTED,
        this.type
      );
    }

    const wsUrl = createWebSocketUrl(serverUrl, serverInfo.ws_port);
    let socket;
    try {
      socket = new globalThis.WebSocket(wsUrl);
    } catch (error) {
      throw new DataSourceError(
        `Remote WebSocket construction failed: ${error instanceof Error ? error.message : String(error)}`,
        DataSourceErrorCode.NETWORK_ERROR,
        this.type,
        { url: wsUrl }
      );
    }

    try {
      await new Promise((resolve, reject) => {
        const rejectWith = message => {
          cleanup();
          reject(new DataSourceError(
            message,
            DataSourceErrorCode.NETWORK_ERROR,
            this.type,
            { url: wsUrl }
          ));
        };
        const onAbort = () => rejectWith('Remote WebSocket connection was cancelled');
        const cleanup = () => {
          signal.removeEventListener('abort', onAbort);
          socket.onopen = null;
          socket.onerror = null;
          socket.onclose = null;
        };

        socket.onopen = () => {
          cleanup();
          resolve();
        };
        socket.onerror = () => {
          rejectWith('Remote server advertised a WebSocket that failed to open');
        };
        socket.onclose = event => {
          rejectWith(
            `Remote server advertised a WebSocket that closed before opening (code ${event.code})`
          );
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    } catch (error) {
      closeSocket(socket);
      throw error;
    }
    return socket;
  }

  /**
   * Establish one exact remote connection.
   *
   * @param {{url: string, timeout?: number}} config
   * @returns {Promise<Object>}
   */
  async connect(config) {
    const exactConfig = requireConnectionConfig(config);
    if (this._connecting) {
      throw new DataSourceError(
        'A remote connection attempt is already in progress',
        DataSourceErrorCode.NETWORK_ERROR,
        this.type
      );
    }

    this._connecting = true;
    const operationId = ++this._operationId;
    const controller = new AbortController();
    this._pendingController = controller;
    let deadlineExpired = false;
    const timeoutId = setTimeout(
      () => {
        deadlineExpired = true;
        controller.abort();
      },
      exactConfig.timeout
    );
    let stagedSocket = null;

    try {
      const healthPayload = await requestJson(
        `${exactConfig.url}/_cellucid/health`,
        controller.signal,
        'Remote health'
      );
      const health = requireRemoteHealthPayload(healthPayload);

      const infoPayload = await requestJson(
        `${exactConfig.url}/_cellucid/info`,
        controller.signal,
        'Remote server info'
      );
      const serverInfo = requireRemoteServerInfo(infoPayload, health);
      const catalog = await this._requestDatasetCatalog(
        exactConfig.url,
        controller.signal
      );
      stagedSocket = await this._openAdvertisedWebSocket(
        exactConfig.url,
        serverInfo,
        controller.signal
      );

      if (operationId !== this._operationId || controller.signal.aborted) {
        throw new DataSourceError(
          'Remote connection was cancelled before adoption',
          DataSourceErrorCode.NETWORK_ERROR,
          this.type
        );
      }

      const previousSocket = this._ws;
      this._releaseAnnData();
      this._serverUrl = exactConfig.url;
      this._serverInfo = serverInfo;
      this._health = health;
      this._datasetEntries = new Map(catalog.map(dataset => [dataset.id, dataset]));
      this._datasetCache = new Map();
      this._summaries = new Map();
      this._ws = stagedSocket;
      this._connected = true;
      this._beginCatalogGeneration(
        'Remote catalog was replaced by a new connection'
      );
      if (stagedSocket) this._adoptWebSocket(stagedSocket);
      stagedSocket = null;
      closeSocket(previousSocket);
      return serverInfo;
    } catch (error) {
      closeSocket(stagedSocket);
      if (controller.signal.aborted) {
        throw new DataSourceError(
          deadlineExpired
            ? `Remote connection timed out after ${exactConfig.timeout}ms`
            : 'Remote connection was cancelled',
          DataSourceErrorCode.NETWORK_ERROR,
          this.type,
          { url: exactConfig.url, timeout: exactConfig.timeout }
        );
      }
      // A cancellation that did not come from this connection's own controller
      // — a body stream cancelled by the transport, for instance — is still a
      // cancellation. Relabelling it as a contract validation failure blames the
      // server for a request that was never allowed to finish.
      if (error?.name === 'AbortError') throw error;
      if (error instanceof DataSourceError) throw error;
      throw new DataSourceError(
        `Remote server contract validation failed: ${error instanceof Error ? error.message : String(error)}`,
        DataSourceErrorCode.VALIDATION_ERROR,
        this.type,
        { url: exactConfig.url }
      );
    } finally {
      clearTimeout(timeoutId);
      if (this._pendingController === controller) {
        this._pendingController = null;
      }
      this._connecting = false;
    }
  }

  _adoptWebSocket(socket) {
    socket.onopen = null;
    socket.onmessage = async event => {
      try {
        if (typeof event.data !== 'string') {
          throw new TypeError(
            'Remote WebSocket messages must use one UTF-8 JSON text frame'
          );
        }
        const message = requireRemoteMessage(JSON.parse(event.data));
        await this._handleMessage(message);
      } catch (error) {
        await this._terminateWebSocket(
          socket,
          error instanceof Error ? error : new Error(String(error))
        );
      }
    };
    socket.onerror = async () => {
      await this._terminateWebSocket(
        socket,
        new DataSourceError(
          'Remote WebSocket failed',
          DataSourceErrorCode.NETWORK_ERROR,
          this.type
        )
      );
    };
    socket.onclose = async event => {
      await this._terminateWebSocket(
        socket,
        new DataSourceError(
          `Remote WebSocket closed (code ${event.code})`,
          DataSourceErrorCode.NETWORK_ERROR,
          this.type,
          { code: event.code, reason: event.reason }
        )
      );
    };
  }

  async _terminateWebSocket(socket, error) {
    if (this._ws !== socket) return;
    this._operationId += 1;
    this._ws = null;
    this._connected = false;
    this._endCatalogGeneration(
      'Remote catalog was retired after connection loss'
    );
    closeSocket(socket);
    await this._notifyConnectionLost(error);
  }

  _handleMessage(message) {
    return deliverCallbacks(this._messageCallbacks, [message]);
  }

  _notifyConnectionLost(error) {
    return deliverCallbacks(this._connectionLostCallbacks, [error]);
  }

  disconnect() {
    this._operationId += 1;
    if (this._pendingController) {
      this._pendingController.abort(
        new Error('Remote connection cancelled by disconnect')
      );
    }
    const socket = this._ws;
    this._ws = null;
    this._connected = false;
    this._releaseAnnData();
    this._serverUrl = null;
    this._serverInfo = null;
    this._health = null;
    this._datasetEntries = new Map();
    this._datasetCache = new Map();
    this._summaries = new Map();
    this._endCatalogGeneration(
      'Remote catalog was retired by disconnect'
    );
    closeSocket(socket);
  }

  isConnected() {
    return this._connected;
  }

  getConnectionInfo() {
    return Object.freeze({
      url: this._serverUrl,
      serverInfo: this._serverInfo,
      status: this._connected ? 'connected' : 'disconnected'
    });
  }

  onConnectionLost(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Remote connection-lost callback must be a function');
    }
    this._connectionLostCallbacks.add(callback);
  }

  offConnectionLost(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Remote connection-lost callback must be a function');
    }
    this._connectionLostCallbacks.delete(callback);
  }

  onMessage(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Remote message callback must be a function');
    }
    this._messageCallbacks.add(callback);
  }

  offMessage(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Remote message callback must be a function');
    }
    this._messageCallbacks.delete(callback);
  }

  sendMessage(message) {
    requireRemoteMessage(message);
    if (
      !this._connected ||
      !this._ws ||
      this._ws.readyState !== globalThis.WebSocket.OPEN
    ) {
      throw new DataSourceError(
        'Remote WebSocket is not connected',
        DataSourceErrorCode.NETWORK_ERROR,
        this.type
      );
    }
    this._ws.send(JSON.stringify(message));
  }

  async listDatasets() {
    if (!this._connected || !this._serverUrl) {
      throw new DataSourceError(
        'Remote dataset listing requires an active connection',
        DataSourceErrorCode.NETWORK_ERROR,
        this.type
      );
    }

    const operationId = this._operationId;
    const serverUrl = this._serverUrl;
    const catalogOwner = this._beginCatalogGeneration(
      'Remote catalog listing was superseded'
    );
    const catalog = await this._requestDatasetCatalog(
      serverUrl,
      catalogOwner.controller.signal
    );
    // The listing describes each store; it does not open one. Opening
    // belongs to the dataset load (`getMetadata`), which a newer choice
    // replaces.
    const summaries = await loadMetadataBatchAtomically(
      catalog,
      catalogOwner.controller.signal,
      (dataset, signal) => this._describeStore(serverUrl, dataset, signal),
      'Remote catalog metadata loading'
    );

    if (
      !this._connected ||
      this._operationId !== operationId ||
      this._serverUrl !== serverUrl ||
      this._catalogRevision !== catalogOwner.revision ||
      this._catalogController !== catalogOwner.controller ||
      catalogOwner.controller.signal.aborted
    ) {
      throw new DataSourceError(
        'Remote connection changed before dataset listing adoption',
        DataSourceErrorCode.NETWORK_ERROR,
        this.type
      );
    }
    this._beginCatalogGeneration(
      'Remote catalog metadata was adopted'
    );
    this._datasetEntries = new Map(catalog.map(dataset => [dataset.id, dataset]));
    this._datasetCache = new Map();
    return summaries;
  }

  _requireDatasetId(datasetId) {
    return requireExactText(
      datasetId,
      'Remote dataset id',
      { allowWhitespace: true }
    );
  }

  _requireDeclaredDataset(datasetId) {
    const id = this._requireDatasetId(datasetId);
    if (!this._datasetEntries.has(id)) {
      throw new DataSourceError(
        `Remote dataset ${JSON.stringify(id)} is not declared by the current listing`,
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        { datasetId: id }
      );
    }
    return this._datasetEntries.get(id);
  }

  async hasDataset(datasetId) {
    if (!this._connected) {
      throw new DataSourceError(
        'Remote dataset lookup requires an active connection',
        DataSourceErrorCode.NETWORK_ERROR,
        this.type
      );
    }
    const id = this._requireDatasetId(datasetId);
    if (this._datasetEntries.has(id)) return true;
    const datasets = await this.listDatasets();
    return datasets.some(dataset => dataset.id === id);
  }

  async getMetadata(datasetId) {
    if (!this._connected || !this._serverUrl) {
      throw new DataSourceError(
        'Remote metadata loading requires an active connection',
        DataSourceErrorCode.NETWORK_ERROR,
        this.type
      );
    }
    const id = this._requireDatasetId(datasetId);
    if (this._datasetCache.has(id)) return this._datasetCache.get(id);
    const dataset = this._requireDeclaredDataset(id);
    // Opening the store belongs to the connection, not to one listing: the
    // dataset list is read again while a dataset opens, and that must not
    // cancel the open. It stands while the connection lasts and the dataset
    // still names the same store.
    const operationId = this._operationId;
    const serverUrl = this._serverUrl;
    const key = servedStoreKey(serverUrl, dataset);
    const existing = this._metadataInFlight.get(key);
    if (existing?.operationId === operationId && existing.serverUrl === serverUrl) {
      return existing.promise;
    }

    const inFlight = { operationId, serverUrl, promise: null };
    inFlight.promise = (async () => {
      try {
        const metadata = await this._openAnnDataMetadata(serverUrl, dataset);
        const declared = this._datasetEntries.get(id);
        if (
          !this._connected ||
          this._operationId !== operationId ||
          this._serverUrl !== serverUrl ||
          declared === undefined ||
          servedStoreKey(serverUrl, declared) !== key
        ) {
          throw new DataSourceError(
            'Remote connection changed before metadata adoption',
            DataSourceErrorCode.NETWORK_ERROR,
            this.type
          );
        }
        this._datasetCache.set(id, metadata);
        return metadata;
      } finally {
        if (this._metadataInFlight.get(key) === inFlight) {
          this._metadataInFlight.delete(key);
        }
      }
    })();
    this._metadataInFlight.set(key, inFlight);
    return inFlight.promise;
  }

  /**
   * The base URL of the dataset: the h5ad:// or zarr:// URL of the store the
   * browser's reader opened, which its metadata load opens.
   *
   * @param {string} datasetId
   * @returns {string}
   */
  getBaseUrl(datasetId) {
    if (!this._connected || !this._serverUrl) {
      throw new DataSourceError(
        'Remote dataset URL requires an active connection',
        DataSourceErrorCode.NETWORK_ERROR,
        this.type
      );
    }
    const id = this._requireDeclaredDataset(datasetId).id;
    if (this._annData?.datasetId !== id) {
      throw new DataSourceError(
        `Remote dataset ${JSON.stringify(id)} is not open; load its metadata first`,
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        { datasetId: id }
      );
    }
    this.datasetId = id;
    return this._annData.source.getBaseUrl(id);
  }

  /**
   * The AnnData data source of the served store, once its metadata is loaded.
   * @returns {Object|null}
   */
  getAnnDataSource() {
    return this._annData?.source ?? null;
  }

  requiresManualReconnect() {
    return !this._connected;
  }

  refresh() {
    this._beginCatalogGeneration(
      'Remote metadata cache was refreshed'
    );
    this._datasetCache = new Map();
    this._summaries = new Map();
  }

  onDeactivate() {
    return undefined;
  }
}

export function createRemoteDataSource() {
  return new RemoteDataSource();
}
