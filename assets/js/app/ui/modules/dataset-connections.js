/**
 * Exact dataset connection and local-file controls.
 *
 * Remote/GitHub connection attempts always use isolated source candidates.
 * Zero-dataset and failed candidates are disconnected without replacing the
 * registered source. One dataset is transactionally activated; multiple
 * datasets require an explicit enabled-selector choice.
 */

import { formatCompactCount } from '../components/display-format.js';
import {
  explainedFailure,
  isExplainedFailure,
  validateDatasetId,
  validateDatasetSummary
} from '../../../data/data-source.js';
import { getProviderRegistry } from '../../../data/sources/registry.js';
import { probeRemoteServer, validateRemoteServerUrl } from '../../../data/remote-source.js';
import { filePickerAccept, folderMarkersOf, openableNamePhrases } from '../../../data/input-formats.js';
import { routeAddress } from './address-routing.js';
import { initOpenDataMenu } from './open-data-menu.js';
import { getNotificationCenter } from '../../notification-center.js';
import { beginOpening } from '../../../data/opening-progress.js';
import { DATA_LOAD_METHODS } from '../../data-load-methods.js';
import { analytics } from '../../optional-analytics.js';
import { debug } from '../../../utils/debug.js';
import { initDatasetDrop, localFileLayout } from './dataset-drop.js';
import {
  createDatasetReloadSupersededError,
  isDatasetReloadSupersededError
} from '../../dataset-reload-outcome.js';

const CONNECTION_OPTION_KEYS = Object.freeze([
  'clearDataset',
  'dataSourceManager',
  'datasetIntents',
  'dom',
  'noneDatasetValue',
  'populateDatasetDropdown'
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return Object.getPrototypeOf(value) === Object.prototype;
}

function requireExactOptions(options) {
  if (!isPlainObject(options)) {
    throw new TypeError('Dataset connections options must be a plain object.');
  }
  const ownKeys = Reflect.ownKeys(options);
  if (
    ownKeys.some(key => typeof key !== 'string') ||
    ownKeys.some(key => {
      const descriptor = Object.getOwnPropertyDescriptor(options, key);
      return (
        descriptor === undefined ||
        descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value')
      );
    })
  ) {
    throw new TypeError(
      'Dataset connections options must use enumerable own data fields.'
    );
  }
  const actual = ownKeys.sort();
  const expected = [...CONNECTION_OPTION_KEYS].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(
      `Dataset connections options must contain exactly: ` +
      `${expected.join(', ')}.`
    );
  }
}

function requireFunction(value, label) {
  if (typeof value !== 'function') {
    throw new TypeError(`${label} must be a function.`);
  }
  return value;
}

function requireMethod(owner, method, label) {
  if (
    owner === null ||
    typeof owner !== 'object' ||
    typeof owner[method] !== 'function'
  ) {
    throw new TypeError(`${label} must implement ${method}().`);
  }
}

function requireSource(source, sourceType, label) {
  for (const method of [
    'connect',
    'createConnectionCandidate',
    'disconnect',
    'getConnectionInfo',
    'getType',
    'listDatasets'
  ]) {
    requireMethod(source, method, label);
  }
  if (source.getType() !== sourceType) {
    throw new TypeError(`${label} must own source type "${sourceType}".`);
  }
  return source;
}

function requireControlGroup(dom, keys, label) {
  const values = keys.map(key => dom[key]);
  const present = values.filter(value => value !== undefined).length;
  if (present === 0) return null;
  if (present !== keys.length) {
    throw new TypeError(
      `${label} controls must provide together: ${keys.join(', ')}.`
    );
  }
  for (const [index, value] of values.entries()) {
    if (value === null || typeof value !== 'object') {
      throw new TypeError(`${label} ${keys[index]} must be a DOM element.`);
    }
  }
  return Object.fromEntries(keys.map((key, index) => [key, values[index]]));
}

function requireDatasetInventory(value, sourceType) {
  if (!Array.isArray(value)) {
    throw new TypeError(
      `${sourceType} connection must publish a dataset array.`
    );
  }
  const seen = new Set();
  return value.map((metadata, index) => {
    if (
      metadata === null ||
      typeof metadata !== 'object' ||
      Array.isArray(metadata)
    ) {
      throw new TypeError(
        `${sourceType} dataset ${index} must be metadata.`
      );
    }
    const id = validateDatasetId(
      metadata.id,
      `${sourceType} dataset ${index} id`
    );
    if (seen.has(id)) {
      throw new TypeError(
        `${sourceType} connection published duplicate dataset id "${id}".`
      );
    }
    validateDatasetSummary(metadata, sourceType);
    seen.add(id);
    return metadata;
  });
}

/**
 * The causes a data-source failure can be told apart into, and what each one
 * asks the user to do next.
 *
 * The loader already publishes the difference: `DataSourceError` carries a
 * `code`, and a transport failure carries the HTTP status the server answered
 * with. Everything below is read from those fields — nothing is inferred from
 * an error message, because message text is engine-specific and a UI that
 * sniffed it would be guessing.
 *
 * `unreachable` is deliberately one bucket for two causes. A request that never
 * completed (offline, DNS, CORS) and a request whose body was not a Cellucid
 * document both arrive as `NETWORK_ERROR` with no status, and `fetchJson()`
 * discards which of the two it was. Rather than guess, the sentence names both
 * possibilities and asks the user to check both.
 *
 * `too-large` is the row that must not be folded into `unreadable`. A byte
 * ceiling fires on a perfectly valid file that is merely bigger than the
 * browser will take, so "write it again" is the one action guaranteed to fail:
 * the user regenerates a byte-identical file and meets the identical wall.
 * The loader tells the two apart — `TOO_LARGE` is published by whichever
 * ceiling refused — so the UI does not have to guess (CEL-0219).
 */
const DATA_SOURCE_FAILURES = Object.freeze({
  'not-found': Object.freeze({
    cause:
      'nothing is published at that address (the server answered "not '
      + 'found").',
    action: 'Check the address for a typo, then try again.'
  }),
  refused: Object.freeze({
    cause: 'the server refused access.',
    action: 'Check that the data is shared publicly, then try again.'
  }),
  rejected: Object.freeze({
    cause: 'the server rejected the request.',
    action: 'Check the address, then try again.'
  }),
  server: Object.freeze({
    cause: 'the server reported a problem of its own.',
    action: 'Wait a moment, then try again.'
  }),
  'too-large': Object.freeze({
    cause: 'what is published there is larger than Cellucid opens in a browser.',
    action:
      'Serve it with the Cellucid server, or publish a smaller file, then '
      + 'try again.'
  }),
  unreadable: Object.freeze({
    cause: 'what is published there is not in a format Cellucid can read.',
    action: 'Write it again with anndata (or cellucid.prepare), then try again.'
  }),
  unreachable: Object.freeze({
    cause:
      'nothing readable came back — the connection may have failed, or that ' +
      'address may not hold Cellucid data.',
    action: 'Check your network and the address, then try again.'
  })
});

/**
 * What to say when the loader published no cause at all. Naming one anyway
 * would be an invention: an error with no code and no status is as likely to be
 * a broken invariant inside Cellucid as anything on the network.
 */
const UNCLASSIFIED_DATA_SOURCE_ACTION =
  'Try again; if it keeps failing, check the address and your connection.';

/**
 * Name the cause one loader Error stands for, or null when it published none.
 *
 * @param {unknown} error
 * @returns {string|null}
 */
export function classifyDataSourceFailure(error) {
  if (error instanceof AggregateError && error.errors.length > 0) {
    return classifyDataSourceFailure(error.errors[0]);
  }
  if (!(error instanceof Error)) return null;
  const code = typeof error.code === 'string' ? error.code : null;
  if (code === 'NOT_FOUND' || code === 'FILE_NOT_FOUND') return 'not-found';
  if (code === 'PERMISSION_DENIED') return 'refused';
  if (code === 'TOO_LARGE') return 'too-large';
  if (
    code === 'INVALID_FORMAT' ||
    code === 'VALIDATION_ERROR' ||
    code === 'UNSUPPORTED'
  ) {
    return 'unreadable';
  }
  const details = error.details;
  const status =
    details !== null &&
    typeof details === 'object' &&
    Number.isInteger(details.status)
      ? details.status
      : null;
  if (status === null) return code === 'NETWORK_ERROR' ? 'unreachable' : null;
  if (status === 404) return 'not-found';
  if (status === 401 || status === 403) return 'refused';
  if (status >= 500) return 'server';
  if (status >= 400) return 'rejected';
  return 'unreachable';
}

/**
 * One sentence a bench scientist can act on, naming what is wrong and what to
 * do next without quoting a URL, a status line or a compression term.
 *
 * @param {string} subject - Noun phrase for what failed, e.g. `Sample datasets`
 * @param {string} verb - How it failed, e.g. `could not be loaded`
 * @param {unknown} error
 * @returns {string}
 */
export function describeDataSourceFailure(subject, verb, error) {
  if (typeof subject !== 'string' || subject.length === 0) {
    throw new TypeError(
      'Data source failure subject must be a non-empty string.'
    );
  }
  if (typeof verb !== 'string' || verb.length === 0) {
    throw new TypeError('Data source failure verb must be a non-empty string.');
  }
  // A failure written for the person (a link naming several files, a file
  // with nothing to plot) already says what is wrong and what to do.
  if (isExplainedFailure(error)) {
    return `${subject} could not be opened: ${explainedMessage(error)}`;
  }
  const failure = classifyDataSourceFailure(error);
  if (failure === null) {
    return `${subject} ${verb}. ${UNCLASSIFIED_DATA_SOURCE_ACTION}`;
  }
  const { cause, action } = DATA_SOURCE_FAILURES[failure];
  return `${subject} ${verb}: ${cause} ${action}`;
}

function errorMessage(error) {
  if (error instanceof AggregateError) {
    const causes = error.errors.map(item => errorMessage(item));
    return `${error.message} Causes: ${causes.join('; ')}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The raw text of a failure, for its notification's Details and the console:
 * the notification itself says one sentence (`describeDataSourceFailure`).
 * An unclassified failure is as likely to be a broken invariant inside
 * Cellucid as a transport problem, and then its message is the only evidence
 * anyone has, so it is always kept, never quoted in the sentence.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function dataSourceFailureDetails(error) {
  return errorMessage(error);
}

function explainedMessage(error) {
  return error instanceof AggregateError && error.errors.length > 0
    ? explainedMessage(error.errors[0])
    : error.message;
}

/**
 * A failure said in one sentence for the person, with the error behind it as
 * its cause: the opening's notification shows the sentence and folds the
 * cause under Details.
 *
 * @param {string} sentence
 * @param {unknown} cause
 * @returns {Error}
 */
export function saidFailure(sentence, cause) {
  return explainedFailure(
    sentence,
    typeof cause?.code === 'string' ? cause.code : null,
    null,
    { cause }
  );
}

/**
 * Why a typed remote server address cannot be tried, or null when it can.
 *
 * The source's own validator decides; this only turns its refusal into a
 * sentence that says where the right address comes from.
 *
 * @param {string} value
 * @returns {string|null}
 */
export function describeRemoteAddressProblem(value) {
  try {
    validateRemoteServerUrl(value);
    return null;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    const reason = error.message.charAt(0).toLowerCase() + error.message.slice(1);
    return `The remote server address was not tried: ${reason}. Use the bare `
      + 'address the server prints as Local URL.';
  }
}

/**
 * Why a typed GitHub repository path cannot be tried, or null when it can.
 *
 * @param {string} value
 * @returns {string|null}
 */
export function describeDataLinkProblem(value) {
  try {
    getProviderRegistry().resolve(value);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * The three ways a local dataset arrives (`data/input-formats.js` layouts):
 * one file that is the container itself (an `.h5ad`), a ZIP archive holding a
 * store (a `.zarr.zip`), or a store folder. The file inputs and a drop onto
 * the viewer share them, so a dropped file is read, validated, reported and
 * superseded exactly as a picked one is. What each is is decided by the
 * reader from its content.
 */
const LOCAL_LOADERS = Object.freeze({
  file: Object.freeze({
    loadMethod: DATA_LOAD_METHODS.LOCAL_H5AD,
    load: (source, files) =>
      source.loadFromFile(files.length === 1 ? files[0] : null)
  }),
  zip: Object.freeze({
    loadMethod: DATA_LOAD_METHODS.LOCAL_ZARR_ZIP,
    load: (source, files) =>
      source.loadFromFile(files.length === 1 ? files[0] : null)
  }),
  folder: Object.freeze({
    loadMethod: DATA_LOAD_METHODS.LOCAL_ZARR_FOLDER,
    load: (source, files) => source.loadFromFolder(files)
  })
});

/**
 * What File… opens and what Zarr folder… is for, from the registry: "Choose
 * an .h5ad file or a .zarr.zip archive, or choose Zarr folder… for a .zarr
 * folder."
 *
 * @returns {string}
 */
function describePickableFiles() {
  const phrases = openableNamePhrases();
  const folders = phrases.filter(phrase => phrase.endsWith(' folder'));
  const files = phrases.filter(phrase => !phrase.endsWith(' folder'));
  const article = phrase => (/^\.[aeiouh]/i.test(phrase) ? 'an' : 'a');
  return `Choose ${files.map(phrase => `${article(phrase)} ${phrase}`).join(' or ')}, ` +
    `or choose Zarr folder… for ${folders.map(phrase => `a ${phrase}`).join(' or ')}.`;
}

/**
 * What a local choice is called while it is being read: the file, or the
 * folder a Zarr store was chosen as.
 *
 * @param {FileList|File[]} files
 * @returns {string}
 */
function describeLocalSelection(files) {
  const first = files[0];
  const relativePath = typeof first?.webkitRelativePath === 'string'
    ? first.webkitRelativePath
    : '';
  if (relativePath.includes('/')) return relativePath.split('/')[0];
  return typeof first?.name === 'string' && first.name.length > 0
    ? first.name
    : 'your data';
}

/**
 * An address as the connection line shows it: `localhost:8777`,
 * `theislab.github.io/…/catalog/`; text that is not a web address (`hf:…`,
 * `GSE123456`) is shown as it is.
 *
 * @param {string} address
 * @returns {string}
 */
export function shortAddress(address) {
  let url;
  try {
    url = new URL(address);
  } catch {
    return address;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return address;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length === 0) return url.host;
  const last = `${parts.at(-1)}${url.pathname.endsWith('/') ? '/' : ''}`;
  return parts.length === 1 ? `${url.host}/${last}` : `${url.host}/…/${last}`;
}

/**
 * Why a folder picked with the folder dialog cannot be a Zarr store although
 * it may be one, or null. A Zarr v2 store keeps its metadata in files whose
 * names start with "." (`.zgroup`, `.zattrs`, `.zarray`, `.zmetadata`), and
 * some browsers' folder dialogs (Safari's) leave every such file out. A
 * listing with no hidden file at all and no Zarr v3 `zarr.json` is that
 * case: the same folder dropped on the page, or zipped, is read whole.
 *
 * @param {ArrayLike<File>} files - As the folder input lists them
 * @returns {string|null}
 */
export function describeHiddenMetadataProblem(files) {
  const paths = Array.from(files, file => (
    typeof file?.webkitRelativePath === 'string' && file.webkitRelativePath !== ''
      ? file.webkitRelativePath
      : String(file?.name ?? '')
  ));
  const hasHidden = paths.some(path => path.split('/').some(part => part.startsWith('.')));
  // A Zarr v3 store's metadata (`zarr.json`) is not hidden.
  const visibleMarkers = folderMarkersOf('zarr').filter(marker => !marker.startsWith('.'));
  const hasVisibleMarker = paths.some(path => visibleMarkers.includes(path.split('/').at(-1)));
  if (paths.length === 0 || hasHidden || hasVisibleMarker) return null;
  return 'This browser left out the folder\'s hidden files (names starting with "."), '
    + 'where a Zarr v2 store keeps its metadata. Drag the folder onto the page, '
    + 'or open its .zarr.zip.';
}

/**
 * @param {Object} options
 * @param {() => Promise<boolean>} options.clearDataset
 * @param {Object} options.dataSourceManager
 * @param {{
 *   activate: (intent: Object, datasetId: string, sourceType: string,
 *     loadMethod: string, source: Object) => Promise<boolean>,
 *   actionSequence: () => number,
 *   begin: (pending: {value: string|null, label: string}) => Object,
 *   beginIfNoActionSince: (sequence: number,
 *     pending: {value: string|null, label: string}) => Object|null,
 *   owns: (intent: Object) => boolean,
 *   settle: (intent: Object) => void,
 *   settled: () => boolean,
 *   whenSettled: () => Promise<void>
 * }} options.datasetIntents The dataset controls' intent owner: every
 *   dataset change made here is one of its intents.
 * @param {Object} options.dom
 * @param {string} options.noneDatasetValue
 * @param {() => Promise<boolean>} options.populateDatasetDropdown
 */
export function initDatasetConnections(options) {
  requireExactOptions(options);
  const {
    clearDataset,
    dataSourceManager,
    datasetIntents,
    dom,
    noneDatasetValue,
    populateDatasetDropdown
  } = options;
  if (datasetIntents === null || typeof datasetIntents !== 'object') {
    throw new TypeError('Dataset connections require the dataset intent owner.');
  }
  for (const method of [
    'actionSequence',
    'activate',
    'begin',
    'beginIfNoActionSince',
    'owns',
    'settle',
    'settled',
    'whenSettled'
  ]) {
    requireMethod(datasetIntents, method, 'Dataset intent owner');
  }
  requireFunction(clearDataset, 'Dataset clear owner');
  requireFunction(
    populateDatasetDropdown,
    'Dataset catalog population owner'
  );
  if (!isPlainObject(dom)) {
    throw new TypeError('Dataset connections DOM must be a plain object.');
  }
  validateDatasetId(noneDatasetValue, 'None dataset control value');
  for (const method of [
    'getCurrentSourceType',
    'getSource',
    'registerSource',
    'unregisterSource'
  ]) {
    requireMethod(
      dataSourceManager,
      method,
      'Dataset connections dataSourceManager'
    );
  }

  const notifications = getNotificationCenter();
  const datasetSelect = dom.select;
  if (
    datasetSelect === null ||
    typeof datasetSelect !== 'object' ||
    typeof datasetSelect.focus !== 'function'
  ) {
    throw new TypeError(
      'Dataset connections select must be a focusable DOM element.'
    );
  }
  const lifecycleController = new AbortController();
  const activeOperations = new Set();
  /** Openings this module began, ended with it (`data/opening-progress.js`). */
  const activeOpenings = new Set();
  const connectionLossCleanups = new Set();
  const connectionLossCleanupBySource = new Map();
  const operationInvalidators = new Set();
  let destroyed = false;
  let destroyPromise = null;

  function assertAlive() {
    if (destroyed) {
      throw createDatasetReloadSupersededError(
        'Dataset connection controls were destroyed.'
      );
    }
  }

  function trackOperation(work) {
    const promise = Promise.resolve(work);
    activeOperations.add(promise);
    const retire = () => activeOperations.delete(promise);
    promise.then(retire, retire);
    return promise;
  }

  function launchOperation(operation, label) {
    let work;
    try {
      work = operation();
    } catch (error) {
      work = Promise.reject(error);
    }
    const promise = trackOperation(work);
    void promise.catch(error => {
      if (destroyed || isDatasetReloadSupersededError(error)) return;
      debug.error(`[UI] ${label}: ${errorMessage(error)}`, error);
    });
    return promise;
  }

  function listen(target, eventName, listener) {
    requireMethod(target, 'addEventListener', 'Dataset connection control');
    const guardedListener = (...args) => {
      if (destroyed) return;
      return listener(...args);
    };
    target.addEventListener(eventName, guardedListener, {
      signal: lifecycleController.signal
    });
  }

  // Every data-source control ships disabled in `index.html`, because until
  // this module has attached its listeners a click on one is discarded without
  // a request, a message or a trace. A control is admitted only once the
  // listener that acts on it exists, and every admitted control is retired
  // again when those listeners are aborted.
  const admittedControls = new Set();

  function admitControls(...controls) {
    for (const control of controls) {
      if (control === null || typeof control !== 'object') {
        throw new TypeError(
          'A wired dataset connection control must be a DOM element.'
        );
      }
      admittedControls.add(control);
      control.disabled = false;
    }
  }

  function retireAdmittedControls() {
    for (const control of admittedControls) control.disabled = true;
    admittedControls.clear();
  }

  /**
   * What is opened is shown from the first moment by the opening progress
   * (the startup overlay, or a notification with Cancel); the source and the
   * dataset change that read it join this opening.
   */
  function beginShownOpening(title, onCancel) {
    assertAlive();
    const opening = beginOpening({ title, onCancel });
    activeOpenings.add(opening);
    return opening;
  }

  /**
   * End it: `complete` with what was opened (a sentence), `fail` with why:
   * a sentence of its own, or the error (`saidFailure` for a sentence with
   * the error behind it), which the opening's notification shortens.
   */
  function settleShownOpening(method, opening, outcome) {
    if (destroyed) return;
    activeOpenings.delete(opening);
    if (method === 'complete') opening.end(outcome);
    else opening.fail(outcome);
  }

  /** End it with nothing to say: superseded, or explained where it failed. */
  function dismissShownOpening(opening) {
    activeOpenings.delete(opening);
    opening.dismiss();
  }

  function detachConnectionLoss(source) {
    const cleanup = connectionLossCleanupBySource.get(source);
    if (cleanup !== undefined) cleanup();
  }

  async function populate() {
    assertAlive();
    const outcome = await populateDatasetDropdown();
    assertAlive();
    if (!isPlainObject(outcome)) {
      throw new TypeError(
        'Dataset catalog population must publish one exact outcome.'
      );
    }
    const keys = Reflect.ownKeys(outcome);
    if (
      outcome.status === 'ready' &&
      keys.length === 1 &&
      keys[0] === 'status'
    ) {
      return;
    }
    if (
      outcome.status === 'superseded' &&
      keys.length === 1 &&
      keys[0] === 'status'
    ) {
      throw createDatasetReloadSupersededError(
        'Dataset catalog publication was superseded.'
      );
    }
    if (
      outcome.status === 'failed' &&
      keys.length === 2 &&
      keys.includes('error') &&
      keys.includes('status') &&
      outcome.error instanceof Error
    ) {
      throw outcome.error;
    }
    throw new TypeError(
      'Dataset catalog population published a malformed outcome.'
    );
  }

  /**
   * A file or folder is a dataset change from the moment it is chosen. Its
   * intent is begun before the file is read, so the load in flight stops at
   * once, the select shows what is being opened, and a choice made while the
   * file is still being read replaces it instead of being overwritten by it
   * when the read finishes.
   */
  /**
   * @param {{label: string, readFiles: () => Promise<ArrayLike<File>>}} selection
   *   `label` names the choice while it is read; `readFiles` yields its files,
   *   and runs under the choice's own intent (a dropped folder is listed
   *   there).
   * @param {{loadMethod: string,
   *   load: (source: Object, files: ArrayLike<File>) => Promise<Object>}} loader
   */
  async function loadLocalUserSelection(selection, loader) {
    const intent = datasetIntents.begin({
      label: `Opening ${selection.label}…`,
      value: null
    });
    try {
      await loadLocalUserSelectionForIntent(intent, selection, loader);
    } finally {
      datasetIntents.settle(intent);
    }
  }

  /** A choice made with one of the file inputs. */
  function pickedSelection(files) {
    return Object.freeze({
      label: describeLocalSelection(files),
      readFiles: async () => files
    });
  }

  async function loadLocalUserSelectionForIntent(
    intent,
    { label, readFiles },
    { loadMethod, load }
  ) {
    const assertCurrentSelection = () => {
      if (destroyed || !datasetIntents.owns(intent)) {
        throw createDatasetReloadSupersededError(
          'Local dataset selection was superseded.'
        );
      }
    };

    const registeredSource = dataSourceManager.getSource('local-user');
    if (registeredSource === null) {
      notifications.error('User data source is not available.', {
        category: 'data'
      });
      return;
    }
    for (const method of [
      'createSelectionCandidate',
      'disconnect',
      'getType'
    ]) {
      requireMethod(
        registeredSource,
        method,
        'Registered local-user source'
      );
    }
    const userSource = registeredSource.createSelectionCandidate();
    if (
      userSource === registeredSource ||
      userSource === null ||
      typeof userSource !== 'object' ||
      userSource.getType() !== 'local-user' ||
      typeof userSource.disconnect !== 'function'
    ) {
      throw new TypeError(
        'Local-user selection candidate must be one isolated local-user source.'
      );
    }
    // The activation joins this request, so a file that cannot be read is
    // reported as a failed load too, and the duration includes reading it.
    const dataLoad = analytics.openDataLoad(loadMethod, 'local-user');
    const localOpening = beginShownOpening(label, () => userSource.disconnect());
    // A newer dataset choice cancels the read itself, not only its result:
    // the candidate's disconnect retires a parsed file instead of adopting
    // it, and the read's progress
    // leaves the screen at once rather than when the read gets round to
    // noticing.
    const cancelRead = () => {
      userSource.disconnect();
      if (destroyed) return;
      dismissShownOpening(localOpening);
    };
    intent.transaction.signal.addEventListener('abort', cancelRead, {
      once: true
    });
    let candidatePublished = false;
    try {
      let metadata;
      try {
        const files = await readFiles();
        assertCurrentSelection();
        metadata = await load(userSource, files);
      } finally {
        intent.transaction.signal.removeEventListener('abort', cancelRead);
      }
      assertCurrentSelection();
      const ready = await datasetIntents.activate(
        intent,
        userSource.datasetId,
        'local-user',
        loadMethod,
        userSource
      );
      // The activation settled the request it joined; this closes it when the
      // selection was already current and nothing was activated.
      dataLoad.cancel();
      assertCurrentSelection();
      if (ready !== true) {
        // The activation has already explained its failure next to the
        // dataset select; a second toast would repeat it.
        userSource.disconnect();
        dismissShownOpening(localOpening);
        return;
      }
      if (dataSourceManager.getSource('local-user') !== userSource) {
        throw new Error(
          'Local-user activation did not adopt its isolated source candidate.'
        );
      }
      candidatePublished = true;
      await populate();
      assertCurrentSelection();
      settleShownOpening(
        'complete',
        localOpening,
        `User data ready: ${formatCompactCount(metadata.stats.n_cells)} cells`
      );
    } catch (error) {
      if (destroyed) {
        dataLoad.cancel();
        const adopted =
          dataSourceManager.getSource('local-user') === userSource;
        if (!candidatePublished && !adopted) userSource.disconnect();
        return;
      }
      if (isDatasetReloadSupersededError(error)) {
        dataLoad.cancel();
        // A candidate the activation already registered is the live
        // dataset's source until the newer choice replaces it, which retires
        // it then.
        const adopted =
          dataSourceManager.getSource('local-user') === userSource;
        if (!candidatePublished && !adopted) userSource.disconnect();
        dismissShownOpening(localOpening);
        return;
      }
      dataLoad.fail(error);
      if (!candidatePublished) userSource.disconnect();
      debug.error(`[UI] Failed to load user data: ${errorMessage(error)}`, error);
      settleShownOpening('fail', localOpening, error);
    }
  }

  // One "Open…" button with a File… / Zarr folder… menu: a browser's dialog
  // picks files or one folder, never both. What was picked decides how it is
  // read.
  const openMenu = requireControlGroup(
    dom,
    [
      'userDataOpenBtn',
      'userDataOpenMenu',
      'userDataFileItem',
      'userDataFolderItem',
      'userDataFileInput',
      'userDataFolderInput'
    ],
    'Open file or folder'
  );
  if (openMenu !== null) {
    const {
      userDataOpenBtn,
      userDataOpenMenu,
      userDataFileItem,
      userDataFolderItem,
      userDataFileInput,
      userDataFolderInput
    } = openMenu;
    // File… offers every single-file format the registry names.
    userDataFileInput.accept = filePickerAccept();
    initOpenDataMenu({
      button: userDataOpenBtn,
      menu: userDataOpenMenu,
      items: [userDataFileItem, userDataFolderItem],
      onChoose: item => {
        if (destroyed) return;
        (item === userDataFolderItem ? userDataFolderInput : userDataFileInput).click();
      },
      signal: lifecycleController.signal
    });
    listen(userDataFileInput, 'change', event => {
      const files = event.target.files;
      if (!files || files.length === 0) return undefined;
      const layout = localFileLayout(files[0]);
      if (layout === null) {
        notifications.error(
          `"${files[0].name}" is not a file Cellucid can open. ${describePickableFiles()}`,
          { category: 'data', title: 'Cannot open this file' }
        );
        userDataFileInput.value = '';
        return undefined;
      }
      return launchOperation(async () => {
        await loadLocalUserSelection(pickedSelection(files), LOCAL_LOADERS[layout]);
        if (!destroyed) userDataFileInput.value = '';
      }, 'File selection failed');
    });
    listen(userDataFolderInput, 'change', event => {
      const files = event.target.files;
      if (!files || files.length === 0) return undefined;
      const hidden = describeHiddenMetadataProblem(files);
      if (hidden !== null) {
        notifications.error(hidden, {
          category: 'data',
          title: 'Cannot open this folder'
        });
        userDataFolderInput.value = '';
        return undefined;
      }
      return launchOperation(async () => {
        await loadLocalUserSelection(
          pickedSelection(files),
          LOCAL_LOADERS.folder
        );
        if (!destroyed) userDataFolderInput.value = '';
      }, 'Zarr folder selection failed');
    });
    admitControls(
      userDataOpenBtn,
      userDataFileItem,
      userDataFolderItem,
      userDataFileInput,
      userDataFolderInput
    );
  }

  // A file or folder dropped onto the viewer is one more way to make the same
  // three local choices, so it goes through the same intent and reader.
  const datasetDrop = requireControlGroup(
    dom,
    ['datasetDropOverlay'],
    'Dataset drop'
  );
  const retireDatasetDrop = datasetDrop === null
    ? null
    : initDatasetDrop({
        documentOwner: datasetSelect.ownerDocument,
        overlay: datasetDrop.datasetDropOverlay,
        openDataset: drop => {
          if (destroyed) return;
          void launchOperation(
            () => loadLocalUserSelection(
              { label: drop.label, readFiles: drop.readFiles },
              LOCAL_LOADERS[drop.kind]
            ),
            'Dropped dataset failed'
          );
        },
        refuse: message => {
          if (destroyed) return;
          notifications.error(message, {
            category: 'data',
            title: 'Cannot open the dropped item'
          });
        }
      });

  /** @type {Map<string, (value: string) => Promise<boolean>>} */
  const openers = new Map();
  /**
   * The address bar's way into each connection, by source type:
   * `request(value)` opens `value` as if it had been typed.
   * @type {Map<string, {request: (value: string, loadMethod?: string) => Promise<void>}>}
   */
  const connectors = new Map();
  // Connection operations still running; the address bar's Open waits for
  // none of them, but is not offered twice at once.
  let busyOperations = 0;
  let addressOpenButton = null;
  let addressInputElement = null;

  function setBusy(delta) {
    busyOperations += delta;
    if (addressOpenButton !== null && !destroyed) {
      addressOpenButton.disabled = busyOperations > 0;
    }
  }

  function wireConnection(config) {
    const {
      connectionTarget,
      describeInputProblem,
      disconnectButton,
      disconnectContainer,
      emptyInputMessage,
      failureSubject,
      failureVerb,
      inputLabel,
      loadMethod,
      sourceType
    } = config;
    let source = requireSource(
      dataSourceManager.getSource(sourceType),
      sourceType,
      `${inputLabel} registered source`
    );
    let recoveryBlocked = false;
    let operationRevision = 0;
    operationInvalidators.add(() => {
      operationRevision =
        operationRevision === Number.MAX_SAFE_INTEGER
          ? 1
          : operationRevision + 1;
    });

    function assertCurrentOperation(revision) {
      if (destroyed || revision !== operationRevision) {
        throw createDatasetReloadSupersededError(
          `${inputLabel} operation was superseded.`
        );
      }
    }

    function sourceConnected(candidate) {
      const info = candidate.getConnectionInfo();
      if (info === null || typeof info !== 'object') {
        throw new TypeError(
          `${inputLabel} source must publish connection information.`
        );
      }
      if (sourceType === 'remote') {
        return info.status === 'connected';
      }
      return info.connected === true;
    }

    function sourceInputValue(candidate) {
      const info = candidate.getConnectionInfo();
      return sourceType === 'remote' ? info.url : info.inputPath;
    }

    /**
     * Show whether this source is connected, and to what, under the address
     * bar, with its Disconnect.
     */
    function updateConnectionUI(connected) {
      assertAlive();
      if (typeof connected !== 'boolean') {
        throw new TypeError(
          `${inputLabel} UI state must be a boolean.`
        );
      }
      disconnectContainer.hidden = !connected;
      const target = connected ? sourceInputValue(source) : '';
      // One short line: the host and the last part of the path; the whole
      // address is the title and stays in the address bar.
      connectionTarget.textContent = shortAddress(target);
      connectionTarget.title = target;
    }

    function createCandidate() {
      const candidate = source.createConnectionCandidate();
      if (candidate === source) {
        throw new Error(
          `${inputLabel} connection candidate must be isolated.`
        );
      }
      return requireSource(
        candidate,
        sourceType,
        `${inputLabel} connection candidate`
      );
    }

    async function restorePriorSource(priorSource, candidate, revision) {
      assertCurrentOperation(revision);
      if (dataSourceManager.getSource(sourceType) === candidate) {
        dataSourceManager.registerSource(sourceType, priorSource);
        await populate();
        assertCurrentOperation(revision);
      }
      source = priorSource;
      updateConnectionUI(sourceConnected(priorSource));
    }

    async function adoptMultipleCandidate(
      priorSource,
      candidate,
      datasets,
      revision
    ) {
      assertCurrentOperation(revision);
      dataSourceManager.registerSource(sourceType, candidate);
      try {
        await populate();
        assertCurrentOperation(revision);
      } catch (error) {
        if (destroyed) throw error;
        if (dataSourceManager.getSource(sourceType) === candidate) {
          dataSourceManager.registerSource(sourceType, priorSource);
          await populate();
          assertCurrentOperation(revision);
        }
        throw error;
      }
      source = candidate;
      updateConnectionUI(true);
      datasetSelect.disabled = false;
      datasetSelect.focus();
      let cleanupError = null;
      try {
        detachConnectionLoss(priorSource);
        priorSource.disconnect();
      } catch (error) {
        cleanupError = error;
      }
      return {
        cleanupError,
        count: datasets.length
      };
    }

    async function recoverConnectionLoss(lostSource, error, notice) {
      if (dataSourceManager.getSource(sourceType) !== lostSource) return;
      const revision = ++operationRevision;
      disconnectButton.disabled = true;
      // Said at once: recovery may wait for a newer choice to settle, and the
      // loss must not wait with it. The same notice is completed below.
      notice.id = notifications.error(
        `${inputLabel} connection was lost.`,
        {
          category: 'connectivity',
          title: 'Connection lost',
          duration: 0
        }
      );
      // Recovery clears only the dataset it lost, and only once nothing the
      // user chose is still loading: a newer choice in flight replaces the
      // lost dataset itself, and clearing now would supersede that choice.
      // Should the newer choice fail, the lost dataset is still on screen
      // and is cleared then.
      while (dataSourceManager.getCurrentSourceType() === sourceType) {
        if (!datasetIntents.settled()) {
          await datasetIntents.whenSettled();
          assertCurrentOperation(revision);
          continue;
        }
        let cleared;
        try {
          cleared = await clearDataset();
        } catch (clearError) {
          // A choice the user made while the clear ran owns the dataset now.
          if (destroyed || !isDatasetReloadSupersededError(clearError)) {
            throw clearError;
          }
          assertCurrentOperation(revision);
          continue;
        }
        assertCurrentOperation(revision);
        if (cleared !== true) {
          recoveryBlocked = true;
          notifications.error(
            `${inputLabel} connection was lost and the active dataset could ` +
            `not be cleared safely. Reload the page before reconnecting. ` +
            `Cause: ${errorMessage(error)}`,
            {
              id: notice.id,
              category: 'connectivity',
              duration: 0,
              title: 'Connection recovery blocked'
            }
          );
          return;
        }
      }

      assertCurrentOperation(revision);
      detachConnectionLoss(lostSource);
      lostSource.disconnect();
      dataSourceManager.unregisterSource(sourceType);
      const disconnectedSource = lostSource.createConnectionCandidate();
      requireSource(
        disconnectedSource,
        sourceType,
        `${inputLabel} disconnected replacement`
      );
      dataSourceManager.registerSource(sourceType, disconnectedSource);
      source = disconnectedSource;
      await populate();
      assertCurrentOperation(revision);
      updateConnectionUI(false);
      disconnectButton.disabled = false;
      notifications.error(
        `${inputLabel} connection was lost. Open its address again to continue.`,
        {
          id: notice.id,
          category: 'connectivity',
          title: 'Connection lost',
          duration: 0
        }
      );
    }

    function attachConnectionLoss(candidate) {
      if (sourceType !== 'remote') return;
      if (connectionLossCleanupBySource.has(candidate)) return;
      requireMethod(
        candidate,
        'onConnectionLost',
        'Remote connection source'
      );
      const handleConnectionLost = error => {
        launchOperation(async () => {
          const notice = { id: undefined };
          try {
            await recoverConnectionLoss(candidate, error, notice);
          } catch (recoveryError) {
            if (
              destroyed ||
              isDatasetReloadSupersededError(recoveryError)
            ) {
              return;
            }
            recoveryBlocked = true;
            disconnectButton.disabled = true;
            notifications.error(
              `Remote connection recovery failed: ` +
              `${errorMessage(recoveryError)}. Reload the page before reconnecting.`,
              {
                // Completes the loss notice when recovery got that far.
                ...(notice.id === undefined ? {} : { id: notice.id }),
                category: 'connectivity',
                duration: 0,
                title: 'Connection recovery blocked'
              }
            );
          }
        }, 'Remote connection recovery rejected');
      };
      candidate.onConnectionLost(handleConnectionLost);
      const cleanup = () => {
        if (typeof candidate.offConnectionLost === 'function') {
          candidate.offConnectionLost(handleConnectionLost);
        }
        connectionLossCleanupBySource.delete(candidate);
        connectionLossCleanups.delete(cleanup);
      };
      connectionLossCleanupBySource.set(candidate, cleanup);
      connectionLossCleanups.add(cleanup);
    }

    attachConnectionLoss(source);

    /**
     * @param {string} inputValue
     * @param {string} [clickLoadMethod]
     * @param {{supersede?: boolean}} [options] - `supersede`: the dataset on
     *   screen may come from this kind of source; the new connection replaces
     *   it only once its own dataset is ready, and on failure or Cancel it
     *   stays.
     */
    async function handleConnect(inputValue, clickLoadMethod = loadMethod, { supersede = false } = {}) {
      if (recoveryBlocked) {
        notifications.error(
          `${inputLabel} cannot be opened again until the page is reloaded.`,
          { category: 'connectivity' }
        );
        return;
      }
      const replacesShown = dataSourceManager.getCurrentSourceType() === sourceType;
      if (replacesShown && !supersede) {
        notifications.error(
          `${inputLabel} is the active dataset source. Disconnect it before reconnecting.`,
          { category: 'connectivity' }
        );
        return;
      }
      if (typeof inputValue !== 'string' || inputValue.trim().length === 0) {
        notifications.error(emptyInputMessage, { category: 'connectivity' });
        return;
      }
      // An address the source would refuse unread is a typing problem, not a
      // connection failure: say what is wrong with it and do not start a
      // connection whose failure would be reported as if the data were at
      // fault ("not in a format Cellucid can read ... write it again").
      const inputProblem = describeInputProblem(inputValue);
      if (inputProblem !== null) {
        notifications.error(inputProblem, { category: 'connectivity' });
        return;
      }

      const priorSource = source;
      const revision = ++operationRevision;
      // Connecting changes the dataset only if the server holds exactly one,
      // which is not known until it answers. So the click begins no dataset
      // change; it records the user's last action, and the activation later
      // replaces only loads that were already running then — never a choice
      // made or a session applied while it connected.
      const clickAction = datasetIntents.actionSequence();
      // A one-dataset connection's activation joins this request; a
      // connection that only lists datasets loads none and is canceled.
      const dataLoad = analytics.openDataLoad(clickLoadMethod, sourceType);
      // Cancel ends this connection as a newer one would: what it opened
      // is released, and the source on screen stays.
      const connectOpening = beginShownOpening(inputValue, () => {
        if (revision === operationRevision) operationRevision += 1;
      });
      setBusy(1);
      let candidate = null;
      let candidateDisconnectAttempted = false;
      let candidatePublished = false;

      function disconnectCandidateOnce() {
        if (
          candidate === null ||
          candidatePublished ||
          candidateDisconnectAttempted
        ) {
          return null;
        }
        candidateDisconnectAttempted = true;
        try {
          detachConnectionLoss(candidate);
          candidate.disconnect();
          return null;
        } catch (error) {
          return error;
        }
      }

      try {
        candidate = createCandidate();
        const connection = sourceType === 'remote'
          ? await candidate.connect({ url: inputValue })
          : await candidate.connect(inputValue);
        assertCurrentOperation(revision);
        if (!sourceConnected(candidate)) {
          throw new Error(
            `${inputLabel} source did not publish a connected state.`
          );
        }
        const datasets = requireDatasetInventory(
          await candidate.listDatasets(),
          sourceType
        );
        assertCurrentOperation(revision);
        if (datasets.length === 0) {
          dataLoad.cancel();
          const cleanupError = disconnectCandidateOnce();
          if (cleanupError !== null) throw cleanupError;
          updateConnectionUI(sourceConnected(priorSource));
          settleShownOpening(
            'fail',
            connectOpening,
            `Connected ${inputLabel} has no datasets. Add an AnnData file and reconnect.`
          );
          return;
        }

        attachConnectionLoss(candidate);
        // One dataset is opened. A catalog of several is only listed, unless
        // the dataset on screen comes from this kind of source: its slot is
        // the new connection's, so the catalog's default dataset replaces it
        // (the others stay one choice away in the dataset list).
        const defaultId = typeof connection?.defaultDatasetId === 'string'
          ? connection.defaultDatasetId
          : null;
        const opened = datasets.length === 1
          ? datasets[0]
          : replacesShown
            ? datasets.find(dataset => dataset.id === defaultId) ?? datasets[0]
            : null;
        const activationIntent = opened !== null
          ? datasetIntents.beginIfNoActionSince(clickAction, {
              label: `Loading ${opened.name}…`,
              value: null
            })
          : null;
        if (activationIntent !== null) {
          let ready = null;
          try {
            ready = await datasetIntents.activate(
              activationIntent,
              opened.id,
              sourceType,
              clickLoadMethod,
              candidate
            );
          } catch (error) {
            // A choice made while the dataset loaded replaced it. The
            // connection itself still succeeded and is kept below.
            if (!isDatasetReloadSupersededError(error) || destroyed) {
              throw error;
            }
          } finally {
            datasetIntents.settle(activationIntent);
          }
          // Settled by the activation that joined it; closed otherwise.
          dataLoad.cancel();
          assertCurrentOperation(revision);
          if (ready === false) {
            // The activation explained its failure next to the dataset
            // select; the connection is not adopted and says nothing more.
            disconnectCandidateOnce();
            updateConnectionUI(sourceConnected(priorSource));
            dismissShownOpening(connectOpening);
            return;
          }
          // Published — and possibly replaced since by a newer choice — so
          // the activation transaction registered the candidate and
          // finalized the displaced transport exactly once.
          const published =
            dataSourceManager.getSource(sourceType) === candidate;
          if (ready === true && !published) {
            throw new Error(
              `${inputLabel} activation did not adopt its connection candidate.`
            );
          }
          if (published) {
            source = candidate;
            updateConnectionUI(true);
            candidatePublished = true;
            detachConnectionLoss(priorSource);
            await populate();
            assertCurrentOperation(revision);
            settleShownOpening(
              'complete',
              connectOpening,
              ready === true
                ? `Connected - dataset "${opened.name}" loaded`
                : `Connected - "${opened.name}" was not opened because ` +
                  'another dataset was chosen meanwhile. Open the address ' +
                  'again to show it.'
            );
            return;
          }
        }

        // A server listing several datasets — or one whose dataset another
        // choice made during the connection now supersedes — is adopted as a
        // catalog: its datasets are offered in the dataset select.
        dataLoad.cancel();
        const adoption = await adoptMultipleCandidate(
          priorSource,
          candidate,
          datasets,
          revision
        );
        candidatePublished = true;
        if (adoption.cleanupError !== null) {
          settleShownOpening(
            'fail',
            connectOpening,
            saidFailure(
              `Connected - ${adoption.count} datasets found, but the prior ` +
              'connection could not be released.',
              adoption.cleanupError
            )
          );
          return;
        }
        settleShownOpening(
          'complete',
          connectOpening,
          adoption.count === 1
            ? `Connected - "${datasets[0].name}" was not opened because ` +
              'another dataset was chosen meanwhile. Open the address again ' +
              'to show it.'
            : `Connected - ${adoption.count} datasets found. Choose one ` +
              `from the dataset list.`
        );
      } catch (error) {
        if (destroyed) {
          dataLoad.cancel();
          if (
            candidate !== null &&
            dataSourceManager.getSource(sourceType) === candidate
          ) {
            candidatePublished = true;
            source = candidate;
          }
          disconnectCandidateOnce();
          return;
        }
        if (
          !candidatePublished &&
          candidate !== null &&
          dataSourceManager.getSource(sourceType) === candidate &&
          dataSourceManager.getCurrentSourceType() === sourceType
        ) {
          candidatePublished = true;
          source = candidate;
          updateConnectionUI(true);
        }
        if (candidatePublished) {
          settleShownOpening(
            'fail',
            connectOpening,
            saidFailure(
              'Dataset loaded, but the catalog could not be refreshed.',
              error
            )
          );
          debug.error(
            `[UI] ${inputLabel} post-publication catalog error: ${errorMessage(error)}`,
            error
          );
          return;
        }
        const failureErrors = [error];
        if (candidate !== null) {
          if (dataSourceManager.getSource(sourceType) === candidate) {
            // A failed post-registration multi-source adoption is restored;
            // a published one-dataset activation is never rolled back here.
            if (
              dataSourceManager.getCurrentSourceType() !== sourceType
            ) {
              try {
                await restorePriorSource(
                  priorSource,
                  candidate,
                  revision
                );
              } catch (restorationError) {
                failureErrors.push(restorationError);
              }
            }
          }
        }
        const cleanupError = disconnectCandidateOnce();
        if (cleanupError !== null) failureErrors.push(cleanupError);
        if (
          isDatasetReloadSupersededError(error) &&
          failureErrors.length === 1
        ) {
          dataLoad.cancel();
          dismissShownOpening(connectOpening);
          return;
        }
        try {
          updateConnectionUI(sourceConnected(source));
        } catch (uiError) {
          failureErrors.push(uiError);
        }
        const exactError = failureErrors.length === 1
          ? error
          : new AggregateError(
              failureErrors,
              `${inputLabel} connection recovery failed.`
            );
        dataLoad.fail(exactError);
        settleShownOpening(
          'fail',
          connectOpening,
          saidFailure(
            describeDataSourceFailure(failureSubject, failureVerb, exactError),
            exactError
          )
        );
        debug.error(`[UI] ${inputLabel} connection error: ${errorMessage(exactError)}`, exactError);
      } finally {
        setBusy(-1);
      }
    }

    async function handleDisconnectClick() {
      const revision = ++operationRevision;
      const connectedSource = source;
      disconnectButton.disabled = true;
      setBusy(1);
      try {
        const wasActive =
          dataSourceManager.getCurrentSourceType() === sourceType;
        if (wasActive) {
          const cleared = await clearDataset();
          assertCurrentOperation(revision);
          if (cleared !== true) {
            notifications.error(
              `${inputLabel} remains connected because the active dataset could not be cleared.`,
              {
                category: 'connectivity',
                duration: 0,
                title: 'Disconnect blocked'
              }
            );
            return;
          }
        }

        assertCurrentOperation(revision);
        const disconnectedSource =
          connectedSource.createConnectionCandidate();
        requireSource(
          disconnectedSource,
          sourceType,
          `${inputLabel} disconnected replacement`
        );
        detachConnectionLoss(connectedSource);
        connectedSource.disconnect();
        dataSourceManager.unregisterSource(sourceType);
        dataSourceManager.registerSource(sourceType, disconnectedSource);
        source = disconnectedSource;
        updateConnectionUI(false);
        await populate();
        assertCurrentOperation(revision);
        notifications.success(`Disconnected from ${inputLabel}.`, {
          category: 'connectivity'
        });
      } catch (error) {
        if (destroyed) return;
        if (isDatasetReloadSupersededError(error)) return;
        recoveryBlocked = true;
        disconnectButton.disabled = true;
        notifications.error(
          `${inputLabel} disconnect could not finish safely. Reload the ` +
          `page before reconnecting. Cause: ${errorMessage(error)}`,
          {
            category: 'connectivity',
            duration: 0,
            title: 'Disconnect recovery blocked'
          }
        );
        debug.error(`[UI] ${inputLabel} disconnect error: ${errorMessage(error)}`, error);
      } finally {
        setBusy(-1);
        if (
          !destroyed &&
          revision === operationRevision &&
          !recoveryBlocked
        ) {
          disconnectButton.disabled = false;
        }
      }
    }
    listen(disconnectButton, 'click', () => {
      return launchOperation(
        handleDisconnectClick,
        `${inputLabel} disconnect handler rejected`
      );
    });

    /**
     * Connect to `value`. The dataset on screen stays until the new one is
     * ready, which then replaces it, even when it comes from another
     * connection of this kind; on failure or Cancel it stays. Failures are
     * reported by the connect path itself.
     *
     * @returns {Promise<boolean>} Whether `value` is now connected.
     */
    async function open(value, openLoadMethod) {
      assertAlive();
      const connectedTo = () =>
        sourceConnected(source) && sourceInputValue(source) === value;
      if (connectedTo()) return true;
      // The address bar shows what a session (or anything else) opened.
      if (addressInputElement !== null) addressInputElement.value = value;
      await handleConnect(value, openLoadMethod, { supersede: true });
      return !destroyed && connectedTo();
    }
    openers.set(sourceType, value =>
      launchOperation(
        () => open(value, DATA_LOAD_METHODS.SESSION_SOURCE),
        `${inputLabel} open rejected`
      )
    );

    /**
     * Show the dataset of a connection that is still open: it was replaced
     * on screen by another choice, and its address was opened again.
     */
    async function reopenConnected(requestLoadMethod) {
      const datasets = requireDatasetInventory(
        await source.listDatasets(),
        sourceType
      );
      if (datasets.length !== 1) {
        datasetSelect.focus();
        notifications.info(
          `${inputLabel} is open. Choose one of its datasets in the dataset list.`,
          { category: 'connectivity' }
        );
        return;
      }
      const intent = datasetIntents.begin({
        label: `Loading ${datasets[0].name}…`,
        value: null
      });
      try {
        await datasetIntents.activate(
          intent,
          datasets[0].id,
          sourceType,
          requestLoadMethod,
          source
        );
      } catch (error) {
        if (!isDatasetReloadSupersededError(error)) throw error;
      } finally {
        datasetIntents.settle(intent);
      }
    }

    connectors.set(sourceType, Object.freeze({
      /**
       * Open `value` from the address bar: show it again when it is the open
       * connection, else connect to it; what is on screen stays until it is
       * ready.
       */
      async request(value) {
        assertAlive();
        if (recoveryBlocked) {
          notifications.error(
            `${inputLabel} cannot be opened again until the page is reloaded.`,
            { category: 'connectivity' }
          );
          return;
        }
        if (sourceConnected(source) && sourceInputValue(source) === value) {
          if (dataSourceManager.getCurrentSourceType() === sourceType) {
            notifications.info(`${value} is already open.`, { category: 'connectivity' });
            return;
          }
          await reopenConnected(loadMethod);
          return;
        }
        await open(value, loadMethod);
      }
    }));

    updateConnectionUI(sourceConnected(source));
    // `updateConnectionUI` shows the connection; Disconnect has no other
    // owner until an operation runs, so admission is its.
    admitControls(disconnectButton);
    return Object.freeze({
      connectedValue: () => (sourceConnected(source) ? sourceInputValue(source) : null)
    });
  }

  const remote = requireControlGroup(
    dom,
    [
      'remoteDisconnectBtn',
      'remoteDisconnectContainer',
      'remoteConnectionTarget'
    ],
    'Remote'
  );
  const remoteConnection = remote === null
    ? null
    : wireConnection({
        connectionTarget: remote.remoteConnectionTarget,
        describeInputProblem: describeRemoteAddressProblem,
        disconnectButton: remote.remoteDisconnectBtn,
        disconnectContainer: remote.remoteDisconnectContainer,
        emptyInputMessage:
          'Enter a server address, such as localhost:8765, before opening it.',
        failureSubject: 'The Cellucid server',
        failureVerb: 'could not be reached',
        inputLabel: 'Server',
        loadMethod: DATA_LOAD_METHODS.REMOTE_CONNECT,
        sourceType: 'remote'
      });

  const dataLink = requireControlGroup(
    dom,
    [
      'dataLinkDisconnectBtn',
      'dataLinkDisconnectContainer',
      'dataLinkConnectionTarget'
    ],
    'Data link'
  );
  const linkConnection = dataLink === null
    ? null
    : wireConnection({
        connectionTarget: dataLink.dataLinkConnectionTarget,
        describeInputProblem: describeDataLinkProblem,
        disconnectButton: dataLink.dataLinkDisconnectBtn,
        disconnectContainer: dataLink.dataLinkDisconnectContainer,
        emptyInputMessage:
          'Paste a link or an id, such as a CELLxGENE dataset link, GSE123456, '
          + 'or owner/repo/folder, before opening it.',
        failureSubject: 'The linked data',
        failureVerb: 'could not be opened',
        inputLabel: 'Link',
        loadMethod: DATA_LOAD_METHODS.LINK_CONNECT,
        sourceType: 'link'
      });

  // One address bar for a server and for linked data: what is typed decides
  // which (`address-routing.js`).
  const addressBar = requireControlGroup(
    dom,
    ['dataAddressInput', 'dataAddressOpenBtn'],
    'Address bar'
  );
  if (addressBar !== null) {
    const { dataAddressInput, dataAddressOpenBtn } = addressBar;
    addressOpenButton = dataAddressOpenBtn;
    addressInputElement = dataAddressInput;
    const shown = remoteConnection?.connectedValue() ?? linkConnection?.connectedValue() ?? null;
    if (shown !== null && dataAddressInput.value.length === 0) {
      dataAddressInput.value = shown;
    }

    /**
     * Open what the bar holds. A web address the text cannot settle is asked
     * whether it is a Cellucid server before anything is connected.
     */
    async function openAddress() {
      const route = routeAddress(dataAddressInput.value);
      if (route.kind === 'invalid') {
        notifications.error(route.message, { category: 'connectivity' });
        return;
      }
      let kind = route.kind === 'server' ? 'remote' : 'link';
      let value = route.kind === 'server' ? route.url : route.value;
      // Asking the address whether it is a server is the opening's first
      // step: the connection that follows joins this opening, and how the
      // opening ends is that connection's.
      const probe = new AbortController();
      let asking = null;
      if (route.kind === 'ask') {
        asking = beginOpening({
          title: route.value,
          step: 'Checking for a Cellucid server',
          onCancel: () => probe.abort()
        });
        activeOpenings.add(asking);
      }
      try {
        if (route.kind === 'ask') {
          setBusy(1);
          let isServer;
          try {
            isServer = await probeRemoteServer(route.url, {
              signal: AbortSignal.any([lifecycleController.signal, probe.signal])
            });
          } finally {
            setBusy(-1);
          }
          if (destroyed || probe.signal.aborted) return;
          kind = isServer ? 'remote' : 'link';
          value = isServer ? route.url : route.value;
        }
        await openKind(kind, value);
      } catch (error) {
        if (probe.signal.aborted && error?.name === 'AbortError') return;
        throw error;
      } finally {
        if (asking !== null) dismissShownOpening(asking);
      }
    }

    /** Hand one routed address to its connection. */
    async function openKind(kind, value) {
      const connector = connectors.get(kind);
      if (connector === undefined) {
        notifications.error(
          kind === 'remote'
            ? 'This page cannot connect to a Cellucid server.'
            : 'This page cannot open linked data.',
          { category: 'connectivity' }
        );
        return;
      }
      await connector.request(value);
    }

    listen(dataAddressOpenBtn, 'click', () => launchOperation(
      openAddress,
      'Address bar open rejected'
    ));
    listen(dataAddressInput, 'keydown', event => {
      if (event.key !== 'Enter' || event.isComposing) return undefined;
      event.preventDefault();
      if (dataAddressOpenBtn.disabled) return undefined;
      return launchOperation(openAddress, 'Address bar open rejected');
    });
    admitControls(dataAddressInput, dataAddressOpenBtn);
  }

  function destroy() {
    if (destroyPromise !== null) return destroyPromise;
    destroyed = true;
    const cleanupErrors = [];
    try {
      lifecycleController.abort();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      // The listeners are gone, so the controls must stop offering the actions
      // those listeners would have carried out.
      retireAdmittedControls();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      retireDatasetDrop?.();
    } catch (error) {
      cleanupErrors.push(error);
    }
    for (const invalidate of operationInvalidators) {
      try {
        invalidate();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    operationInvalidators.clear();
    for (const cleanup of [...connectionLossCleanups]) {
      try {
        cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const opening of activeOpenings) {
      try {
        opening.dismiss();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    activeOpenings.clear();
    destroyPromise = Promise.allSettled(
      [...activeOperations]
    ).then(() => {
      if (cleanupErrors.length === 1) throw cleanupErrors[0];
      if (cleanupErrors.length > 1) {
        throw new AggregateError(
          cleanupErrors,
          'Dataset connection controls could not release every owner.'
        );
      }
    });
    return destroyPromise;
  }

  /**
   * Open the connection of one source type at `value` (a data link's
   * locator, a server address).
   *
   * @param {string} sourceType
   * @param {string} value
   * @returns {Promise<boolean>} Whether it is now connected.
   */
  function openConnection(sourceType, value) {
    const opener = openers.get(sourceType);
    if (opener === undefined) {
      throw new Error(`No ${sourceType} connection control is wired.`);
    }
    validateDatasetId(value, `${sourceType} connection value`);
    return opener(value);
  }

  return Object.freeze({ destroy, openConnection });
}
