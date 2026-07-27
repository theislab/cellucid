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

function errorMessage(error) {
  if (error instanceof AggregateError) {
    const causes = error.errors.map(item => errorMessage(item));
    return `${error.message} Causes: ${causes.join('; ')}`;
  }
  return error instanceof Error ? error.message : String(error);
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

  async function populate() {
    const outcome = await populateDatasetDropdown();
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
  async function loadLocalUserSelection(
    files,
    { loadMethod, loadingMessage, load }
  ) {
    if (!files || files.length === 0) return;
    const selectionRevision = ++localSelectionRevision;
    const assertCurrentSelection = () => {
      if (selectionRevision !== localSelectionRevision) {
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

    const loadNotifId = notifications.loading(loadingMessage, {
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
      notifications.complete(
        loadNotifId,
        `User data ready: ${formatDataNumber(metadata.stats.n_cells)} cells`
      );
    } catch (error) {
      if (isDatasetReloadSupersededError(error)) {
        if (!candidatePublished) userSource.disconnect();
        notifications.dismiss(loadNotifId);
        return;
      }
      if (!candidatePublished) userSource.disconnect();
      debug.error('[UI] Failed to load user data:', error);
      notifications.fail(loadNotifId, errorMessage(error));
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
    userDataBrowseBtn.addEventListener(
      'click',
      () => userDataFileInput.click()
    );
    userDataFileInput.addEventListener('change', async event => {
      await loadLocalUserSelection(event.target.files, {
        loadMethod: DATA_LOAD_METHODS.LOCAL_PREPARED,
        loadingMessage: 'Loading prepared dataset...',
        load: (source, files) => source.loadFromPreparedDirectory(files)
      });
      userDataFileInput.value = '';
    });
  }
  if (localH5ad !== null) {
    const { userDataH5adBtn, userDataH5adInput } = localH5ad;
    userDataH5adBtn.addEventListener(
      'click',
      () => userDataH5adInput.click()
    );
    userDataH5adInput.addEventListener('change', async event => {
      await loadLocalUserSelection(event.target.files, {
        loadMethod: DATA_LOAD_METHODS.LOCAL_H5AD,
        loadingMessage: 'Loading h5ad file...',
        load: (source, files) =>
          source.loadFromH5adFile(
            files.length === 1 ? files[0] : null
          )
      });
      userDataH5adInput.value = '';
    });
  }
  if (localZarr !== null) {
    const {
      userDataZarrArchiveBtn,
      userDataZarrArchiveInput
    } = localZarr;
    userDataZarrArchiveBtn.addEventListener(
      'click',
      () => userDataZarrArchiveInput.click()
    );
    userDataZarrArchiveInput.addEventListener('change', async event => {
      await loadLocalUserSelection(event.target.files, {
        loadMethod: DATA_LOAD_METHODS.LOCAL_ZARR_ZIP,
        loadingMessage: 'Loading Zarr ZIP archive...',
        load: (source, files) =>
          source.loadFromZarrArchive(
            files.length === 1 ? files[0] : null
          )
      });
      userDataZarrArchiveInput.value = '';
    });
  }

  function wireConnection(config) {
    const {
      connectButton,
      connectionInput,
      disconnectButton,
      disconnectContainer,
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

    function assertCurrentOperation(revision) {
      if (revision !== operationRevision) {
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

    async function restorePriorSource(priorSource, candidate) {
      if (dataSourceManager.getSource(sourceType) === candidate) {
        dataSourceManager.registerSource(sourceType, priorSource);
        await populate();
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
        if (dataSourceManager.getSource(sourceType) === candidate) {
          dataSourceManager.registerSource(sourceType, priorSource);
          await populate();
        }
        throw error;
      }
      source = candidate;
      updateConnectionUI(true);
      datasetSelect.disabled = false;
      datasetSelect.focus();
      let cleanupError = null;
      try {
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
      requireMethod(
        candidate,
        'onConnectionLost',
        'Remote connection source'
      );
      candidate.onConnectionLost(error => {
        void recoverConnectionLoss(candidate, error).catch(
          recoveryError => {
            if (isDatasetReloadSupersededError(recoveryError)) return;
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
        );
      });
    }

    attachConnectionLoss(source);

    connectButton.addEventListener('click', async () => {
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
      const connectNotifId = notifications.loading(
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
          notifications.fail(
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
          await populate();
          assertCurrentOperation(revision);
          notifications.complete(
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
          notifications.fail(
            connectNotifId,
            `Connected - ${adoption.count} datasets found, but the prior ` +
            `connection could not be released: ` +
            `${errorMessage(adoption.cleanupError)}`
          );
          return;
        }
        notifications.complete(
          connectNotifId,
          `Connected - ${adoption.count} datasets found. Choose one from Sample datasets.`
        );
      } catch (error) {
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
          notifications.fail(
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
                await restorePriorSource(priorSource, candidate);
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
        notifications.fail(
          connectNotifId,
          `Connection failed: ${errorMessage(exactError)}`
        );
        debug.error(`[UI] ${inputLabel} connection error:`, exactError);
      } finally {
        if (revision === operationRevision && !recoveryBlocked) {
          connectButton.disabled = false;
        }
      }
    });

    disconnectButton.addEventListener('click', async () => {
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
        if (revision === operationRevision && !recoveryBlocked) {
          connectButton.disabled = false;
          disconnectButton.disabled = false;
        }
      }
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
      inputLabel: 'GitHub repository',
      loadMethod: DATA_LOAD_METHODS.GITHUB_CONNECT,
      sourceType: 'github-repo'
    });
  }
}
