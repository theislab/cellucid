/**
 * A served AnnData store: the dataset a Cellucid server -- Python's
 * (`cellucid serve`, `serve_anndata()`, `show_anndata()`) or the R package's
 * viewer (`cellucid_view()`, `cellucid_serve()`) -- declares in
 * `_cellucid/datasets` with an `anndata` member. The server computes nothing:
 * it names the dataset, serves the store's bytes, and states the launch
 * choices. The browser's AnnData reader reads the store in place, with range
 * requests, exactly as it reads a linked file -- under the server's dataset id
 * and name, so sessions and community annotations keep matching.
 *
 * `anndata` is
 *
 *     {
 *       file: {url, kind, layout: 'file'|'zip'|'folder', size?, files?},
 *       defaults: {embedding1d?, embedding2d?, embedding3d?, knn?, modality?,
 *                  expression?, geneIdColumn?, latentKey?, vectorFieldDefault?,
 *                  obsKeys?, normalizeEmbeddings?, centroidMinPoints?}
 *     }
 *
 * `kind` is an input format id and `layout` one of the layouts that format
 * arrives in (`data/input-formats.js`: `h5ad` as a `file`, `zarr` as a `zip`
 * or a `folder`, `rds` as a `file`, `mtx` as a `folder`). `defaults` are the
 * AnnData launch defaults (`requireAnnDataLaunchDefaults` in
 * `base-anndata-adapter.js`).
 *
 * A folder that is not a Zarr store (a MatrixMarket folder, a Cell Ranger
 * `outs/`) lists its files, `files: [{path, size}]`, because a browser cannot
 * list a folder; each is read at `<url><path>` (`loadRemoteFileSet`). A Zarr
 * store folder lists nothing: its consolidated metadata names its keys.
 *
 * `file.url` is the store's route relative to the server's base URL (the
 * server cannot know the address a browser reaches it by: a tunnel, a proxy).
 * `size` is given for a file and absent for a folder. Each default the server
 * states is passed to the AnnData data source as `options.defaults`, and on to
 * the adapter, and overrides the store's own `uns['cellucid']` defaults; one
 * it does not state follows the store's, else the adapter's own rule.
 *
 * @module data/served-anndata
 */

import { DataSourceError, DataSourceErrorCode } from './data-source.js';
import { requireAnnDataLaunchDefaults } from './base-anndata-adapter.js';
import { AnnDataReaderClient } from './anndata-reader-client.js';
import { requireCellucidFileMetadata } from './anndata-cellucid-metadata.js';
import { createAnnDataFileSource } from './anndata-file-source.js';
import { inputFormat, isInputFormatId, layoutsOf } from './input-formats.js';
import { getTransferLog } from './transfer-log.js';
import { isPlainRecord, requireExactKeys } from '../utils/exact-record.js';

const ROUTE_PREFIX = '_cellucid/anndata/';
const FILE_KEYS = Object.freeze(['url', 'kind', 'layout', 'size']);
const FOLDER_KEYS = Object.freeze(['url', 'kind', 'layout']);
const LISTED_FOLDER_KEYS = Object.freeze(['url', 'kind', 'layout', 'files']);

function requireLaunchDefaults(value, label) {
  try {
    return requireAnnDataLaunchDefaults(value);
  } catch (error) {
    throw new TypeError(`${label}: ${error?.message ?? error}`, { cause: error });
  }
}

function requireRoute(value, layout, label) {
  if (typeof value !== 'string' || !value.startsWith(ROUTE_PREFIX)) {
    throw new TypeError(`${label} must be a route under ${ROUTE_PREFIX}`);
  }
  const name = value.slice(ROUTE_PREFIX.length);
  const folder = layout === 'folder';
  const segment = folder ? name.slice(0, -1) : name;
  if (
    (folder && !name.endsWith('/')) ||
    segment.length === 0 ||
    segment.includes('/') ||
    segment.includes('?') ||
    segment.includes('#')
  ) {
    throw new TypeError(
      `${label} must name one ${folder ? 'store folder, ending in "/"' : 'file'}`
    );
  }
  let decoded;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new TypeError(`${label} contains invalid percent encoding`);
  }
  if (decoded === '.' || decoded === '..' || encodeURIComponent(decoded) !== segment) {
    throw new TypeError(`${label} must spell its name canonically`);
  }
  return Object.freeze({ route: value, name: decoded });
}

/**
 * The files of a served folder: canonical relative paths, each once, with
 * exact sizes.
 */
function requireListedFiles(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must list the folder's files`);
  }
  const seen = new Set();
  return Object.freeze(value.map((entry, index) => {
    requireExactKeys(entry, ['path', 'size'], `${label}[${index}]`);
    const { path, size } = entry;
    if (
      typeof path !== 'string' ||
      path.length === 0 ||
      path.startsWith('/') ||
      path.split('/').some(part => part === '' || part === '.' || part === '..' || /[\\\u0000-\u001f]/.test(part))
    ) {
      throw new TypeError(`${label}[${index}].path must be a plain relative path`);
    }
    if (seen.has(path)) throw new TypeError(`${label} lists ${JSON.stringify(path)} twice`);
    seen.add(path);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new TypeError(`${label}[${index}].size must be the file's exact byte length`);
    }
    return Object.freeze({ path, size });
  }));
}

/**
 * Validate the `anndata` member of one served dataset entry.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {Readonly<{file: Readonly<Object>, defaults: Readonly<Object>}>}
 */
export function requireServedAnnData(value, label) {
  requireExactKeys(value, ['file', 'defaults'], label);
  const file = value.file;
  const kind = isPlainRecord(file) ? file.kind : undefined;
  const layout = isPlainRecord(file) ? file.layout : undefined;
  if (!isInputFormatId(kind) || !layoutsOf(kind).includes(layout)) {
    throw new TypeError(
      `${label}.file must name an input format this viewer reads and one of its layouts ` +
      '(an h5ad file, a zipped Zarr store or a Zarr store folder, an R object, a MatrixMarket folder, …)'
    );
  }
  const sized = layout !== 'folder';
  const listed = !sized && inputFormat(kind).container !== 'zarr';
  const keys = sized ? FILE_KEYS : listed ? LISTED_FOLDER_KEYS : FOLDER_KEYS;
  requireExactKeys(file, keys, `${label}.file`);
  if (sized && (!Number.isSafeInteger(file.size) || file.size < 1)) {
    throw new TypeError(`${label}.file.size must be the file's exact positive byte length`);
  }
  const { route, name } = requireRoute(file.url, layout, `${label}.file.url`);
  return Object.freeze({
    file: Object.freeze({
      route,
      name,
      kind,
      layout,
      size: sized ? file.size : null,
      files: listed ? requireListedFiles(file.files, `${label}.file.files`) : null,
    }),
    defaults: requireLaunchDefaults(value.defaults, `${label}.defaults`),
  });
}

/**
 * What identifies one served store's open: the server, the dataset id and
 * the store's route and size. A listing that declares the same key declares
 * the same store, so an open of it stands.
 *
 * @param {string} serverUrl
 * @param {{id: string, anndata: Object}} dataset
 * @returns {string}
 */
export function servedStoreKey(serverUrl, dataset) {
  const { file } = dataset.anndata;
  return JSON.stringify([serverUrl, dataset.id, file.route, file.size, file.files]);
}

/**
 * Where one served store's bytes are, as this browser reaches the server:
 * its URL and the remote file the reader reads in place.
 */
function servedResource(serverUrl, dataset, sourceType) {
  const { file } = dataset.anndata;
  const url = new URL(file.route, `${serverUrl}/`).href;
  return {
    url,
    resource: {
      url,
      size: file.size,
      name: file.name,
      identity: Object.freeze({
        kind: 'remote',
        key: `${sourceType}:${dataset.id}`,
        version: `size:${file.size}`,
      }),
    },
  };
}

/**
 * A served folder of files as the reader opens it: each file a remote file
 * read at `<folder url><path>` (`{files, rootName}`, the shape of a picked
 * folder).
 */
function servedFileSet(url, dataset, sourceType) {
  const { file } = dataset.anndata;
  return {
    files: new Map(file.files.map(({ path, size }) => [path, Object.freeze({
      url: new URL(path.split('/').map(encodeURIComponent).join('/'), url).href,
      size,
      name: path.split('/').at(-1),
      identity: Object.freeze({
        kind: 'remote',
        key: `${sourceType}:${dataset.id}:${path}`,
        version: `size:${size}`,
      }),
    })])),
    rootName: file.name,
  };
}

/**
 * The reader's source for one served store: a remote file, a Zarr folder
 * URL, or a folder of remote files.
 */
function servedSource(url, resource, dataset, sourceType) {
  const { file } = dataset.anndata;
  if (file.files !== null) return servedFileSet(url, dataset, sourceType);
  return file.layout === 'folder' ? { url, name: file.name } : { file: resource };
}

/**
 * What the dataset list shows about one served store, read from its metadata
 * and `uns` alone (`describeAnnDataStore`), without opening it as the
 * dataset: `{id, name, description, stats: {n_cells, n_genes}}` under the
 * server's id and name. Listing a server is part of starting up, so it must
 * not read what opening reads (the embeddings, the expression index); the
 * store is opened when the dataset is chosen ({@link openServedAnnData}),
 * where a newer choice can replace it.
 *
 * @param {Object} options
 * @param {string} options.serverUrl - The server's base URL, as this browser reaches it
 * @param {{id: string, name: string, anndata: Object}} options.dataset - A
 *   validated catalog entry
 * @param {string} options.sourceType - The owning source's type, for errors
 * @param {AbortSignal|null} [options.signal]
 * @returns {Promise<Readonly<{id: string, name: string, description: string,
 *   stats: Readonly<{n_cells: number, n_genes: number}>}>>}
 */
export async function describeServedAnnData({ serverUrl, dataset, sourceType, signal = null }) {
  const { file } = dataset.anndata;
  const { url, resource } = servedResource(serverUrl, dataset, sourceType);
  const client = new AnnDataReaderClient();
  try {
    const source = servedSource(url, resource, dataset, sourceType);
    const described = await client.describe(source, { signal, expect: { format: file.kind, layout: file.layout } });
    const own = requireCellucidFileMetadata(described.cellucid, sourceType);
    return Object.freeze({
      id: dataset.id,
      name: dataset.name,
      description: own.description ?? '',
      stats: Object.freeze({
        n_cells: described.nObs,
        n_genes: described.hasExpressionMatrix ? described.nVars : 0,
      }),
    });
  } finally {
    client.close();
  }
}

/**
 * Open one served AnnData store as a candidate: the reader opens it, the
 * adapter checks it, and nothing that is open is replaced.
 *
 * @param {Object} options
 * @param {string} options.serverUrl - The server's base URL, as this browser reaches it
 * @param {{id: string, name: string, anndata: Object}} options.dataset - A
 *   validated catalog entry
 * @param {string} options.sourceType - The owning source's type, for errors
 * @returns {Promise<{source: Object, metadata: Object, release: () => void}>}
 */
export async function openServedAnnData({ serverUrl, dataset, sourceType }) {
  const { file, defaults } = dataset.anndata;
  const { url, resource } = servedResource(serverUrl, dataset, sourceType);
  const transfer = getTransferLog().begin({
    key: url,
    label: dataset.name,
    why: file.layout === 'folder'
      ? 'reading on demand: only the chunks each view needs'
      : 'reading on demand: only what each view needs',
    total: file.size,
  });
  const source = createAnnDataFileSource();
  const options = {
    datasetId: dataset.id,
    name: dataset.name,
    description: '',
    source: { name: dataset.name, url, filename: file.name },
    defaults,
    expect: { format: file.kind, layout: file.layout },
  };
  try {
    if (file.files !== null) {
      await source.loadRemoteFileSet(servedFileSet(url, dataset, sourceType), options);
    } else if (file.layout === 'folder') {
      await source.loadRemoteFolder({ url, name: file.name }, options);
    } else {
      await source.loadFile(resource, options);
    }
    const metadata = await source.getMetadata(dataset.id);
    if (metadata.id !== dataset.id || metadata.name !== dataset.name) {
      throw new DataSourceError(
        `The served AnnData store did not open as dataset ${JSON.stringify(dataset.id)}.`,
        DataSourceErrorCode.VALIDATION_ERROR,
        sourceType,
        { datasetId: dataset.id }
      );
    }
    let released = false;
    return {
      source,
      metadata,
      release() {
        if (released) return;
        released = true;
        source.clear();
        getTransferLog().finish(transfer);
      },
    };
  } catch (error) {
    source.clear();
    getTransferLog().finish(transfer, { error });
    throw error;
  }
}
