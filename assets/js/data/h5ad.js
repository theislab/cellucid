/**
 * H5AD Module for Cellucid
 *
 * The data source for one AnnData `.h5ad` file opened directly in the
 * browser. The file is read by the AnnData reader (`anndata/reader.js`, over
 * the HDF5 reader of `formats/hdf5`) in the AnnData reader worker, through
 * `AnnDataReaderClient`: nothing is copied into memory up front, only the
 * datasets a view needs are read, and HDF5 never runs on the page's thread.
 * The file size is not limited; the only bound is the memory the arrays
 * actually shown need.
 *
 * The bridge that routes the application's data requests to this source lives
 * in `anndata-provider.js`, which serves h5ad:// and zarr:// alike.
 */

import { getNotificationCenter } from '../app/notification-center.js';
import { DataSourceError, DataSourceErrorCode } from './data-source.js';
import { BaseAnnDataAdapter, requireAnnDataLaunchDefaults } from './base-anndata-adapter.js';
import { AnnDataReaderClient } from './anndata-reader-client.js';
import {
  getMetadataLoadSignal,
  throwIfMetadataAborted,
} from './metadata-load-contract.js';
import {
  combineDatasetLifecycleFailures,
  createDatasetReloadSupersededError,
} from './dataset-lifecycle-errors.js';

/**
 * Check if a file appears to be an h5ad file
 * @param {File} file - File to check
 * @returns {boolean}
 */
export function isH5adFile(file) {
  return file.name.toLowerCase().endsWith('.h5ad');
}

// ============================================================================
// H5AD DATA SOURCE
// ============================================================================

/**
 * H5AD-specific adapter extending the shared BaseAnnDataAdapter.
 * Any h5ad-specific overrides would go here.
 */
class H5adDataAdapter extends BaseAnnDataAdapter {
  static sourceType = 'h5ad';

  // H5adDataAdapter uses all methods from BaseAnnDataAdapter without modification.
  // Any h5ad-specific overrides can be added here if needed in the future.
}

/**
 * H5AD Data Source for Cellucid
 * Provides the same interface as LocalUserDirDataSource but for h5ad files
 */
export class H5adDataSource {
  constructor() {
    /** @type {AnnDataReaderClient|null} */
    this._loader = null;

    /** @type {H5adDataAdapter|null} */
    this._adapter = null;

    /** @type {string|null} */
    this.datasetId = null;

    /** @type {string|null} */
    this.filename = null;

    /** @type {Object|null} */
    this._metadata = null;

    /** @type {number} Latest file-selection request identity */
    this._loadRequestId = 0;

    this.type = 'h5ad';
  }

  _assertLoadRequest(requestId) {
    if (requestId !== this._loadRequestId) {
      throw createDatasetReloadSupersededError(
        'H5AD load request was superseded by a newer selection'
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
   * Load an h5ad file
   * @param {File|{url: string, size: number, name: string}} file - A file
   *   from a file input, or a remote file read in place with range requests
   * @param {Object} [options]
   * @param {boolean} [options.showProgress=true]
   * @param {string} [options.datasetId] - The id the caller serves the
   *   dataset under (a catalog's, a server's); without one, the id the file
   *   states (`uns['cellucid']['id']`), else `defaultDatasetId`
   * @param {string} [options.defaultDatasetId] - The id of a file that states
   *   none; `h5ad_<file name>` by default
   * @param {string} [options.name] - Display name; defaults to the file name
   * @param {boolean} [options.preferFileName=false] - Name the dataset by
   *   the name the file gives itself (`uns['cellucid']['name']`, else
   *   `uns['title']`) when it has one
   * @param {string} [options.description]
   * @param {Object} [options.source]
   * @param {Object} [options.defaults] - Launch defaults: the choices the
   *   dataset opens with (`requireAnnDataLaunchDefaults`)
   * @returns {Promise<Object>}
   */
  async loadFromFile(file, options = {}) {
    if (!isH5adFile(file)) {
      throw new DataSourceError(
        'Not an h5ad file',
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
    }

    const requestId = ++this._loadRequestId;
    const remoteHost = typeof file.url === 'string' ? new URL(file.url).host : null;
    const {
      showProgress = true,
      defaults = {},
      datasetId = null,
      defaultDatasetId = `h5ad_${file.name.replace(/\.h5ad$/i, '')}`,
      name = file.name.replace(/\.h5ad$/i, ''),
      preferFileName = false,
      description = 'Loaded directly from H5AD file',
      source = {
        name: 'H5AD file',
        filename: file.name,
      },
    } = options;
    // Launch defaults are checked before anything is read.
    requireAnnDataLaunchDefaults(defaults);
    const notifications = showProgress ? getNotificationCenter() : null;
    const trackerId = notifications
      ? notifications.startDownload(file.name || 'H5AD file')
      : null;

    // Validate a candidate completely before releasing the working dataset.
    const candidateReader = new AnnDataReaderClient({ kind: 'h5ad' });
    let candidateAdapter = null;
    let adopted = false;
    try {
      await candidateReader.open(file);
      this._assertLoadRequest(requestId);
      candidateAdapter = new H5adDataAdapter(candidateReader, { defaults });
      await candidateAdapter.initialize();
      this._assertLoadRequest(requestId);

      const candidateFilename = file.name;
      const candidateDatasetId =
        datasetId ??
        candidateAdapter.getFileMetadata().id ??
        defaultDatasetId;
      const candidateMetadata =
        await candidateAdapter.finalizeDirectIdentity({
          id: candidateDatasetId,
          name,
          preferFileName,
          description,
          source,
        });
      this._assertLoadRequest(requestId);

      this._releaseCurrentSource();
      this._loader = candidateReader;
      this._adapter = candidateAdapter;
      this.filename = candidateFilename;
      this.datasetId = candidateDatasetId;
      this._metadata = candidateMetadata;
      adopted = true;

      console.log(`[H5adDataSource] Loaded ${file.name}: ${this._loader.nObs} cells, ${this._loader.nVars} genes`);
      if (notifications !== null) {
        notifications.completeDownload(trackerId);
        notifications.info(
          'Opened H5AD directly in the browser. It is read ' +
          (remoteHost === null ? 'from disk' : `in place from ${remoteHost}`) +
          ' as each view needs it; a row-major ' +
          '(CSR) matrix is indexed by gene the first time a gene is shown.',
          { duration: 15000 }
        );
      }

      return this._metadata;
    } catch (error) {
      let terminalError = error instanceof Error
        ? error
        : new TypeError(
            'H5AD source loading must reject with an Error.',
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
            'H5AD source loading and candidate cleanup both failed.'
          );
        }
      }
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
            'H5AD source loading and failure reporting both failed.'
          );
        }
      }
      throw terminalError;
    }
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
        'No h5ad file loaded',
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
        `H5AD dataset "${String(datasetId)}" is not the adopted dataset ` +
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
        `H5AD dataset "${String(datasetId)}" is not the adopted dataset ` +
        `"${String(this.datasetId)}"`,
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        {
          requestedId: datasetId,
          currentId: this.datasetId,
        }
      );
    }
    return `h5ad://${this.datasetId}/`;
  }

  /**
   * Get the H5AD data adapter (for direct data access)
   * @returns {H5adDataAdapter|null}
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
      throw new DataSourceError('No h5ad file loaded', DataSourceErrorCode.NOT_FOUND, this.type);
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
      'H5AD connectivity edges'
    );
    throwIfMetadataAborted(signal, 'H5AD connectivity edge loading');
    if (!this._adapter) {
      throw new DataSourceError(
        'No h5ad file loaded',
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
      throw new DataSourceError('No h5ad file loaded', DataSourceErrorCode.NOT_FOUND, this.type);
    }
    return this._adapter.getObsFields();
  }

  /**
   * The gene list the file opens with (`BaseAnnDataAdapter.getGeneList`)
   * @returns {Promise<Object>}
   */
  getGeneList() {
    if (!this._adapter) {
      throw new DataSourceError('No h5ad file loaded', DataSourceErrorCode.NOT_FOUND, this.type);
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
      'H5AD connectivity summary'
    );
    throwIfMetadataAborted(signal, 'H5AD connectivity summary loading');
    if (!this._adapter) {
      throw new DataSourceError(
        'No h5ad file loaded',
        DataSourceErrorCode.NOT_FOUND,
        this.type
      );
    }
    const summary = this._adapter.getConnectivitySummary();
    throwIfMetadataAborted(signal, 'H5AD connectivity summary loading');
    return summary;
  }

  /**
   * Resolve h5ad:// URL (not really used, data is accessed directly)
   * @param {string} url
   * @returns {Promise<string>}
   */
  async resolveUrl(url) {
    // h5ad source doesn't use URL fetching, data is accessed directly
    throw new DataSourceError(
      'h5ad source does not support URL resolution. Use direct data access methods.',
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
   * Cleanup resources
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
   * Clear the current file
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
    console.log('[H5adDataSource] Cleared caches to free memory');
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
 * Create an H5adDataSource instance
 * @returns {H5adDataSource}
 */
export function createH5adDataSource() {
  return new H5adDataSource();
}
