/**
 * LocalDemoDataSource - the Sample dataset list: the dataset catalog the page
 * names (`DATA_CONFIG.SAMPLE_CATALOG_URL`, from the `cellucid-sample-catalog`
 * meta element or one `sampleCatalog` query field), read by
 * `sources/anndata-catalog.js`.
 *
 * In production the catalog is the `cellucid-datasets` site: a folder of
 * AnnData files with its `datasets.json`.
 */

import {
  DATA_CONFIG,
  DataSourceError,
  DataSourceErrorCode,
  resolveUrl,
} from './data-source.js';
import { createMetadataAbortError } from './metadata-load-contract.js';
import {
  AnnDataCatalog,
  CATALOG_FILENAME,
  fetchAnnDataCatalog,
} from './sources/anndata-catalog.js';

/**
 * @typedef {import('./data-source.js').DatasetMetadata} DatasetMetadata
 * @typedef {import('./data-source.js').DatasetSummary} DatasetSummary
 */

/** What the dataset panel names the source of a sample that names none. */
const SAMPLE_SOURCE_NAME = 'Cellucid sample datasets';

export class LocalDemoDataSource {
  /**
   * @param {string|null} [baseUrl] - The catalog folder URL
   * @param {Error|null} [configurationError] - Parsed startup configuration failure
   */
  constructor(
    baseUrl = DATA_CONFIG.SAMPLE_CATALOG_URL,
    configurationError = DATA_CONFIG.SAMPLE_CATALOG_CONFIGURATION_ERROR
  ) {
    if (
      baseUrl !== null &&
      (
        typeof baseUrl !== 'string' ||
        baseUrl.length === 0 ||
        baseUrl !== baseUrl.trim() ||
        !baseUrl.endsWith('/') ||
        new URL(baseUrl).href !== baseUrl
      )
    ) {
      throw new TypeError(
        'LocalDemoDataSource baseUrl must be one exact absolute folder URL or null.'
      );
    }
    if (
      configurationError !== null &&
      !(configurationError instanceof Error)
    ) {
      throw new TypeError(
        'LocalDemoDataSource configurationError must be an Error or null.'
      );
    }
    this.baseUrl = baseUrl;
    this.configurationError = configurationError;
    this.catalogUrl = this.baseUrl === null
      ? null
      : resolveUrl(this.baseUrl, CATALOG_FILENAME);
    this.type = 'local-demo';

    /** @type {AnnDataCatalog|null} */
    this._catalog = null;
    /**
     * The catalog a refresh replaced: its open datasets stay readable until
     * the next selection is shown.
     * @type {AnnDataCatalog|null}
     */
    this._retired = null;
    /** @type {DatasetSummary[]|null} */
    this._datasets = null;
    this._datasetError = null;
    this._availabilityError = null;
    this._catalogRevision = 0;
    this._catalogController = new AbortController();
    this._catalogInFlight = null;
    this._datasetsInFlight = null;
    /**
     * Whether the catalog is read again because the person asked
     * (`refresh()`): their retry is one request, never a schedule of
     * requests behind the failure they are looking at.
     */
    this._askOnce = false;

    /** @type {string|null} Dataset whose base URL was handed out last */
    this.datasetId = null;
  }

  _captureCatalogGeneration() {
    return {
      controller: this._catalogController,
      revision: this._catalogRevision,
    };
  }

  _assertCatalogGeneration(owner) {
    if (
      owner.controller.signal.aborted ||
      owner.controller !== this._catalogController ||
      owner.revision !== this._catalogRevision
    ) {
      throw createMetadataAbortError('Sample catalog generation');
    }
  }

  getType() {
    return this.type;
  }

  /**
   * Whether the page names a sample catalog that loads.
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    if (this.catalogUrl === null && this.configurationError === null) {
      return false;
    }
    if (this._availabilityError !== null) throw this._availabilityError;
    const owner = this._captureCatalogGeneration();
    try {
      await this._loadCatalog(owner);
      return true;
    } catch (error) {
      this._assertCatalogGeneration(owner);
      this._availabilityError = error;
      throw error;
    }
  }

  /**
   * Load `datasets.json` once per catalog generation.
   * @returns {Promise<AnnDataCatalog>}
   * @private
   */
  async _loadCatalog(owner = this._captureCatalogGeneration()) {
    this._assertCatalogGeneration(owner);
    if (this.configurationError !== null) {
      throw new DataSourceError(
        this.configurationError.message,
        DataSourceErrorCode.INVALID_FORMAT,
        this.type,
        { cause: this.configurationError }
      );
    }
    if (this.baseUrl === null) {
      throw new DataSourceError(
        'Sample datasets are not configured. Set exactly one ?sampleCatalog=https://host/folder/ ' +
        'query field or one cellucid-sample-catalog meta element.',
        DataSourceErrorCode.INVALID_FORMAT,
        this.type,
        { hint: 'configure cellucid-sample-catalog' }
      );
    }
    if (this._catalog !== null) return this._catalog;
    const current = this._catalogInFlight;
    if (current?.controller === owner.controller && current.revision === owner.revision) {
      return current.promise;
    }
    const promise = (async () => {
      const catalog = await fetchAnnDataCatalog(
        this.baseUrl,
        this.type,
        owner.controller.signal,
        { askOnce: this._askOnce }
      );
      this._assertCatalogGeneration(owner);
      this._catalog = new AnnDataCatalog({
        baseUrl: this.baseUrl,
        catalog,
        sourceType: this.type,
        sourceName: SAMPLE_SOURCE_NAME,
      });
      return this._catalog;
    })();
    const inFlight = { controller: owner.controller, revision: owner.revision, promise };
    this._catalogInFlight = inFlight;
    try {
      return await promise;
    } finally {
      if (this._catalogInFlight === inFlight) this._catalogInFlight = null;
    }
  }

  /**
   * What the Sample dataset list shows: every dataset's name and counts, read
   * from its file's metadata.
   * @returns {Promise<DatasetSummary[]>}
   */
  async listDatasets() {
    if (this._datasets) return this._datasets;
    if (this._datasetError !== null) throw this._datasetError;
    const owner = this._captureCatalogGeneration();
    const current = this._datasetsInFlight;
    if (current?.controller === owner.controller && current.revision === owner.revision) {
      return current.promise;
    }
    const promise = (async () => {
      const catalog = await this._loadCatalog(owner);
      try {
        const datasets = await catalog.describe(owner.controller.signal);
        this._assertCatalogGeneration(owner);
        this._datasets = datasets;
        return datasets;
      } catch (error) {
        this._assertCatalogGeneration(owner);
        this._datasetError = error;
        throw error;
      }
    })();
    const inFlight = { controller: owner.controller, revision: owner.revision, promise };
    this._datasetsInFlight = inFlight;
    try {
      return await promise;
    } finally {
      if (this._datasetsInFlight === inFlight) this._datasetsInFlight = null;
    }
  }

  /**
   * The catalog's default dataset id.
   * @returns {Promise<string>}
   */
  async getDefaultDatasetId() {
    return (await this._loadCatalog()).defaultDatasetId;
  }

  /**
   * One dataset's identity: its file is opened (once) to build it.
   * @param {string} datasetId
   * @returns {Promise<DatasetMetadata>}
   */
  async getMetadata(datasetId) {
    const catalog = await this._loadCatalog();
    if (!catalog.has(datasetId)) {
      throw new DataSourceError(
        `Dataset '${datasetId}' not found`,
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        { datasetId }
      );
    }
    return (await catalog.open(datasetId)).metadata;
  }

  /**
   * @param {string} datasetId
   * @returns {Promise<boolean>}
   */
  async hasDataset(datasetId) {
    return (await this._loadCatalog()).has(datasetId);
  }

  /** @private */
  _openedSource(datasetId) {
    return this._catalog?.openedSource(datasetId) ?? this._retired?.openedSource(datasetId) ?? null;
  }

  /**
   * The base URL of one opened dataset: its h5ad:// or zarr:// URL.
   * @param {string} datasetId
   * @returns {string}
   */
  getBaseUrl(datasetId) {
    const source = this._openedSource(datasetId);
    if (source === null) {
      throw new DataSourceError(
        `Sample dataset '${datasetId}' is not open; its metadata is read first`,
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        { datasetId }
      );
    }
    this.datasetId = datasetId;
    return source.getBaseUrl(datasetId);
  }

  /**
   * The AnnData source one opened dataset is read from (`anndata-provider.js`).
   * @param {string} datasetId
   * @returns {Object|null}
   */
  getAnnDataSource(datasetId) {
    return this._openedSource(datasetId);
  }

  /**
   * The default view the catalog names for one dataset, or null.
   * @param {string} datasetId
   * @returns {{sessionUrl: string, sessionBytes: number, sessionSha256: string}|null}
   */
  getStateDescriptor(datasetId) {
    if (this._catalog === null || !this._catalog.has(datasetId)) return null;
    const session = this._catalog.sessionOf(datasetId);
    return session === null
      ? null
      : { sessionUrl: session.url, sessionBytes: session.bytes, sessionSha256: session.sha256 };
  }

  /**
   * Release every open dataset but `keepId` (null releases all).
   * @param {string|null} keepId
   */
  releaseExcept(keepId) {
    this._catalog?.releaseExcept(keepId);
    if (this._retired !== null && this._retired.openedSource(keepId) === null) {
      this._retired.close();
      this._retired = null;
    }
  }

  /**
   * Read the catalog again, as one new generation, because the person asked.
   * The datasets already open stay readable until another is shown.
   */
  refresh() {
    this._askOnce = true;
    const previousController = this._catalogController;
    this._catalogController = new AbortController();
    this._catalogRevision += 1;
    previousController.abort(new Error('Sample catalog cache was refreshed'));
    this._catalogInFlight = null;
    this._datasetsInFlight = null;
    if (this._catalog !== null) {
      this._retired?.close();
      this._retired = this._catalog;
    }
    this._catalog = null;
    this._datasets = null;
    this._datasetError = null;
    this._availabilityError = null;
  }

  requiresManualReconnect() {
    return false;
  }

  /** Another source is shown: its datasets are released. */
  onDeactivate() {
    this.releaseExcept(null);
  }
}

/**
 * A LocalDemoDataSource for the page's sample catalog.
 * @returns {LocalDemoDataSource}
 */
export function createLocalDemoDataSource() {
  return new LocalDemoDataSource(
    DATA_CONFIG.SAMPLE_CATALOG_URL,
    DATA_CONFIG.SAMPLE_CATALOG_CONFIGURATION_ERROR
  );
}
