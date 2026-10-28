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
import { createCellIdentity } from './cell-identity.js';
import { BaseAnnDataAdapter, requireAnnDataLaunchDefaults } from './base-anndata-adapter.js';
import { AnnDataReaderClient } from './anndata-reader-client.js';
import { stoppableOpening } from './opening-progress.js';
import { requestOfOpenCells } from './cell-subset-policy.js';
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
 * How many of the first open cells two openings of the same dataset share:
 * the largest `L` such that open cells `[0, L)` are the same original
 * positions in both. When `L` is the smaller opening's cell count, one
 * opening is the other grown or cut in place (a larger or smaller uniform
 * or blocks subsample with the same seed, which open in priority order; a
 * priority-ordered file opened whole and by a prefix): every per-cell array
 * of the smaller is the larger's first rows (`app/open-cells-resize.js`).
 *
 * @param {import('./cell-identity.js').CellIdentity} a
 * @param {import('./cell-identity.js').CellIdentity} b
 * @returns {number}
 */
export function sharedOpenCells(a, b) {
  if (a.nOriginal !== b.nOriginal) return 0;
  const limit = Math.min(a.n, b.n);
  // Each opening's original positions in open order, read directly (a
  // comparison of millions of cells): null when open cell `i` is `i`.
  const first = a.openOrder ?? a.kept;
  const second = b.openOrder ?? b.kept;
  if (first === null && second === null) return limit;
  let shared = 0;
  if (first === null) while (shared < limit && second[shared] === shared) shared++;
  else if (second === null) while (shared < limit && first[shared] === shared) shared++;
  else while (shared < limit && first[shared] === second[shared]) shared++;
  return shared;
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
      const identified = await this._identify(candidateReader, opened, source, options, { opening, requestId, launchDefaults });
      candidateAdapter = identified.adapter;
      const candidateDatasetId = identified.datasetId;
      const candidateMetadata = identified.metadata;

      const candidateStorage = describeAnnDataStorage(source, opened);
      this._releaseCurrentSource();
      this._loader = candidateReader;
      this._adapter = candidateAdapter;
      this._storage = candidateStorage;
      this.filename = opened.name;
      this.format = opened.format;
      this.datasetId = candidateDatasetId;
      this._metadata = candidateMetadata;
      // What reading it again with other cells takes (`reopenCells`): the
      // same source and options, without the signal of this opening.
      this._lastLoad = { source, options: { ...options, signal: null }, title, step };
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
   * The adapter of a reader that opened `source`, initialized, and the
   * dataset's identity (`options` as `loadFile`'s). `geneNameGuesses`: the
   * gene-name guesses of an earlier reading of the same store, kept. @private
   */
  async _identify(reader, opened, source, options, { opening, requestId, launchDefaults, firstView = true, geneNameGuesses = undefined }) {
    const {
      datasetId = null,
      defaultDatasetId = null,
      name = null,
      preferFileName = false,
      description = '',
      source: identitySource = null,
    } = options;
    const adapter = new AnnDataFileAdapter(reader, {
      defaults: launchDefaults,
      ...(geneNameGuesses === undefined ? {} : { geneNameGuesses }),
    });
    try {
      await adapter.initialize({ firstView });
      opening.throwIfStopped();
      this._assertLoadRequest(requestId);
      const id =
        datasetId ??
        adapter.getFileMetadata().id ??
        defaultDatasetId ??
        defaultDatasetIdOf(opened.format, opened.name);
      const metadata = await adapter.finalizeDirectIdentity({
        id,
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
      return { adapter, datasetId: id, metadata };
    } catch (error) {
      adapter.release();
      throw error;
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
   * Read the open dataset again, in place, with the cells `cellSubset`
   * asks for (a cell subset request, `cell-subset-policy.js`): the same
   * file, link or folder, the same identity. The dataset stays open until
   * the new reading is complete; a failed one leaves it as it was.
   *
   * `resized` says when the new cells are the open ones grown or cut in
   * place (`sharedOpenCells`: a larger or smaller uniform or blocks
   * subsample with the same seed, or a priority-ordered file's prefix and
   * the whole file): `{from, to}`, the open cell counts before and after.
   * Every per-cell array of the smaller opening is then the larger's first
   * rows, so the app keeps what it shows and reads only the cells added
   * (`app/open-cells-resize.js`); the first view's embedding is not read
   * again. Null otherwise: other cells, shown as a new reading.
   * `reordered`: the same cells as before in another order (each cell's
   * arrays move with it, `app/open-cells-resize.js`).
   *
   * @param {{cellSubset: Object, signal?: AbortSignal|null, step?: string, quiet?: boolean}} options -
   *   `step` names the opening's step; `quiet` reads without the opening
   *   progress (a growth step of a progressive opening, shown by its own line)
   * @returns {Promise<{metadata: Object, resized: {from: number, to: number}|null, reordered: boolean}>}
   */
  async reopenCells({ cellSubset, signal = null, step = 'Reading the chosen cells', quiet = false }) {
    const last = this._lastLoad ?? null;
    const loader = this._loader;
    if (last === null || loader === null) throw new Error('No dataset is open to read again.');
    const requestId = ++this._loadRequestId;
    const launchDefaults = requireAnnDataLaunchDefaults(last.options.defaults ?? {});
    // Read again in the same reader worker (`AnnDataReaderClient.reopenCells`):
    // what the open reading built that the new cells keep is not read again.
    const stop = new AbortController();
    const opening = stoppableOpening({ title: last.title, step, signal, stop: () => stop.abort(), quiet });
    const before = loader.cellSubset;
    const shownBefore = this.getCellIdentity();
    try {
      await loader.reopenCells({ cellSubset, signal: stop.signal });
      opening.throwIfStopped();
      this._assertLoadRequest(requestId);
      const after = loader.cellSubset;
      const shownAfter = after === null ? null : createCellIdentity({ nObs: after.nObs, kept: after.kept, openOrder: after.openOrder ?? null });
      const shared = shownBefore === null || shownAfter === null ? 0 : sharedOpenCells(shownBefore, shownAfter);
      const resized = shared > 0 && shared === Math.min(shownBefore.n, shownAfter.n) && shownBefore.n !== shownAfter.n
        ? Object.freeze({ from: shownBefore.n, to: shownAfter.n })
        : null;
      // The same cells in another order (a subsample grown from few chunks
      // put in priority order): shown in place too, each cell moved.
      const reordered = resized === null && shownBefore !== null && shownAfter !== null &&
        shownBefore.n === shownAfter.n && shownBefore.digest === shownAfter.digest;
      const opened = { name: this.filename, format: this.format };
      // The var axes are the same whatever cells are open: the gene names
      // already guessed are kept.
      const { adapter, datasetId, metadata } = await this._identify(loader, opened, last.source, last.options, {
        opening,
        requestId,
        launchDefaults,
        firstView: resized === null && !reordered,
        geneNameGuesses: this._adapter?.geneNameGuesses(),
      });
      // The reader stays; the adapter of the earlier reading lets go of
      // what it holds without closing it.
      this._adapter?.release();
      this._adapter = adapter;
      this.datasetId = datasetId;
      this._metadata = metadata;
      // The identity of the cells now open is the one made above (once:
      // an identity of millions of cells takes a while to check).
      this._cellIdentity = after === null ? null : { subset: after, identity: shownAfter };
      opening.release();
      opening.handle.end();
      return { metadata, resized, reordered };
    } catch (thrown) {
      opening.release();
      const error = opening.outcome(thrown);
      // The cells open before are read again, so the dataset on screen and
      // its reader agree (what they share is carried, nothing is fetched):
      // a reading cancelled as its reply came may have been taken already.
      // A newer reading of the file (superseding this one) is left to stand.
      if (this._loader === loader && this._loadRequestId === requestId) {
        await loader.reopenCells({ cellSubset: requestOfOpenCells(before) }).catch(restoreFailure => {
          console.error('[AnnDataFileSource] The cells open before could not be read again:', restoreFailure);
        });
      }
      opening.handle.fail(error);
      throw error;
    }
  }

  /**
   * Which of the dataset's cells were opened (`anndata/subsample-plan.js`):
   * `{nObs, kept, spec, autoFit, reproduced, keptValues, note}`, `kept` null
   * when every cell is; null when nothing is open.
   *
   * @returns {Object|null}
   */
  getCellSubset() {
    return this._loader?.cellSubset ?? null;
  }

  /**
   * The open cells' identity (`cell-identity.js`), made once per opening.
   *
   * @returns {import('./cell-identity.js').CellIdentity|null}
   */
  getCellIdentity() {
    const subset = this.getCellSubset();
    if (subset === null) return null;
    if (this._cellIdentity?.subset !== subset) {
      this._cellIdentity = { subset, identity: createCellIdentity({ nObs: subset.nObs, kept: subset.kept, openOrder: subset.openOrder ?? null }) };
    }
    return this._cellIdentity.identity;
  }

  /**
   * How the open subsample represents a categorical obs field
   * (`AnnDataReader.subsampleRepresentation`); null when every cell is open.
   *
   * @param {string} key
   */
  subsampleRepresentation(key) {
    if (this.getCellSubset()?.kept == null) return Promise.resolve(null);
    return this._loader.subsampleRepresentation(key);
  }

  /**
   * How much of the neighbour graph `obsp[key]` the open subsample keeps,
   * once it was read (`AnnDataReader.subsampleGraphShare`): `{kept, of}`;
   * null when every cell is open or the graph was not read.
   *
   * @param {string|null} key
   * @returns {Promise<{kept: number, of: number}|null>}
   */
  subsampleGraphShare(key) {
    if (this.getCellSubset()?.kept == null || typeof key !== 'string') return Promise.resolve(null);
    return this._loader.subsampleGraphShare(key);
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
