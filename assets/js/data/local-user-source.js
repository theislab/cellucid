/**
 * LocalUserDirDataSource - one AnnData dataset the user chose on their own
 * computer: an `.h5ad`, an AnnData Zarr store folder (`.zarr`), or a zipped
 * one (`.zarr.zip`), picked or dropped. It is read in the browser by the
 * AnnData reader; nothing is uploaded anywhere.
 */

import {
  DataSourceError,
  DataSourceErrorCode,
} from './data-source.js';
import {
  createDatasetReloadSupersededError,
} from './dataset-lifecycle-errors.js';
import { isH5adFile, createH5adDataSource } from './h5ad.js';
import { createZarrDataSource, isZarrDirectory } from './zarr.js';

/**
 * @typedef {import('./data-source.js').DatasetMetadata} DatasetMetadata
 */

export function isZarrZipArchive(file) {
  return Boolean(
    file &&
    typeof file.name === 'string' &&
    /\.zip$/i.test(file.name)
  );
}

export class LocalUserDirDataSource {
  constructor() {
    /** @type {string|null} */
    this.datasetId = null;

    /** @type {string|null} The file's name, for display */
    this.directoryPath = null;

    /** @type {DatasetMetadata|null} */
    this._metadata = null;

    /** @type {import('./h5ad.js').H5adDataSource|import('./zarr.js').ZarrDataSource|null} */
    this._annDataSource = null;

    /**
     * Monotonic identity for user selections. Async work may publish state only
     * while the epoch it captured is still current.
     * @type {number}
     */
    this._selectionEpoch = 0;

    /**
     * Monotonic identity of committed working source state. Unlike the
     * selection epoch, rejected candidates do not advance this identity.
     * @type {number}
     */
    this._adoptionEpoch = 0;

    this.type = 'local-user';
  }

  /** @private */
  _createSupersededSelectionError() {
    return createDatasetReloadSupersededError(
      'This local data selection was superseded by a newer selection.'
    );
  }

  getType() {
    return this.type;
  }

  /**
   * An isolated local-file selection candidate: reading a file never mutates
   * the registered generation.
   *
   * @returns {LocalUserDirDataSource}
   */
  createSelectionCandidate() {
    return new LocalUserDirDataSource();
  }

  /**
   * The monotonic identity of the current local selection, so async work
   * that spans a replacement can be refused.
   * @returns {number}
   */
  getSelectionIdentity() {
    return this._selectionEpoch;
  }

  /**
   * The identity of the currently adopted working source.
   * @returns {number}
   */
  getAdoptionIdentity() {
    return this._adoptionEpoch;
  }

  /** @returns {Promise<boolean>} */
  async isAvailable() {
    return this._annDataSource === null ? false : this._annDataSource.isAvailable();
  }

  /**
   * The chosen file's name (for display).
   * @returns {string|null}
   */
  getPath() {
    return this.directoryPath;
  }

  /**
   * Read one chosen file as a candidate and adopt it only when it opened
   * completely; a superseded selection never publishes.
   * @private
   */
  async _adopt(candidateSource, load, describe) {
    const selectionEpoch = ++this._selectionEpoch;
    let adopted = false;
    try {
      await load(candidateSource);
      if (selectionEpoch !== this._selectionEpoch) throw this._createSupersededSelectionError();
      const metadata = await candidateSource.getMetadata(candidateSource.datasetId);
      if (selectionEpoch !== this._selectionEpoch) throw this._createSupersededSelectionError();

      // Commit only after the candidate is completely usable.
      this._cleanup();
      this._annDataSource = candidateSource;
      this.datasetId = candidateSource.datasetId;
      this.directoryPath = describe(candidateSource);
      this._metadata = metadata;
      this._adoptionEpoch += 1;
      adopted = true;
      return metadata;
    } catch (error) {
      if (selectionEpoch !== this._selectionEpoch) {
        throw this._createSupersededSelectionError();
      }
      throw error;
    } finally {
      if (!adopted) candidateSource.clear();
    }
  }

  /**
   * Open one `.h5ad` file. Its dataset id is the one it states
   * (`uns['cellucid']['id']`), else `h5ad_<file name>`.
   * @param {File} file
   * @returns {Promise<DatasetMetadata>}
   */
  async loadFromH5adFile(file) {
    if (!file || !isH5adFile(file)) {
      throw new DataSourceError(
        'Not an h5ad file. Expected .h5ad extension.',
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
    }
    return this._adopt(
      createH5adDataSource(),
      source => source.loadFromFile(file, {
        showProgress: false,
        preferFileName: true,
        description: 'Loaded directly from H5AD file',
        source: { name: 'H5AD file', filename: file.name },
      }),
      () => file.name
    );
  }

  /**
   * Open one zipped AnnData Zarr store (`.zarr.zip`). Its dataset id is the
   * one it states (`uns['cellucid']['id']`), else `zarr_<store name>`.
   * @param {File|Blob} file
   * @returns {Promise<DatasetMetadata>}
   */
  async loadFromZarrArchive(file) {
    if (!isZarrZipArchive(file)) {
      throw new DataSourceError(
        'Not a Zarr ZIP archive. Expected a .zip file.',
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
    }
    return this._adopt(
      createZarrDataSource(),
      source => source.loadFromArchiveFile(file, {
        showProgress: false,
        preferFileName: true,
        defaultDatasetId: `zarr_${file.name.replace(/\.zip$/i, '').replace(/\.zarr$/i, '')}`,
        description: 'Loaded directly from Zarr ZIP archive',
        source: { name: 'Zarr ZIP archive', filename: file.name },
      }),
      source => source.dirname
    );
  }

  /**
   * Open one AnnData Zarr store folder, chosen with a folder picker or
   * dropped: every file below it, each with its path inside the folder
   * (`webkitRelativePath`). Its dataset id is the one it states
   * (`uns['cellucid']['id']`), else `zarr_<folder name>`.
   * @param {FileList|File[]} files
   * @returns {Promise<DatasetMetadata>}
   */
  async loadFromZarrDirectory(files) {
    if (!isZarrDirectory(files)) {
      throw new DataSourceError(
        'The chosen folder is not an AnnData Zarr store: it holds no Zarr metadata ' +
        '(.zgroup, .zarray or zarr.json). Choose the .zarr folder itself.',
        DataSourceErrorCode.INVALID_FORMAT,
        this.type,
        { explained: true }
      );
    }
    return this._adopt(
      createZarrDataSource(),
      source => source.loadFromFileList(files, {
        showProgress: false,
        preferFileName: true,
        description: 'Loaded directly from a Zarr store folder',
        source: { name: 'Zarr store folder' },
      }),
      source => source.dirname
    );
  }

  /** @returns {Promise<DatasetMetadata[]>} */
  async listDatasets() {
    return this._metadata === null ? [] : [this._metadata];
  }

  /**
   * @param {string} datasetId
   * @returns {Promise<DatasetMetadata>}
   */
  async getMetadata(datasetId) {
    if (this._metadata === null) {
      throw new DataSourceError(
        'No file selected',
        DataSourceErrorCode.NOT_FOUND,
        this.type
      );
    }
    if (datasetId !== this.datasetId) {
      throw new DataSourceError(
        `Dataset '${datasetId}' not found. Current dataset is '${this.datasetId}'.`,
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        { requestedId: datasetId, currentId: this.datasetId }
      );
    }
    return this._metadata;
  }

  /**
   * @param {string} datasetId
   * @returns {Promise<boolean>}
   */
  async hasDataset(datasetId) {
    return this.datasetId !== null && this.datasetId === datasetId;
  }

  /**
   * The h5ad:// or zarr:// base URL of the adopted file.
   * @param {string} datasetId
   * @returns {string}
   */
  getBaseUrl(datasetId) {
    if (this._annDataSource === null || datasetId !== this.datasetId) {
      throw new DataSourceError(
        `Dataset '${String(datasetId)}' not found. Current dataset is '${this.datasetId}'.`,
        DataSourceErrorCode.NOT_FOUND,
        this.type,
        { requestedId: datasetId, currentId: this.datasetId }
      );
    }
    return this._annDataSource.getBaseUrl(this.datasetId);
  }

  /**
   * The AnnData source (`h5ad` or `zarr`) the adopted file is read from.
   * @returns {Object|null}
   */
  getAnnDataSource() {
    return this._annDataSource;
  }

  /** @private */
  _cleanup() {
    this._annDataSource?.clear();
    this._annDataSource = null;
    this.datasetId = null;
    this.directoryPath = null;
    this._metadata = null;
  }

  /** Clear the current selection, superseding any candidate still loading. */
  clear() {
    this._selectionEpoch += 1;
    this._cleanup();
    this._adoptionEpoch += 1;
  }

  /**
   * Retire a displaced registered local source through the same lifecycle
   * method used by connected transports.
   */
  disconnect() {
    this.clear();
  }

  /**
   * Another source is shown: the file stays open (the user may switch back),
   * and the reader's computed caches are freed.
   */
  onDeactivate() {
    this._annDataSource?.clearCaches?.();
  }

  /** A chosen file is immutable once read: there is nothing to refresh. */
  async refresh() {}

  /**
   * Local files cannot be reopened from saved state: the browser asks the
   * user to choose them again.
   * @returns {boolean}
   */
  requiresManualReconnect() {
    return true;
  }
}

/**
 * Create a LocalUserDirDataSource instance
 * @returns {LocalUserDirDataSource}
 */
export function createLocalUserDirDataSource() {
  return new LocalUserDirDataSource();
}
