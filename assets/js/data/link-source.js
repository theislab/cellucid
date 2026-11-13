/**
 * LinkDataSource - every dataset opened from a link.
 *
 * A link (`?data=`, or text pasted into the Session panel's address bar) names a provider
 * (`sources/registry.js`, `DEFAULT_PROVIDERS`): CELLxGENE, GEO, Zenodo,
 * Figshare, Hugging Face, Google Drive, OneDrive, Dropbox, GitHub, or any web
 * address. The
 * provider says where the bytes are; this source reads them in one of four
 * forms and knows nothing else about the provider:
 *
 * - one file (any single-file format of `data/input-formats.js`),
 *   read in place with HTTP range requests by the AnnData reader worker;
 * - one AnnData Zarr store folder on a web host, read key by key;
 * - several files that make one dataset together (a GEO MatrixMarket
 *   sample: its matrix, features and barcodes), read once each;
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
 * downloaded once into this browser's storage, said up front with its size
 * and progress, and kept for later visits (`whole-download.js`).
 */

import {
  DataSourceError,
  DataSourceErrorCode,
  explainedFailure,
  hostFaultCause,
  hostFaultFailure,
  hostFaultOf,
  isExplainedFailure,
} from './data-source.js';
import { BYTE_SOURCE_FAILURES, isUnanswered } from '../formats/io/byte-source.js';
import { realmHosts } from '../formats/io/hosts.js';
import { formatLocator, getProviderRegistry, publicLocatorOf } from './sources/registry.js';
import { releaseSourceAccessesOf } from './sources/access.js';
import {
  AnnDataCatalog,
  CATALOG_FILENAME,
  fetchAnnDataCatalog,
} from './sources/anndata-catalog.js';
import { afterWholeFileOpened, downloadReason, wholeFileOf } from './whole-download.js';
import { keptStoreManifest } from './anndata/transcode/space.js';
import { matrixMarketSetIdentity } from './anndata/transcode/matrix-market.js';
import { createAnnDataFileSource } from './anndata-file-source.js';
import { getTransferLog } from './transfer-log.js';
import { prewarmAnnDataReaderWorker } from './anndata-reader-client.js';
import { beginOpening, openingCancelledError } from './opening-progress.js';
import { folderFormatOfName, openableNamesText } from './input-formats.js';
import { unreadableAtHost } from './sources/remote-file.js';
import { formatCountOf } from '../utils/format-units.js';
import { isCancellation, cancel, cancelled } from '../utils/abort.js';

/**
 * @typedef {import('./data-source.js').DatasetMetadata} DatasetMetadata
 */

const LINK_SOURCE_TYPE = 'link';

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
 * Open several files on a host that make one dataset (a GEO MatrixMarket
 * sample: `describeRemoteFileSet`), as a candidate.
 *
 * @param {{id: string, rootName: string, title: string, format: Object, attribution: Object, files: Map}} set
 * @param {AbortSignal} signal - Stops the opening where it is
 * @returns {Promise<{source: Object, metadata: DatasetMetadata}>}
 */
async function openRemoteFileSet(set, signal) {
  const source = createAnnDataFileSource();
  try {
    await source.loadRemoteFileSet({ files: set.files, rootName: set.rootName }, {
      signal,
      defaultDatasetId: set.id,
      name: set.title,
      preferFileName: true,
      description: '',
      source: { name: set.attribution.title, url: set.attribution.url, filename: set.rootName },
      expect: set.format,
    });
    return { source, metadata: await source.getMetadata(source.datasetId) };
  } catch (error) {
    source.clear();
    throw error;
  }
}

/**
 * Open one Zarr store folder on a web host, as a candidate.
 *
 * @param {{url: string, name: string, title: string, id: string, attribution: Object, version?: string, key?: string}} store -
 *   `version`: what names the store's content, when its provider says (a commit it is read at);
 *   `key`: where it is whatever its version, when its address names the version read (a link at a commit)
 * @param {AbortSignal} signal - Stops the opening where it is
 * @returns {Promise<{source: Object, metadata: DatasetMetadata}>}
 */
async function openZarrFolder(store, signal) {
  if (typeof store.id !== 'string' || store.id.length === 0 || store.id.includes('/')) {
    throw new TypeError('A Zarr store id must be a non-empty string without "/" (it becomes anndata://<id>/).');
  }
  const source = createAnnDataFileSource();
  try {
    await source.loadRemoteFolder({
      url: store.url,
      name: store.name,
      ...(typeof store.version === 'string' ? { version: store.version } : {}),
      ...(typeof store.key === 'string' ? { key: store.key } : {}),
    }, {
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

    /**
     * @type {string|null} Canonical locator of the open link, as it is read:
     * with any access key it carries. Held here and in the page address
     * only (`getAddressLocator`).
     */
    this._locator = null;

    /** @type {string|null} The same link without what grants access to it */
    this._publicLocator = null;

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
    cancel(previousController, 'superseded', reason);
    return { controller, revision };
  }

  _assertOperation(owner, label) {
    if (
      owner.controller.signal.aborted ||
      owner.controller !== this._pendingController ||
      owner.revision !== this._operationRevision
    ) {
      throw cancelled('superseded', `${label} was superseded.`);
    }
  }

  /**
   * An operation ended. One that failed stops every request it started that
   * is still under way: nothing waits for them any more (a provider asks
   * several at once, and one refusal ends the opening while the others
   * would retry on, past the source's disconnect).
   */
  _finishOperation(owner, { failed = false } = {}) {
    if (failed) cancel(owner.controller, 'superseded', 'The link\'s opening or refresh failed: nothing waits for its other requests.');
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

  /** Whether a link is open now. */
  isConnected() {
    return this._connected;
  }

  /**
   * Open a catalog folder: its `datasets.json`, and what each file says
   * about itself.
   * @private
   */
  async _loadCatalog(baseUrl, title, signal, { askOnce = false, provider = null } = {}) {
    let validated;
    try {
      validated = await fetchAnnDataCatalog(baseUrl, this.type, signal, { askOnce });
    } catch (error) {
      if (error?.code !== DataSourceErrorCode.NOT_FOUND) {
        // No answer this page may read: said as a file's would be.
        throw await unreadableAtLinkError(provider, {
          url: `${baseUrl}${CATALOG_FILENAME}`,
          name: CATALOG_FILENAME,
          format: null,
          // A catalog opens from its host only: what it lists can open from a download.
          nextStep: 'Ask its owner to let other websites read it (CORS headers), or download a dataset it lists and ' +
            'open it from your computer (Open… › File…).',
        }, error, signal);
      }
      // The commonest mistake: a link to a page, a file listing or the wrong
      // folder. Say what a folder link has to hold.
      throw explainedFailure(
        `${baseUrl} holds no ${CATALOG_FILENAME}, so it is not a dataset catalog. Link to the folder ` +
        `that holds ${CATALOG_FILENAME} (an address ending in "/"), to a Zarr store folder, or to ` +
        `one file: ${openableNamesText({ layouts: ['file', 'zip'] })}.`,
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
  async _load(opening, signal, progress, provider) {
    if (opening.catalog) {
      progress.step('Reading the dataset list');
      const { catalog, datasets } = await this._loadCatalog(opening.catalog.baseUrl, opening.title, signal, { provider });
      return { catalog, annData: null, datasets };
    }
    if (opening.store) {
      let annData;
      try {
        annData = await openZarrFolder(opening.store, signal);
      } catch (error) {
        throw await unreadableAtLinkError(provider, {
          url: opening.store.url,
          name: opening.store.name,
          format: folderFormatOfName(opening.store.name),
        }, error, signal);
      }
      return { catalog: null, annData, datasets: [annData.metadata] };
    }
    if (opening.files) {
      // A member its host content-codes is downloaded whole first (the rest
      // are read once each, from the start), or opens from its kept copy;
      // none is, when the set's own store is kept.
      const setIdentity = matrixMarketSetIdentity(opening.files.files);
      const kept = setIdentity === null ? null : await keptStoreManifest(setIdentity);
      const storeKept = kept !== null && kept.whole !== false;
      const files = new Map();
      for (const [name, member] of opening.files.files) {
        files.set(name, member.contentCoded === true && !storeKept
          ? await wholeFileOf(member, { signal, opening: { ...progress, step: text => progress.step(`${name}: ${text}`) } })
          : member);
      }
      const annData = await openRemoteFileSet({ ...opening.files, files }, signal);
      await afterWholeFileOpened(files.values(), annData.source.describeStorage()?.conversion ?? null);
      return { catalog: null, annData, datasets: [annData.metadata] };
    }
    if (opening.file) {
      let resource = opening.file.resource;
      const format = opening.file.format?.format ?? null;
      // The host serves no part of the file: all of it, once (or what an
      // earlier visit kept of it).
      if (opening.file.transport === 'download') resource = await wholeFileOf(resource, { format, signal, opening: progress });
      const annData = await openAnnDataFile({ ...opening.file, resource }, signal);
      if (opening.file.transport === 'download') await afterWholeFileOpened([resource], annData.source.describeStorage()?.conversion ?? null);
      return { catalog: null, annData, datasets: [annData.metadata] };
    }
    throw new TypeError('A provider opening must hold a catalog, a file, a store or a file set.');
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
    // What is said about the link (the opening's title, a failure, the
    // console) names it without its access key.
    const shown = this._registry.publicFormOf(input);
    const progress = beginOpening({
      title: shown || 'a link',
      step: 'Finding the file',
      onCancel: () => owner.controller.abort(openingCancelledError(shown)),
    });
    let loaded = null;
    let transfer = null;
    // What a read of the opened data names when its host fails on its own
    // side: the provider the host serves, and the data.
    let opened = null;
    let reading = shown;
    let adopted = false;
    // What the provider opened, whose files' accesses (`sources/access.js`)
    // go with an opening that fails before its reader took it.
    let providerOpening = null;
    try {
      const { provider, locator: asked, publicLocator: askedPublic, opening } = await this._openProvider(
        input,
        owner.controller.signal,
        progress
      );
      providerOpening = opening;
      this._assertOperation(owner, 'Opening a link');
      opened = provider;
      reading = opening.title;
      // A provider may name what it opened canonically once it is open (a
      // OneDrive share link by its drive and item): sessions and `?data=`
      // then record that, and either opens it again in this page.
      const locator = typeof opening.locator === 'string' ? formatLocator(provider, opening.locator) : asked;
      const publicLocator = typeof opening.locator === 'string' ? publicLocatorOf(provider, opening.locator) : askedPublic;
      progress.rename(opening.title);
      transfer = getTransferLog().begin(opening.file
        ? {
            key: opening.file.resource.url,
            label: opening.file.title,
            why: opening.file.transport === 'download'
              ? `downloading the whole file: ${downloadReason(opening.file.resource, 'its host')}`
              : 'reading on demand: only what each view needs',
            mode: opening.file.transport === 'download' ? 'download' : 'in-place',
            // A content-coded file arrives decoded: its size is not the stated one.
            total: opening.file.resource.contentCoded === true ? null : opening.file.resource.size,
          }
        : opening.store
          ? {
              key: opening.store.url,
              label: opening.store.title,
              why: 'reading on demand: only the chunks each view needs',
            }
          : opening.files
            ? {
                // Every file of the set is in this folder.
                key: new URL('.', opening.files.files.values().next().value.url).href,
                label: opening.files.title,
                why: 'reading the lists and cell tables first, then the matrix once from its start (a MatrixMarket matrix ' +
                  'has no index to read parts of), keeping the rows of the cells genes are read for',
                mode: 'download',
                total: [...opening.files.files.values()].reduce((sum, file) => sum + file.size, 0),
              }
            : {
              key: opening.catalog.baseUrl,
              label: opening.title,
              why: 'reading on demand: each dataset when it is chosen',
            });
      loaded = await this._load(opening, owner.controller.signal, progress, provider);
      this._assertOperation(owner, 'Opening a link');
      // Named after what was opened: the dataset, or how many a catalog holds
      // (where it is read from is the entry's own line).
      getTransferLog().rename(
        transfer,
        loaded.datasets.length === 1
          ? loaded.datasets[0].name
          : `${formatCountOf(loaded.datasets.length, 'dataset')}`
      );

      this._releaseAll();
      if (this._transfer !== null) getTransferLog().finish(this._transfer);
      this._transfer = transfer;
      transfer = null;
      this._locator = locator;
      this._publicLocator = publicLocator;
      this._opening = { ...opening, provider: provider.id };
      this._catalog = loaded.catalog;
      this._annData = loaded.annData;
      this._datasets = loaded.datasets;
      this.datasetId = null;
      this._connected = true;
      this._connectionRevision++;
      loaded = null;
      adopted = true;

      progress.end();
      return {
        locator: publicLocator,
        title: opening.title,
        datasets: this._datasets,
        // A catalog names the dataset it opens on; one file is its dataset.
        defaultDatasetId: this._catalog?.defaultDatasetId ?? this._datasets[0]?.id ?? null,
      };
    } catch (thrown) {
      // Cancel names itself as the reason, whatever the stopped read threw.
      // A read its host did not answer as it should is said by who is at
      // fault (`hostFaultFailure`), named with the provider the host serves,
      // never as Cellucid's failure.
      const fault = progress.cancelled ? null : hostFaultOf(thrown);
      const said = thrown?.details?.hostFault ?? null;
      const error = progress.cancelled
        ? openingCancelledError(shown)
        : fault !== null && (said === null || (fault.service === null && opened !== null && opened.id !== 'url'))
          ? hostFaultFailure(providerFault(opened, { ...fault, what: said?.what ?? reading }),
            { input: shown, cause: hostFaultCause(thrown) })
          : thrown;
      if (transfer !== null) {
        getTransferLog().finish(transfer, { error });
        transfer = null;
      }
      progress.fail(error);
      // The caller reports the outcome (the Connect control, startup, a
      // session reopening its dataset), as for every other source.
      if (
        isCancellation(error) ||
        error instanceof DataSourceError ||
        isExplainedFailure(error)
      ) {
        throw error;
      }
      // Only a request that got no answer is a network failure, as the one
      // transport labels it (`fetchOnce`: no connection, an answer without
      // CORS headers, a stall); anything else (a reader refusing what it
      // read, a programming error whose message names "network") keeps its
      // own message.
      const unanswered = isUnanswered(error);
      throw new DataSourceError(
        `Failed to open ${shown}: ${error?.message ?? error}`,
        unanswered ? DataSourceErrorCode.NETWORK_ERROR : undefined,
        this.type,
        { input: shown, originalError: error?.message }
      );
    } finally {
      loaded?.annData?.source.clear();
      loaded?.catalog?.close();
      if (!adopted && providerOpening !== null) {
        releaseSourceAccessesOf({ file: providerOpening.file?.resource ?? null, files: providerOpening.files?.files ?? null });
      }
      this._finishOperation(owner, { failed: !adopted });
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
    let publicLocator = null;
    // Whatever is said while the link is resolved -- its steps, a refusal --
    // names it by its public form: the text as pasted, the provider's value
    // and its locator never appear in it, whichever provider wrote the text
    // (a OneDrive share id carries its share link whole).
    let shown = text => text;
    let provider = null;
    try {
      const resolved = this._registry.resolve(input);
      provider = resolved.provider;
      const { value, locator } = resolved;
      publicLocator = resolved.publicLocator;
      const publicValue = provider.publicValue(value);
      const raws = [[input.trim(), publicLocator], [locator, publicLocator], [value, publicValue]]
        .filter(([raw, shownAs]) => raw !== '' && raw !== shownAs)
        .sort((left, right) => right[0].length - left[0].length);
      shown = text => (typeof text === 'string' ? raws.reduce((said, [raw, shownAs]) => said.split(raw).join(shownAs), text) : text);
      // Asked of the provider at every opening, never taken from an earlier
      // one: the version it names is the source's now (`remote-file.js`).
      // A bare web address is its own host: the probe that follows names it.
      progress.step(provider.id === 'url' ? 'Finding the file' : `Finding the file on ${provider.label}`);
      const opening = await provider.open(value, { signal, onStep: text => progress.step(shown(text)) });
      return { provider, value, locator, publicLocator, opening };
    } catch (error) {
      if (provider !== null && provider.id !== 'url' && isUnanswered(error) && error.code === BYTE_SOURCE_FAILURES.NETWORK) {
        // A provider's host lets other websites read it: no answer a page
        // may read is no connection, a failing host, or one refusing this
        // network for now (an "unusual traffic" page without CORS headers).
        throw unansweredProviderError(provider, error, shown);
      }
      const fault = hostFaultOf(error);
      if (fault !== null) {
        // Who is at fault, named with the provider the host serves ("NCBI
        // GEO (ftp.ncbi.nlm.nih.gov)"), whichever layer met it.
        throw hostFaultFailure(providerFault(provider, { ...fault, what: shown(error.details.hostFault?.what ?? input.trim()) }),
          { input: publicLocator, cause: hostFaultCause(error) });
      }
      if (error instanceof DataSourceError) {
        // A provider's refusal names what it was given; it is kept, and
        // logged, as the link's public form.
        error.message = shown(error.message);
        error.details = {
          ...error.details,
          ...(Object.hasOwn(error.details ?? {}, 'input') && publicLocator !== null ? { input: publicLocator } : {}),
          explained: true,
        };
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
    cancel(this._pendingController, 'closed', 'The link was closed.');
    this._pendingController = null;
    this._releaseAll();
    if (this._transfer !== null) getTransferLog().finish(this._transfer);
    this._transfer = null;
    this._locator = null;
    this._publicLocator = null;
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
   * Title, link and license of what is open, for the UI and figure
   * provenance.
   * @returns {Object|null}
   */
  getAttribution() {
    return this._opening?.attribution ?? null;
  }

  /**
   * What the open link is read by, with any access key it carries: for the
   * page address alone (`url-state.js`), so a reload opens the same file.
   * Everything else is given `getConnectionInfo().locator`, its public form.
   *
   * @returns {string|null}
   */
  getAddressLocator() {
    return this._locator;
  }

  getConnectionInfo() {
    return {
      connected: this._connected,
      inputPath: this._publicLocator,
      locator: this._publicLocator,
      provider: this._opening?.provider ?? null,
      title: this._opening?.title ?? null,
      baseUrl: this._catalog?.baseUrl ?? null,
      datasetsCount: this._datasets?.length || 0,
      // The dataset it opens on: a catalog's default, else its one dataset.
      defaultDatasetId: this._connected ? this._catalog?.defaultDatasetId ?? this._datasets?.[0]?.id ?? null : null,
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
    let refreshed = false;
    try {
      // A refresh is the person's retry: one request (fetchCatalogFile).
      const { catalog, datasets } = await this._loadCatalog(
        baseUrl,
        this._opening?.title ?? baseUrl,
        owner.controller.signal,
        { askOnce: true, provider: this._registry.get(this._opening?.provider ?? '') }
      );
      this._assertOperation(owner, 'Link refresh');
      if (
        !this._connected ||
        this._catalog?.baseUrl !== baseUrl ||
        this._connectionRevision !== connectionRevision
      ) {
        catalog.close();
        throw cancelled('superseded', 'The link changed during refresh.');
      }
      this._retired?.close();
      this._retired = this._catalog;
      this._catalog = catalog;
      this._datasets = datasets;
      if (this.datasetId !== null && !catalog.has(this.datasetId)) {
        this.datasetId = null;
      }
      refreshed = true;
    } finally {
      this._finishOperation(owner, { failed: !refreshed });
    }
  }

  /**
   * Cancel transient catalog work; the adopted link and the AnnData reader's
   * own caches stay (the reader drops its caches through
   * `getAnnDataSource()`).
   */
  clearCaches() {
    this._operationRevision += 1;
    cancel(this._pendingController, 'released', 'The link\'s connect or refresh was superseded: its caches were cleared.');
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

/**
 * What a link opens without a probe of its own (a Zarr store folder, a
 * dataset catalog) whose first read got no answer a page may read, said as a
 * file's probe says it: on a bare web address, whether its host does not let
 * other websites read it, cannot be reached or refuses this network for now
 * (`unreadableAtHost`); on a provider's host, which lets other websites read
 * it, `unansweredProviderError`. Any other failure as it is. The byte
 * layer's failure may come wrapped (`fetchJson`'s `details.cause`).
 */
async function unreadableAtLinkError(provider, { url, name, format, nextStep }, error, signal) {
  if (isCancellation(error)) return error;
  const unanswered = isUnanswered(error) ? error : isUnanswered(error?.details?.cause) ? error.details.cause : null;
  if (unanswered === null) return error;
  if (provider !== null && provider.id !== 'url') return unansweredProviderError(provider, unanswered, text => text);
  const at = URL.canParse(unanswered.details?.url ?? '') ? unanswered.details.url : url;
  return unreadableAtHost({ url: at, name, format, error: unanswered, signal, nextStep });
}

/**
 * A provider's request that got no answer a page may read, written for the
 * person: the provider's host lets other websites read it (that is why it is
 * a provider), so it is not CORS. Asked again once already (`withRetries`):
 * the person decides when to try again.
 */
function unansweredProviderError(provider, error, shown) {
  // The host the request went to (`details.host`; `details.url` may be a
  // request's label, `api-request.js`).
  let host = typeof error.details?.host === 'string' ? error.details.host : null;
  if (host === null && URL.canParse(error.details?.url ?? '')) host = new URL(error.details.url).host;
  if (!realmHosts.online() || (host !== null && realmHosts.connectionDown(`https://${host}/`))) {
    return hostFaultFailure({
      kind: !realmHosts.online() ? 'offline' : 'connection',
      host: host ?? provider.label,
      what: 'it',
      service: provider.label,
    }, { request: shown(error.message) });
  }
  const where = host === null ? provider.label : `${provider.label} (${host})`;
  return new DataSourceError(
    `${where} is not answering this site: no answer arrived. ${provider.label} lets other websites read it, so this ` +
    `is a problem on ${provider.label}'s side (an outage, or a block of this network for a while after many ` +
    'requests from it) or this computer\'s connection, not the link or Cellucid. Try again later.',
    DataSourceErrorCode.NETWORK_ERROR,
    'link',
    { explained: true, host, request: shown(error.message) }
  );
}

/**
 * A host fault met while opening a provider's link, as said of that
 * provider: named with it ("NCBI GEO (ftp.ncbi.nlm.nih.gov)"; a bare web
 * address is its own host), and a refusal (401, 403) of a provider whose
 * every file is public (`capabilities.public`: GEO, the CELLxGENE Census) is
 * that host refusing this network for now (`refusing`), never the link's
 * permissions: NCBI has answered 403 for its files during an outage.
 *
 * @param {Object|null} provider
 * @param {Object} fault - `hostFaultOf`'s fields with `what`
 * @returns {Object}
 */
function providerFault(provider, fault) {
  const named = provider !== null && provider.id !== 'url';
  return {
    ...fault,
    service: fault.service ?? (named ? provider.label : null),
    kind: fault.kind === 'refused' && provider?.capabilities.public === true ? 'refusing' : fault.kind,
  };
}
