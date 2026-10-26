/**
 * The data source for one dataset file or store opened directly in the
 * browser, whatever format it arrived in (`data/input-formats.js`): one
 * file (`loadFile`), a picked folder (`loadFolder`), a Zarr folder on a web
 * host (`loadRemoteFolder`) or remote files that make one dataset
 * (`loadRemoteFileSet`). The reader worker decides what it is from its
 * content (`anndata/open.js` `openDatasetStore`; a layout view or a
 * transcoder presents a format other than AnnData as an AnnData store) and
 * reads it with the one AnnData reader (`anndata/reader.js`), through
 * `AnnDataReaderClient`: only what a view needs is read, and no byte is
 * decoded on the page's thread. No file
 * size or chunk count is limited; the only bound is the memory the arrays
 * actually shown need.
 *
 * Every dataset is addressed by one scheme, `anndata://<dataset id>/`, which
 * `anndata-provider.js` resolves to this source's adapter; the format is a
 * fact of the open dataset (`format`, `describeStorage()`), not of its
 * address.
 */

import { DataSourceError, DataSourceErrorCode } from './data-source.js';
import { BaseAnnDataAdapter, requireAnnDataLaunchDefaults } from './base-anndata-adapter.js';
import { AnnDataReaderClient } from './anndata-reader-client.js';
import { stoppableOpening } from './opening-progress.js';
import { describeAnnDataStorage } from './anndata-storage.js';
import { defaultDatasetIdOf, inputFormat, titleOfName } from './input-formats.js';
import {
  combineDatasetLifecycleFailures,
  createDatasetReloadSupersededError,
} from './dataset-lifecycle-errors.js';
import {
  getMetadataLoadSignal,
  throwIfMetadataAborted,
} from './metadata-load-contract.js';
import { formatCountOf } from '../utils/format-units.js';

/** The source type, and the scheme of every dataset address it serves. */
export const ANNDATA_SOURCE_TYPE = 'anndata';

/**
 * The store-relative file map of one directory selection
 * (`<input webkitdirectory>`, or a dropped folder), keyed by path below the
 * selected root.
 *
 * @param {FileList|File[]} fileList
 * @returns {{files: Map<string, File>, rootName: string}}
 */
export function folderSourceFromFileList(fileList) {
  if (!fileList || fileList.length === 0) {
    throw new Error('No files provided');
  }
  const firstPath = (fileList[0].webkitRelativePath || fileList[0].name).replace(/\\/g, '/');
  const rootName = firstPath.split('/')[0];
  const files = new Map();
  for (const file of fileList) {
    const relativePath = (file.webkitRelativePath || file.name).replace(/\\/g, '/');
    const internalPath = relativePath.split('/').slice(1).join('/');
    if (internalPath) files.set(internalPath, file);
  }
  if (files.size === 0) {
    throw new Error(
      'No folder structure was provided. Select the store folder itself, not an individual file.'
    );
  }
  return { files, rootName };
}

/** The adapter of an AnnData file source (`BaseAnnDataAdapter`). */
class AnnDataFileAdapter extends BaseAnnDataAdapter {
  static sourceType = ANNDATA_SOURCE_TYPE;
}

/**
 * One dataset file or store opened directly in the browser.
 * Provides the same interface as LocalUserDirDataSource.
 */
export class AnnDataFileSource {
  constructor() {
    /** @type {AnnDataReaderClient|null} */
    this._loader = null;

    /** @type {AnnDataFileAdapter|null} */
    this._adapter = null;

    /** @type {string|null} */
    this.datasetId = null;

    /** @type {string|null} The file or folder name the dataset was opened from */
    this.filename = null;

    /** @type {string|null} The input format id of the open dataset */
    this.format = null;

    /** @type {Object|null} */
    this._metadata = null;

    /** @type {Readonly<import('./anndata-storage.js').AnnDataStorage>|null} */
    this._storage = null;

    /** @type {number} Latest load request identity */
    this._loadRequestId = 0;

    this.type = ANNDATA_SOURCE_TYPE;
  }

  _assertLoadRequest(requestId) {
    if (requestId !== this._loadRequestId) {
      throw createDatasetReloadSupersededError(
        'The dataset load request was superseded by a newer selection.'
      );
    }
  }

  /**
   * Get the type identifier
   * @returns {string}
   */
  getType() {
    return this.type;
  }

  /**
   * Check if a dataset is loaded
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    return this._loader !== null && this._loader.isOpen;
  }

  /**
   * Open one source as a candidate and adopt it once it is complete. The
   * opening is shown from its first moment (`data/opening-progress.js`);
   * Cancel or `signal` close the candidate's reader, which ends its worker
   * and every request it made.
   * @private
   */
  async _loadCandidate(source, options, { title, step }) {
    const requestId = ++this._loadRequestId;
    const {
      signal = null,
      defaults = {},
      datasetId = null,
      defaultDatasetId = null,
      name = null,
      preferFileName = false,
      description = '',
      source: identitySource = null,
      expect = null,
    } = options;
    // Launch defaults are checked before anything is read.
    const launchDefaults = requireAnnDataLaunchDefaults(defaults);
    const candidateReader = new AnnDataReaderClient();
    const opening = stoppableOpening({ title, step, signal, stop: () => candidateReader.close() });
    let candidateAdapter = null;
    let adopted = false;
    try {
      // A file holding several objects asks which to open, in the opening.
      // Opened from a link (its identity names the address) or from this
      // computer: a refusal's advice is what can be done from there.
      const fromLink = typeof identitySource?.url === 'string';
      const opened = await candidateReader.open(source, { expect, fromLink, choose: choice => opening.handle.choose(choice) });
      opening.throwIfStopped();
      this._assertLoadRequest(requestId);
      candidateAdapter = new AnnDataFileAdapter(candidateReader, { defaults: launchDefaults });
      await candidateAdapter.initialize();
      opening.throwIfStopped();
      this._assertLoadRequest(requestId);

      const candidateDatasetId =
        datasetId ??
        candidateAdapter.getFileMetadata().id ??
        defaultDatasetId ??
        defaultDatasetIdOf(opened.format, opened.name);
      const candidateMetadata =
        await candidateAdapter.finalizeDirectIdentity({
          id: candidateDatasetId,
          name: name ?? titleOfName(opened.name),
          preferFileName,
          description,
          // Named by its format; a file also by its file name.
          source: identitySource ?? {
            name: inputFormat(opened.format).label,
            ...(source.file === undefined ? {} : { filename: opened.name }),
          },
        });
      this._assertLoadRequest(requestId);

      const candidateStorage = describeAnnDataStorage(source, opened);
      this._releaseCurrentSource();
      this._loader = candidateReader;
      this._adapter = candidateAdapter;
      this._storage = candidateStorage;
      this.filename = opened.name;
      this.format = opened.format;
      this.datasetId = candidateDatasetId;
      this._metadata = candidateMetadata;
      adopted = true;

      console.log(
        `[AnnDataFileSource] Loaded ${this.filename} (${this.format}): ` +
        `${formatCountOf(this._loader.nObs, 'cell')}, ${formatCountOf(this._loader.nVars, 'gene')}`
      );
      opening.release();
      opening.handle.end();
      return this._metadata;
    } catch (thrown) {
      opening.release();
      const error = opening.outcome(thrown);
      let terminalError = error instanceof Error || error?.name === 'AbortError'
        ? error
        : new TypeError(
            'Dataset loading must reject with an Error.',
            { cause: error }
          );
      if (!adopted) {
        try {
          if (candidateAdapter !== null) {
            candidateAdapter.close();
          } else {
            candidateReader.close();
          }
        } catch (cleanupFailure) {
          terminalError = combineDatasetLifecycleFailures(
            terminalError,
            cleanupFailure,
            'Dataset loading and candidate cleanup both failed.'
          );
        }
      }
      opening.handle.fail(terminalError);
      throw terminalError;
    }
  }

  /**
   * Load one file: a local `File`, or a remote file read in place with
   * range requests (`{url, size, name, identity, head?, access?}`). What it
   * is (an `.h5ad`, a `.zarr.zip`) is decided from its content.
   *
   * @param {File|Blob|{url: string, size: number, name: string}} file
   * @param {Object} [options]
   * @param {AbortSignal|null} [options.signal] - Stops the opening where it
   *   is (its reader worker and every request it made end); Cancel on the
   *   opening progress does the same (`data/opening-progress.js`)
   * @param {string} [options.datasetId] - The id the caller serves the
   *   dataset under (a catalog's, a server's); without one, the id the file
   *   states (`uns['cellucid']['id']`), else `defaultDatasetId`
   * @param {string} [options.defaultDatasetId] - The id of a file that states
   *   none; `<format>_<file name>` by default (`defaultDatasetIdOf`)
   * @param {string} [options.name] - Display name; the file name without its
   *   format's ending by default
   * @param {boolean} [options.preferFileName=false] - Name the dataset by
   *   the name the file gives itself (`uns['cellucid']['name']`, else
   *   `uns['title']`) when it has one
   * @param {string} [options.description]
   * @param {Object} [options.source] - What the Dataset box names the source;
   *   the format's label (`input-formats.js`) and, for a file, its name by
   *   default
   * @param {Object} [options.defaults] - Launch defaults: the choices the
   *   dataset opens with (`requireAnnDataLaunchDefaults`)
   * @param {{format: string, layout: string}|null} [options.expect] - What
   *   a server or catalog says the file is, standing in for its name
   * @returns {Promise<Object>}
   */
  async loadFile(file, options = {}) {
    const remote = typeof file?.url === 'string' && !(typeof Blob !== 'undefined' && file instanceof Blob);
    if (file === null || typeof file !== 'object' || typeof file.name !== 'string') {
      throw new DataSourceError(
        'A dataset file is a named File or a remote file {url, size, name}.',
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
    }
    return this._loadCandidate({ file }, options, {
      title: file.name || 'the file',
      step: remote ? `Connecting to ${new URL(file.url).host}` : 'Reading the file',
    });
  }

  /**
   * Load one folder chosen with a folder picker or dropped: every file below
   * it, each with its path inside the folder (`webkitRelativePath`).
   *
   * @param {FileList|File[]} fileList
   * @param {Object} [options] - As `loadFile`
   * @returns {Promise<Object>}
   */
  async loadFolder(fileList, options = {}) {
    const source = folderSourceFromFileList(fileList);
    return this._loadCandidate(source, options, {
      title: source.rootName || 'the folder',
      step: 'Reading the folder',
    });
  }

  /**
   * Load a store folder on a web host, read in place: its metadata from the
   * store's consolidated metadata (`.zmetadata` for Zarr v2, `zarr.json`
   * for v3), its chunks as views need them, many at once.
   *
   * @param {{url: string, name: string}} folder - The store folder's URL
   *   (its path ending in `/`; a query string is kept) and the name to show
   * @param {Object} [options] - As `loadFile`
   * @returns {Promise<Object>}
   */
  async loadRemoteFolder(folder, options = {}) {
    let folderPath = null;
    try {
      folderPath = new URL(folder?.url).pathname;
    } catch {
      folderPath = null;
    }
    if (folderPath === null || !folderPath.endsWith('/')) {
      throw new DataSourceError(
        'A remote store is opened by its folder address, ending in "/"',
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
    }
    return this._loadCandidate({ url: folder.url, name: folder.name }, options, {
      title: folder.name || 'the store',
      step: `Connecting to ${new URL(folder.url).host}`,
    });
  }

  /**
   * Load several files on a host that make one dataset together (a
   * MatrixMarket matrix and its lists: `describeRemoteFileSet`), read as
   * the folder they would be on this computer.
   *
   * @param {{files: Map<string, {url: string, size: number, name: string}>, rootName: string}} set
   * @param {Object} [options] - As `loadFile`
   * @returns {Promise<Object>}
   */
  async loadRemoteFileSet(set, options = {}) {
    const files = set?.files;
    if (!(files instanceof Map) || files.size === 0 || [...files.values()].some(file => typeof file?.url !== 'string')) {
      throw new DataSourceError(
        'A remote file set is a Map of remote files {url, size, name}.',
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
    }
    const [first] = files.values();
    return this._loadCandidate({ files, rootName: set.rootName }, options, {
      title: set.rootName || 'the files',
      step: `Connecting to ${new URL(first.url).host}`,
    });
  }

  /**
   * List available datasets
   * @returns {Promise<Object[]>}
   */
  async listDatasets() {
    if (!this._metadata) {
      return [];
    }
    return [this._metadata];
  }

  _requireAdopted(datasetId) {
    if (
      typeof datasetId !== 'string' ||
      datasetId.length === 0 ||
      datasetId !== this.datasetId
    ) {
      throw new DataSourceError(
        `Dataset "${String(datasetId)}" is not the adopted dataset ` +
        `"${String(this.datasetId)}"`,
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        {
          requestedId: datasetId,
          currentId: this.datasetId,
        }
      );
    }
  }

  _requireAdapter() {
    if (!this._adapter) {
      throw new DataSourceError('No dataset loaded', DataSourceErrorCode.NOT_FOUND, this.type);
    }
    return this._adapter;
  }

  /**
   * Get metadata for a dataset
   * @param {string} datasetId
   * @returns {Promise<Object>}
   */
  async getMetadata(datasetId) {
    if (!this._metadata) {
      throw new DataSourceError(
        'No dataset loaded',
        DataSourceErrorCode.NOT_FOUND,
        this.type
      );
    }
    this._requireAdopted(datasetId);
    return this._metadata;
  }

  /**
   * Check if a dataset exists
   * @param {string} datasetId
   * @returns {Promise<boolean>}
   */
  async hasDataset(datasetId) {
    return this.datasetId !== null && this.datasetId === datasetId;
  }

  /**
   * The base URL of the dataset: `anndata://<id>/`
   * @param {string} datasetId
   * @returns {string}
   */
  getBaseUrl(datasetId) {
    this._requireAdopted(datasetId);
    return `${ANNDATA_SOURCE_TYPE}://${this.datasetId}/`;
  }

  /**
   * Get the data adapter (for direct data access)
   * @returns {AnnDataFileAdapter|null}
   */
  getAdapter() {
    return this._adapter;
  }

  /**
   * Get obs field data
   * @param {string} key - Field name
   * @returns {Promise<Object>}
   */
  async getObsFieldData(key) {
    return this._requireAdapter().getObsFieldData(key);
  }

  /**
   * Get connectivity edges
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<Object|null>}
   */
  async getConnectivityEdges(options = {}) {
    const signal = getMetadataLoadSignal(options, 'Dataset connectivity edges');
    throwIfMetadataAborted(signal, 'Dataset connectivity edge loading');
    return this._requireAdapter().getConnectivityEdges({ signal });
  }

  /**
   * The obs field list (`BaseAnnDataAdapter.getObsFields`)
   * @returns {Object}
   */
  getObsFields() {
    return this._requireAdapter().getObsFields();
  }

  /**
   * The gene list the dataset opens with (`BaseAnnDataAdapter.getGeneList`)
   * @returns {Promise<Object>}
   */
  getGeneList() {
    return this._requireAdapter().getGeneList();
  }

  /**
   * The summary of the neighbour graph the dataset opens with, or null
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<Object|null>}
   */
  async getConnectivitySummary(options = {}) {
    const signal = getMetadataLoadSignal(options, 'Dataset connectivity summary');
    throwIfMetadataAborted(signal, 'Dataset connectivity summary loading');
    const summary = this._requireAdapter().getConnectivitySummary();
    throwIfMetadataAborted(signal, 'Dataset connectivity summary loading');
    return summary;
  }

  /**
   * The data is read through the adapter, never by URL.
   * @returns {Promise<string>}
   */
  async resolveUrl() {
    throw new DataSourceError(
      'An AnnData file source does not resolve URLs. Use direct data access methods.',
      DataSourceErrorCode.UNSUPPORTED,
      this.type
    );
  }

  /**
   * Called when source is deactivated
   */
  onDeactivate() {
    this.clearCaches();
  }

  /**
   * Release the active source without changing the load request identity.
   * @private
   */
  _releaseCurrentSource() {
    if (this._adapter) {
      this._adapter.close();
      this._adapter = null;
      this._loader = null;
    } else if (this._loader) {
      this._loader.close();
      this._loader = null;
    }

    this.datasetId = null;
    this.filename = null;
    this.format = null;
    this._metadata = null;
    this._storage = null;
  }

  /**
   * Where the open dataset is kept (`data/anndata-storage.js`), or null.
   * @returns {Readonly<import('./anndata-storage.js').AnnDataStorage>|null}
   */
  describeStorage() {
    return this._storage;
  }

  /**
   * Release the dataset and supersede pending loads.
   * @private
   */
  _cleanup() {
    this._loadRequestId++;
    this._releaseCurrentSource();
  }

  /**
   * Clear the current dataset
   */
  clear() {
    this._cleanup();
  }

  /**
   * Clear caches without fully closing the source.
   * Used when deactivating to free memory while keeping the file reference.
   */
  clearCaches() {
    if (this._adapter) {
      this._adapter.clearCaches();
    }
    if (this._loader) {
      this._loader.clearCache();
    }
    console.log('[AnnDataFileSource] Cleared caches to free memory');
  }

  /**
   * Requires manual reconnection (file access)
   * @returns {boolean}
   */
  requiresManualReconnect() {
    return true;
  }
}

/**
 * Create an AnnDataFileSource instance
 * @returns {AnnDataFileSource}
 */
export function createAnnDataFileSource() {
  return new AnnDataFileSource();
}
