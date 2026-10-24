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
 * - Data loading from the notebook's server (works everywhere): the one
 *   AnnData store `show_anndata()` serves, read in place by the browser's
 *   AnnData reader (`served-anndata.js`) and exposed by `getAnnDataSource()`
 * - Live highlighting from Python (works everywhere)
 * - Selection/hover/click notifications to Python (works everywhere via HTTP POST)
 *
 * Bidirectional communication works in ALL environments:
 * - Python → Frontend: postMessage from notebook to iframe
 * - Frontend → Python: HTTP POST to /_cellucid/events on the data server
 *   (JSON events) and to /_cellucid/selection (a selection, as binary cell
 *   indices; see `encodeJupyterSelectionCells`)
 */

import { INPUT_FORMATS, isInputFormatId } from './input-formats.js';
import {
  DataSourceError,
  DataSourceErrorCode,
  readBoundedJson
} from './data-source.js';
import {
  loadMetadataBatchAtomically,
  throwIfMetadataAborted,
} from './metadata-load-contract.js';
import { getNotificationCenter } from '../app/notification-center.js';
import { createDeadline } from '../utils/deadline.js';
import { validateDataMapping } from './data-mapping.js';
import {
  describeServedAnnData,
  openServedAnnData,
  requireServedAnnData,
  servedStoreKey,
} from './served-anndata.js';

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

function captureJupyterRuntimeConfig(config) {
  const exactConfig = requireJupyterRuntimeConfig(config);
  return Object.freeze({
    serverUrl: exactConfig.serverUrl,
    viewerId: exactConfig.viewerId,
    viewerToken: exactConfig.viewerToken
  });
}

function createJupyterLifecycleSupersededError(label) {
  const error = new Error(
    `${label} was superseded by a newer Jupyter lifecycle.`
  );
  error.name = 'AbortError';
  error.code = 'CELLUCID_JUPYTER_LIFECYCLE_SUPERSEDED';
  return error;
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
      const entry = value[index];
      // Scalars are checked inline: a label is built only for an entry that
      // fails or that nests further, never once per element.
      if (
        entry === null ||
        typeof entry === 'string' ||
        typeof entry === 'boolean' ||
        (typeof entry === 'number' && Number.isFinite(entry))
      ) {
        continue;
      }
      if (!Object.hasOwn(value, index)) {
        throw new TypeError(`${label} arrays must not contain holes`);
      }
      requireExactJsonValue(entry, `${label}[${index}]`, ancestors);
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

/**
 * The cells of a Python command are an array; the state that applies them
 * checks every index against the dataset and orders them once
 * (`cellListFrom` for a highlight, `setCellVisibility` for visibility).
 */
function requireCellArray(value, label) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value;
}

const HOST_IS_LITTLE_ENDIAN =
  new Uint8Array(Uint32Array.of(1).buffer)[0] === 1;

/**
 * Encode one selection as the exact body of `POST /_cellucid/selection`.
 *
 * The wire is the selected cell indices as little-endian unsigned 32-bit
 * integers, strictly ascending, at least one: four bytes per cell instead of
 * a JSON array, and an order that lets Python prove uniqueness in one pass.
 * The selection tools hand over a cell list -- an ascending `Uint32Array`,
 * the wire's own order -- so encoding is one order check and one copy.
 *
 * @param {unknown} value - Cell list: ascending Uint32Array of cell indices
 * @param {string} label
 * @returns {Uint8Array} The request body.
 */
export function encodeJupyterSelectionCells(value, label = 'Jupyter selection cells') {
  if (!(value instanceof Uint32Array)) {
    throw new TypeError(`${label} must be a cell list (Uint32Array)`);
  }
  const length = value.length;
  if (length === 0) {
    throw new TypeError(`${label} must contain at least one cell`);
  }
  for (let index = 1; index < length; index++) {
    if (value[index] <= value[index - 1]) {
      throw new TypeError(
        `${label} must hold unique cell indices in ascending order`
      );
    }
  }
  const cells = value.slice();
  const bytes = new Uint8Array(cells.buffer);
  if (!HOST_IS_LITTLE_ENDIAN) {
    const view = new DataView(cells.buffer);
    for (let index = 0; index < length; index++) {
      view.setUint32(index * 4, cells[index], true);
    }
  }
  return bytes;
}

function requireJupyterHealthPayload(payload) {
  requireExactKeys(
    payload,
    ['status', 'type', 'version', 'format', 'n_cells', 'n_genes'],
    'Jupyter health response'
  );
  if (payload.status !== 'ok') {
    throw new TypeError('Jupyter health response status must be exactly ok');
  }
  if (payload.type !== 'anndata') {
    throw new TypeError('Jupyter health response type must be exactly anndata');
  }
  if (!isInputFormatId(payload.format)) {
    throw new TypeError('Jupyter health format must be an input format id this viewer reads (' +
      `${INPUT_FORMATS.map(format => format.id).join(', ')})`);
  }
  requireNonNegativeInteger(payload.n_cells, 'Jupyter health n_cells');
  requireNonNegativeInteger(payload.n_genes, 'Jupyter health n_genes');
  requireExactText(
    payload.version,
    'Jupyter health version',
    { allowWhitespace: true }
  );
  return payload;
}

/**
 * Deadline for one health exchange with the notebook's Python server. The
 * server answers from the same machine, so a request still open after this
 * long has stalled; without a deadline it would hold startup, or a health
 * check, open forever.
 */
export const JUPYTER_HEALTH_TIMEOUT_MS = 30_000;

async function requestJupyterHealth(config, signal = null) {
  const exactConfig = requireJupyterRuntimeConfig(config);
  throwIfMetadataAborted(signal, 'Jupyter health request');
  const healthUrl = `${exactConfig.serverUrl}/_cellucid/health`;
  const deadline = createDeadline(JUPYTER_HEALTH_TIMEOUT_MS);
  const requestSignal = signal === null
    ? deadline.signal
    : AbortSignal.any([signal, deadline.signal]);
  try {
    const response = await fetch(healthUrl, {
      cache: 'no-store',
      signal: requestSignal,
    });
    throwIfMetadataAborted(signal, 'Jupyter health request');
    if (!(response instanceof Response)) {
      throw new TypeError('Jupyter health fetch must return a Response');
    }
    if (!response.ok) {
      throw new Error(
        `Jupyter health request failed with HTTP ${response.status}`
      );
    }
    const payload = await readBoundedJson(response, {
      label: 'Jupyter health request',
      signal: requestSignal,
    });
    throwIfMetadataAborted(signal, 'Jupyter health request');
    return requireJupyterHealthPayload(payload);
  } catch (error) {
    if (deadline.signal.aborted && signal?.aborted !== true) {
      throw new Error(
        `The Jupyter Python server did not answer ${healthUrl} within ` +
        `${JUPYTER_HEALTH_TIMEOUT_MS / 1000} s.`,
        { cause: error }
      );
    }
    throw error;
  } finally {
    deadline.release();
  }
}

/**
 * What the notebook's `cellucid` accepts on the viewer wire, as
 * `GET /_cellucid/protocol` publishes it: every inbound event type and every
 * command type. Both lists grow; neither is a version to compare against.
 *
 * @typedef {{events: ReadonlySet<string>, commands: ReadonlySet<string>}} JupyterProtocol
 */

/** The protocol of a `cellucid` too old to publish one: it accepts nothing new. */
const EMPTY_JUPYTER_PROTOCOL = Object.freeze({
  events: Object.freeze(new Set()),
  commands: Object.freeze(new Set()),
});

function requireProtocolNames(value, label) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  const names = new Set();
  for (const [index, name] of value.entries()) {
    requireExactText(name, `${label}[${index}]`);
    if (names.has(name)) {
      throw new TypeError(`${label} must not repeat "${name}"`);
    }
    names.add(name);
  }
  return Object.freeze(names);
}

/**
 * Validate one `/_cellucid/protocol` document.
 *
 * @param {unknown} payload
 * @returns {JupyterProtocol}
 */
export function requireJupyterProtocolPayload(payload) {
  requireExactKeys(payload, ['events', 'commands'], 'Jupyter protocol response');
  return Object.freeze({
    events: requireProtocolNames(payload.events, 'Jupyter protocol events'),
    commands: requireProtocolNames(payload.commands, 'Jupyter protocol commands'),
  });
}

/**
 * Ask the notebook's `cellucid` what it accepts on the viewer wire.
 *
 * The answer gates every event a newer viewer could send: Python validates an
 * inbound event against an exact list and answers an unknown type with a
 * kernel traceback and HTTP 500, and the package loads this build from
 * www.cellucid.com without pinning one, so an older notebook driving a newer
 * viewer is the normal case after a deploy. A server that predates the route
 * answers 404 and accepts nothing new.
 *
 * @param {JupyterConfig} config
 * @param {AbortSignal|null} signal
 * @returns {Promise<JupyterProtocol>}
 */
async function requestJupyterProtocol(config, signal = null) {
  const exactConfig = requireJupyterRuntimeConfig(config);
  throwIfMetadataAborted(signal, 'Jupyter protocol request');
  const protocolUrl = `${exactConfig.serverUrl}/_cellucid/protocol`;
  const deadline = createDeadline(JUPYTER_HEALTH_TIMEOUT_MS);
  const requestSignal = signal === null
    ? deadline.signal
    : AbortSignal.any([signal, deadline.signal]);
  try {
    const response = await fetch(protocolUrl, {
      cache: 'no-store',
      signal: requestSignal,
    });
    throwIfMetadataAborted(signal, 'Jupyter protocol request');
    if (!(response instanceof Response)) {
      throw new TypeError('Jupyter protocol fetch must return a Response');
    }
    if (response.status === 404) return EMPTY_JUPYTER_PROTOCOL;
    if (!response.ok) {
      throw new Error(
        `Jupyter protocol request failed with HTTP ${response.status}`
      );
    }
    const payload = await readBoundedJson(response, {
      label: 'Jupyter protocol request',
      signal: requestSignal,
    });
    throwIfMetadataAborted(signal, 'Jupyter protocol request');
    return requireJupyterProtocolPayload(payload);
  } catch (error) {
    if (deadline.signal.aborted && signal?.aborted !== true) {
      throw new Error(
        `The Jupyter Python server did not answer ${protocolUrl} within ` +
        `${JUPYTER_HEALTH_TIMEOUT_MS / 1000} s.`,
        { cause: error }
      );
    }
    throw error;
  } finally {
    deadline.release();
  }
}

/** Why a `data_mapping` event reports the mapping it carries. */
const JUPYTER_DATA_MAPPING_ORIGINS = Object.freeze([
  'default',
  'best_guess',
  'session',
  'user',
  'notebook',
]);

/**
 * The notebook server's catalog: exactly one dataset, the AnnData store it
 * serves.
 */
function requireDatasetCatalogPayload(payload) {
  requireExactKeys(payload, ['datasets'], 'Jupyter dataset listing');
  if (!Array.isArray(payload.datasets) || payload.datasets.length !== 1) {
    throw new TypeError(
      'Jupyter dataset listing must declare exactly one dataset'
    );
  }
  const label = 'Jupyter dataset listing datasets[0]';
  const entry = requireExactKeys(payload.datasets[0], ['id', 'name', 'anndata'], label);
  return [Object.freeze({
    id: requireExactText(entry.id, `${label}.id`, { allowWhitespace: true }),
    name: requireExactText(entry.name, `${label}.name`, { allowWhitespace: true }),
    anndata: requireServedAnnData(entry.anndata, `${label}.anndata`),
  })];
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
 * Every notebook-initiated command type this bridge accepts.
 *
 * A failure is labelled from this exact list rather than from the raw inbound
 * `type`, so no malformed or hostile message can place arbitrary text in the
 * viewer's notification surface.
 */
const JUPYTER_COMMAND_TYPES = Object.freeze([
  'ping',
  'debug_snapshot',
  'highlight',
  'setColorBy',
  'setVisibility',
  'clearHighlights',
  'resetCamera',
  'freeze',
  'requestSessionBundle',
  'setDataMapping',
]);

const JUPYTER_FAILURE_REASON_LIMIT = 240;

/**
 * Name the notebook command that one failed message was carrying.
 *
 * @param {unknown} data - The raw `MessageEvent.data`.
 * @returns {string|null} One recognised command type, or null when the
 *   message never identified itself as a current command.
 */
export function describeJupyterCommandType(data) {
  const type = isPlainRecord(data) ? data.type : undefined;
  return typeof type === 'string' && JUPYTER_COMMAND_TYPES.includes(type)
    ? type
    : null;
}

function describeJupyterFailureReason(error) {
  const raw =
    error instanceof Error && typeof error.message === 'string'
      ? error.message.replace(/\s+/g, ' ').trim()
      : '';
  if (raw.length === 0) {
    return 'the viewer reported no reason';
  }
  return raw.length > JUPYTER_FAILURE_REASON_LIMIT
    ? `${raw.slice(0, JUPYTER_FAILURE_REASON_LIMIT - 1)}…`
    : raw;
}

/**
 * Build the exact user-facing text for one failed notebook command.
 *
 * The state-changing commands -- `highlight`, `setColorBy`, `setVisibility`,
 * `clearHighlights`, `resetCamera` and `freeze` -- carry no `requestId`, so
 * `viewer.set_color_by(...)` returns whether the viewer applied it or threw.
 * Announcing the failure here is what separates "the command failed" from
 * "the command matched nothing". The bridge also reports it to the notebook as
 * a `command_error` event, but only when the notebook's `cellucid` lists that
 * event in `/_cellucid/protocol` (see `requestJupyterProtocol`); an older one
 * would answer an unknown event with a kernel traceback.
 *
 * @param {string|null} commandType - A value from {@link describeJupyterCommandType}.
 * @param {unknown} error
 * @returns {{title: string, message: string}}
 */
export function describeJupyterCommandFailure(commandType, error) {
  if (commandType !== null && !JUPYTER_COMMAND_TYPES.includes(commandType)) {
    throw new TypeError(
      'Jupyter command failure type must be one recognised command or null'
    );
  }
  const subject = commandType === null
    ? 'A notebook command'
    : `The notebook "${commandType}" command`;
  return {
    title: 'Notebook command failed',
    message:
      `${subject} did not run: ${describeJupyterFailureReason(error)}. ` +
      'The viewer is unchanged; correct the notebook cell and run it again.'
  };
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
  const config = captureJupyterRuntimeConfig(options.config);
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

  const requestId = message.requestId;
  const createSessionBundle = options.createSessionBundle;
  const fetchImpl = options.fetchImpl;
  const blob = await createSessionBundle();
  if (!(blob instanceof Blob) || blob.size <= 0) {
    throw new TypeError('Session serializer must produce one non-empty Blob');
  }
  const query = new URLSearchParams([
    ['viewerId', config.viewerId],
    ['viewerToken', config.viewerToken],
    ['requestId', requestId],
  ]);
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
    await readBoundedJson(response, { label: 'Jupyter session upload' }),
    blob.size
  );
}

/**
 * Data source for Jupyter notebook integration
 */
export class JupyterBridgeDataSource {
  constructor(config = getJupyterConfig()) {
    /** @type {JupyterConfig|null} */
    this._declaredConfig = config === null
      ? null
      : captureJupyterRuntimeConfig(config);

    /** @type {JupyterConfig|null} */
    this._config = null;

    /**
     * What the notebook's `cellucid` accepts on the wire, read at connect.
     * @type {JupyterProtocol}
     */
    this._protocol = EMPTY_JUPYTER_PROTOCOL;

    this._parentWindow = window.parent;

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

    /** @type {Map<string, Object>} Dataset ID -> catalog entry */
    this._datasetEntries = new Map();

    /**
     * The open AnnData store of a `show_anndata()` server, read in place by
     * the browser's reader.
     * @type {{key: string, datasetId: string, source: Object, metadata: Object, release: () => void}|null}
     */
    this._annData = null;

    /** @type {string|null} Dataset whose base URL was handed out last */
    this.datasetId = null;

    /** @type {Set<Function>} */
    this._messageCallbacks = new Set();

    /** @type {Set<Function>} */
    this._highlightCallbacks = new Set();

    this._lifecycleRevision = 0;
    this._catalogRevision = 0;
    /** @type {AbortController|null} */
    this._catalogController = null;
    /** @type {AbortController|null} */
    this._initializationController = null;
    this._destroyed = false;
    this._listenerInstalled = false;

    this.type = 'jupyter';

    this._boundMessageHandler = event => {
      this._observeMessage(event);
    };
  }

  _assertAlive() {
    if (this._destroyed) {
      throw new Error('Jupyter source has been destroyed.');
    }
  }

  _installMessageListener() {
    if (this._listenerInstalled) return;
    window.addEventListener('message', this._boundMessageHandler);
    this._listenerInstalled = true;
  }

  _removeMessageListener() {
    if (!this._listenerInstalled) return;
    window.removeEventListener('message', this._boundMessageHandler);
    this._listenerInstalled = false;
  }

  /**
   * Announce one failed notebook-initiated command to the person watching.
   *
   * A console entry inside an embedded iframe is not a user surface, and the
   * wire protocol has no way to answer the notebook, so this notification is
   * the only signal that the command failed rather than matched nothing.
   * Both reporting steps are guarded: neither may turn the `message` listener
   * or a promise rejection handler into a thrown failure.
   *
   * @param {string|null} commandType
   * @param {unknown} error
   */
  _reportMessageFailure(commandType, error) {
    const failure = describeJupyterCommandFailure(commandType, error);
    try {
      console.error(`[JupyterBridge] ${failure.message}`, error);
    } catch {
      // Console reporting is observational only.
    }
    if (
      commandType !== null &&
      this._connected &&
      this._protocol.events.has('command_error') &&
      this._protocol.commands.has(commandType)
    ) {
      void this._postEventToPython({
        type: 'command_error',
        command: commandType,
        reason: describeJupyterFailureReason(error)
      }).catch(deliveryError => {
        try {
          console.error(
            '[JupyterBridge] Notebook command failure delivery failed:',
            deliveryError
          );
        } catch {
          // Nothing further is available to report through.
        }
      });
    }
    try {
      getNotificationCenter().error(failure.message, {
        category: 'connectivity',
        title: failure.title,
        duration: 0
      });
    } catch (notificationError) {
      try {
        console.error(
          '[JupyterBridge] Notebook command failure notice failed:',
          notificationError
        );
      } catch {
        // Nothing further is available to report through.
      }
    }
  }

  _observeMessage(event) {
    const commandType = describeJupyterCommandType(event?.data);
    let result;
    try {
      result = this._handleMessage(event);
    } catch (error) {
      this._reportMessageFailure(commandType, error);
      return;
    }
    if (
      result !== null &&
      (
        typeof result === 'object' ||
        typeof result === 'function'
      ) &&
      typeof result.then === 'function'
    ) {
      void Promise.resolve(result).catch(error => {
        this._reportMessageFailure(commandType, error);
      });
    }
  }

  _assertLifecycle(revision, label) {
    if (
      this._destroyed ||
      revision !== this._lifecycleRevision
    ) {
      throw createJupyterLifecycleSupersededError(label);
    }
  }

  _captureConnection(label) {
    this._assertAlive();
    if (!this._connected || this._config === null) {
      throw new Error(`${label} requires an initialized connection.`);
    }
    return {
      config: this._config,
      lifecycleRevision: this._lifecycleRevision
    };
  }

  _assertConnection(owner, label) {
    this._assertLifecycle(owner.lifecycleRevision, label);
    if (
      !this._connected ||
      this._config !== owner.config
    ) {
      throw createJupyterLifecycleSupersededError(label);
    }
  }

  _assertCatalog(owner, label) {
    this._assertConnection(owner, label);
    if (
      owner.catalogRevision !== this._catalogRevision ||
      owner.catalogController !== this._catalogController ||
      owner.catalogController?.signal.aborted
    ) {
      throw createJupyterLifecycleSupersededError(label);
    }
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
    return this._declaredConfig !== null && this._connected;
  }

  /**
   * Initialize from URL parameters
   * @returns {Promise<boolean>} True if successfully initialized
   */
  async initialize() {
    this._assertAlive();
    const config = this._declaredConfig;
    if (config === null) {
      return false;
    }

    const revision = ++this._lifecycleRevision;
    const previousController = this._initializationController;
    const controller = new AbortController();
    this._initializationController = controller;
    previousController?.abort(
      new Error('Jupyter initialization was superseded')
    );
    this._endCatalogGeneration(
      'Jupyter catalog was retired by initialization'
    );
    this._removeMessageListener();
    this._connected = false;
    this._config = null;
    this._protocol = EMPTY_JUPYTER_PROTOCOL;
    this._parentOrigin = null;
    this._datasetCache.clear();
    this._summaries.clear();
    this._datasetEntries.clear();
    this._releaseAnnData();
    try {
      const health = await requestJupyterHealth(config, controller.signal);
      this._assertLifecycle(revision, 'Jupyter initialization');
      const protocol = await requestJupyterProtocol(config, controller.signal);
      this._assertLifecycle(revision, 'Jupyter initialization');
      if (this._initializationController !== controller) {
        throw createJupyterLifecycleSupersededError(
          'Jupyter initialization'
        );
      }
      this._config = config;
      this._protocol = protocol;
      this._connected = true;
      this._beginCatalogGeneration(
        'Jupyter catalog was initialized'
      );
      this._installMessageListener();
      return true;
    } catch (error) {
      if (
        revision !== this._lifecycleRevision ||
        this._initializationController !== controller
      ) {
        throw createJupyterLifecycleSupersededError(
          'Jupyter initialization'
        );
      }
      if (revision === this._lifecycleRevision) {
        this._removeMessageListener();
        this._connected = false;
        this._config = null;
            this._protocol = EMPTY_JUPYTER_PROTOCOL;
        this._parentOrigin = null;
      }
      throw error;
    } finally {
      if (this._initializationController === controller) {
        this._initializationController = null;
      }
    }
  }

  /**
   * Open a served AnnData store (once per connection and store) and return
   * the metadata the reader reads from it.
   *
   * @private
   */
  async _openAnnDataMetadata(owner, dataset) {
    const serverUrl = owner.config.serverUrl;
    const key = servedStoreKey(serverUrl, dataset);
    if (this._annData?.key === key) return this._annData.metadata;
    const opened = await openServedAnnData({
      serverUrl,
      dataset,
      sourceType: this.type,
    });
    if (
      owner.lifecycleRevision !== this._lifecycleRevision ||
      owner.config !== this._config
    ) {
      opened.release();
      throw createJupyterLifecycleSupersededError('Jupyter AnnData store');
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

  /**
   * The AnnData data source of the served store, once its metadata is loaded.
   * @returns {Object|null}
   */
  getAnnDataSource() {
    return this._annData?.source ?? null;
  }

  /**
   * Whether the notebook's `cellucid` accepts one event type from this viewer,
   * as its `/_cellucid/protocol` lists it.
   *
   * @param {string} type
   * @returns {boolean}
   */
  acceptsEvent(type) {
    if (!this._connected) {
      throw new Error('Jupyter data source is not connected.');
    }
    return this._protocol.events.has(type);
  }

  /**
   * Validate the live Python server against the current health contract.
   * @returns {Promise<Object>}
   */
  async checkHealth() {
    const owner = this._captureConnection('Jupyter health check');
    const payload = await requestJupyterHealth(owner.config);
    this._assertConnection(owner, 'Jupyter health check');
    return payload;
  }

  /**
   * Handle incoming message from parent frame
   * @param {MessageEvent} event
   * @private
   */
  _handleMessage(event) {
    if (!this._connected || this._config === null) return;
    if (event?.source !== this._parentWindow) return;
    const data = event.data;
    if (!isPlainRecord(data)) return;

    const config = requireJupyterRuntimeConfig(this._config);

    // Messages without this viewer's secret are unrelated window traffic.
    if (data.viewerToken !== config.viewerToken) return;

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

      case 'setDataMapping':
        requireExactKeys(
          data,
          ['type', 'requestId', 'mapping', 'viewerId', 'viewerToken'],
          'Jupyter set-data-mapping message'
        );
        requireExactText(
          data.requestId,
          'Jupyter set-data-mapping requestId'
        );
        validateDataMapping(data.mapping, {
          label: 'Jupyter set-data-mapping mapping'
        });
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
    requireCellArray(cells, 'Jupyter highlight cells');
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
      requireCellArray(cells, 'Jupyter set-visibility cells');
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
   *
   * Every event here is a small JSON record; a selection, which can be
   * millions of cells, has its own binary route (`_postSelectionToPython`).
   * No request uses `keepalive`: the Fetch standard caps the bodies of all
   * in-flight keepalive requests at 64 KiB in total, no event is sent while
   * the page unloads, and a keepalive request over that budget is refused by
   * the browser before it reaches Python.
   *
   * @param {Object} event - Event data with a non-empty type
   * @private
   */
  async _postEventToPython(event) {
    const owner = this._captureConnection('Jupyter event delivery');
    const config = owner.config;
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
      })
    });
    await this._requireDeliveryResponse(owner, response, 'Jupyter event delivery');
  }

  /**
   * Post one encoded selection to `POST /_cellucid/selection`.
   *
   * The credentials and `source` travel in the query, as they do for the
   * session-bundle upload, so the server authenticates before it reads the
   * body. The body is the exact bytes `encodeJupyterSelectionCells` returns.
   *
   * @param {Uint8Array} body
   * @param {string} source
   * @private
   */
  async _postSelectionToPython(body, source) {
    const owner = this._captureConnection('Jupyter selection delivery');
    const config = owner.config;
    const query = new URLSearchParams([
      ['viewerId', config.viewerId],
      ['viewerToken', config.viewerToken],
      ['source', source],
    ]);
    const response = await fetch(
      `${config.serverUrl}/_cellucid/selection?${query.toString()}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream'
        },
        body
      }
    );
    await this._requireDeliveryResponse(owner, response, 'Jupyter selection delivery');
  }

  /**
   * Require one successful delivery answer from the Python server.
   *
   * @param {{config: JupyterConfig}} owner
   * @param {unknown} response
   * @param {string} label
   * @private
   */
  async _requireDeliveryResponse(owner, response, label) {
    this._assertConnection(owner, label);
    if (!(response instanceof Response)) {
      throw new TypeError(`${label} fetch must return a Response`);
    }
    if (!response.ok) {
      throw new Error(
        `${label} failed with HTTP ${response.status}`
      );
    }
    const payload = await readBoundedJson(response, { label });
    this._assertConnection(owner, label);
    requireJupyterSuccessPayload(payload, label);
  }

  // =========================================================================
  // PYTHON NOTIFICATION METHODS (Frontend → Python)
  // =========================================================================
  // These methods send events to Python via HTTP POST to the data server.
  // This works in ALL environments (Jupyter, JupyterLab, Colab, VSCode).
  /**
   * Notify Python of cell selection change
   * @param {number[]} cellIndices - Selected cell indices: unique non-negative
   *   integers in any order, at least one. Python receives them ascending.
   * @param {string} source - Selection source ('lasso', 'knn', 'proximity', 'annotation')
   */
  async notifySelection(cellIndices, source) {
    if (!this._connected) {
      throw new Error('Jupyter event source is not connected');
    }
    const body = encodeJupyterSelectionCells(cellIndices, 'Jupyter selection cells');
    requireExactText(source, 'Jupyter selection source');
    return this._postSelectionToPython(body, source);
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
   * Tell Python which data mapping the viewer shows, when the notebook's
   * `cellucid` accepts the `data_mapping` event.
   *
   * @param {{origin: string, requestId: string|null, mapping: Object}} report
   *   `requestId` names the `setDataMapping` command this answers; it is set
   *   exactly when `origin` is `notebook`.
   * @returns {Promise<boolean>} Whether the event was sent.
   */
  async notifyDataMapping(report) {
    if (!this._connected) {
      throw new Error('Jupyter event source is not connected');
    }
    requireExactKeys(
      report,
      ['origin', 'requestId', 'mapping'],
      'Jupyter data-mapping report'
    );
    if (!JUPYTER_DATA_MAPPING_ORIGINS.includes(report.origin)) {
      throw new TypeError(
        `Jupyter data-mapping origin must be one of ${JUPYTER_DATA_MAPPING_ORIGINS.join(', ')}`
      );
    }
    if (report.origin === 'notebook') {
      requireExactText(report.requestId, 'Jupyter data-mapping requestId');
    } else if (report.requestId !== null) {
      throw new TypeError(
        'Jupyter data-mapping requestId must be null unless it answers the notebook'
      );
    }
    const mapping = validateDataMapping(report.mapping, {
      label: 'Jupyter data-mapping report'
    });
    if (!this._protocol.events.has('data_mapping')) return false;
    await this._postEventToPython({
      type: 'data_mapping',
      requestId: report.requestId,
      origin: report.origin,
      mapping
    });
    return true;
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
    const catalogOwner = this._beginCatalogGeneration(
      'Jupyter dataset listing was superseded'
    );
    const owner = {
      config: this._config,
      lifecycleRevision: this._lifecycleRevision,
      catalogRevision: catalogOwner.revision,
      catalogController: catalogOwner.controller,
    };

    try {
      const response = await fetch(
        `${owner.config.serverUrl}/_cellucid/datasets`,
        { signal: catalogOwner.controller.signal }
      );
      this._assertCatalog(owner, 'Jupyter dataset listing');
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

      const catalogPayload = await readBoundedJson(response, {
        label: 'Jupyter dataset listing',
      });
      this._assertCatalog(owner, 'Jupyter dataset listing');
      const datasetList = requireDatasetCatalogPayload(catalogPayload);
      // The listing describes each store; it does not open one. Listing is a
      // startup step that holds the data controls, and opening belongs to
      // the dataset load (`getMetadata`), which a newer choice replaces.
      const summaries = await loadMetadataBatchAtomically(
        datasetList,
        catalogOwner.controller.signal,
        (dataset, signal) => this._describeStore(owner.config.serverUrl, dataset, signal),
        'Jupyter catalog metadata loading'
      );
      this._assertCatalog(owner, 'Jupyter dataset listing');

      this._beginCatalogGeneration(
        'Jupyter dataset listing was adopted'
      );
      this._datasetEntries = new Map(
        datasetList.map(dataset => [dataset.id, dataset])
      );
      this._datasetCache = new Map();
      return summaries;
    } catch (error) {
      if (
        catalogOwner.controller.signal.aborted ||
        owner.lifecycleRevision !== this._lifecycleRevision ||
        owner.catalogRevision !== this._catalogRevision ||
        owner.catalogController !== this._catalogController
      ) {
        throw createJupyterLifecycleSupersededError(
          'Jupyter dataset listing'
        );
      }
      throw error;
    }
  }

  _requireDatasetId(datasetId) {
    return requireExactText(
      datasetId,
      'Jupyter dataset id',
      { allowWhitespace: true }
    );
  }

  _requireDeclaredDataset(datasetId) {
    const id = this._requireDatasetId(datasetId);
    if (!this._datasetEntries.has(id)) {
      throw new DataSourceError(
        `Jupyter dataset ${JSON.stringify(id)} is not declared by the current listing`,
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        { datasetId: id }
      );
    }
    return this._datasetEntries.get(id);
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

    if (this._datasetEntries.has(id)) {
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

    // Opening the store belongs to the connection, not to one listing: the
    // dataset list is read again while a dataset opens (the controls list
    // every source when they start), and that must not cancel the open. The
    // open stands while the connection lasts and the dataset still names
    // the same store.
    const owner = {
      config: this._config,
      lifecycleRevision: this._lifecycleRevision,
    };
    const dataset = this._requireDeclaredDataset(id);
    const key = servedStoreKey(owner.config.serverUrl, dataset);
    const existing = this._metadataInFlight.get(key);
    if (
      existing?.config === owner.config &&
      existing.lifecycleRevision === owner.lifecycleRevision
    ) {
      return existing.promise;
    }

    const inFlight = {
      config: owner.config,
      lifecycleRevision: owner.lifecycleRevision,
      promise: null,
    };
    inFlight.promise = (async () => {
      try {
        const metadata = await this._openAnnDataMetadata(owner, dataset);
        this._assertConnection(owner, 'Jupyter dataset metadata');
        const declared = this._datasetEntries.get(id);
        if (
          declared === undefined ||
          servedStoreKey(owner.config.serverUrl, declared) !== key
        ) {
          throw createJupyterLifecycleSupersededError(
            'Jupyter dataset metadata'
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
    if (!this._connected || !this._config) {
      throw new DataSourceError(
        'Jupyter dataset URL requires an initialized connection',
        DataSourceErrorCode.NETWORK_ERROR,
        this.type
      );
    }
    const id = this._requireDeclaredDataset(datasetId).id;
    if (this._annData?.datasetId !== id) {
      throw new DataSourceError(
        `Jupyter dataset ${JSON.stringify(id)} is not open; load its metadata first`,
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        { datasetId: id }
      );
    }
    this.datasetId = id;
    return this._annData.source.getBaseUrl(id);
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
    this._beginCatalogGeneration(
      'Jupyter metadata cache was refreshed'
    );
    this._datasetCache.clear();
    this._summaries.clear();
  }

  /**
   * Cleanup on deactivation
   */
  onDeactivate() {
    // Keep the authenticated notebook transport reusable when another
    // registered data source is selected. Explicit disconnect/destroy owns
    // terminal listener and callback cleanup.
    return undefined;
  }

  /**
   * Cleanup and disconnect
   */
  disconnect() {
    this._lifecycleRevision += 1;
    this._endCatalogGeneration(
      'Jupyter catalog was retired by disconnect'
    );
    this._initializationController?.abort(
      new Error('Jupyter initialization was cancelled by disconnect')
    );
    this._initializationController = null;
    this._removeMessageListener();
    this._connected = false;
    this._config = null;
    this._protocol = EMPTY_JUPYTER_PROTOCOL;
    this._parentOrigin = null;
    this._datasetCache.clear();
    this._summaries.clear();
    this._datasetEntries.clear();
    this._releaseAnnData();
    this._messageCallbacks.clear();
    this._highlightCallbacks.clear();
  }

  destroy() {
    if (this._destroyed) return;
    this.disconnect();
    this._destroyed = true;
  }
}

/**
 * Create a JupyterBridgeDataSource instance
 * @param {JupyterConfig|null} [config]
 * @returns {JupyterBridgeDataSource}
 */
export function createJupyterBridgeDataSource(
  config = getJupyterConfig()
) {
  return new JupyterBridgeDataSource(config);
}
