/**
 * Opening the store behind one AnnData dataset: an `.h5ad` (a local file or a
 * remote one) through `formats/hdf5`, or an AnnData Zarr store (a picked
 * folder, a `.zarr.zip` local or remote, or a Zarr folder on a web host)
 * through `formats/zarr`. Every byte goes through one byte reader per file
 * (`formats/io`), which reports what it fetches, or through a Zarr store's
 * own requests; either way the link to the store is measured as it is read
 * (`formats/io/link.js`), and the reader shapes its strategies by it. A
 * picked folder is the exception: it is this machine's disk, read as a local
 * file is assumed to be, and its per-file reads are not measured.
 *
 * Errors the person who opened the file can act on are explained here, once,
 * for both formats: a file that is not what it claims, a damaged one, and a
 * feature the browser cannot read (a compression filter, a codec), each with
 * what to do instead.
 *
 * @module data/anndata/open
 */

import { LOCAL_POLICY, REMOTE_POLICY, blobByteSource, httpByteSource } from '../../formats/io/byte-source.js';
import { createByteReader } from '../../formats/io/byte-reader.js';
import { LinkMeter } from '../../formats/io/link.js';
import { Hdf5FormatError, Hdf5UnsupportedError, openHdf5 } from '../../formats/hdf5/index.js';
import {
  ZarrFormatError,
  ZarrUnsupportedError,
  directoryStore,
  httpStore,
  openZarr,
  zipStore,
} from '../../formats/zarr/index.js';
import { ZipFormatError, ZipUnsupportedError, openZipArchive } from '../../formats/zip/index.js';
import { isGroup } from '../../formats/store.js';
import { H5AD_FORMAT, ZARR_FORMAT } from './elements.js';

/** Whether a source is a remote file `{url, size, ...}` rather than a `File`. */
function isRemoteFile(file) {
  return file !== null && typeof file === 'object' && typeof file.url === 'string' &&
    !(typeof Blob !== 'undefined' && file instanceof Blob);
}

/**
 * The byte reader of one file: a local `File`/`Blob`, or a remote file
 * `{url, size, name, identity, head?}`, whose `head` (`{bytes, etag, ms}`,
 * read beside the probe of its size: `describeRemoteFile`) is its first read.
 */
function readerOf(file, { onTransfer = null } = {}) {
  if (typeof Blob !== 'undefined' && file instanceof Blob) {
    return createByteReader(blobByteSource(file));
  }
  if (isRemoteFile(file)) {
    const head = file.head ?? null;
    const source = httpByteSource({
      url: file.url,
      size: file.size,
      name: file.name,
      identity: file.identity ?? null,
      etag: head?.etag ?? null,
    });
    const reader = createByteReader(source, {
      onTransfer: progress => onTransfer?.({ url: file.url, ...progress }),
      head: head === null ? null : { bytes: head.bytes, ms: head.ms },
    });
    reader.link.watchProtocol(source.url);
    return reader;
  }
  throw new TypeError('An AnnData file must be a File or a remote file {url, size}.');
}

function explained(message, cause, extra = {}) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = 'UNSUPPORTED';
  error.details = { explained: true, ...extra };
  return error;
}

/**
 * The error a person sees for a failure of the format packages: an
 * unsupported feature (with what to do), or a damaged or mistaken file. Any
 * other error is returned as it is.
 *
 * @param {unknown} error
 * @param {'h5ad'|'zarr'} kind
 * @returns {unknown}
 */
export function explainFormatError(error, kind) {
  const file = kind === 'h5ad' ? 'This .h5ad file' : 'This Zarr store';
  const writeAgain = kind === 'h5ad'
    ? "Save it again with anndata (adata.write_h5ad(new_path), or compression='gzip'), or serve it with cellucid serve, then open the new file."
    : 'Write it again with anndata (adata.write_zarr(new_path)), or serve it with cellucid serve, then open the new store.';
  if (error instanceof Hdf5UnsupportedError || error instanceof ZarrUnsupportedError || error instanceof ZipUnsupportedError) {
    return explained(`${file} uses something the browser cannot read: ${error.message} ${writeAgain}`, error, { feature: error.feature ?? null });
  }
  if (error instanceof Hdf5FormatError) {
    if (/is not an HDF5 file/.test(error.message)) {
      return explained(
        'The selected file is not a valid HDF5/H5AD file. Choose an AnnData .h5ad file or regenerate it with AnnData.',
        error
      );
    }
    return explained(
      `The H5AD file could not be read (${error.message}). It may be corrupted or truncated; regenerate it with AnnData and try again.`,
      error
    );
  }
  if (error instanceof ZarrFormatError || error instanceof ZipFormatError) {
    return explained(
      `The Zarr store could not be read (${error.message}). It may be incomplete or damaged; write it again with AnnData and try again.`,
      error
    );
  }
  return error;
}

/**
 * `fetch` for a Zarr folder on a web host, measuring the link with every
 * request (`link`) and counting what it sends for the Transfers log
 * (`{url, bytes, requests, ms}` running totals keyed by the folder).
 */
function measuredFetch(folderUrl, link, onTransfer) {
  let bytes = 0;
  let requests = 0;
  return async (url, init) => {
    const started = link.begin();
    let body;
    let response;
    try {
      response = await globalThis.fetch(url, init);
      if (init?.method === 'HEAD') {
        link.end(started, null);
        return response;
      }
      body = await response.arrayBuffer();
    } catch (error) {
      link.end(started, null);
      throw error;
    }
    link.end(started, body.byteLength);
    bytes += body.byteLength;
    requests += 1;
    onTransfer?.({ url: folderUrl, bytes, requests, ms: performance.now() - started });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

/**
 * @typedef {Object} OpenedStore
 * @property {Object} root - The store root group
 * @property {import('./elements.js').AnnDataFormat} format
 * @property {string} name
 * @property {import('../../formats/io/link.js').LinkMeter} link - The link to
 *   the store, measured as it is read
 */

/**
 * Open the store of one dataset.
 *
 * @param {{kind: 'h5ad', source: Object} | {kind: 'zarr', source: Object}} description
 *   An `.h5ad` source is a `File` or a remote file. A Zarr source is
 *   `{files: Map<path, File>, rootName}` (a picked folder), `{archive}` (a
 *   `.zarr.zip`, a `File` or a remote file) or `{url}` (a Zarr folder on a
 *   web host).
 * @param {{decodedChunkCacheBytes: number, onTransfer?: Function, signal?: AbortSignal|null,
 *   activity?: import('../../formats/io/activity.js').ReadActivity|null}} options
 *   `activity` counts every read of opening (the file's whole structure).
 * @returns {Promise<OpenedStore>}
 */
export async function openAnnDataStore({ kind, source }, { decodedChunkCacheBytes, onTransfer = null, signal = null, activity = null }) {
  try {
    if (kind === 'h5ad') {
      if (!isRemoteFile(source) && source?.size === 0) {
        throw explained('The selected H5AD file is empty. Choose an AnnData .h5ad file or regenerate it with AnnData.');
      }
      const reader = readerOf(source, { onTransfer });
      const root = await openHdf5(reader, { signal, activity, decodedChunkCacheBytes });
      return { root, format: H5AD_FORMAT, name: source.name, link: reader.link };
    }
    if (kind === 'zarr') {
      let store;
      let name;
      let link;
      if (source?.files instanceof Map) {
        name = source.rootName;
        // A picked folder is files on this machine's disk, read with a local
        // file's policy and never measured: each read is one file, whose
        // time is the file system's cost of opening it plus however long the
        // reader thread is busy before it takes the bytes, not the disk's
        // speed. Measured, the folder's first reads (a 21 KB .zmetadata in
        // 1 ms; files of a few bytes in 17 ms while the thread parses) put a
        // disk delivering gigabytes a second below the 64 MB/s read-ahead
        // line in most opens, and the cell rows of a CSC matrix were then
        // indexed without their values (1,000 rows of Suo in Node: 2.3-2.7 s
        // instead of 1.4-1.6 s).
        link = new LinkMeter(LOCAL_POLICY);
        try {
          store = directoryStore(source.files, { name });
        } catch (error) {
          if (!(error instanceof ZarrFormatError)) throw error;
          // The metadata files are hidden (dot) files, which a browser folder
          // picker may leave out of the selection: an archive keeps them.
          throw explained(
            `${error.message} A browser folder picker may omit these hidden metadata files; if the folder is a Zarr store, open it as a Zarr ZIP archive (.zarr.zip) instead.`,
            error
          );
        }
      } else if (source?.archive) {
        name = source.archive.name || 'dataset.zarr.zip';
        const reader = readerOf(source.archive, { onTransfer });
        link = reader.link;
        const archive = await openZipArchive(reader, { name, signal, activity });
        store = zipStore(archive, { name });
      } else if (typeof source?.url === 'string') {
        name = source.name ?? source.url;
        link = new LinkMeter(REMOTE_POLICY);
        link.watchProtocol(new URL(source.url).href);
        store = httpStore(source.url, { name, concurrency: link, fetch: measuredFetch(source.url, link, onTransfer) });
      } else {
        throw new TypeError('A Zarr source is a folder {files, rootName}, an archive {archive} or a folder URL {url}.');
      }
      const root = await openZarr(store, { signal, activity, decodedChunkCacheBytes });
      if (!isGroup(root)) {
        throw explained(`${name} is a single Zarr array, not an AnnData store (a group with obs, var and X).`);
      }
      return { root, format: ZARR_FORMAT, name, link };
    }
    throw new TypeError(`Unknown AnnData store kind '${String(kind)}'`);
  } catch (error) {
    throw explainFormatError(error, kind);
  }
}
