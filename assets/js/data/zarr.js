/**
 * Zarr Module for Cellucid
 *
 * The data source for one AnnData Zarr store (v2 or v3) opened directly in
 * the browser: a `.zarr.zip` archive, or a directory's file list. The store
 * is read by the AnnData reader (`anndata/reader.js`, over the Zarr reader of
 * `formats/zarr`) in the AnnData reader worker, through
 * `AnnDataReaderClient`: only the chunks a view needs are read, and no chunk
 * is decoded on the page's thread. No store size or chunk count is limited;
 * the only bound is the memory the arrays actually shown need.
 *
 * The bridge that routes the application's data requests to this source lives
 * in `anndata-provider.js`, which serves zarr:// and h5ad:// alike.
 */

import { DataSourceError, DataSourceErrorCode } from './data-source.js';
import { BaseAnnDataAdapter, requireAnnDataLaunchDefaults } from './base-anndata-adapter.js';
import { AnnDataReaderClient } from './anndata-reader-client.js';
import { stoppableOpening } from './opening-progress.js';
import { describeAnnDataStorage } from './anndata-storage.js';
import {
  combineDatasetLifecycleFailures,
  createDatasetReloadSupersededError,
} from './dataset-lifecycle-errors.js';
import {
  getMetadataLoadSignal,
  throwIfMetadataAborted,
} from './metadata-load-contract.js';

/**
 * Check if a FileList appears to be a zarr directory
 * @param {FileList} files - FileList to check
 * @returns {boolean}
 */
export function isZarrDirectory(files) {
  if (!files || files.length === 0) return false;

  // Check if any file has .zarr in the path
  for (const file of files) {
    const path = file.webkitRelativePath || file.name;
    if (path.includes('.zarr/') || path.endsWith('.zarr')) {
      return true;
    }
    // Or for Zarr metadata files: .zarray / .zgroup (v2), zarr.json (v3)
    if (path.endsWith('.zarray') || path.endsWith('.zgroup') || path.endsWith('/zarr.json')) {
      return true;
    }
  }
  return false;
}

/**
 * The store-relative file map of one directory selection
 * (`<input webkitdirectory>`), keyed by path below the selected root.
 *
 * @param {FileList|File[]} fileList
 * @returns {{files: Map<string, File>, rootName: string}}
 */
export function zarrStoreFromFileList(fileList) {
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
      'No Zarr directory structure was provided. Select the .zarr directory, not an individual file.'
    );
  }
  return { files, rootName };
}

// ============================================================================
// ZARR DATA SOURCE
// ============================================================================

/**
 * Zarr-specific adapter extending the shared BaseAnnDataAdapter.
 * Any zarr-specific overrides would go here.
 */
class ZarrDataAdapter extends BaseAnnDataAdapter {
  static sourceType = 'zarr';

  // ZarrDataAdapter uses all methods from BaseAnnDataAdapter without modification.
  // Any zarr-specific overrides can be added here if needed in the future.
}

/**
 * Zarr Data Source for Cellucid
 * Provides the same interface as LocalUserDirDataSource but for zarr directories
 */
export class ZarrDataSource {
  constructor() {
    /** @type {AnnDataReaderClient|null} */
    this._loader = null;

    /** @type {ZarrDataAdapter|null} */
    this._adapter = null;

    /** @type {string|null} */
    this.datasetId = null;

    /** @type {string|null} */
    this.dirname = null;

    /** @type {Object|null} */
    this._metadata = null;

    /** @type {Readonly<import('./anndata-storage.js').AnnDataStorage>|null} */
    this._storage = null;

    /** @type {number} Latest directory-selection request identity */
    this._loadRequestId = 0;

    this.type = 'zarr';
  }

  _assertLoadRequest(requestId) {
    if (requestId !== this._loadRequestId) {
      throw createDatasetReloadSupersededError(
        'Zarr load request was superseded by a newer selection.'
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
   * Check if a file is loaded
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    return this._loader !== null && this._loader.isOpen;
  }

  /**
   * Open one store as a candidate and adopt it once it is complete. The
   * opening is shown from its first moment (`data/opening-progress.js`);
   * Cancel or `signal` close the candidate's reader, which ends its worker
   * and every request it made.
   * @private
   */
  async _loadCandidate(requestId, source, identityOptions, { title, step, signal = null }) {
    // Launch defaults are checked before anything is read.
    const defaults = requireAnnDataLaunchDefaults(identityOptions.defaults ?? {});
    const candidateReader = new AnnDataReaderClient({ kind: 'zarr' });
    const opening = stoppableOpening({ title, step, signal, stop: () => candidateReader.close() });
    let candidateAdapter = null;
    let adopted = false;
    try {
      const { name: candidateDirname } = await candidateReader.open(source);
      opening.throwIfStopped();
      this._assertLoadRequest(requestId);
      candidateAdapter = new ZarrDataAdapter(candidateReader, { defaults });
      await candidateAdapter.initialize();
      opening.throwIfStopped();
      this._assertLoadRequest(requestId);

      // A store is named by its folder or archive, without `.zarr`/`.zip`.
      const storeName = candidateDirname.replace(/(\.zarr)?(\.zip)?$/i, '') || candidateDirname;
      const candidateDatasetId =
        identityOptions.datasetId ??
        candidateAdapter.getFileMetadata().id ??
        identityOptions.defaultDatasetId ??
        `zarr_${storeName}`;
      const candidateMetadata =
        await candidateAdapter.finalizeDirectIdentity({
          id: candidateDatasetId,
          name: identityOptions.name ?? storeName,
          preferFileName: identityOptions.preferFileName === true,
          description: identityOptions.description,
          source: identityOptions.source,
        });
      this._assertLoadRequest(requestId);

      const candidateStorage = describeAnnDataStorage('zarr', source, {
        name: candidateDirname,
        zarrVersion: candidateReader.zarrVersion,
      });
      this._releaseCurrentSource();
      this._loader = candidateReader;
      this._adapter = candidateAdapter;
      this._storage = candidateStorage;
      this.dirname = candidateDirname;
      this.datasetId = candidateDatasetId;
      this._metadata = candidateMetadata;
      adopted = true;

      console.log(
        `[ZarrDataSource] Loaded ${this.dirname}: ` +
        `${this._loader.nObs} cells, ${this._loader.nVars} genes`
      );
      opening.release();
      opening.handle.end();
      return this._metadata;
    } catch (thrown) {
      opening.release();
      const error = opening.outcome(thrown);
      let terminalError = error instanceof Error
        ? error
        : new TypeError(
            'Zarr candidate loading must reject with an Error.',
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
            'Zarr candidate loading and cleanup both failed.'
          );
        }
      }
      opening.handle.fail(terminalError);
      throw terminalError;
    }
  }

  /**
   * Load a zarr directory from FileList
   * @param {FileList} fileList - FileList from <input type="file" webkitdirectory>
   * @param {Object} [options]
   * @param {AbortSignal|null} [options.signal] - Stops the opening where it
   *   is; Cancel on the opening progress does the same
   * @param {string} [options.datasetId] - The id the caller serves the
   *   dataset under; without one, the id the store states
   *   (`uns['cellucid']['id']`), else `defaultDatasetId`
   * @param {string} [options.defaultDatasetId] - The id of a store that states
   *   none; `zarr_<folder name>` by default
   * @param {string} [options.description]
   * @param {Object} [options.source]
   * @param {Object} [options.defaults] - Launch defaults: the choices the
   *   dataset opens with (`requireAnnDataLaunchDefaults`)
   * @returns {Promise<Object>}
   */
  async loadFromFileList(fileList, options = {}) {
    if (!isZarrDirectory(fileList)) {
      throw new DataSourceError(
        'Not a zarr directory',
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
    }

    const requestId = ++this._loadRequestId;
    const {
      signal = null,
      defaults = {},
      datasetId = null,
      defaultDatasetId = null,
      preferFileName = false,
      description = '',
      source = {
        name: 'Zarr directory',
      },
    } = options;
    const firstPath = (
      fileList[0].webkitRelativePath || fileList[0].name
    ).replace(/\\/g, '/');
    const candidateDirname = firstPath.split('/')[0];
    return this._loadCandidate(
      requestId,
      zarrStoreFromFileList(fileList),
      { datasetId, defaultDatasetId, preferFileName, description, source, defaults },
      { title: candidateDirname || 'Zarr directory', step: 'Reading the folder', signal },
    );
  }

  /**
   * Load one portable ZIP archive containing a Zarr v2 store.
   * Archive parsing and source adoption share the same latest-request identity.
   *
   * @param {File|Blob|{url: string, size: number, name: string}} file - A
   *   local file, or a remote file read in place with range requests
   * @param {Object} [options]
   * @param {AbortSignal|null} [options.signal] - Stops the opening where it
   *   is; Cancel on the opening progress does the same
   * @param {string} [options.datasetId] - The id the caller serves the
   *   dataset under; without one, the id the store states
   *   (`uns['cellucid']['id']`), else `defaultDatasetId`
   * @param {string} [options.defaultDatasetId] - The id of a store that states
   *   none; `zarr_<folder name>` by default
   * @param {string} [options.name] - Display name; defaults to the store's
   *   folder name
   * @param {boolean} [options.preferFileName=false] - Name the dataset by
   *   the name the store gives itself (`uns['cellucid']['name']`, else
   *   `uns['title']`) when it has one
   * @param {string} [options.description]
   * @param {Object} [options.source]
   * @param {Object} [options.defaults] - Launch defaults: the choices the
   *   dataset opens with (`requireAnnDataLaunchDefaults`)
   * @returns {Promise<Object>}
   */
  async loadFromArchiveFile(file, options = {}) {
    const remote = typeof file?.url === 'string' && Number.isSafeInteger(file?.size);
    if (!file || (!remote && typeof file.arrayBuffer !== 'function')) {
      throw new DataSourceError(
        'Not a Zarr ZIP archive',
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
    }

    const requestId = ++this._loadRequestId;
    const {
      signal = null,
      defaults = {},
      datasetId = null,
      defaultDatasetId = null,
      name = null,
      preferFileName = false,
      description = '',
      source = {
        name: 'Zarr ZIP archive',
        ...(typeof file.name === 'string'
          ? { filename: file.name }
          : {}),
      },
    } = options;
    return this._loadCandidate(
      requestId,
      { archive: file },
      { datasetId, defaultDatasetId, name, preferFileName, description, source, defaults },
      {
        title: file.name || 'Zarr ZIP archive',
        step: remote ? `Connecting to ${new URL(file.url).host}` : 'Reading the archive',
        signal,
      },
    );
  }

  /**
   * Load a Zarr store from a folder on a web host, read in place: its
   * metadata from the store's consolidated metadata (`.zmetadata` for Zarr
   * v2, `zarr.json` for v3), its chunks as views need them, many at once.
   *
   * @param {{url: string, name: string}} folder - The store folder's URL
   *   (its path ending in `/`; a query string is kept) and the name to show
   * @param {Object} [options] - As `loadFromArchiveFile`
   * @returns {Promise<Object>}
   */
  async loadFromRemoteFolder(folder, options = {}) {
    let folderPath = null;
    try {
      folderPath = new URL(folder?.url).pathname;
    } catch {
      folderPath = null;
    }
    if (folderPath === null || !folderPath.endsWith('/')) {
      throw new DataSourceError(
        'A remote Zarr store is opened by its folder address, ending in "/"',
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
    }
    const requestId = ++this._loadRequestId;
    const {
      signal = null,
      defaults = {},
      datasetId = null,
      defaultDatasetId = null,
      name = null,
      preferFileName = false,
      description = '',
      source = { name: 'Zarr store', filename: folder.name },
    } = options;
    return this._loadCandidate(
      requestId,
      { url: folder.url, name: folder.name },
      { datasetId, defaultDatasetId, name, preferFileName, description, source, defaults },
      { title: folder.name || 'Zarr store', step: `Connecting to ${new URL(folder.url).host}`, signal },
    );
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

  /**
   * Get metadata for a dataset
   * @param {string} datasetId
   * @returns {Promise<Object>}
   */
  async getMetadata(datasetId) {
    if (!this._metadata) {
      throw new DataSourceError(
        'No zarr directory loaded',
        DataSourceErrorCode.NOT_FOUND,
        this.type
      );
    }
    if (
      typeof datasetId !== 'string' ||
      datasetId.length === 0 ||
      datasetId !== this.datasetId
    ) {
      throw new DataSourceError(
        `Zarr dataset "${String(datasetId)}" is not the adopted dataset ` +
        `"${String(this.datasetId)}"`,
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        {
          requestedId: datasetId,
          currentId: this.datasetId,
        }
      );
    }
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
   * Get base URL for the dataset
   * @param {string} datasetId
   * @returns {string}
   */
  getBaseUrl(datasetId) {
    if (
      typeof datasetId !== 'string' ||
      datasetId.length === 0 ||
      datasetId !== this.datasetId
    ) {
      throw new DataSourceError(
        `Zarr dataset "${String(datasetId)}" is not the adopted dataset ` +
        `"${String(this.datasetId)}"`,
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        {
          requestedId: datasetId,
          currentId: this.datasetId,
        }
      );
    }
    return `zarr://${this.datasetId}/`;
  }

  /**
   * Get the Zarr data adapter (for direct data access)
   * @returns {ZarrDataAdapter|null}
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
    if (!this._adapter) {
      throw new DataSourceError('No zarr directory loaded', DataSourceErrorCode.NOT_FOUND, this.type);
    }
    return this._adapter.getObsFieldData(key);
  }

  /**
   * Get connectivity edges
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<Object|null>}
   */
  async getConnectivityEdges(options = {}) {
    const signal = getMetadataLoadSignal(
      options,
      'Zarr connectivity edges'
    );
    throwIfMetadataAborted(signal, 'Zarr connectivity edge loading');
    if (!this._adapter) {
      throw new DataSourceError(
        'No zarr directory loaded',
        DataSourceErrorCode.NOT_FOUND,
        this.type
      );
    }
    return this._adapter.getConnectivityEdges({ signal });
  }

  /**
   * The obs field list (`BaseAnnDataAdapter.getObsFields`)
   * @returns {Object}
   */
  getObsFields() {
    if (!this._adapter) {
      throw new DataSourceError('No zarr directory loaded', DataSourceErrorCode.NOT_FOUND, this.type);
    }
    return this._adapter.getObsFields();
  }

  /**
   * The gene list the file opens with (`BaseAnnDataAdapter.getGeneList`)
   * @returns {Promise<Object>}
   */
  getGeneList() {
    if (!this._adapter) {
      throw new DataSourceError('No zarr directory loaded', DataSourceErrorCode.NOT_FOUND, this.type);
    }
    return this._adapter.getGeneList();
  }

  /**
   * The summary of the neighbour graph the file opens with, or null
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<Object|null>}
   */
  async getConnectivitySummary(options = {}) {
    const signal = getMetadataLoadSignal(
      options,
      'Zarr connectivity summary'
    );
    throwIfMetadataAborted(signal, 'Zarr connectivity summary loading');
    if (!this._adapter) {
      throw new DataSourceError(
        'No zarr directory loaded',
        DataSourceErrorCode.NOT_FOUND,
        this.type
      );
    }
    const summary = this._adapter.getConnectivitySummary();
    throwIfMetadataAborted(signal, 'Zarr connectivity summary loading');
    return summary;
  }

  /**
   * Resolve zarr:// URL (not really used, data is accessed directly)
   * @param {string} url
   * @returns {Promise<string>}
   */
  async resolveUrl(url) {
    throw new DataSourceError(
      'zarr source does not support URL resolution. Use direct data access methods.',
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
   * Release the active source without changing the selection epoch.
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
    this.dirname = null;
    this._metadata = null;
    this._storage = null;
  }

  /**
   * Where the open store is kept (`data/anndata-storage.js`), or null.
   * @returns {Readonly<import('./anndata-storage.js').AnnDataStorage>|null}
   */
  describeStorage() {
    return this._storage;
  }

  /**
   * Cleanup resources and supersede pending selections.
   * @private
   */
  _cleanup() {
    this._loadRequestId++;
    this._releaseCurrentSource();
  }

  /**
   * Clear the current directory
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
      // Clear loader caches (gene expression, obs info)
      this._loader.clearCache();
    }
    console.log('[ZarrDataSource] Cleared caches to free memory');
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
 * Create a ZarrDataSource instance
 * @returns {ZarrDataSource}
 */
export function createZarrDataSource() {
  return new ZarrDataSource();
}
