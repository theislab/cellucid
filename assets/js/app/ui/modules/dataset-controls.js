/**
 * @fileoverview Dataset selection and data-source connection UI.
 *
 * Handles:
 * - Dataset dropdown + metadata panel
 * - Local user data (prepared, h5ad, zarr)
 * - Remote server connect/disconnect
 * - GitHub repo connect/disconnect
 *
 * This module is UI-only and calls back into the coordinator for dataset-wide
 * refresh hooks (field dropdowns, gene search, dimension options, etc.).
 *
 * @module ui/modules/dataset-controls
 */

import {
  formatCellCount as formatDataNumber,
  validateDatasetIdentity
} from '../../../data/data-source.js';
import { DATA_LOAD_METHODS } from '../../../analytics/tracker.js';
import { debug } from '../../../utils/debug.js';
import { isDatasetReloadSupersededError } from '../../dataset-reload-outcome.js';
import { initDatasetConnections } from './dataset-connections.js';

export const NONE_DATASET_VALUE = '__none__';

const LOADING_DATASET_VALUE = '__catalog_loading__';
const EMPTY_CATALOG_VALUE = '__catalog_empty__';
const CATALOG_ERROR_VALUE = '__catalog_error__';
const DATASET_CONTROL_KEYS = [
  'callbacks',
  'clearDataset',
  'dataSourceManager',
  'dom',
  'reloadDataset'
];
const DATASET_CALLBACK_KEYS = [
  'clearGeneSelection',
  'initGeneExpressionDropdown',
  'refreshUIForActiveView',
  'renderDeletedFieldsSection',
  'renderFieldSelects',
  'showSessionStatus',
  'updateDimensionSelectUI'
];
const DATASET_EVENT_KEYS = [
  'baseUrl',
  'datasetId',
  'loadMethod',
  'metadata',
  'previousDatasetId',
  'previousSourceType',
  'sourceType'
];

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePlainObject(value, name) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${name} must be a plain object.`);
  }
  return value;
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function requireExactKeys(value, expectedKeys, name) {
  requirePlainObject(value, name);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${name} must contain exactly: ${expected.join(', ')}.`);
  }
}

function requireMethod(owner, methodName, name) {
  if (
    owner === null ||
    typeof owner !== 'object' ||
    typeof owner[methodName] !== 'function'
  ) {
    throw new TypeError(`${name} must implement ${methodName}().`);
  }
}

function requireElement(element, name, methods = []) {
  if (element === null || typeof element !== 'object') {
    throw new TypeError(`${name} must be a DOM element.`);
  }
  for (const method of methods) {
    if (typeof element[method] !== 'function') {
      throw new TypeError(`${name} must implement ${method}().`);
    }
  }
  return element;
}

function requireDatasetMetadata(metadata, sourceType, name) {
  requirePlainObject(metadata, name);
  requireNonEmptyString(sourceType, `${name} sourceType`);
  requireNonEmptyString(metadata.id, `${name} id`);
  validateDatasetIdentity(metadata, metadata.id, sourceType);
  return metadata;
}

function requireDatasetEvent(event) {
  requireExactKeys(event, DATASET_EVENT_KEYS, 'Dataset change event');
  for (const key of [
    'baseUrl',
    'datasetId',
    'loadMethod',
    'previousDatasetId',
    'previousSourceType',
    'sourceType'
  ]) {
    if (event[key] !== null) {
      requireNonEmptyString(event[key], `Dataset change event ${key}`);
    }
  }
  const isEmpty = event.datasetId === null;
  if (
    isEmpty !== (event.sourceType === null) ||
    isEmpty !== (event.metadata === null) ||
    isEmpty !== (event.baseUrl === null)
  ) {
    throw new TypeError(
      'Dataset change event must publish either one complete dataset or the exact None state.'
    );
  }
  if (!isEmpty) {
    requireDatasetMetadata(
      event.metadata,
      event.sourceType,
      'Dataset change event metadata'
    );
    if (event.metadata.id !== event.datasetId) {
      throw new TypeError(
        'Dataset change event metadata id must equal datasetId.'
      );
    }
  }
  return event;
}

function requireCatalog(catalog) {
  if (!Array.isArray(catalog)) {
    throw new TypeError('Dataset catalog must be an array of source records.');
  }
  const seenSourceTypes = new Set();
  const seenDatasetKeys = new Set();
  const records = catalog.map((record, sourceIndex) => {
    requireExactKeys(
      record,
      ['datasets', 'sourceType'],
      `Dataset catalog source ${sourceIndex}`
    );
    requireNonEmptyString(
      record.sourceType,
      `Dataset catalog source ${sourceIndex} sourceType`
    );
    if (seenSourceTypes.has(record.sourceType)) {
      throw new TypeError(
        `Dataset catalog contains source "${record.sourceType}" more than once.`
      );
    }
    seenSourceTypes.add(record.sourceType);
    if (!Array.isArray(record.datasets)) {
      throw new TypeError(
        `Dataset catalog source "${record.sourceType}" datasets must be an array.`
      );
    }
    const datasets = record.datasets.map((metadata, datasetIndex) => {
      requireDatasetMetadata(
        metadata,
        record.sourceType,
        `Dataset catalog ${record.sourceType}[${datasetIndex}]`
      );
      const datasetKey = datasetSelectionValue(
        record.sourceType,
        metadata.id
      );
      if (seenDatasetKeys.has(datasetKey)) {
        throw new TypeError(
          `Dataset "${record.sourceType}/${metadata.id}" occurs more than once.`
        );
      }
      seenDatasetKeys.add(datasetKey);
      return metadata;
    });
    return { sourceType: record.sourceType, datasets };
  });
  return records;
}

function errorFromUnknown(error, context) {
  if (error instanceof Error) {
    return error;
  }
  return new TypeError(`${context} rejected with a non-Error value.`, {
    cause: error
  });
}

function datasetSelectionValue(sourceType, datasetId) {
  requireNonEmptyString(sourceType, 'Dataset selection source type');
  requireNonEmptyString(datasetId, 'Dataset selection id');
  return (
    `dataset:${encodeURIComponent(sourceType)}:` +
    encodeURIComponent(datasetId)
  );
}

export function initDatasetControls(options) {
  requireExactKeys(options, DATASET_CONTROL_KEYS, 'Dataset controls options');
  const {
    dom,
    dataSourceManager,
    clearDataset,
    reloadDataset,
    callbacks
  } = options;
  requirePlainObject(dom, 'Dataset controls DOM');
  requireExactKeys(callbacks, DATASET_CALLBACK_KEYS, 'Dataset control callbacks');
  for (const callbackName of DATASET_CALLBACK_KEYS) {
    if (typeof callbacks[callbackName] !== 'function') {
      throw new TypeError(
        `Dataset control callback ${callbackName} must be a function.`
      );
    }
  }
  if (typeof reloadDataset !== 'function') {
    throw new TypeError('Dataset controls reloadDataset must be a function.');
  }
  if (typeof clearDataset !== 'function') {
    throw new TypeError('Dataset controls clearDataset must be a function.');
  }
  for (const method of [
    'getAllDatasets',
    'getCurrentDatasetId',
    'getCurrentMetadata',
    'getCurrentSourceType',
    'getSource',
    'offDatasetChange',
    'onDatasetChange',
    'registerSource',
    'unregisterSource'
  ]) {
    requireMethod(dataSourceManager, method, 'Dataset controls dataSourceManager');
  }
  const {
    renderFieldSelects,
    renderDeletedFieldsSection,
    initGeneExpressionDropdown,
    clearGeneSelection,
    refreshUIForActiveView,
    updateDimensionSelectUI,
    showSessionStatus
  } = callbacks;

  const {
    select: datasetSelect,
    info: datasetInfo,
    nameEl: datasetNameEl,
    sourceEl: datasetSourceEl,
    descriptionEl: datasetDescriptionEl,
    urlEl: datasetUrlEl,
    cellsEl: datasetCellsEl,
    genesEl: datasetGenesEl,
    obsEl: datasetObsEl,
    connectivityEl: datasetConnectivityEl,
  } = dom;
  requireElement(datasetSelect, 'Dataset select', [
    'addEventListener',
    'appendChild',
    'replaceChildren'
  ]);
  requireElement(datasetInfo, 'Dataset info');
  if (
    datasetInfo.classList === null ||
    typeof datasetInfo.classList !== 'object' ||
    typeof datasetInfo.classList.add !== 'function' ||
    typeof datasetInfo.classList.remove !== 'function'
  ) {
    throw new TypeError('Dataset info must provide classList add/remove.');
  }
  for (const [name, element] of Object.entries({
    datasetCellsEl,
    datasetConnectivityEl,
    datasetDescriptionEl,
    datasetGenesEl,
    datasetNameEl,
    datasetObsEl,
    datasetSourceEl,
    datasetUrlEl
  })) {
    requireElement(element, name);
  }
  const ownerDocument = datasetSelect.ownerDocument;
  if (
    ownerDocument === null ||
    typeof ownerDocument !== 'object' ||
    typeof ownerDocument.createElement !== 'function'
  ) {
    throw new TypeError('Dataset select must provide an ownerDocument.');
  }
  const datasetOptionsByKey = new Map();
  const lifecycleController = new AbortController();
  const activeWork = new Set();
  let noneDatasetOption = null;
  let catalogGeneration = 0;
  let datasetSelectionIntentGeneration = 0;
  let activeDatasetSelectionIntent = null;
  let datasetConnections = null;
  let destroyed = false;
  let destroyPromise = null;

  function assertAlive() {
    if (destroyed) {
      throw new Error('Dataset controls are unavailable after destroy().');
    }
  }

  function trackWork(work) {
    const promise = Promise.resolve(work);
    activeWork.add(promise);
    const retire = () => activeWork.delete(promise);
    promise.then(retire, retire);
    return promise;
  }

  function invokeTracked(operation) {
    try {
      assertAlive();
      return trackWork(operation());
    } catch (error) {
      return trackWork(Promise.reject(error));
    }
  }

  function ownsCatalogGeneration(generation) {
    return !destroyed && generation === catalogGeneration;
  }

  function beginDatasetSelectionIntent() {
    assertAlive();
    datasetSelectionIntentGeneration =
      datasetSelectionIntentGeneration === Number.MAX_SAFE_INTEGER
        ? 1
        : datasetSelectionIntentGeneration + 1;
    activeDatasetSelectionIntent = Object.freeze({
      generation: datasetSelectionIntentGeneration
    });
    return activeDatasetSelectionIntent;
  }

  function ownsDatasetSelectionIntent(owner) {
    return !destroyed && owner === activeDatasetSelectionIntent;
  }

  function createNoneDatasetOption() {
    const option = ownerDocument.createElement('option');
    option.value = NONE_DATASET_VALUE;
    option.textContent = 'None';
    return option;
  }

  function ensureNoneDatasetOption() {
    if (noneDatasetOption === null) {
      noneDatasetOption = createNoneDatasetOption();
      datasetSelect.appendChild(noneDatasetOption);
    }
    return noneDatasetOption;
  }

  function createDatasetOption(metadata, sourceType) {
    requireDatasetMetadata(metadata, sourceType, 'Dataset option metadata');
    const value = datasetSelectionValue(sourceType, metadata.id);
    if (datasetOptionsByKey.has(value)) {
      throw new Error(
        `Dataset option "${sourceType}/${metadata.id}" already exists.`
      );
    }
    const option = ownerDocument.createElement('option');
    option.value = value;
    option.dataset.sourceType = sourceType;
    option.dataset.datasetId = metadata.id;
    option.textContent =
      `${metadata.name} (${formatDataNumber(metadata.stats.n_cells)} cells)`;
    datasetOptionsByKey.set(value, option);
    return option;
  }

// =========================================================================
// Dataset Selector
// =========================================================================

/**
 * Update the dataset info display
 * @param {Object|null} metadata - Dataset metadata
 */
function updateDatasetInfo(metadata, sourceTypeOverride = null) {
  const resetValues = () => {
    datasetNameEl.textContent = '—';
    datasetSourceEl.textContent = '—';
    datasetDescriptionEl.textContent = '—';
    datasetDescriptionEl.title = '—';
    datasetUrlEl.textContent = '—';
    datasetUrlEl.title = '—';
    datasetCellsEl.textContent = '–';
    datasetGenesEl.textContent = '–';
    datasetObsEl.textContent = '–';
    datasetConnectivityEl.textContent = '–';
    datasetInfo.classList.remove('loading', 'error');
  };

  if (metadata === null) {
    if (sourceTypeOverride !== null) {
      throw new TypeError(
        'Dataset sourceTypeOverride must be null for the None state.'
      );
    }
    resetValues();
    return;
  }

  const sourceType = sourceTypeOverride ??
    dataSourceManager.getCurrentSourceType();
  requireNonEmptyString(sourceType, 'Dataset info source type');
  requireDatasetMetadata(metadata, sourceType, 'Dataset info metadata');

  const stats = metadata.stats;
  const sourceTypeLabel = sourceType
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

  // An explicitly declared dataset source name owns the display label;
  // otherwise the registered source type owns it.
  const sourceLabel = metadata.source === undefined
    ? sourceTypeLabel
    : metadata.source.name;

  datasetNameEl.textContent = metadata.name;
  datasetSourceEl.textContent = sourceLabel;
  const description = metadata.description.length === 0
    ? '—'
    : metadata.description;
  datasetDescriptionEl.textContent = description;
  datasetDescriptionEl.title = description;
  const url = metadata.source?.url ?? '—';
  datasetUrlEl.textContent = url;
  datasetUrlEl.title = url;
  datasetCellsEl.textContent = formatDataNumber(stats.n_cells);
  datasetGenesEl.textContent = formatDataNumber(stats.n_genes);
  datasetObsEl.textContent = formatDataNumber(stats.n_obs_fields);
  if (stats.has_connectivity) {
    datasetConnectivityEl.textContent =
      `${formatDataNumber(stats.n_edges)} edges`;
  } else {
    datasetConnectivityEl.textContent = 'None';
  }
  datasetInfo.classList.remove('loading', 'error');
}

/**
 * Refresh dataset-aware UI (field dropdowns, gene search, info panel, dimension controls)
 * @param {Object|null} metadata - Dataset metadata
 */
function refreshDatasetUI(metadata) {
  assertAlive();
  renderFieldSelects();
  renderDeletedFieldsSection();
  initGeneExpressionDropdown();
  clearGeneSelection();
  refreshUIForActiveView();
  const currentMetadata = metadata === undefined
    ? dataSourceManager.getCurrentMetadata()
    : metadata;
  const currentSourceType = currentMetadata === null
    ? null
    : dataSourceManager.getCurrentSourceType();
  updateDatasetInfo(currentMetadata, currentSourceType);
  // Update dimension dropdown when dataset changes (different datasets may have different available dimensions)
  updateDimensionSelectUI();
}

/**
 * Populate the dataset dropdown with available datasets from all sources
 */
async function populateDatasetDropdown() {
  assertAlive();
  const generation = ++catalogGeneration;
  debug.log('[UI] populateDatasetDropdown called', { datasetSelect, dataSourceManager });

  const loadingOption = ownerDocument.createElement('option');
  loadingOption.value = LOADING_DATASET_VALUE;
  loadingOption.disabled = true;
  loadingOption.selected = true;
  loadingOption.textContent = 'Loading datasets…';
  datasetSelect.replaceChildren(loadingOption);
  datasetOptionsByKey.clear();
  noneDatasetOption = null;
  datasetSelect.disabled = true;

  try {
    debug.log('[UI] Calling getAllDatasets...');
    const allSourceDatasets = requireCatalog(await trackWork(
      dataSourceManager.getAllDatasets()
    ));
    if (!ownsCatalogGeneration(generation)) {
      return Object.freeze({ status: 'superseded' });
    }

    debug.log('[UI] getAllDatasets returned:', allSourceDatasets);

    // Flatten and collect all datasets with their source type
    const allDatasets = [];
    for (const { sourceType, datasets } of allSourceDatasets) {
      for (const dataset of datasets) {
        allDatasets.push({ metadata: dataset, sourceType });
      }
    }

    datasetSelect.replaceChildren();
    datasetOptionsByKey.clear();
    noneDatasetOption = null;

    ensureNoneDatasetOption();

    if (allDatasets.length === 0) {
      const emptyMsg = ownerDocument.createElement('option');
      emptyMsg.value = EMPTY_CATALOG_VALUE;
      emptyMsg.disabled = true;
      emptyMsg.textContent = 'No datasets found';
      datasetSelect.appendChild(emptyMsg);
      datasetSelect.value = NONE_DATASET_VALUE;
      datasetSelect.disabled = false;
      updateDatasetInfo(null);
      return Object.freeze({ status: 'ready' });
    }

    // Group by source type if there are multiple sources with data
    const sourcesWithData = allSourceDatasets.filter(s => s.datasets.length > 0);
    const useGroups = sourcesWithData.length > 1;

    if (useGroups) {
      // Create optgroups for each source
      for (const { sourceType, datasets } of sourcesWithData) {
        const group = ownerDocument.createElement('optgroup');
        group.label = sourceType === 'local-demo' ? 'Demo Datasets' :
                      sourceType === 'local-user' ? 'Your Data' :
                      sourceType;

        for (const dataset of datasets) {
          const option = createDatasetOption(dataset, sourceType);
          group.appendChild(option);
        }

        datasetSelect.appendChild(group);
      }
    } else {
      // Simple flat list
      for (const { metadata, sourceType } of allDatasets) {
        const option = createDatasetOption(metadata, sourceType);
        datasetSelect.appendChild(option);
      }
    }

    // Represent the exact active selection; no active dataset maps only to None.
    const currentId = dataSourceManager.getCurrentDatasetId();
    const currentSourceType = dataSourceManager.getCurrentSourceType();
    const currentMetadata = dataSourceManager.getCurrentMetadata();
    const hasCurrentDataset = currentId !== null;
    if (
      hasCurrentDataset !== (currentSourceType !== null) ||
      hasCurrentDataset !== (currentMetadata !== null)
    ) {
      throw new TypeError(
        'Dataset manager current id, source type, and metadata must be published together.'
      );
    }
    if (hasCurrentDataset) {
      requireNonEmptyString(currentId, 'Current dataset id');
      requireNonEmptyString(currentSourceType, 'Current dataset source type');
      requireDatasetMetadata(
        currentMetadata,
        currentSourceType,
        'Current dataset metadata'
      );
      if (currentMetadata.id !== currentId) {
        throw new TypeError(
          'Current dataset metadata id must equal the manager dataset id.'
        );
      }
      const currentCatalogRecord = allDatasets.find(
        record =>
          record.sourceType === currentSourceType &&
          record.metadata.id === currentId
      );
      if (currentCatalogRecord === undefined) {
        throw new Error(
          `Current dataset "${currentSourceType}/${currentId}" is absent from the active catalog.`
        );
      }
      const currentSelectionValue = datasetSelectionValue(
        currentSourceType,
        currentId
      );
      datasetSelect.value = currentSelectionValue;
      if (datasetSelect.value !== currentSelectionValue) {
        throw new Error(
          `Dataset select could not represent "${currentSourceType}/${currentId}".`
        );
      }
      updateDatasetInfo(currentMetadata, currentSourceType);
    } else {
      datasetSelect.value = NONE_DATASET_VALUE;
      if (datasetSelect.value !== NONE_DATASET_VALUE) {
        throw new Error('Dataset select could not represent the None state.');
      }
      updateDatasetInfo(null);
    }
    datasetSelect.disabled = false;
    return Object.freeze({ status: 'ready' });
  } catch (error) {
    if (!ownsCatalogGeneration(generation)) {
      return Object.freeze({ status: 'superseded' });
    }
    const exactError = errorFromUnknown(error, 'Dataset catalog');
    const errorOption = ownerDocument.createElement('option');
    errorOption.value = CATALOG_ERROR_VALUE;
    errorOption.disabled = true;
    errorOption.selected = true;
    errorOption.textContent =
      `Failed to load dataset catalog: ${exactError.message}`;
    errorOption.title = errorOption.textContent;
    datasetSelect.replaceChildren(errorOption);
    datasetOptionsByKey.clear();
    noneDatasetOption = null;
    datasetSelect.disabled = true;
    datasetInfo.classList.remove('loading');
    datasetInfo.classList.add('error');
    showSessionStatus(errorOption.textContent, true);
    return Object.freeze({
      error: exactError,
      status: 'failed'
    });
  }
}

/**
 * Handle dataset selection change - reloads page with new dataset
 * @param {string} datasetId - The selected dataset ID
 * @param {string} sourceType - The exact source type for the dataset
 * @returns {Promise<boolean>} Whether the requested dataset became ready
 */
async function handleDatasetChangeForIntent(
  datasetId,
  sourceType,
  loadMethod = DATA_LOAD_METHODS.DATASET_DROPDOWN,
  sourceOverride = null,
  intentOwner
) {
  requireNonEmptyString(datasetId, 'Selected dataset id');
  requireNonEmptyString(sourceType, 'Selected dataset source type');

  // Check if this is already the current dataset
  const currentId = dataSourceManager.getCurrentDatasetId();
  const currentSourceType = dataSourceManager.getCurrentSourceType();
  if (currentId === datasetId && currentSourceType === sourceType) {
    if (ownsDatasetSelectionIntent(intentOwner)) {
      synchronizeDatasetSelectToCurrent();
      showSessionStatus('Dataset loaded', false);
    }
    return true;
  }

  let datasetReloaded = false;
  try {
    datasetInfo.classList.remove('error');
    datasetInfo.classList.add('loading');
    datasetCellsEl.textContent = '…';
    datasetGenesEl.textContent = '…';

    showSessionStatus('Switching dataset...', false);

    const source = sourceOverride ?? dataSourceManager.getSource(sourceType);
    if (source === null) {
      throw new Error(
        `Dataset source "${sourceType}" is not registered or staged.`
      );
    }
    const ready = await trackWork(reloadDataset({
        datasetId,
        loadMethod,
        source,
        sourceType
      }));
    if (!ownsDatasetSelectionIntent(intentOwner)) {
      return ready === true;
    }
    if (ready !== true) {
      throw new Error(
        'Dataset activation did not publish one ready generation.'
      );
    }

    const metadata = dataSourceManager.getCurrentMetadata();
    const adoptedDatasetId = dataSourceManager.getCurrentDatasetId();
    const adoptedSourceType = dataSourceManager.getCurrentSourceType();
    if (
      adoptedDatasetId !== datasetId ||
      adoptedSourceType !== sourceType
    ) {
      throw new Error(
        'Dataset manager did not publish the requested source and dataset.'
      );
    }
    requireDatasetMetadata(metadata, sourceType, 'Selected dataset metadata');
    if (metadata.id !== datasetId) {
      throw new Error(
        'Selected dataset metadata id does not match the requested dataset.'
      );
    }

    datasetReloaded = true;
    if (!ownsDatasetSelectionIntent(intentOwner)) {
      return true;
    }
    updateDatasetInfo(metadata, sourceType);
    datasetInfo.classList.remove('loading', 'error');
    showSessionStatus('Dataset loaded', false);
    return true;
  } catch (error) {
    if (isDatasetReloadSupersededError(error)) {
      throw error;
    }
    if (!ownsDatasetSelectionIntent(intentOwner)) {
      return false;
    }
    const exactError = errorFromUnknown(error, 'Dataset switch');
    datasetInfo.classList.remove('loading');
    datasetInfo.classList.add('error');
    const activeMetadata = dataSourceManager.getCurrentMetadata();
    const activeSourceType = dataSourceManager.getCurrentSourceType();
    const activeDatasetId = dataSourceManager.getCurrentDatasetId();
    if (
      activeMetadata !== null &&
      activeSourceType !== null &&
      activeDatasetId !== null
    ) {
      requireDatasetMetadata(
        activeMetadata,
        activeSourceType,
        'Active dataset metadata after switch failure'
      );
      updateDatasetInfo(activeMetadata, activeSourceType);
      datasetInfo.classList.add('error');
    }
    const prefix = datasetReloaded
      ? 'Dataset loaded, but URL state failed'
      : 'Failed to switch dataset';
    showSessionStatus(`${prefix}: ${exactError.message}`, true);
    return false;
  }
}

async function handleDatasetChange(
  datasetId,
  sourceType,
  loadMethod = DATA_LOAD_METHODS.DATASET_DROPDOWN,
  sourceOverride = null
) {
  requireNonEmptyString(datasetId, 'Selected dataset id');
  requireNonEmptyString(sourceType, 'Selected dataset source type');
  if (
    dataSourceManager.getCurrentDatasetId() === datasetId &&
    dataSourceManager.getCurrentSourceType() === sourceType
  ) {
    return true;
  }
  return await handleDatasetChangeForIntent(
    datasetId,
    sourceType,
    loadMethod,
    sourceOverride,
    beginDatasetSelectionIntent()
  );
}

/**
 * Handle selecting the exact None state.
 *
 * @returns {Promise<boolean>} Whether the dataset and UI were fully cleared
 */
async function handleNoneDatasetSelectionForIntent(intentOwner) {
  try {
    datasetInfo.classList.remove('error');
    datasetInfo.classList.add('loading');
    showSessionStatus('Clearing dataset...', false);

    const cleared = await trackWork(clearDataset());
    if (!ownsDatasetSelectionIntent(intentOwner)) {
      return cleared === true;
    }
    if (cleared !== true) {
      throw new Error(
        'Dataset clear did not publish one ready None generation.'
      );
    }
    if (
      dataSourceManager.getCurrentDatasetId() !== null ||
      dataSourceManager.getCurrentSourceType() !== null ||
      dataSourceManager.getCurrentMetadata() !== null
    ) {
      throw new Error(
        'Dataset manager did not publish the exact None state.'
      );
    }

    if (!ownsDatasetSelectionIntent(intentOwner)) {
      return true;
    }
    refreshDatasetUI(null);
    ensureNoneDatasetOption();
    datasetSelect.value = NONE_DATASET_VALUE;
    if (datasetSelect.value !== NONE_DATASET_VALUE) {
      throw new Error('Dataset select could not represent the None state.');
    }
    datasetSelect.disabled = false;
    datasetInfo.classList.remove('loading', 'error');
    showSessionStatus('No dataset selected', false);
    return true;
  } catch (error) {
    if (isDatasetReloadSupersededError(error)) {
      throw error;
    }
    if (!ownsDatasetSelectionIntent(intentOwner)) {
      return false;
    }
    const exactError = errorFromUnknown(error, 'Dataset clear');
    datasetInfo.classList.remove('loading');
    datasetInfo.classList.add('error');
    showSessionStatus(
      `Failed to clear dataset: ${exactError.message}`,
      true
    );
    return false;
  }
}

function handleNoneDatasetSelection() {
  return handleNoneDatasetSelectionForIntent(
    beginDatasetSelectionIntent()
  );
}

function synchronizeDatasetEvent(rawEvent) {
  if (destroyed) return;
  const event = requireDatasetEvent(rawEvent);
  if (
    (event.previousDatasetId === null) !==
    (event.previousSourceType === null)
  ) {
    throw new TypeError(
      'Dataset change event previous id and source type must be published together.'
    );
  }

  if (event.datasetId === null) {
    ensureNoneDatasetOption();
    datasetSelect.value = NONE_DATASET_VALUE;
    if (datasetSelect.value !== NONE_DATASET_VALUE) {
      throw new Error('Dataset select could not represent the None state.');
    }
    updateDatasetInfo(null);
    return;
  }

  const selectionValue = datasetSelectionValue(
    event.sourceType,
    event.datasetId
  );
  let option = datasetOptionsByKey.get(selectionValue);
  if (option === undefined) {
    option = createDatasetOption(event.metadata, event.sourceType);
    datasetSelect.appendChild(option);
  }
  datasetSelect.value = selectionValue;
  if (datasetSelect.value !== selectionValue) {
    throw new Error(
      `Dataset select could not represent "${event.sourceType}/${event.datasetId}".`
    );
  }
  datasetSelect.disabled = false;
  updateDatasetInfo(event.metadata, event.sourceType);
}

function synchronizeDatasetSelectToCurrent() {
  const activeMetadata = dataSourceManager.getCurrentMetadata();
  const activeSourceType = dataSourceManager.getCurrentSourceType();
  const activeDatasetId = dataSourceManager.getCurrentDatasetId();
  const ownsDataset =
    activeMetadata !== null &&
    activeSourceType !== null &&
    activeDatasetId !== null;
  const ownsNone =
    activeMetadata === null &&
    activeSourceType === null &&
    activeDatasetId === null;
  if (!ownsDataset && !ownsNone) {
    throw new Error(
      'Dataset manager published a partial active selection after reload.'
    );
  }
  if (ownsDataset) {
    requireDatasetMetadata(
      activeMetadata,
      activeSourceType,
      'Active dataset metadata after selection settlement'
    );
    if (activeMetadata.id !== activeDatasetId) {
      throw new Error(
        'Active dataset metadata does not match its selected dataset id.'
      );
    }
    const value = datasetSelectionValue(
      activeSourceType,
      activeDatasetId
    );
    updateDatasetInfo(activeMetadata, activeSourceType);
    datasetSelect.value = value;
    if (datasetSelect.value !== value) {
      throw new Error(
        'Dataset select cannot represent the active dataset after reload.'
      );
    }
  } else {
    ensureNoneDatasetOption();
    updateDatasetInfo(null);
    datasetSelect.value = NONE_DATASET_VALUE;
    if (datasetSelect.value !== NONE_DATASET_VALUE) {
      throw new Error(
        'Dataset select cannot represent the active None state after reload.'
      );
    }
  }
  datasetSelect.disabled = false;
}

function synchronizeTerminalDatasetSelectionFailure() {
  synchronizeDatasetSelectToCurrent();
  datasetInfo.classList.add('error');
}

async function handleDatasetSelectEvent(event) {
  const intentOwner = beginDatasetSelectionIntent();
  try {
    if (
      event === null ||
      typeof event !== 'object' ||
      event.currentTarget !== datasetSelect
    ) {
      throw new TypeError(
        'Dataset change DOM event must be owned by the dataset select.'
      );
    }
    if (
      datasetSelect.selectedOptions === null ||
      typeof datasetSelect.selectedOptions !== 'object' ||
      datasetSelect.selectedOptions.length !== 1
    ) {
      throw new Error(
        'Dataset select must publish exactly one selected option.'
      );
    }
    const selectedOption = datasetSelect.selectedOptions[0];
    requireElement(selectedOption, 'Selected dataset option');
    if (selectedOption.value !== datasetSelect.value) {
      throw new Error(
        'Selected dataset option must own the select value.'
      );
    }

    const selectedValue = selectedOption.value;
    if (selectedValue === NONE_DATASET_VALUE) {
      const cleared = await handleNoneDatasetSelectionForIntent(
        intentOwner
      );
      if (!ownsDatasetSelectionIntent(intentOwner)) {
        return;
      }
      if (cleared !== true) {
        synchronizeTerminalDatasetSelectionFailure();
      }
      return;
    }
    if (
      selectedValue === LOADING_DATASET_VALUE ||
      selectedValue === EMPTY_CATALOG_VALUE ||
      selectedValue === CATALOG_ERROR_VALUE
    ) {
      throw new Error('A non-selectable dataset status option was selected.');
    }

    const sourceType = requireNonEmptyString(
      selectedOption.dataset.sourceType,
      'Selected dataset option source type'
    );
    const datasetId = requireNonEmptyString(
      selectedOption.dataset.datasetId,
      'Selected dataset option id'
    );
    if (selectedValue !== datasetSelectionValue(sourceType, datasetId)) {
      throw new Error(
        'Selected dataset option value does not match its exact source and id.'
      );
    }
    const ready = await handleDatasetChangeForIntent(
      datasetId,
      sourceType,
      DATA_LOAD_METHODS.DATASET_DROPDOWN,
      null,
      intentOwner
    );
    if (!ownsDatasetSelectionIntent(intentOwner)) {
      return;
    }
    if (ready !== true) {
      synchronizeTerminalDatasetSelectionFailure();
    }
  } catch (error) {
    if (!ownsDatasetSelectionIntent(intentOwner)) {
      return;
    }
    if (isDatasetReloadSupersededError(error)) {
      datasetInfo.classList.remove('loading', 'error');
      synchronizeDatasetSelectToCurrent();
      showSessionStatus(
        'A newer dataset selection is now active.',
        false
      );
      return;
    }
    const exactError = errorFromUnknown(error, 'Dataset selection event');
    datasetInfo.classList.remove('loading');
    datasetInfo.classList.add('error');
    synchronizeTerminalDatasetSelectionFailure();
    showSessionStatus(
      `Dataset selection failed: ${exactError.message}`,
      true
    );
  }
}

  const initialMetadata = dataSourceManager.getCurrentMetadata();
  const initialDatasetId = dataSourceManager.getCurrentDatasetId();
  const initialSourceType = dataSourceManager.getCurrentSourceType();
  if (
    initialMetadata === null
    && initialDatasetId === null
    && initialSourceType === null
  ) {
    updateDatasetInfo(null);
  } else {
    if (
      initialMetadata === null
      || initialDatasetId === null
      || initialSourceType === null
    ) {
      throw new TypeError(
        'Initial dataset state must be either complete or the exact None state.'
      );
    }
    requireDatasetMetadata(
      initialMetadata,
      initialSourceType,
      'Initial dataset metadata'
    );
    if (initialMetadata.id !== initialDatasetId) {
      throw new TypeError(
        'Initial dataset metadata id must equal the manager dataset id.'
      );
    }
    updateDatasetInfo(initialMetadata, initialSourceType);
  }

  const catalogReady = trackWork(populateDatasetDropdown());

  dataSourceManager.onDatasetChange(synchronizeDatasetEvent);
  function handleDatasetSelectDomEvent(event) {
    if (destroyed) return;
    void invokeTracked(() => handleDatasetSelectEvent(event));
  }
  datasetSelect.addEventListener(
    'change',
    handleDatasetSelectDomEvent,
    { signal: lifecycleController.signal }
  );
  datasetConnections = initDatasetConnections({
    activateDataset: (...args) =>
      invokeTracked(() => handleDatasetChange(...args)),
    clearDataset: () =>
      invokeTracked(() => handleNoneDatasetSelection()),
    dom,
    dataSourceManager,
    populateDatasetDropdown: () =>
      invokeTracked(() => populateDatasetDropdown()),
    noneDatasetValue: NONE_DATASET_VALUE
  });

  function destroy() {
    if (destroyPromise !== null) return destroyPromise;
    destroyed = true;
    catalogGeneration =
      catalogGeneration === Number.MAX_SAFE_INTEGER
        ? 1
        : catalogGeneration + 1;
    datasetSelectionIntentGeneration =
      datasetSelectionIntentGeneration === Number.MAX_SAFE_INTEGER
        ? 1
        : datasetSelectionIntentGeneration + 1;
    activeDatasetSelectionIntent = null;
    const cleanupErrors = [];
    try {
      lifecycleController.abort();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      dataSourceManager.offDatasetChange(synchronizeDatasetEvent);
    } catch (error) {
      cleanupErrors.push(error);
    }

    let connectionDrain;
    try {
      connectionDrain = datasetConnections.destroy();
    } catch (error) {
      cleanupErrors.push(error);
      connectionDrain = Promise.resolve();
    }
    const operationDrain = Promise.allSettled([...activeWork]);
    destroyPromise = Promise.allSettled([
      operationDrain,
      connectionDrain
    ]).then(results => {
      const connectionResult = results[1];
      if (connectionResult.status === 'rejected') {
        cleanupErrors.push(connectionResult.reason);
      }
      if (cleanupErrors.length === 1) throw cleanupErrors[0];
      if (cleanupErrors.length > 1) {
        throw new AggregateError(
          cleanupErrors,
          'Dataset controls could not release every owner.'
        );
      }
    });
    return destroyPromise;
  }

  return {
    catalogReady,
    clearDataset: () =>
      invokeTracked(() => handleNoneDatasetSelection()),
    destroy,
    populateDatasetDropdown: () =>
      invokeTracked(() => populateDatasetDropdown()),
    refreshDatasetUI,
    selectDataset: (...args) =>
      invokeTracked(() => handleDatasetChange(...args))
  };
}
