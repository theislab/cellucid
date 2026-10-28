/**
 * @fileoverview Dataset selection and data-source connection UI.
 *
 * Handles:
 * - The sample dataset dropdown, and the Dataset box (`dataset-card.js`),
 *   which always describes the dataset that is open, or none
 * - Local files and folders, a server and links (`dataset-connections.js`)
 *
 * The dropdown lists the datasets of one source: a connected catalog that
 * holds several (named in its label, "Dataset from <host>"), else the
 * samples. A dataset opened from a file, a single-dataset link or a server is
 * not a choice there, so while one is open the dropdown shows "—" and the
 * Dataset box names it. Disconnecting a catalog brings the samples back.
 *
 * This module is UI-only and calls back into the coordinator for dataset-wide
 * refresh hooks (field dropdowns, gene search, dimension options, etc.).
 *
 * @module ui/modules/dataset-controls
 */

import {
  validateDatasetIdentity,
  validateDatasetSummary
} from '../../../data/data-source.js';
import { formatCompactCount } from '../components/display-format.js';
import { DATA_LOAD_METHODS } from '../../data-load-methods.js';
import { debug } from '../../../utils/debug.js';
import { isDatasetReloadSupersededError } from '../../dataset-reload-outcome.js';
import {
  classifyDataSourceFailure,
  dataSourceFailureDetails,
  describeDataSourceFailure,
  initDatasetConnections
} from './dataset-connections.js';
import { isPlainRecord, requireExactKeys, requirePlainRecord } from '../../../utils/exact-record.js';
import { formatOpenCells } from '../../../utils/format-units.js';

export const NONE_DATASET_VALUE = '__none__';
/** What the dropdown shows while the open dataset is not one of its choices. */
export const UNLISTED_DATASET_VALUE = '__dataset_unlisted__';
const UNLISTED_DATASET_LABEL = '—';
const OPENING_OPTION_SUFFIX = '· opening…';
const CLOSING_DATASET_LABEL = 'Closing the dataset…';
const SAMPLE_PICKER_LABEL = 'Sample dataset';

const LOADING_DATASET_VALUE = '__catalog_loading__';
// Stands in the select for a choice that has no catalog option yet — a file
// being read, a connection opening its only dataset, the startup selection
// before the catalog is listed — so the select always shows what is loading.
const PENDING_DATASET_VALUE = '__dataset_pending__';
/** Connections: their datasets are offered when they list several. */
const CONNECTION_SOURCE_TYPES = new Set(['link', 'remote', 'jupyter']);
const EMPTY_CATALOG_VALUE = '__catalog_empty__';
const CATALOG_ERROR_VALUE = '__catalog_error__';
const CATALOG_RETRY_LABEL = 'Try again';
const CATALOG_RETRYING_LABEL = 'Retrying…';
// Enumerating the sources is the manager's own contract work, so it fails only
// when that contract is broken — never for a reason the UI could name. The
// notice says what happened and offers the way out; it invents no cause.
const CATALOG_TOTAL_FAILURE_MESSAGE =
  'The dataset list could not be loaded. Try again; if it keeps failing, ' +
  'reload the page.';

/**
 * One human name per registered source type, used both for the dropdown's
 * group headings and for the recovery notice, so a source is called the same
 * thing wherever the user meets it.
 */
const SOURCE_DISPLAY_NAMES = {
  // A host program's viewer is named after the program once its server says
  // which (`hostSourceName`); this is the name before it has.
  jupyter: 'Viewer data',
  link: 'Linked data',
  'local-demo': 'Sample datasets',
  'local-user': 'Your data',
  remote: 'Remote server data'
};

const DATASET_CONTROL_KEYS = [
  'callbacks',
  'clearDataset',
  'dataSourceManager',
  'datasetCard',
  'datasetChanges',
  'dom',
  'reloadDataset',
  'resizeOpenCells'
];
const DATASET_CALLBACK_KEYS = [
  'clearGeneSelection',
  'initGeneExpressionDropdown',
  'refreshUIForActiveView',
  'renderDeletedFieldsSection',
  'renderFieldSelects',
  'showSessionStatus',
  'renderRepresentationPicker'
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

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

/** The source type that opens each kind of recorded session source. */
const RECORDED_SOURCE_TYPES = Object.freeze({
  sample: 'local-demo',
  link: 'link',
  remote: 'remote'
});

function sourceDisplayName(sourceType) {
  requireNonEmptyString(sourceType, 'Dataset source type');
  return Object.hasOwn(SOURCE_DISPLAY_NAMES, sourceType)
    ? SOURCE_DISPLAY_NAMES[sourceType]
    : sourceType;
}

function formatSourceList(names) {
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
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

/**
 * What the dataset list shows about one dataset (`DatasetSummary`): a
 * catalog's description of a file, or an open dataset's identity.
 */
function requireDatasetSummary(summary, sourceType, name) {
  requirePlainRecord(summary, name);
  requireNonEmptyString(sourceType, `${name} sourceType`);
  validateDatasetSummary(summary, sourceType);
  return summary;
}

function requireDatasetMetadata(metadata, sourceType, name) {
  requirePlainRecord(metadata, name);
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
      ['datasets', 'error', 'sourceType'],
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
    // A source that could not be probed reports its own failure and no
    // datasets. A source that is merely unavailable is never reported at all,
    // so these two states are already distinct before the UI sees them.
    if (record.error !== null && !(record.error instanceof Error)) {
      throw new TypeError(
        `Dataset catalog source "${record.sourceType}" error must be an Error or null.`
      );
    }
    if (record.error !== null && record.datasets.length !== 0) {
      throw new TypeError(
        `Dataset catalog source "${record.sourceType}" cannot report both datasets and a failure.`
      );
    }
    const datasets = record.datasets.map((metadata, datasetIndex) => {
      requireDatasetSummary(
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
    return { sourceType: record.sourceType, datasets, error: record.error };
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
    datasetCard,
    datasetChanges,
    clearDataset,
    reloadDataset,
    resizeOpenCells,
    callbacks
  } = options;
  requirePlainRecord(dom, 'Dataset controls DOM');
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
  if (typeof resizeOpenCells !== 'function') {
    throw new TypeError('Dataset controls resizeOpenCells must be a function.');
  }
  if (typeof clearDataset !== 'function') {
    throw new TypeError('Dataset controls clearDataset must be a function.');
  }
  if (
    datasetChanges === null ||
    typeof datasetChanges !== 'object' ||
    typeof datasetChanges.begin !== 'function' ||
    typeof datasetChanges.beginIfNoActionSince !== 'function' ||
    typeof datasetChanges.whenSettled !== 'function' ||
    typeof datasetChanges.settled !== 'boolean' ||
    !Number.isSafeInteger(datasetChanges.actionSequence)
  ) {
    throw new TypeError(
      'Dataset controls require the dataset-change coordinator.'
    );
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
    renderRepresentationPicker,
    showSessionStatus
  } = callbacks;

  const { select: datasetSelect } = dom;
  requireElement(datasetSelect, 'Dataset select', [
    'addEventListener',
    'appendChild',
    'replaceChildren'
  ]);
  for (const method of [
    'show',
    'showLoading',
    'showNone',
    'refreshFacts',
    'showLoadedConnectivityEdges'
  ]) {
    requireMethod(datasetCard, method, 'Dataset box');
  }
  const ownerDocument = datasetSelect.ownerDocument;
  if (
    ownerDocument === null ||
    typeof ownerDocument !== 'object' ||
    typeof ownerDocument.createElement !== 'function'
  ) {
    throw new TypeError('Dataset select must provide an ownerDocument.');
  }
  // The recovery notice explains the selector standing next to it, so it lives
  // in the selector's own control block rather than in the dataset info panel,
  // which describes the dataset that is currently loaded.
  const datasetSelectBlock = datasetSelect.parentNode;
  requireElement(datasetSelectBlock, 'Dataset select control block', [
    'appendChild'
  ]);
  const datasetOptionsByKey = new Map();
  const lifecycleController = new AbortController();
  const activeWork = new Set();
  let noneDatasetOption = null;
  let unlistedDatasetOption = null;
  let catalogGeneration = 0;
  // The dataset choice these controls are presenting: the newest change the
  // user made here, while it loads. Null once it has settled.
  let activeDatasetSelectionIntent = null;
  let pendingDatasetOption = null;
  // The catalog option of the dataset being opened: its label says so.
  let openingDatasetOption = null;
  let datasetConnections = null;
  let catalogRetryInFlight = false;
  // Whether the samples' files are read for the picker (their names and
  // cell counts): from the start when no link or server is connected, else
  // once the person reaches for the picker (`describeListedSamples`).
  let samplesWanted = false;
  // The samples the picker lists by their `datasets.json` entries only,
  // while their files are not read; false once they are described.
  let samplesListedAsEntries = false;
  // The operation the visible notice offers to repeat, or null when nothing
  // has failed. A notice without one would be an affordance that does nothing.
  let noticeRetry = null;
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

  /**
   * Begin one dataset change for a choice the user just made. The
   * transaction is begun before any of the choice's own work, so the load in
   * flight — whoever started it — is aborted at once and can neither keep
   * fetching nor publish late over this choice. `pending` says what the select
   * shows while it loads: the catalog option it names, or a stand-in carrying
   * its label.
   *
   * @param {{value: string|null, label: string}} pending
   */
  function beginDatasetSelectionIntent(pending) {
    assertAlive();
    return adoptDatasetSelectionIntent(datasetChanges.begin(), pending);
  }

  /**
   * Begin the change only if the user did nothing that decides the dataset
   * since `sequence` was read: a connection that turns out to hold one
   * dataset replaces the loads that were running when the user clicked
   * Connect, but never a choice made or a session applied after that.
   */
  function beginDatasetSelectionIntentIfNoActionSince(sequence, pending) {
    assertAlive();
    const transaction = datasetChanges.beginIfNoActionSince(sequence);
    return transaction === null
      ? null
      : adoptDatasetSelectionIntent(transaction, pending);
  }

  function adoptDatasetSelectionIntent(transaction, pending) {
    requirePendingSelection(pending);
    const intent = Object.freeze({ pending, transaction });
    activeDatasetSelectionIntent = intent;
    presentPendingSelection();
    return intent;
  }

  function requirePendingSelection(pending) {
    requireExactKeys(pending, ['label', 'value'], 'Pending dataset selection');
    if (pending.value !== null) {
      requireNonEmptyString(pending.value, 'Pending dataset selection value');
    }
    requireNonEmptyString(pending.label, 'Pending dataset selection label');
  }

  /**
   * True while `owner` is the newest dataset change of all — not only of the
   * ones made here: the benchmark and startup begin theirs in the bootstrap.
   */
  function ownsDatasetSelectionIntent(owner) {
    return (
      !destroyed &&
      owner === activeDatasetSelectionIntent &&
      owner.transaction.isLatest()
    );
  }

  function removePendingDatasetOption() {
    if (pendingDatasetOption === null) return false;
    const shown = pendingDatasetOption.selected;
    pendingDatasetOption.remove();
    pendingDatasetOption = null;
    return shown;
  }

  function catalogIsPopulating() {
    return datasetSelect.value === LOADING_DATASET_VALUE;
  }

  /**
   * Show the active intent's choice in the select while it loads. A listing
   * still in progress presents it when it finishes.
   */
  function presentPendingSelection() {
    const intent = activeDatasetSelectionIntent;
    if (destroyed || intent === null) return;
    datasetCard.showLoading(intent.pending.label);
    if (catalogIsPopulating()) return;
    removePendingDatasetOption();
    retireUnlistedDatasetOption();
    const option = intent.pending.value === null
      ? undefined
      : intent.pending.value === NONE_DATASET_VALUE
        ? ensureNoneDatasetOption()
        : datasetOptionsByKey.get(intent.pending.value);
    if (option !== undefined) {
      datasetSelect.value = option.value;
      markOpeningOption(option === noneDatasetOption ? null : option);
    } else {
      markOpeningOption(null);
      pendingDatasetOption = ownerDocument.createElement('option');
      pendingDatasetOption.value = PENDING_DATASET_VALUE;
      pendingDatasetOption.disabled = true;
      // A file, a link or a server being opened is not a choice of the
      // dropdown: it shows "—", and the Dataset box says what is opening.
      pendingDatasetOption.textContent = UNLISTED_DATASET_LABEL;
      datasetSelect.appendChild(pendingDatasetOption);
      pendingDatasetOption.selected = true;
    }
  }

  /**
   * End one intent. Its transaction no longer holds back a session waiting
   * for the dataset, and when nothing newer took its place the select stops
   * showing it. An intent overtaken by a change made outside these controls
   * (the benchmark) has to put the select back itself: nothing else will.
   */
  function settleDatasetSelectionIntent(intent) {
    intent.transaction.finish();
    if (destroyed || activeDatasetSelectionIntent !== intent) return;
    activeDatasetSelectionIntent = null;
    markOpeningOption(null);
    const pendingWasShown = removePendingDatasetOption();
    if (catalogIsPopulating()) return;
    if (!intent.transaction.isLatest() || pendingWasShown) {
      synchronizeDatasetSelectToCurrent();
    }
  }

  async function runDatasetSelectionIntent(intent, operation) {
    try {
      return await operation(intent);
    } finally {
      settleDatasetSelectionIntent(intent);
    }
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

  /**
   * The sources whose datasets the dropdown offers. It lists one source at a
   * time: a connected catalog that holds several datasets (a link, a
   * server), else the samples. A file from this computer, or a connection
   * that holds one dataset, is never a choice there: the Dataset box names it.
   */
  function pickerSourcesOf(records) {
    const catalogs = records.filter(record =>
      CONNECTION_SOURCE_TYPES.has(record.sourceType) && record.datasets.length > 1
    );
    if (catalogs.length > 0) return catalogs;
    return records.filter(record =>
      record.sourceType === 'local-demo' && record.datasets.length > 0
    );
  }

  /** Name the dropdown by what it lists: the samples, or a catalog's host. */
  function labelPicker(sources) {
    const label = datasetSelect.labels?.[0] ?? null;
    if (label === null) return;
    const catalog = sources.find(record => record.sourceType !== 'local-demo');
    const text = catalog === undefined
      ? SAMPLE_PICKER_LABEL
      : `Dataset from ${connectionName(catalog.sourceType)}`;
    if (label.textContent !== text) label.textContent = text;
  }

  /**
   * A source's name: a host program's viewer is named after the program
   * ("R data", "Viewer host data", "Python data"), any other source as listed.
   */
  function hostSourceName(sourceType) {
    const source = dataSourceManager.getSource(sourceType) ?? null;
    const host = typeof source?.getHostLabel === 'function' ? source.getHostLabel() : null;
    return typeof host === 'string' ? `${host} data` : sourceDisplayName(sourceType);
  }

  /** The host (or name) of one connected source, as the picker names it. */
  function connectionName(sourceType) {
    const info = dataSourceManager.getSource(sourceType)?.getConnectionInfo?.() ?? null;
    const address = info?.baseUrl ?? info?.url ?? info?.locator ?? null;
    if (typeof address === 'string') {
      try {
        return new URL(address).host;
      } catch {
        return address;
      }
    }
    return hostSourceName(sourceType).toLowerCase();
  }

  function ensureUnlistedDatasetOption() {
    if (unlistedDatasetOption === null) {
      unlistedDatasetOption = ownerDocument.createElement('option');
      unlistedDatasetOption.value = UNLISTED_DATASET_VALUE;
      unlistedDatasetOption.disabled = true;
      unlistedDatasetOption.textContent = UNLISTED_DATASET_LABEL;
      datasetSelect.appendChild(unlistedDatasetOption);
    }
    return unlistedDatasetOption;
  }

  function retireUnlistedDatasetOption() {
    if (unlistedDatasetOption === null) return;
    unlistedDatasetOption.remove();
    unlistedDatasetOption = null;
  }

  /**
   * Show one open dataset in the dropdown: its own option, or "—" when the
   * dropdown does not offer it.
   */
  function selectDatasetOption(sourceType, datasetId) {
    const value = datasetSelectionValue(sourceType, datasetId);
    if (datasetOptionsByKey.has(value)) {
      retireUnlistedDatasetOption();
      datasetSelect.value = value;
      if (datasetSelect.value !== value) {
        throw new Error(
          `Dataset select could not represent "${sourceType}/${datasetId}".`
        );
      }
      return;
    }
    ensureUnlistedDatasetOption();
    datasetSelect.value = UNLISTED_DATASET_VALUE;
    if (datasetSelect.value !== UNLISTED_DATASET_VALUE) {
      throw new Error(
        `Dataset select could not represent "${sourceType}/${datasetId}" as unlisted.`
      );
    }
  }

  function createDatasetOption(metadata, sourceType) {
    requireDatasetSummary(metadata, sourceType, 'Dataset option metadata');
    const option = createListedOption(
      sourceType,
      metadata.id,
      metadata.name,
      datasetOptionLabel(metadata, sourceType)
    );
    option.dataset.cells = String(metadata.stats.n_cells);
    return option;
  }

  /**
   * What the picker says of one described dataset: its name and cell count;
   * while a subsample of it is open, the open cells of every cell
   * (`formatOpenCells`), as every count of them is said.
   */
  function datasetOptionLabel(metadata, sourceType) {
    const subset = openSubsetOf(sourceType, metadata.id);
    const cells = subset === null
      ? formatOpenCells(metadata.stats.n_cells, null, formatCompactCount)
      : formatOpenCells(subset.kept.length, subset.nObs, formatCompactCount);
    return `${metadata.name} (${cells})`;
  }

  /** The open subsample of this dataset (`getCellSubset`), or null: it is not open, or every cell of it is. */
  function openSubsetOf(sourceType, datasetId) {
    if (dataSourceManager.getCurrentSourceType() !== sourceType || dataSourceManager.getCurrentDatasetId() !== datasetId) return null;
    const source = dataSourceManager.getSource(sourceType);
    const annData = typeof source?.getAnnDataSource === 'function' ? source.getAnnDataSource(datasetId) : null;
    const subset = typeof annData?.getCellSubset === 'function' ? annData.getCellSubset() : null;
    return subset?.kept != null ? subset : null;
  }

  /** Say each described dataset's cells again: the open cells changed, or another dataset is open. */
  function relabelDatasetOptions() {
    for (const option of datasetOptionsByKey.values()) {
      if (option.dataset.cells === undefined) continue;
      const label = datasetOptionLabel(
        { id: option.dataset.datasetId, name: option.dataset.datasetName, stats: { n_cells: Number(option.dataset.cells) } },
        option.dataset.sourceType
      );
      option.dataset.label = label;
      option.textContent = option === openingDatasetOption ? `${label} ${OPENING_OPTION_SUFFIX}` : label;
    }
  }

  /**
   * One entry of a catalog whose files are not described yet: its id and
   * the name its path gives it, without counts.
   */
  function createCatalogEntryOption(entry, sourceType) {
    requireExactKeys(entry, ['id', 'name'], 'Dataset catalog entry');
    requireNonEmptyString(entry.id, 'Dataset catalog entry id');
    requireNonEmptyString(entry.name, 'Dataset catalog entry name');
    return createListedOption(sourceType, entry.id, entry.name, entry.name);
  }

  function createListedOption(sourceType, datasetId, name, label) {
    const value = datasetSelectionValue(sourceType, datasetId);
    if (datasetOptionsByKey.has(value)) {
      throw new Error(
        `Dataset option "${sourceType}/${datasetId}" already exists.`
      );
    }
    const option = ownerDocument.createElement('option');
    option.value = value;
    option.dataset.sourceType = sourceType;
    option.dataset.datasetId = datasetId;
    // Kept apart from the label so a failure message can name the dataset
    // without the cell count the dropdown appends.
    option.dataset.datasetName = name;
    option.dataset.label = label;
    option.textContent = label;
    datasetOptionsByKey.set(value, option);
    return option;
  }

  /** Label `option` (or none) as the dataset being opened. */
  function markOpeningOption(option) {
    if (openingDatasetOption === option) return;
    if (openingDatasetOption !== null) {
      openingDatasetOption.textContent = openingDatasetOption.dataset.label;
    }
    openingDatasetOption = option;
    if (option !== null) {
      option.textContent = `${option.dataset.label} ${OPENING_OPTION_SUFFIX}`;
    }
  }

  /** The select's options are being replaced: forget the ones it held. */
  function forgetDatasetOptions() {
    datasetOptionsByKey.clear();
    noneDatasetOption = null;
    unlistedDatasetOption = null;
    openingDatasetOption = null;
  }

  /** Whether a link or a server is connected (`CONNECTION_SOURCE_TYPES`). */
  function hasConnection() {
    for (const sourceType of CONNECTION_SOURCE_TYPES) {
      if (dataSourceManager.getSource(sourceType)?.isConnected?.() === true) return true;
    }
    return false;
  }

  /**
   * The samples as `datasets.json` lists them, as one listing record
   * (`{sourceType, datasets, error}`, the datasets `{id, name}` entries),
   * or null when the page has no sample catalog.
   */
  async function listSampleEntries() {
    const samples = dataSourceManager.getSource('local-demo');
    if (typeof samples?.listCatalogEntries !== 'function') return null;
    try {
      if (!(await samples.isAvailable())) return null;
      return { sourceType: 'local-demo', datasets: [...await samples.listCatalogEntries()], error: null };
    } catch (error) {
      return { sourceType: 'local-demo', datasets: [], error: errorFromUnknown(error, 'Sample catalog') };
    }
  }

  /**
   * The person reached for the picker while it lists the samples by their
   * entries: their files are read now, and each option gains its name and
   * cell count in place (the open list stays open). From now on every
   * listing describes them.
   */
  async function describeListedSamples() {
    if (samplesWanted) return;
    samplesWanted = true;
    if (!samplesListedAsEntries) return;
    const generation = catalogGeneration;
    const samples = dataSourceManager.getSource('local-demo');
    let datasets;
    try {
      datasets = await samples.listDatasets();
    } catch (error) {
      if (!ownsCatalogGeneration(generation)) return;
      setCatalogNotice(
        describeFailedSources([{ sourceType: 'local-demo', datasets: [], error: errorFromUnknown(error, 'Sample catalog') }]),
        retryCatalog
      );
      return;
    }
    if (!ownsCatalogGeneration(generation)) return;
    samplesListedAsEntries = false;
    for (const metadata of datasets) {
      requireDatasetSummary(metadata, 'local-demo', 'Dataset option metadata');
      const option = datasetOptionsByKey.get(datasetSelectionValue('local-demo', metadata.id));
      if (option === undefined) continue;
      const label = datasetOptionLabel(metadata, 'local-demo');
      option.dataset.datasetName = metadata.name;
      option.dataset.cells = String(metadata.stats.n_cells);
      option.dataset.label = label;
      option.textContent = option === openingDatasetOption ? `${label} ${OPENING_OPTION_SUFFIX}` : label;
    }
  }

  /**
   * The sample catalog's files are read for the listing only once the
   * dataset being opened has its first view, so list the entries
   * `datasets.json` names meanwhile: the select offers them at once and says
   * which one is opening. The full listing replaces them when it arrives.
   */
  async function presentCatalogEntries(generation) {
    const samples = dataSourceManager.getSource('local-demo');
    if (typeof samples?.listCatalogEntries !== 'function') return;
    let entries;
    try {
      entries = await samples.listCatalogEntries();
      // A connected catalog takes the picker (pickerSourcesOf).
      for (const sourceType of CONNECTION_SOURCE_TYPES) {
        const source = dataSourceManager.getSource(sourceType);
        if (typeof source?.isAvailable === 'function' && await source.isAvailable()) {
          return;
        }
      }
    } catch {
      // The full listing reports what failed.
      return;
    }
    if (
      !ownsCatalogGeneration(generation) ||
      !catalogIsPopulating() ||
      !Array.isArray(entries) ||
      entries.length === 0
    ) {
      return;
    }
    labelPicker([{ sourceType: 'local-demo', datasets: entries }]);
    datasetSelect.replaceChildren();
    forgetDatasetOptions();
    ensureNoneDatasetOption();
    for (const entry of entries) {
      datasetSelect.appendChild(createCatalogEntryOption(entry, 'local-demo'));
    }
    const currentId = dataSourceManager.getCurrentDatasetId();
    const currentSourceType = dataSourceManager.getCurrentSourceType();
    if (currentId === null) {
      datasetSelect.value = NONE_DATASET_VALUE;
    } else {
      selectDatasetOption(currentSourceType, currentId);
    }
    datasetSelect.disabled = false;
    presentPendingSelection();
  }

  // =========================================================================
  // Dataset recovery notice
  // =========================================================================
  // One notice owns the last data operation that failed — listing the catalog
  // or opening a dataset — and carries the retry for exactly that operation.
  // It persists until the next data operation succeeds, because a message that
  // fades away leaves a user who looked at the plot instead of the toast with
  // no explanation at all.
  //
  // A source whose probe failed is reported by the manager as an entry that
  // carries an error and no datasets. A source that is merely unavailable —
  // GitHub with no repository connected, a remote server nobody has pointed at
  // — is not reported at all. Those are already distinct states before the UI
  // sees them, so the notice speaks only for genuine failures and an
  // unconfigured source stays silent.
  //
  // On a reload the manager also reports a source whose refresh() failed on
  // that source's entry, so "Dataset list reloaded" is never shown for a
  // reload that did not happen. An unconfigured source has nothing to
  // refresh and resolves, so it stays silent here too.
  const catalogNoticeMessageEl = ownerDocument.createElement('p');
  catalogNoticeMessageEl.classList.add('dataset-notice-message');
  const catalogRetryButton = ownerDocument.createElement('button');
  catalogRetryButton.type = 'button';
  catalogRetryButton.classList.add('btn', 'btn-compact');
  catalogRetryButton.textContent = CATALOG_RETRY_LABEL;
  const catalogNotice = ownerDocument.createElement('div');
  catalogNotice.id = 'dataset-notice';
  catalogNotice.classList.add('dataset-notice');
  catalogNotice.setAttribute('role', 'status');
  catalogNotice.setAttribute('aria-live', 'polite');
  catalogNotice.hidden = true;
  catalogNotice.appendChild(catalogNoticeMessageEl);
  catalogNotice.appendChild(catalogRetryButton);
  datasetSelectBlock.appendChild(catalogNotice);

  /**
   * Publish the notice for one failed operation together with the retry that
   * repeats exactly that operation.
   *
   * @param {string} message
   * @param {() => Promise<unknown>} retry
   */
  function setCatalogNotice(message, retry) {
    requireNonEmptyString(message, 'Dataset catalog notice message');
    if (typeof retry !== 'function') {
      throw new TypeError('Dataset notice retry must be a function.');
    }
    noticeRetry = retry;
    catalogNoticeMessageEl.textContent = message;
    catalogRetryButton.disabled = false;
    catalogRetryButton.textContent = CATALOG_RETRY_LABEL;
    catalogNotice.hidden = false;
  }

  function clearCatalogNotice() {
    noticeRetry = null;
    catalogNoticeMessageEl.textContent = '';
    catalogRetryButton.disabled = false;
    catalogRetryButton.textContent = CATALOG_RETRY_LABEL;
    catalogNotice.hidden = true;
  }

  // The retry keeps its own notice on screen while it runs. Hiding it would
  // pull the affordance out from under the pointer that just used it, and the
  // disabled label is the only confirmation the click was registered.
  function markCatalogNoticeRetrying() {
    if (catalogNotice.hidden) return;
    catalogRetryButton.disabled = true;
    catalogRetryButton.textContent = CATALOG_RETRYING_LABEL;
  }

  /**
   * One sentence per cause, naming the sources that share it in the same words
   * the dropdown uses for them. Loader Error messages are transport
   * diagnostics, so they are never shown; the cause the loader published on
   * the error is what reaches the user.
   *
   * @param {{sourceType: string, error: Error|null}[]} records
   * @returns {string|null}
   */
  function describeFailedSources(records) {
    const failed = records.filter(record => record.error !== null);
    if (failed.length === 0) return null;
    // Sources that failed the same way belong in one sentence; sources that
    // failed differently must not be given a shared cause they do not have.
    const byCause = new Map();
    for (const record of failed) {
      const cause = classifyDataSourceFailure(record.error);
      const group = byCause.get(cause);
      const name = hostSourceName(record.sourceType);
      if (group === undefined) {
        byCause.set(cause, { error: record.error, names: [name] });
      } else {
        group.names.push(name);
      }
    }
    return [...byCause.values()]
      .map(group => describeDataSourceFailure(
        formatSourceList(group.names),
        'could not be loaded',
        group.error
      ))
      .join(' ');
  }

  // Retrying the catalog is the refreshing pass: it clears the per-source
  // failures the manager cached, which a plain re-read would keep returning.
  const retryCatalog = () => populateDatasetDropdown({ refresh: true });

  function handleCatalogRetryClick() {
    if (
      destroyed ||
      catalogRetryInFlight ||
      catalogNotice.hidden ||
      noticeRetry === null
    ) {
      return;
    }
    const retry = noticeRetry;
    catalogRetryInFlight = true;
    markCatalogNoticeRetrying();
    // A retry that is superseded settles without publishing an outcome of its
    // own, so the affordance is re-armed here rather than left reading
    // "Retrying…" over an operation nobody is waiting for any more.
    const settle = () => {
      catalogRetryInFlight = false;
      if (destroyed || catalogNotice.hidden) return;
      catalogRetryButton.disabled = false;
      catalogRetryButton.textContent = CATALOG_RETRY_LABEL;
    };
    void invokeTracked(retry).then(settle, settle);
  }

  catalogRetryButton.addEventListener(
    'click',
    handleCatalogRetryClick,
    { signal: lifecycleController.signal }
  );

// =========================================================================
// Dataset Selector
// =========================================================================

/**
 * Show one dataset in the Dataset box, or None.
 * @param {Object|null} metadata - Dataset metadata
 */
function updateDatasetInfo(metadata, sourceTypeOverride = null) {
  if (metadata === null) {
    if (sourceTypeOverride !== null) {
      throw new TypeError(
        'Dataset sourceTypeOverride must be null for the None state.'
      );
    }
    datasetCard.showNone();
    return;
  }
  const sourceType = sourceTypeOverride ??
    dataSourceManager.getCurrentSourceType();
  requireNonEmptyString(sourceType, 'Dataset info source type');
  requireDatasetMetadata(metadata, sourceType, 'Dataset info metadata');
  datasetCard.show(metadata, sourceType);
}

/**
 * The edges of the graph in use were read: an uncounted graph now shows its
 * count.
 *
 * @param {number} edges
 */
function showLoadedConnectivityEdges(edges) {
  assertAlive();
  datasetCard.showLoadedConnectivityEdges(edges);
}

/**
 * The data mapping changed what the dataset uses (its neighbour graph, gene
 * list, latent space or vector fields): the Dataset box says so.
 */
function updateMappedDatasetFacts() {
  assertAlive();
  datasetCard.refreshFacts();
}

/**
 * The dataset shown, its cells grown or cut in place
 * (`app/open-cells-resize.js`): the Dataset box says the cells open now.
 * The fields, the gene search and the views are the dataset's still and
 * stay as they are.
 *
 * @param {Object} metadata - Dataset metadata, the cell count the new one
 */
function refreshOpenCells(metadata) {
  assertAlive();
  updateDatasetInfo(metadata);
  relabelDatasetOptions();
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
  // The picker says the open cells of the dataset open now, every cell of the others.
  relabelDatasetOptions();
  // A new dataset enables its own representations.
  renderRepresentationPicker();
}

/**
 * Populate the dataset dropdown with available datasets from all sources
 *
 * @param {Object} [options]
 * @param {boolean} [options.refresh=false] - Run the pass as a user-visible
 *   retry: cached per-source failures are cleared before the catalogs are
 *   probed again, and the outcome is confirmed in the session status line.
 */
async function populateDatasetDropdown(options = {}) {
  assertAlive();
  requirePlainRecord(options, 'Dataset catalog population options');
  const unsupportedOptions = Object.keys(options).filter(
    key => key !== 'refresh'
  );
  if (unsupportedOptions.length > 0) {
    throw new TypeError(
      'Dataset catalog population options support only: refresh.'
    );
  }
  const refresh = Object.hasOwn(options, 'refresh') ? options.refresh : false;
  if (typeof refresh !== 'boolean') {
    throw new TypeError(
      'Dataset catalog population refresh must be a boolean.'
    );
  }
  const generation = ++catalogGeneration;
  debug.log('[UI] populateDatasetDropdown called', { datasetSelect, dataSourceManager });

  const loadingOption = ownerDocument.createElement('option');
  loadingOption.value = LOADING_DATASET_VALUE;
  loadingOption.disabled = true;
  loadingOption.selected = true;
  loadingOption.textContent = 'Loading datasets…';
  datasetSelect.replaceChildren(loadingOption);
  forgetDatasetOptions();
  datasetSelect.disabled = true;
  if (refresh) {
    markCatalogNoticeRetrying();
  } else {
    clearCatalogNotice();
  }

  try {
    // A link or a server holds the dataset on screen: the samples' files
    // are read only once the person reaches for the picker (or retries).
    const deferSamples = !samplesWanted && !refresh &&
      dataSourceManager.getCurrentSourceType() !== 'local-demo' && hasConnection();
    debug.log('[UI] Calling getAllDatasets...');
    const listing = trackWork(dataSourceManager.getAllDatasets(
      deferSamples ? { refresh, skip: ['local-demo'] } : { refresh }
    ));
    if (!deferSamples) {
      void trackWork(presentCatalogEntries(generation)).catch(error => {
        console.error('[UI] Listing the catalog entries failed:', error);
      });
    }
    const probed = requireCatalog(await listing);
    if (!ownsCatalogGeneration(generation)) {
      return Object.freeze({ status: 'superseded' });
    }
    // Deferred, the samples are listed by their entries when the picker
    // lists them at all (no connected catalog of several datasets).
    const sampleEntries = deferSamples && pickerSourcesOf(probed).length === 0
      ? await listSampleEntries()
      : null;
    if (!ownsCatalogGeneration(generation)) {
      return Object.freeze({ status: 'superseded' });
    }
    samplesListedAsEntries = sampleEntries !== null && sampleEntries.datasets.length > 0;
    const allSourceDatasets = sampleEntries === null ? probed : [...probed, sampleEntries];

    debug.log('[UI] getAllDatasets returned:', allSourceDatasets);

    // A failed source belongs on screen next to the selector it is missing
    // from. It never blocks the sources that answered.
    const failureMessage = describeFailedSources(allSourceDatasets);
    if (failureMessage === null) {
      clearCatalogNotice();
      if (refresh) showSessionStatus('Dataset list reloaded', false);
    } else {
      setCatalogNotice(failureMessage, retryCatalog);
      if (refresh) showSessionStatus(failureMessage, true);
    }

    // The sources whose datasets the dropdown offers.
    const listedSources = pickerSourcesOf(allSourceDatasets);
    labelPicker(listedSources);

    datasetSelect.replaceChildren();
    forgetDatasetOptions();

    ensureNoneDatasetOption();

    if (listedSources.length === 0) {
      const emptyMsg = ownerDocument.createElement('option');
      emptyMsg.value = EMPTY_CATALOG_VALUE;
      emptyMsg.disabled = true;
      emptyMsg.textContent = 'No datasets found';
      datasetSelect.appendChild(emptyMsg);
    } else if (listedSources.length > 1) {
      // One group per source when several offer datasets.
      for (const { sourceType, datasets } of listedSources) {
        const group = ownerDocument.createElement('optgroup');
        group.label = hostSourceName(sourceType);
        for (const dataset of datasets) {
          group.appendChild(createDatasetOption(dataset, sourceType));
        }
        datasetSelect.appendChild(group);
      }
    } else if (listedSources[0] === sampleEntries) {
      for (const entry of sampleEntries.datasets) {
        datasetSelect.appendChild(createCatalogEntryOption(entry, 'local-demo'));
      }
    } else {
      for (const dataset of listedSources[0].datasets) {
        datasetSelect.appendChild(
          createDatasetOption(dataset, listedSources[0].sourceType)
        );
      }
    }

    // Represent the exact active selection: its option, "—" for an open
    // dataset the dropdown does not offer, or None.
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
      // The dataset on screen stays shown when its source could not be
      // listed this time (a sample file that failed to read, while the
      // notice above offers the retry), when its source was not asked
      // (`deferSamples`), or when it was opened while the listing was read:
      // it is the "—" option until a listing offers it.
      selectDatasetOption(currentSourceType, currentId);
      updateDatasetInfo(currentMetadata, currentSourceType);
    } else {
      datasetSelect.value = NONE_DATASET_VALUE;
      if (datasetSelect.value !== NONE_DATASET_VALUE) {
        throw new Error('Dataset select could not represent the None state.');
      }
      updateDatasetInfo(null);
    }
    datasetSelect.disabled = false;
    // A choice still loading is what the select shows, not the dataset it is
    // about to replace.
    presentPendingSelection();
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
    errorOption.textContent = 'Dataset list unavailable';
    datasetSelect.replaceChildren(errorOption);
    forgetDatasetOptions();
    datasetSelect.disabled = true;
    // The whole enumeration failed, so the selector is empty and the only way
    // back used to be a page reload. The notice carries the retry instead;
    // the notification is one sentence, its raw error under Details.
    setCatalogNotice(CATALOG_TOTAL_FAILURE_MESSAGE, retryCatalog);
    debug.error('[UI] The dataset list could not be loaded:', exactError);
    showSessionStatus(
      'The dataset list could not be loaded.',
      true,
      dataSourceFailureDetails(exactError)
    );
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
  loadMethod,
  sourceOverride,
  intentOwner,
  { startup = false } = {}
) {
  requireNonEmptyString(datasetId, 'Selected dataset id');
  requireNonEmptyString(sourceType, 'Selected dataset source type');
  requireNonEmptyString(loadMethod, 'Selected dataset load method');
  if (typeof startup !== 'boolean') {
    throw new TypeError('Dataset change startup must be a boolean.');
  }

  // Choosing the dataset already on screen from its registered source ends
  // whatever load was replacing it: this intent's transaction has already
  // superseded that load. A source the caller hands over (a file just
  // picked, a connection just made) is a new opening even when its dataset
  // states the id of the one on screen -- the same file picked again, or a
  // newer copy of it -- so it is read and shown afresh.
  const currentId = dataSourceManager.getCurrentDatasetId();
  const currentSourceType = dataSourceManager.getCurrentSourceType();
  if (
    sourceOverride === null &&
    currentId === datasetId &&
    currentSourceType === sourceType
  ) {
    if (ownsDatasetSelectionIntent(intentOwner)) {
      synchronizeDatasetSelectToCurrent();
    }
    return true;
  }

  let datasetReloaded = false;
  try {


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
        sourceType,
        startup,
        transaction: intentOwner.transaction
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
    // A dataset is on screen, so no earlier failure to show one is still
    // true; a source the list could not read is still missing from it, and
    // its notice keeps the retry.
    if (noticeRetry !== retryCatalog) clearCatalogNotice();
    // How the change went is the opening progress's to say (its outcome
    // notification): a toast here would say it twice.
    return true;
  } catch (error) {
    if (isDatasetReloadSupersededError(error)) {
      throw error;
    }
    if (!ownsDatasetSelectionIntent(intentOwner)) {
      return false;
    }
    const exactError = errorFromUnknown(error, 'Dataset switch');
    // The Dataset box goes back to the dataset that is still open, or None.
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
    } else {
      updateDatasetInfo(null);
    }
    // A startup selection that fails is explained by startup (main.js): its
    // opening says why over the empty viewer, or the startup failure screen
    // does when the app itself failed. The select goes back to what is open,
    // unless the listing still under way will.
    if (startup) {
      if (!catalogIsPopulating()) synchronizeDatasetSelectToCurrent();
      throw exactError;
    }
    // The dataset itself arrived and only the address bar could not be
    // rewritten: nothing about the data is wrong, so it keeps its own wording
    // and offers no retry.
    if (datasetReloaded) {
      debug.error('[UI] The page address could not be updated:', exactError);
      showSessionStatus(
        'The dataset opened, but the page address could not be updated.',
        true,
        dataSourceFailureDetails(exactError)
      );
      return false;
    }
    debug.error(`[UI] Dataset switch failed: ${exactError.message}`, exactError);
    const name = datasetDisplayName(sourceType, datasetId);
    const explanation = describeDataSourceFailure(
      `"${name}"`,
      'could not be opened',
      exactError
    ) + (
      activeMetadata === null
        ? ''
        : ` "${activeMetadata.name}" is still open.`
    );
    // Persist the explanation next to the selector and offer the same dataset
    // again: a toast that fades leaves nothing behind to act on. The notice is
    // a permanent fixture of the sidebar, so it carries no raw diagnostic.
    setCatalogNotice(
      explanation,
      () => handleDatasetChange(datasetId, sourceType, loadMethod)
    );
    // The one notification of the failure: one sentence, with the raw error
    // under its Details (the console has it too). The opening only lets go.
    showSessionStatus(
      `Could not open "${name}".`,
      true,
      dataSourceFailureDetails(exactError)
    );
    return false;
  }
}

/**
 * The dataset's own name where the catalog published one, so the message names
 * what the dropdown showed rather than an internal id.
 *
 * @param {string} sourceType
 * @param {string} datasetId
 * @returns {string}
 */
function datasetDisplayName(sourceType, datasetId) {
  const option = datasetOptionsByKey.get(
    datasetSelectionValue(sourceType, datasetId)
  );
  const name = option?.dataset?.datasetName;
  return typeof name === 'string' && name.length > 0 ? name : datasetId;
}

async function handleDatasetChange(
  datasetId,
  sourceType,
  loadMethod = DATA_LOAD_METHODS.DATASET_DROPDOWN
) {
  requireNonEmptyString(datasetId, 'Selected dataset id');
  requireNonEmptyString(sourceType, 'Selected dataset source type');
  const intent = beginDatasetSelectionIntent({
    label: `Loading ${datasetDisplayName(sourceType, datasetId)}…`,
    value: datasetSelectionValue(sourceType, datasetId)
  });
  return await runDatasetSelectionIntent(intent, owner =>
    handleDatasetChangeForIntent(
      datasetId,
      sourceType,
      loadMethod,
      null,
      owner
    )
  );
}

/**
 * Activate one dataset for an intent the caller already began — a local file
 * that has been read, a connection that holds one dataset. The caller owns
 * the intent's settlement and hears a superseded activation as its own
 * superseded error.
 */
function activateDatasetForIntent(
  intent,
  datasetId,
  sourceType,
  loadMethod,
  source
) {
  return handleDatasetChangeForIntent(
    datasetId,
    sourceType,
    loadMethod,
    source,
    intent
  );
}

/**
 * Load the startup selection as the first ordinary dataset change, so the
 * select shows it while it loads and any choice the user makes meanwhile
 * replaces it.
 *
 * @param {{datasetId: string, loadMethod: string, sourceType: string}} selection
 * @returns {Promise<'ready'|'superseded'>} Rejects with the load's own error
 *   when it fails and nothing superseded it.
 */
async function loadStartupDataset(selection) {
  requireExactKeys(
    selection,
    ['datasetId', 'loadMethod', 'sourceType'],
    'Startup dataset selection'
  );
  const { datasetId, loadMethod, sourceType } = selection;
  const intent = beginDatasetSelectionIntent({
    label: `Loading ${datasetDisplayName(sourceType, datasetId)}…`,
    value: datasetSelectionValue(sourceType, datasetId)
  });
  return await runDatasetSelectionIntent(intent, async owner => {
    try {
      const ready = await handleDatasetChangeForIntent(
        datasetId,
        sourceType,
        loadMethod,
        null,
        owner,
        { startup: true }
      );
      if (!ownsDatasetSelectionIntent(owner)) return 'superseded';
      if (ready !== true) {
        throw new Error(
          'Startup dataset activation did not publish one ready generation.'
        );
      }
      return 'ready';
    } catch (error) {
      if (
        isDatasetReloadSupersededError(error) ||
        !ownsDatasetSelectionIntent(owner)
      ) {
        return 'superseded';
      }
      throw error;
    }
  });
}

/**
 * Handle selecting the exact None state.
 *
 * @returns {Promise<boolean>} Whether the dataset and UI were fully cleared
 */
async function handleNoneDatasetSelectionForIntent(intentOwner) {
  try {

    const cleared = await trackWork(clearDataset(intentOwner.transaction));
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
    retireUnlistedDatasetOption();
    datasetSelect.value = NONE_DATASET_VALUE;
    if (datasetSelect.value !== NONE_DATASET_VALUE) {
      throw new Error('Dataset select could not represent the None state.');
    }
    datasetSelect.disabled = false;
    // The user asked for no dataset and got it, so a failed switch they walked
    // away from is no longer something to retry.
    clearCatalogNotice();
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
    debug.error('[UI] The dataset could not be closed:', exactError);
    showSessionStatus(
      'The dataset could not be closed.',
      true,
      dataSourceFailureDetails(exactError)
    );
    return false;
  }
}

async function handleNoneDatasetSelection() {
  const intent = beginDatasetSelectionIntent({
    label: CLOSING_DATASET_LABEL,
    value: NONE_DATASET_VALUE
  });
  return await runDatasetSelectionIntent(
    intent,
    handleNoneDatasetSelectionForIntent
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
    retireUnlistedDatasetOption();
    datasetSelect.value = NONE_DATASET_VALUE;
    if (datasetSelect.value !== NONE_DATASET_VALUE) {
      throw new Error('Dataset select could not represent the None state.');
    }
    updateDatasetInfo(null);
    return;
  }

  // A listing in progress selects the dataset itself when it finishes.
  if (!catalogIsPopulating()) {
    selectDatasetOption(event.sourceType, event.datasetId);
    datasetSelect.disabled = false;
  }
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
    updateDatasetInfo(activeMetadata, activeSourceType);
    selectDatasetOption(activeSourceType, activeDatasetId);
  } else {
    ensureNoneDatasetOption();
    retireUnlistedDatasetOption();
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
}

async function handleDatasetSelectEvent(event) {
  // The option the user picked is already showing, so it is what the select
  // presents while it loads.
  const pickedValue = datasetSelect.value;
  const pickedName = datasetSelect.selectedOptions?.[0]?.dataset?.datasetName;
  const intentOwner = beginDatasetSelectionIntent({
    label: pickedValue === NONE_DATASET_VALUE
      ? CLOSING_DATASET_LABEL
      : typeof pickedName === 'string' && pickedName.length > 0
        ? `Loading ${pickedName}…`
        : 'Loading…',
    value: pickedValue
  });
  return await runDatasetSelectionIntent(
    intentOwner,
    () => handleDatasetSelectEventForIntent(event, intentOwner)
  );
}

async function handleDatasetSelectEventForIntent(event, intentOwner) {
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
      selectedValue === UNLISTED_DATASET_VALUE ||
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
      synchronizeDatasetSelectToCurrent();
      showSessionStatus(
        'A newer dataset selection is now active.',
        false
      );
      return;
    }
    const exactError = errorFromUnknown(error, 'Dataset selection event');
    synchronizeTerminalDatasetSelectionFailure();
    debug.error('[UI] A dataset choice could not be applied:', exactError);
    showSessionStatus(
      'That dataset choice could not be applied.',
      true,
      dataSourceFailureDetails(exactError)
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
  // Reaching for the picker (pointer, focus, keyboard) is what asks for the
  // samples' files while a link or a server holds the dataset on screen.
  for (const type of ['pointerdown', 'focus', 'keydown']) {
    datasetSelect.addEventListener(
      type,
      () => {
        if (destroyed || samplesWanted) return;
        void invokeTracked(() => describeListedSamples()).catch(error => {
          console.error('[UI] Describing the sample datasets failed:', error);
        });
      },
      { signal: lifecycleController.signal }
    );
  }
  datasetConnections = initDatasetConnections({
    datasetIntents: Object.freeze({
      activate: (intent, ...args) =>
        invokeTracked(() => activateDatasetForIntent(intent, ...args)),
      begin: pending => beginDatasetSelectionIntent(pending),
      beginIfNoActionSince: (sequence, pending) =>
        beginDatasetSelectionIntentIfNoActionSince(sequence, pending),
      actionSequence: () => datasetChanges.actionSequence,
      owns: intent => ownsDatasetSelectionIntent(intent),
      settle: intent => settleDatasetSelectionIntent(intent),
      settled: () => datasetChanges.settled,
      whenSettled: () => datasetChanges.whenSettled()
    }),
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
    activeDatasetSelectionIntent = null;
    catalogRetryInFlight = false;
    const cleanupErrors = [];
    try {
      // A retired controls instance owns no retry, so its notice must not stay
      // on screen offering one.
      clearCatalogNotice();
    } catch (error) {
      cleanupErrors.push(error);
    }
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

  /**
   * Open the dataset a session file recorded (see
   * `session/dataset-source-record.js`): a sample by its id, a data link or a
   * server through its connection control, then the recorded dataset when
   * the connection holds several.
   *
   * @param {{kind: 'sample'|'link'|'remote', dataset: string,
   *   locator?: string, url?: string}} record
   * @returns {Promise<boolean>} Whether that dataset is now open.
   */
  async function openDatasetSource(record) {
    const sourceType = RECORDED_SOURCE_TYPES[record.kind];
    if (sourceType === undefined) {
      throw new TypeError(`Unknown recorded dataset source "${record.kind}".`);
    }
    const isOpen = () =>
      dataSourceManager.getCurrentSourceType() === sourceType &&
      dataSourceManager.getCurrentDatasetId() === record.dataset;
    try {
      if (sourceType !== 'local-demo') {
        const connected = await datasetConnections.openConnection(
          sourceType,
          sourceType === 'link' ? record.locator : record.url
        );
        if (!connected) return false;
        if (isOpen()) return true;
      }
      const ready = await handleDatasetChange(
        record.dataset,
        sourceType,
        DATA_LOAD_METHODS.SESSION_SOURCE
      );
      return ready === true && isOpen();
    } catch (error) {
      if (isDatasetReloadSupersededError(error)) return false;
      throw error;
    }
  }

  /**
   * Read the open dataset again, in place, with the cells `cellSubset` asks
   * for (a cell subset request, `data/cell-subset-policy.js`; it is this
   * reading's own, never another's). Cells that are the open ones
   * grown or cut (a larger or smaller share of the same method and seed)
   * are shown in place (`resizeOpenCells`, `app/open-cells-resize.js`):
   * only the added cells are read, and the views, fields, filters and
   * analysis windows stay. Other cells are shown as a dataset change: its
   * source has read them (`AnnDataFileSource.reopenCells`) and the change
   * stages and publishes them like any other. The dataset on screen stays
   * until the new reading is shown; Cancel keeps it.
   *
   * @param {Object} cellSubset
   * @returns {Promise<{shown: boolean, inPlace: boolean}>} Whether the
   *   dataset was shown again, and whether in place (what was shown stayed)
   */
  async function reopenOpenDataset(cellSubset) {
    const datasetId = dataSourceManager.getCurrentDatasetId();
    const sourceType = dataSourceManager.getCurrentSourceType();
    if (typeof datasetId !== 'string' || typeof sourceType !== 'string') {
      throw new Error('No dataset is open to read again.');
    }
    const source = dataSourceManager.getSource(sourceType);
    const annData = typeof source?.getAnnDataSource === 'function' ? source.getAnnDataSource(datasetId) : null;
    if (typeof annData?.reopenCells !== 'function') {
      throw new Error('This dataset is not read from a file Cellucid can read again with other cells.');
    }
    const intent = beginDatasetSelectionIntent({
      label: `Reading ${datasetDisplayName(sourceType, datasetId)} again…`,
      value: datasetSelectionValue(sourceType, datasetId)
    });
    return await runDatasetSelectionIntent(intent, async owner => {
      try {
        const outcome = await trackWork(resizeOpenCells({ annData, cellSubset, signal: owner.transaction.signal }));
        if (outcome.inPlace === true) return { shown: true, inPlace: true };
        const shown = await handleDatasetChangeForIntent(datasetId, sourceType, DATA_LOAD_METHODS.SUBSAMPLE, source, owner);
        return { shown: shown === true, inPlace: false };
      } catch (error) {
        if (isDatasetReloadSupersededError(error) || error?.name === 'AbortError') return { shown: false, inPlace: false };
        throw error;
      }
    });
  }

  return {
    catalogReady,
    reopenOpenDataset: cellSubset =>
      invokeTracked(() => reopenOpenDataset(cellSubset)),
    clearDataset: () =>
      invokeTracked(() => handleNoneDatasetSelection()),
    destroy,
    openDatasetSource: record =>
      invokeTracked(() => openDatasetSource(record)),
    loadStartupDataset: selection =>
      invokeTracked(() => loadStartupDataset(selection)),
    populateDatasetDropdown: () =>
      invokeTracked(() => populateDatasetDropdown()),
    refreshDatasetUI,
    refreshOpenCells,
    updateMappedDatasetFacts,
    showLoadedConnectivityEdges,
    selectDataset: (...args) =>
      invokeTracked(() => handleDatasetChange(...args))
  };
}
