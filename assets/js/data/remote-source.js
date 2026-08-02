/**
 * Exact remote Cellucid server data source.
 *
 * A connection is adopted only after the health response, server information,
 * dataset catalog, and any advertised WebSocket have all satisfied the current
 * contract. Remote failures are terminal; this source never retries,
 * reconnects, fabricates dataset metadata, or rewrites caller-supplied URLs.
 */

import {
  DataSourceError,
  DataSourceErrorCode,
  loadDatasetMetadata,
  readBoundedJson
} from './data-source.js';
import {
  loadMetadataBatchAtomically,
} from './metadata-load-contract.js';

/**
 * @typedef {import('./data-source.js').DatasetMetadata} DatasetMetadata
 */

const DEFAULT_CONNECTION_TIMEOUT_MS = 5000;
const MAX_CONNECTION_TIMEOUT_MS = 120000;
const REMOTE_MESSAGE_KEYS = Object.freeze(['type', 'payload']);
const REMOTE_STATE_MANIFEST = 'state-snapshots.json';

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
  if (!isPlainRecord(payload)) {
    throw new TypeError('Remote health response must be a JSON object');
  }

  if (payload.type === 'exported') {
    requireExactKeys(
      payload,
      ['status', 'type', 'version'],
      [],
      'Remote exported health response'
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
      [],
      'Remote AnnData health response'
    );
    if (!['h5ad', 'zarr', 'in-memory'].includes(payload.format)) {
      throw new TypeError(
        'Remote AnnData health format must be exactly h5ad, zarr, or in-memory'
      );
    }
    if (typeof payload.is_backed !== 'boolean') {
      throw new TypeError(
        'Remote AnnData health is_backed must be a boolean'
      );
    }
    requireNonNegativeSafeInteger(
      payload.n_cells,
      'Remote AnnData health n_cells'
    );
    requireNonNegativeSafeInteger(
      payload.n_genes,
      'Remote AnnData health n_genes'
    );
  } else {
    throw new TypeError(
      'Remote health response type must be exactly exported or anndata'
    );
  }

  if (payload.status !== 'ok') {
    throw new TypeError('Remote health response status must be exactly ok');
  }
  requireExactText(payload.version, 'Remote health version');
  return Object.freeze({ ...payload });
}

function requireRemoteServerInfo(payload, health) {
  if (!isPlainRecord(payload)) {
    throw new TypeError('Remote server info must be a JSON object');
  }
  const websocketKeys = Object.hasOwn(payload, 'ws_port') ? ['ws_port'] : [];
  if (health.type === 'exported') {
    requireExactKeys(
      payload,
      ['version', 'host', 'port', 'mode'],
      websocketKeys,
      'Remote exported server info'
    );
    if (payload.mode !== 'standalone') {
      throw new TypeError(
        'Remote exported server mode must be exactly standalone'
      );
    }
  } else {
    requireExactKeys(
      payload,
      [
        'version',
        'type',
        'format',
        'host',
        'port',
        'n_cells',
        'n_genes',
        'is_backed'
      ],
      websocketKeys,
      'Remote AnnData server info'
    );
    if (payload.type !== 'anndata') {
      throw new TypeError(
        'Remote AnnData server info type must be exactly anndata'
      );
    }
    if (
      payload.format !== health.format ||
      payload.is_backed !== health.is_backed ||
      payload.n_cells !== health.n_cells ||
      payload.n_genes !== health.n_genes
    ) {
      throw new TypeError(
        'Remote AnnData health and server info must describe the same dataset'
      );
    }
  }

  requireExactText(payload.version, 'Remote server version');
  if (payload.version !== health.version) {
    throw new TypeError(
      'Remote health and server info versions must match exactly'
    );
  }
  requireExactText(payload.host, 'Remote server host');
  requirePort(payload.port, 'Remote server port');
  if (Object.hasOwn(payload, 'ws_port')) {
    requirePort(payload.ws_port, 'Remote WebSocket port');
  }
  if (health.type === 'anndata') {
    requireNonNegativeSafeInteger(
      payload.n_cells,
      'Remote AnnData server n_cells'
    );
    requireNonNegativeSafeInteger(
      payload.n_genes,
      'Remote AnnData server n_genes'
    );
    if (typeof payload.is_backed !== 'boolean') {
      throw new TypeError(
        'Remote AnnData server is_backed must be a boolean'
      );
    }
  }
  return Object.freeze({ ...payload });
}

function requireDatasetCatalogPath(value, label) {
  if (
    typeof value !== 'string' ||
    !/^\/(?:[A-Za-z0-9][A-Za-z0-9._-]{0,179}\/)?$/.test(value)
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

function requireDatasetStateCapability(entry, label) {
  const hasStateManifest = Object.hasOwn(entry, 'state_manifest');
  const hasStateSha256 = Object.hasOwn(entry, 'state_sha256');
  if (hasStateManifest !== hasStateSha256) {
    throw new TypeError(
      `${label} state_manifest and state_sha256 must be declared together`
    );
  }
  if (!hasStateManifest) return null;
  if (entry.state_manifest !== REMOTE_STATE_MANIFEST) {
    throw new TypeError(
      `${label}.state_manifest must be exactly ${REMOTE_STATE_MANIFEST}`
    );
  }
  if (
    typeof entry.state_sha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(entry.state_sha256)
  ) {
    throw new TypeError(
      `${label}.state_sha256 must be one lowercase SHA-256 digest`
    );
  }
  return Object.freeze({
    state_manifest: entry.state_manifest,
    state_sha256: entry.state_sha256
  });
}

function requireDatasetCatalogPayload(payload) {
  requireExactKeys(payload, ['datasets'], [], 'Remote dataset listing');
  if (!Array.isArray(payload.datasets)) {
    throw new TypeError('Remote dataset listing datasets must be an array');
  }
  if (payload.datasets.length === 0) {
    throw new TypeError(
      'Remote dataset listing must declare at least one dataset'
    );
  }

  const ids = new Set();
  const paths = new Set();
  return Object.freeze(payload.datasets.map((entry, index) => {
    const label = `Remote dataset listing datasets[${index}]`;
    requireExactKeys(
      entry,
      ['id', 'path', 'name'],
      ['state_manifest', 'state_sha256'],
      label
    );
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
    const stateCapability = requireDatasetStateCapability(entry, label);
    if (ids.has(id)) {
      throw new TypeError(`Remote dataset listing contains duplicate id ${id}`);
    }
    if (paths.has(path)) {
      throw new TypeError(
        `Remote dataset listing contains duplicate path ${path}`
      );
    }
    ids.add(id);
    paths.add(path);
    return Object.freeze(
      stateCapability === null
        ? { id, path, name }
        : { id, path, name, ...stateCapability }
    );
  }));
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
 * Check whether a value declares the exact remote custom protocol prefix.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isRemoteUrl(value) {
  return (
    typeof value === 'string' &&
    (value.startsWith('remote://') || value.startsWith('remotes://'))
  );
}

/**
 * Check whether a value declares the exact secure remote protocol prefix.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSecureRemoteUrl(value) {
  return typeof value === 'string' && value.startsWith('remotes://');
}

/**
 * Parse one canonical remote custom URL.
 *
 * @param {unknown} value
 * @returns {{serverUrl: string, path: string, secure: boolean}|null}
 */
export function parseRemoteUrl(value) {
  if (!isRemoteUrl(value) || value !== value.trim()) return null;
  const match = /^(remote|remotes):\/\/([^/?#]+)(\/[^?#]*)$/.exec(value);
  if (!match) return null;

  const secure = match[1] === 'remotes';
  const protocol = secure ? 'https:' : 'http:';
  const candidate = `${protocol}//${match[2]}${match[3]}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    `${protocol}//${parsed.host}${parsed.pathname}` !== candidate
  ) {
    return null;
  }
  try {
    requireCanonicalPathSegments(parsed.pathname, 'Remote URL');
  } catch {
    return null;
  }
  return Object.freeze({
    serverUrl: `${protocol}//${parsed.host}`,
    path: parsed.pathname.slice(1),
    secure
  });
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
    this._connected = false;
    /** @type {Map<string, string>} */
    this._datasetPaths = new Map();
    /** @type {Map<string, DatasetMetadata>} */
    this._datasetCache = new Map();
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

  _beginCatalogGeneration(reason) {
    const previousController = this._catalogController;
    const controller = new AbortController();
    this._catalogController = controller;
    const revision = ++this._catalogRevision;
    this._metadataInFlight = new Map();
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
      const stagedPaths = new Map(
        catalog.map(dataset => [dataset.id, dataset.path])
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
      this._serverUrl = exactConfig.url;
      this._serverInfo = serverInfo;
      this._datasetPaths = stagedPaths;
      this._datasetCache = new Map();
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
    this._serverUrl = null;
    this._serverInfo = null;
    this._datasetPaths = new Map();
    this._datasetCache = new Map();
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
    const stagedPaths = new Map(
      catalog.map(dataset => [dataset.id, dataset.path])
    );
    const metadataEntries = await loadMetadataBatchAtomically(
      catalog,
      catalogOwner.controller.signal,
      async (dataset, signal) => {
        const metadata = await loadDatasetMetadata(
          `${serverUrl}${dataset.path}`,
          dataset.id,
          this.type,
          { signal }
        );
        if (metadata.name !== dataset.name) {
          throw new DataSourceError(
            `Remote catalog name for ${JSON.stringify(dataset.id)} does not match dataset_identity.json`,
            DataSourceErrorCode.VALIDATION_ERROR,
            this.type,
            {
              datasetId: dataset.id,
              catalogName: dataset.name,
              identityName: metadata.name
            }
          );
        }
        return [dataset.id, metadata];
      },
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
    this._datasetPaths = stagedPaths;
    this._datasetCache = new Map(metadataEntries);
    return metadataEntries.map(([, metadata]) => metadata);
  }

  _requireDatasetId(datasetId) {
    return requireExactText(
      datasetId,
      'Remote dataset id',
      { allowWhitespace: true }
    );
  }

  _requireDeclaredDatasetPath(datasetId) {
    const id = this._requireDatasetId(datasetId);
    if (!this._datasetPaths.has(id)) {
      throw new DataSourceError(
        `Remote dataset ${JSON.stringify(id)} is not declared by the current listing`,
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        { datasetId: id }
      );
    }
    return this._datasetPaths.get(id);
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
    if (this._datasetPaths.has(id)) return true;
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
    const datasetPath = this._requireDeclaredDatasetPath(id);
    const operationId = this._operationId;
    const serverUrl = this._serverUrl;
    const catalogRevision = this._catalogRevision;
    const catalogController = this._catalogController;
    if (catalogController === null) {
      throw new DataSourceError(
        'Remote metadata loading requires an active catalog generation',
        DataSourceErrorCode.NETWORK_ERROR,
        this.type
      );
    }
    const existing = this._metadataInFlight.get(id);
    if (
      existing?.operationId === operationId &&
      existing.serverUrl === serverUrl &&
      existing.catalogRevision === catalogRevision &&
      existing.catalogController === catalogController &&
      existing.datasetPath === datasetPath
    ) {
      return existing.promise;
    }

    const promise = (async () => {
      const metadata = await loadDatasetMetadata(
        `${serverUrl}${datasetPath}`,
        id,
        this.type,
        { signal: catalogController.signal }
      );
      if (
        !this._connected ||
        this._operationId !== operationId ||
        this._serverUrl !== serverUrl ||
        this._catalogRevision !== catalogRevision ||
        this._catalogController !== catalogController ||
        catalogController.signal.aborted ||
        this._datasetPaths.get(id) !== datasetPath
      ) {
        throw new DataSourceError(
          'Remote connection changed before metadata adoption',
          DataSourceErrorCode.NETWORK_ERROR,
          this.type
        );
      }
      this._datasetCache.set(id, metadata);
      return metadata;
    })();
    const inFlight = {
      operationId,
      serverUrl,
      catalogRevision,
      catalogController,
      datasetPath,
      promise,
    };
    this._metadataInFlight.set(id, inFlight);
    try {
      return await promise;
    } finally {
      if (this._metadataInFlight.get(id) === inFlight) {
        this._metadataInFlight.delete(id);
      }
    }
  }

  getBaseUrl(datasetId) {
    if (!this._connected || !this._serverUrl) {
      throw new DataSourceError(
        'Remote dataset URL requires an active connection',
        DataSourceErrorCode.NETWORK_ERROR,
        this.type
      );
    }
    const id = this._requireDatasetId(datasetId);
    const datasetPath = this._requireDeclaredDatasetPath(id);

    const server = new URL(this._serverUrl);
    const prefix = server.pathname === '/' ? '' : server.pathname;
    const fullPath = `${prefix}${datasetPath}`;
    const scheme = server.protocol === 'https:' ? 'remotes' : 'remote';
    return `${scheme}://${server.host}${fullPath}`;
  }

  async resolveUrl(url) {
    if (!this._connected || !this._serverUrl) {
      throw new DataSourceError(
        'Remote URL resolution requires an active connection',
        DataSourceErrorCode.NETWORK_ERROR,
        this.type
      );
    }
    const parsed = parseRemoteUrl(url);
    if (!parsed) {
      throw new DataSourceError(
        `Remote source cannot resolve a noncanonical remote URL: ${String(url)}`,
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
    }

    const connected = new URL(this._serverUrl);
    const resolved = new URL(
      parsed.path.length === 0 ? '/' : `/${parsed.path}`,
      `${parsed.serverUrl}/`
    );
    const requiredPrefix = connected.pathname === '/' ? '/' : `${connected.pathname}/`;
    if (
      resolved.origin !== connected.origin ||
      (
        connected.pathname !== '/' &&
        resolved.pathname !== requiredPrefix &&
        !resolved.pathname.startsWith(requiredPrefix)
      )
    ) {
      throw new DataSourceError(
        'Remote URL does not belong to the active remote server',
        DataSourceErrorCode.VALIDATION_ERROR,
        this.type,
        { url }
      );
    }

    const serverPrefix =
      connected.pathname === '/' ? '' : connected.pathname;
    const belongsToDeclaredDataset = [
      ...this._datasetPaths.values(),
    ].some(datasetPath => {
      const datasetPrefix = `${serverPrefix}${datasetPath}`;
      return (
        resolved.pathname === datasetPrefix ||
        resolved.pathname.startsWith(datasetPrefix)
      );
    });
    if (!belongsToDeclaredDataset) {
      throw new DataSourceError(
        'Remote URL does not belong to a currently declared dataset',
        DataSourceErrorCode.VALIDATION_ERROR,
        this.type,
        { url }
      );
    }
    return resolved.href;
  }

  requiresManualReconnect() {
    return !this._connected;
  }

  refresh() {
    this._beginCatalogGeneration(
      'Remote metadata cache was refreshed'
    );
    this._datasetCache = new Map();
  }

  onDeactivate() {
    return undefined;
  }
}

export function createRemoteDataSource() {
  return new RemoteDataSource();
}
