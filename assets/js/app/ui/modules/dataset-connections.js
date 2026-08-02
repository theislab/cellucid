/**
 * Exact dataset connection and local-file controls.
 *
 * Remote/GitHub connection attempts always use isolated source candidates.
 * Zero-dataset and failed candidates are disconnected without replacing the
 * registered source. One dataset is transactionally activated; multiple
 * datasets require an explicit enabled-selector choice.
 */

import {
  formatCellCount as formatDataNumber,
  validateDatasetId,
  validateDatasetIdentity
} from '../../../data/data-source.js';
import { getNotificationCenter } from '../../notification-center.js';
import { DATA_LOAD_METHODS } from '../../../analytics/tracker.js';
import { debug } from '../../../utils/debug.js';
import {
  createDatasetReloadSupersededError,
  isDatasetReloadSupersededError
} from '../../dataset-reload-outcome.js';

const CONNECTION_OPTION_KEYS = Object.freeze([
  'activateDataset',
  'clearDataset',
  'dataSourceManager',
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
    validateDatasetIdentity(metadata, id, sourceType);
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
 * ceiling fires on a perfectly valid export that is merely bigger than the
 * browser will take, so "re-export it" is the one action guaranteed to fail:
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
      'Serve it with the Cellucid server, or publish a smaller export, then '
      + 'try again.'
  }),
  unreadable: Object.freeze({
    cause: 'what is published there is not in a format Cellucid can read.',
    action: 'Re-export it with cellucid prepare, then try again.'
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
  return classifyDataSourceFailure(error) === null
    ? ` Details: ${errorMessage(error)}`
    : '';
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
 * @param {Object} options
 * @param {(datasetId: string, sourceType: string, loadMethod: string, source?: Object|null) => Promise<boolean>} options.activateDataset
 * @param {() => Promise<boolean>} options.clearDataset
 * @param {Object} options.dataSourceManager
 * @param {Object} options.dom
 * @param {string} options.noneDatasetValue
 * @param {() => Promise<boolean>} options.populateDatasetDropdown
 */
export function initDatasetConnections(options) {
  requireExactOptions(options);
  const {
    activateDataset,
    clearDataset,
    dataSourceManager,
    dom,
    noneDatasetValue,
    populateDatasetDropdown
  } = options;
  requireFunction(activateDataset, 'Dataset activation owner');
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

  let localSelectionRevision = 0;
  operationInvalidators.add(() => {
    localSelectionRevision =
      localSelectionRevision === Number.MAX_SAFE_INTEGER
        ? 1
        : localSelectionRevision + 1;
  });
  async function loadLocalUserSelection(
    files,
    { loadMethod, loadingMessage, load }
  ) {
    if (!files || files.length === 0) return;
    const selectionRevision = ++localSelectionRevision;
    const assertCurrentSelection = () => {
      if (
        destroyed ||
        selectionRevision !== localSelectionRevision
      ) {
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

    const loadNotifId = beginLoadingNotification(loadingMessage, {
      category: 'data'
    });
    let candidatePublished = false;
    try {
      const metadata = await load(userSource, files);
      assertCurrentSelection();
      const ready = await activateDataset(
        userSource.datasetId,
        'local-user',
        loadMethod,
        userSource
      );
      assertCurrentSelection();
      if (ready !== true) {
        throw new Error(
          'Validated user data did not publish one ready generation.'
        );
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
        `User data ready: ${formatDataNumber(metadata.stats.n_cells)} cells`
      );
    } catch (error) {
      if (destroyed) {
        const adopted =
          dataSourceManager.getSource('local-user') === userSource;
        if (!candidatePublished && !adopted) userSource.disconnect();
        return;
      }
      if (isDatasetReloadSupersededError(error)) {
        if (!candidatePublished) userSource.disconnect();
        activeLoadingNotifications.delete(loadNotifId);
        notifications.dismiss(loadNotifId);
        return;
      }
      if (!candidatePublished) userSource.disconnect();
      debug.error('[UI] Failed to load user data:', error);
      settleLoadingNotification(
        'fail',
        loadNotifId,
        errorMessage(error)
      );
    }
  }

  const localPrepared = requireControlGroup(
    dom,
    ['userDataBrowseBtn', 'userDataFileInput'],
    'Prepared-directory'
  );
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

  if (localPrepared !== null) {
    const { userDataBrowseBtn, userDataFileInput } = localPrepared;
    listen(
      userDataBrowseBtn,
      'click',
      () => userDataFileInput.click()
    );
    listen(userDataFileInput, 'change', event => {
      return launchOperation(async () => {
        await loadLocalUserSelection(event.target.files, {
          loadMethod: DATA_LOAD_METHODS.LOCAL_PREPARED,
          loadingMessage: 'Loading prepared dataset...',
          load: (source, files) => source.loadFromPreparedDirectory(files)
        });
        if (!destroyed) userDataFileInput.value = '';
      }, 'Prepared-directory selection failed');
    });
    admitControls(userDataBrowseBtn, userDataFileInput);
  }
  if (localH5ad !== null) {
    const { userDataH5adBtn, userDataH5adInput } = localH5ad;
    listen(
      userDataH5adBtn,
      'click',
      () => userDataH5adInput.click()
    );
    listen(userDataH5adInput, 'change', event => {
      return launchOperation(async () => {
        await loadLocalUserSelection(event.target.files, {
          loadMethod: DATA_LOAD_METHODS.LOCAL_H5AD,
          loadingMessage: 'Loading h5ad file...',
          load: (source, files) =>
            source.loadFromH5adFile(
              files.length === 1 ? files[0] : null
            )
        });
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
      return launchOperation(async () => {
        await loadLocalUserSelection(event.target.files, {
          loadMethod: DATA_LOAD_METHODS.LOCAL_ZARR_ZIP,
          loadingMessage: 'Loading Zarr ZIP archive...',
          load: (source, files) =>
            source.loadFromZarrArchive(
              files.length === 1 ? files[0] : null
            )
        });
        if (!destroyed) userDataZarrArchiveInput.value = '';
      }, 'Zarr ZIP selection failed');
    });
    admitControls(userDataZarrArchiveBtn, userDataZarrArchiveInput);
  }

  function wireConnection(config) {
    const {
      connectButton,
      connectionInput,
      disconnectButton,
      disconnectContainer,
      failureSubject,
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
      disconnectContainer.style.display = connected ? 'flex' : 'none';
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

    async function recoverConnectionLoss(lostSource, error) {
      if (dataSourceManager.getSource(sourceType) !== lostSource) return;
      const revision = ++operationRevision;
      connectButton.disabled = true;
      disconnectButton.disabled = true;
      const wasActive =
        dataSourceManager.getCurrentSourceType() === sourceType;
      if (wasActive) {
        const cleared = await clearDataset();
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
          try {
            await recoverConnectionLoss(candidate, error);
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

    async function handleConnectClick() {
      if (dataSourceManager.getCurrentSourceType() === sourceType) {
        notifications.error(
          `${inputLabel} is the active dataset source. Disconnect it before reconnecting.`,
          { category: 'connectivity' }
        );
        return;
      }
      const inputValue = connectionInput.value;
      if (typeof inputValue !== 'string' || inputValue.trim().length === 0) {
        notifications.error(
          `Enter one ${inputLabel.toLowerCase()} before connecting.`,
          { category: 'connectivity' }
        );
        return;
      }

      const priorSource = source;
      const revision = ++operationRevision;
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
          const cleanupError = disconnectCandidateOnce();
          if (cleanupError !== null) throw cleanupError;
          updateConnectionUI(sourceConnected(priorSource));
          settleLoadingNotification(
            'fail',
            connectNotifId,
            `Connected ${inputLabel} has no datasets. Add a valid export and reconnect.`
          );
          return;
        }

        attachConnectionLoss(candidate);
        if (datasets.length === 1) {
          const ready = await activateDataset(
            datasets[0].id,
            sourceType,
            loadMethod,
            candidate
          );
          assertCurrentOperation(revision);
          if (ready !== true) {
            throw new Error(
              `${inputLabel} dataset activation did not publish a ready generation.`
            );
          }
          // The activation transaction registered the candidate and finalized
          // the displaced transport exactly once.
          if (dataSourceManager.getSource(sourceType) !== candidate) {
            throw new Error(
              `${inputLabel} activation did not adopt its connection candidate.`
            );
          }
          source = candidate;
          updateConnectionUI(true);
          candidatePublished = true;
          detachConnectionLoss(priorSource);
          await populate();
          assertCurrentOperation(revision);
          settleLoadingNotification(
            'complete',
            connectNotifId,
            `Connected - dataset "${datasets[0].name}" loaded`
          );
          return;
        }

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
          `Connected - ${adoption.count} datasets found. Choose one from Sample datasets.`
        );
      } catch (error) {
        if (destroyed) {
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
        settleLoadingNotification(
          'fail',
          connectNotifId,
          reportDataSourceFailure(
            failureSubject,
            'could not be reached',
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
      disconnectButton: remote.remoteDisconnectBtn,
      disconnectContainer: remote.remoteDisconnectContainer,
      failureSubject: 'The remote server',
      inputLabel: 'Remote server',
      loadMethod: DATA_LOAD_METHODS.REMOTE_CONNECT,
      sourceType: 'remote'
    });
  }

  const github = requireControlGroup(
    dom,
    [
      'githubConnectBtn',
      'githubDisconnectBtn',
      'githubDisconnectContainer',
      'githubRepoUrl'
    ],
    'GitHub'
  );
  if (github !== null) {
    wireConnection({
      connectButton: github.githubConnectBtn,
      connectionInput: github.githubRepoUrl,
      disconnectButton: github.githubDisconnectBtn,
      disconnectContainer: github.githubDisconnectContainer,
      failureSubject: 'The GitHub repository',
      inputLabel: 'GitHub repository',
      loadMethod: DATA_LOAD_METHODS.GITHUB_CONNECT,
      sourceType: 'github-repo'
    });
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

  return Object.freeze({ destroy });
}
