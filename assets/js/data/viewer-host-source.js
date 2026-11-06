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
 *   viewer id and token, carrying the host's commands (an action of the
 *   catalogue -- colour by, highlight, push a column, read the history, … --,
 *   session capture) to the viewer and the viewer's events (an action's
 *   answer, selection, hover, click, ready, data mapping, results, …) back.
 *   The page reaches the host at the address it was loaded from, so a
 *   notebook proxy that carries the page carries the channel too.
 *
 * A notebook widget (`cellucid.Widget`) opens this page instead with
 * `?viewer=embedded` inside its own output, and the host is reached through
 * the widget: the viewer channel and every request run over the port the
 * widget hands the page (`viewer-embed.js`), with the host named by
 * `EMBEDDED_HOST_ORIGIN` (`formats/io/host-fetch.js`). Everything above the
 * transport -- the documents, the store reads, the protocol -- is the same.
 *
 * Every cell crossing the channel is an original position (a row of the
 * dataset's `obs`): the app hands this source cells in subset positions (the
 * cells open now), and it names them by original position with the open
 * dataset's cell identity (`setCellIdentityProvider`, `data/cell-identity.js`).
 */

import { INPUT_FORMATS, isInputFormatId } from './input-formats.js';
import {
  DataSourceError,
  DataSourceErrorCode,
  readBoundedJson
} from './data-source.js';
import {
  loadMetadataBatchAtomically,
} from './metadata-load-contract.js';
import { getNotificationCenter } from '../app/notification-center.js';
import { validateDataMapping } from './data-mapping.js';
import { ViewerChannel } from './viewer-channel.js';
import { connectEmbeddedHost, isEmbeddedViewerAddress } from './viewer-embed.js';
import { routedFetch } from '../formats/io/host-fetch.js';
import { publicPageAddress } from './sources/registry.js';
import {
  VIEWER_CHANNEL_PATH,
  VIEWER_HOST_RUNTIMES,
  VIEWER_PAGE_MODE_PARAMETER,
  VIEWER_PAGE_PARAMETERS,
  VIEWER_COMMAND_ERROR_REASON_LIMIT,
  VIEWER_DATA_MAPPING_ORIGINS,
  VIEWER_RESULT_META_FIELDS,
  VIEWER_ACTION_STEP_FIELDS,
  VIEWER_COMMAND_FIELDS,
  VIEWER_SESSION_LOADED_TRACKER_FIELDS,
  isViewerActionType,
  isViewerResultEpoch,
  requireViewerActionCommand,
  requireViewerAgentCommand,
  requireViewerHistoryChanged,
  requireViewerLoadSession,
  encodeViewerCells,
  encodeViewerResult,
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
import { abortReason, cancelled, cancel, onAbort, throwIfAborted } from '../utils/abort.js';
import { failureText } from '../utils/errors.js';

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

/** The page address a debug snapshot reports: public data link, no viewer token. */
function snapshotAddress(href) {
  const address = new URL(publicPageAddress(href));
  address.searchParams.delete('viewerToken');
  return address.href;
}

/**
 * The configuration of a viewer a notebook widget embeds (`?viewer=embedded`):
 * its credentials and the host's address arrive from the widget
 * (`connectEmbeddedHost`), never in the page address.
 */
export const EMBEDDED_VIEWER_HOST = Object.freeze({ embedded: true });

/**
 * The viewer host configuration from URL parameters: a served viewer's
 * exact routing fields, `EMBEDDED_VIEWER_HOST` for a widget's viewer, or null.
 * @returns {ViewerHostConfig|typeof EMBEDDED_VIEWER_HOST|null}
 */
export function getViewerHostConfig() {
  const params = new URLSearchParams(window.location.search);
  const declaredKeys = [...params.keys()];
  const modeValues = params.getAll(VIEWER_PAGE_MODE_PARAMETER);
  if (modeValues.length === 0) {
    return null;
  }
  if (isEmbeddedViewerAddress(params)) {
    return EMBEDDED_VIEWER_HOST;
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

/** Work of an older viewer host lifecycle a newer one replaced: a `superseded` cancellation. */
function viewerHostLifecycleSuperseded(label) {
  return cancelled('superseded', `${label} was superseded by a newer viewer host lifecycle.`);
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
 * One JSON document of the host's server (`/_cellucid/<route>`), under the
 * caller's signal and no clock of its own. The host is a Python or R
 * session: a notebook kernel answers between cells (none while one runs,
 * `viewer-embed.js`), a served one from the same machine, busy perhaps with
 * a large dataset. A late answer is still an answer: what bounds the wait is
 * its owner (startup's step, measured as silence and standing still while
 * the notebook runs a cell; the viewer's lifecycle), and a host that went
 * away refuses the connection or is said to have ended.
 */
/**
 * A request the Python or R host answered with an error: its status and
 * address kept, so it is said by whose problem it is wherever it is shown
 * (`describeHostFault`, `data-source.js`).
 */
function viewerHostFailure(what, url, status) {
  return new DataSourceError(`${what} request failed with HTTP ${status}`, DataSourceErrorCode.NETWORK_ERROR, 'jupyter', { url, status });
}

async function requestViewerHostDocument(config, route, label, signal = null) {
  const exactConfig = requireViewerHostRuntimeConfig(config);
  throwIfAborted(signal);
  const url = `${exactConfig.serverUrl}/_cellucid/${route}`;
  const response = await routedFetch(url, {
    cache: 'no-store',
    signal,
  });
  throwIfAborted(signal);
  if (!(response instanceof Response)) {
    throw new TypeError(`Viewer host ${label} fetch must return a Response`);
  }
  if (!response.ok) throw viewerHostFailure(`Viewer host ${label}`, url, response.status);
  const payload = await readBoundedJson(response, {
    label: `Viewer host ${label} request`,
    signal,
  });
  throwIfAborted(signal);
  return payload;
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
  throwIfAborted(signal);
  const protocolUrl = `${exactConfig.serverUrl}/_cellucid/protocol`;
  const response = await routedFetch(protocolUrl, {
    cache: 'no-store',
    signal,
  });
  throwIfAborted(signal);
  if (!(response instanceof Response)) {
    throw new TypeError('Viewer host protocol fetch must return a Response');
  }
  if (response.status === 404) {
    throw new Error(
      'The host offers no viewer channel: its cellucid package is older than this viewer. ' +
      'Upgrade it (Python: pip install -U cellucid; R: install.packages("cellucid")) and run the cell again.'
    );
  }
  if (!response.ok) throw viewerHostFailure('Viewer host protocol', protocolUrl, response.status);
  const payload = await readBoundedJson(response, {
    label: 'Viewer host protocol request',
    signal,
  });
  throwIfAborted(signal);
  return requireViewerHostProtocolPayload(payload);
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

/**
 * The notebook server's catalog as it is now: one request, past the HTTP
 * cache, so the store it names (its ETag the version of what is kept of
 * it) is the one the server serves at this moment.
 */
async function fetchDatasetList(serverUrl, signal) {
  const response = await routedFetch(`${serverUrl}/_cellucid/datasets`, { signal, cache: 'no-store' });
  if (!(response instanceof Response)) {
    throw new TypeError(
      'Viewer host dataset listing fetch must return a Response'
    );
  }
  if (!response.ok) throw viewerHostFailure('Viewer host dataset listing', `${serverUrl}/_cellucid/datasets`, response.status);
  const catalogPayload = await readBoundedJson(response, {
    label: 'Viewer host dataset listing',
  });
  return requireDatasetCatalogPayload(catalogPayload);
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
 * The language of each runtime a host names (`VIEWER_HOST_RUNTIMES`):
 * `jupyter` is Python's notebook viewer (R's says `r` in a notebook too).
 */
const VIEWER_HOST_LANGUAGES = Object.freeze({ python: 'python', jupyter: 'python', r: 'r' });


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
 * The request id one failed viewer-channel frame named, when it named one as
 * exact text; null otherwise (`freeze`, or a frame read no further).
 *
 * @param {unknown} data - The frame's parsed JSON object.
 * @returns {string|null}
 */
export function describeViewerHostRequestId(data) {
  const requestId = isPlainRecord(data) ? data.requestId : undefined;
  try {
    return requireExactText(requestId, 'Viewer host requestId');
  } catch {
    return null;
  }
}

/**
 * Build the exact user-facing text for one failed notebook command.
 *
 * The person watching sees why a notebook's command did nothing (a console
 * entry inside an embedded iframe is no user surface); the notebook learns it
 * from the `command_error` event that names the command's `requestId`, which
 * fails the notebook's request for it. A failed `action` is named by its
 * dotted type (`color.by`), which is safe to show: only a type of the
 * catalogue's form is named, any other text is not echoed.
 *
 * @param {string|null} commandType - A value from {@link describeViewerHostCommandType}.
 * @param {unknown} error
 * @param {string|null} [action] - The failed action's type, for an `action`
 * @returns {{title: string, message: string}}
 */
export function describeViewerHostCommandFailure(commandType, error, action = null) {
  if (commandType !== null && !VIEWER_HOST_COMMAND_TYPES.includes(commandType)) {
    throw new TypeError(
      'Viewer host command failure type must be one recognised command or null'
    );
  }
  const subject = commandType === null
    ? 'A notebook command'
    : commandType === 'action' && isViewerActionType(action)
      ? `The notebook's "${action}" action`
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
    /** @type {ViewerHostConfig|typeof EMBEDDED_VIEWER_HOST|null} */
    this._declaredConfig = config === null || config === EMBEDDED_VIEWER_HOST
      ? config
      : captureViewerHostRuntimeConfig(config);

    /**
     * How the host is reached: its configuration and the WebSocket class the
     * viewer channel opens (the browser's, or the embedding widget's port,
     * `viewer-embed.js`). Set by `connectHost()`.
     * @type {{config: ViewerHostConfig, WebSocketImpl: typeof WebSocket|undefined}|null}
     */
    this._hostConnection = null;

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

    /** @type {Set<Function>} Run when a dropped channel was opened again. */
    this._reopenCallbacks = new Set();

    /** @type {boolean} */
    this._connected = false;

    /**
     * The metadata of each dataset opened on this connection, with the
     * store it was read from (`servedStoreKey`): it stands only while the
     * server's listing, asked at each opening, names that store.
     * @type {Map<string, {key: string, metadata: DatasetMetadata}>}
     */
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

    /**
     * What runs a host's action (`onAction`): resolves to its outcome and
     * the history step it made.
     * @type {((action: {action: string, params: object}) => Promise<{outcome: unknown, step: {id: string, label: string}|null}>)|null}
     */
    this._actionHandler = null;
    this._loadSessionHandler = null;
    this._agentHandler = null;

    this._lifecycleRevision = 0;
    this._catalogRevision = 0;
    /** @type {AbortController|null} */
    this._catalogController = null;
    /** @type {AbortController|null} */
    this._initializationController = null;
    /** Ends what belongs to the lifecycle (`initialize` to `disconnect`). @type {AbortController|null} */
    this._lifecycleController = null;
    this._destroyed = false;
    /** @type {string|null} The program serving the viewer (`VIEWER_HOST_RUNTIMES`) */
    this._runtime = null;

    /**
     * The open dataset's cell identity (`data/cell-identity.js`), asked for
     * each event that names cells.
     * @type {(() => import('./cell-identity.js').CellIdentity)|null}
     */
    this._cellIdentityProvider = null;

    /**
     * The id of the host's dataset the viewer shows, or null when the person
     * opened another one in it (`setShownDatasetProvider`).
     * @type {(() => string|null)|null}
     */
    this._shownDatasetProvider = null;

    this.type = 'jupyter';
  }

  /**
   * Say which of the host's datasets the viewer shows: `provider` returns its
   * id (`/_cellucid/datasets`), or null while the viewer shows a dataset the
   * host did not serve. Events that name cells (a selection, a hover, a
   * click) are sent only while it names one: the host's cell positions
   * describe its own dataset.
   *
   * @param {() => string|null} provider
   */
  setShownDatasetProvider(provider) {
    if (typeof provider !== 'function') {
      throw new TypeError('Viewer host shown-dataset provider must be a function');
    }
    this._shownDatasetProvider = provider;
  }

  /** The id of the host's dataset the viewer shows, or null (another dataset). */
  getShownHostDataset() {
    if (this._shownDatasetProvider === null) {
      throw new Error('Viewer host events name cells only once the app said which dataset it shows');
    }
    const id = this._shownDatasetProvider();
    if (id !== null && (typeof id !== 'string' || id.length === 0)) {
      throw new TypeError('Viewer host shown dataset must be a dataset id or null');
    }
    return id;
  }

  /**
   * Name cells by original position from now on: `provider` returns the open
   * dataset's cell identity.
   *
   * @param {() => import('./cell-identity.js').CellIdentity} provider
   */
  setCellIdentityProvider(provider) {
    if (typeof provider !== 'function') {
      throw new TypeError('Viewer host cell identity provider must be a function');
    }
    this._cellIdentityProvider = provider;
  }

  /** The open dataset's cell identity. */
  _cellIdentity() {
    if (this._cellIdentityProvider === null) {
      throw new Error('Viewer host events name cells only once the app gave it the dataset\'s cell identity');
    }
    return this._cellIdentityProvider();
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

  /**
   * The language of the program serving the viewer, which a step it takes is
   * labelled with: `python` (a script, or Jupyter -- the runtime of Python's
   * notebook viewers) or `r`; null before it answered.
   *
   * @returns {'python'|'r'|null}
   */
  getHostLanguage() {
    return this._runtime === null ? null : VIEWER_HOST_LANGUAGES[this._runtime];
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
   * @param {unknown} command - The command's parsed frame (anything)
   * @param {unknown} error
   */
  _reportMessageFailure(command, error) {
    const commandType = describeViewerHostCommandType(command);
    const action = commandType === 'action' && isViewerActionType(command.action) ? command.action : null;
    const failure = describeViewerHostCommandFailure(commandType, error, action);
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
          requestId: describeViewerHostRequestId(command),
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
      getNotificationCenter().error(failureText(failure), {
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
    let result;
    try {
      result = this._handleCommand(command);
    } catch (error) {
      this._reportMessageFailure(command, error);
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
        this._reportMessageFailure(command, error);
      });
    }
  }

  /**
   * Start running the host's commands: the app calls this once every handler
   * it registers with `onAction`/`onMessage` is in place. Commands that
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

  /**
   * Register what runs when the viewer channel, dropped (the network, a
   * proxy restarting), was opened again: the viewer sends the host its
   * results snapshot again.
   *
   * @param {() => void} callback
   */
  onChannelReopen(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Viewer host channel-reopen callback must be a function');
    }
    this._reopenCallbacks.add(callback);
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
      throw viewerHostLifecycleSuperseded(label);
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
      throw viewerHostLifecycleSuperseded(label);
    }
  }

  _assertCatalog(owner, label) {
    this._assertConnection(owner, label);
    if (
      owner.catalogRevision !== this._catalogRevision ||
      owner.catalogController !== this._catalogController ||
      owner.catalogController?.signal.aborted
    ) {
      throw viewerHostLifecycleSuperseded(label);
    }
  }

  _beginCatalogGeneration(reason) {
    const previousController = this._catalogController;
    const controller = new AbortController();
    this._catalogController = controller;
    const revision = ++this._catalogRevision;
    cancel(previousController, 'superseded', reason);
    return { controller, revision };
  }

  _endCatalogGeneration(reason) {
    const previousController = this._catalogController;
    this._catalogController = null;
    this._catalogRevision += 1;
    this._metadataInFlight = new Map();
    cancel(previousController, 'closed', reason);
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
   * Whether a notebook widget embeds this viewer (`?viewer=embedded`).
   * @returns {boolean}
   */
  isEmbedded() {
    return this._declaredConfig === EMBEDDED_VIEWER_HOST;
  }

  /**
   * Reach the host: at once for a served viewer, whose address names it;
   * for an embedded one, once the widget that embeds the page connected it
   * (`connectEmbeddedHost`), which waits for nothing but the notebook: the
   * kernel answers the widget between cells, so this has no deadline.
   *
   * @returns {Promise<void>}
   */
  async connectHost() {
    this._assertAlive();
    if (this._hostConnection !== null || this._declaredConfig === null) return;
    if (this.isEmbedded()) {
      const { config, WebSocketImpl } = await connectEmbeddedHost();
      this._assertAlive();
      this._hostConnection = { config: captureViewerHostRuntimeConfig(config), WebSocketImpl };
      return;
    }
    this._hostConnection = { config: this._declaredConfig, WebSocketImpl: undefined };
  }

  /**
   * Initialize from URL parameters
   * @returns {Promise<boolean>} True if successfully initialized
   */
  /**
   * @param {{signal?: AbortSignal|null}} [options] - What else stops the
   *   initialization (startup's step): its requests have no clock of their own
   */
  async initialize({ signal = null } = {}) {
    this._assertAlive();
    if (this._declaredConfig === null) {
      return false;
    }
    // A served viewer's requests start at once; an embedded one waits for
    // the widget (`main.js` connects it first, outside any deadline).
    if (this._hostConnection === null) {
      if (this.isEmbedded()) await this.connectHost();
      else this._hostConnection = { config: this._declaredConfig, WebSocketImpl: undefined };
    }
    const { config, WebSocketImpl } = this._hostConnection;

    const revision = ++this._lifecycleRevision;
    const previousController = this._initializationController;
    const controller = new AbortController();
    this._initializationController = controller;
    const stopRelay = onAbort(signal, () => controller.abort(abortReason(signal)));
    cancel(previousController, 'superseded', 'Viewer host initialization was superseded.');
    // What belongs to this lifecycle, not to one listing (the listing an
    // opening reads to name its store): the next initialization or a
    // disconnect ends it.
    cancel(this._lifecycleController, 'superseded', 'A newer viewer host lifecycle replaced this one.');
    this._lifecycleController = new AbortController();
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
    let adopted = false;
    try {
      const health = await requestViewerHostHealth(config, controller.signal);
      this._assertLifecycle(revision, 'Viewer host initialization');
      const [protocol, runtime] = await Promise.all([
        requestViewerHostProtocol(config, controller.signal),
        requestViewerHostInfo(config, health, controller.signal),
      ]);
      this._assertLifecycle(revision, 'Viewer host initialization');
      if (this._initializationController !== controller) {
        throw viewerHostLifecycleSuperseded(
          'Viewer host initialization'
        );
      }
      const channel = new ViewerChannel({
        serverUrl: config.serverUrl,
        viewerId: config.viewerId,
        viewerToken: config.viewerToken,
        channelPath: protocol.channel,
        WebSocketImpl,
        onCommand: command => {
          if (this._channel === channel) this._observeCommand(command);
        },
        onEnd: end => this._channelEnded(channel, end),
        onReopen: () => {
          if (this._channel !== channel) return;
          for (const callback of [...this._reopenCallbacks]) {
            try {
              callback();
            } catch (error) {
              console.error('[ViewerHost] channel-reopen handler failed:', error);
            }
          }
        },
        isHostAlive: async () => {
          try {
            // Under the lifecycle: a disconnect stops the question.
            await requestViewerHostHealth(config, this._lifecycleController?.signal ?? null);
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
        throw viewerHostLifecycleSuperseded('Viewer host initialization');
      }
      this._config = config;
      this._protocol = protocol;
      this._runtime = runtime;
      this._connected = true;
      this._beginCatalogGeneration(
        'Viewer host catalog was initialized'
      );
      adopted = true;
      return true;
    } catch (error) {
      if (
        revision !== this._lifecycleRevision ||
        this._initializationController !== controller
      ) {
        throw viewerHostLifecycleSuperseded(
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
      stopRelay();
      // A failed initialization stops every request it started that is
      // still under way (it asks for the protocol and the host's info at
      // once): nothing waits for them any more.
      if (!adopted) cancel(controller, 'superseded', 'Viewer host initialization failed: nothing waits for its other requests.');
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
      throw viewerHostLifecycleSuperseded('Viewer host AnnData store');
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
          // Where the page is, without what grants access: a data link in
          // public form, and no viewer token (a snapshot is printed in a
          // notebook's output, which is saved with it).
          locationHref: snapshotAddress(window.location.href),
          origin: window.location.origin,
          serverUrl: config.serverUrl,
          connected: this._connected,
          userAgent: (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent : null
        });

      case 'action':
        // A text frame as it came, or a binary one with its arrays in place
        // in its parameters (`decodeViewerBinaryCommand`).
        requireExactKeys(data, VIEWER_COMMAND_FIELDS.action, 'Viewer host action');
        requireViewerActionCommand(data);
        return this._runAction(data);

      case 'agent_list':
      case 'agent_call':
      case 'agent_cancel':
      case 'agent_answer':
        // An agent app's call through the host's `cellucid mcp`: run as the
        // agent through a local connection (`onAgent`), answered by its own
        // events, never a `command_error` once it is read.
        requireExactKeys(data, VIEWER_COMMAND_FIELDS[data.type], `Viewer host ${data.type}`);
        requireViewerAgentCommand(data);
        return this._runAgentCommand(data);

      case 'load_session':
        // Only ever a binary frame (`decodeViewerBinaryCommand`): the file as
        // its body.
        requireExactKeys(data, ['type', 'requestId', 'name', 'file'], 'Viewer host session load');
        requireViewerLoadSession(data);
        return this._runLoadSession(data);

      case 'freeze':
        requireExactKeys(
          data,
          ['type'],
          'Viewer host freeze message'
        );
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
        this._requireHostDatasetShown();
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
   * Run one host action through the app's handler (`onAction`) and answer it
   * with its `action_result`: its outcome (a read's result) as JSON in the
   * frame's body, and the history step it made. A failure reaches the host
   * as the `command_error` of its `requestId` (`_observeCommand`).
   *
   * @param {{requestId: string, action: string, params: object}} command
   * @private
   */
  async _runAction(command) {
    if (this._actionHandler === null) {
      throw new Error('This viewer cannot carry out actions yet; reload the page.');
    }
    const answer = await this._actionHandler({
      action: command.action, params: command.params, turn: command.turn, turnLabel: command.turnLabel,
    });
    requireExactKeys(answer, ['outcome', 'step'], 'Viewer host action answer');
    this._sendActionResult(command.requestId, answer.outcome, answer.step);
  }

  /**
   * One agent command through the app's agent handler (`onAgent`): the tool
   * list (`agent_tools`), a call (its `agent_result`, whatever happens), a
   * stop, or the person's answer given in the agent's app.
   *
   * @param {object} command - an agent command, its keys checked (`requireViewerAgentCommand`)
   * @private
   */
  _runAgentCommand(command) {
    if (this._agentHandler === null) {
      throw new Error('This viewer cannot take agent calls yet; reload the page.');
    }
    switch (command.type) {
      case 'agent_list':
        return this._sendAgentJson('agent_tools', command.requestId, this._agentHandler.list(command.connection));
      case 'agent_call':
        return this._agentHandler.call({
          id: command.requestId, tool: command.tool, args: command.args, agent: command.agent, connection: command.connection,
        });
      case 'agent_cancel':
        return this._agentHandler.cancel(command.requestId);
      default:
        return this._agentHandler.answer(command.requestId, command.allowed);
    }
  }

  /**
   * Send a binary agent event whose body is JSON (`agent_tools`,
   * `agent_result`), when the host accepts it.
   *
   * @param {'agent_tools'|'agent_result'} type
   * @param {string} requestId
   * @param {unknown} body - JSON
   * @returns {boolean} Whether it was sent
   * @private
   */
  _sendAgentJson(type, requestId, body) {
    this._captureConnection(`Viewer host ${type}`);
    requireExactText(requestId, `Viewer host ${type} requestId`);
    requireExactJsonValue(body, `Viewer host ${type} body`);
    if (!this._protocol.events.has(type)) return false;
    this._channel.sendBinary({ type, requestId }, new Blob([JSON.stringify(body)]));
    return true;
  }

  /**
   * Load the session file a host pushed (`load_session`) through the app's
   * handler (`onLoadSession`) and answer it with `session_loaded`: the
   * tracker shown and its step shown. A failure reaches the host as the
   * `command_error` of its `requestId` (`_observeCommand`).
   *
   * @param {{requestId: string, name: string, file: Uint8Array}} command
   * @private
   */
  async _runLoadSession(command) {
    if (this._loadSessionHandler === null) {
      throw new Error('This viewer cannot load a session yet; reload the page.');
    }
    const answer = await this._loadSessionHandler({ name: command.name, file: command.file });
    requireExactKeys(answer, ['tracker', 'head'], 'Viewer host session load answer');
    requireExactKeys(answer.tracker, VIEWER_SESSION_LOADED_TRACKER_FIELDS, 'Viewer host session load tracker');
    requireExactText(answer.tracker.id, 'Viewer host session load tracker id');
    requireExactText(answer.tracker.name, 'Viewer host session load tracker name', { allowWhitespace: true });
    requireExactText(answer.head, 'Viewer host session load head');
    this._sendEvent({
      type: 'session_loaded',
      requestId: command.requestId,
      tracker: { id: answer.tracker.id, name: answer.tracker.name },
      head: answer.head
    });
  }

  /**
   * Send an action's answer, when the host accepts it.
   *
   * @param {string} requestId
   * @param {unknown} outcome - JSON (null: nothing to report)
   * @param {{id: string, label: string}|null} step
   * @returns {boolean} Whether it was sent
   * @private
   */
  _sendActionResult(requestId, outcome, step) {
    this._captureConnection('Viewer host action answer');
    requireExactText(requestId, 'Viewer host action requestId');
    if (step !== null) {
      requireExactKeys(step, VIEWER_ACTION_STEP_FIELDS, 'Viewer host action step');
      requireExactText(step.id, 'Viewer host action step id');
      requireExactText(step.label, 'Viewer host action step label', { allowWhitespace: true });
    }
    requireExactJsonValue(outcome, 'The action\'s outcome');
    if (!this._protocol.events.has('action_result')) return false;
    this._channel.sendBinary({
      type: 'action_result',
      requestId,
      step
    }, new Blob([JSON.stringify(outcome)]));
    return true;
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
   * A session goes to the host only while the viewer shows the host's own
   * dataset, as hover, click, selection and results do: a session of another
   * dataset (a local file, a Drive file, a link opened in the viewer) is
   * that dataset's, and is refused as a `command_error` the host reports.
   *
   * @private
   */
  _requireHostDatasetShown() {
    if (this.getShownHostDataset() === null) {
      throw new Error(
        'the viewer shows another dataset than the one this notebook gave it, so its session is not sent; ' +
        'open the notebook\'s dataset in the viewer again to capture its session'
      );
    }
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
    // Checked again here: the person may have opened another dataset while
    // the session was captured.
    this._requireHostDatasetShown();
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
   * @param {Uint32Array} cellIndices - Selected cells in subset positions,
   *   ascending, at least one. The host receives their original positions.
   * @param {string} source - Selection source ('lasso', 'knn', 'proximity', 'annotation')
   */
  async notifySelection(cellIndices, source) {
    if (!this._connected) {
      throw new Error('Viewer host event source is not connected');
    }
    encodeViewerCells(cellIndices, 'Viewer host selection cells');
    if (this.getShownHostDataset() === null) return false;
    // Open cells in another order than their original one (a priority-ordered
    // dataset) are named ascending, as the protocol names a cell set.
    const body = encodeViewerCells(
      this._cellIdentity().toOriginal(cellIndices).sort(),
      'Viewer host selection cells'
    );
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
    if (this.getShownHostDataset() === null) return false;
    const cell = cellIndex === null ? null : this._cellIdentity().toOriginal([cellIndex])[0];
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
      cell,
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
    if (this.getShownHostDataset() === null) return false;
    const event = {
      type: 'click',
      cell: this._cellIdentity().toOriginal([cellIndex])[0],
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
   * @param {{origin: string, mapping: Object}} report - `origin` is why the
   *   mapping is what it is (`notebook`: the host's own `mapping.set`)
   * @returns {Promise<boolean>} Whether the event was sent.
   */
  async notifyDataMapping(report) {
    if (!this._connected) {
      throw new Error('Viewer host event source is not connected');
    }
    requireExactKeys(
      report,
      ['origin', 'mapping'],
      'Viewer host data-mapping report'
    );
    if (!VIEWER_HOST_DATA_MAPPING_ORIGINS.includes(report.origin)) {
      throw new TypeError(
        `Viewer host data-mapping origin must be one of ${VIEWER_HOST_DATA_MAPPING_ORIGINS.join(', ')}`
      );
    }
    const mapping = validateDataMapping(report.mapping, {
      label: 'Viewer host data-mapping report'
    });
    return this._sendEvent({
      type: 'data_mapping',
      origin: report.origin,
      mapping
    });
  }

  /**
   * Notify Python that viewer is ready with dataset info
   * @param {Object} info - Dataset info
   * @param {number} info.dimensions - Embedding dimensions (1, 2, or 3)
   *   The cells open and in the dataset come from the cell identity.
   */
  async notifyReady(info) {
    if (!this._connected) {
      throw new Error('Viewer host event source is not connected');
    }
    requireExactKeys(
      info,
      ['dimensions'],
      'Viewer host ready info'
    );
    const identity = this._cellIdentity();
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
      n_cells: identity.n,
      n_obs: identity.nOriginal,
      dimensions: info.dimensions
    };
    return this._sendEvent(event);
  }

  /**
   * Send one result (`encodeViewerResult`), when the host accepts results.
   * Its cells are already original positions: the results publisher
   * (`app/viewer-host/results.js`) names them.
   *
   * @param {Parameters<typeof encodeViewerResult>[0]} result
   * @returns {boolean} Whether it was sent
   */
  notifyResult(result) {
    this._captureConnection('Viewer host result delivery');
    const { header, body } = encodeViewerResult(result);
    if (!this._protocol.events.has('result')) return false;
    this._channel.sendBinary(header, new Blob(body));
    return true;
  }

  /**
   * Say a result is gone.
   *
   * @param {{epoch: string, revision: number, kind: string, id: string}} removal
   * @returns {boolean} Whether it was sent
   */
  notifyResultRemoved(removal) {
    requireExactKeys(removal, ['epoch', 'revision', 'kind', 'id'], 'Viewer host result removal');
    if (!isViewerResultEpoch(removal.epoch)) throw new TypeError('Viewer host result removal epoch must be an epoch');
    requireNonNegativeInteger(removal.revision, 'Viewer host result removal revision');
    if (!Object.hasOwn(VIEWER_RESULT_META_FIELDS, removal.kind)) {
      throw new TypeError('Viewer host result removal kind must be a result kind');
    }
    requireExactText(removal.id, 'Viewer host result removal id', { allowWhitespace: true });
    return this._sendEvent({
      type: 'result_removed',
      epoch: removal.epoch,
      revision: removal.revision,
      kind: removal.kind,
      id: removal.id
    });
  }

  /**
   * Send the inventory of every result of `epoch` at `revision`: the end of
   * a snapshot (a dataset opened, the channel opened again). `dataset` is the
   * host's dataset they describe, or null (the viewer shows another dataset,
   * and `items` is empty).
   *
   * @param {{epoch: string, dataset: string|null, revision: number, nObs: number,
   *   items: Array<{kind: string, id: string, revision: number}>}} inventory
   * @returns {boolean} Whether it was sent
   */
  notifyResults(inventory) {
    requireExactKeys(inventory, ['epoch', 'dataset', 'revision', 'nObs', 'items'], 'Viewer host results inventory');
    if (!isViewerResultEpoch(inventory.epoch)) throw new TypeError('Viewer host results epoch must be an epoch');
    if (inventory.dataset !== null) requireExactText(inventory.dataset, 'Viewer host results dataset');
    requireNonNegativeInteger(inventory.revision, 'Viewer host results revision');
    requireNonNegativeInteger(inventory.nObs, 'Viewer host results nObs');
    if (!Array.isArray(inventory.items)) throw new TypeError('Viewer host results items must be a list');
    if (inventory.dataset === null && inventory.items.length > 0) {
      throw new TypeError('Viewer host results of another dataset list nothing');
    }
    for (const item of inventory.items) {
      requireExactKeys(item, ['kind', 'id', 'revision'], 'Viewer host results item');
    }
    return this._sendEvent({
      type: 'results',
      epoch: inventory.epoch,
      dataset: inventory.dataset,
      revision: inventory.revision,
      nObs: inventory.nObs,
      items: inventory.items
    });
  }

  /**
   * Say which field the viewer colours by now.
   *
   * @param {{field: string|null, source: 'obs'|'var'|null, symbol: string|null}} colorBy
   *   `field` a gene's identifier (the var index) or an obs key; `symbol` the
   *   name the viewer shows for a gene when it differs from its identifier (a
   *   var column names the genes), else null
   * @returns {boolean} Whether it was sent
   */
  notifyColorBy(colorBy) {
    requireExactKeys(colorBy, ['field', 'source', 'symbol', 'cells_read'], 'Viewer host colour-by report');
    const { field, source, symbol, cells_read: cellsRead } = colorBy;
    if ((field === null) !== (source === null)) {
      throw new TypeError('Viewer host colour-by names a field and its source, or neither');
    }
    if (symbol !== null && source !== 'var') {
      throw new TypeError('Viewer host colour-by names a symbol only for a gene');
    }
    if (field !== null) {
      requireExactText(field, 'Viewer host colour-by field', { allowWhitespace: true });
      if (source !== 'obs' && source !== 'var') throw new TypeError('Viewer host colour-by source must be obs or var');
    }
    if (symbol !== null) requireExactText(symbol, 'Viewer host colour-by symbol', { allowWhitespace: true });
    // A gene read for the first open cells only (a gene sample): how many.
    if (cellsRead !== null && (source !== 'var' || !Number.isSafeInteger(cellsRead) || cellsRead < 0)) {
      throw new TypeError('Viewer host colour-by names the cells read only for a gene, as a count');
    }
    return this._sendEvent({
      type: 'color_by',
      field,
      source,
      symbol,
      cells_read: cellsRead
    });
  }

  // =========================================================================
  // PYTHON EVENT CALLBACKS (Python → Frontend)
  // =========================================================================

  /**
   * Register what carries out the host's actions: `handler({action, params})`
   * applies (or reads) the catalogue's action `action` -- its parameters
   * checked by the action's schema, its typed arrays in place -- and resolves
   * to `{outcome, step}`: the action's outcome (JSON; a read's result) and
   * the history step it made as `{id, label}`, or null. A rejection is the
   * host's `command_error`. One handler: each action is answered once.
   *
   * @param {(action: {action: string, params: object}) => Promise<{outcome: unknown, step: {id: string, label: string}|null}>} handler
   */
  onAction(handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('Viewer host action handler must be a function');
    }
    if (this._actionHandler !== null) {
      throw new Error('Viewer host actions already have a handler');
    }
    this._actionHandler = handler;
  }

  /**
   * Register what runs an agent app's calls that come through the host
   * (`cellucid mcp`): `list(connection)` returns the MCP tools as that
   * connection may use them; `call({id, tool, args, agent, connection})`
   * runs one and answers it later with `sendAgentResult(id, result)`;
   * `cancel(id)` stops it; `answer(id, allowed)` answers the person's
   * question about it from the agent's app. One handler
   * (`app/agent/bridge/agent-calls.js` behind it).
   *
   * @param {{list: Function, call: Function, cancel: Function, answer: Function}} handler
   */
  onAgent(handler) {
    for (const name of ['list', 'call', 'cancel', 'answer']) {
      if (typeof handler?.[name] !== 'function') throw new TypeError(`Viewer host agent handler needs ${name}()`);
    }
    if (this._agentHandler !== null) {
      throw new Error('Viewer host agent calls already have a handler');
    }
    this._agentHandler = handler;
  }

  /**
   * Answer an agent call (`agent_result`): its MCP tool result.
   * @param {string} requestId
   * @param {{content: object[], isError: boolean}} result
   * @returns {boolean} Whether it was sent
   */
  sendAgentResult(requestId, result) {
    if (!this._connected) return false;
    return this._sendAgentJson('agent_result', requestId, result);
  }

  /**
   * The person is asked about agent call `requestId` (`agent_asking`):
   * the card's question in one sentence, and what makes it cost (or null).
   * @param {string} requestId
   * @param {{message: string, detail: string|null}} question
   */
  sendAgentAsking(requestId, { message, detail = null }) {
    if (!this._connected) return false;
    requireExactText(requestId, 'Viewer host agent_asking requestId');
    return this._sendEvent({
      type: 'agent_asking',
      requestId,
      message: String(message),
      detail: detail === null ? null : String(detail)
    });
  }

  /** The person answered the question about agent call `requestId` (`agent_answered`). */
  sendAgentAnswered(requestId, allowed) {
    if (!this._connected) return false;
    requireExactText(requestId, 'Viewer host agent_answered requestId');
    return this._sendEvent({
      type: 'agent_answered',
      requestId,
      allowed: allowed === true
    });
  }

  /** The person's settings changed what a tool list says (`agent_tools_changed`). */
  notifyAgentToolsChanged() {
    if (!this._connected) return false;
    return this._sendEvent({
      type: 'agent_tools_changed'
    });
  }

  /**
   * Register what loads a session file the host pushed: `handler({name,
   * file})` loads the `.cellucid-session` bytes `file` (named `name`) into
   * the open dataset's history and resolves to `{tracker: {id, name}, head}`,
   * the tracker shown and its step shown. A rejection is the host's
   * `command_error`. One handler.
   *
   * @param {(load: {name: string, file: Uint8Array}) => Promise<{tracker: {id: string, name: string}, head: string}>} handler
   */
  onLoadSession(handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('Viewer host session-load handler must be a function');
    }
    if (this._loadSessionHandler !== null) {
      throw new Error('Viewer host session loads already have a handler');
    }
    this._loadSessionHandler = handler;
  }

  /**
   * Tell the host the history changed (`history_changed`), when it accepts
   * that event and the viewer shows the host's dataset: a history of another
   * dataset is not the host's.
   *
   * @param {{kind: string, tracker: string, head: string, step: string|null, branch: string|null}} change
   * @returns {boolean} Whether it was sent
   */
  notifyHistoryChanged(change) {
    requireExactKeys(change, ['kind', 'tracker', 'head', 'step', 'branch'], 'Viewer host history change');
    const event = requireViewerHistoryChanged({
      type: 'history_changed',
      kind: change.kind,
      tracker: change.tracker,
      head: change.head,
      step: change.step,
      branch: change.branch
    });
    if (this.getShownHostDataset() === null) return false;
    return this._sendEvent(event);
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
      const datasetList = await fetchDatasetList(
        owner.config.serverUrl,
        catalogOwner.controller.signal
      );
      this._assertCatalog(owner, 'Viewer host dataset listing');
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
        throw viewerHostLifecycleSuperseded(
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

  /**
   * One dataset as the server's listing names it now (`fetchDatasetList`),
   * adopted as the connection's entry for it.
   * @private
   */
  async _declaredNow(owner, id) {
    if (owner.signal === null) throw viewerHostLifecycleSuperseded('Viewer host dataset metadata');
    const datasetList = await fetchDatasetList(owner.config.serverUrl, owner.signal);
    this._assertConnection(owner, 'Viewer host dataset metadata');
    const dataset = datasetList.find(entry => entry.id === id);
    if (dataset === undefined) {
      throw new DataSourceError(
        `Viewer host dataset ${JSON.stringify(id)} is not declared by the current listing`,
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        { datasetId: id }
      );
    }
    this._datasetEntries.set(id, dataset);
    return dataset;
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

    // Opening the store belongs to the connection, not to one listing: the
    // dataset list is read again while a dataset opens (the controls list
    // every source when they start), and that must not cancel the open. The
    // open stands while the connection lasts and the dataset still names
    // the same store.
    const owner = {
      config: this._config,
      lifecycleRevision: this._lifecycleRevision,
      signal: this._lifecycleController?.signal ?? null,
    };
    // The store the server names now, asked at each opening: a file
    // rewritten since an earlier listing has another ETag, so it opens as
    // its new version, never as the one that listing named.
    const dataset = await this._declaredNow(owner, id);
    const key = servedStoreKey(owner.config.serverUrl, dataset);
    const opened = this._datasetCache.get(id);
    if (opened?.key === key) return opened.metadata;
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
          throw viewerHostLifecycleSuperseded(
            'Viewer host dataset metadata'
          );
        }
        this._datasetCache.set(id, { key, metadata });
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
    cancel(this._initializationController, 'closed', 'Viewer host initialization was cancelled by disconnect.');
    this._initializationController = null;
    cancel(this._lifecycleController, 'closed', 'The viewer host was disconnected.');
    this._lifecycleController = null;
    this._closeChannel();
    this._connected = false;
    this._config = null;
    this._protocol = EMPTY_VIEWER_HOST_PROTOCOL;
    this._datasetCache.clear();
    this._summaries.clear();
    this._datasetEntries.clear();
    this._releaseAnnData();
    this._messageCallbacks.clear();
    this._actionHandler = null;
    this._loadSessionHandler = null;
    this._agentHandler = null;
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
