/**
 * @fileoverview The AnnData reader worker: it owns one reader (`H5adLoader`
 * or `ZarrLoader`) and answers the calls `AnnDataReaderClient` makes on the main thread. All
 * HDF5 work (opening, decompressing, slab reads, the gene-index transpose)
 * runs here, so the page never blocks on it.
 *
 * Protocol (every request carries a numeric `id`, echoed in its reply):
 * - `{id, method: 'open', args: [{kind, source}]}` opens a dataset: an
 *   `.h5ad` File (`kind: 'h5ad'`), or a Zarr store (`kind: 'zarr'`) given as
 *   `{files: Map<path, File>, rootName}` or `{archive: File}`. The reply is
 *   the reader's snapshot (`nObs`, `nVars`, `obsKeys`, `varNames`,
 *   `hasExpressionMatrix`, `isOpen`, `name`).
 * - `{id, method: 'latentOutlierQuantiles', args: [key, width, codes,
 *   nCategories, minPoints]}` computes one categorical field's latent-space
 *   outlier quantiles here, streaming `obsm[key]` from the file
 *   (`LatentOutlierReader`).
 * - `{id, method, args}` for every other reader method; the reply is
 *   `{id, result}` with typed arrays transferred, or `{id, error}`.
 * - The worker posts `{event: 'progress', ...}` during long reads.
 *
 * Errors cross as plain records (`serializeReaderError`) and are rebuilt
 * with their original class, code and cause on the main thread.
 *
 * @module data/anndata-reader-worker
 */

import { H5adLoader } from './h5ad-loader.js';
import { ZarrLoader } from './zarr-loader.js';
import { readZarrZipArchive } from './zarr-archive.js';
import { BlobRangeSource, PageCachedRangeSource } from './range-source.js';
import { LatentOutlierReader } from './latent-outliers-stream.js';

/**
 * A plain, structured-clonable record of one error and its cause chain.
 *
 * @param {unknown} error
 * @param {number} [depth]
 * @returns {Object}
 */
export function serializeReaderError(error, depth = 0) {
  if (!(error instanceof Error)) {
    return { name: 'Error', message: String(error) };
  }
  const record = {
    name: error.name,
    message: error.message,
  };
  if (typeof error.source === 'string') record.sourceType = error.source;
  for (const key of ['code', 'key', 'reason', 'bytes', 'details', 'columns']) {
    if (error[key] !== undefined) {
      try {
        record[key] = structuredClone(error[key]);
      } catch {
        record[key] = String(error[key]);
      }
    }
  }
  if (error.cause !== undefined && depth < 8) {
    record.cause = serializeReaderError(error.cause, depth + 1);
  }
  if (Array.isArray(error.errors) && depth < 8) {
    record.errors = error.errors.map(item => serializeReaderError(item, depth + 1));
  }
  return record;
}

/** Collect the ArrayBuffers of the typed arrays in one result, for transfer. */
function transferables(value, into = new Set(), depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 4) return into;
  if (ArrayBuffer.isView(value)) {
    if (value.buffer instanceof ArrayBuffer &&
        value.byteOffset === 0 &&
        value.byteLength === value.buffer.byteLength) {
      into.add(value.buffer);
    }
    return into;
  }
  if (Array.isArray(value)) return into;
  for (const key of Object.keys(value)) transferables(value[key], into, depth + 1);
  return into;
}

function snapshotOf(loader) {
  return {
    nObs: loader.nObs,
    nVars: loader.nVars,
    obsKeys: loader.obsKeys,
    varNames: loader.varNames,
    hasExpressionMatrix: loader.hasExpressionMatrix,
    isOpen: loader.isOpen,
  };
}

/** Files at most this large are kept once read (Zarr metadata, small chunks). */
const SMALL_FILE_BYTES = 64 * 1024;

/**
 * The files of a Zarr directory, read synchronously in the worker as every
 * other file read of the reader is. WebKit can fail, or never complete, an
 * asynchronous read of a `File` a worker has read before; the small files a
 * store re-reads (its metadata) are kept after their first read.
 *
 * @param {Map<string, File>} files
 * @returns {Map<string, {name: string, size: number, arrayBuffer: Function, text: Function}>}
 */
function workerFileMap(files) {
  if (typeof FileReaderSync !== 'function') return files;
  const reader = new FileReaderSync();
  const kept = new Map();
  const mapped = new Map();
  const textDecoder = new TextDecoder();
  for (const [path, file] of files) {
    const read = () => {
      const cached = kept.get(path);
      if (cached !== undefined) return cached.slice(0);
      const buffer = reader.readAsArrayBuffer(file);
      if (buffer.byteLength <= SMALL_FILE_BYTES) kept.set(path, buffer.slice(0));
      return buffer;
    };
    mapped.set(path, Object.freeze({
      name: file.name,
      size: file.size,
      async arrayBuffer() {
        return read();
      },
      async text() {
        return textDecoder.decode(read());
      },
    }));
  }
  return mapped;
}

/**
 * Create the message handler of one reader worker.
 *
 * @param {Object} [options]
 * @param {(file: Blob) => Promise<Object>|Object} [options.createRangeSource]
 *   How a File becomes a range source; the default reads it synchronously
 *   with `FileReaderSync` (worker only).
 * @param {(message: Object) => void} [options.post] - Posts events
 * @returns {(message: Object) => Promise<{reply: Object, transfer: ArrayBuffer[]}>}
 */
export function createAnnDataReaderHandler({
  createRangeSource = file => new BlobRangeSource(file),
  post = () => {},
} = {}) {
  let loader = null;
  let latent = null;

  const methods = {
    async open({ kind, source }) {
      let next;
      let name;
      if (kind === 'h5ad') {
        next = new H5adLoader();
        next.onProgress = progress => post({ event: 'progress', ...progress });
        await next.open(new PageCachedRangeSource(await createRangeSource(source)));
        name = source.name;
      } else if (kind === 'zarr') {
        // A directory arrives as its file map; a .zarr.zip is indexed here,
        // reading only its central directory.
        const store = source.archive
          ? await readZarrZipArchive(
              new PageCachedRangeSource(await createRangeSource(source.archive)),
              { archiveName: source.archive.name || 'dataset.zarr.zip' }
            )
          : { files: workerFileMap(source.files), rootName: source.rootName };
        next = new ZarrLoader();
        next.onProgress = progress => post({ event: 'progress', ...progress });
        await next.openFileMap(store.files, store.rootName);
        name = store.rootName;
      } else {
        throw new TypeError(`Unknown AnnData reader kind '${String(kind)}'`);
      }
      const previous = loader;
      loader = next;
      latent = new LatentOutlierReader(next);
      previous?.close();
      return { ...snapshotOf(loader), name };
    },
    probeMapping: () => loader.probeMapping(),
    readObsmColumns: (key, columns) => loader.readObsmColumns(key, columns),
    latentOutlierQuantiles: (key, width, codes, nCategories, minPoints) =>
      latent.quantiles(key, width, { codes, nCategories, minPoints }),
    readVarNames: (axis, column) => loader.readVarNames(axis, column),
    getMatrixColumn: (element, index) => loader.getMatrixColumn(element, index),
    prepareMatrix: element => loader.prepareMatrix(element),
    getObsFieldInfo: key => loader.getObsFieldInfo(key),
    async getObsField(key) {
      const field = await loader.getObsField(key);
      // The payload is transferred to the caller, which owns it from now on;
      // the reader keeps nothing that would be detached.
      loader.detachObsField(key, field);
      if (field.dtype === 'categorical') {
        return {
          dtype: field.dtype,
          codes: field.codes,
          categories: field.categories,
          ordered: field.ordered,
        };
      }
      return field;
    },
    releaseObsField: key => loader.releaseObsField(key),
    hasConnectivities: key => loader.hasConnectivities(key),
    getConnectivityEdges: key => loader.getConnectivityEdges(key),
    getDatasetMetadata: () => loader.getDatasetMetadata(),
    clearCache() {
      latent?.clear();
      loader?.clearCache();
    },
    close() {
      const current = loader;
      loader = null;
      latent = null;
      current?.close();
    },
  };

  return async function handle(message) {
    const id = message?.id;
    try {
      const method = methods[message?.method];
      if (typeof method !== 'function') {
        throw new TypeError(`Unknown AnnData reader method '${String(message?.method)}'`);
      }
      if (message.method !== 'open' && message.method !== 'close' &&
          message.method !== 'clearCache' && loader === null) {
        throw new Error('No AnnData file is open in the reader.');
      }
      const result = await method(...(Array.isArray(message.args) ? message.args : []));
      return { reply: { id, result }, transfer: [...transferables(result)] };
    } catch (error) {
      return { reply: { id, error: serializeReaderError(error) }, transfer: [] };
    }
  };
}

if (
  typeof self !== 'undefined' &&
  typeof self.postMessage === 'function' &&
  typeof window === 'undefined'
) {
  const handle = createAnnDataReaderHandler({
    post: message => self.postMessage(message),
  });
  // Requests interleave at the reader's own await points (a gene-index
  // transpose yields between slabs), so a field read never waits for one;
  // every h5wasm call itself is synchronous and runs to completion.
  self.onmessage = async event => {
    const { reply, transfer } = await handle(event.data);
    self.postMessage(reply, transfer);
  };
}
