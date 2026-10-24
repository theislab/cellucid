/**
 * A served AnnData store: the dataset a Cellucid Python server (`cellucid
 * serve`, `serve_anndata()`, `show_anndata()`) declares in
 * `_cellucid/datasets` with an `anndata` member. The server computes nothing:
 * it names the dataset, serves the store's bytes, and states the launch
 * choices. The browser's AnnData reader reads the store in place, with range
 * requests, exactly as it reads a linked file -- under the server's dataset id
 * and name, so sessions and community annotations keep matching.
 *
 * `anndata` is
 *
 *     {
 *       file: {url, kind: 'h5ad'|'zarr', layout: 'file'|'zip'|'folder', size?},
 *       defaults: {embedding1d?, embedding2d?, embedding3d?, knn?, expression?,
 *                  geneIdColumn?, latentKey?, vectorFieldDefault?, obsKeys?,
 *                  normalizeEmbeddings?,
 *                  centroidMinPoints?}
 *     }
 *
 * `defaults` are the AnnData launch defaults (`requireAnnDataLaunchDefaults`
 * in `base-anndata-adapter.js`).
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
import { createH5adDataSource } from './h5ad.js';
import { createZarrDataSource } from './zarr.js';
import { getTransferLog } from './transfer-log.js';

const ROUTE_PREFIX = '_cellucid/anndata/';
const FILE_KEYS = Object.freeze(['url', 'kind', 'layout', 'size']);
const LAYOUTS = Object.freeze({ h5ad: ['file'], zarr: ['zip', 'folder'] });

function isPlainRecord(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function requireKeys(value, required, allowed, label) {
  if (!isPlainRecord(value)) throw new TypeError(`${label} must be a JSON object`);
  const missing = required.filter(key => !Object.hasOwn(value, key));
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (missing.length > 0 || unknown.length > 0) {
    const details = [];
    if (missing.length > 0) details.push(`missing ${missing.join(', ')}`);
    if (unknown.length > 0) details.push(`unsupported ${unknown.join(', ')}`);
    throw new TypeError(`${label} has noncanonical fields (${details.join('; ')})`);
  }
  return value;
}

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
 * Validate the `anndata` member of one served dataset entry.
 *
 * @param {unknown} value
 * @param {string} label
 * @returns {Readonly<{file: Readonly<Object>, defaults: Readonly<Object>}>}
 */
export function requireServedAnnData(value, label) {
  requireKeys(value, ['file', 'defaults'], ['file', 'defaults'], label);
  const file = value.file;
  const kind = isPlainRecord(file) ? file.kind : undefined;
  const layout = isPlainRecord(file) ? file.layout : undefined;
  const sized = layout !== 'folder';
  requireKeys(file, sized ? FILE_KEYS : ['url', 'kind', 'layout'], sized ? FILE_KEYS : ['url', 'kind', 'layout'], `${label}.file`);
  if (!Object.hasOwn(LAYOUTS, kind) || !LAYOUTS[kind].includes(layout)) {
    throw new TypeError(
      `${label}.file must be an h5ad file, a zipped Zarr store or a Zarr store folder`
    );
  }
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
  return JSON.stringify([serverUrl, dataset.id, file.route, file.size]);
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
  const client = new AnnDataReaderClient({ kind: file.kind });
  try {
    const source = file.layout === 'file'
      ? resource
      : file.layout === 'zip'
        ? { archive: resource }
        : { url, name: file.name };
    const described = await client.describe(source, { signal });
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
  const source = file.kind === 'h5ad' ? createH5adDataSource() : createZarrDataSource();
  const options = {
    datasetId: dataset.id,
    name: dataset.name,
    description: '',
    source: { name: dataset.name, url, filename: file.name },
    defaults,
  };
  try {
    if (file.layout === 'file') {
      await source.loadFromFile(resource, options);
    } else if (file.layout === 'zip') {
      await source.loadFromArchiveFile(resource, options);
    } else {
      await source.loadFromRemoteFolder({ url, name: file.name }, options);
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
