/**
 * LocalUserDirDataSource - one dataset the user chose on their own
 * computer: a file (an `.h5ad`, a `.zarr.zip`, a `.loom`, an `.rds`, …) or a
 * folder (a `.zarr` store, a Cell Ranger `outs/` folder, a MatrixMarket
 * folder), picked or dropped, in any input format of
 * `data/input-formats.js`. It is read in the browser by the AnnData reader, which
 * decides what it is from its content (`data/input-formats.js`); nothing is
 * uploaded anywhere.
 */

import {
  DataSourceError,
  DataSourceErrorCode,
} from './data-source.js';
import {
  createDatasetReloadSupersededError,
} from './dataset-lifecycle-errors.js';
import { createAnnDataFileSource } from './anndata-file-source.js';
import { fileFormatOfName, filePickerAccept, folderFormatOfPaths, openableNamesText } from './input-formats.js';

/** The folders Cellucid opens, as a message names them: "a .zarr folder, a Cell Ranger outs/ folder or …". */
function folderKinds() {
  return openableNamesText({ layouts: ['folder'] });
}

/**
 * @typedef {import('./data-source.js').DatasetMetadata} DatasetMetadata
 */

/** Each file's path below the chosen folder's parent, as a folder input lists it. */
function pathsOf(files) {
  return Array.from(files, file => (
    typeof file?.webkitRelativePath === 'string' && file.webkitRelativePath !== ''
      ? file.webkitRelativePath
      : String(file?.name ?? '')
  ));
}

export class LocalUserDirDataSource {
  constructor() {
    /** @type {string|null} */
    this.datasetId = null;

    /** @type {string|null} The file's name, for display */
    this.directoryPath = null;

    /** @type {DatasetMetadata|null} */
    this._metadata = null;

    /** @type {import('./anndata-file-source.js').AnnDataFileSource|null} */
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

    /**
     * Stops the file still being read for the newest selection.
     * @type {AbortController|null}
     */
    this._reading = null;

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
    this._reading?.abort();
    const reading = new AbortController();
    this._reading = reading;
    let adopted = false;
    try {
      await load(candidateSource, reading.signal);
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
      if (this._reading === reading) this._reading = null;
      if (!adopted) candidateSource.clear();
    }
  }

  /**
   * Open one file: an `.h5ad` or a `.zarr.zip`, as its name says and its
   * content confirms. Its dataset id is the one it states
   * (`uns['cellucid']['id']`), else `<format>_<file name>`.
   * @param {File} file
   * @returns {Promise<DatasetMetadata>}
   */
  async loadFromFile(file) {
    if (!file || typeof file.name !== 'string' || fileFormatOfName(file.name) === null) {
      throw new DataSourceError(
        `Not a file Cellucid opens. Expected a name ending in ${filePickerAccept().split(',').join(' or ')}.`,
        DataSourceErrorCode.INVALID_FORMAT,
        this.type
      );
    }
    return this._adopt(
      createAnnDataFileSource(),
      (source, signal) => source.loadFile(file, {
        signal,
        preferFileName: true,
      }),
      source => source.filename
    );
  }

  /**
   * Open one store folder, chosen with a folder picker or dropped: every
   * file below it, each with its path inside the folder
   * (`webkitRelativePath`). Its dataset id is the one it states
   * (`uns['cellucid']['id']`), else `<format>_<folder name>`.
   * @param {FileList|File[]} files
   * @returns {Promise<DatasetMetadata>}
   */
  async loadFromFolder(files) {
    if (!files || files.length === 0 || folderFormatOfPaths(pathsOf(files)) === null) {
      throw new DataSourceError(
        `The chosen folder is not a folder Cellucid opens: it holds none of the files that make ${folderKinds()}. ` +
        'Choose that folder itself.',
        DataSourceErrorCode.INVALID_FORMAT,
        this.type,
        { explained: true }
      );
    }
    return this._adopt(
      createAnnDataFileSource(),
      (source, signal) => source.loadFolder(files, {
        signal,
        preferFileName: true,
      }),
      source => source.filename
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
   * The anndata:// base URL of the adopted file.
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
   * The AnnData file source the adopted file is read from.
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

  /**
   * Clear the current selection, superseding any candidate still loading:
   * its read stops where it is.
   */
  clear() {
    this._selectionEpoch += 1;
    this._reading?.abort();
    this._reading = null;
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
