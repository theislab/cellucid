/**
 * A dataset catalog: a folder on a web host holding `datasets.json` and the
 * dataset files it lists. The page's sample datasets are one, and so is every
 * folder link (`?data=https://host/folder/`); this module reads both the same
 * way and knows nothing about providers.
 *
 * `datasets.json`:
 *
 *     {
 *       "schema": 2,
 *       "default": "<id>",
 *       "datasets": [
 *         {
 *           "id": "<id>",
 *           "path": "<relative URL>",
 *           "session": {"path": "<relative URL>", "bytes": <n>, "sha256": "<hex>"}
 *         }
 *       ]
 *     }
 *
 * - `schema` is the integer 2.
 * - `default` is the id of the dataset the catalog opens on.
 * - `datasets` lists one entry or more; ids are distinct, and so are paths.
 * - `id` is the dataset's stable id (`isPortableDatasetId`). A file whose
 *   `uns['cellucid']['id']` states an id must state this one.
 * - `path` is where the dataset is, relative to the folder: a Zarr store
 *   folder (ending in `/`), or one file whose name a single-file input
 *   format names (`data/input-formats.js`: an `.h5ad`, a zipped Zarr store
 *   `.zarr.zip`, a `.loom`, …). It is written in canonical URL encoding (`cell%20atlas`),
 *   without `.`, `..`, a query or a fragment.
 * - `session` (optional) is the dataset's default view: a `.cellucid-session`
 *   file applied when the dataset is opened from the catalog, with its exact
 *   byte length and lowercase SHA-256, which pin it to this catalog.
 *
 * No other key is read, and an unknown key is refused. A dataset's name,
 * description, citation and source are its file's own (`uns['cellucid']`,
 * else `uns['title']`, else the file name): listing the catalog reads each
 * file's metadata and `uns` (`describeAnnDataStore`), never its data.
 *
 * @module data/sources/anndata-catalog
 */

import {
  DataSourceError,
  DataSourceErrorCode,
  explainedFailure,
  fetchJson,
  resolveUrl,
} from '../data-source.js';
import { loadMetadataBatchAtomically } from '../metadata-load-contract.js';
import { AnnDataReaderClient } from '../anndata-reader-client.js';
import {
  PORTABLE_DATASET_ID_RULE,
  isPortableDatasetId,
  requireCellucidFileMetadata,
} from '../anndata-cellucid-metadata.js';
import { describeRemoteFile } from './remote-file.js';
import { getProviderRegistry } from './registry.js';
import { afterWholeFileOpened, downloadReason, keptCopyOf, wholeFileOf } from '../whole-download.js';
import { formatBytes } from '../../utils/format-units.js';
import { SharedWork, abortReason, isCancellation, cancel, onAbort, requireSignalOrNull } from '../../utils/abort.js';
import { ANNDATA_SOURCE_TYPE, createAnnDataFileSource } from '../anndata-file-source.js';
import { fileFormatOfName, folderFormatOfName, openableNamesText, titleOfName } from '../input-formats.js';
import { getTransferLog } from '../transfer-log.js';
import { requireObjectKeys } from '../../utils/exact-record.js';

/** The catalog file of a folder. */
export const CATALOG_FILENAME = 'datasets.json';

/** The one catalog schema this viewer reads. */
export const CATALOG_SCHEMA = 2;

const SESSION_EXTENSION = '.cellucid-session';
const SHA256 = /^[0-9a-f]{64}$/;

function invalidCatalog(message, sourceType, details = {}) {
  return explainedFailure(
    `Invalid ${CATALOG_FILENAME}: ${message}.`,
    DataSourceErrorCode.INVALID_FORMAT,
    sourceType,
    details
  );
}

function requireCatalogKeys(value, required, optional, label, sourceType) {
  return requireObjectKeys(value, required, optional, label, (message, detail) =>
    invalidCatalog(message.replace(/\.$/, ''), sourceType, detail));
}

/**
 * One canonical relative address below the catalog folder.
 *
 * @returns {string} The absolute URL it names
 */
function requireRelativePath(value, label, baseUrl, sourceType) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.startsWith('/') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) ||
    /[?#\\\u0000-\u001f\u007f\s]/.test(value)
  ) {
    throw invalidCatalog(`${label} must be a relative address below the catalog folder; got ${JSON.stringify(value)}`, sourceType);
  }
  const segments = (value.endsWith('/') ? value.slice(0, -1) : value).split('/');
  for (const segment of segments) {
    let decoded = null;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      decoded = null;
    }
    if (
      decoded === null ||
      segment.length === 0 ||
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('/') ||
      encodeURIComponent(decoded) !== segment
    ) {
      throw invalidCatalog(
        `${label} ${JSON.stringify(value)} must spell each part canonically (as encodeURIComponent writes it), ` +
        "without '.' or '..'",
        sourceType
      );
    }
  }
  const url = resolveUrl(baseUrl, value);
  if (!url.startsWith(baseUrl)) {
    throw invalidCatalog(`${label} ${JSON.stringify(value)} must stay below the catalog folder`, sourceType);
  }
  return url;
}

/**
 * The form of one dataset path (`data/input-formats.js`): a store folder (a
 * path ending in "/"; its format is the one its name names, else the one its
 * content shows), or a file its name names (an `.h5ad`, a zipped Zarr
 * store, any other single-file format). The reader confirms either from the content.
 *
 * @param {string} path
 * @returns {Readonly<{format: string|null, layout: 'file'|'zip'|'folder'}>|null}
 */
export function catalogEntryForm(path) {
  if (path.endsWith('/')) {
    return Object.freeze({ format: folderFormatOfName(path)?.format ?? null, layout: 'folder' });
  }
  return fileFormatOfName(path);
}

/** The last part of a path, decoded: a file or folder name. */
function lastSegment(path) {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  return decodeURIComponent(trimmed.slice(trimmed.lastIndexOf('/') + 1));
}

/** What a dataset is called when its file does not name itself. */
function nameOfPath(path) {
  return titleOfName(lastSegment(path));
}

/**
 * Check one `datasets.json` and resolve its addresses.
 *
 * @param {unknown} catalog
 * @param {string} baseUrl - The catalog folder's URL, ending in '/'
 * @param {string} sourceType
 * @returns {Readonly<{default: string, datasets: ReadonlyArray<Readonly<Object>>}>}
 */
export function validateAnnDataCatalog(catalog, baseUrl, sourceType) {
  requireCatalogKeys(catalog, ['schema', 'default', 'datasets'], [], 'the catalog', sourceType);
  if (catalog.schema !== CATALOG_SCHEMA) {
    throw invalidCatalog(
      `schema is ${JSON.stringify(catalog.schema)}; this viewer reads schema ${CATALOG_SCHEMA}` +
      (Number.isSafeInteger(catalog.schema) && catalog.schema > CATALOG_SCHEMA ? ', so open it in a newer Cellucid' : ''),
      sourceType
    );
  }
  if (!Array.isArray(catalog.datasets) || catalog.datasets.length === 0) {
    throw invalidCatalog('datasets must list one dataset or more', sourceType);
  }
  const ids = new Set();
  const urls = new Set();
  const datasets = catalog.datasets.map((entry, index) => {
    const label = `datasets[${index}]`;
    requireCatalogKeys(entry, ['id', 'path'], ['session', 'name'], label, sourceType);
    // Its name as a person reads it (the dataset's own, `uns['cellucid']['name']`): what the picker
    // and the opening say before its file is read, so neither shows the dataset's id.
    if (Object.hasOwn(entry, 'name') && (typeof entry.name !== 'string' || entry.name.trim() === '' || entry.name !== entry.name.trim())) {
      throw invalidCatalog(`${label}.name must be the dataset's name, a trimmed nonempty text`, sourceType);
    }
    if (!isPortableDatasetId(entry.id)) {
      throw invalidCatalog(`${label}.id ${JSON.stringify(entry.id)} must be ${PORTABLE_DATASET_ID_RULE}`, sourceType);
    }
    if (ids.has(entry.id)) throw invalidCatalog(`dataset id '${entry.id}' is listed twice`, sourceType);
    ids.add(entry.id);
    const url = requireRelativePath(entry.path, `dataset '${entry.id}' path`, baseUrl, sourceType);
    const form = catalogEntryForm(entry.path);
    if (form === null) {
      throw invalidCatalog(
        `dataset '${entry.id}' path ${JSON.stringify(entry.path)} must name a store folder (ending in "/") or ` +
        `${openableNamesText({ layouts: ['file', 'zip'] })}`,
        sourceType
      );
    }
    if (urls.has(url)) throw invalidCatalog(`dataset '${entry.id}' path is listed twice`, sourceType);
    urls.add(url);
    let session = null;
    if (Object.hasOwn(entry, 'session')) {
      requireCatalogKeys(entry.session, ['path', 'bytes', 'sha256'], [], `dataset '${entry.id}' session`, sourceType);
      const sessionUrl = requireRelativePath(entry.session.path, `dataset '${entry.id}' session path`, baseUrl, sourceType);
      if (!entry.session.path.endsWith(SESSION_EXTENSION)) {
        throw invalidCatalog(`dataset '${entry.id}' session path must name a ${SESSION_EXTENSION} file`, sourceType);
      }
      if (!Number.isSafeInteger(entry.session.bytes) || entry.session.bytes < 1) {
        throw invalidCatalog(`dataset '${entry.id}' session bytes must be the file's exact positive byte length`, sourceType);
      }
      if (typeof entry.session.sha256 !== 'string' || !SHA256.test(entry.session.sha256)) {
        throw invalidCatalog(`dataset '${entry.id}' session sha256 must be one lowercase SHA-256 digest`, sourceType);
      }
      session = Object.freeze({ url: sessionUrl, bytes: entry.session.bytes, sha256: entry.session.sha256 });
    }
    return Object.freeze({
      id: entry.id,
      path: entry.path,
      url,
      name: lastSegment(entry.path),
      title: entry.name ?? null,
      form,
      session,
    });
  });
  if (typeof catalog.default !== 'string' || !ids.has(catalog.default)) {
    throw invalidCatalog(`default ${JSON.stringify(catalog.default)} must be the id of a listed dataset`, sourceType);
  }
  return Object.freeze({ default: catalog.default, datasets: Object.freeze(datasets) });
}

/**
 * Fetch and check the catalog of one folder. A folder without one is a
 * NOT_FOUND `DataSourceError`, which each caller explains in its own words.
 *
 * @param {string} baseUrl - The folder's URL, ending in '/'
 * @param {string} sourceType
 * @param {AbortSignal|null} signal
 * @param {{askOnce?: boolean}} [options] - `askOnce` for a person's retry:
 *   a busy host is reported at once, not asked again (`fetchCatalogFile`)
 * @returns {Promise<ReturnType<typeof validateAnnDataCatalog>>}
 */
export async function fetchAnnDataCatalog(baseUrl, sourceType, signal, { askOnce = false } = {}) {
  const catalog = await fetchJson(resolveUrl(baseUrl, CATALOG_FILENAME), sourceType, { signal, askOnce });
  return validateAnnDataCatalog(catalog, baseUrl, sourceType);
}

/**
 * The datasets of one catalog: listed from their files' metadata, opened one
 * at a time when chosen, and released when another is shown.
 */


/**
 * The providers whose catalog entries an opening asks for the entry's
 * version: those that name a file's or a folder's content (GitHub: the
 * commit that last wrote it; Hugging Face: its LFS hash or git tree), which
 * a plain request to the entry's address cannot see.
 */
const CONTENT_NAMING_PROVIDERS = new Set(['gh', 'hf']);

/**
 * An entry's source as its provider opens it (`providers/github.js`,
 * `providers/huggingface.js`), or null when its address belongs to no
 * provider that names content. A file: `{file}` (or the copy downloaded
 * whole, for a host that serves no part); a folder: `{url, name, version,
 * key}`.
 */
async function providerSourceOf(entry, signal) {
  let resolved;
  try {
    resolved = getProviderRegistry().resolve(entry.url);
  } catch {
    return null;
  }
  if (!CONTENT_NAMING_PROVIDERS.has(resolved.provider.id)) return null;
  const opened = await resolved.provider.open(resolved.value, { signal });
  if (entry.form.layout === 'folder') {
    const store = opened?.store ?? null;
    if (store === null) return null;
    return {
      url: store.url,
      name: entry.name,
      ...(typeof store.version === 'string' ? { version: store.version } : {}),
      ...(typeof store.key === 'string' ? { key: store.key } : {}),
    };
  }
  const described = opened?.file ?? null;
  if (described?.resource == null) return null;
  if (described.transport !== 'download') return { file: described.resource };
  return { file: await wholeFileOf(described.resource, { format: entry.form.format, signal }) };
}

export class AnnDataCatalog {
  /**
   * @param {Object} options
   * @param {string} options.baseUrl - The catalog folder, ending in '/'
   * @param {ReturnType<typeof validateAnnDataCatalog>} options.catalog
   * @param {string} options.sourceType - The owning source's type, for errors
   * @param {string} options.sourceName - What the dataset panel names the
   *   source when a file does not name its own (`uns['cellucid']['source']`)
   */
  constructor({ baseUrl, catalog, sourceType, sourceName }) {
    this.baseUrl = baseUrl;
    this.catalog = catalog;
    this._sourceType = sourceType;
    this._sourceName = sourceName;
    /**
     * @type {Map<string, SharedWork>} Remote file descriptions by id, while
     * each is being made: the listing and an opening under way at once share
     * one, and every later reader source describes its file again, so its
     * version is the host's at that opening, never one an earlier opening
     * or listing read.
     */
    this._resources = new Map();
    /** @type {Map<string, Promise<{source: Object, metadata: Object, transfer: Object}>>} */
    this._opened = new Map();
    /** @type {Map<string, Object>} The AnnData source of each dataset whose opening finished */
    this._settled = new Map();
    /** @type {WeakMap<Promise<Object>, Object>} Who still wants each opening (`open`) */
    this._wanted = new WeakMap();
    this._closed = false;
  }

  /** The default dataset id. */
  get defaultDatasetId() {
    return this.catalog.default;
  }

  /** Whether the catalog lists `datasetId`. */
  has(datasetId) {
    return this.catalog.datasets.some(entry => entry.id === datasetId);
  }

  /** @private */
  _entry(datasetId) {
    const entry = this.catalog.datasets.find(candidate => candidate.id === datasetId);
    if (entry === undefined) {
      throw new DataSourceError(
        `Dataset '${datasetId}' is not in ${CATALOG_FILENAME}`,
        DataSourceErrorCode.NOT_FOUND,
        this._sourceType,
        { datasetId }
      );
    }
    return entry;
  }

  /**
   * The source the reader opens for one entry: the remote file (described,
   * with its size and version, by the opening or listing that asks for it)
   * or the store folder. The listing and an opening under way at once
   * may both wait for one description: each stops waiting with its own
   * signal, and the description stops only when none waits any more (a
   * listing abandoned because another sample failed leaves an opening's
   * description running). A file on a host that serves only whole files is
   * downloaded by an opening, never by a listing (`listing`), which reads
   * only what an earlier opening kept of it.
   * @private
   */
  async _readerSource(entry, signal, { listing = false } = {}) {
    // An opening of an entry its provider names by content (a catalog on
    // GitHub or Hugging Face) asks the provider, as a link to it does: the
    // same identity whichever way the dataset is reached, and a version
    // that names its content (else nothing of it would be kept across
    // visits). A listing never asks a provider (one request each).
    const routed = listing ? null : await providerSourceOf(entry, signal);
    if (routed !== null) return routed;
    if (entry.form.layout === 'folder') return { url: entry.url, name: entry.name };
    let described = this._resources.get(entry.id);
    if (described === undefined || described.abandoned) {
      const work = new SharedWork(workSignal => describeRemoteFile({
        url: entry.url,
        // Filed under its address, as a link to the file is (`providers/http.js`):
        // a dataset id names a dataset in this catalog, not where its bytes are.
        id: `url:${encodeURIComponent(entry.url)}`,
        name: entry.name,
        attribution: { title: nameOfPath(entry.path), url: entry.url },
        signal: workSignal,
      }));
      this._resources.set(entry.id, work);
      const made = () => {
        if (this._resources.get(entry.id) === work) this._resources.delete(entry.id);
      };
      work.promise.then(made, made);
      described = work;
    }
    const { resource, transport } = await described.join(signal);
    if (transport !== 'download') return { file: resource };
    // A host that serves no part of the file. The listing reads only what
    // an earlier opening kept of it, never the whole file; an opening
    // downloads it whole, once (`whole-download.js`), saying so up front.
    if (!listing) return { file: await wholeFileOf(resource, { format: entry.form.format, signal }) };
    const kept = await keptCopyOf(resource, { format: entry.form.format });
    if (kept !== null) return { file: kept };
    throw explainedFailure(
      `${resource.compression === undefined ? `${new URL(entry.url).host} serves ${entry.path}` : `${entry.path} can be read`} ` +
      `only whole (${downloadReason(resource, 'its host')}), so the ` +
      `catalog cannot read what it holds without downloading all of it (${formatBytes(resource.size)}). Open the ` +
      `file by its own link, which downloads it once and keeps it, or host the catalog where parts of files are ` +
      'served (GitHub, Zenodo, Hugging Face, a static web server).',
      DataSourceErrorCode.UNSUPPORTED,
      this._sourceType,
      { datasetId: entry.id, url: entry.url }
    );
  }

  /**
   * One entry's file id, checked against the catalog's.
   * @private
   */
  _requireAgreeingId(entry, fileId) {
    if (fileId !== null && fileId !== entry.id) {
      throw explainedFailure(
        `${CATALOG_FILENAME} lists ${entry.path} as dataset '${entry.id}', but the file states the id ` +
        `'${fileId}' (uns['cellucid']['id']). List it under the id the file states.`,
        DataSourceErrorCode.VALIDATION_ERROR,
        this._sourceType,
        { datasetId: entry.id, fileId }
      );
    }
  }

  /**
   * The datasets as `datasets.json` itself lists them, in catalog order:
   * `{id, name}`, the name the catalog gives it, else one taken from its
   * path. Nothing is read, so the picker can list them, and an opening name
   * them, while their files are still being described.
   *
   * @returns {ReadonlyArray<Readonly<{id: string, name: string}>>}
   */
  entries() {
    return Object.freeze(this.catalog.datasets.map(entry => Object.freeze({
      id: entry.id,
      name: entry.title ?? nameOfPath(entry.path),
    })));
  }

  /**
   * What the dataset picker lists about every dataset, in catalog order:
   * `{id, name, description, stats: {n_cells, n_genes}}`, read from each
   * file's metadata and `uns`. One file that cannot be described fails the
   * listing, naming it.
   *
   * @param {AbortSignal|null} signal
   * @returns {Promise<Object[]>}
   */
  async describe(signal) {
    const client = new AnnDataReaderClient();
    try {
      return await loadMetadataBatchAtomically(
        this.catalog.datasets,
        signal,
        async (entry, entrySignal) => {
          try {
            const listed = await this._listedFromOpen(entry);
            if (listed !== null) return listed;
            const source = await this._readerSource(entry, entrySignal, { listing: true });
            const described = await client.describe(source, { signal: entrySignal, expect: entry.form });
            const file = requireCellucidFileMetadata(described.cellucid, ANNDATA_SOURCE_TYPE);
            this._requireAgreeingId(entry, file.id);
            return Object.freeze({
              id: entry.id,
              name: file.name ?? described.title ?? nameOfPath(entry.path),
              description: file.description ?? '',
              stats: Object.freeze({
                n_cells: described.nObs,
                n_genes: described.hasExpressionMatrix ? described.nVars : 0,
              }),
            });
          } catch (error) {
            if (isCancellation(error)) throw error;
            // The message (Details, the log) keeps the cause's own words; the
            // person is told which dataset by its id (`unlisted`) and why in
            // the cause's terms (`describeDataSourceFailure`), never by a URL.
            const first = error instanceof AggregateError && error.errors[0] instanceof Error
              ? error.errors[0]
              : error;
            throw new DataSourceError(
              `Dataset '${entry.id}' (${entry.path}) cannot be listed: ${error?.message ?? error}`,
              first?.code ?? DataSourceErrorCode.INVALID_FORMAT,
              this._sourceType,
              { ...first?.details, datasetId: entry.id, path: entry.path, unlisted: entry.id, cause: error }
            );
          }
        },
        'Catalog listing'
      );
    } finally {
      client.close();
    }
  }

  /**
   * What the listing says about one entry, taken from its opening when the
   * entry is open or being opened (its file is not read a second time), else
   * null once every opening under way has settled: the other files are read
   * for the listing only after the dataset being opened has what it shows
   * first, so their reads never compete with it.
   * @private
   */
  async _listedFromOpen(entry) {
    for (let pending = [...this._opened.values()]; pending.length > 0; ) {
      await Promise.allSettled(pending);
      const next = [...this._opened.values()];
      pending = next.filter(opening => !pending.includes(opening));
    }
    const opening = this._opened.get(entry.id);
    if (opening === undefined) return null;
    let opened;
    try {
      opened = await opening;
    } catch {
      // Its failure is the open's to report; the listing reads the file itself.
      return null;
    }
    const { source, metadata } = opened;
    return Object.freeze({
      id: entry.id,
      name: metadata.name,
      description: source.getAdapter().getFileMetadata().description ?? '',
      // The listing describes the file: every cell of it, as the entries
      // not open are described, even while a subsample of it is open (the
      // picker says the open cells of it: `dataset-controls.js`).
      stats: Object.freeze({ n_cells: source.getCellSubset?.()?.nObs ?? metadata.stats.n_cells, n_genes: metadata.stats.n_genes }),
    });
  }

  /**
   * Open one dataset completely, once: its AnnData source and identity. A
   * failed open is forgotten, so choosing it again retries.
   *
   * Every caller passes the signal of its own reason to want the dataset (a
   * dataset change, which a newer choice replaces), or null to want it until
   * it is released. An opening still under way stops as soon as no caller
   * wants it any more, so a superseded choice neither keeps reading nor keeps
   * its opening on screen; once it has opened, it stays until released.
   *
   * @param {string} datasetId
   * @param {AbortSignal|null} [signal]
   * @returns {Promise<{source: Object, metadata: Object}>}
   */
  open(datasetId, signal = null) {
    if (this._closed) throw new Error('The catalog was closed.');
    requireSignalOrNull(signal, 'A catalog open signal');
    const entry = this._entry(datasetId);
    // A caller that no longer wants it starts nothing.
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    let opening = this._opened.get(datasetId);
    let wanted = opening === undefined ? undefined : this._wanted.get(opening);
    if (opening === undefined || wanted.controller.signal.aborted) {
      const controller = new AbortController();
      wanted = { controller, always: false, callers: new Map(), settled: false };
      const current = this._open(entry, controller.signal);
      opening = current;
      this._opened.set(datasetId, current);
      this._wanted.set(current, wanted);
      const settle = () => {
        wanted.settled = true;
        for (const stopWaiting of wanted.callers.values()) stopWaiting();
        wanted.callers.clear();
      };
      current.then(settle, () => {
        settle();
        if (this._opened.get(datasetId) === current) this._opened.delete(datasetId);
      });
    }
    if (signal === null) {
      wanted.always = true;
    } else if (!wanted.settled && !wanted.callers.has(signal)) {
      const state = wanted;
      const stopWaiting = onAbort(signal, () => {
        state.callers.delete(signal);
        if (!state.settled && !state.always && state.callers.size === 0) {
          state.controller.abort(signal.reason);
        }
      });
      state.callers.set(signal, stopWaiting);
    }
    return opening;
  }

  /** @private */
  async _open(entry, signal) {
    const transfer = getTransferLog().begin({
      key: entry.url,
      label: nameOfPath(entry.path),
      why: entry.form.layout === 'folder'
        ? 'reading on demand: only the chunks each view needs'
        : 'reading on demand: only what each view needs',
    });
    const source = createAnnDataFileSource();
    try {
      try {
        const readerSource = await this._readerSource(entry, signal);
        const options = {
          signal,
          datasetId: entry.id,
          name: nameOfPath(entry.path),
          preferFileName: true,
          description: '',
          source: { name: this._sourceName, url: entry.url, filename: entry.name },
          expect: entry.form,
        };
        if (entry.form.layout === 'folder') {
          await source.loadRemoteFolder(readerSource, options);
        } else {
          await source.loadFile(readerSource.file, options);
          await afterWholeFileOpened([readerSource.file], source.describeStorage()?.conversion ?? null);
        }
      } catch (error) {
        throw this._namedOpenFailure(entry, error);
      }
      this._requireAgreeingId(entry, source.getAdapter().getFileMetadata().id);
      const metadata = await source.getMetadata(entry.id);
      getTransferLog().rename(transfer, metadata.name);
      if (this._closed) throw new Error('The catalog was closed.');
      this._settled.set(entry.id, source);
      return { source, metadata, transfer };
    } catch (error) {
      source.clear();
      getTransferLog().finish(transfer, { error });
      throw error;
    }
  }

  /**
   * A failure reading one listed file, naming the file. A catalog
   * lists many files, and what a format package says ("The selected file is
   * not a valid HDF5/H5AD file") does not say which one. The cause's code and
   * details (an HTTP status, `explained`) are kept, so it is classified and
   * shown as before; a canceled open stays a cancellation.
   * @private
   */
  _namedOpenFailure(entry, error) {
    if (!(error instanceof Error) || isCancellation(error)) return error;
    const first = error instanceof AggregateError && error.errors[0] instanceof Error
      ? error.errors[0]
      : error;
    return new DataSourceError(
      `${entry.path} (dataset '${entry.id}' in ${CATALOG_FILENAME}): ${first.message}`,
      first.code,
      this._sourceType,
      { ...first.details, datasetId: entry.id, path: entry.path, cause: error }
    );
  }

  /**
   * The open AnnData source of one dataset, or null when it is not open.
   *
   * @param {string} datasetId
   * @returns {Object|null}
   */
  openedSource(datasetId) {
    return this._settled.get(datasetId) ?? null;
  }

  /**
   * The default view of one dataset (`session`), or null.
   *
   * @param {string} datasetId
   * @returns {Readonly<{url: string, bytes: number, sha256: string}>|null}
   */
  sessionOf(datasetId) {
    return this._entry(datasetId).session;
  }

  /**
   * Release every open dataset but `keepId` (null releases all).
   *
   * @param {string|null} keepId
   */
  releaseExcept(keepId) {
    for (const [datasetId, opening] of this._opened) {
      if (datasetId === keepId) continue;
      this._opened.delete(datasetId);
      this._settled.delete(datasetId);
      // Released while still opening: it stops where it is.
      const wanted = this._wanted.get(opening);
      if (wanted !== undefined && !wanted.settled) cancel(wanted.controller, 'closed', 'The dataset was released while opening.');
      opening.then(
        ({ source, transfer }) => {
          // An opening still under way when it was released settles here.
          if (this._settled.get(datasetId) === source) this._settled.delete(datasetId);
          source.clear();
          getTransferLog().finish(transfer);
        },
        () => {}
      );
    }
  }

  /** Release everything; the catalog cannot open datasets afterwards. */
  close() {
    this._closed = true;
    this.releaseExcept(null);
  }
}
