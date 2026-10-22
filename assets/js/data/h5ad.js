/**
 * H5AD Module for Cellucid
 *
 * The data source for one AnnData `.h5ad` file opened directly in the
 * browser. The file is read by `H5adLoader` (`h5ad-loader.js`) in the
 * AnnData reader worker, through `AnnDataReaderClient`: nothing is copied
 * into memory up front, only the datasets a view needs are read, and HDF5
 * never runs on the page's thread. The file size is not limited; the only
 * bound is the memory the arrays actually shown need.
 *
 * The bridge that routes the application's data requests to this source lives
 * in `anndata-provider.js`, which serves h5ad:// and zarr:// alike.
 */

import { getNotificationCenter } from '../app/notification-center.js';
import { DataSourceError, DataSourceErrorCode } from './data-source.js';
import { BaseAnnDataAdapter } from './base-anndata-adapter.js';
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

/**
 * One reader for one h5ad file. Long reads (indexing a row-major matrix by
 * gene, once per matrix) report progress in a notification.
 *
 * @param {{showProgress?: boolean}} [options]
 * @returns {AnnDataReaderClient}
 */
export function createH5adLoader({ showProgress = true } = {}) {
  let progressId = null;
  let lastUpdate = 0;
  const onProgress = showProgress
    ? event => {
        if (event?.kind !== 'transpose') return;
        const notifications = getNotificationCenter();
        const percent = event.total > 0 ? (100 * event.done) / event.total : 0;
        if (progressId === null) {
          progressId = notifications.progress(
            `Indexing ${event.label} by gene (once per file)`,
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
  return new AnnDataReaderClient({ kind: 'h5ad', onProgress });
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

  /**
   * @param {AnnDataReaderClient} loader - The h5ad reader
   */
  constructor(loader) {
    super(loader);
  }

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
   * @param {File} file - File from file input
   * @param {Object} [options]
   * @param {boolean} [options.showProgress=true]
   * @param {string} [options.datasetId]
   * @param {string} [options.description]
   * @param {Object} [options.source]
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
    const {
      showProgress = true,
      datasetId = null,
      description = 'Loaded directly from H5AD file',
      source = {
        name: 'H5AD file',
        filename: file.name,
      },
    } = options;
    const notifications = showProgress ? getNotificationCenter() : null;
    const trackerId = notifications
      ? notifications.startDownload(file.name || 'H5AD file')
      : null;

    // Validate a candidate completely before releasing the working dataset.
    const candidateLoader = createH5adLoader({ showProgress });
    let candidateAdapter = null;
    let adopted = false;
    try {
      await candidateLoader.open(file);
      this._assertLoadRequest(requestId);
      candidateAdapter = new H5adDataAdapter(candidateLoader);
      await candidateAdapter.initialize();
      this._assertLoadRequest(requestId);

      const candidateFilename = file.name;
      const candidateDatasetId =
        datasetId ??
        `h5ad_${file.name.replace(/\.h5ad$/i, '')}`;
      const candidateMetadata =
        await candidateAdapter.finalizeDirectIdentity({
          id: candidateDatasetId,
          name: file.name.replace(/\.h5ad$/i, ''),
          description,
          cellucidDataVersion: 'h5ad_loader',
          source,
        });
      this._assertLoadRequest(requestId);

      this._releaseCurrentSource();
      this._loader = candidateLoader;
      this._adapter = candidateAdapter;
      this.filename = candidateFilename;
      this.datasetId = candidateDatasetId;
      this._metadata = candidateMetadata;
      adopted = true;

      console.log(`[H5adDataSource] Loaded ${file.name}: ${this._loader.nObs} cells, ${this._loader.nVars} genes`);
      if (notifications !== null) {
        notifications.completeDownload(trackerId);
        notifications.info(
          'Opened H5AD directly in the browser. It is read from disk as each view needs it ' +
          'and gene expression is read unquantized; a row-major (CSR) matrix is indexed by ' +
          'gene the first time a gene is shown.',
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
            candidateLoader.close();
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
   * Get obs manifest
   * @returns {Object}
   */
  getObsManifest() {
    if (!this._adapter) {
      throw new DataSourceError('No h5ad file loaded', DataSourceErrorCode.NOT_FOUND, this.type);
    }
    return this._adapter.getObsManifest();
  }

  /**
   * Get the var manifest of the gene list the file opens with
   * @returns {Promise<Object>}
   */
  getVarManifest() {
    if (!this._adapter) {
      throw new DataSourceError('No h5ad file loaded', DataSourceErrorCode.NOT_FOUND, this.type);
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
      'H5AD connectivity manifest'
    );
    throwIfMetadataAborted(signal, 'H5AD connectivity manifest loading');
    if (!this._adapter) {
      throw new DataSourceError(
        'No h5ad file loaded',
        DataSourceErrorCode.NOT_FOUND,
        this.type
      );
    }
    const manifest = this._adapter.getConnectivityManifest();
    throwIfMetadataAborted(signal, 'H5AD connectivity manifest loading');
    return manifest;
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
