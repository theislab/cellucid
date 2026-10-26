/**
 * Exact remote Cellucid server data source.
 *
 * A connection is adopted only after the health response, server information
 * and dataset catalog have all satisfied the current contract. Remote failures
 * are terminal; this source never retries, fabricates dataset metadata, or
 * rewrites caller-supplied URLs.
 *
 * A Cellucid server (`cellucid serve`, `serve_anndata()`) serves one dataset
 * file or folder in any input format (`data/input-formats.js`) and declares
 * it in its catalog
 * entry (`anndata`, see `served-anndata.js`); the browser's AnnData reader
 * reads it in place under the server's dataset id and name, and
 * `getAnnDataSource()` exposes it.
 */

import { INPUT_FORMATS, isInputFormatId } from './input-formats.js';
import { VIEWER_HOST_RUNTIMES } from './viewer-protocol.js';
import {
  DataSourceError,
  DataSourceErrorCode,
  explainedFailure,
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
import { isPlainRecord, requireKeys } from '../utils/exact-record.js';

/**
 * @typedef {import('./data-source.js').DatasetMetadata} DatasetMetadata
 */

const DEFAULT_CONNECTION_TIMEOUT_MS = 5000;
const MAX_CONNECTION_TIMEOUT_MS = 120000;

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

function requireCountOrNull(value, label) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`${label} must be a non-negative safe integer or null`);
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
  requireKeys(
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

function requireRemoteHealthPayload(payload) {
  requireKeys(
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
  if (!isInputFormatId(payload.format)) {
    throw new TypeError('Remote health format must be an input format id this viewer reads (' +
      `${INPUT_FORMATS.map(format => format.id).join(', ')})`);
  }
  // Null when the server cannot know without reading the data (an R
  // object, a MatrixMarket or Loom file): the browser learns them on open.
  requireCountOrNull(payload.n_cells, 'Remote health n_cells');
  requireCountOrNull(payload.n_genes, 'Remote health n_genes');
  requireExactText(payload.version, 'Remote health version');
  return Object.freeze({ ...payload });
}

function requireRemoteServerInfo(payload, health) {
  requireKeys(
    payload,
    ['version', 'type', 'format', 'host', 'port', 'n_cells', 'n_genes', 'runtime'],
    [],
    'Remote server info'
  );
  if (!Object.hasOwn(VIEWER_HOST_RUNTIMES, payload.runtime)) {
    throw new TypeError(
      `Remote server info runtime must be one of ${Object.keys(VIEWER_HOST_RUNTIMES).join(', ')}`
    );
  }
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
  return Object.freeze({ ...payload });
}

/**
 * The server's catalog: exactly one dataset, the AnnData store it serves.
 */
function requireDatasetCatalogPayload(payload) {
  requireKeys(payload, ['datasets'], [], 'Remote dataset listing');
  if (!Array.isArray(payload.datasets) || payload.datasets.length !== 1) {
    throw new TypeError(
      'Remote dataset listing must declare exactly one dataset'
    );
  }
  const label = 'Remote dataset listing datasets[0]';
  const entry = requireKeys(
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

/**
 * A server's health, or the refusal that says the address answers but is no
 * Cellucid server: its health endpoint is not there (a 4xx other than a
 * refusal of access), or it answers in another media type than JSON (a web
 * page, a file listing). A static web host serving a folder answers so; the refusal says
 * how to open such a folder instead of calling it unreachable.
 */
async function requestHealth(url, signal) {
  try {
    return await requestJson(`${url}/_cellucid/health`, signal, 'Remote health');
  } catch (error) {
    const status = error?.details?.status;
    const notAServer = error instanceof DataSourceError && (
      (Number.isInteger(status) && status >= 400 && status < 500 && status !== 401 && status !== 403) ||
      (error.code === DataSourceErrorCode.INVALID_FORMAT && Object.hasOwn(error.details ?? {}, 'contentType'))
    );
    if (!notAServer) throw error;
    throw explainedFailure(
      `${url} answers, but it is not a Cellucid server: it has no Cellucid health endpoint (/_cellucid/health). ` +
      'To open a server, start it with cellucid serve (Python) or cellucid_serve() (R) and type the address it prints. ' +
      'To open a folder of datasets on a web host, type the address of its datasets.json (the folder must hold one), ' +
      'or of one dataset file.',
      DataSourceErrorCode.NOT_FOUND,
      'remote',
      { url, cause: error }
    );
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

    try {
      const healthPayload = await requestHealth(exactConfig.url, controller.signal);
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

      if (operationId !== this._operationId || controller.signal.aborted) {
        throw new DataSourceError(
          'Remote connection was cancelled before adoption',
          DataSourceErrorCode.NETWORK_ERROR,
          this.type
        );
      }

      this._releaseAnnData();
      this._serverUrl = exactConfig.url;
      this._serverInfo = serverInfo;
      this._health = health;
      this._datasetEntries = new Map(catalog.map(dataset => [dataset.id, dataset]));
      this._datasetCache = new Map();
      this._summaries = new Map();
      this._connected = true;
      this._beginCatalogGeneration(
        'Remote catalog was replaced by a new connection'
      );
      return serverInfo;
    } catch (error) {
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

  disconnect() {
    this._operationId += 1;
    if (this._pendingController) {
      this._pendingController.abort(
        new Error('Remote connection cancelled by disconnect')
      );
    }
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
   * The base URL of the dataset: the anndata:// URL of the store the
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
