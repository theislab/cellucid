/**
 * Opening the store behind one dataset, whatever file it arrived as: the one
 * entry is `openDatasetStore()`. Its source is one file (a local `File` or a
 * remote file, in any single-file format: an `.h5ad`, a `.zarr.zip`, an
 * `.rds`, …), a picked folder or remote files that make one dataset
 * (`{files, rootName}`), or a store folder on a web host. What it is is
 * decided here, from content where the content is at hand (a file's first
 * bytes, a folder's marker files) and from its name otherwise
 * (`data/input-formats.js`); the caller's expectation (a server's `kind`, a
 * catalog's path) stands in for a name.
 *
 * Then, by the format's container and access:
 *
 * - an HDF5 file opens through `formats/hdf5`, a Zarr store (a picked
 *   folder, a `.zarr.zip`, a folder on a web host) through `formats/zarr`;
 *   a layout view (`views/`) presents a root it recognises as AnnData,
 *   every array read in place; a root none recognises is AnnData as stored;
 * - a single-stream format is transcoded (`transcode/`) into an AnnData
 *   Zarr store, which the Zarr reader then opens.
 *
 * Every byte goes through one byte reader per file (`formats/io`), which
 * reports what it fetches, or through a Zarr store's own requests; either
 * way the link to the store is measured as it is read
 * (`formats/io/link.js`), and the reader shapes its strategies by it. A
 * picked folder is the exception: it is this machine's disk, read as a local
 * file is assumed to be, and its per-file reads are not measured.
 *
 * Errors the person who opened the file can act on are explained here, once,
 * for every format: a file that is not what it claims, a damaged one, and a
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
import {
  SIGNATURE_BYTES,
  fileFormatOfName,
  folderFormatOfName,
  folderFormatOfPaths,
  folderMarkersOf,
  INPUT_FORMATS,
  inputFormat,
  isInputFormatId,
  layoutOfHead,
} from '../input-formats.js';
import { H5AD_FORMAT, ZARR_FORMAT } from './elements.js';
import { LAYOUT_VIEWS } from './views/index.js';
import { LayoutRefusal } from './views/refusal.js';
import { TRANSCODERS } from './transcode/index.js';
import { formatCountOf } from '../../utils/format-units.js';
/** Whether a source is a remote file `{url, size, ...}` rather than a `File`. */
function isRemoteFile(file) {
  return file !== null && typeof file === 'object' && typeof file.url === 'string' &&
    !(typeof Blob !== 'undefined' && file instanceof Blob);
}

/**
 * The byte reader of one file: a local `File`/`Blob`, or a remote file
 * `{url, size, name, identity, head?, access?}`, whose `head` (`{bytes, etag, ms}`,
 * read beside the probe of its size: `describeRemoteFile`) is its first read.
 * A file behind a sign-in or an expiring link names its access
 * (`{provider, ref}`), which `sourceAccess` turns into the byte source's
 * `access`; its `url` is then its display link.
 */
function readerOf(file, { onTransfer = null, sourceAccess = null } = {}) {
  if (typeof Blob !== 'undefined' && file instanceof Blob) {
    return createByteReader(blobByteSource(file));
  }
  if (isRemoteFile(file)) {
    const head = file.head ?? null;
    if (file.access != null && sourceAccess === null) {
      throw new TypeError(`${file.name} needs its access, which this reader was not given.`);
    }
    const source = httpByteSource({
      url: file.url,
      size: file.size,
      name: file.name,
      identity: file.identity ?? null,
      etag: head?.etag ?? null,
    }, file.access == null ? {} : { access: sourceAccess(file.access) });
    const reader = createByteReader(source, {
      onTransfer: progress => onTransfer?.({ url: file.url, ...progress }),
      head: head === null ? null : { bytes: head.bytes, ms: head.ms },
    });
    reader.link.watchProtocol(source.url);
    reportArrivals(reader.link, file.url, onTransfer);
    return reader;
  }
  throw new TypeError('An AnnData file must be a File or a remote file {url, size}.');
}

/**
 * A small file beside a dataset's matrix, whole, as text (a Cell Ranger
 * analysis CSV): a picked folder's `File`, or a served folder's remote file,
 * read with the same byte reader as the matrix.
 */
async function textOf(file, options) {
  if (typeof Blob !== 'undefined' && file instanceof Blob) return file.text();
  return new TextDecoder().decode(await readerOf(file, options).read(0, file.size));
}

/**
 * What a reader's link does between its counted requests, for whoever
 * watches the read (the Transfers log, a startup step): while a request's
 * bytes arrive, `onTransfer` hears `{url, arriving: true}` at most every
 * `ARRIVAL_INTERVAL_MS` (a read of one large request shows progress before
 * it completes); each request made again after a transient failure is
 * `{url, retrying: message}`, the failure naming the request's URL.
 */
const ARRIVAL_INTERVAL_MS = 250;

function reportArrivals(link, url, onTransfer) {
  if (onTransfer === null) return;
  let last = -Infinity;
  link.responses.onReceived = () => {
    const now = performance.now();
    if (now - last < ARRIVAL_INTERVAL_MS) return;
    last = now;
    onTransfer({ url, arriving: true });
  };
  link.responses.onRetry = (error, attempts) => {
    onTransfer({ url, retrying: `${error.message} Asked ${formatCountOf(attempts, 'time')} so far.` });
  };
}

function explained(message, cause, extra = {}) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = 'UNSUPPORTED';
  error.details = { explained: true, ...extra };
  return error;
}

/** A format label with its article: "an AnnData (.h5ad)", "a Loom (.loom)", "an R object (.rds)". */
function withArticle(label) {
  return `${/^([aeiou]|r\b|h5)/i.test(label) ? 'an' : 'a'} ${label}`;
}

/** How a message names a file of one format. */
function subjectOf(format) {
  if (format === 'h5ad') return 'This .h5ad file';
  if (format !== null && isInputFormatId(format) && inputFormat(format).container === 'zarr') return `This ${inputFormat(format).label} store`;
  return format !== null && isInputFormatId(format) ? `This ${inputFormat(format).label} file` : 'This file';
}

/**
 * The error a person sees for a failure of the format packages: an
 * unsupported feature (with what to do), or a damaged or mistaken file. Any
 * other error is returned as it is.
 *
 * @param {unknown} error
 * @param {string|null} format - The input format id (`input-formats.js`) the
 *   file was opened as, or null before that is known
 * @returns {unknown}
 */
export function explainFormatError(error, format) {
  const known = format !== null && isInputFormatId(format) ? inputFormat(format) : null;
  const writeAgain = known?.writeAgain ?? 'Write it again with anndata, or serve it with cellucid serve, then open the new file.';
  if (error instanceof LayoutRefusal) {
    // A recognised file Cellucid does not show; its message says what to do.
    return explained(error.message, error, { reason: error.reason });
  }
  if (error instanceof Hdf5UnsupportedError || error instanceof ZarrUnsupportedError || error instanceof ZipUnsupportedError) {
    return explained(`${subjectOf(format)} uses something the browser cannot read: ${error.message} ${writeAgain}`, error, { feature: error.feature ?? null });
  }
  if (error instanceof Hdf5FormatError) {
    if (/is not an HDF5 file/.test(error.message)) {
      // The name promised a format the registry reads as HDF5; the bytes are
      // not HDF5 at all, so say which format was expected and how to make one.
      return explained(
        known === null
          ? `The selected file is not a valid HDF5 file. ${writeAgain}`
          : `The selected file is not a valid HDF5 file, so it cannot be ${withArticle(known.label)} file. ${writeAgain}`,
        error
      );
    }
    return explained(
      `${subjectOf(format)} could not be read (${error.message}). It may be corrupted or truncated. ${writeAgain}`,
      error
    );
  }
  if (error instanceof ZarrFormatError || error instanceof ZipFormatError) {
    return explained(
      `${subjectOf(format)} could not be read (${error.message}). It may be incomplete or damaged. ${writeAgain}`,
      error
    );
  }
  return error;
}

/**
 * @typedef {Object} OpenedStore
 * @property {Object} root - The AnnData store root group (a layout view's
 *   root for a format presented through one)
 * @property {string} format - The input format id (`input-formats.js`)
 * @property {'file'|'zip'|'folder'} layout - How it arrived
 * @property {import('./elements.js').AnnDataFormat} readerFormat - How the
 *   AnnData reader names its storage in messages
 * @property {2|3|null} zarrVersion - The Zarr format version a Zarr store
 *   was read as; null for any other container
 * @property {string} name - The file or folder name
 * @property {import('../../formats/io/link.js').LinkMeter} link - The link to
 *   the store, measured as it is read
 * @property {import('./transcode/session.js').Conversion} [conversion] - A
 *   single-stream format read once (`transcode/`): where its store is kept
 *   and what was not read; absent for every other format
 */

/**
 * The source of one dataset:
 *
 * - `{file}`: one file, a `File`/`Blob` or a remote file
 *   `{url, size, name, identity, head?, access?}`;
 * - `{files, rootName}`: a picked or dropped folder, every file by its path
 *   below the folder (`Map<string, File>`), or remote files that make one
 *   dataset together (`Map<string, {url, size, name}>`);
 * - `{url, name}`: a store folder on a web host, its URL ending in `/`.
 *
 * @typedef {{file: File|Blob|Object} | {files: Map<string, File|Object>, rootName: string} | {url: string, name?: string}} DatasetSource
 */

/** The first bytes of one file when they are at hand without a request. */
async function headOf(file) {
  if (typeof Blob !== 'undefined' && file instanceof Blob) {
    if (file.size === 0) return new Uint8Array(0);
    return new Uint8Array(await file.slice(0, SIGNATURE_BYTES).arrayBuffer());
  }
  const bytes = file?.head?.bytes;
  return bytes instanceof Uint8Array ? bytes : null;
}

/** What one source is: its layout and container, decided by content first. */
async function identify(source, expect) {
  if (source?.files instanceof Map) {
    const found = folderFormatOfPaths(source.files.keys());
    // A folder whose marker files the folder picker left out (hidden files)
    // names no format; it is read as a Zarr store, whose reader then says
    // what is missing and what to do.
    const format = found?.format ?? expect?.format ?? null;
    return { layout: 'folder', container: format === null ? 'zarr' : inputFormat(format).container, expected: format };
  }
  if (source !== null && typeof source === 'object' && typeof source.url === 'string' && source.file === undefined) {
    const format = expect?.format ?? folderFormatOfName(source.name ?? '')?.format ?? null;
    return { layout: 'folder', container: format === null ? 'zarr' : inputFormat(format).container, expected: format };
  }
  const file = source?.file;
  if (file === null || typeof file !== 'object') {
    throw new TypeError('A dataset source is a file {file}, a folder {files, rootName} or a folder URL {url}.');
  }
  const named = isInputFormatId(expect?.format) ? expect : fileFormatOfName(file.name ?? '');
  const sniffed = layoutOfHead(await headOf(file));
  if (sniffed !== null) {
    // The content decides; the name still names the format when it agrees.
    const agrees = named !== null && named.layout === sniffed.layout && inputFormat(named.format).container === sniffed.container;
    return { ...sniffed, expected: agrees ? named.format : null };
  }
  if (named === null) {
    throw explained(
      `${file.name ?? 'This file'} is not a file Cellucid opens: its name and its first bytes match no format it reads ` +
      `(${INPUT_FORMATS.map(format => format.label).join(', ')}).`
    );
  }
  return { layout: named.layout, container: inputFormat(named.format).container, expected: named.format };
}

/**
 * Present one opened container as an AnnData store root: the first format of
 * that container and layout (in registry order) whose layout view
 * recognises the root presents it through its view; a root no view
 * recognises is the one format of that container and layout read as stored
 * (AnnData: `h5ad`, `zarr`).
 *
 * @param {Object} root - The container's root group (`openHdf5`, `openZarr`)
 * @param {{container: string, layout: 'file'|'zip'|'folder', name: string, signal?: AbortSignal|null,
 *   fromLink?: boolean, files?: Map<string, File>, base?: string}} context - `files` and `base`: a
 *   folder format's files and the folder of the file opened (`views/index.js`);
 *   `fromLink`: opened from a link, which a view's refusal advises for
 * @param {{formats?: ReadonlyArray<Object>, views?: Readonly<Record<string, Object>>}} [tables] -
 *   The registry and the views (the module's own by default)
 * @returns {Promise<{format: string, root: Object, readerFormat: import('./elements.js').AnnDataFormat}>}
 */
export async function presentStore(root, { container, layout, name, ...context }, { formats = INPUT_FORMATS, views = LAYOUT_VIEWS } = {}) {
  const candidates = formats.filter(format => format.container === container && Object.hasOwn(format.names, layout));
  for (const format of candidates) {
    const view = views[format.id];
    if (view !== undefined && view.recognize(root)) {
      const viewed = await view.view(root, { name, layout, signal: null, ...context });
      if (typeof root.close === 'function' && typeof viewed?.close !== 'function') {
        throw new TypeError(`The ${format.id} layout view must close the store it presents.`);
      }
      return { format: format.id, root: viewed, readerFormat: view.readerFormat };
    }
  }
  const stored = candidates.find(format => views[format.id] === undefined && format.access !== 'stream');
  if (stored === undefined) {
    throw explained(`${name} is a ${container} file that holds none of the formats Cellucid reads.`);
  }
  return { format: stored.id, root, readerFormat: container === 'hdf5' ? H5AD_FORMAT : ZARR_FORMAT };
}

/** Open a Zarr store of one layout: its store, name and link. */
async function zarrStoreOf(source, layout, { onTransfer, sourceAccess, signal, activity }) {
  if (layout === 'folder' && source.files instanceof Map) {
    const name = source.rootName;
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
    const link = new LinkMeter(LOCAL_POLICY);
    try {
      return { store: directoryStore(source.files, { name }), name, link };
    } catch (error) {
      if (!(error instanceof ZarrFormatError)) throw error;
      // The metadata files are hidden (dot) files, which a browser folder
      // picker may leave out of the selection: an archive keeps them.
      throw explained(
        `${error.message} A browser folder picker may omit these hidden metadata files; if the folder is a Zarr store, open it as a Zarr ZIP archive (.zarr.zip) instead.`,
        error
      );
    }
  }
  if (layout === 'zip') {
    const name = source.file.name || 'dataset.zarr.zip';
    const reader = readerOf(source.file, { onTransfer, sourceAccess });
    const archive = await openZipArchive(reader, { name, signal, activity });
    return { store: zipStore(archive, { name }), name, link: reader.link };
  }
  const name = source.name ?? source.url;
  const link = new LinkMeter(REMOTE_POLICY);
  link.watchProtocol(new URL(source.url).href);
  // Every request measures the link and is counted for the Transfers
  // log (`{url, bytes, requests, ms}` running totals keyed by the folder).
  const store = httpStore(source.url, { name, concurrency: link, onTransfer });
  reportArrivals(link, source.url, onTransfer);
  return { store, name, link };
}

/**
 * Open the store of one dataset.
 *
 * @param {{source: DatasetSource, expect?: {format: string, layout: 'file'|'zip'|'folder'}|null, fromLink?: boolean}} request
 *   `expect`: what the caller was told the source is (a server's
 *   `anndata.file`, a catalog entry's path), standing in for its name when
 *   its content does not say. `fromLink`: it was opened from a link (else
 *   from this computer); the views and transcoders advise on a refusal with
 *   what can be done from there.
 * @param {{decodedChunkCacheBytes: number, onTransfer?: Function, signal?: AbortSignal|null,
 *   activity?: import('../../formats/io/activity.js').ReadActivity|null, sourceAccess?: Function|null}} options
 *   `activity` counts every read of opening (the file's whole structure).
 *   `sourceAccess(descriptor)`: the byte source access of a remote file that
 *   names one (`{provider, ref}`: a sign-in or an expiring link).
 *   `transcoding`: what a single-stream format's transcoder may use
 *   (`transcode/`): `createActivity` (its pass as an activity of its own),
 *   `choose({question, options})` (the person picks among the objects one
 *   file holds; resolves to an index), `onStore({directory, state})` (where
 *   its store is kept, `writing` then `complete`).
 * @returns {Promise<OpenedStore>}
 */
export async function openDatasetStore({ source, expect = null, fromLink = false }, { decodedChunkCacheBytes, onTransfer = null, signal = null, activity = null, sourceAccess = null, transcoding = {} }) {
  let format = expect?.format ?? null;
  try {
    const file = source?.file ?? null;
    if (file !== null && !isRemoteFile(file) && file?.size === 0) {
      throw explained((expect?.format ?? fileFormatOfName(file.name ?? '')?.format) === 'h5ad'
        ? 'The selected H5AD file is empty. Choose an AnnData .h5ad file or regenerate it with AnnData.'
        : `The selected file ${file.name ?? ''} is empty. Choose an AnnData file or store, or write it again with AnnData.`);
    }
    const { layout, container, expected } = await identify(source, expect);
    format = expected;
    const transcoder = expected === null ? undefined : TRANSCODERS[expected];
    if (transcoder !== undefined) {
      const byteReaderOf = item => readerOf(item, { onTransfer, sourceAccess });
      const transcoded = await transcoder.transcode(source, { ...transcoding, signal, activity, onTransfer, byteReaderOf, expect, fromLink });
      const stored = await openZarr(transcoded.store, { signal, activity, decodedChunkCacheBytes });
      // A transcoder writes an object of several assays in MuData's layout
      // (`views/modalities.js`), presented as every MuData store is.
      const muData = LAYOUT_VIEWS['mudata-zarr'];
      const root = muData.recognize(stored) ? await muData.view(stored, { name: transcoded.name, layout, signal }) : stored;
      return {
        root, format: expected, layout, readerFormat: ZARR_FORMAT, zarrVersion: stored.zarrFormat ?? null,
        name: transcoded.name, link: transcoded.link, conversion: transcoded.conversion,
      };
    }
    if (container !== 'hdf5' && container !== 'zarr') {
      // A single-stream container (no random access) is read only by the
      // transcoder of the format its name or the caller names.
      throw explained(
        `${file?.name ?? source?.rootName ?? source?.name ?? 'This file'} is a ${container} file, ` +
        'but neither its name nor what it was opened as says which format it holds.'
      );
    }
    if (container === 'hdf5' && layout === 'folder') {
      // A folder whose data is one HDF5 file and the files beside it (a
      // Cell Ranger outs/ folder): the format's view names the file.
      const folderView = LAYOUT_VIEWS[expected];
      const name = source.rootName ?? source.name ?? 'the folder';
      if (!(source.files instanceof Map)) {
        throw explained(`${name} is a ${inputFormat(expected).label}: open it from this computer with Open… › Folder…, or link its .h5 file.`);
      }
      const matrix = folderView.matrixFile(source.files);
      if (matrix === null) {
        throw explained(`${name} holds no count matrix file (${folderMarkersOf(expected).join(', ')}).`);
      }
      const reader = readerOf(matrix.file, { onTransfer, sourceAccess });
      const root = await openHdf5(reader, { signal, activity, decodedChunkCacheBytes });
      const readText = file => textOf(file, { onTransfer, sourceAccess });
      const opened = await presentStore(root, { container: 'hdf5', layout, name, signal, fromLink, files: source.files, base: matrix.base, readText });
      format = opened.format;
      return { root: opened.root, format: opened.format, layout, readerFormat: opened.readerFormat, zarrVersion: null, name, link: reader.link };
    }
    if (container === 'hdf5') {
      const reader = readerOf(file, { onTransfer, sourceAccess });
      const root = await openHdf5(reader, { signal, activity, decodedChunkCacheBytes });
      const opened = await presentStore(root, { container: 'hdf5', layout, name: file.name, signal, fromLink });
      format = opened.format;
      return { root: opened.root, format: opened.format, layout, readerFormat: opened.readerFormat, zarrVersion: null, name: file.name, link: reader.link };
    }
    const { store, name, link } = await zarrStoreOf(source, layout, { onTransfer, sourceAccess, signal, activity });
    const root = await openZarr(store, { signal, activity, decodedChunkCacheBytes });
    if (!isGroup(root)) {
      throw explained(`${name} is a single Zarr array, not an AnnData store (a group with obs, var and X).`);
    }
    const opened = await presentStore(root, { container: 'zarr', layout, name, signal, fromLink });
    format = opened.format;
    return { root: opened.root, format: opened.format, layout, readerFormat: opened.readerFormat, zarrVersion: root.zarrFormat ?? null, name, link };
  } catch (error) {
    throw explainFormatError(error, format);
  }
}
