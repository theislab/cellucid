/**
 * Zarr Module for Cellucid
 *
 * The data source for one AnnData Zarr v2 store opened directly in the
 * browser: a `.zarr.zip` archive, or a directory's file list. The store is
 * read by `ZarrLoader` (`zarr-loader.js`) in the AnnData reader worker,
 * through `AnnDataReaderClient`: only the chunks a view needs are read, and
 * no chunk is decoded on the page's thread. No store size or chunk count is
 * limited; the only bound is the memory the arrays actually shown need.
 *
 * The bridge that routes the application's data requests to this source lives
 * in `anndata-provider.js`, which serves zarr:// and h5ad:// alike.
 */

import { getNotificationCenter } from '../app/notification-center.js';
import { DataSourceError, DataSourceErrorCode } from './data-source.js';
import { BaseAnnDataAdapter } from './base-anndata-adapter.js';
import { AnnDataReaderClient } from './anndata-reader-client.js';
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
    // Also check for .zarray or .zgroup files (indicates zarr structure)
    if (path.endsWith('.zarray') || path.endsWith('.zgroup')) {
      return true;
    }
  }
  return false;
}

/**
 * One reader for one Zarr store. Long reads (indexing a matrix by gene, once
 * per matrix) report progress in a notification.
 *
 * @param {{showProgress?: boolean}} [options]
 * @returns {AnnDataReaderClient}
 */
export function createZarrLoader({ showProgress = true } = {}) {
  let progressId = null;
  let lastUpdate = 0;
  const onProgress = showProgress
    ? event => {
        if (event?.kind !== 'transpose') return;
        const notifications = getNotificationCenter();
        const percent = event.total > 0 ? (100 * event.done) / event.total : 0;
        if (progressId === null) {
          progressId = notifications.progress(
            `Indexing ${event.label} by gene (once per store)`,
            percent
          );
          lastUpdate = Date.now();
        } else if (event.done >= event.total) {
          notifications.complete(progressId, `${event.label} is indexed by gene`);
          progressId = null;
        } else if (Date.now() - lastUpdate >= 100) {
          notifications.updateProgress(progressId, percent);
          lastUpdate = Date.now();
        }
      }
    : null;
  return new AnnDataReaderClient({ kind: 'zarr', onProgress });
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

  /**
   * @param {ZarrLoader} loader - The zarr loader
   */
  constructor(loader) {
    super(loader);
  }

  // ZarrDataAdapter uses all methods from BaseAnnDataAdapter without modification.
  // Any zarr-specific overrides can be added here if needed in the future.
}

/**
 * Zarr Data Source for Cellucid
 * Provides the same interface as LocalUserDirDataSource but for zarr directories
 */
export class ZarrDataSource {
  constructor() {
    /** @type {ZarrLoader|null} */
    this._loader = null;

    /** @type {ZarrDataAdapter|null} */
    this._adapter = null;

    /** @type {string|null} */
    this.datasetId = null;

    /** @type {string|null} */
    this.dirname = null;

    /** @type {Object|null} */
    this._metadata = null;

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

  _showDirectLoadWarning(kind) {
    const notifications = getNotificationCenter();
    notifications.info(
      `Opened a Zarr ${kind} directly in the browser. Its chunks are read as each ` +
      'view needs them and gene expression is read unquantized; a row-major (CSR) ' +
      'matrix is indexed by gene the first time a gene is shown.',
      { duration: 15000 }
    );
  }

  async _runLoadTransaction(
    requestId,
    progressName,
    showProgress,
    operation
  ) {
    const notifications = showProgress ? getNotificationCenter() : null;
    const trackerId = notifications
      ? notifications.startDownload(progressName)
      : null;
    let adopted = false;
    try {
      const result = await operation();
      this._assertLoadRequest(requestId);
      adopted = true;
      if (notifications !== null) {
        notifications.completeDownload(trackerId);
      }
      return result;
    } catch (error) {
      let terminalError = error instanceof Error
        ? error
        : new TypeError(
            'Zarr source loading must reject with an Error.',
            { cause: error }
          );
      if (!adopted && notifications !== null) {
        try {
          if (requestId !== this._loadRequestId) {
            notifications.dismissDownload(trackerId);
          } else {
            notifications.failDownload(trackerId, terminalError.message);
          }
        } catch (reportingFailure) {
          terminalError = combineDatasetLifecycleFailures(
            terminalError,
            reportingFailure,
            'Zarr source loading and failure reporting both failed.'
          );
        }
      }
      throw terminalError;
    }
  }

  async _loadCandidate(
    requestId,
    source,
    identityOptions,
    showProgress
  ) {
    const candidateLoader = createZarrLoader({ showProgress });
    let candidateAdapter = null;
    let adopted = false;
    try {
      const { name: candidateDirname } = await candidateLoader.open(source);
      this._assertLoadRequest(requestId);
      candidateAdapter = new ZarrDataAdapter(candidateLoader);
      await candidateAdapter.initialize();
      this._assertLoadRequest(requestId);

      const candidateDatasetId =
        identityOptions.datasetId ??
        `zarr_${candidateDirname.replace(/\.zarr$/i, '')}`;
      const candidateMetadata =
        await candidateAdapter.finalizeDirectIdentity({
          id: candidateDatasetId,
          name: candidateDirname.replace(/\.zarr$/i, ''),
          description: identityOptions.description,
          cellucidDataVersion: 'zarr_loader',
          source: identityOptions.source,
        });
      this._assertLoadRequest(requestId);

      this._releaseCurrentSource();
      this._loader = candidateLoader;
      this._adapter = candidateAdapter;
      this.dirname = candidateDirname;
      this.datasetId = candidateDatasetId;
      this._metadata = candidateMetadata;
      adopted = true;

      console.log(
        `[ZarrDataSource] Loaded ${this.dirname}: ` +
        `${this._loader.nObs} cells, ${this._loader.nVars} genes`
      );
      return this._metadata;
    } catch (error) {
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
            candidateLoader.close();
          }
        } catch (cleanupFailure) {
          terminalError = combineDatasetLifecycleFailures(
            terminalError,
            cleanupFailure,
            'Zarr candidate loading and cleanup both failed.'
          );
        }
      }
      throw terminalError;
    }
  }

  /**
   * Load a zarr directory from FileList
   * @param {FileList} fileList - FileList from <input type="file" webkitdirectory>
   * @param {Object} [options]
   * @param {boolean} [options.showProgress=true]
   * @param {string} [options.datasetId]
   * @param {string} [options.description]
   * @param {Object} [options.source]
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
      showProgress = true,
      datasetId = null,
      description = 'Loaded directly from Zarr directory',
      source = {
        name: 'Zarr directory',
      },
    } = options;
    const firstPath = (
      fileList[0].webkitRelativePath || fileList[0].name
    ).replace(/\\/g, '/');
    const candidateDirname = firstPath.split('/')[0];
    const result = await this._runLoadTransaction(
      requestId,
      candidateDirname || 'Zarr directory',
      showProgress,
      () => this._loadCandidate(
        requestId,
        zarrStoreFromFileList(fileList),
        { datasetId, description, source },
        showProgress
      )
    );
    if (showProgress) this._showDirectLoadWarning('directory');
    return result;
  }

  /**
   * Load one portable ZIP archive containing a Zarr v2 store.
   * Archive parsing and source adoption share the same latest-request identity.
   *
   * @param {File|Blob} file
   * @param {Object} [options]
   * @param {boolean} [options.showProgress=true]
   * @param {string} [options.datasetId]
   * @param {string} [options.description]
   * @param {Object} [options.source]
   * @returns {Promise<Object>}
   */
  async loadFromArchiveFile(file, options = {}) {
    if (!file || typeof file.arrayBuffer !== 'function') {
      throw new DataSourceError(
        'Not a Zarr ZIP archive',
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
    }

    const requestId = ++this._loadRequestId;
    const {
      showProgress = true,
      datasetId = null,
      description = 'Loaded directly from Zarr ZIP archive',
      source = {
        name: 'Zarr ZIP archive',
        ...(typeof file.name === 'string'
          ? { filename: file.name }
          : {}),
      },
    } = options;
    const result = await this._runLoadTransaction(
      requestId,
      file.name || 'Zarr ZIP archive',
      showProgress,
      () => this._loadCandidate(
        requestId,
        { archive: file },
        { datasetId, description, source },
        showProgress
      )
    );
    if (showProgress) this._showDirectLoadWarning('ZIP archive');
    return result;
  }

  /**
   * Load an already indexed Zarr v2 store transactionally.
   * Primarily used by archive/container adapters.
   *
   * @param {Map<string, File|Object>} files
   * @param {string} rootName
   * @param {Object} [options]
   * @param {boolean} [options.showProgress=true]
   * @param {string} [options.datasetId]
   * @param {string} [options.description]
   * @param {Object} [options.source]
   * @returns {Promise<Object>}
   */
  async loadFromFileMap(files, rootName, options = {}) {
    const requestId = ++this._loadRequestId;
    const {
      showProgress = true,
      datasetId = null,
      description = 'Loaded directly from Zarr store',
      source = {
        name: 'Zarr store',
      },
    } = options;
    const result = await this._runLoadTransaction(
      requestId,
      rootName || 'Zarr store',
      showProgress,
      () => this._loadCandidate(
        requestId,
        { files, rootName },
        { datasetId, description, source },
        showProgress
      )
    );
    if (showProgress) this._showDirectLoadWarning('store');
    return result;
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
   * Get obs manifest
   * @returns {Object}
   */
  getObsManifest() {
    if (!this._adapter) {
      throw new DataSourceError('No zarr directory loaded', DataSourceErrorCode.NOT_FOUND, this.type);
    }
    return this._adapter.getObsManifest();
  }

  /**
   * Get the var manifest of the gene list the file opens with
   * @returns {Promise<Object>}
   */
  getVarManifest() {
    if (!this._adapter) {
      throw new DataSourceError('No zarr directory loaded', DataSourceErrorCode.NOT_FOUND, this.type);
    }
    return this._adapter.getVarManifest();
  }

  /**
   * Get connectivity manifest
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<Object|null>}
   */
  async getConnectivityManifest(options = {}) {
    const signal = getMetadataLoadSignal(
      options,
      'Zarr connectivity manifest'
    );
    throwIfMetadataAborted(signal, 'Zarr connectivity manifest loading');
    if (!this._adapter) {
      throw new DataSourceError(
        'No zarr directory loaded',
        DataSourceErrorCode.NOT_FOUND,
        this.type
      );
    }
    const manifest = this._adapter.getConnectivityManifest();
    throwIfMetadataAborted(signal, 'Zarr connectivity manifest loading');
    return manifest;
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
