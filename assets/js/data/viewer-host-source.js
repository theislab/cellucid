/**
 * ViewerHostDataSource - the data source of a viewer a host program opened
 *
 * A host program -- the `cellucid` Python package (`show_anndata()`, in a
 * notebook or not), the `cellucid` R package's viewer -- serves one dataset
 * and opens this page with `?viewer=true&viewerId=…&viewerToken=…`
 * (`VIEWER_PAGE_PARAMETERS`); its `/_cellucid/info` names the program
 * (`runtime`), which the viewer shows. This source:
 *
 * - reads the dataset the host serves: the one AnnData-shaped store, read in
 *   place by the browser's reader (`served-anndata.js`, `getAnnDataSource()`);
 * - holds the viewer channel (`viewer-channel.js`, rules in
 *   `viewer-protocol.js`): one WebSocket to the host, authenticated with the
 *   viewer id and token, carrying the host's commands (highlight, colour by,
 *   visibility, data mapping, session capture, …) to the viewer and the
 *   viewer's events (selection, hover, click, ready, data mapping, …) back.
 *   The page reaches the host at the address it was loaded from, so a
 *   notebook proxy that carries the page carries the channel too.
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
import { ViewerChannel } from './viewer-channel.js';
import {
  VIEWER_CHANNEL_PATH,
  VIEWER_HOST_RUNTIMES,
  VIEWER_PAGE_MODE_PARAMETER,
  VIEWER_PAGE_PARAMETERS,
  VIEWER_COMMAND_ERROR_REASON_LIMIT,
  VIEWER_DATA_MAPPING_ORIGINS,
  encodeViewerCells,
  viewerBinaryCommandTypes,
  viewerCommandTypes,
} from './viewer-protocol.js';
import {
  describeServedAnnData,
  openServedAnnData,
  requireServedAnnData,
  servedStoreKey,
} from './served-anndata.js';
import { isPlainRecord, requireExactKeys } from '../utils/exact-record.js';

/**
 * @typedef {import('./data-source.js').DatasetMetadata} DatasetMetadata
 */

/**
 * @typedef {Object} ViewerHostConfig
 * @property {string} serverUrl - URL of the cellucid data server (from Python side)
 * @property {string} viewerId - Unique viewer ID for message routing
 * @property {string} viewerToken - Per-viewer authentication token
 */

function requireSingleViewerHostParameter(params, key) {
  const values = params.getAll(key);
  if (
    values.length !== 1 ||
    values[0].length === 0 ||
    values[0] !== values[0].trim() ||
    /\s/.test(values[0])
  ) {
    throw new Error(
      'Viewer host configuration requires exactly one non-whitespace ' +
      'viewerId and viewerToken'
    );
  }
  return values[0];
}

/**
 * The viewer host configuration from URL parameters
 * @returns {ViewerHostConfig|null}
 */
export function getViewerHostConfig() {
  const params = new URLSearchParams(window.location.search);
  const declaredKeys = [...params.keys()];
  const modeValues = params.getAll(VIEWER_PAGE_MODE_PARAMETER);
  if (modeValues.length === 0) {
    return null;
  }
  const annDataValues = params.getAll('anndata');
  if (
    (declaredKeys.length !== 3 && declaredKeys.length !== 4) ||
    declaredKeys.some(key => !VIEWER_PAGE_PARAMETERS.includes(key)) ||
    (annDataValues.length !== 0 &&
      (annDataValues.length !== 1 || annDataValues[0] !== 'true'))
  ) {
    throw new Error(
      'A viewer page address must contain exact routing fields and only the ' +
      'optional anndata=true server discriminator'
    );
  }
  if (modeValues.length !== 1 || modeValues[0] !== 'true') {
    throw new Error(
      `The viewer page must be declared exactly once as ${VIEWER_PAGE_MODE_PARAMETER}=true`
    );
  }
  const viewerId = requireSingleViewerHostParameter(params, 'viewerId');
  const viewerToken = requireSingleViewerHostParameter(params, 'viewerToken');
  const defaultBase = new URL('.', window.location.href).toString().replace(/\/$/, '');

  return {
    serverUrl: defaultBase,
    viewerId,
    viewerToken
  };
}

function requireViewerHostRuntimeConfig(config) {
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
      'Viewer host configuration must contain exactly serverUrl, viewerId, and viewerToken'
    );
  }
  for (const key of ['serverUrl', 'viewerId', 'viewerToken']) {
    if (
      typeof config[key] !== 'string' ||
      config[key].length === 0 ||
      config[key] !== config[key].trim() ||
      /\s/.test(config[key])
    ) {
      throw new TypeError(`Viewer host ${key} must be exact non-whitespace text`);
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
      'Viewer host serverUrl must be an exact HTTP(S) base URL without credentials, query, fragment, or trailing slash'
    );
  }
  return config;
}

function captureViewerHostRuntimeConfig(config) {
  const exactConfig = requireViewerHostRuntimeConfig(config);
  return Object.freeze({
    serverUrl: exactConfig.serverUrl,
    viewerId: exactConfig.viewerId,
    viewerToken: exactConfig.viewerToken
  });
}

function createViewerHostLifecycleSupersededError(label) {
  const error = new Error(
    `${label} was superseded by a newer viewer host lifecycle.`
  );
  error.name = 'AbortError';
  error.code = 'CELLUCID_VIEWER_HOST_LIFECYCLE_SUPERSEDED';
  return error;
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
 * The cells of a host command: the Uint32Array its binary frame carried,
 * strictly ascending and at least one (`decodeViewerBinaryCommand` checked
 * both). The state that applies them checks every index against the dataset
 * (`requireCellList` for a highlight, `setCellVisibility` for visibility).
 */
function requireCommandCells(value, label) {
  if (!(value instanceof Uint32Array) || value.length === 0) {
    throw new TypeError(`${label} must be the cells of a binary command frame`);
  }
  return value;
}

function requireCountOrNull(value, label) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`${label} must be a non-negative safe integer or null`);
  }
  return value;
}

function requireViewerHostHealthPayload(payload) {
  requireExactKeys(
    payload,
    ['status', 'type', 'version', 'format', 'n_cells', 'n_genes'],
    'Viewer host health response'
  );
  if (payload.status !== 'ok') {
    throw new TypeError('Viewer host health response status must be exactly ok');
  }
  if (payload.type !== 'anndata') {
    throw new TypeError('Viewer host health response type must be exactly anndata');
  }
  if (!isInputFormatId(payload.format)) {
    throw new TypeError('Viewer host health format must be an input format id this viewer reads (' +
      `${INPUT_FORMATS.map(format => format.id).join(', ')})`);
  }
  // Null when the host cannot know without reading the data (an R object,
  // a MatrixMarket or Loom file): the browser learns them on open.
  requireCountOrNull(payload.n_cells, 'Viewer host health n_cells');
  requireCountOrNull(payload.n_genes, 'Viewer host health n_genes');
  requireExactText(
    payload.version,
    'Viewer host health version',
    { allowWhitespace: true }
  );
  return payload;
}

/**
 * Deadline for one request to the host's server (Python or R): its health,
 * info and protocol documents. The server answers from the same machine, so
 * a request still open after this long has stalled; without a deadline it
 * would hold startup, or the health request that explains a failed channel
 * reopen, open forever.
 */
export const VIEWER_HOST_HEALTH_TIMEOUT_MS = 30_000;

/**
 * One JSON document of the host's server (`/_cellucid/<route>`), within
 * `VIEWER_HOST_HEALTH_TIMEOUT_MS`.
 */
async function requestViewerHostDocument(config, route, label, signal = null) {
  const exactConfig = requireViewerHostRuntimeConfig(config);
  throwIfMetadataAborted(signal, `Viewer host ${label} request`);
  const url = `${exactConfig.serverUrl}/_cellucid/${route}`;
  const deadline = createDeadline(VIEWER_HOST_HEALTH_TIMEOUT_MS);
  const requestSignal = signal === null
    ? deadline.signal
    : AbortSignal.any([signal, deadline.signal]);
  try {
    const response = await fetch(url, {
      cache: 'no-store',
      signal: requestSignal,
    });
    throwIfMetadataAborted(signal, `Viewer host ${label} request`);
    if (!(response instanceof Response)) {
      throw new TypeError(`Viewer host ${label} fetch must return a Response`);
    }
    if (!response.ok) {
      throw new Error(
        `Viewer host ${label} request failed with HTTP ${response.status}`
      );
    }
    const payload = await readBoundedJson(response, {
      label: `Viewer host ${label} request`,
      signal: requestSignal,
    });
    throwIfMetadataAborted(signal, `Viewer host ${label} request`);
    return payload;
  } catch (error) {
    if (deadline.signal.aborted && signal?.aborted !== true) {
      throw new Error(
        `The host's server did not answer ${url} within ` +
        `${VIEWER_HOST_HEALTH_TIMEOUT_MS / 1000} s.`,
        { cause: error }
      );
    }
    throw error;
  } finally {
    deadline.release();
  }
}

async function requestViewerHostHealth(config, signal = null) {
  return requireViewerHostHealthPayload(
    await requestViewerHostDocument(config, 'health', 'health', signal)
  );
}

/**
 * Validate one `/_cellucid/info` document against the health the same server
 * answered, and return the program it names (`runtime`).
 *
 * @param {unknown} payload
 * @param {Object} health - The validated health document
 * @returns {string} A key of `VIEWER_HOST_RUNTIMES`
 */
export function requireViewerHostInfoPayload(payload, health) {
  requireExactKeys(
    payload,
    ['version', 'type', 'format', 'host', 'port', 'n_cells', 'n_genes', 'runtime'],
    'Viewer host server info'
  );
  if (
    payload.version !== health.version ||
    payload.type !== health.type ||
    payload.format !== health.format ||
    payload.n_cells !== health.n_cells ||
    payload.n_genes !== health.n_genes
  ) {
    throw new TypeError('Viewer host server info and health must describe the same server and dataset');
  }
  if (!Object.hasOwn(VIEWER_HOST_RUNTIMES, payload.runtime)) {
    throw new TypeError(
      `Viewer host server info runtime must be one of ${Object.keys(VIEWER_HOST_RUNTIMES).join(', ')}`
    );
  }
  return payload.runtime;
}

async function requestViewerHostInfo(config, health, signal = null) {
  return requireViewerHostInfoPayload(
    await requestViewerHostDocument(config, 'info', 'server info', signal),
    health
  );
}

/**
 * What the host accepts on the viewer channel, as `GET /_cellucid/protocol`
 * publishes it: where the channel is, every command type it may send and
 * every event type it accepts. The lists grow; neither is a version to compare
 * against.
 *
 * @typedef {{channel: string, events: ReadonlySet<string>, commands: ReadonlySet<string>,
 *   binaryCommands: ReadonlySet<string>}} ViewerHostProtocol
 */

const EMPTY_VIEWER_HOST_PROTOCOL = Object.freeze({
  channel: VIEWER_CHANNEL_PATH,
  events: Object.freeze(new Set()),
  commands: Object.freeze(new Set()),
  binaryCommands: Object.freeze(new Set()),
});

const OLDER_HOST = 'its cellucid package is older than this viewer. ' +
  'Upgrade it (Python: pip install -U cellucid; R: install.packages("cellucid")) and run the cell again.';

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
 * @returns {ViewerHostProtocol}
 */
export function requireViewerHostProtocolPayload(payload) {
  if (isPlainRecord(payload) && !Object.hasOwn(payload, 'channel')) {
    throw new TypeError(`The host offers no viewer channel: ${OLDER_HOST}`);
  }
  if (isPlainRecord(payload) && !Object.hasOwn(payload, 'binaryCommands')) {
    throw new TypeError(`The host sends the cells of its commands as JSON text: ${OLDER_HOST}`);
  }
  requireExactKeys(payload, ['channel', 'commands', 'binaryCommands', 'events'], 'Viewer host protocol response');
  if (payload.channel !== VIEWER_CHANNEL_PATH) {
    throw new TypeError(`The host's viewer channel must be at ${VIEWER_CHANNEL_PATH}`);
  }
  const commands = requireProtocolNames(payload.commands, 'Viewer host protocol commands');
  const binaryCommands = requireProtocolNames(payload.binaryCommands, 'Viewer host protocol binaryCommands');
  // Every command the host lists that this viewer knows must travel in the
  // form this viewer reads it in: a command that names cells as a binary
  // frame, every other one as text.
  const binary = new Set(viewerBinaryCommandTypes());
  for (const name of binaryCommands) {
    if (!commands.has(name)) {
      throw new TypeError(`Viewer host protocol binaryCommands lists "${name}", which commands does not`);
    }
  }
  for (const name of commands) {
    if (VIEWER_HOST_COMMAND_TYPES.includes(name) && binary.has(name) !== binaryCommands.has(name)) {
      throw new TypeError(
        `The host sends its "${name}" command in a form this viewer does not read: ` +
        'the viewer and the host package are from different releases. Upgrade both and run the cell again.'
      );
    }
  }
  return Object.freeze({
    channel: payload.channel,
    events: requireProtocolNames(payload.events, 'Viewer host protocol events'),
    commands,
    binaryCommands,
  });
}

/**
 * Ask the host what it accepts on the viewer channel.
 *
 * The answer gates every event a newer viewer could send: the host closes the
 * channel on an event type it does not declare, and the packages load this
 * build from www.cellucid.com without pinning one, so an older host driving a
 * newer viewer is the normal case after a deploy.
 *
 * @param {ViewerHostConfig} config
 * @param {AbortSignal|null} signal
 * @returns {Promise<ViewerHostProtocol>}
 */
async function requestViewerHostProtocol(config, signal = null) {
  const exactConfig = requireViewerHostRuntimeConfig(config);
  throwIfMetadataAborted(signal, 'Viewer host protocol request');
  const protocolUrl = `${exactConfig.serverUrl}/_cellucid/protocol`;
  const deadline = createDeadline(VIEWER_HOST_HEALTH_TIMEOUT_MS);
  const requestSignal = signal === null
    ? deadline.signal
    : AbortSignal.any([signal, deadline.signal]);
  try {
    const response = await fetch(protocolUrl, {
      cache: 'no-store',
      signal: requestSignal,
    });
    throwIfMetadataAborted(signal, 'Viewer host protocol request');
    if (!(response instanceof Response)) {
      throw new TypeError('Viewer host protocol fetch must return a Response');
    }
    if (response.status === 404) {
      throw new Error(
        'The host offers no viewer channel: its cellucid package is older than this viewer. ' +
        'Upgrade it (Python: pip install -U cellucid; R: install.packages("cellucid")) and run the cell again.'
      );
    }
    if (!response.ok) {
      throw new Error(
        `Viewer host protocol request failed with HTTP ${response.status}`
      );
    }
    const payload = await readBoundedJson(response, {
      label: 'Viewer host protocol request',
      signal: requestSignal,
    });
    throwIfMetadataAborted(signal, 'Viewer host protocol request');
    return requireViewerHostProtocolPayload(payload);
  } catch (error) {
    if (deadline.signal.aborted && signal?.aborted !== true) {
      throw new Error(
        `The host's server did not answer ${protocolUrl} within ` +
        `${VIEWER_HOST_HEALTH_TIMEOUT_MS / 1000} s.`,
        { cause: error }
      );
    }
    throw error;
  } finally {
    deadline.release();
  }
}

/** Why a `data_mapping` event reports the mapping it carries. */
const VIEWER_HOST_DATA_MAPPING_ORIGINS = VIEWER_DATA_MAPPING_ORIGINS;

/**
 * The notebook server's catalog: exactly one dataset, the AnnData store it
 * serves.
 */
function requireDatasetCatalogPayload(payload) {
  requireExactKeys(payload, ['datasets'], 'Viewer host dataset listing');
  if (!Array.isArray(payload.datasets) || payload.datasets.length !== 1) {
    throw new TypeError(
      'Viewer host dataset listing must declare exactly one dataset'
    );
  }
  const label = 'Viewer host dataset listing datasets[0]';
  const entry = requireExactKeys(payload.datasets[0], ['id', 'name', 'anndata'], label);
  return [Object.freeze({
    id: requireExactText(entry.id, `${label}.id`, { allowWhitespace: true }),
    name: requireExactText(entry.name, `${label}.name`, { allowWhitespace: true }),
    anndata: requireServedAnnData(entry.anndata, `${label}.anndata`),
  })];
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
const VIEWER_HOST_COMMAND_TYPES = Object.freeze(viewerCommandTypes());


/**
 * Name the host command that one failed viewer-channel frame was carrying.
 *
 * @param {unknown} data - The frame's parsed JSON object.
 * @returns {string|null} One recognised command type, or null when the
 *   frame never identified itself as a current command.
 */
export function describeViewerHostCommandType(data) {
  const type = isPlainRecord(data) ? data.type : undefined;
  return typeof type === 'string' && VIEWER_HOST_COMMAND_TYPES.includes(type)
    ? type
    : null;
}

function describeViewerHostFailureReason(error) {
  const raw =
    error instanceof Error && typeof error.message === 'string'
      ? error.message.replace(/\s+/g, ' ').trim()
      : '';
  if (raw.length === 0) {
    return 'the viewer reported no reason';
  }
  return raw.length > VIEWER_COMMAND_ERROR_REASON_LIMIT
    ? `${raw.slice(0, VIEWER_COMMAND_ERROR_REASON_LIMIT - 1)}…`
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
 * event in `/_cellucid/protocol` (see `requestViewerHostProtocol`); a host closes
 * the channel on an event type it does not declare.
 *
 * @param {string|null} commandType - A value from {@link describeViewerHostCommandType}.
 * @param {unknown} error
 * @returns {{title: string, message: string}}
 */
export function describeViewerHostCommandFailure(commandType, error) {
  if (commandType !== null && !VIEWER_HOST_COMMAND_TYPES.includes(commandType)) {
    throw new TypeError(
      'Viewer host command failure type must be one recognised command or null'
    );
  }
  const subject = commandType === null
    ? 'A notebook command'
    : `The notebook "${commandType}" command`;
  return {
    title: 'Notebook command failed',
    message:
      `${subject} did not run: ${describeViewerHostFailureReason(error)}. ` +
      'The viewer is unchanged; correct the notebook cell and run it again.'
  };
}

/**
 * Data source of a viewer host (Python, Jupyter or R) over the viewer channel
 */
export class ViewerHostDataSource {
  constructor(config = getViewerHostConfig()) {
    /** @type {ViewerHostConfig|null} */
    this._declaredConfig = config === null
      ? null
      : captureViewerHostRuntimeConfig(config);

    /** @type {ViewerHostConfig|null} */
    this._config = null;

    /**
     * What the notebook's `cellucid` accepts on the wire, read at connect.
     * @type {ViewerHostProtocol}
     */
    this._protocol = EMPTY_VIEWER_HOST_PROTOCOL;

    /**
     * The viewer channel, open from initialization until disconnect or its end.
     * @type {ViewerChannel|null}
     */
    this._channel = null;

    /**
     * Commands that arrived before the app registered its handlers
     * (`acceptCommands`), in order: a host queues commands until the viewer
     * connects, and the first ones arrive while the dataset still opens.
     * @type {Array<Object>|null}
     */
    this._heldCommands = [];

    /** @type {Set<Function>} */
    this._endCallbacks = new Set();

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
    /** @type {string|null} The program serving the viewer (`VIEWER_HOST_RUNTIMES`) */
    this._runtime = null;

    this.type = 'jupyter';
  }

  /**
   * What the viewer calls the program serving it -- "Python", "Jupyter" or
   * "R", as its `/_cellucid/info` says -- or null before it answered.
   *
   * @returns {string|null}
   */
  getHostLabel() {
    return this._runtime === null ? null : VIEWER_HOST_RUNTIMES[this._runtime];
  }

  _assertAlive() {
    if (this._destroyed) {
      throw new Error('Viewer host source has been destroyed.');
    }
  }

  /**
   * Announce one failed notebook-initiated command to the person watching.
   *
   * A console entry inside an embedded iframe is not a user surface, so the
   * notification is what the person watching sees; the host learns of it by
   * a `command_error` event when it accepts one. Every reporting step is
   * guarded: none may turn the channel's message handler or a promise
   * rejection handler into a thrown failure.
   *
   * @param {string|null} commandType
   * @param {unknown} error
   */
  _reportMessageFailure(commandType, error) {
    const failure = describeViewerHostCommandFailure(commandType, error);
    try {
      console.error(`[ViewerHost] ${failure.message}`, error);
    } catch {
      // Console reporting is observational only.
    }
    if (
      commandType !== null &&
      this._connected &&
      this._protocol.events.has('command_error') &&
      this._protocol.commands.has(commandType)
    ) {
      try {
        this._sendEvent({
          type: 'command_error',
          command: commandType,
          reason: describeViewerHostFailureReason(error)
        });
      } catch (deliveryError) {
        try {
          console.error(
            '[ViewerHost] Notebook command failure delivery failed:',
            deliveryError
          );
        } catch {
          // Nothing further is available to report through.
        }
      }
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
          '[ViewerHost] Notebook command failure notice failed:',
          notificationError
        );
      } catch {
        // Nothing further is available to report through.
      }
    }
  }

  /**
   * Run one command from the host, reporting a failure where the person and
   * the host see it.
   *
   * @param {Object} command
   */
  _observeCommand(command) {
    if (this._heldCommands !== null) {
      this._heldCommands.push(command);
      return;
    }
    const commandType = describeViewerHostCommandType(command);
    let result;
    try {
      result = this._handleCommand(command);
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

  /**
   * Start running the host's commands: the app calls this once every handler
   * it registers with `onHighlight`/`onMessage` is in place. Commands that
   * arrived before run now, in order.
   */
  acceptCommands() {
    const held = this._heldCommands;
    if (held === null) return;
    this._heldCommands = null;
    for (const command of held) this._observeCommand(command);
  }

  /**
   * Register what runs when the viewer channel ends for good: the host
   * stopped the viewer, the viewer was opened again elsewhere, the host
   * became unreachable, or a frame broke the protocol.
   *
   * @param {(end: import('./viewer-channel.js').ViewerChannelEnd) => void} callback
   */
  onChannelEnd(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Viewer host channel-end callback must be a function');
    }
    this._endCallbacks.add(callback);
  }

  _channelEnded(channel, end) {
    if (this._channel !== channel) return;
    this._connected = false;
    for (const callback of [...this._endCallbacks]) {
      try {
        callback(end);
      } catch (error) {
        console.error('[ViewerHost] channel-end handler failed:', error);
      }
    }
  }

  _assertLifecycle(revision, label) {
    if (
      this._destroyed ||
      revision !== this._lifecycleRevision
    ) {
      throw createViewerHostLifecycleSupersededError(label);
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
      throw createViewerHostLifecycleSupersededError(label);
    }
  }

  _assertCatalog(owner, label) {
    this._assertConnection(owner, label);
    if (
      owner.catalogRevision !== this._catalogRevision ||
      owner.catalogController !== this._catalogController ||
      owner.catalogController?.signal.aborted
    ) {
      throw createViewerHostLifecycleSupersededError(label);
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
   * Check if available (opened by a viewer host)
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
      new Error('Viewer host initialization was superseded')
    );
    this._endCatalogGeneration(
      'Viewer host catalog was retired by initialization'
    );
    this._closeChannel();
    this._connected = false;
    this._config = null;
    this._protocol = EMPTY_VIEWER_HOST_PROTOCOL;
    this._runtime = null;
    this._datasetCache.clear();
    this._summaries.clear();
    this._datasetEntries.clear();
    this._releaseAnnData();
    try {
      const health = await requestViewerHostHealth(config, controller.signal);
      this._assertLifecycle(revision, 'Viewer host initialization');
      const [protocol, runtime] = await Promise.all([
        requestViewerHostProtocol(config, controller.signal),
        requestViewerHostInfo(config, health, controller.signal),
      ]);
      this._assertLifecycle(revision, 'Viewer host initialization');
      if (this._initializationController !== controller) {
        throw createViewerHostLifecycleSupersededError(
          'Viewer host initialization'
        );
      }
      const channel = new ViewerChannel({
        serverUrl: config.serverUrl,
        viewerId: config.viewerId,
        viewerToken: config.viewerToken,
        channelPath: protocol.channel,
        onCommand: command => {
          if (this._channel === channel) this._observeCommand(command);
        },
        onEnd: end => this._channelEnded(channel, end),
        isHostAlive: async () => {
          try {
            await requestViewerHostHealth(config);
            return true;
          } catch {
            return false;
          }
        },
      });
      this._channel = channel;
      await channel.open();
      this._assertLifecycle(revision, 'Viewer host initialization');
      if (this._channel !== channel) {
        throw createViewerHostLifecycleSupersededError('Viewer host initialization');
      }
      this._config = config;
      this._protocol = protocol;
      this._runtime = runtime;
      this._connected = true;
      this._beginCatalogGeneration(
        'Viewer host catalog was initialized'
      );
      return true;
    } catch (error) {
      if (
        revision !== this._lifecycleRevision ||
        this._initializationController !== controller
      ) {
        throw createViewerHostLifecycleSupersededError(
          'Viewer host initialization'
        );
      }
      if (revision === this._lifecycleRevision) {
        this._closeChannel();
        this._connected = false;
        this._config = null;
        this._protocol = EMPTY_VIEWER_HOST_PROTOCOL;
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
      throw createViewerHostLifecycleSupersededError('Viewer host AnnData store');
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
   * Whether the host accepts one event type from this viewer, as its
   * `/_cellucid/protocol` lists it.
   *
   * @param {string} type
   * @returns {boolean}
   */
  acceptsEvent(type) {
    if (!this._connected) {
      throw new Error('Viewer host data source is not connected.');
    }
    return this._protocol.events.has(type);
  }

  /**
   * Run one command the host sent on the viewer channel. The channel is
   * authenticated, so a command carries no credentials; its keys are exactly
   * its type's (`VIEWER_COMMAND_FIELDS`, and for a binary command its header's
   * and `cells`).
   *
   * @param {Object} data
   * @private
   */
  _handleCommand(data) {
    if (!this._connected || this._config === null) return;
    const config = requireViewerHostRuntimeConfig(this._config);
    requireExactText(data.type, 'Viewer host command type');

    switch (data.type) {
      case 'ping':
        requireExactKeys(
          data,
          ['type', 'requestId'],
          'Viewer host ping message'
        );
        requireExactText(data.requestId, 'Viewer host ping requestId');
        return this._sendEvent({
          type: 'pong',
          requestId: data.requestId,
          t: Date.now()
        });

      case 'debug_snapshot':
        requireExactKeys(
          data,
          ['type', 'requestId'],
          'Viewer host debug snapshot message'
        );
        requireExactText(
          data.requestId,
          'Viewer host debug snapshot requestId'
        );
        return this._sendEvent({
          type: 'debug_snapshot',
          requestId: data.requestId,
          ts: new Date().toISOString(),
          locationHref: window.location.href,
          origin: window.location.origin,
          serverUrl: config.serverUrl,
          connected: this._connected,
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
          ['type'],
          'Viewer host clear-highlights message'
        );
        return this._handleClearHighlights();

      case 'resetCamera':
        requireExactKeys(
          data,
          ['type'],
          'Viewer host reset-camera message'
        );
        return this._handleResetCamera(data);

      case 'freeze':
        requireExactKeys(
          data,
          ['type'],
          'Viewer host freeze message'
        );
        return deliverCallbacks(this._messageCallbacks, [data]);

      case 'setDataMapping':
        requireExactKeys(
          data,
          ['type', 'requestId', 'mapping'],
          'Viewer host set-data-mapping message'
        );
        requireExactText(
          data.requestId,
          'Viewer host set-data-mapping requestId'
        );
        validateDataMapping(data.mapping, {
          label: 'Viewer host set-data-mapping mapping'
        });
        return deliverCallbacks(this._messageCallbacks, [data]);

      case 'requestSessionBundle':
        requireExactKeys(
          data,
          ['type', 'requestId'],
          'Viewer host session-bundle request'
        );
        requireExactText(
          data.requestId,
          'Viewer host session-bundle requestId'
        );
        return deliverCallbacks(this._messageCallbacks, [data]);

      default:
        // The type is not echoed: it is the host's text, and this message
        // reaches the person watching.
        throw new TypeError(
          'This viewer does not know that host command; reload the page to load the current viewer.'
        );
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
      ['type', 'cells', 'color'],
      'Viewer host highlight message'
    );
    const { cells, color } = data;
    requireCommandCells(cells, 'Viewer host highlight cells');
    if (
      typeof color !== 'string' ||
      !/^#[0-9a-fA-F]{6}$/.test(color)
    ) {
      throw new TypeError(
        'Viewer host highlight color must be an exact six-digit hex color'
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
      ['type', 'field'],
      'Viewer host set-color-by message'
    );
    const { field } = data;
    requireExactText(
      field,
      'Viewer host set-color-by field',
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
      ['type', 'cells', 'visible'],
      'Viewer host set-visibility message'
    );
    const { cells, visible } = data;
    if (cells !== null) {
      requireCommandCells(cells, 'Viewer host set-visibility cells');
    }
    if (typeof visible !== 'boolean') {
      throw new TypeError(
        'Viewer host set-visibility visible must be a boolean'
      );
    }
    return deliverCallbacks(this._messageCallbacks, [data]);
  }

  /**
   * Handle clear highlights command
   * @private
   */
  _handleClearHighlights() {
    return deliverCallbacks(this._highlightCallbacks, [null, null]);
  }

  /**
   * Handle reset camera command
   * @private
   */
  _handleResetCamera(data) {
    return deliverCallbacks(this._messageCallbacks, [data]);
  }

  /**
   * Send one event to the host on the viewer channel, when the host accepts
   * its type (its `/_cellucid/protocol` lists it).
   *
   * @param {Object} event - Event data with a non-empty type, without credentials
   * @returns {boolean} Whether the event was sent (or queued while the
   *   channel reconnects).
   * @private
   */
  _sendEvent(event) {
    this._captureConnection('Viewer host event delivery');
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
        'Viewer host event must have one exact type and must not supply routing credentials'
      );
    }
    requireExactJsonValue(event, 'Viewer host event');
    if (!this._protocol.events.has(event.type)) return false;
    this._channel.sendEvent(event);
    return true;
  }

  /**
   * Send the session bundle the host asked for with `requestSessionBundle`.
   *
   * @param {string} requestId
   * @param {Blob} bundle - The `.cellucid-session` file
   * @returns {boolean} Whether it was sent
   */
  sendSessionBundle(requestId, bundle) {
    this._captureConnection('Viewer host session delivery');
    requireExactText(requestId, 'Viewer host session-bundle requestId');
    if (!(bundle instanceof Blob) || bundle.size <= 0) {
      throw new TypeError('A session bundle must be one non-empty Blob');
    }
    if (!this._protocol.events.has('session_bundle')) return false;
    this._channel.sendBinary({
      type: 'session_bundle',
      requestId,
    }, bundle);
    return true;
  }

  // =========================================================================
  // PYTHON NOTIFICATION METHODS (Frontend → Python)
  // =========================================================================
  // These methods send events to the host on the viewer channel.
  /**
   * Notify Python of cell selection change
   * @param {number[]} cellIndices - Selected cell indices: unique non-negative
   *   integers in any order, at least one. Python receives them ascending.
   * @param {string} source - Selection source ('lasso', 'knn', 'proximity', 'annotation')
   */
  async notifySelection(cellIndices, source) {
    if (!this._connected) {
      throw new Error('Viewer host event source is not connected');
    }
    const body = encodeViewerCells(cellIndices, 'Viewer host selection cells');
    requireExactText(source, 'Viewer host selection source');
    this._captureConnection('Viewer host selection delivery');
    if (!this._protocol.events.has('selection')) return false;
    this._channel.sendBinary({
      type: 'selection',
      source,
    }, body);
    return true;
  }

  /**
   * Notify Python of cell hover (debounced internally)
   * @param {number|null} cellIndex - Hovered cell index, or null if not hovering
   * @param {{x: number, y: number, z: number}|null} position - World coordinates
   */
  async notifyHover(cellIndex, position) {
    if (!this._connected) {
      throw new Error('Viewer host event source is not connected');
    }
    if (cellIndex !== null) {
      requireNonNegativeInteger(cellIndex, 'Viewer host hover cell');
    }
    if (position !== null) {
      requireExactKeys(
        position,
        ['x', 'y', 'z'],
        'Viewer host hover position'
      );
      for (const axis of ['x', 'y', 'z']) {
        if (!Number.isFinite(position[axis])) {
          throw new TypeError(
            `Viewer host hover position ${axis} must be finite`
          );
        }
      }
    }
    return this._sendEvent({
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
      throw new Error('Viewer host event source is not connected');
    }
    requireNonNegativeInteger(cellIndex, 'Viewer host click cell');
    requireExactKeys(
      options,
      ['button', 'shift', 'ctrl'],
      'Viewer host click options'
    );
    if (
      !Number.isInteger(options.button) ||
      options.button < 0 ||
      options.button > 2
    ) {
      throw new TypeError(
        'Viewer host click button must be the integer 0, 1, or 2'
      );
    }
    if (
      typeof options.shift !== 'boolean' ||
      typeof options.ctrl !== 'boolean'
    ) {
      throw new TypeError(
        'Viewer host click shift and ctrl must be booleans'
      );
    }
    const event = {
      type: 'click',
      cell: cellIndex,
      button: options.button,
      shift: options.shift,
      ctrl: options.ctrl
    };
    return this._sendEvent(event);
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
      throw new Error('Viewer host event source is not connected');
    }
    requireExactKeys(
      report,
      ['origin', 'requestId', 'mapping'],
      'Viewer host data-mapping report'
    );
    if (!VIEWER_HOST_DATA_MAPPING_ORIGINS.includes(report.origin)) {
      throw new TypeError(
        `Viewer host data-mapping origin must be one of ${VIEWER_HOST_DATA_MAPPING_ORIGINS.join(', ')}`
      );
    }
    if (report.origin === 'notebook') {
      requireExactText(report.requestId, 'Viewer host data-mapping requestId');
    } else if (report.requestId !== null) {
      throw new TypeError(
        'Viewer host data-mapping requestId must be null unless it answers the notebook'
      );
    }
    const mapping = validateDataMapping(report.mapping, {
      label: 'Viewer host data-mapping report'
    });
    return this._sendEvent({
      type: 'data_mapping',
      requestId: report.requestId,
      origin: report.origin,
      mapping
    });
  }

  /**
   * Notify Python that viewer is ready with dataset info
   * @param {Object} info - Dataset info
   * @param {number} info.nCells - Number of cells
   * @param {number} info.dimensions - Embedding dimensions (1, 2, or 3)
   */
  async notifyReady(info) {
    if (!this._connected) {
      throw new Error('Viewer host event source is not connected');
    }
    requireExactKeys(
      info,
      ['nCells', 'dimensions'],
      'Viewer host ready info'
    );
    requireNonNegativeInteger(info.nCells, 'Viewer host ready nCells');
    if (
      info.dimensions !== 1 &&
      info.dimensions !== 2 &&
      info.dimensions !== 3
    ) {
      throw new TypeError(
        'Viewer host ready dimensions must be exactly 1, 2, or 3'
      );
    }
    const event = {
      type: 'ready',
      n_cells: info.nCells,
      dimensions: info.dimensions
    };
    return this._sendEvent(event);
  }

  // =========================================================================
  // PYTHON EVENT CALLBACKS (Python → Frontend)
  // =========================================================================

  /**
   * Register callback for highlight commands from the host
   * @param {Function} callback - Called with (cells, color): the ascending
   *   Uint32Array of a highlight and its colour, or (null, null) to clear
   *   every highlight
   */
  onHighlight(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Viewer host highlight callback must be a function');
    }
    this._highlightCallbacks.add(callback);
  }

  /**
   * Remove highlight callback
   * @param {Function} callback
   */
  offHighlight(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Viewer host highlight callback must be a function');
    }
    this._highlightCallbacks.delete(callback);
  }

  /**
   * Register callback for generic messages
   * @param {Function} callback
   */
  onMessage(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Viewer host message callback must be a function');
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
        'Viewer host dataset listing requires an initialized connection',
        DataSourceErrorCode.NETWORK_ERROR,
        this.type
      );
    }
    const catalogOwner = this._beginCatalogGeneration(
      'Viewer host dataset listing was superseded'
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
      this._assertCatalog(owner, 'Viewer host dataset listing');
      if (!(response instanceof Response)) {
        throw new TypeError(
          'Viewer host dataset listing fetch must return a Response'
        );
      }
      if (!response.ok) {
        throw new Error(
          `Viewer host dataset listing failed with HTTP ${response.status}`
        );
      }

      const catalogPayload = await readBoundedJson(response, {
        label: 'Viewer host dataset listing',
      });
      this._assertCatalog(owner, 'Viewer host dataset listing');
      const datasetList = requireDatasetCatalogPayload(catalogPayload);
      // The listing describes each store; it does not open one. Listing is a
      // startup step that holds the data controls, and opening belongs to
      // the dataset load (`getMetadata`), which a newer choice replaces.
      const summaries = await loadMetadataBatchAtomically(
        datasetList,
        catalogOwner.controller.signal,
        (dataset, signal) => this._describeStore(owner.config.serverUrl, dataset, signal),
        'Viewer host catalog metadata loading'
      );
      this._assertCatalog(owner, 'Viewer host dataset listing');

      this._beginCatalogGeneration(
        'Viewer host dataset listing was adopted'
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
        throw createViewerHostLifecycleSupersededError(
          'Viewer host dataset listing'
        );
      }
      throw error;
    }
  }

  _requireDatasetId(datasetId) {
    return requireExactText(
      datasetId,
      'Viewer host dataset id',
      { allowWhitespace: true }
    );
  }

  _requireDeclaredDataset(datasetId) {
    const id = this._requireDatasetId(datasetId);
    if (!this._datasetEntries.has(id)) {
      throw new DataSourceError(
        `Viewer host dataset ${JSON.stringify(id)} is not declared by the current listing`,
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
        'Viewer host dataset lookup requires an initialized connection',
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
        this._assertConnection(owner, 'Viewer host dataset metadata');
        const declared = this._datasetEntries.get(id);
        if (
          declared === undefined ||
          servedStoreKey(owner.config.serverUrl, declared) !== key
        ) {
          throw createViewerHostLifecycleSupersededError(
            'Viewer host dataset metadata'
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
        'Viewer host dataset URL requires an initialized connection',
        DataSourceErrorCode.NETWORK_ERROR,
        this.type
      );
    }
    const id = this._requireDeclaredDataset(datasetId).id;
    if (this._annData?.datasetId !== id) {
      throw new DataSourceError(
        `Viewer host dataset ${JSON.stringify(id)} is not open; load its metadata first`,
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
   * Requires manual reconnect (a viewer host is needed)
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
      'Viewer host metadata cache was refreshed'
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
      'Viewer host catalog was retired by disconnect'
    );
    this._initializationController?.abort(
      new Error('Viewer host initialization was cancelled by disconnect')
    );
    this._initializationController = null;
    this._closeChannel();
    this._connected = false;
    this._config = null;
    this._protocol = EMPTY_VIEWER_HOST_PROTOCOL;
    this._datasetCache.clear();
    this._summaries.clear();
    this._datasetEntries.clear();
    this._releaseAnnData();
    this._messageCallbacks.clear();
    this._highlightCallbacks.clear();
    this._endCallbacks.clear();
  }

  _closeChannel() {
    const channel = this._channel;
    this._channel = null;
    channel?.close();
  }

  destroy() {
    if (this._destroyed) return;
    this.disconnect();
    this._destroyed = true;
  }
}

/**
 * Create a ViewerHostDataSource instance
 * @param {ViewerHostConfig|null} [config]
 * @returns {ViewerHostDataSource}
 */
export function createViewerHostBridgeDataSource(
  config = getViewerHostConfig()
) {
  return new ViewerHostDataSource(config);
}
