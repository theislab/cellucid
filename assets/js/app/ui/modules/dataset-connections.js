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
  isExplainedFailure,
  validateDatasetId,
  validateDatasetSummary
} from '../../../data/data-source.js';
import { getProviderRegistry } from '../../../data/sources/registry.js';
import { initTransfersPanel } from './transfers-panel.js';
import { validateRemoteServerUrl } from '../../../data/remote-source.js';
import { getNotificationCenter } from '../../notification-center.js';
import { DATA_LOAD_METHODS } from '../../data-load-methods.js';
import { analytics } from '../../optional-analytics.js';
import { debug } from '../../../utils/debug.js';
import { initDatasetDrop } from './dataset-drop.js';
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
 * The raw text to append to a notification, and nothing at all when the loader
 * did publish a cause.
 *
 * An unclassified failure is as likely to be a broken invariant inside
 * Cellucid as a transport problem, and then its message is the only evidence
 * anyone has. Swallowing it would hide a defect, so it is carried through as a
 * clearly-labelled trailing detail rather than as the whole message.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function dataSourceFailureDetail(error) {
  return classifyDataSourceFailure(error) === null && !isExplainedFailure(error)
    ? ` Details: ${errorMessage(error)}`
    : '';
}

function explainedMessage(error) {
  return error instanceof AggregateError && error.errors.length > 0
    ? explainedMessage(error.errors[0])
    : error.message;
}

/**
 * The failure as a notification: the readable sentence, plus the raw text
 * whenever the loader classified nothing.
 *
 * @param {string} subject
 * @param {string} verb
 * @param {unknown} error
 * @returns {string}
 */
export function reportDataSourceFailure(subject, verb, error) {
  return describeDataSourceFailure(subject, verb, error)
    + dataSourceFailureDetail(error);
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
 * The three ways a local dataset is read: an `.h5ad` file, an AnnData Zarr
 * store folder, or a zipped one. The file inputs and a drop onto the viewer
 * share them, so a dropped file is read, validated, reported and superseded
 * exactly as a picked one is.
 */
const LOCAL_LOADERS = Object.freeze({
  h5ad: Object.freeze({
    loadMethod: DATA_LOAD_METHODS.LOCAL_H5AD,
    loadingMessage: 'Loading h5ad file...',
    load: (source, files) =>
      source.loadFromH5adFile(files.length === 1 ? files[0] : null)
  }),
  'zarr-zip': Object.freeze({
    loadMethod: DATA_LOAD_METHODS.LOCAL_ZARR_ZIP,
    loadingMessage: 'Loading Zarr ZIP archive...',
    load: (source, files) =>
      source.loadFromZarrArchive(files.length === 1 ? files[0] : null)
  }),
  'zarr-folder': Object.freeze({
    loadMethod: DATA_LOAD_METHODS.LOCAL_ZARR_FOLDER,
    loadingMessage: 'Loading Zarr folder...',
    load: (source, files) => source.loadFromZarrDirectory(files)
  })
});

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
  const activeLoadingNotifications = new Set();
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
      debug.error(`[UI] ${label}:`, error);
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

  function beginLoadingNotification(message, options) {
    assertAlive();
    const id = notifications.loading(message, options);
    activeLoadingNotifications.add(id);
    return id;
  }

  function settleLoadingNotification(method, id, message) {
    if (destroyed) return;
    activeLoadingNotifications.delete(id);
    notifications[method](id, message);
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
   * @param {{loadMethod: string, loadingMessage: string,
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
    { readFiles },
    { loadMethod, loadingMessage, load }
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
    const loadNotifId = beginLoadingNotification(loadingMessage, {
      category: 'data'
    });
    // A newer dataset choice cancels the read itself, not only its result:
    // the candidate's disconnect retires a parsed file instead of adopting
    // it, and the read's progress
    // leaves the screen at once rather than when the read gets round to
    // noticing.
    const cancelRead = () => {
      userSource.disconnect();
      if (destroyed) return;
      activeLoadingNotifications.delete(loadNotifId);
      notifications.dismiss(loadNotifId);
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
        activeLoadingNotifications.delete(loadNotifId);
        notifications.dismiss(loadNotifId);
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
      settleLoadingNotification(
        'complete',
        loadNotifId,
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
        activeLoadingNotifications.delete(loadNotifId);
        notifications.dismiss(loadNotifId);
        return;
      }
      dataLoad.fail(error);
      if (!candidatePublished) userSource.disconnect();
      debug.error('[UI] Failed to load user data:', error);
      settleLoadingNotification(
        'fail',
        loadNotifId,
        errorMessage(error)
      );
    }
  }

  const localH5ad = requireControlGroup(
    dom,
    ['userDataH5adBtn', 'userDataH5adInput'],
    'H5AD'
  );
  const localZarr = requireControlGroup(
    dom,
    ['userDataZarrArchiveBtn', 'userDataZarrArchiveInput'],
    'Zarr ZIP'
  );
  const localZarrFolder = requireControlGroup(
    dom,
    ['userDataZarrFolderBtn', 'userDataZarrFolderInput'],
    'Zarr folder'
  );
  if (localZarrFolder !== null) {
    const { userDataZarrFolderBtn, userDataZarrFolderInput } = localZarrFolder;
    listen(
      userDataZarrFolderBtn,
      'click',
      () => userDataZarrFolderInput.click()
    );
    listen(userDataZarrFolderInput, 'change', event => {
      const files = event.target.files;
      if (!files || files.length === 0) return undefined;
      return launchOperation(async () => {
        await loadLocalUserSelection(
          pickedSelection(files),
          LOCAL_LOADERS['zarr-folder']
        );
        if (!destroyed) userDataZarrFolderInput.value = '';
      }, 'Zarr folder selection failed');
    });
    admitControls(userDataZarrFolderBtn, userDataZarrFolderInput);
  }

  if (localH5ad !== null) {
    const { userDataH5adBtn, userDataH5adInput } = localH5ad;
    listen(
      userDataH5adBtn,
      'click',
      () => userDataH5adInput.click()
    );
    listen(userDataH5adInput, 'change', event => {
      const files = event.target.files;
      if (!files || files.length === 0) return undefined;
      return launchOperation(async () => {
        await loadLocalUserSelection(
          pickedSelection(files),
          LOCAL_LOADERS.h5ad
        );
        if (!destroyed) userDataH5adInput.value = '';
      }, 'H5AD selection failed');
    });
    admitControls(userDataH5adBtn, userDataH5adInput);
  }
  if (localZarr !== null) {
    const {
      userDataZarrArchiveBtn,
      userDataZarrArchiveInput
    } = localZarr;
    listen(
      userDataZarrArchiveBtn,
      'click',
      () => userDataZarrArchiveInput.click()
    );
    listen(userDataZarrArchiveInput, 'change', event => {
      const files = event.target.files;
      if (!files || files.length === 0) return undefined;
      return launchOperation(async () => {
        await loadLocalUserSelection(
          pickedSelection(files),
          LOCAL_LOADERS['zarr-zip']
        );
        if (!destroyed) userDataZarrArchiveInput.value = '';
      }, 'Zarr ZIP selection failed');
    });
    admitControls(userDataZarrArchiveBtn, userDataZarrArchiveInput);
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

  function wireConnection(config) {
    const {
      connectButton,
      connectionInput,
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

    function updateConnectionUI(connected) {
      assertAlive();
      if (typeof connected !== 'boolean') {
        throw new TypeError(
          `${inputLabel} UI state must be a boolean.`
        );
      }
      connectButton.textContent = connected ? 'Reconnect' : 'Connect';
      disconnectContainer.hidden = !connected;
      connectionInput.disabled = connected || recoveryBlocked;
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
      connectButton.disabled = true;
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
          connectButton.disabled = true;
          connectionInput.disabled = true;
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
      connectButton.disabled = false;
      disconnectButton.disabled = false;
      notifications.error(
        `${inputLabel} connection was lost. Reconnect to continue.`,
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
            connectButton.disabled = true;
            disconnectButton.disabled = true;
            connectionInput.disabled = true;
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

    async function handleConnectClick(clickLoadMethod = loadMethod) {
      if (dataSourceManager.getCurrentSourceType() === sourceType) {
        notifications.error(
          `${inputLabel} is the active dataset source. Disconnect it before reconnecting.`,
          { category: 'connectivity' }
        );
        return;
      }
      const inputValue = connectionInput.value;
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
      const connectNotifId = beginLoadingNotification(
        `Connecting to ${inputLabel}: ${inputValue}...`,
        { category: 'connectivity' }
      );
      connectButton.disabled = true;
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
        if (sourceType === 'remote') {
          await candidate.connect({ url: inputValue });
        } else {
          await candidate.connect(inputValue);
        }
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
          settleLoadingNotification(
            'fail',
            connectNotifId,
            `Connected ${inputLabel} has no datasets. Add an AnnData file and reconnect.`
          );
          return;
        }

        attachConnectionLoss(candidate);
        const activationIntent = datasets.length === 1
          ? datasetIntents.beginIfNoActionSince(clickAction, {
              label: `Loading ${datasets[0].name}…`,
              value: null
            })
          : null;
        if (activationIntent !== null) {
          let ready = null;
          try {
            ready = await datasetIntents.activate(
              activationIntent,
              datasets[0].id,
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
            activeLoadingNotifications.delete(connectNotifId);
            notifications.dismiss(connectNotifId);
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
            settleLoadingNotification(
              'complete',
              connectNotifId,
              ready === true
                ? `Connected - dataset "${datasets[0].name}" loaded`
                : `Connected - dataset "${datasets[0].name}" is available ` +
                  `in Sample datasets.`
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
          settleLoadingNotification(
            'fail',
            connectNotifId,
            `Connected - ${adoption.count} datasets found, but the prior ` +
            `connection could not be released: ` +
            `${errorMessage(adoption.cleanupError)}`
          );
          return;
        }
        settleLoadingNotification(
          'complete',
          connectNotifId,
          adoption.count === 1
            ? `Connected - dataset "${datasets[0].name}" is available in ` +
              `Sample datasets.`
            : `Connected - ${adoption.count} datasets found. Choose one ` +
              `from Sample datasets.`
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
          settleLoadingNotification(
            'fail',
            connectNotifId,
            `Dataset loaded, but the catalog could not be refreshed: ` +
            `${errorMessage(error)}`
          );
          debug.error(
            `[UI] ${inputLabel} post-publication catalog error:`,
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
          activeLoadingNotifications.delete(connectNotifId);
          notifications.dismiss(connectNotifId);
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
        settleLoadingNotification(
          'fail',
          connectNotifId,
          reportDataSourceFailure(
            failureSubject,
            failureVerb,
            exactError
          )
        );
        debug.error(`[UI] ${inputLabel} connection error:`, exactError);
      } finally {
        if (
          !destroyed &&
          revision === operationRevision &&
          !recoveryBlocked
        ) {
          connectButton.disabled = false;
        }
      }
    }
    listen(connectButton, 'click', () => {
      return launchOperation(
        handleConnectClick,
        `${inputLabel} connection handler rejected`
      );
    });

    async function handleDisconnectClick() {
      const revision = ++operationRevision;
      const connectedSource = source;
      connectButton.disabled = true;
      disconnectButton.disabled = true;
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
        connectButton.disabled = true;
        disconnectButton.disabled = true;
        connectionInput.disabled = true;
        notifications.error(
          `${inputLabel} disconnect could not finish safely. Reload the ` +
          `page before reconnecting. Cause: ${errorMessage(error)}`,
          {
            category: 'connectivity',
            duration: 0,
            title: 'Disconnect recovery blocked'
          }
        );
        debug.error(`[UI] ${inputLabel} disconnect error:`, error);
      } finally {
        if (
          !destroyed &&
          revision === operationRevision &&
          !recoveryBlocked
        ) {
          connectButton.disabled = false;
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
     * Connect to `value` as if it had been typed and Connect clicked, for an
     * action that names its data (a session file's recorded source). A
     * different connection that is open is closed first. Failures are
     * reported by the connect and disconnect paths themselves.
     *
     * @returns {Promise<boolean>} Whether `value` is now connected.
     */
    async function open(value, openLoadMethod) {
      assertAlive();
      const connectedTo = () =>
        sourceConnected(source) && sourceInputValue(source) === value;
      if (connectedTo()) return true;
      if (dataSourceManager.getCurrentSourceType() === sourceType) {
        await handleDisconnectClick();
        if (dataSourceManager.getCurrentSourceType() === sourceType) {
          return false;
        }
      }
      connectionInput.value = value;
      await handleConnectClick(openLoadMethod);
      return !destroyed && connectedTo();
    }
    openers.set(sourceType, value =>
      launchOperation(
        () => open(value, DATA_LOAD_METHODS.SESSION_SOURCE),
        `${inputLabel} open rejected`
      )
    );

    const initialConnected = sourceConnected(source);
    if (initialConnected && connectionInput.value.length === 0) {
      const value = sourceInputValue(source);
      if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(
          `${inputLabel} connected source must publish its input value.`
        );
      }
      connectionInput.value = value;
    }
    updateConnectionUI(initialConnected);
    // `updateConnectionUI` owns the text input's enabled state; the two buttons
    // have no other owner until an operation runs, so admission is theirs.
    admitControls(connectButton, disconnectButton);
  }

  const remote = requireControlGroup(
    dom,
    [
      'remoteConnectBtn',
      'remoteDisconnectBtn',
      'remoteDisconnectContainer',
      'remoteServerUrl'
    ],
    'Remote'
  );
  if (remote !== null) {
    wireConnection({
      connectButton: remote.remoteConnectBtn,
      connectionInput: remote.remoteServerUrl,
      describeInputProblem: describeRemoteAddressProblem,
      disconnectButton: remote.remoteDisconnectBtn,
      disconnectContainer: remote.remoteDisconnectContainer,
      emptyInputMessage:
        'Enter a remote server address, such as http://localhost:8765, '
        + 'before connecting.',
      failureSubject: 'The remote server',
      failureVerb: 'could not be reached',
      inputLabel: 'Server',
      loadMethod: DATA_LOAD_METHODS.REMOTE_CONNECT,
      sourceType: 'remote'
    });
  }

  const dataLink = requireControlGroup(
    dom,
    [
      'dataLinkConnectBtn',
      'dataLinkDisconnectBtn',
      'dataLinkDisconnectContainer',
      'dataLinkUrl'
    ],
    'Data link'
  );
  if (dataLink !== null) {
    wireConnection({
      connectButton: dataLink.dataLinkConnectBtn,
      connectionInput: dataLink.dataLinkUrl,
      describeInputProblem: describeDataLinkProblem,
      disconnectButton: dataLink.dataLinkDisconnectBtn,
      disconnectContainer: dataLink.dataLinkDisconnectContainer,
      emptyInputMessage:
        'Paste a link or an id, such as a CELLxGENE dataset link, GSE123456, '
        + 'or owner/repo/folder, before connecting.',
      failureSubject: 'The linked data',
      failureVerb: 'could not be opened',
      inputLabel: 'Link',
      loadMethod: DATA_LOAD_METHODS.LINK_CONNECT,
      sourceType: 'link'
    });
  }

  if (dom.transfersBlock && dom.transfersList) {
    const stopTransfers = initTransfersPanel({
      container: dom.transfersBlock,
      list: dom.transfersList,
    });
    lifecycleController.signal.addEventListener('abort', stopTransfers, { once: true });
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
    for (const id of activeLoadingNotifications) {
      try {
        notifications.dismiss(id);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    activeLoadingNotifications.clear();
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
