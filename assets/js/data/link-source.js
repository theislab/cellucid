/**
 * LinkDataSource - every dataset opened from a link.
 *
 * A link (`?data=`, or text pasted into the Session panel's address bar) names a provider
 * (`sources/registry.js`): GitHub, CELLxGENE, GEO, or any web address. The
 * provider says where the bytes are; this source reads them in one of three
 * forms and knows nothing else about the provider:
 *
 * - one file (an `.h5ad` or a zipped Zarr store: `data/input-formats.js`),
 *   read in place with HTTP range requests by the AnnData reader worker;
 * - one AnnData Zarr store folder on a web host, read key by key;
 * - a dataset catalog: a folder holding `datasets.json` and the AnnData files
 *   it lists (`sources/anndata-catalog.js`), each opened when chosen.
 *
 * Every dataset is served through anndata:// URLs like a local file,
 * and `getAnnDataSource(datasetId)` exposes the source it is read from.
 *
 * Connecting builds a complete candidate before anything is replaced, as the
 * other connection sources do: a failed or superseded link leaves the open
 * one untouched.
 *
 * Opening a link is shown from its first moment (`opening-progress.js`):
 * finding the file at its provider (each provider says its steps), then the
 * reads of the file. Cancel stops it where it is. The reader worker starts
 * loading as the link is resolved, so it is ready when the file is found.
 * A host that ignores range requests serves only the whole file: it is
 * downloaded once, with its progress shown, and read from memory.
 */

import {
  DataSourceError,
  DataSourceErrorCode,
  explainedFailure,
  isExplainedFailure,
} from './data-source.js';
import { createMetadataAbortError } from './metadata-load-contract.js';
import { formatLocator, getProviderRegistry } from './sources/registry.js';
import {
  AnnDataCatalog,
  CATALOG_FILENAME,
  fetchAnnDataCatalog,
} from './sources/anndata-catalog.js';
import { downloadRemoteFile } from './sources/remote-file.js';
import { createAnnDataFileSource } from './anndata-file-source.js';
import { getTransferLog } from './transfer-log.js';
import { prewarmAnnDataReaderWorker } from './anndata-reader-client.js';
import { beginOpening, openingCancelledError } from './opening-progress.js';

/**
 * @typedef {import('./data-source.js').DatasetMetadata} DatasetMetadata
 */

const LINK_SOURCE_TYPE = 'link';

/**
 * What each provider said about a link this page opened, by its canonical
 * locator: opening the same link again in this page (Disconnect and open, a
 * session reopening its dataset) asks the provider nothing, and a file starts
 * from the first bytes read the first time. Only a link that opened is kept.
 * @type {Map<string, Object>}
 */
const PROVIDER_OPENINGS = new Map();

/**
 * Open one remote AnnData file completely, as a candidate. Its dataset id
 * is the one the file states (`uns['cellucid']['id']`), else the link's.
 *
 * @param {Object} file - An entry from `describeRemoteFile`, its `resource`
 *   the remote file or, for a host that serves only whole files, the
 *   downloaded `File`
 * @param {AbortSignal} signal - Stops the opening where it is
 * @returns {Promise<{source: Object, metadata: DatasetMetadata}>}
 */
async function openAnnDataFile(file, signal) {
  const source = createAnnDataFileSource();
  const identitySource = {
    name: file.attribution.title,
    url: file.attribution.url,
    filename: file.name,
    ...(typeof file.attribution.citation === 'string'
      ? { citation: file.attribution.citation }
      : {}),
  };
  try {
    await source.loadFile(file.resource, {
      signal,
      defaultDatasetId: file.id,
      name: file.title,
      preferFileName: true,
      description: '',
      source: identitySource,
      expect: file.format,
    });
    // The id the file states (`uns['cellucid']['id']`), else the link's.
    return { source, metadata: await source.getMetadata(source.datasetId) };
  } catch (error) {
    source.clear();
    throw error;
  }
}

/**
 * Open one Zarr store folder on a web host, as a candidate.
 *
 * @param {{url: string, name: string, title: string, id: string, attribution: Object}} store
 * @param {AbortSignal} signal - Stops the opening where it is
 * @returns {Promise<{source: Object, metadata: DatasetMetadata}>}
 */
async function openZarrFolder(store, signal) {
  if (typeof store.id !== 'string' || store.id.length === 0 || store.id.includes('/')) {
    throw new TypeError('A Zarr store id must be a non-empty string without "/" (it becomes anndata://<id>/).');
  }
  const source = createAnnDataFileSource();
  try {
    await source.loadRemoteFolder({ url: store.url, name: store.name }, {
      signal,
      defaultDatasetId: store.id,
      name: store.title,
      preferFileName: true,
      description: '',
      source: { name: store.attribution.title, url: store.attribution.url, filename: store.name },
    });
    return { source, metadata: await source.getMetadata(source.datasetId) };
  } catch (error) {
    source.clear();
    throw error;
  }
}

export class LinkDataSource {
  /**
   * @param {{registry?: import('./sources/registry.js').ProviderRegistry}} [options]
   */
  constructor({ registry = getProviderRegistry() } = {}) {
    this._registry = registry;

    /** @type {string|null} Canonical locator of the open link */
    this._locator = null;

    /** @type {Object|null} What the provider opened */
    this._opening = null;

    /** @type {AnnDataCatalog|null} An open dataset catalog */
    this._catalog = null;

    /**
     * The catalog a refresh replaced: its open datasets stay readable until
     * the next selection is shown.
     * @type {AnnDataCatalog|null}
     */
    this._retired = null;

    /** @type {{source: Object, metadata: DatasetMetadata}|null} One open file or store */
    this._annData = null;

    /** @type {Object|null} This link's entry in the Transfers log */
    this._transfer = null;

    /** @type {Object[]|null} What the dataset list shows */
    this._datasets = null;

    /** @type {string|null} Dataset whose base URL was handed out last */
    this.datasetId = null;

    this._connected = false;
    this._connectionRevision = 0;
    this._operationRevision = 0;
    /** @type {AbortController|null} */
    this._pendingController = null;

    this.type = LINK_SOURCE_TYPE;
  }

  _beginOperation(reason) {
    const previousController = this._pendingController;
    const controller = new AbortController();
    this._pendingController = controller;
    const revision = ++this._operationRevision;
    previousController?.abort(new Error(reason));
    return { controller, revision };
  }

  _assertOperation(owner, label) {
    if (
      owner.controller.signal.aborted ||
      owner.controller !== this._pendingController ||
      owner.revision !== this._operationRevision
    ) {
      throw createMetadataAbortError(label);
    }
  }

  _finishOperation(owner) {
    if (this._pendingController === owner.controller) {
      this._pendingController = null;
    }
  }

  getType() {
    return this.type;
  }

  /**
   * An isolated connection candidate: validating a link never mutates the
   * registered source.
   * @returns {LinkDataSource}
   */
  createConnectionCandidate() {
    return new LinkDataSource({ registry: this._registry });
  }

  async isAvailable() {
    return this._connected;
  }

  /**
   * Open a catalog folder: its `datasets.json`, and what each file says
   * about itself.
   * @private
   */
  async _loadCatalog(baseUrl, title, signal, { askOnce = false } = {}) {
    let validated;
    try {
      validated = await fetchAnnDataCatalog(baseUrl, this.type, signal, { askOnce });
    } catch (error) {
      if (error?.code !== DataSourceErrorCode.NOT_FOUND) throw error;
      // The commonest mistake: a link to a page, a file listing or the wrong
      // folder. Say what a folder link has to hold.
      throw explainedFailure(
        `${baseUrl} holds no ${CATALOG_FILENAME}, so it is not a dataset catalog. Link to the folder ` +
        `that holds ${CATALOG_FILENAME} (an address ending in "/"), to a Zarr store folder, or to ` +
        'one .h5ad or .zarr.zip file.',
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        { url: `${baseUrl}${CATALOG_FILENAME}`, cause: error }
      );
    }
    const catalog = new AnnDataCatalog({
      baseUrl,
      catalog: validated,
      sourceType: this.type,
      sourceName: title,
    });
    try {
      return { catalog, datasets: await catalog.describe(signal) };
    } catch (error) {
      catalog.close();
      throw error;
    }
  }

  /**
   * Read what one opening holds, completely.
   * @private
   */
  async _load(opening, signal, progress) {
    if (opening.catalog) {
      progress.step('Reading the dataset list');
      const { catalog, datasets } = await this._loadCatalog(opening.catalog.baseUrl, opening.title, signal);
      return { catalog, annData: null, datasets };
    }
    if (opening.store) {
      const annData = await openZarrFolder(opening.store, signal);
      return { catalog: null, annData, datasets: [annData.metadata] };
    }
    if (opening.file) {
      let resource = opening.file.resource;
      if (opening.file.transport === 'download') {
        // The host serves no part of the file: all of it, once.
        progress.step(`Downloading the whole file: ${new URL(resource.url).host} does not serve parts of files`);
        let counted = 0;
        resource = await downloadRemoteFile(resource, {
          signal,
          onBytes: received => {
            getTransferLog().record(opening.file.resource.url, { bytes: received - counted, requests: counted === 0 ? 1 : 0 });
            counted = received;
          },
        });
      }
      const annData = await openAnnDataFile({ ...opening.file, resource }, signal);
      return { catalog: null, annData, datasets: [annData.metadata] };
    }
    throw new TypeError('A provider opening must hold a catalog, a file or a store.');
  }

  /**
   * Open one link.
   *
   * @param {string} input - Pasted text or a `?data=` value
   * @returns {Promise<{locator: string, title: string, datasets: Object[], defaultDatasetId: string|null}>}
   */
  async connect(input) {
    const owner = this._beginOperation('Opening a link was superseded');
    // The reader worker loads while the link is resolved.
    prewarmAnnDataReaderWorker();
    const progress = beginOpening({
      title: String(input).trim() || 'a link',
      step: 'Finding the file',
      onCancel: () => owner.controller.abort(openingCancelledError(String(input).trim())),
    });
    let loaded = null;
    let transfer = null;
    try {
      const { provider, locator: asked, opening } = await this._openProvider(
        input,
        owner.controller.signal,
        progress
      );
      this._assertOperation(owner, 'Opening a link');
      // A provider may name what it opened canonically once it is open (a
      // OneDrive share link by its drive and item): sessions and `?data=`
      // then record that, and either opens it again in this page.
      const locator = typeof opening.locator === 'string' ? formatLocator(provider, opening.locator) : asked;
      progress.rename(opening.title);
      transfer = getTransferLog().begin(opening.file
        ? {
            key: opening.file.resource.url,
            label: opening.file.title,
            why: opening.file.transport === 'download'
              ? 'downloading the whole file: its host does not serve parts of files'
              : 'reading on demand: only what each view needs',
            mode: opening.file.transport === 'download' ? 'download' : 'in-place',
            total: opening.file.resource.size,
          }
        : opening.store
          ? {
              key: opening.store.url,
              label: opening.store.title,
              why: 'reading on demand: only the chunks each view needs',
            }
          : {
              key: opening.catalog.baseUrl,
              label: opening.title,
              why: 'reading on demand: each dataset when it is chosen',
            });
      loaded = await this._load(opening, owner.controller.signal, progress);
      this._assertOperation(owner, 'Opening a link');
      // Named after what was opened: the dataset, or how many a catalog holds
      // (where it is read from is the entry's own line).
      getTransferLog().rename(
        transfer,
        loaded.datasets.length === 1
          ? loaded.datasets[0].name
          : `${loaded.datasets.length} datasets`
      );

      PROVIDER_OPENINGS.set(asked, opening);
      PROVIDER_OPENINGS.set(locator, opening);
      this._releaseAll();
      if (this._transfer !== null) getTransferLog().finish(this._transfer);
      this._transfer = transfer;
      transfer = null;
      this._locator = locator;
      this._opening = { ...opening, provider: provider.id };
      this._catalog = loaded.catalog;
      this._annData = loaded.annData;
      this._datasets = loaded.datasets;
      this.datasetId = null;
      this._connected = true;
      this._connectionRevision++;
      loaded = null;

      progress.end();
      return {
        locator,
        title: opening.title,
        datasets: this._datasets,
        // A catalog names the dataset it opens on; one file is its dataset.
        defaultDatasetId: this._catalog?.defaultDatasetId ?? this._datasets[0]?.id ?? null,
      };
    } catch (thrown) {
      // Cancel names itself as the reason, whatever the stopped read threw.
      const error = progress.cancelled ? openingCancelledError(String(input).trim()) : thrown;
      if (transfer !== null) {
        getTransferLog().finish(transfer, { error });
        transfer = null;
      }
      progress.fail(error);
      // The caller reports the outcome (the Connect control, startup, a
      // session reopening its dataset), as for every other source.
      if (
        error?.name === 'AbortError' ||
        error instanceof DataSourceError ||
        isExplainedFailure(error)
      ) {
        throw error;
      }
      // Only a request that got no answer is a network failure; anything
      // else (a reader refusing what it read) keeps its own message.
      const unanswered = error instanceof TypeError && /fetch|network/i.test(error.message);
      throw new DataSourceError(
        `Failed to open ${input}: ${error?.message ?? error}`,
        unanswered ? DataSourceErrorCode.NETWORK_ERROR : undefined,
        this.type,
        { input, originalError: error?.message }
      );
    } finally {
      loaded?.annData?.source.clear();
      loaded?.catalog?.close();
      this._finishOperation(owner);
    }
  }

  /**
   * Resolve a link and ask its provider where the bytes are. A provider's
   * refusal (a record with several files, a folder link, a host that ignores
   * ranges) is written for the person who pasted the link, so it is marked
   * explained and shown as it is.
   *
   * @private
   */
  async _openProvider(input, signal, progress) {
    try {
      const { provider, value, locator } = this._registry.resolve(input);
      const known = PROVIDER_OPENINGS.get(locator);
      if (known !== undefined) return { provider, value, locator, opening: known };
      // A bare web address is its own host: the probe that follows names it.
      progress.step(provider.id === 'url' ? 'Finding the file' : `Finding the file on ${provider.label}`);
      const opening = await provider.open(value, { signal, onStep: text => progress.step(text) });
      return { provider, value, locator, opening };
    } catch (error) {
      if (error instanceof DataSourceError) {
        error.details = { ...error.details, explained: true };
      }
      throw error;
    }
  }

  /** Release the open file and every dataset a catalog opened. @private */
  _releaseAll() {
    const annData = this._annData;
    this._annData = null;
    annData?.source.clear();
    this._catalog?.close();
    this._catalog = null;
    this._retired?.close();
    this._retired = null;
  }

  disconnect() {
    this._cleanup();
  }

  /** @private */
  _cleanup() {
    this._operationRevision += 1;
    this._pendingController?.abort(new Error('The link was closed'));
    this._pendingController = null;
    this._releaseAll();
    if (this._transfer !== null) getTransferLog().finish(this._transfer);
    this._transfer = null;
    this._locator = null;
    this._opening = null;
    this._datasets = null;
    this.datasetId = null;
    this._connected = false;
    this._connectionRevision++;
  }

  async listDatasets() {
    return this._connected ? this._datasets ?? [] : [];
  }

  async hasDataset(datasetId) {
    return this._connected && (this._datasets ?? []).some(d => d.id === datasetId);
  }

  /** @private */
  _requireConnected() {
    if (!this._connected) {
      throw new DataSourceError(
        'No link is open',
        DataSourceErrorCode.NETWORK_ERROR,
        this.type
      );
    }
  }

  /**
   * One dataset's identity; a catalog's dataset is opened (once) to build it.
   * @param {string} datasetId
   * @returns {Promise<DatasetMetadata>}
   */
  async getMetadata(datasetId, { signal = null } = {}) {
    this._requireConnected();
    if (!(this._datasets ?? []).some(d => d.id === datasetId)) {
      throw new DataSourceError(
        `Dataset '${datasetId}' not found`,
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        { datasetId }
      );
    }
    if (this._catalog !== null) return (await this._catalog.open(datasetId, signal)).metadata;
    return this._annData.metadata;
  }

  /**
   * The AnnData source one dataset is read from, or null when it is not open.
   * @param {string} datasetId
   * @returns {Object|null}
   */
  getAnnDataSource(datasetId) {
    if (this._annData !== null) return this._annData.source;
    return this._catalog?.openedSource(datasetId) ?? this._retired?.openedSource(datasetId) ?? null;
  }

  /**
   * The base URL of one open dataset: the anndata:// URL of its file.
   * @param {string} datasetId
   * @returns {string}
   */
  getBaseUrl(datasetId) {
    this._requireConnected();
    const source = this.getAnnDataSource(datasetId);
    if (source === null) {
      throw new DataSourceError(
        `Dataset '${datasetId}' is not open; its metadata is read first`,
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        { datasetId }
      );
    }
    const baseUrl = source.getBaseUrl(datasetId);
    this.datasetId = datasetId;
    return baseUrl;
  }

  /**
   * The default view the linked catalog names for one dataset, as the sample
   * catalog does; null for a single file or store, and for a dataset with
   * none.
   *
   * @param {string} datasetId
   * @returns {{sessionUrl: string, sessionBytes: number, sessionSha256: string}|null}
   */
  getStateDescriptor(datasetId) {
    if (!this._connected || this._catalog === null || !this._catalog.has(datasetId)) return null;
    const session = this._catalog.sessionOf(datasetId);
    return session === null
      ? null
      : { sessionUrl: session.url, sessionBytes: session.bytes, sessionSha256: session.sha256 };
  }

  /**
   * Release every dataset a catalog opened but `keepId` (null: all).
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
   * Title, link and licence of what is open, for the UI and figure
   * provenance.
   * @returns {Object|null}
   */
  getAttribution() {
    return this._opening?.attribution ?? null;
  }

  getConnectionInfo() {
    return {
      connected: this._connected,
      inputPath: this._locator,
      locator: this._locator,
      provider: this._opening?.provider ?? null,
      title: this._opening?.title ?? null,
      baseUrl: this._catalog?.baseUrl ?? null,
      datasetsCount: this._datasets?.length || 0,
    };
  }

  onDeactivate() {
    // The link stays open: the user may switch back to it. The datasets a
    // catalog opened are released; choosing one opens it again.
    this._catalog?.releaseExcept(null);
  }

  /**
   * Read a linked catalog again, as one complete generation. A file link has
   * nothing to refresh: its file is read in place on demand.
   */
  async refresh() {
    if (!this._connected || this._catalog === null) return;
    const baseUrl = this._catalog.baseUrl;
    const connectionRevision = this._connectionRevision;
    const owner = this._beginOperation('Link refresh was superseded');
    try {
      // A refresh is the person's retry: one request (fetchCatalogFile).
      const { catalog, datasets } = await this._loadCatalog(
        baseUrl,
        this._opening?.title ?? baseUrl,
        owner.controller.signal,
        { askOnce: true }
      );
      this._assertOperation(owner, 'Link refresh');
      if (
        !this._connected ||
        this._catalog?.baseUrl !== baseUrl ||
        this._connectionRevision !== connectionRevision
      ) {
        catalog.close();
        throw new DataSourceError(
          'The link changed during refresh',
          DataSourceErrorCode.VALIDATION_ERROR,
          this.type
        );
      }
      this._retired?.close();
      this._retired = this._catalog;
      this._catalog = catalog;
      this._datasets = datasets;
      if (this.datasetId !== null && !catalog.has(this.datasetId)) {
        this.datasetId = null;
      }
    } catch (error) {
      if (
        error?.name === 'AbortError' &&
        (
          !this._connected ||
          this._catalog?.baseUrl !== baseUrl ||
          this._connectionRevision !== connectionRevision
        )
      ) {
        throw new DataSourceError(
          'The link changed during refresh',
          DataSourceErrorCode.VALIDATION_ERROR,
          this.type
        );
      }
      throw error;
    } finally {
      this._finishOperation(owner);
    }
  }

  /**
   * Cancel transient catalog work; the adopted link and the AnnData reader's
   * own caches stay (the reader drops its caches through
   * `getAnnDataSource()`).
   */
  clearCaches() {
    this._operationRevision += 1;
    this._pendingController?.abort(new Error('Link caches were cleared'));
    this._pendingController = null;
    this._annData?.source.clearCaches?.();
  }

  requiresManualReconnect() {
    return !this._connected;
  }
}

/** @returns {LinkDataSource} */
export function createLinkDataSource() {
  return new LinkDataSource();
}
