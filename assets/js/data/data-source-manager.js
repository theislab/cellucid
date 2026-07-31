/**
 * DataSourceManager - Central coordinator for data sources and dataset switching
 *
 * Manages:
 * - Registration of data sources (local-demo, local-user, remote, jupyter)
 * - Active dataset tracking
 * - Dataset switching with callbacks
 * - State serialization hooks
 */

import {
  DataSourceError,
  DataSourceErrorCode,
  readBoundedJson,
  validateDatasetId,
  validateDatasetIdentity
} from './data-source.js';
import { createLocalDemoDataSource } from './local-demo-source.js';
import { createGitHubDataSource } from './github-data-source.js';
import {
  throwIfMetadataAborted,
  validateAbortSignalOrNull,
  waitForMetadata,
} from './metadata-load-contract.js';
import { debug } from '../utils/debug.js';
import { setOwnDataProperty } from '../utils/exact-record.js';

const datasetSelectionStages = new WeakMap();
const datasetSelectionPublications = new WeakMap();

function requireExactOptionRecord(value, allowedKeys, label) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !allowedKeys.includes(key)) {
      throw new TypeError(
        `${label} supports only: ${allowedKeys.join(', ')}.`
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      throw new TypeError(
        `${label}.${key} must be an enumerable own data field.`
      );
    }
  }
  return value;
}

function requireLoadMethod(value, label) {
  if (value === null) return null;
  return validateDatasetId(value, label);
}

function readSourceType(source, label) {
  if (source === null) return null;
  if (
    typeof source !== 'object'
    || typeof source.getType !== 'function'
  ) {
    throw new TypeError(`${label} must implement getType().`);
  }
  const sourceType = source.getType();
  if (
    typeof sourceType !== 'string' ||
    sourceType.length === 0 ||
    sourceType !== sourceType.trim()
  ) {
    throw new TypeError(
      `${label} getType() must return a non-empty trimmed string.`
    );
  }
  return sourceType;
}

function requireListener(callback, label) {
  if (typeof callback !== 'function') {
    throw new TypeError(`${label} must be a function.`);
  }
  return callback;
}

function notifyListeners(listeners, event, label) {
  const errors = [];
  for (const callback of [...listeners]) {
    try {
      callback(event);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `${label} listener publication failed.`
    );
  }
}

/**
 * @typedef {import('./data-source.js').DatasetMetadata} DatasetMetadata
 */

/**
 * @typedef {Object} DataSourceState
 * @property {string|null} sourceType - Type of active data source
 * @property {string|null} datasetId - Active dataset ID
 * @property {string|null} userPath - Path for user directories (for display only)
 */

/**
 * Central manager for data sources
 */
export class DataSourceManager {
  constructor() {
    /** @type {Map<string, Object>} */
    this.sources = new Map();

    /** @type {Object|null} */
    this.activeSource = null;

    /** @type {string|null} */
    this.activeDatasetId = null;

    /** @type {string|null} */
    this.activeIdentityId = null;

    /** @type {DatasetMetadata|null} */
    this.activeDatasetMetadata = null;

    /** @type {Set<Function>} */
    this._onDatasetChangeCallbacks = new Set();

    /** @type {Set<Function>} */
    this._onSourcesChangeCallbacks = new Set();

    /** @type {boolean} */
    this._initialized = false;

    /** @type {string|null} */
    this.lastLoadMethod = null;

    /** @type {number} */
    this._selectionRevision = 0;

    /** @type {Object<string, string>} Protocol handlers (protocol → sourceType) */
    this._protocolHandlers = { ...DataSourceManager.DEFAULT_PROTOCOL_HANDLERS };
  }

  /**
   * Register a data source
   * @param {string} type - Source type identifier
   * @param {Object} source - Data source instance
   */
  registerSource(type, source) {
    validateDatasetId(type, 'Registered source type');
    if (source === null || typeof source !== 'object') {
      throw new TypeError('Registered data source must be an object.');
    }
    if (
      this.activeSource !== null &&
      readSourceType(this.activeSource, 'Active data source') === type &&
      this.activeSource !== source
    ) {
      throw new Error(
        `Cannot replace active data source "${type}" before clearing its dataset.`
      );
    }
    this.sources.set(type, source);
    this._notifySourcesChange();
  }

  /**
   * Unregister a data source
   * @param {string} type - Source type identifier
   */
  unregisterSource(type) {
    validateDatasetId(type, 'Unregistered source type');
    if (
      this.activeSource !== null &&
      readSourceType(this.activeSource, 'Active data source') === type
    ) {
      throw new Error(
        `Cannot unregister active data source "${type}" before clearing its dataset.`
      );
    }
    this.sources.delete(type);
    this._notifySourcesChange();
  }

  /**
   * Get a registered data source
   * @param {string} type - Source type identifier
   * @returns {Object|null}
   */
  getSource(type) {
    return this.sources.get(type) || null;
  }

  /**
   * Get all registered source types
   * @returns {string[]}
   */
  getSourceTypes() {
    return Array.from(this.sources.keys());
  }

  /**
   * Register the current built-in sources without selecting a dataset.
   * Dataset loading requires a user selection or an explicit launch parameter.
   *
   * @param {Object} [options]
   * @param {boolean} [options.registerDemoCatalog=true]
   * @returns {Promise<void>}
   */
  async initialize(options = {}) {
    if (this._initialized) return;
    if (
      options === null ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      Object.getPrototypeOf(options) !== Object.prototype
    ) {
      throw new TypeError(
        'DataSourceManager initialization options must be a plain object'
      );
    }
    const unsupported = Object.keys(options).filter(
      key => key !== 'registerDemoCatalog'
    );
    if (unsupported.length > 0) {
      throw new TypeError(
        `DataSourceManager initialization contains unsupported option(s): ${unsupported.join(', ')}`
      );
    }
    const registerDemoCatalog = Object.hasOwn(
      options,
      'registerDemoCatalog'
    )
      ? options.registerDemoCatalog
      : true;
    if (typeof registerDemoCatalog !== 'boolean') {
      throw new TypeError(
        'DataSourceManager registerDemoCatalog must be a boolean'
      );
    }

    if (registerDemoCatalog) {
      this.registerSource(
        'local-demo',
        createLocalDemoDataSource()
      );
    }

    // GitHub is an explicit connection workflow and performs no catalog I/O
    // until the user supplies a repository.
    const githubSource = createGitHubDataSource();
    this.registerSource('github-repo', githubSource);

    this._initialized = true;
    debug.log('[DataSourceManager] Initialized');
  }

  /**
   * Probe one source without letting its failure escape.
   *
   * @param {string} sourceType
   * @param {Object} source
   * @returns {Promise<{sourceType: string, datasets: DatasetMetadata[], error: Error|null}|null>}
   * @private
   */
  async _probeSource(sourceType, source) {
    try {
      if (
        typeof source?.isAvailable !== 'function' ||
        typeof source?.listDatasets !== 'function'
      ) {
        throw new TypeError(
          `Data source '${sourceType}' must implement isAvailable() and listDatasets().`
        );
      }
      const isAvailable = await source.isAvailable();
      if (typeof isAvailable !== 'boolean') {
        throw new TypeError(
          `Data source '${sourceType}' isAvailable() must resolve to a boolean.`
        );
      }
      if (!isAvailable) return null;
      const datasets = await source.listDatasets();
      if (!Array.isArray(datasets)) {
        throw new TypeError(
          `Data source '${sourceType}' listDatasets() must resolve to an array.`
        );
      }
      return { sourceType, datasets, error: null };
    } catch (error) {
      debug.log('[DataSourceManager] source probe failed', {
        sourceType,
        message: error?.message,
      });
      return {
        sourceType,
        datasets: [],
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Get all available datasets from all sources.
   *
   * A probe failure belongs to the source that produced it and is reported on
   * that source's entry. One unreachable catalog must never take the whole
   * selector down with it: a dataset opened from a local file needs no network
   * at all, so it must keep listing while a remote catalog is offline.
   *
   * Failures stay cached on their source, so a catalog is never re-fetched
   * implicitly. Pass `{ refresh: true }` — a user-visible retry — to clear
   * them and probe again.
   *
   * @param {Object} [options]
   * @param {boolean} [options.refresh=false] - Clear cached source state first
   * @returns {Promise<{sourceType: string, datasets: DatasetMetadata[], error: Error|null}[]>}
   */
  async getAllDatasets(options = {}) {
    requireExactOptionRecord(
      options,
      ['refresh'],
      'DataSourceManager.getAllDatasets options'
    );
    const refresh = Object.hasOwn(options, 'refresh')
      ? options.refresh
      : false;
    if (typeof refresh !== 'boolean') {
      throw new TypeError(
        'DataSourceManager.getAllDatasets refresh must be a boolean.'
      );
    }
    debug.log('[DataSourceManager] getAllDatasets', {
      refresh,
      sources: [...this.sources.keys()],
    });

    if (refresh) await this.refreshAll();

    const allResults = await Promise.all(
      [...this.sources.entries()].map(
        ([sourceType, source]) => this._probeSource(sourceType, source)
      )
    );
    const results = allResults.filter(result => result !== null);

    debug.log('[DataSourceManager] getAllDatasets complete', {
      failedSources: results.filter(result => result.error !== null).length,
      sourceGroups: results.length,
    });
    return results;
  }

  /**
   * Get datasets from a specific source
   * @param {string} sourceType - Source type
   * @returns {Promise<DatasetMetadata[]>}
   */
  async getDatasets(sourceType) {
    const source = this.sources.get(sourceType);
    if (!source) {
      throw new DataSourceError(
        `Unknown source type: ${sourceType}`,
        DataSourceErrorCode.NOT_FOUND,
        null,
        { sourceType }
      );
    }
    return source.listDatasets();
  }

  /**
   * Switch to a different dataset
   * @param {string} sourceType - Source type
   * @param {string} datasetId - Dataset ID
   * @param {Object} [options]
   * @param {boolean} [options.silent=false] - Don't notify listeners
   * @param {string} [options.loadMethod] - Analytics hint for how the dataset was chosen
   * @returns {Promise<{baseUrl: string, metadata: DatasetMetadata}>}
   */
  async switchToDataset(sourceType, datasetId, options = {}) {
    const exactOptions = requireExactOptionRecord(
      options,
      ['loadMethod', 'silent'],
      'Dataset switch options'
    );
    const silent = Object.hasOwn(exactOptions, 'silent')
      ? exactOptions.silent
      : false;
    if (typeof silent !== 'boolean') {
      throw new TypeError('Dataset switch silent must be a boolean.');
    }
    const loadMethod = requireLoadMethod(
      Object.hasOwn(exactOptions, 'loadMethod')
        ? exactOptions.loadMethod
        : null,
      'Dataset switch loadMethod'
    );
    const stage = await this.stageDatasetSelection(
      sourceType,
      datasetId,
      { loadMethod }
    );
    const publication = this.commitDatasetSelection(stage);
    let publicationError = null;
    if (!silent) {
      try {
        this.publishDatasetSelection(publication);
      } catch (error) {
        publicationError = error;
      }
    } else {
      datasetSelectionPublications.get(publication).state = 'published';
    }
    let finalizationError = null;
    try {
      this.finalizeDatasetSelection(publication);
    } catch (error) {
      finalizationError = error;
    }
    if (publicationError !== null && finalizationError !== null) {
      throw new AggregateError(
        [publicationError, finalizationError],
        'Dataset selection publication and prior-source cleanup failed.'
      );
    }
    if (publicationError !== null) throw publicationError;
    if (finalizationError !== null) throw finalizationError;
    return {
      baseUrl: stage.baseUrl,
      metadata: stage.metadata
    };
  }

  /**
   * Resolve and validate a dataset candidate without changing the live
   * selection, notifying listeners, or deactivating the prior source.
   *
   * @param {string} sourceType
   * @param {string} datasetId
   * @param {{loadMethod?: string|null, source?: Object}} [options]
   * @returns {Promise<Readonly<{
   *   baseUrl: string,
   *   datasetId: string,
   *   identityId: string,
   *   loadMethod: string|null,
   *   metadata: DatasetMetadata,
   *   sourceType: string
   * }>>}
   */
  async stageDatasetSelection(sourceType, datasetId, options = {}) {
    validateDatasetId(sourceType, 'Dataset selection sourceType');
    validateDatasetId(datasetId, 'Dataset selection datasetId');
    const exactOptions = requireExactOptionRecord(
      options,
      ['loadMethod', 'source'],
      'Dataset selection stage options'
    );
    const loadMethod = requireLoadMethod(
      Object.hasOwn(exactOptions, 'loadMethod')
        ? exactOptions.loadMethod
        : null,
      'Dataset selection loadMethod'
    );
    const registeredSource = this.sources.get(sourceType);
    const source = Object.hasOwn(exactOptions, 'source')
      ? exactOptions.source
      : registeredSource;
    if (!source) {
      throw new DataSourceError(
        `Unknown source type: ${sourceType}`,
        DataSourceErrorCode.NOT_FOUND,
        null,
        { sourceType }
      );
    }
    if (readSourceType(source, 'Candidate data source') !== sourceType) {
      throw new TypeError(
        'Candidate data source type must equal the requested source type.'
      );
    }

    const metadata = await source.getMetadata(datasetId);
    validateDatasetIdentity(metadata, datasetId, sourceType);
    const baseUrl = source.getBaseUrl(datasetId);
    if (
      typeof baseUrl !== 'string' ||
      baseUrl.length === 0 ||
      baseUrl !== baseUrl.trim() ||
      /[\u0000-\u001f\u007f]/.test(baseUrl)
    ) {
      throw new DataSourceError(
        'The selected source did not provide one exact dataset base URL.',
        DataSourceErrorCode.INVALID_FORMAT,
        sourceType,
        { baseUrl, datasetId }
      );
    }
    const identityId = sourceType === 'local-user'
      ? source.getIdentityId(datasetId)
      : datasetId;
    try {
      validateDatasetId(
        identityId,
        'Selected dataset identity id'
      );
    } catch (error) {
      throw new DataSourceError(
        'The selected source did not provide an exact dataset identity id.',
        DataSourceErrorCode.INVALID_FORMAT,
        sourceType,
        {
          datasetId,
          identityId,
          reason: error instanceof Error
            ? error.message
            : String(error)
        }
      );
    }

    const stage = Object.freeze({
      baseUrl,
      datasetId,
      identityId,
      loadMethod,
      metadata,
      sourceType
    });
    datasetSelectionStages.set(stage, {
      manager: this,
      registeredSource,
      revision: this._selectionRevision,
      source,
      state: 'staged'
    });
    return stage;
  }

  /**
   * Commit one exact staged selection after all dataset runtime I/O succeeds.
   * Listener publication remains explicitly owned by
   * publishDatasetSelection().
   *
   * @param {Object} stage
   * @returns {Readonly<Object>}
   */
  commitDatasetSelection(stage) {
    const owner = datasetSelectionStages.get(stage);
    if (
      owner === undefined ||
      owner.manager !== this ||
      owner.state !== 'staged'
    ) {
      throw new TypeError(
        'Dataset selection commit requires one current manager-owned stage.'
      );
    }
    if (
      owner.revision !== this._selectionRevision ||
      this.sources.get(stage.sourceType) !== owner.registeredSource
    ) {
      owner.state = 'superseded';
      throw new Error(
        'Dataset selection stage was superseded before publication.'
      );
    }

    const previousSource = this.activeSource;
    const previousSourceType = readSourceType(
      previousSource,
      'Previous active data source'
    );
    const previousDatasetId = this.activeDatasetId;
    const previousState = Object.freeze({
      activeDatasetId: this.activeDatasetId,
      activeDatasetMetadata: this.activeDatasetMetadata,
      activeIdentityId: this.activeIdentityId,
      activeSource: this.activeSource,
      lastLoadMethod: this.lastLoadMethod
    });

    const sourceChanged = owner.registeredSource !== owner.source;
    if (sourceChanged) {
      this.sources.set(stage.sourceType, owner.source);
    }

    this.activeSource = owner.source;
    this.activeDatasetId = stage.datasetId;
    this.activeIdentityId = stage.identityId;
    this.activeDatasetMetadata = stage.metadata;
    this.lastLoadMethod = stage.loadMethod;
    this._selectionRevision++;
    owner.state = 'committed';

    debug.log('[DataSourceManager] Switched dataset', {
      sourceType: stage.sourceType,
      datasetId: stage.datasetId,
      baseUrl: stage.baseUrl,
      loadMethod: stage.loadMethod
    });

    const publication = Object.freeze({
      baseUrl: stage.baseUrl,
      datasetId: stage.datasetId,
      loadMethod: stage.loadMethod,
      metadata: stage.metadata,
      previousDatasetId,
      previousSourceType,
      sourceType: stage.sourceType
    });
    datasetSelectionPublications.set(publication, {
      manager: this,
      previousSource,
      previousState,
      registeredSource: owner.registeredSource,
      revision: this._selectionRevision,
      sourceChanged,
      state: 'committed'
    });
    return publication;
  }

  /**
   * Permanently cancel one staged candidate. A discarded or superseded stage
   * can never be committed later.
   *
   * @param {Object} stage
   */
  discardDatasetSelection(stage) {
    const owner = datasetSelectionStages.get(stage);
    if (
      owner === undefined ||
      owner.manager !== this ||
      owner.state !== 'staged'
    ) {
      throw new TypeError(
        'Dataset selection discard requires one current manager-owned stage.'
      );
    }
    owner.state = 'discarded';
  }

  /**
   * Restore a committed selection before it has been exposed to listeners or
   * prior-source cleanup. This is reserved for synchronous runtime publication
   * failure inside the same final transaction.
   *
   * @param {Object} publication
   */
  rollbackDatasetSelection(publication) {
    const owner = datasetSelectionPublications.get(publication);
    if (
      owner === undefined ||
      owner.manager !== this ||
      owner.state !== 'committed' ||
      owner.revision !== this._selectionRevision
    ) {
      throw new TypeError(
        'Dataset selection rollback requires one unpublished current commit.'
      );
    }
    if (owner.sourceChanged) {
      if (owner.registeredSource === undefined) {
        this.sources.delete(publication.sourceType);
      } else {
        this.sources.set(
          publication.sourceType,
          owner.registeredSource
        );
      }
    }
    this.activeSource = owner.previousState.activeSource;
    this.activeDatasetId = owner.previousState.activeDatasetId;
    this.activeIdentityId = owner.previousState.activeIdentityId;
    this.activeDatasetMetadata =
      owner.previousState.activeDatasetMetadata;
    this.lastLoadMethod = owner.previousState.lastLoadMethod;
    this._selectionRevision++;
    owner.state = 'rolled-back';
  }

  /**
   * Notify dataset listeners only after the manager and runtime have both
   * published the committed generation.
   *
   * @param {Object} publication
   */
  publishDatasetSelection(publication) {
    const owner = datasetSelectionPublications.get(publication);
    if (
      owner === undefined ||
      owner.manager !== this ||
      owner.state !== 'committed'
    ) {
      throw new TypeError(
        'Dataset selection publication requires one unpublished manager commit.'
      );
    }
    if (owner.revision !== this._selectionRevision) {
      owner.state = 'superseded';
      throw new Error(
        'Dataset selection publication was superseded before listener delivery.'
      );
    }
    owner.state = 'published';
    const errors = [];
    if (owner.sourceChanged) {
      try {
        this._notifySourcesChange();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      this._notifyDatasetChange(publication);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw errors.length === 1
        ? errors[0]
        : new AggregateError(
            errors,
            'Dataset registry and selection listener publication failed.'
          );
    }
  }

  /**
   * Retire resources owned only by the prior generation. Cleanup happens
   * after the new manager/runtime/URL/listener generation is complete, so a
   * cleanup failure never restores an already-revoked prior generation.
   *
   * @param {Object} publication
   */
  finalizeDatasetSelection(publication) {
    const owner = datasetSelectionPublications.get(publication);
    if (
      owner === undefined ||
      owner.manager !== this ||
      owner.state !== 'published'
    ) {
      throw new TypeError(
        'Dataset selection finalization requires one published manager commit.'
      );
    }
    owner.state = 'finalized';
    const cleanupOwners = new Map();
    const currentRegisteredSource = this.sources.get(
      publication.sourceType
    );
    if (
      owner.registeredSource &&
      owner.registeredSource !== this.activeSource &&
      owner.registeredSource !== currentRegisteredSource
    ) {
      cleanupOwners.set(owner.registeredSource, 'disconnect');
    }
    if (
      owner.previousSource &&
      owner.previousSource !== this.activeSource &&
      !cleanupOwners.has(owner.previousSource)
    ) {
      cleanupOwners.set(owner.previousSource, 'deactivate');
    }

    const errors = [];
    for (const [source, cleanup] of cleanupOwners) {
      try {
        if (cleanup === 'disconnect') {
          if (typeof source.disconnect !== 'function') {
            throw new TypeError(
              'A displaced registered source must implement disconnect().'
            );
          }
          source.disconnect();
        } else if (typeof source.onDeactivate === 'function') {
          source.onDeactivate();
        }
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw errors.length === 1
        ? errors[0]
        : new AggregateError(
            errors,
            'Prior dataset source cleanup failed.'
          );
    }
  }

  /**
   * Clear the active dataset selection (no dataset loaded)
   * @param {Object} [options]
   * @param {boolean} [options.silent=false] - Don't notify listeners
   */
  clearActiveDataset(options = {}) {
    const exactOptions = requireExactOptionRecord(
      options,
      ['loadMethod', 'silent'],
      'Dataset clear options'
    );
    const silent = Object.hasOwn(exactOptions, 'silent')
      ? exactOptions.silent
      : false;
    if (typeof silent !== 'boolean') {
      throw new TypeError('Dataset clear silent must be a boolean.');
    }
    const loadMethod = requireLoadMethod(
      Object.hasOwn(exactOptions, 'loadMethod')
        ? exactOptions.loadMethod
        : null,
      'Dataset clear loadMethod'
    );
    const stage = this.stageDatasetClear({ loadMethod });
    const publication = this.commitDatasetClear(stage);
    if (!silent && publication !== null) {
      let publicationError = null;
      try {
        this.publishDatasetSelection(publication);
      } catch (error) {
        publicationError = error;
      }
      let finalizationError = null;
      try {
        this.finalizeDatasetSelection(publication);
      } catch (error) {
        finalizationError = error;
      }
      if (publicationError !== null && finalizationError !== null) {
        throw new AggregateError(
          [publicationError, finalizationError],
          'Dataset clear publication and prior-source cleanup failed.'
        );
      }
      if (publicationError !== null) throw publicationError;
      if (finalizationError !== null) throw finalizationError;
    } else if (publication !== null) {
      datasetSelectionPublications.get(publication).state = 'published';
      this.finalizeDatasetSelection(publication);
    }
  }

  /**
   * Stage the exact None selection without deactivating the live source.
   *
   * @param {{loadMethod?: string|null}} [options]
   * @returns {Readonly<Object>}
   */
  stageDatasetClear(options = {}) {
    const exactOptions = requireExactOptionRecord(
      options,
      ['loadMethod'],
      'Dataset clear stage options'
    );
    const loadMethod = requireLoadMethod(
      Object.hasOwn(exactOptions, 'loadMethod')
        ? exactOptions.loadMethod
        : null,
      'Dataset clear stage loadMethod'
    );
    const stage = Object.freeze({
      loadMethod,
      target: 'none'
    });
    datasetSelectionStages.set(stage, {
      manager: this,
      registeredSource: null,
      revision: this._selectionRevision,
      source: null,
      state: 'staged'
    });
    return stage;
  }

  /**
   * Commit one staged None selection.
   *
   * @param {Object} stage
   * @returns {Readonly<Object>|null}
   */
  commitDatasetClear(stage) {
    const owner = datasetSelectionStages.get(stage);
    if (
      owner === undefined ||
      owner.manager !== this ||
      owner.source !== null ||
      owner.state !== 'staged' ||
      stage.target !== 'none'
    ) {
      throw new TypeError(
        'Dataset clear commit requires one current manager-owned None stage.'
      );
    }
    if (owner.revision !== this._selectionRevision) {
      owner.state = 'superseded';
      throw new Error(
        'Dataset clear stage was superseded before publication.'
      );
    }
    if (
      !this.activeSource &&
      !this.activeDatasetId &&
      !this.activeIdentityId
    ) {
      owner.state = 'committed';
      return null;
    }

    const previousSource = this.activeSource;
    const previousSourceType = readSourceType(
      previousSource,
      'Previous active data source'
    );
    const previousDatasetId = this.activeDatasetId;
    const previousState = Object.freeze({
      activeDatasetId: this.activeDatasetId,
      activeDatasetMetadata: this.activeDatasetMetadata,
      activeIdentityId: this.activeIdentityId,
      activeSource: this.activeSource,
      lastLoadMethod: this.lastLoadMethod
    });

    this.activeSource = null;
    this.activeDatasetId = null;
    this.activeIdentityId = null;
    this.activeDatasetMetadata = null;
    this.lastLoadMethod = null;
    this._selectionRevision++;
    owner.state = 'committed';

    const publication = Object.freeze({
      sourceType: null,
      datasetId: null,
      metadata: null,
      baseUrl: null,
      previousSourceType,
      previousDatasetId,
      loadMethod: stage.loadMethod
    });
    datasetSelectionPublications.set(publication, {
      manager: this,
      previousSource,
      previousState,
      registeredSource: null,
      revision: this._selectionRevision,
      sourceChanged: false,
      state: 'committed'
    });
    return publication;
  }

  /**
   * Get the base URL for the current dataset
   * @returns {string|null}
   */
  getCurrentBaseUrl() {
    if (!this.activeSource || !this.activeDatasetId) return null;
    return this.activeSource.getBaseUrl(this.activeDatasetId);
  }

  /**
   * Get the active local-demo dataset's explicitly advertised state manifest.
   * Other source types and demo catalogs without the capability return null
   * without a network probe.
   *
   * @returns {string|null}
   */
  getCurrentStateDescriptor() {
    if (!this.activeSource || !this.activeDatasetId) return null;
    if (
      readSourceType(this.activeSource, 'Active data source')
      !== 'local-demo'
    ) {
      return null;
    }
    if (typeof this.activeSource.getStateDescriptor !== 'function') {
      throw new TypeError(
        'Active local-demo source must implement getStateDescriptor().'
      );
    }
    const sourceDescriptor = this.activeSource.getStateDescriptor(
      this.activeDatasetId
    );
    if (sourceDescriptor === null) return null;
    if (
      sourceDescriptor === null
      || typeof sourceDescriptor !== 'object'
      || Array.isArray(sourceDescriptor)
      || Object.keys(sourceDescriptor).sort().join(',')
        !== 'manifestUrl,stateSha256'
    ) {
      throw new TypeError(
        'Active dataset state descriptor must contain exactly manifestUrl and stateSha256.'
      );
    }
    const baseUrl = this.getCurrentBaseUrl();
    const expectedManifestUrl = new URL(
      'state-snapshots.json',
      baseUrl
    ).href;
    if (sourceDescriptor.manifestUrl !== expectedManifestUrl) {
      throw new TypeError(
        'Active dataset state manifest URL must be the exact dataset sibling.'
      );
    }
    if (
      typeof sourceDescriptor.stateSha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(sourceDescriptor.stateSha256)
    ) {
      throw new TypeError(
        'Active dataset state SHA-256 must be one lowercase digest.'
      );
    }
    if (
      typeof this.activeIdentityId !== 'string'
      || this.activeIdentityId.length === 0
      || this.activeIdentityId !== this.activeIdentityId.trim()
    ) {
      throw new TypeError(
        'Active dataset state descriptor requires the exact identity id.'
      );
    }
    return {
      baseUrl,
      datasetId: this.activeDatasetId,
      identityId: this.activeIdentityId,
      manifestUrl: sourceDescriptor.manifestUrl,
      selectionRevision: this._selectionRevision,
      sourceType: 'local-demo',
      stateSha256: sourceDescriptor.stateSha256,
    };
  }

  /**
   * Get metadata for the current dataset
   * @returns {DatasetMetadata|null}
   */
  getCurrentMetadata() {
    return this.activeDatasetMetadata;
  }

  /**
   * Get the current source type
   * @returns {string|null}
   */
  getCurrentSourceType() {
    return readSourceType(this.activeSource, 'Active data source');
  }

  /**
   * Get the current dataset ID
   * @returns {string|null}
   */
  getCurrentDatasetId() {
    return this.activeDatasetId;
  }

  /**
   * Get the exact dataset_identity.json id for the current generation.
   * @returns {string|null}
   */
  getCurrentIdentityId() {
    return this.activeIdentityId;
  }

  /**
   * Get the last recorded load method (for analytics)
   * @returns {string|null}
   */
  getLastLoadMethod() {
    return this.lastLoadMethod;
  }

  /**
   * Check if a dataset is currently loaded
   * @returns {boolean}
   */
  hasActiveDataset() {
    return this.activeSource !== null && this.activeDatasetId !== null;
  }

  /**
   * Get state snapshot for serialization
   * @returns {DataSourceState}
   */
  getStateSnapshot() {
    return {
      sourceType: this.activeSource?.getType?.() || null,
      datasetId: this.activeDatasetId,
      userPath: this.activeSource?.getType?.() === 'local-user'
        ? this.activeSource.getPath?.() || null
        : null
    };
  }

  /**
   * Restore state from a snapshot
   * @param {DataSourceState} state - State to restore
   * @param {Object} [options]
   * @param {boolean} [options.silent=false] - Don't notify listeners
   * @returns {Promise<boolean>} - True if restoration succeeded
   */
  async restoreState(state, options = {}) {
    if (!state?.sourceType || !state?.datasetId) {
      return false;
    }

    const source = this.sources.get(state.sourceType);
    if (!source) {
      debug.warn(`[DataSourceManager] Cannot restore: source '${state.sourceType}' not registered`);
      return false;
    }

    // Check if this source requires manual reconnection (e.g., user directories, remote servers)
    if (typeof source.requiresManualReconnect === 'function' && source.requiresManualReconnect()) {
      debug.warn(`[DataSourceManager] Cannot auto-restore '${state.sourceType}' (requires manual reconnection)`);
      return false;
    }

    try {
      await this.switchToDataset(state.sourceType, state.datasetId, options);
      return true;
    } catch (err) {
      debug.warn(`[DataSourceManager] Failed to restore dataset '${state.datasetId}':`, err);
      return false;
    }
  }

  /**
   * Add a callback for dataset changes
   * @param {Function} callback - Callback function
   */
  onDatasetChange(callback) {
    this._onDatasetChangeCallbacks.add(
      requireListener(callback, 'Dataset-change listener')
    );
  }

  /**
   * Remove a dataset change callback
   * @param {Function} callback - Callback to remove
   */
  offDatasetChange(callback) {
    this._onDatasetChangeCallbacks.delete(
      requireListener(callback, 'Dataset-change listener')
    );
  }

  /**
   * Add a callback for source registration changes
   * @param {Function} callback - Callback function
   */
  onSourcesChange(callback) {
    this._onSourcesChangeCallbacks.add(
      requireListener(callback, 'Sources-change listener')
    );
  }

  /**
   * Remove a sources change callback
   * @param {Function} callback - Callback to remove
   */
  offSourcesChange(callback) {
    this._onSourcesChangeCallbacks.delete(
      requireListener(callback, 'Sources-change listener')
    );
  }

  /**
   * Notify all dataset change listeners
   * @param {Object} event - Change event data
   * @private
   */
  _notifyDatasetChange(event) {
    notifyListeners(
      this._onDatasetChangeCallbacks,
      event,
      'Dataset-change'
    );
  }

  /**
   * Notify all sources change listeners
   * @private
   */
  _notifySourcesChange() {
    notifyListeners(
      this._onSourcesChangeCallbacks,
      undefined,
      'Sources-change'
    );
  }

  /**
   * Refresh every source, clearing its cached catalog and cached failure.
   *
   * A source that cannot be refreshed — a GitHub source with no connection, a
   * local directory whose handles have gone stale — reports its own failure
   * instead of rejecting the pass or escaping as an unhandled rejection.
   *
   * @returns {Promise<{sourceType: string, error: Error|null}[]>}
   */
  async refreshAll() {
    return Promise.all(
      [...this.sources.entries()].map(async ([sourceType, source]) => {
        if (typeof source?.refresh !== 'function') {
          return { sourceType, error: null };
        }
        try {
          await source.refresh();
          return { sourceType, error: null };
        } catch (error) {
          debug.log('[DataSourceManager] source refresh failed', {
            sourceType,
            message: error?.message,
          });
          return {
            sourceType,
            error: error instanceof Error ? error : new Error(String(error)),
          };
        }
      })
    );
  }

  /**
   * Default protocol handlers for custom URL schemes.
   * Maps protocol prefix to source type that handles it.
   * @type {Object<string, string>}
   */
  static DEFAULT_PROTOCOL_HANDLERS = {
    'local-user://': 'local-user',
    'remote://': 'remote',
    'remotes://': 'remote',
    'jupyter://': 'jupyter',
  };

  /**
   * Register a custom protocol handler
   * Allows new data source types to register their own URL protocols.
   * @param {string} protocol - Protocol prefix (e.g., 'remote://', 'jupyter://')
   * @param {string} sourceType - Source type that handles this protocol
   * @example
   * manager.registerProtocol('remote://', 'remote-server');
   * manager.registerProtocol('jupyter://', 'jupyter-bridge');
   */
  registerProtocol(protocol, sourceType) {
    if (!protocol.endsWith('://')) {
      debug.warn(`[DataSourceManager] Protocol should end with '://': ${protocol}`);
    }
    setOwnDataProperty(this._protocolHandlers, protocol, sourceType);
    debug.log('[DataSourceManager] Registered protocol', { protocol, sourceType });
  }

  /**
   * Unregister a custom protocol handler
   * @param {string} protocol - Protocol prefix to remove
   */
  unregisterProtocol(protocol) {
    delete this._protocolHandlers[protocol];
  }

  /**
   * Get all registered protocol handlers
   * @returns {Object<string, string>} Map of protocol → sourceType
   */
  getProtocolHandlers() {
    return { ...this._protocolHandlers };
  }

  /**
   * Check if a URL uses a custom protocol handled by a data source
   * @param {string} url - URL to check
   * @returns {boolean}
   */
  isCustomProtocolUrl(url) {
    if (!url) return false;
    for (const protocol of Object.keys(this._protocolHandlers)) {
      if (url.startsWith(protocol)) return true;
    }
    return false;
  }

  /**
   * Get the source type for a custom protocol URL
   * @param {string} url - Custom protocol URL
   * @returns {string|null} Source type or null if not a custom protocol
   */
  getSourceTypeForUrl(url) {
    if (!url) return null;
    for (const [protocol, sourceType] of Object.entries(this._protocolHandlers)) {
      if (url.startsWith(protocol)) return sourceType;
    }
    return null;
  }

  /**
   * Resolve a custom protocol URL to a fetchable URL (async version)
   * Handles local-user://, remote://, jupyter://, etc.
   * @param {string} url - URL that may use a custom protocol
   * @param {AbortSignal|null} signal - Exact request owner
   * @returns {Promise<string>} Standard fetchable URL (http://, https://, blob://, or data://)
   */
  async resolveUrl(url, signal) {
    validateAbortSignalOrNull(signal, 'URL resolution signal');
    throwIfMetadataAborted(signal, 'URL resolution');
    if (!url) return url;

    const sourceType = this.getSourceTypeForUrl(url);
    if (!sourceType) {
      // Standard HTTP(S) URL, return as-is
      return url;
    }

    const source = this.sources.get(sourceType);
    if (!source) {
      throw new DataSourceError(
        `Custom protocol URL requires registered source '${sourceType}': ${url}`,
        DataSourceErrorCode.NOT_FOUND,
        sourceType,
        { sourceType, url }
      );
    }

    return this.resolveUrlWithSource(url, signal, source);
  }

  /**
   * Resolve one custom-protocol URL through an explicit staged source without
   * registering or activating that source. The source implementation remains
   * responsible for validating its exact dataset/transport URL ownership.
   *
   * @param {string} url
   * @param {AbortSignal|null} signal
   * @param {Object} source
   * @returns {Promise<string>}
   */
  async resolveUrlWithSource(url, signal, source) {
    validateAbortSignalOrNull(signal, 'Staged URL resolution signal');
    throwIfMetadataAborted(signal, 'Staged URL resolution');
    const sourceType = this.getSourceTypeForUrl(url);
    if (sourceType === null) {
      throw new DataSourceError(
        `Explicit staged source requires one registered custom protocol URL: ${String(url)}`,
        DataSourceErrorCode.INVALID_FORMAT,
        null,
        { url }
      );
    }
    if (
      source === null ||
      typeof source !== 'object' ||
      typeof source.getType !== 'function' ||
      source.getType() !== sourceType
    ) {
      throw new DataSourceError(
        `Staged custom protocol '${url}' requires one exact ` +
        `'${sourceType}' source owner`,
        DataSourceErrorCode.INVALID_FORMAT,
        sourceType,
        { sourceType, url }
      );
    }
    if (typeof source.resolveUrl !== 'function') {
      throw new DataSourceError(
        `Staged source '${sourceType}' must expose resolveUrl(url, signal) ` +
        `to handle custom protocol URLs`,
        DataSourceErrorCode.UNSUPPORTED,
        sourceType,
        { sourceType, url }
      );
    }

    const resolvedUrl = await waitForMetadata(
      source.resolveUrl(url, signal),
      signal,
      'Staged URL resolution'
    );
    throwIfMetadataAborted(signal, 'Staged URL resolution');
    return resolvedUrl;
  }

  /**
   * Fetch a URL, handling custom protocols automatically
   * @param {string} url - URL to fetch (may be custom protocol)
   * @param {RequestInit} [options] - Fetch options
   * @returns {Promise<Response>}
   */
  async fetch(url, options = {}) {
    const resolvedUrl = await this.resolveUrl(
      url,
      options.signal ?? null
    );
    return fetch(resolvedUrl, options);
  }

  /**
   * Fetch a URL as JSON, handling custom protocols automatically
   * @param {string} url - URL to fetch (may be custom protocol)
   * @returns {Promise<any>}
   */
  async fetchJson(url) {
    const response = await this.fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return readBoundedJson(response, { label: `Metadata ${url}` });
  }
}

// Singleton instance
let _instance = null;

/**
 * Get the singleton DataSourceManager instance
 * @returns {DataSourceManager}
 */
export function getDataSourceManager() {
  if (!_instance) {
    _instance = new DataSourceManager();
  }
  return _instance;
}

/**
 * Create a new DataSourceManager (for testing or custom instances)
 * @returns {DataSourceManager}
 */
export function createDataSourceManager() {
  return new DataSourceManager();
}
