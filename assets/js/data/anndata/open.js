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
 *   a layout view (`views/`) presents a root it recognizes as AnnData,
 *   every array read in place; a root none recognizes is AnnData as stored;
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
 * for every format: a web page in place of data (a link's sign-in or preview
 * page, a page saved under a data file's name), a file that is not what it
 * claims, a damaged one, and a feature the browser cannot read (a
 * compression filter, a codec), each with what to do instead.
 *
 * @module data/anndata/open
 */

import { LOCAL_POLICY, REMOTE_POLICY, blobByteSource, httpByteSource, looksLikeWebPage } from '../../formats/io/byte-source.js';
import { createByteReader } from '../../formats/io/byte-reader.js';
import { equivalentS3Urls } from '../../formats/io/s3.js';
import { forgetFileInMemory, forgetOtherVersionsInMemory, rangeCacheAddress, rangeCacheKey, withRangeCache } from '../../formats/io/range-cache.js';
import { keptPartsOf, withKeptParts, confirmFileVersion } from '../../formats/io/kept-parts.js';
import { LinkMeter } from '../../formats/io/link.js';
import { realmHosts } from '../../formats/io/hosts.js';
import { DecodedBudget } from '../../formats/io/decoded-budget.js';
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
import { ANNDATA_OPENING_PATHS, AnnDataFormatError, H5AD_FORMAT, ZARR_FORMAT, attributeValue } from './elements.js';
import { LAYOUT_VIEWS } from './views/index.js';
import { LayoutRefusal } from './views/refusal.js';
import { TRANSCODERS } from './transcode/index.js';
import { THIS_TAB, findKeptDownload, forgetKeptCopy, forgetOtherVersions, keepDownload } from './transcode/space.js';
import { decompressed } from '../../formats/rds/stream.js';
import { RdsFormatError, RdsUnsupportedError } from '../../formats/rds/errors.js';
import { linkIdentity } from '../sources/link-credentials.js';
import { formatCountOf } from '../../utils/format-units.js';
import { throwIfAborted } from '../../utils/abort.js';
/** Whether a source is a remote file `{url, size, ...}` rather than a `File`. */
function isRemoteFile(file) {
  return file !== null && typeof file === 'object' && typeof file.url === 'string' &&
    !(typeof Blob !== 'undefined' && file instanceof Blob);
}

/**
 * The byte reader of one file: a local `File`/`Blob`, or a remote file
 * `{url, size, name, identity, etag?, head?, access?, downloaded?}` (`etag`:
 * the version a viewer host states in its dataset list), whose `head`
 * (`{bytes, etag, ms}`, read beside the probe of its size:
 * `describeRemoteFile`) is its first read. A remote file its host serves
 * only whole is read from its `downloaded` copy (kept in this browser:
 * `downloadRemoteFile`), under the remote file's identity, so what is kept
 * of it is found again without downloading it.
 * A file behind a sign-in or an expiring link names its access
 * (`{provider, ref}`), which `sourceAccess` turns into the byte source's
 * `access`; its `url` is then its display link.
 *
 * What a remote file's reads fetch is kept in this browser under its
 * version (`formats/io/kept-parts.js`), and read from there by a later
 * reader of the same version, unless `keeping` is null: a file a
 * transcoder reads whole, whose converted store is what is kept of it.
 * `keeping`: where (`environment`, `tab`) and who hears of each directory
 * kept (`onStore`).
 */
function readerOf(file, { onTransfer = null, sourceAccess = null, keeping = null, resumed = null } = {}) {
  if (typeof Blob !== 'undefined' && file instanceof Blob) {
    return createByteReader(blobByteSource(file));
  }
  // A copy kept in this browser: of a remote file read whole, or of a
  // compressed copy decompressed there (`decompressedCopyOf`).
  if (file !== null && typeof file === 'object' && typeof Blob !== 'undefined' && file.downloaded instanceof Blob) {
    const checks = file.downloadedChecks ?? null;
    return createByteReader(blobByteSource(file.downloaded, {
      name: file.name,
      identity: file.identity ?? null,
      // Every read of the kept copy is checked; a damaged one is forgotten,
      // so the next open downloads the file again.
      checks: checks === null ? null : { ...checks, onDamage: () => forgetKeptCopy(checks.directory) },
    }));
  }
  if (isRemoteFile(file)) {
    const head = file.head ?? null;
    if (file.access != null && sourceAccess === null) {
      throw new TypeError(`${file.name} needs its access, which this reader was not given.`);
    }
    const access = file.access == null ? null : sourceAccess(file.access);
    const fetched = httpByteSource({
      url: file.url,
      size: file.size,
      name: file.name,
      identity: file.identity ?? null,
      // The version read beside the probe, or the one a viewer host states.
      etag: head?.etag ?? file.etag ?? null,
      lastModified: file.lastModified ?? null,
      // A public S3 object's other addresses: six more connections each.
      mirrors: access === null ? equivalentS3Urls(file.url) : [],
      head: head?.bytes ?? null,
    }, access === null ? {} : { access });
    // Bytes an earlier reading of this version kept in this browser are
    // read from there; what is fetched is kept (`kept-parts.js`). A file
    // that changed on its host while open makes every kept copy of it, in
    // this browser and in the page's memory, stale; one whose reads name no
    // version is kept once its provider confirms the version still holds.
    const parts = keeping === null ? null : keptPartsOf(file, {
      ...keeping,
      onChanged: () => forgetFileInMemory(file),
      confirm: access?.confirmVersion ?? null,
    });
    const kept = withKeptParts(fetched, parts, { head: head?.bytes ?? null });
    // Ranges another reader of the same bytes fetched are not fetched again.
    const source = withRangeCache(kept, rangeCacheKey(file), rangeCacheAddress(file));
    // Opened again from an earlier opening's description (`resumed`, its
    // version asked just now): the head's bytes stand, its timing and the
    // provider's are that opening's, so they measure nothing of this link --
    // a link priced from a stale round trip would give the page's memory
    // (`range-cache.js`) no time to answer and fetch what it holds. The
    // version check's own answer seeds the stall timeout.
    const checkedMs = resumed === null ? undefined : resumed.get(file) ?? null;
    const reader = createByteReader(source, {
      onTransfer: progress => onTransfer?.({ url: file.url, ...progress }),
      head: head === null ? null : { bytes: head.bytes, ms: checkedMs === undefined ? head.ms : null },
    });
    if (checkedMs !== undefined) {
      if (Number.isFinite(checkedMs)) reader.link.responses.answered(checkedMs);
    } else if (head === null && Number.isFinite(file.answeredMs)) {
      // Without a head read beside its probe, the host's answer to the
      // provider's own request (`describeRemoteFile`) seeds the stall timeout.
      reader.link.responses.answered(file.answeredMs);
    }
    reader.link.watchProtocol(source.url);
    reportArrivals(reader.link, file.url, onTransfer);
    return reader;
  }
  throw new TypeError('An AnnData file must be a File or a remote file {url, size}.');
}

/**
 * Ask every remote file of `source` (a file, or the files of a set) for its
 * version now (`kept-parts.js` `confirmFileVersion`), together: one small
 * request each. A file that changed fails the opening as `CHANGED`, every
 * kept copy of it forgotten, in this browser and in the page's memory.
 */
async function confirmSourceVersions(source, { sourceAccess, environment, signal }) {
  const files = [
    ...(source?.file === undefined || source.file === null ? [] : [source.file]),
    ...(source?.files instanceof Map ? source.files.values() : []),
  ].filter(isRemoteFile);
  const checked = await Promise.all(files.map(file => confirmFileVersion(file, {
    access: file.access == null || sourceAccess === null ? null : sourceAccess(file.access),
    environment,
    signal,
    onChanged: () => forgetFileInMemory(file),
  })));
  // How long each check took to answer (null: its provider was asked): the
  // readers opened next start their links from it (`readerOf`).
  return new Map(files.map((file, i) => [file, checked[i]]));
}

/**
 * What a reader's link does between its counted requests, for whoever
 * watches the read (the Transfers log, a startup step): while a request's
 * bytes arrive, `onTransfer` hears `{url, arriving: true}` at most every
 * `ARRIVAL_INTERVAL_MS` (a read of one large request shows progress before
 * it completes); each request made again after a transient failure is
 * `{url, retrying: message}`, the failure naming the request's URL; a wait
 * the host named (its request budget, a `Retry-After`) is `{url, waiting:
 * sentence}`, and `{url, waiting: null}` once it ends.
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
  // A wait the host named (`byte-source.js` `HostWait`): not a failure.
  link.responses.onWait = wait => {
    onTransfer({ url, waiting: wait === null ? null : wait.text });
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

/** The formats whose files are AnnData (or MuData, AnnData per modality) as stored. */
const ANNDATA_NATIVE_FORMATS = new Set(['h5ad', 'zarr', 'h5mu', 'mudata-zarr']);

/**
 * The error a person sees for a failure of the format packages: an
 * unsupported feature (with what to do), a damaged or mistaken file, or a
 * file whose AnnData parts break the format (`AnnDataFormatError`). Any
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
    // A recognized file Cellucid does not show; its message says what to do.
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
  if (error instanceof AnnDataFormatError) {
    // The container read fine; an element in it is not what its writer
    // should have written (anndata's, or a format presented as AnnData:
    // a Loom file, a 10x matrix).
    const rule = error.message.replace(/\.$/, '');
    return explained(
      known === null || ANNDATA_NATIVE_FORMATS.has(known.id)
        ? `${subjectOf(format)} breaks the AnnData format: ${rule}. ${writeAgain}`
        : `${subjectOf(format)} is not laid out as its format requires: ${rule}. ${writeAgain}`,
      error
    );
  }
  if (error instanceof RdsUnsupportedError) {
    // Written for the person already: what the file uses and what to do.
    return explained(error.message, error, { feature: error.feature ?? null });
  }
  if (error instanceof RdsFormatError) {
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
 * @property {Object|null} identity - What the bytes read are (`byte-source.js`
 *   identities: the file's, a folder's every file's, a folder URL's), which a
 *   gene index kept in this browser is filed under (`kept-column-index.js`);
 *   null for a store transcoded in this browser
 * @property {{url: string, version: string|null, unchanged: (options?: {signal?: AbortSignal|null}) => Promise<boolean>}|null} [folder] -
 *   A store folder on a web host: its version as opened (its consolidated
 *   metadata's validator) and whether it is still that version; absent or
 *   null for every other layout
 * @property {DecodedBudget} decodedBudget - The byte budget every cache of
 *   the store's decoded chunks shares (`formats/io/decoded-budget.js`): the
 *   store's own and the reader's kept across a growth (`AnnDataReader.open`)
 * @property {import('./transcode/session.js').Conversion} [conversion] - A
 *   single-stream format read once (`transcode/`): where its store is kept
 *   and what was not read; absent for every other format
 * @property {import('./transcode/matrix-market.js').MatrixStream|null} [matrixStream] -
 *   A matrix read after its map: rows `[0, held)` of the store hold their
 *   matrix rows, and a share of more is read on demand; null otherwise
 */

/**
 * The source of one dataset:
 *
 * - `{file}`: one file, a `File`/`Blob` or a remote file
 *   `{url, size, name, identity, head?, access?}`;
 * - `{files, rootName}`: a picked or dropped folder, every file by its path
 *   below the folder (`Map<string, File>`), or remote files that make one
 *   dataset together (`Map<string, {url, size, name}>`);
 * - `{url, name, version?, key?}`: a store folder on a web host, its URL
 *   ending in `/`; `version`: what names its content (a commit it is read
 *   at); `key`: where it is whatever its version, when its URL names the
 *   version read.
 *
 * @typedef {{file: File|Blob|Object} | {files: Map<string, File|Object>, rootName: string} | {url: string, name?: string, version?: string, key?: string}} DatasetSource
 */

/** A Blob's bytes in order, a piece at a time (`Blob.stream()`, read without async iteration, which not every engine has). */
async function* blobPieces(blob, signal) {
  const reader = blob.stream().getReader();
  try {
    for (;;) {
      throwIfAborted(signal);
      const { value, done } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * A compressed copy picked from this computer (`.h5ad.gz`,
 * `compressedFormatOfName`) as the reader opens it: decompressed once into
 * this browser's storage, as a link's is (`data/whole-download.js`), kept
 * under the picked file's identity (its name, size and modification time),
 * so picking it again opens the kept copy without decompressing, and read in
 * parts from there, every read checked against its page checksums.
 */
async function decompressedCopyOf(file, { environment, signal }) {
  const identity = { kind: 'file', name: file.name ?? '', size: file.size, lastModified: Number.isFinite(file.lastModified) ? file.lastModified : null };
  const copyOf = kept => ({ name: file.name ?? '', size: kept.file.size, identity, downloaded: kept.file, downloadedChecks: kept.checks });
  const found = await findKeptDownload(identity, file.name ?? '', environment);
  if (found !== null) return copyOf(found);
  const { pieces } = await decompressed(blobPieces(file, signal), { signal, bytes: file.size });
  return copyOf(await keepDownload(identity, pieces, { name: file.name ?? '', environment }));
}

/** The first bytes of one file when they are at hand without a request. */
async function headOf(file) {
  if (typeof Blob !== 'undefined' && file instanceof Blob) {
    if (file.size === 0) return new Uint8Array(0);
    return new Uint8Array(await file.slice(0, SIGNATURE_BYTES).arrayBuffer());
  }
  if (typeof Blob !== 'undefined' && file?.downloaded instanceof Blob) return headOf(file.downloaded);
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
  const head = await headOf(file);
  const sniffed = layoutOfHead(head);
  if (sniffed === null && looksLikeWebPage(head)) {
    // A page, not data: what to do is to get the file itself, not to write
    // it again.
    const name = file.name ?? 'This file';
    throw explained(typeof file.url === 'string'
      ? `${name}: its link answered with a web page (a sign-in, preview or error page), not the file. Open the file's direct download link instead.`
      : `${name} is a web page saved under a data file's name, not the data. Download the file itself (on GitHub, its raw file) and open that.`);
  }
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
 * What opening a file expected to hold `format` reads with its root
 * (`openHdf5(reader, {load})`): its layout view's `openingPaths`, or an
 * AnnData store's (`ANNDATA_OPENING_PATHS`). Named before the file is
 * recognized, they only let those reads start with the root's own; what a
 * file holds is still recognized from its root, and each view and the
 * reader load what they read.
 *
 * @param {string|null} format
 * @returns {ReadonlyArray<string|{path: string, depth: number}>}
 */
function openingPathsOf(format) {
  return LAYOUT_VIEWS[format]?.openingPaths ?? ANNDATA_OPENING_PATHS;
}

/**
 * Whether a root bears any mark of an AnnData store: a declared encoding
 * (anndata 0.8 and later), or obs, var or X (an older anndata's layout,
 * `older-layouts.js`). A root with none is no AnnData store at all.
 */
function hasAnnDataMarks(root) {
  return attributeValue(root, 'encoding-type') !== undefined || ['obs', 'var', 'X'].some(key => root.has(key));
}

/**
 * Present one opened container as an AnnData store root: the first format of
 * that container and layout (in registry order) whose layout view
 * recognizes the root presents it through its view; a root no view
 * recognizes is the one format of that container and layout read as stored
 * (AnnData: `h5ad`, `zarr`) when it bears an AnnData store's marks
 * (`hasAnnDataMarks`), and is refused as none of the formats otherwise. A
 * view's refusal is explained as the format the view presents.
 *
 * @param {Object} root - The container's root group (`openHdf5`, `openZarr`)
 * @param {{container: string, layout: 'file'|'zip'|'folder', name: string, signal?: AbortSignal|null,
 *   activity?: Object|null, fromLink?: boolean, files?: Map<string, File>, base?: string}} context - `files`
 *   and `base`: a folder format's files and the folder of the file opened (`views/index.js`);
 *   `fromLink`: opened from a link, which a view's refusal advises for; `signal` and `activity`: the
 *   opening's, for what recognizing and presenting the root loads
 * @param {{formats?: ReadonlyArray<Object>, views?: Readonly<Record<string, Object>>}} [tables] -
 *   The registry and the views (the module's own by default)
 * @returns {Promise<{format: string, root: Object, readerFormat: import('./elements.js').AnnDataFormat}>}
 */
export async function presentStore(root, { container, layout, name, ...context }, { formats = INPUT_FORMATS, views = LAYOUT_VIEWS } = {}) {
  const candidates = formats.filter(format => format.container === container && Object.hasOwn(format.names, layout));
  const options = { signal: context.signal ?? null, activity: context.activity ?? null };
  for (const format of candidates) {
    const view = views[format.id];
    if (view !== undefined && await view.recognize(root, options)) {
      // A view's refusal is said of the format the content is, whatever
      // the name promised (a Loom file named .h5).
      let viewed;
      try {
        viewed = await view.view(root, { name, layout, signal: null, activity: null, ...context });
      } catch (error) {
        throw explainFormatError(error, format.id);
      }
      if (typeof root.close === 'function' && typeof viewed?.close !== 'function') {
        throw new TypeError(`The ${format.id} layout view must close the store it presents.`);
      }
      return { format: format.id, root: viewed, readerFormat: view.readerFormat };
    }
  }
  const stored = candidates.find(format => views[format.id] === undefined && format.access !== 'stream');
  if (stored === undefined || !hasAnnDataMarks(root)) {
    // Nothing of any format this container holds: said so, not read as
    // AnnData to be refused for a part an AnnData store would have (no
    // embedding, no obs).
    const kind = container === 'hdf5' ? 'an HDF5 file' : 'a Zarr store';
    throw explained(
      `${name} is ${kind}, but not in any format Cellucid reads from one ` +
      `(${candidates.map(format => format.label).join(', ')}): it has no obs, var or X, nor the parts the others are recognized by.`
    );
  }
  return { format: stored.id, root, readerFormat: container === 'hdf5' ? H5AD_FORMAT : ZARR_FORMAT };
}

/**
 * What a folder of files is: every file's identity by its path (a picked
 * folder's files by name, size and modification time; a served folder's
 * remote files by theirs).
 */
function folderIdentity(files) {
  return {
    files: [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([filePath, file]) => (
      typeof Blob !== 'undefined' && file instanceof Blob
        ? { kind: 'file', name: filePath, size: file.size, lastModified: Number.isFinite(file.lastModified) ? file.lastModified : null }
        : { ...(file?.identity ?? { kind: 'url', url: file?.url ?? null, size: file?.size ?? null }), name: filePath }
    )),
  };
}

/**
 * Before anything kept of a source is used, what this browser keeps of
 * other versions of its remote files is stale: every kept kind of them
 * (`transcode/space.js` `forgetOtherVersions`: converted stores, downloads,
 * downloaded parts, gene index runs) and the page's memory of their bytes
 * (`range-cache.js`). Each remote file's version is the one its host or
 * provider stated for this opening (`data/sources`); a set of files' is
 * every file's. A store folder on a web host is checked once its version
 * is read (`zarrStoreOf`).
 */
async function forgetOtherVersionsOf(source, environment) {
  const files = source?.files instanceof Map ? [...source.files.values()] : source?.file != null ? [source.file] : [];
  const remote = files.filter(file => isRemoteFile(file) && file.identity != null);
  if (remote.length === 0) return;
  for (const file of remote) forgetOtherVersionsInMemory(file);
  const identities = remote.map(file => file.identity);
  if (source.files instanceof Map) identities.push(folderIdentity(source.files));
  await Promise.all(identities.map(identity => forgetOtherVersions(identity, environment)));
}

/** Open a Zarr store of one layout: its store, name, link and identity. */
async function zarrStoreOf(source, layout, { onTransfer, sourceAccess, signal, activity, keeping, resumed = null }) {
  if (layout === 'folder' && source.files instanceof Map) {
    const name = source.rootName;
    // A picked folder is files on this machine's disk, read with a local
    // file's policy. Its reads measure its link: the shortest read is what
    // one more read costs, and the fastest its bandwidth, so ranges a read
    // apart are joined as a web host's are (`batchedRanges`). A local
    // file's link is read ahead whatever one read measures
    // (`LinkMeter.readsAhead`): a read's time is the file system's cost of
    // opening it plus however long the reader thread is busy before it
    // takes the bytes, a lower bound of the disk's speed.
    const link = new LinkMeter(LOCAL_POLICY);
    try {
      return { store: directoryStore(source.files, { name, link }), name, link, identity: folderIdentity(source.files) };
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
    const reader = readerOf(source.file, { onTransfer, sourceAccess, keeping, resumed });
    const archive = await openZipArchive(reader, { name, signal, activity });
    return { store: zipStore(archive, { name }), name, link: reader.link, identity: reader.identity };
  }
  const name = source.name ?? source.url;
  // A public S3 folder's other addresses: six more connections each.
  const mirrors = equivalentS3Urls(source.url);
  // A host's request budget prices each request too, once it binds (`hosts.js` `requestCostMs`).
  const link = new LinkMeter({ ...REMOTE_POLICY, concurrency: REMOTE_POLICY.concurrency * (1 + mirrors.length) },
    { requestCost: () => realmHosts.requestCostMs(source.url) });
  link.watchProtocol(new URL(source.url).href);
  // A folder on a web host is known by its address (its link without
  // credentials) and, across openings, only by a version that names its
  // content (`source.version`: the commit its provider reads it at). Its
  // consolidated metadata's validators say when the metadata was written,
  // not that every object is as it was (an object can be rewritten under
  // the same metadata), so a folder with no content name keeps nothing
  // across openings: correctness first. Under a content name its objects
  // are kept in this browser (`kept-parts.js`), each with the validator its
  // host answered it with, and what is kept of other versions is stale.
  // Its address: its provider's key when its link names the version read
  // (a GitHub folder read at a commit), else its link.
  const address = typeof source.key === 'string' && source.key !== '' ? source.key : `zarr:${linkIdentity(new URL(source.url).href)}`;
  const identity = typeof source.version === 'string' && source.version !== ''
    ? Object.freeze({ kind: 'remote', key: address, version: source.version })
    : null;
  const folderKeeping = keeping === null || identity === null || source.keptParts === false ? null : {
    // What names the store's content: its objects' prefix in the page's memory too.
    version: identity.version,
    open: async () => {
      await forgetOtherVersions(identity, keeping.environment);
      return keptPartsOf({ url: source.url, size: null, name, identity }, keeping);
    },
  };
  // Every request measures the link and is counted for the Transfers
  // log (`{url, bytes, requests, ms}` running totals keyed by the folder).
  const store = httpStore(source.url, { name, concurrency: link, onTransfer, mirrors, keeping: folderKeeping });
  reportArrivals(link, source.url, onTransfer);
  return { store, name, link, identity: () => identity ?? ({ kind: 'url', url: new URL(source.url).href, version: store.version?.() ?? null }) };
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
 * @param {{decodedChunkCacheBytes: number|(() => number), onTransfer?: Function, signal?: AbortSignal|null,
 *   activity?: import('../../formats/io/activity.js').ReadActivity|null, sourceAccess?: Function|null}} options
 *   `activity` counts every read of opening (the file's whole structure).
 *   `sourceAccess(descriptor)`: the byte source access of a remote file that
 *   names one (`{provider, ref}`: a sign-in or an expiring link).
 *   `transcoding`: what a single-stream format's transcoder may use
 *   (`transcode/`): `createActivity` (its pass as an activity of its own),
 *   `choose({question, options})` (the person picks among the objects one
 *   file holds; resolves to an index), `onStore({directory, state})` (where
 *   its store is kept, `writing` then `complete`), `onWholeRead(read)` (the
 *   file is read whole, or what an earlier read kept is opened:
 *   `transcode/session.js`).
 * @returns {Promise<OpenedStore>}
 */
/**
 * The root a transcoder's store is read through (`transcode/`): its Zarr
 * group, presented as MuData when the transcoder wrote an object of several
 * assays in MuData's layout (`views/modalities.js`). Also the store a
 * matrix read after its map becomes (`anndata-reader-worker.js`).
 *
 * @param {Object} store
 * @param {{name: string, layout: string, signal?: AbortSignal|null, activity?: Object|null, decodedBudget: DecodedBudget}} options
 * @returns {Promise<{root: Object, zarrVersion: number|null}>}
 */
export async function openTranscodedStore(store, { name, layout, signal = null, activity = null, decodedBudget }) {
  const stored = await openZarr(store, { signal, activity, decodedChunkCacheBytes: decodedBudget });
  const muData = LAYOUT_VIEWS['mudata-zarr'];
  const root = await muData.recognize(stored, { signal, activity }) ? await muData.view(stored, { name, layout, signal, activity }) : stored;
  return { root, zarrVersion: stored.zarrFormat ?? null };
}

export async function openDatasetStore({ source, expect = null, fromLink = false }, { decodedChunkCacheBytes, onTransfer = null, signal = null, activity = null, sourceAccess = null, transcoding = {}, confirmVersion = false }) {
  let format = expect?.format ?? null;
  // One budget for every cache of the store's decoded chunks: its own, and
  // the reader's kept across a growth (`OpenedStore.decodedBudget`).
  const decodedBudget = new DecodedBudget(decodedChunkCacheBytes);
  try {
    let file = source?.file ?? null;
    if (file !== null && !isRemoteFile(file) && file?.size === 0) {
      // Empty, or no longer readable: a browser that lost a picked file (it
      // was moved or changed, or the browser's copy of it failed) answers 0
      // bytes too, and reading it then fails. Said as what it is.
      const unreadable = typeof file.arrayBuffer === 'function'
        ? await file.arrayBuffer().then(() => null, error => error)
        : null;
      if (unreadable !== null) {
        throw explained(
          `The selected file ${file.name ?? ''} can no longer be read by this browser (it was moved or changed since it was chosen, or the browser lost it). Choose it again.`,
          unreadable
        );
      }
      throw explained((expect?.format ?? fileFormatOfName(file.name ?? '')?.format) === 'h5ad'
        ? 'The selected H5AD file is empty. Choose an AnnData .h5ad file or regenerate it with AnnData.'
        : `The selected file ${file.name ?? ''} is empty. Choose an AnnData file or store, or write it again with AnnData.`);
    }
    const environment = transcoding.environment ?? globalThis;
    // A compressed copy picked from this computer is read from its
    // decompressed copy (a link's is decompressed as it downloads).
    if (file !== null && typeof Blob !== 'undefined' && file instanceof Blob && fileFormatOfName(file.name ?? '')?.compression !== undefined) {
      file = await decompressedCopyOf(file, { environment, signal });
      source = { ...source, file };
    }
    const { layout, container, expected } = await identify(source, expect);
    format = expected;
    // What a remote file's reads fetch is kept in this browser
    // (`kept-parts.js`), held by the page for its tab's life.
    const keeping = { environment, tab: transcoding.tab ?? THIS_TAB, onStore: transcoding.onStore ?? null };
    // Opened again from an earlier opening's description: every remote file
    // of it is asked for its version before anything kept of it -- parts,
    // gene indexes, a converted store, a download -- is used.
    const resumed = confirmVersion ? await confirmSourceVersions(source, { sourceAccess, environment, signal }) : null;
    await forgetOtherVersionsOf(source, environment);
    const transcoder = expected === null ? undefined : TRANSCODERS[expected];
    if (transcoder !== undefined) {
      // A file read whole to be converted: its converted store is what is
      // kept of it, not its parts.
      const byteReaderOf = item => readerOf(item, { onTransfer, sourceAccess, resumed });
      const transcoded = await transcoder.transcode(source, { ...transcoding, format: expected, signal, activity, onTransfer, byteReaderOf, expect, fromLink });
      const { root, zarrVersion } = await openTranscodedStore(transcoded.store, { name: transcoded.name, layout, signal, activity, decodedBudget });
      return {
        root, format: expected, layout, readerFormat: ZARR_FORMAT, zarrVersion,
        name: transcoded.name, link: transcoded.link, identity: null, conversion: transcoded.conversion, decodedBudget,
        // A matrix read after its map (`transcode/matrix-market.js`): the
        // reader worker reads its share and swaps onto the store it makes.
        matrixStream: transcoded.matrixStream ?? null,
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
      const reader = readerOf(matrix.file, { onTransfer, sourceAccess, keeping, resumed });
      const root = await openHdf5(reader, { signal, activity, decodedChunkCacheBytes: decodedBudget, load: openingPathsOf(expected) });
      const opened = await presentStore(root, {
        container: 'hdf5', layout, name, signal, activity, fromLink, files: source.files, base: matrix.base,
        readerOf: file => readerOf(file, { onTransfer, sourceAccess, keeping, resumed }),
      });
      format = opened.format;
      // The folder is every file it holds (the analysis files beside the matrix too).
      return { root: opened.root, format: opened.format, layout, readerFormat: opened.readerFormat, zarrVersion: null, name, link: reader.link, identity: folderIdentity(source.files), decodedBudget };
    }
    if (container === 'hdf5') {
      const reader = readerOf(file, { onTransfer, sourceAccess, keeping, resumed });
      const root = await openHdf5(reader, { signal, activity, decodedChunkCacheBytes: decodedBudget, load: openingPathsOf(expected) });
      const opened = await presentStore(root, { container: 'hdf5', layout, name: file.name, signal, activity, fromLink });
      format = opened.format;
      return { root: opened.root, format: opened.format, layout, readerFormat: opened.readerFormat, zarrVersion: null, name: file.name, link: reader.link, identity: reader.identity, decodedBudget };
    }
    const { store, name, link, identity: identityOf } = await zarrStoreOf(source, layout, { onTransfer, sourceAccess, signal, activity, keeping, resumed });
    const root = await openZarr(store, { signal, activity, decodedChunkCacheBytes: decodedBudget });
    const identity = typeof identityOf === 'function' ? identityOf() : identityOf;
    if (!isGroup(root)) {
      throw explained(`${name} is a single Zarr array, not an AnnData store (a group with obs, var and X).`);
    }
    const opened = await presentStore(root, { container: 'zarr', layout, name, signal, activity, fromLink });
    format = opened.format;
    // A store folder on a web host: its version as opened, and whether it
    // is still that version (`httpStore`), so reading it again with other
    // cells takes over what was opened only while it is unchanged.
    const folder = typeof store.unchanged === 'function'
      ? Object.freeze({ url: store.url, version: store.version(), unchanged: options => store.unchanged(options) })
      : null;
    return { root: opened.root, format: opened.format, layout, readerFormat: opened.readerFormat, zarrVersion: root.zarrFormat ?? null, name, link, identity, folder, decodedBudget };
  } catch (error) {
    throw explainFormatError(error, format);
  }
}
