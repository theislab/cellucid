/**
 * @fileoverview The AnnData reader worker: it owns one `AnnDataReader`
 * (`anndata/reader.js`) over one opened store and answers the calls
 * `AnnDataReaderClient` makes on the main thread. Every file read, every
 * decompression and every gene index runs here, so the page never blocks on
 * a file.
 *
 * Protocol (every request carries a numeric `id`, echoed in its reply):
 * - `{id, method: 'open', args: [{source, expect, fromLink, cellSubset, resumed?}]}` opens a dataset
 *   (`resumed`: again, from the description of an earlier opening, after the
 *   page ended its reader: the source is asked for its version before
 *   anything kept of it is used, `kept-parts.js` `confirmFileVersion`)
 *   (`openDatasetStore` in `anndata/open.js`): `source` is one file
 *   `{file}` (a `File` or a remote file `{url, size, name, identity}`), a
 *   picked folder `{files: Map<path, File>, rootName}` (or remote files that
 *   make one dataset, `Map<path, {url, size, name}>`) or a store folder on
 *   a web host `{url, name}`; `expect` (or null) is what the caller was told
 *   it is (`{format, layout}`). What it is is decided from its content.
 *   `fromLink` says it was opened from a link (else from this computer), so
 *   a refusal's advice is what can be done from there. `cellSubset` is
 *   which cells to open (`anndata/subsample-plan.js`; null: every cell);
 *   the reply's `cellSubset` says which were (`AnnDataReader.cellSubset`).
 *   Opening the source already open again (other cells of it: the page's
 *   `AnnDataReaderClient.reopenCells`) reads through the store it holds and
 *   takes over what the open reader built that the new cells keep (gene
 *   indexes of the rows both share, row pointers); a cancel stops it and
 *   leaves the open dataset as it was. Such a reading sends no source:
 *   `{heldSource: true, reopen: true, ...}` reads again the source this
 *   worker holds (a picked file is never copied to it twice). The
 *   reply is the reader's snapshot (`nObs`, `nVars`, `obsKeys`,
 *   `hasExpressionMatrix`, `isOpen`) with `name`, `format` (the input format
 *   id, `data/input-formats.js`), `layout`, `zarrVersion`, `conversion`
 *   (where a format read once is kept, and what was not read; null
 *   otherwise) and `requestConcurrency`.
 * - `{id, method: 'describe', args: [{source, expect}]}` reads what a catalog
 *   lists about one store (`describeAnnDataStore`) without opening it as the
 *   dataset: `{nObs, nVars, hasExpressionMatrix, title, cellucid}`.
 * - `{id, method: 'latentOutlierQuantiles', args: [key, width, fields,
 *   minPoints]}` computes the latent-space outlier quantiles of several
 *   categorical fields (`fields`: `[{codes, nCategories}]`) here, in the same
 *   passes over `obsm[key]` streamed from the file (`latent-outliers-stream.js`);
 *   `readStoredOutlierQuantiles` reads the ones a file stores for one field;
 *   `describeLatentOutliers` says what computing them costs (whether the
 *   latent space is kept already, its stored and value bytes).
 * - `{id, method: 'readEmbedding', args: [key, columns, normalize, rows?]}`
 *   answers one embedding's display coordinates, its display transform and
 *   bounds; `{id, method: 'readVectorField', args: [key, columns, {key,
 *   columns}, normalize, rows?]}` a vector field scaled by that embedding's
 *   transform, with its largest magnitude (`embedding-payload.js`). `rows`
 *   (`[start, end)` of the open cells) reads only those cells: what an
 *   opening grown in place appends, in the frame its cells are shown in.
 *   `{id, method: 'readCellOrderDigest', args: [key, columns]}` answers the
 *   embedding's cell-order digest over the open cells (`cell-order-digest.js`).
 * - `getConnectivityEdges` answers a graph's edges as their forward
 *   adjacency with render strengths (`ConnectivityEdges`,
 *   `connectivity-edges.js`), its arrays transferred;
 *   `getConnectivityRows(key, cells)` some open cells' neighbors read from
 *   the file by row (the k-NN tool's frontier).
 * - `getObsField` answers a categorical field with its codes already narrowed
 *   to the storage the page keeps (`narrowCategoricalCodes`), and a text or
 *   boolean column coded by the reader as one (`discovered`: under the
 *   categories the page names, with any label the cells add); with `rows`,
 *   only those open cells' values.
 * - `getMatrixColumn` / `getMatrixColumns` answer dense float32 gene columns
 *   (with `rows`, on open cells `[start, end)` only, reading what those
 *   cells need: `AnnDataReader.getMatrixColumn`), each as `{column, form}`:
 *   `form` its sparse form when smaller (`column-forms.js`, made here in one
 *   pass, so the page colors a gene from its entries instead of a pass over
 *   every cell), else null;
 *   asked `progressive`, a gene of a matrix indexed in segments is posted
 *   first on the cells read so far (`{event: 'partial', id, position,
 *   column, cells}`: its sparse form when smaller, with the cells from
 *   `cells` on not read, else the column, NaN there), each time it has more;
 *   `getMatrixColumnsSparse` their non-zero entries (`{length, indices,
 *   values}`), `getMatrixCellSubset` some genes in some cells as a gene-major
 *   block (read by cell or by gene, whichever costs the run less: `runGenes`,
 *   the genes its run has still to read of those cells).
 * - Gene routes (`gene-delivery.js`): `openRoute(id, ports)` takes an
 *   analysis run's ports, one per analysis worker (transferred);
 *   `replaceRoutePort(id, worker, port, generation)` the port of a worker
 *   the pool replaced; `closeRoute(id)` lets them go.
 *   `deliverColumns(element, genes, owner, delivery)` reads genes' non-zero
 *   entries and posts them to the workers the delivery names (each run of
 *   the genes to its worker, or each worker its range of cells);
 *   `deliverCellSubset(element, cells,
 *   genes, owner, delivery, runGenes)` reads a cell subset and posts each run of genes
 *   to its worker. Each answers only the bytes it sent (`{bytes}`, one
 *   number per gene for columns): the genes never reach the page.
 * - `{id, method: 'readCopyTarget', args: [names, owner, varModality, colors]}` answers
 *   what a copy is planned against (`anndata/write/copy-target.js`): the
 *   stored obs columns, the values of those `names` lists over every cell
 *   by original position, the var columns a copy's var changes go to, the
 *   root `uns` keys, the colors of the columns `colors` lists
 *   (`uns['<column>_colors']`), and `uns['cellucid']`.
 * - `{id, method: 'writeAnnDataCopy', args: [changes, owner, dataset]}` writes a copy of
 *   the whole dataset (every cell, whichever are open) as a Cellucid-ready
 *   AnnData `.zarr.zip` (`anndata/write/copy.js`, `changes` its
 *   `CopyChanges`): its bytes go to the page in batches,
 *   `{event: 'partial', id, copy, parts}` (`parts` transferred), each
 *   answered `{copyWritten: copy}` once the page wrote it, or
 *   `{copyWritten: copy, error}` (the copy then fails); at most a few
 *   batches are unanswered at once (`anndata/write/acknowledged-sink.js`).
 *   How far it is is its read activity's (`{event: 'activity'}`, kind
 *   `cells`, of the job `owner`: values copied of all). The reply
 *   (`{bytes, entries, zip64, chunks, layout, nObs, priorityOrder, notes}`)
 *   comes once the page has written every byte.
 * - `{id, method, args}` for every other reader method; the reply is
 *   `{id, result}` with typed arrays transferred, or `{id, error}`. Every
 *   typed array of a reply owns its whole buffer (a view is copied out
 *   first), so nothing is cloned on the way. An array that cannot move by
 *   transfer (larger than the engine's `ArrayBuffer` cap, so held in a
 *   WebAssembly memory: `utils/large-arrays.js`) is posted in pieces before
 *   the reply, `{event: 'piece', id, array, type, length, offset, values}`
 *   (`values` transferred, at most `ARRAY_PIECE_BYTES`), and the reply
 *   carries `{arrayPieces: array}` in its place; the client assembles it.
 *   Embedding coordinates and vector fields are posted the same way as each
 *   piece of at most `COORDINATE_PIECE_CELLS` cells is made
 *   (`embedding-payload.js`), so the worker never holds them whole.
 * - `{cancel: id}` cancels request `id`: its reads stop (a request the
 *   network has not sent is never sent), it stops waiting for shared work (a
 *   gene index other reads still need goes on), and it replies with an
 *   `AbortError`. Nothing replies to the cancel itself.
 * - `{hostRequesterPort}` (a `MessagePort`, before any request) is how a
 *   notebook widget's viewer reads its host: requests to
 *   `EMBEDDED_HOST_ORIGIN` go through the page (`formats/io/host-fetch.js`).
 *   Nothing replies to it.
 * - `{event: 'link', latencyMs, loadedLatencyMs, bytesPerMs, backgroundConcurrency, protocol}`
 *   whenever the measured link of the open dataset changes
 *   (`linkMeasurementOf`: a local source reports latency 0 and its decode
 *   rate); the client keeps the latest (`linkMeasurement()`).
 * - Events: `{event: 'transfer', url, bytes, reads, ms}` with a remote file's running
 *   totals, `{event: 'transfer', url, arriving: true}` while bytes of a
 *   request still under way arrive (at most every 250 ms), and
 *   `{event: 'transfer', url, retrying}` when a request is made again after
 *   a transient failure (`retrying` says why, naming the request's URL),
 *   `{event: 'transfer', url, waiting}` while a request waits for a wait its
 *   host named (a sentence; null once it ends); `{event: 'activity', ...}` for every read operation (what it
 *   reads, requests, bytes fetched, chunks decoded, progress, outcome), live
 *   while it runs (at most every `ACTIVITY_INTERVAL_MS`) and once when it ends.
 *
 * - A single-stream file (an R object, a MatrixMarket folder) is read once
 *   into a store kept for the tab's life (`anndata/transcode/`):
 *   `{event: 'transcoded', directory, state}` says where (`writing` when
 *   the pass starts, `complete` when its store is whole, `replaced` when a
 *   newer one took its place: a larger matrix share), so the page keeps a
 *   complete store, removes an unfinished one and lets a replaced one go
 *   (`space.js` `letGoTranscodedStore`); the page answers a
 *   complete one with `{storeHeld: directory}` once it holds it, and a gene
 *   index run kept in this browser (`anndata/kept-column-index.js`) keeps
 *   the worker's hold until then. A file holding several
 *   objects asks the page which to open with `{event: 'choose', request,
 *   question, options}`, answered `{choice: request, index}` or
 *   `{choice: request, error}`.
 * - A remote file behind a sign-in or an expiring link (Google Drive,
 *   OneDrive) names its access, `{provider, ref, stale, changed, unreadable,
 *   limited, versioned}` (`sources/access.js`); the page owns it.
 *   The worker asks the page for the URL and headers to read from with
 *   `{event: 'source-access', request, provider, ref, refresh}` and is
 *   answered `{sourceAccess: request, target}` (`{url, headers?, expiresAt?}`)
 *   or `{sourceAccess: request, error}`. A read that gets no answer from
 *   a file whose access names `unreadable` asks the page whether the
 *   provider confirms it, `{event: 'source-unreadable', request, provider,
 *   ref}`, answered `{sourceUnreadable: request, unreadable}` (a boolean).
 *   What is kept of a file whose access is `versioned` is filed under its
 *   version once the page confirms the version still holds,
 *   `{event: 'source-version', request, provider, ref}`, answered
 *   `{sourceVersion: request, holds}` (a boolean).
 *   `{sourceAccessRevoked: ref}` (a
 *   sign-out) drops the target it holds. Targets live in this worker's memory
 *   only and are never posted back, logged or put in an error.
 * - `{flushKeptParts: true}` (the page was hidden) has every write of what
 *   the readers keep of their files made and held by the disk (each piece
 *   is kept as it arrives); `{leave: true}` (the reader closed, or the page
 *   left) stops every read, does the same, answers `{event: 'left'}` and
 *   ends the worker.
 * - Memory (`memory-budget.js`): the page's state comes first,
 *   `{memoryState}` (the device, the allowance, the working set), and again
 *   whenever it changes; the worker evaluates its budgets from it and trims
 *   its caches to them (gene indexes and row pointers, the latent hold,
 *   decoded chunks, decode workers). `{memoryRelease: level}` gives back a
 *   level of caches (another dataset opens, the page is hidden). The worker
 *   reports `{event: 'memory', held}` (what its caches keep, by share) after
 *   its requests, and at once an allocation it was refused (`refused`) or,
 *   while a refusal holds, granted (`granted`), and what it let go
 *   (`released`, `reason`).
 *
 * Errors cross as plain records (`utils/error-wire.js` `toWire`) and are
 * rebuilt with their class, kind, code and cause on the main thread.
 *
 * @module data/anndata-reader-worker
 */

import { AnnDataReader, describeAnnDataStore } from './anndata/reader.js';
import { keptAbout } from './anndata/transcode/space.js';
import { createOpaqueId } from '../utils/opaque-id.js';
import { linkIdentity } from './sources/link-credentials.js';
import { explainFormatError, openDatasetStore, openTranscodedStore } from './anndata/open.js';
import { folderFormatOfName } from './input-formats.js';
import { requestOfOpenCells } from './cell-subset-policy.js';
import { STREAM_PIECE_BYTES } from '../formats/rds/stream.js';
import { ReadActivity } from '../formats/io/activity.js';
import { adoptHostRequesterPort } from '../formats/io/host-fetch.js';
import { realmHosts } from '../formats/io/hosts.js';
import { adoptRangeCachePort, endRangeCachePort, rangeCacheChannel, rangeCacheKey } from '../formats/io/range-cache.js';
import { flushKeptParts } from '../formats/io/kept-parts.js';
import { LatentOutlierReader } from './latent-outliers-stream.js';
import { writeAnnDataCopy } from './anndata/write/copy.js';
import { readCopyTarget } from './anndata/write/copy-target.js';
import { COPY_BATCH_BYTES, COPY_WINDOW_BYTES, createAcknowledgedSink } from './anndata/write/acknowledged-sink.js';
import { WHOLE_CHUNK } from './anndata/write/layout.js';
import { SLAB_BYTES } from './anndata/values.js';
import { encodeInFlight, poolEncoder } from './anndata/write/pool-encoder.js';
import { noteMemoryChanged, receiveMemoryMessage, registerResidentHolder, residencyBudgetBytes, setMemoryReporter, setWorkingSet } from './memory-budget.js';
import { configureDecodePool, decodePoolStats, decodeWorkersHeldBytes, trimDecodeWorkers, warmDecodePool } from '../formats/io/decode-pool.js';
import { heldDecodedBytes, trimDecodedChunks } from '../formats/io/decoded-budget.js';
import { configureByteReaders, heldReaderBytes, trimReaderBytes } from '../formats/io/byte-reader.js';
import { narrowCategoricalCodes } from './categorical-storage-contract.js';
import { sparseFormOf } from './column-forms.js';
import { PieceSender, canTransfer, isMemoryBacked, placeArrays } from '../utils/large-arrays.js';
import {
  requireColumnDelivery,
  requireRunDelivery,
  splitColumnsByCellRanges,
  subsetRun,
} from './gene-delivery.js';
import { abortReason, awaitWithSignal, cancel, cancelled, isCancellation } from '../utils/abort.js';
import { toWire } from '../utils/error-wire.js';

/** How often a running activity is reported, at most. */
const ACTIVITY_INTERVAL_MS = 250;

/** The error the page answered a source access request with, as a plain record. */
function accessError(record) {
  const error = new Error(typeof record?.message === 'string' ? record.message : 'The file could not be accessed.');
  if (typeof record?.name === 'string') error.name = record.name;
  if (record?.code !== undefined) error.code = record.code;
  if (typeof record?.sourceType === 'string') error.source = record.sourceType;
  if (record?.details !== undefined) error.details = record.details;
  return error;
}

/** A gene column as the page is handed it: with its sparse form when that is smaller (`column-forms.js`). */
function withForm(column) {
  return { column, form: sparseFormOf(column) };
}

/**
 * A gene on the cells read so far (`cells`; NaN after them) as the page is
 * handed it, which only colors it: its sparse form when smaller (a gene's
 * entries, the cells after `cells` not read), else the column.
 */
function partialColumn(values, cells) {
  return sparseFormOf(values, cells) ?? values;
}

/**
 * `value` with every typed array owning its whole buffer: a view of part of
 * a buffer is copied out (posting the view would clone its whole buffer), so
 * every array of a reply crosses by transfer. Records are copied with their
 * property descriptors, so a lazy getter is never run.
 */
export function ownedBuffers(value, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 4) return value;
  if (ArrayBuffer.isView(value)) {
    // A memory's array crosses in pieces (`placeArrays`), never copied whole.
    if (isMemoryBacked(value)) return value;
    const whole = value.byteOffset === 0 && value.byteLength === value.buffer.byteLength;
    return whole || value instanceof DataView || !(value.buffer instanceof ArrayBuffer) ? value : value.slice();
  }
  if (Array.isArray(value)) {
    if (value.length === 0 || value[0] === null || typeof value[0] !== 'object') return value;
    let changed = false;
    const items = value.map(item => {
      const owned = ownedBuffers(item, depth + 1);
      if (owned !== item) changed = true;
      return owned;
    });
    return changed ? items : value;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  let copy = null;
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!('value' in descriptor)) continue;
    const owned = ownedBuffers(descriptor.value, depth + 1);
    if (owned !== descriptor.value) {
      copy ??= Object.defineProperties({}, Object.getOwnPropertyDescriptors(value));
      Object.defineProperty(copy, key, { ...descriptor, value: owned });
    }
  }
  return copy ?? value;
}

/** Collect the ArrayBuffers of the typed arrays in one result, for transfer. */
function transferables(value, into = new Set(), depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 4) return into;
  if (ArrayBuffer.isView(value)) {
    if (canTransfer(value)) into.add(value.buffer);
    return into;
  }
  if (Array.isArray(value)) {
    // A batch of columns or rows has its typed arrays transferred; an array
    // of plain values (strings, numbers) has nothing to transfer.
    if (value.length > 0 && value[0] !== null && typeof value[0] === 'object') {
      for (const item of value) transferables(item, into, depth + 1);
    }
    return into;
  }
  for (const key of Object.keys(value)) transferables(value[key], into, depth + 1);
  return into;
}

function snapshotOf(reader) {
  return {
    nObs: reader.nObs,
    nVars: reader.nVars,
    obsKeys: reader.obsKeys,
    // What opening left out of the dataset, and why (a column it cannot read).
    notes: [...reader.notes],
    hasExpressionMatrix: reader.hasExpressionMatrix,
    isOpen: reader.isOpen,
  };
}

/**
 * The cells the open dataset presents (`AnnDataReader.cellSubset`), as the
 * reply carries it: the kept positions copied, since a reply's arrays are
 * transferred and the reader keeps its own.
 */
function cellSubsetOf(reader) {
  const subset = reader.cellSubset;
  if (subset === null) return null;
  return {
    ...subset,
    kept: subset.kept === null ? null : subset.kept.slice(),
    openOrder: subset.openOrder === null ? null : subset.openOrder.slice(),
  };
}

/**
 * How many reads of a source run at once without queueing behind each other:
 * a local file (a `File`, a picked folder, a ZIP) has no host connections to
 * share, a remote one its link's background concurrency
 * (`formats/io/link.js`).
 */
function requestConcurrencyOf(source, link) {
  if (!isRemoteSource(source)) return Infinity;
  const snapshot = link?.snapshot?.() ?? null;
  return snapshot?.backgroundConcurrency ?? snapshot?.concurrency ?? Infinity;
}

/** Whether a source is read from a host: a remote file, a folder on a web host, or remote files of one dataset. */
function isRemoteSource(source) {
  if (source?.files instanceof Map) return typeof source.files.values().next().value?.url === 'string';
  return typeof source?.url === 'string' || typeof source?.file?.url === 'string';
}

/**
 * What identifies the bytes of a source, so that opening it again (another
 * cell subset) reuses its opened store: a local file by its name, size and
 * modification time; a remote file by its identity (key and the version its
 * host reported) or its URL, size and `ETag` (`rangeCacheKey`); a set of
 * files (a picked folder: a Zarr store, a Cell Ranger `outs/` or
 * MatrixMarket folder; files of one dataset) by every file's path and key,
 * so a file added, removed or rewritten is another source. Null for a
 * source whose bytes cannot be told apart from a later version (a remote
 * file known only by its size, or a set holding one): those are opened
 * anew. A store folder on a web host has no key before it is opened: read
 * again with other cells, it is taken over while its metadata's validator
 * is unchanged (`open`, `httpStore.unchanged`).
 */
export function sourceKey(source) {
  if (source?.files instanceof Map) {
    if (source.files.size === 0) return null;
    const keys = [];
    for (const path of [...source.files.keys()].sort()) {
      const key = sourceKey({ file: source.files.get(path) });
      if (key === null) return null;
      keys.push([path, key]);
    }
    return JSON.stringify(['files', source.rootName ?? '', keys]);
  }
  // A store folder on a web host read at a version naming its content (a
  // GitHub folder at a commit, `source.version`): the same bytes for the
  // same address and version, whatever its host lets the page see of its
  // metadata's validators (GitHub exposes none). A folder by its name (a
  // single file at a version is not one).
  if (typeof source?.url === 'string' && source.file === undefined && typeof source.version === 'string' && source.version !== '' &&
    folderFormatOfName(source.name ?? new URL(source.url).pathname.split('/').filter(Boolean).at(-1) ?? '') !== null) {
    const address = typeof source.key === 'string' && source.key !== '' ? source.key : linkIdentity(folderUrlOf(source) ?? source.url);
    return JSON.stringify(['folder', address, source.version]);
  }
  const file = source?.file ?? null;
  if (typeof Blob !== 'undefined' && file instanceof Blob) {
    return Number.isFinite(file.lastModified) ? JSON.stringify(['file', file.name ?? '', file.size, file.lastModified]) : null;
  }
  if (file !== null && typeof file === 'object' && typeof file.url === 'string' && Number.isSafeInteger(file.size)) {
    // Named exactly as the page keeps its bytes (`formats/io/range-cache.js`):
    // a file known only by its size may change under it, and is opened anew.
    return rangeCacheKey(file);
  }
  return null;
}

/**
 * What a source whose version cannot be told (`sourceKey` null: a remote
 * file known by its size alone, files of one dataset with one such) is
 * within one opening (`keptTab`, the opening's own name, kept by its
 * readings again with other cells): its address and size. Null for a
 * store folder on a web host (taken over while its metadata is unchanged)
 * and a local file.
 */
function openingSourceKey(source, opening) {
  const fileOf = file => (file !== null && typeof file === 'object' && typeof file.url === 'string' && Number.isSafeInteger(file.size)
    ? [linkIdentity(file.url), file.size]
    : null);
  if (source?.files instanceof Map) {
    const files = [...source.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, file]) => [path, fileOf(file)]);
    return files.length > 0 && files.every(([, file]) => file !== null) ? JSON.stringify(['opening', opening, source.rootName ?? '', files]) : null;
  }
  const file = fileOf(source?.file ?? null);
  return file === null ? null : JSON.stringify(['opening', opening, file]);
}

/**
 * The cells an opening reads (its request `cellSubset`) once its source is
 * opened. A progressive opening grows in place: each step reads the same
 * bytes again (`open`, `reuse`: a source by its key, a store folder by its
 * version). A source no later reading can tell to be the same bytes (a
 * store folder whose host names no version, `key` null) would read each
 * step anew, other cells than those shown, and its growth stop at the
 * first view: it opens every cell asked for at once.
 *
 * @param {Object|null} cellSubset - the request (`progressive`: a first view may be planned)
 * @param {{key: string|null, folder: {version: string|null}|null}} source - `sourceKey`/`openingSourceKey`, and `open`'s folder
 * @returns {Object|null}
 */
export function cellsToOpen(cellSubset, { key, folder }) {
  if (cellSubset?.progressive == null || key !== null || (folder !== null && folder.version !== null)) return cellSubset;
  const { progressive: _planned, ...atOnce } = cellSubset;
  return atOnce;
}

/** A store folder source's URL as its store names it (ending in `/`), or null. */
function folderUrlOf(source) {
  if (typeof source?.url !== 'string' || source.file !== undefined) return null;
  try {
    const url = new URL(source.url);
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.href;
  } catch {
    return null;
  }
}

/**
 * What a source is, for the Session panel's list of what is kept in this
 * browser (`space.js` `keptAbout`): its file or folder name and its host
 * (none for a file on this computer), never a link.
 */
function keptAboutOf(source, name) {
  const url = source?.files instanceof Map
    ? source.files.values().next().value?.url
    : source?.file?.url ?? source?.url;
  return keptAbout({ name: source?.file?.name ?? source?.rootName ?? source?.name ?? name, url: typeof url === 'string' ? url : null });
}

/** The name a source is shown by: its file name, folder or URL. */
function sourceName(source) {
  return source?.file?.name ?? source?.name ?? source?.rootName ?? source?.url ?? 'the file';
}

/**
 * Activities whose updates are posted: live, at most every
 * `ACTIVITY_INTERVAL_MS` while running, and always when they end. A change
 * made within the interval is posted when it is over, so the last bytes
 * counted are shown even when nothing changes after them (a whole read that
 * arrives at once and is then parsed, a read waiting on a held request).
 */
export function activityReporter(post, onReport = () => {}) {
  /** @type {Map<number, {at: number, timer: ReturnType<typeof setTimeout>|null}>} */
  const posted = new Map();
  const send = activity => {
    post({ event: 'activity', ...activity.snapshot() });
    onReport();
  };
  return ({ kind, label, owner = null, keys = null, background = false }) => new ReadActivity({
    kind,
    label,
    owner,
    keys,
    background,
    onUpdate: activity => {
      const now = performance.now();
      const last = posted.get(activity.id) ?? null;
      if (activity.status !== 'running') {
        if (last?.timer != null) clearTimeout(last.timer);
        posted.delete(activity.id);
        send(activity);
        return;
      }
      if (last !== null && now - last.at < ACTIVITY_INTERVAL_MS) {
        last.timer ??= setTimeout(() => {
          last.timer = null;
          if (activity.status !== 'running' || posted.get(activity.id) !== last) return;
          last.at = performance.now();
          send(activity);
        }, ACTIVITY_INTERVAL_MS - (now - last.at));
        return;
      }
      if (last?.timer != null) clearTimeout(last.timer);
      posted.set(activity.id, { at: now, timer: null });
      send(activity);
    },
  });
}

/**
 * The link the open dataset is read over, as plain data:
 * `{latencyMs, loadedLatencyMs, bytesPerMs, backgroundConcurrency, protocol}`
 * (`loadedLatencyMs`: its round trip under load, what reads are priced at,
 * `loadedRoundTripMs`). A remote source reports its measured link
 * (`formats/io/link.js`); a local one (a
 * `File`, a picked folder, a local `.zarr.zip`) has no round trip, so its
 * latency is 0 and its rate is how fast its chunks decode
 * (`decodePoolStats().decodedBytesPerMs`). Null until measured.
 */
export function linkMeasurementOf(source, link) {
  if (!isRemoteSource(source)) {
    const bytesPerMs = decodePoolStats().decodedBytesPerMs ?? null;
    return bytesPerMs === null ? null : { latencyMs: 0, bytesPerMs, backgroundConcurrency: requestConcurrencyOf(source, link), protocol: null };
  }
  const snapshot = link?.snapshot?.() ?? null;
  if (snapshot === null || (snapshot.latencyMs === null && snapshot.bytesPerMs === null)) return null;
  return {
    latencyMs: snapshot.latencyMs,
    loadedLatencyMs: snapshot.loadedLatencyMs ?? null,
    bytesPerMs: snapshot.bytesPerMs,
    backgroundConcurrency: snapshot.backgroundConcurrency,
    protocol: snapshot.protocol,
    deliveredBytes: snapshot.deliveredBytes ?? null,
    busyMs: snapshot.busyMs ?? null,
  };
}

/**
 * Create the message handler of one reader worker.
 *
 * @param {Object} [options]
 * @param {(message: Object, transfer?: ArrayBuffer[]) => void} [options.post] - Posts events (the buffers of `transfer` moved with them)
 * @returns {(message: Object) => Promise<{reply: Object, transfer: ArrayBuffer[]}|null>}
 *   The reply to post, or null for a cancel message
 */
export function createAnnDataReaderHandler({ post = () => {} } = {}) {
  /** The open dataset's source and link, whose measurement is posted as it changes. */
  let measured = null;
  let lastMeasurement = null;
  /** Post `{event: 'link', ...}` when the open dataset's link measurement changed. */
  const postLink = () => {
    if (measured === null) return;
    const measurement = linkMeasurementOf(measured.source, measured.link);
    if (measurement === null) return;
    if (lastMeasurement !== null &&
        Object.keys(measurement).every(key => Object.is(measurement[key], lastMeasurement[key]))) return;
    lastMeasurement = measurement;
    post({ event: 'link', ...measurement });
  };
  const createActivity = activityReporter(post, postLink);

  // The access of each remote file that names one, by its page-side `ref`.
  const accesses = new Map();
  const accessRequests = new Map();
  let nextAccessRequest = 1;
  const sourceAccess = descriptor => {
    const ref = descriptor?.ref;
    if (typeof ref !== 'string' || ref === '' || typeof descriptor.provider !== 'string') {
      throw new TypeError('A remote file access names its provider and ref.');
    }
    const stale = new Set(Array.isArray(descriptor.stale) ? descriptor.stale : []);
    const changed = new Set(Array.isArray(descriptor.changed) ? descriptor.changed : []);
    let access = accesses.get(ref);
    if (access === undefined) {
      access = {
        generation: 0,
        isStale: status => stale.has(status),
        isChanged: status => changed.has(status),
        unreadable: typeof descriptor.unreadable === 'string' ? descriptor.unreadable : null,
        limited: typeof descriptor.limited === 'string' ? descriptor.limited : null,
        target: ({ refresh }) => new Promise((resolve, reject) => {
          const request = nextAccessRequest++;
          accessRequests.set(request, { resolve, reject });
          post({ event: 'source-access', request, provider: descriptor.provider, ref, refresh });
        }),
        confirmUnreadable: () => new Promise((resolve, reject) => {
          const request = nextAccessRequest++;
          accessRequests.set(request, { resolve, reject });
          post({ event: 'source-unreadable', request, provider: descriptor.provider, ref });
        }),
        confirmVersion: descriptor.versioned === true ? () => new Promise((resolve, reject) => {
          const request = nextAccessRequest++;
          accessRequests.set(request, { resolve, reject });
          post({ event: 'source-version', request, provider: descriptor.provider, ref });
        }) : null,
      };
      accesses.set(ref, access);
    }
    return access;
  };
  // The page's answers to `choose` events, by request.
  const choices = new Map();
  /** Copies being written (`writeAnnDataCopy`), by ticket: what the page's `{copyWritten}` answers. */
  const copies = new Map();
  let nextCopy = 1;
  let nextChoice = 1;
  /** Complete kept directories the page is to hold, by name: what resolves when it says it does (`{storeHeld}`). */
  const heldByPage = new Map();
  /**
   * Whether the worker is leaving (`{leave}`): the page has let it go and
   * answers it no more, so nothing it keeps waits for the page's hold.
   */
  let leaving = false;
  /** This reader's channel to the page's range cache (`rangeCacheChannel`), ended as it leaves. */
  let ownRangeChannel = null;
  const transcoding = {
    createActivity,
    onStore: ({ directory, state }) => {
      post({ event: 'transcoded', directory, state });
      if (state !== 'complete' || leaving) return undefined;
      return new Promise(resolve => heldByPage.set(directory, resolve));
    },
    // Said up front: the file cannot be read in parts (`data/whole-read-notice.js`).
    onWholeRead: read => post({ event: 'whole-read', ...read }),
    choose: ({ question, options }) => new Promise((resolve, reject) => {
      const request = nextChoice++;
      choices.set(request, { resolve, reject });
      post({ event: 'choose', request, question, options });
    }),
  };
  let reader = null;
  let latent = null;
  /**
   * The open dataset's gene indexes (with the row pointers they are built
   * from) and latent hold, counted by the memory model (`memory-budget.js`)
   * while a dataset is open, and trimmed by it: stops counting them.
   * @type {(() => void)|null}
   */
  let stopCounting = null;
  const countHeld = () => {
    if (stopCounting !== null) return;
    const stops = [
      registerResidentHolder('columnIndex', {
        label: 'gene indexes',
        bytes: () => reader?.residentBytes() ?? 0,
        trim: budget => reader?.trimResident(budget) ?? [],
      }),
      registerResidentHolder('latentHold', {
        label: 'a latent space',
        bytes: () => latent?.heldBytes ?? 0,
        trim: budget => {
          if ((latent?.heldBytes ?? 0) <= budget) return null;
          latent.clear();
          return 'a latent space kept for outlier quantiles';
        },
      }),
    ];
    stopCounting = () => {
      for (const stop of stops) stop();
      stopCounting = null;
    };
  };
  /** The input format id of the open dataset, for the messages of its later reads. */
  let format = null;
  /**
   * The opened store of the open dataset and what identifies its bytes
   * (`sourceKey`): opening the same bytes again (another cell subset of
   * them) reads them through the same store, whose structure, chunk indexes,
   * cached metadata and decoded chunks, and measured link stay; only the
   * cells change. `{key, opened}`, or null.
   */
  let held = null;
  /** The source of the dataset open in this worker, read again with other cells (`open`, `heldSource`). */
  let openSource = null;
  /**
   * The matrix of the open dataset when it is read after its map
   * (`anndata/transcode/matrix-market.js`): its stream, the opening it
   * belongs to (`opened`, whose `heldRows` are what its store holds), the
   * stop of the passes it runs, and the swap under way (`swapping`). A pass
   * keeps the matrix rows of more cells; once it is kept, the open cells
   * are opened again on the store it makes (`swapOntoShare`) and the page
   * is told (`{event: 'genes-arrived', sample}`), which then reads its
   * genes. Null otherwise.
   * @type {{stream: Object, opened: Object, stop: AbortController, hostLink: Object|null, swapping: Object|null}|null}
   */
  let matrixShare = null;
  /**
   * Let go of the shares a larger one replaced (`MatrixStream.letGo`), once
   * nothing reads them: no opening in flight (it may read the store it
   * found), and the open dataset reads the newest share or none.
   */
  const letGoReplacedShares = () => {
    const share = matrixShare;
    if (share === null || newestOpening !== null || reader === null) return;
    const rows = share.opened.heldRows;
    if (rows === 0 || rows === share.stream.held) share.stream.letGo();
  };
  const stopMatrixShare = kind => {
    if (matrixShare === null) return;
    cancel(matrixShare.stop, kind, 'The matrix of the dataset is no longer read.');
    // Its readers are closed: what was replaced is read no more.
    matrixShare.stream.letGo();
    matrixShare = null;
  };
  /**
   * The rows a store a matrix stream made holds, for the reader
   * (`AnnDataReader.open`'s `held`): null when every one does.
   */
  const heldRowsOf = (stream, rows) => (stream == null || rows >= stream.nObs
    ? null
    : { rows, fitCells: stream.fitCells, bytes: stream.bytes });
  /** An opening of a store whose matrix is read after its map, with the rows its store holds now (`heldRows`). */
  const withHeldRows = opened => (opened.matrixStream == null ? opened : { ...opened, heldRows: opened.matrixStream.held });
  /**
   * The open cells read again on the store the stream holds now: the same
   * cells in the same order (`requestOfOpenCells`), genes read for as far
   * as the store holds, the reader before it let go. The page is told.
   * One swap serves every caller asking while it runs; it reads only
   * what this browser keeps, under the share's own stop (a caller that
   * stops waiting leaves it to the others). Resolves to whether the open
   * dataset reads that store now.
   */
  const swapOntoShare = async (share, signal) => {
    const store = share.stream.store();
    const rows = share.stream.held;
    const previous = reader;
    if (share.swapping === null || share.swapping.previous !== previous || share.swapping.store !== store) {
      const done = swapOnto(share, previous, store, rows);
      share.swapping = { previous, store, done };
      done.then(() => {
        if (share.swapping?.done === done) share.swapping = null;
      }, () => {
        if (share.swapping?.done === done) share.swapping = null;
      });
    }
    return awaitWithSignal(share.swapping.done, signal);
  };
  const swapOnto = async (share, previous, store, rows) => {
    const opened = share.opened;
    const signal = share.stop.signal;
    const activity = createActivity({ kind: 'open', label: `the genes of ${opened.name}` });
    try {
      const { root } = await openTranscodedStore(store, { name: opened.name, layout: opened.layout, signal, activity, decodedBudget: opened.decodedBudget });
      const { genes: _sameGenes, ...cells } = requestOfOpenCells(cellSubsetOf(previous));
      const next = new AnnDataReader();
      next.createActivity = createActivity;
      await next.open(root, {
        format: opened.readerFormat,
        name: opened.name,
        decodedChunkBytes: residencyBudgetBytes('decodedBlocks'),
        decodedBudget: opened.decodedBudget,
        link: opened.link,
        activity,
        cellSubset: cells,
        held: heldRowsOf(share.stream, rows),
        hostLink: share.hostLink,
        signal,
      });
      if (reader !== previous || matrixShare !== share) {
        // Another opening came meanwhile: it reads the store as it is now.
        next.close();
        activity.finish();
        return false;
      }
      share.opened = { ...opened, root, heldRows: rows };
      if (held?.opened === opened) held = { ...held, opened: share.opened };
      reader = next;
      latent = new LatentOutlierReader(next);
      previous.releaseStore();
      previous.close();
      activity.finish();
      post({ event: 'genes-arrived', sample: next.geneSample, cellSubset: cellSubsetOf(next) });
      letGoReplacedShares();
      return true;
    } catch (error) {
      activity.finish(error);
      throw error;
    }
  };
  /**
   * Keep the matrix rows of the first `genes` open cells (null: the share
   * sized to this device, `fitCells`, of the cells a progressive opening
   * grows to: `AnnDataReader.shareRows`), one pass over the matrix when the
   * stream does not hold them (`MatrixStream.ensure`: a pass under way
   * serves this call too), then read them (`swapOntoShare`). Resolves to
   * whether the open dataset reads more rows now.
   */
  const ensureMatrixShare = async (genes, { signal = null } = {}) => {
    const share = matrixShare;
    if (share === null || reader === null) return false;
    const rows = genes === null ? reader.shareRows(share.stream.fitCells) : reader.rowsForOpenCells(genes);
    if (reader.heldRows >= rows) return false;
    const stop = signal === null ? share.stop.signal : AbortSignal.any([signal, share.stop.signal]);
    if (share.stream.held < rows) {
      // Said as a pass begins (not by a call the pass under way serves):
      // for how many cells, how many bytes. How far it is is its
      // activity's (`createActivity`, the read activity log).
      if (share.stream.reading < rows) {
        const cells = genes === null ? Math.min(share.stream.fitCells, reader.cellSubset?.growth?.target ?? reader.nObs) : Math.min(reader.nObs, genes);
        post({ event: 'genes-arriving', cells, bytes: share.stream.bytes, of: share.stream.nObs });
      }
      await share.stream.ensure(rows, { signal: stop });
      if (matrixShare !== share) return false;
    }
    return swapOntoShare(share, stop);
  };
  /**
   * Before a read of the genes of `element`: when it is the matrix read
   * after its map and the open dataset holds the matrix rows of no open cell
   * yet (the map's X has no entry: every gene would answer "not read" on
   * every cell), the read waits for the pass the opening began
   * (`ensureMatrixShare`, the share sized to this device; a progressive
   * step's opening goes on with it) and reads from the reader it swaps onto
   * (each handler takes `reader` after this). A gene asked for meanwhile is
   * thus read with its values, never refused as having none. A modality's
   * matrix is read with its map; `signal` stops this wait only, never the
   * pass, which others share.
   */
  const awaitHeldGenes = async (element, signal) => {
    while (matrixShare !== null && reader !== null && !String(element).startsWith('mod/') && reader.heldOpenCells() === 0) {
      if (!(await ensureMatrixShare(null, { signal }))) return;
    }
  };
  /**
   * The newest opening asked for: only it may become the open dataset. A
   * newer one stops it (its reads end), and one that completes all the same
   * (a read that did not stop) is closed, never kept.
   * @type {{stop: AbortController}|null}
   */
  let newestOpening = null;
  /**
   * Whom what is kept for this opening only belongs to (`space.js`: a store
   * of a file whose version cannot be told, a converted store or gene index
   * runs, names it): the open dataset's opening, and its readings again
   * with other cells (`reopen`); a later opening of the file, in this tab
   * too, reads it again, as its source may have changed.
   */
  let openingTab = null;

  /**
   * The open gene routes, by id: each analysis worker's port and its
   * generation (`gene-delivery.js`).
   * @type {Map<string, {ports: MessagePort[], generations: number[]}>}
   */
  const routes = new Map();
  const requireRoute = id => {
    const route = routes.get(id);
    if (route === undefined) throw new Error(`No gene route '${String(id)}' is open in the reader.`);
    return route;
  };
  /**
   * Post `message` to one worker of a route, its arrays transferred, when
   * the worker's port is still of `generation` (a replaced worker's genes
   * are read again by its run).
   */
  const deliverTo = (route, worker, generation, message) => {
    if (worker >= route.ports.length) throw new RangeError(`A gene route has no worker ${worker}.`);
    if (route.generations[worker] !== generation) return;
    const owned = ownedBuffers(message);
    route.ports[worker].postMessage(owned, [...transferables(owned)]);
  };

  // Every method takes the request's context (`signal`, aborted by a cancel
  // message) first, then the arguments the client sent.
  const methods = {
    async open({ signal: requestSignal }, { source: sent = null, heldSource = false, expect = null, fromLink = false, cellSubset = null, tab = null, reopen = false, hostLink = null, resumed = false }) {
      // Read again with other cells (`AnnDataReaderClient.reopenCells`): the
      // source is the one this worker holds, not a copy of it sent again. A
      // file picked from this computer, copied to this worker a second
      // time, read as empty in Linux WebKit ("WebKit encountered an internal
      // error", Web contracts run 41269083996), where the copy it holds read
      // on.
      if (heldSource && (!reopen || openSource === null)) {
        throw new Error('The reader holds no dataset to read again with other cells.');
      }
      const source = heldSource ? openSource : sent;
      // Only the newest opening is kept: one asked for before it stops now.
      const opening = { stop: new AbortController() };
      newestOpening?.stop.abort(cancelled('superseded', 'A newer opening of the dataset superseded this one.'));
      newestOpening = opening;
      const signal = requestSignal == null ? opening.stop.signal : AbortSignal.any([requestSignal, opening.stop.signal]);
      // What is kept of a file with no version is this opening's (and its readings again with other cells).
      const keptTab = reopen && openingTab !== null ? openingTab : `${tab ?? 'tab'}:${createOpaqueId()}`;
      // A host found to bear only a pace on an earlier visit is sent no
      // faster from the first request (`hosts.js` `seedPace`).
      if (hostLink?.paceMs > 0) realmHosts.seedPace(hostLink.origin, hostLink.paceMs);
      // Decode workers start while the structure is read, not on the first chunk.
      warmDecodePool();
      // One activity for the whole opening: the file's structure, then the
      // AnnData elements the first view needs.
      const activity = createActivity({ kind: 'open', label: `the structure of ${sourceName(source)}` });
      let opened;
      let next = new AnnDataReader();
      // A file whose version cannot be told is the same bytes only within
      // the opening that read it (its readings again with other cells: a
      // growth step, Apply): its store is taken over then, never by a later
      // opening (`openingSourceKey`).
      const key = sourceKey(source) ?? openingSourceKey(source, keptTab);
      // The same bytes: a file by its key; a store folder on a web host read
      // again with other cells by its URL, while its version is unchanged
      // (one `HEAD` of its metadata, `httpStore`).
      const sameFolder = key === null && reopen && reader !== null && held !== null && held.folder !== null &&
        held.folder.url === folderUrlOf(source) && held.folder.version !== null;
      // The folder's version is asked beside the step's own reads, not
      // before them: a growth step waited one round trip for it, in series,
      // at each step (F170, about 4% of an opening on 3G). The step reads
      // through the held store meanwhile and is kept only once the folder is
      // known unchanged; found changed, it stops at once, is discarded (the
      // open dataset keeps its reader and store) and the folder is opened
      // anew. So nothing read of a changed folder is ever shown, as when the
      // check came first: a change before the check's answer is seen by it,
      // one after it would have been missed by the check made first too.
      const folderUnchanged = sameFolder
        ? held.folder.unchanged({ signal }).catch(error => {
          // A version that cannot be asked again is not known to be the same.
          if (signal?.aborted) throw error;
          return false;
        })
        : null;
      const changed = new AbortController();
      folderUnchanged?.then(same => {
        if (!same) changed.abort(cancelled('superseded', 'The store folder changed on its host: it is opened anew.'));
      }, () => {});
      let reuse = reader !== null && held !== null && (key !== null ? held.key === key : sameFolder);
      // A remote source's running totals carry how many requests its link
      // answers at once now, which the page's download scheduler follows.
      let link = null;
      const onTransfer = ({ url, bytes, requests, ms, arriving = false, retrying = null, waiting }) => {
        if (waiting !== undefined) {
          post({ event: 'transfer', url, waiting });
          return;
        }
        post(arriving || retrying !== null
          ? { event: 'transfer', url, arriving, retrying }
          : { event: 'transfer', url, bytes, reads: requests, ms, requestConcurrency: requestConcurrencyOf(source, link) });
        if (!arriving && retrying === null) postLink();
      };
      try {
        // At most twice: a step taken over from a store folder found changed
        // meanwhile is opened once more, anew.
        for (;;) {
          // The step taken over from a folder stops once the folder is found changed.
          const stepSignal = reuse && folderUnchanged !== null ? AbortSignal.any([signal, changed.signal]) : signal;
          opened = reuse ? held.opened : withHeldRows(await openDatasetStore({ source, expect, fromLink }, {
            // The share as it is whenever a chunk is kept (it follows the allowance).
            decodedChunkCacheBytes: () => residencyBudgetBytes('decodedBlocks'),
            onTransfer,
            activity,
            sourceAccess,
            // Opened again from its first opening's description (the reader
            // was ended): its source is asked for its version first.
            confirmVersion: resumed,
            transcoding: { ...transcoding, tab: keptTab },
            signal,
          }));
          link = opened.link ?? null;
          // From here on, the link this dataset is read over is reported as it
          // is measured (`{event: 'link'}`), unless a newer opening came.
          if (newestOpening === opening) {
            measured = { source, link };
            lastMeasurement = null;
            postLink();
          }
          next.createActivity = createActivity;
          try {
            await next.open(opened.root, {
              format: opened.readerFormat,
              name: opened.name,
              decodedChunkBytes: residencyBudgetBytes('decodedBlocks'),
              // The chunks a growth keeps share the store's decoded-chunk budget.
              decodedBudget: opened.decodedBudget,
              link: opened.link,
              activity,
              cellSubset: cellsToOpen(cellSubset, { key, folder: opened.folder ?? null }),
              // The same bytes opened again with other cells: what the open
              // reader read that the new cells keep is taken over, not read
              // again (`AnnDataReader.open`, `carry`).
              carry: reuse ? reader : null,
              // Gene indexes of cell-major matrices kept in this browser, under
              // what the bytes are (`anndata/kept-column-index.js`); the page
              // holds what is kept for the tab's life, as a transcoded store.
              keptIndexes: opened.identity == null ? null : { identity: opened.identity, about: keptAboutOf(source, opened.name), tab: keptTab, onStore: transcoding.onStore },
              // What the host delivered on earlier visits (`host-link-memory.js`): sizing's link until this one measures more.
              hostLink,
              // A matrix read after its map: the rows its store holds (the
              // stream's may hold more by now: a swap reads them).
              held: heldRowsOf(opened.matrixStream, opened.heldRows),
              // Opened to be drawn: nothing to draw is refused at once.
              drawn: true,
              signal: stepSignal,
            });
          } catch (error) {
            // A reused store stays the open dataset's.
            if (!reuse) opened.root.close?.();
            // A step taken over from a folder that failed or stopped is
            // judged once the folder's version is known: read from a changed
            // folder (other bytes, a failure they caused), it is opened anew.
            if (stepSignal !== signal && !signal.aborted && !(await folderUnchanged)) {
              next.releaseStore();
              next.close();
              next = new AnnDataReader();
              reuse = false;
              continue;
            }
            throw explainFormatError(error, opened.format);
          }
          // Taken over from a folder: kept only once it is known unchanged.
          if (stepSignal !== signal && !(await folderUnchanged)) {
            next.releaseStore();
            next.close();
            next = new AnnDataReader();
            reuse = false;
            continue;
          }
          break;
        }
        if (newestOpening !== opening || signal.aborted) {
          // Canceled or superseded, yet completed (a read that did not
          // stop): closed, never kept; a store the open dataset reads
          // through stays its.
          if (reuse) next.releaseStore();
          next.close();
          throw abortReason(signal);
        }
        activity.finish();
      } catch (error) {
        activity.finish(error);
        throw error;
      } finally {
        if (newestOpening === opening) newestOpening = null;
      }
      const previous = reader;
      reader = next;
      openingTab = keptTab;
      format = opened.format;
      latent = new LatentOutlierReader(next);
      countHeld();
      // The store goes on to the new reader: the previous one lets it go
      // without closing it.
      if (reuse) previous.releaseStore();
      previous?.close();
      held = key !== null || opened.folder != null ? { key, folder: opened.folder ?? null, opened } : null;
      openSource = source;
      // A matrix read after its map: the share sized to this device is read
      // now, in the background, for the cells a progressive opening grows
      // to (`AnnDataReader.shareRows`): its steps, readings again of the
      // same bytes, go on with the pass under way or read the share kept.
      if (opened.matrixStream == null) {
        stopMatrixShare('superseded');
      } else {
        if (matrixShare?.stream !== opened.matrixStream) {
          stopMatrixShare('superseded');
          matrixShare = { stream: opened.matrixStream, opened, stop: new AbortController(), hostLink, swapping: null };
        }
        letGoReplacedShares();
        ensureMatrixShare(null).catch(error => {
          if (!isCancellation(error)) post({ event: 'genes-arrived', error: toWire(error) });
        });
      }
      // What the store was read as (the Dataset box names it): its format,
      // layout and, for Zarr, the version; for a format read once, where it
      // is kept and what was not read.
      return {
        ...snapshotOf(reader),
        name: opened.name,
        format: opened.format,
        layout: opened.layout,
        zarrVersion: opened.zarrVersion,
        conversion: opened.conversion ?? null,
        requestConcurrency: requestConcurrencyOf(source, link),
        cellSubset: cellSubsetOf(reader),
        // Whether this reading took over the store of the reading before it:
        // the same version of the same bytes, so the cells both show may stay
        // shown (`AnnDataFileSource.reopenCells`). Otherwise what is shown is
        // read anew.
        sameVersion: reuse,
      };
    },
    /**
     * What a catalog lists about one store (`describeAnnDataStore`): its
     * metadata and `uns` only. The store is closed again; the open dataset,
     * if any, is untouched.
     */
    async describe({ signal }, { source, expect = null, tab = null }) {
      // A catalog's files are on a web host: its refusals advise as a link's.
      const opened = await openDatasetStore({ source, expect, fromLink: true }, {
        decodedChunkCacheBytes: 0,
        sourceAccess,
        onTransfer: ({ url, bytes, requests, ms, arriving = false, retrying = null, waiting }) => post(
          waiting !== undefined
            ? { event: 'transfer', url, waiting }
            : arriving || retrying !== null
              ? { event: 'transfer', url, arriving, retrying }
              : { event: 'transfer', url, bytes, reads: requests, ms }),
        signal,
        // A catalog listing has no one to ask: a file of several objects is
        // described by its first, and kept for the opening that follows.
        transcoding: { onStore: transcoding.onStore, onWholeRead: transcoding.onWholeRead, tab, choose: () => Promise.resolve(0) },
      });
      try {
        return await describeAnnDataStore(opened.root, { format: opened.readerFormat }, { signal });
      } catch (error) {
        throw explainFormatError(error, opened.format);
      } finally {
        opened.root.close?.();
      }
    },
    probeMapping: options => reader.probeMapping(options),
    // How the open subsample represents a categorical field (null at every cell).
    subsampleRepresentation: (_context, key) => reader.subsampleRepresentation(key),
    // How much of a neighbor graph read the subsample keeps (null before it is read).
    subsampleGraphShare: (_context, key) => reader.subsampleGraphShare(key),
    // Display coordinates and bound vectors, checked and scaled here
    // (`embedding-payload.js`): the page draws them as they arrive.
    readEmbedding: ({ signal, pieces }, key, columns, normalize, rows = null) => reader.readEmbedding(key, columns, normalize, { signal, rows, pieces }),
    readVectorField: ({ signal, pieces }, key, columns, embedding, normalize, rows = null) =>
      reader.readVectorField(key, columns, embedding, normalize, { signal, rows, pieces }),
    // The cell-order digest a session records (`cell-order-digest.js`):
    // summed as the embedding was read, the rows not read yet read now.
    readCellOrderDigest: ({ signal }, key, columns) => reader.readCellOrderDigest(key, columns, { signal }),
    latentOutlierQuantiles: ({ signal }, key, width, fields, minPoints) =>
      latent.quantiles(key, width, fields, minPoints, { signal }),
    readStoredOutlierQuantiles: ({ signal }, fieldKey) => reader.readStoredOutlierQuantiles(fieldKey, { signal }),
    storedOutlierQuantilesBytes: ({ signal }, fieldKey) => reader.storedOutlierQuantilesBytes(fieldKey, { signal }),
    async describeLatentOutliers({ signal }, key, width) {
      const held = latent.holds(key, width);
      const cost = held ? { storedBytes: null, valueBytes: null } : await reader.obsmReadCost(key, { signal });
      return { held, kept: held || latent.wouldHold(width), ...cost };
    },
    readVarNames: (_context, axis, column) => reader.readVarNames(axis, column),
    readObsNames: (_context, rows = null, cells = null) => reader.readObsNames({ rows, cells }),
    readObsmColumns: ({ signal }, key, columns, rows = null, cells = null) => reader.readObsmColumns(key, columns, { signal, rows, cells, reason: 'export' }),
    readVarFlags: (_context, axis, column) => reader.readVarFlags(axis, column),
    geneReadPlan: (_context, element) => reader.geneReadPlan(element),
    geneSampleNow: () => reader.geneSample,
    geneSampleOf: (_context, element) => reader.geneSampleOf(element),
    // Past what a matrix read after its map holds: a pass over the matrix
    // (its bytes, at the link's rate as measured); none when the stream
    // holds those rows already (a swap onto its store reads nothing).
    geneSampleCost: async (_context, element, target, options = {}) => {
      const cost = await reader.geneSampleCost(element, target, options);
      if (cost === null || matrixShare === null || reader.heldOpenCells() >= Math.min(target, reader.nObs) ||
        matrixShare.stream.held >= reader.rowsForOpenCells(target)) return cost;
      const bytes = matrixShare.stream.bytes;
      const rate = linkMeasurementOf(measured?.source ?? null, matrixShare.opened.link)?.bytesPerMs ?? null;
      return { ...cost, bytes, keptBytes: 0, requests: Math.ceil(bytes / STREAM_PIECE_BYTES), ms: rate > 0 ? bytes / rate : null };
    },
    // Each segment built posts the gene sample now (`{event: 'partial', id, sample, cells}`);
    // past what a matrix read after its map holds, a pass keeps more of it first.
    growGeneSample: async ({ signal, partial }, element, target, gene = 0, topUp = false) => {
      if (matrixShare !== null && reader.heldOpenCells() < Math.min(target, reader.nObs) && await ensureMatrixShare(target, { signal })) {
        partial({ sample: reader.geneSample, cells: reader.geneSample?.cells ?? reader.nObs });
      }
      return reader.growGeneSample(element, target, { signal, gene, topUp, onStep: (sample, cells) => partial({ sample, cells }) });
    },
    // Each column with its sparse form (`{column, form}`). `progressive`: the
    // gene is posted on more cells as its index is built, the cells read so
    // far as a column, sparse when smaller (`{event: 'partial', id, position,
    // column, cells}`), before the reply. `rows`: only open cells
    // `[start, end)` of each gene.
    getMatrixColumn: async ({ signal, partial }, element, index, owner = null, keys = null, progressive = false, rows = null) =>
      withForm(await awaitHeldGenes(element, signal).then(() => reader.getMatrixColumn(element, index, {
        signal,
        owner,
        keys,
        rows,
        onPartial: progressive ? (values, cells) => partial({ position: 0, column: partialColumn(values, cells), cells }) : null,
      }))),
    getMatrixColumns: async ({ signal, partial }, element, genes, owner = null, keys = null, progressive = false, rows = null) =>
      (await awaitHeldGenes(element, signal).then(() => reader.getMatrixColumns(element, genes, {
        signal,
        owner,
        keys,
        rows,
        onPartial: progressive ? (position, values, cells) => partial({ position, column: partialColumn(values, cells), cells }) : null,
      }))).map(withForm),
    getMatrixColumnsSparse: async ({ signal }, element, genes, owner = null) => {
      await awaitHeldGenes(element, signal);
      return reader.getMatrixColumnsSparse(element, genes, { signal, owner });
    },
    // Rows of many cells, part by part (`{event: 'partial', id, first, count,
    // pointers, genes, values}`, each part's arrays transferred), then
    // `{cells, entries}`.
    readMatrixRows: async ({ signal, partial }, element, cells) => {
      await awaitHeldGenes(element, signal);
      return reader.readMatrixRows(element, cells, { signal, onPart: part => partial(part) });
    },
    matrixRowsCost: (_context, element, cells) => reader.matrixRowsCost(element, cells),
    // A copy of the whole dataset as a Cellucid-ready AnnData `.zarr.zip`
    // (`anndata/write/copy.js`), its bytes posted to the page in batches the
    // page answers once written (`anndata/write/acknowledged-sink.js`:
    // `{event: 'partial', id, copy, parts}`, answered `{copyWritten: copy}`),
    // its progress its read activity's (kind `cells`, of the job `owner`);
    // the reply is the copy's result, once the page has written every byte.
    // What a copy is planned against (`anndata/write/copy-target.js`): the
    // stored obs columns, the values of those the plan reads (every cell, by
    // original position) and `uns['cellucid']`; its reads of the job `owner`.
    readCopyTarget: async ({ signal }, names = [], owner = null, varModality = null, colors = []) => {
      const activity = createActivity({ kind: 'cells', label: 'the columns a copy of the dataset changes', owner });
      try {
        const target = await readCopyTarget(reader.storedRoot(), names, { signal, activity }, { varModality, colors });
        activity.finish();
        return target;
      } catch (error) {
        activity.finish(error);
        throw error;
      }
    },
    writeAnnDataCopy: async ({ signal, partial }, changes = {}, owner = null, dataset = null) => {
      const root = reader.storedRoot();
      const ticket = nextCopy++;
      const acknowledged = createAcknowledgedSink(message => partial(message), { ticket, signal });
      copies.set(ticket, acknowledged);
      // A transposition's block (or a dense matrix's band) is a gene index of
      // the copy's own: it takes that share.
      const budgetBytes = residencyBudgetBytes('columnIndex');
      const inFlight = encodeInFlight();
      // What the copy holds while it runs, counted in the working set under a
      // part of its own: the block, two slabs (one read, the next one coming),
      // the chunks being encoded (at most `WHOLE_CHUNK` values of 8 bytes,
      // twice: values and output) and the batches posted to the page.
      const workingPart = `anndata copy ${ticket}`;
      setWorkingSet(workingPart, budgetBytes + 2 * SLAB_BYTES + inFlight * 2 * 8 * WHOLE_CHUNK + COPY_WINDOW_BYTES + COPY_BATCH_BYTES);
      // Its reads in the read activity log, as a cell export's are.
      const activity = createActivity({ kind: 'cells', label: 'a copy of the dataset', owner });
      try {
        const result = await writeAnnDataCopy(root, acknowledged.sink, {
          changes,
          dataset,
          budgetBytes,
          // Deflated on every core the decode pool runs, put in order.
          encode: poolEncoder({ signal }),
          inFlight,
          // Its progress is the activity's (values copied of all), the one channel reads are shown by.
          readOptions: { signal, activity },
        });
        await acknowledged.drain();
        activity.finish();
        return result;
      } catch (error) {
        acknowledged.release();
        activity.finish(error);
        throw error;
      } finally {
        copies.delete(ticket);
        setWorkingSet(workingPart, 0);
      }
    },
    getMatrixCellSubset: async ({ signal }, element, cells, genes, owner = null, runGenes = null) => {
      await awaitHeldGenes(element, signal);
      return reader.getMatrixCellSubset(element, cells, genes, { signal, owner, runGenes });
    },
    openRoute(_context, id, ports) {
      if (typeof id !== 'string' || id.length === 0 || routes.has(id)) {
        throw new TypeError(`A gene route needs a new id; '${String(id)}' is not one.`);
      }
      if (!Array.isArray(ports) || ports.length === 0 || ports.some(port => !(port instanceof MessagePort))) {
        throw new TypeError('A gene route takes one MessagePort per analysis worker.');
      }
      routes.set(id, { ports, generations: ports.map(() => 0) });
    },
    replaceRoutePort(_context, id, worker, port, generation) {
      const route = requireRoute(id);
      if (!(port instanceof MessagePort) || !Number.isSafeInteger(worker) || worker < 0 || worker >= route.ports.length ||
          !Number.isSafeInteger(generation) || generation <= route.generations[worker]) {
        throw new TypeError('A replaced gene route port names its worker, the port, and a newer generation.');
      }
      route.ports[worker].close();
      route.ports[worker] = port;
      route.generations[worker] = generation;
    },
    closeRoute(_context, id) {
      const route = routes.get(id);
      routes.delete(id);
      for (const port of route?.ports ?? []) port.close();
    },
    async deliverColumns({ signal }, element, genes, owner, delivery) {
      requireColumnDelivery(delivery, genes.length);
      const route = requireRoute(delivery.route);
      await awaitHeldGenes(element, signal);
      const columns = await reader.getMatrixColumnsSparse(element, genes, { signal, owner });
      const bytes = columns.map(column => column.indices.byteLength + column.values.byteLength);
      if (delivery.split === undefined) {
        for (const run of delivery.runs) {
          deliverTo(route, run.worker, run.generation, {
            id: run.id,
            generation: run.generation,
            columns: columns.slice(run.first, run.last),
          });
        }
      } else {
        if (delivery.split.length - 1 !== route.ports.length) {
          throw new RangeError('A split gene delivery names one range per worker of its route.');
        }
        splitColumnsByCellRanges(columns, delivery.split).forEach((ranges, worker) => {
          const generation = delivery.generations[worker];
          deliverTo(route, worker, generation, { id: delivery.id, generation, ranges });
        });
      }
      return { bytes };
    },
    async deliverCellSubset({ signal }, element, cells, genes, owner, delivery, runGenes = null) {
      requireRunDelivery(delivery, genes.length);
      const route = requireRoute(delivery.route);
      await awaitHeldGenes(element, signal);
      const block = await reader.getMatrixCellSubset(element, cells, genes, { signal, owner, runGenes });
      for (const run of delivery.runs) {
        deliverTo(route, run.worker, run.generation, {
          id: run.id,
          generation: run.generation,
          block: subsetRun(block, run.first, run.last),
        });
      }
      return { bytes: block.cellIndex.byteLength + block.values.byteLength };
    },
    prepareMatrix: (_context, element) => reader.prepareMatrix(element),
    getObsFieldInfo: (_context, key) => reader.getObsFieldInfo(key),
    getObsFieldKind: (_context, key) => reader.getObsFieldKind(key),
    async getObsField({ signal }, key, rows = null, categories = null, integers = 'decide') {
      const field = await reader.getObsField(key, { signal, rows, categories, integers });
      // The payload is transferred to the caller, which owns it from now on;
      // the reader keeps nothing that would be detached (a read of some rows
      // is never cached).
      if (rows === null) reader.detachObsField(key, field);
      if (field.dtype === 'categorical') {
        // Narrowed here, off the page's thread: the page keeps this array.
        // A text or boolean column arrives coded and narrowed by the reader
        // (`codeDiscoveredColumn`): only its codes cross.
        return {
          dtype: field.dtype,
          ...(field.discovered === true ? { discovered: true } : {}),
          codes: field.discovered === true
            ? field.codes
            : narrowCategoricalCodes(field.codes, field.categories.length, `Categorical observation field '${key}'`),
          categories: field.categories,
          ordered: field.ordered,
          // Integers read as their text (identifiers past 2^53): why.
          ...(field.asText === undefined ? {} : { asText: field.asText }),
          // Coded by the categories its open cells hold (`_readPresentCategorical`):
          // the dictionary's size, each category's stored position (a copy:
          // the reader keeps its own) and the file's colors of them.
          ...(field.present === undefined ? {} : { present: { count: field.present.count, stored: field.present.stored.slice(), colors: field.present.colors } }),
        };
      }
      return field;
    },
    releaseObsField: (_context, key) => reader.releaseObsField(key),
    hasConnectivities: (_context, key) => reader.hasConnectivities(key),
    getConnectivityEdges: ({ signal }, key, keys = null) => reader.getConnectivityEdges(key, { signal, keys }),
    getConnectivityRows: ({ signal }, key, cells) => reader.getConnectivityRows(key, cells, { signal }),
    getDatasetMetadata: () => reader.getDatasetMetadata(),
    clearCache() {
      latent?.clear();
      reader?.clearCache();
    },
    close() {
      const current = reader;
      stopMatrixShare('closed');
      reader = null;
      latent = null;
      held = null;
      openSource = null;
      stopCounting?.();
      current?.close();
    },
  };

  /** @type {Map<number, AbortController>} The requests under way, by id */
  const running = new Map();

  return async function handle(message) {
    if (message?.choice !== undefined) {
      const waiting = choices.get(message.choice);
      choices.delete(message.choice);
      if (waiting !== undefined) {
        if (message.error === undefined) waiting.resolve(message.index);
        else waiting.reject(accessError(message.error));
      }
      return null;
    }
    if (message?.copyWritten !== undefined) {
      copies.get(message.copyWritten)?.acknowledge(message.error === undefined ? null : accessError(message.error));
      return null;
    }
    if (message?.sourceAccess !== undefined) {
      const waiting = accessRequests.get(message.sourceAccess);
      accessRequests.delete(message.sourceAccess);
      if (waiting !== undefined) {
        if (message.error === undefined) waiting.resolve(message.target);
        else waiting.reject(accessError(message.error));
      }
      return null;
    }
    if (message?.storeHeld !== undefined) {
      heldByPage.get(message.storeHeld)?.();
      heldByPage.delete(message.storeHeld);
      return null;
    }
    if (message?.sourceUnreadable !== undefined) {
      const waiting = accessRequests.get(message.sourceUnreadable);
      accessRequests.delete(message.sourceUnreadable);
      waiting?.resolve(message.unreadable === true);
      return null;
    }
    if (message?.sourceVersion !== undefined) {
      const waiting = accessRequests.get(message.sourceVersion);
      accessRequests.delete(message.sourceVersion);
      waiting?.resolve(message.holds === true);
      return null;
    }
    if (message?.sourceAccessRevoked !== undefined) {
      const access = accesses.get(message.sourceAccessRevoked);
      if (access !== undefined) access.generation += 1;
      return null;
    }
    if (message?.cancel !== undefined) {
      running.get(message.cancel)?.abort(cancelled('superseded', 'The page no longer waits for this request.'));
      return null;
    }
    if (message?.memoryState !== undefined || message?.memoryRelease !== undefined) {
      // Taken by the worker's own message loop (`receiveMemoryMessage`); a
      // handler run in the page's thread shares the page's memory model.
      return null;
    }
    if (message?.flushKeptParts === true) {
      // The page is hidden: every write of what the readers fetched is made
      // and held by the disk now (`formats/io/kept-parts.js`; each piece is
      // kept as it arrives).
      void flushKeptParts();
      return null;
    }
    if (message?.leave === true) {
      // The reader is closed or the page left: every read stops, the writes
      // of what was fetched are made, then the worker ends itself (the page
      // does not end it from outside, which would lose the piece being written).
      leaving = true;
      for (const controller of running.values()) controller.abort(cancelled('closed', 'The reader was closed.'));
      stopMatrixShare('page-left');
      // Reads that answer no request (an index being kept on disk, a check
      // beside the reads) stop too: the reader closes its store now, which
      // stops every read made through it, not when the worker ends.
      methods.close();
      // The page told of each directory completes its own hold
      // (`holdTranscodedStore`); none is waited for here.
      for (const resolve of heldByPage.values()) resolve();
      heldByPage.clear();
      // The page closes its end of this reader's range channel once it has
      // every range the reader told it to keep (`endRangeCachePort`).
      void flushKeptParts().finally(() => {
        endRangeCachePort(ownRangeChannel);
        post({ event: 'left' });
        globalThis.close?.();
      });
      return null;
    }
    if (message?.hostRequesterPort !== undefined) {
      // The page's notebook host, reached through the page (`formats/io/host-fetch.js`).
      adoptHostRequesterPort(message.hostRequesterPort);
      return null;
    }
    if (message?.rangeCachePort !== undefined) {
      // The page's bytes of remote files (`formats/io/range-cache.js`).
      adoptRangeCachePort(message.rangeCachePort);
      ownRangeChannel = rangeCacheChannel();
      return null;
    }
    const id = message?.id;
    const controller = new AbortController();
    running.set(id, controller);
    try {
      const method = methods[message?.method];
      if (typeof method !== 'function') {
        throw new TypeError(`Unknown AnnData reader method '${String(message?.method)}'`);
      }
      if (message.method !== 'open' && message.method !== 'describe' && message.method !== 'close' &&
          message.method !== 'clearCache' && message.method !== 'closeRoute' && reader === null) {
        throw new Error('No AnnData file is open in the reader.');
      }
      // What a request posts before its reply (a gene on more cells: `partial`).
      // Arrays posted in pieces before the reply or partial answer that
      // names them (`utils/large-arrays.js`): made piece by piece
      // (`pieces`), or too large to transfer.
      const sender = new PieceSender((piece, transfer) => {
        if (!controller.signal.aborted) post({ event: 'piece', id, ...piece }, transfer);
      });
      const partial = payload => {
        if (controller.signal.aborted) return;
        const placed = placeArrays(payload, view => sender.send(view));
        post({ event: 'partial', id, ...placed }, [...transferables(placed)]);
      };
      const pieces = (ArrayType, length) => sender.begin(ArrayType, length);
      const answer = await method({ signal: controller.signal, partial, pieces }, ...(Array.isArray(message.args) ? message.args : []));
      const result = placeArrays(ownedBuffers(answer), view => sender.send(view));
      return { reply: { id, result }, transfer: [...transferables(result)] };
    } catch (error) {
      // Opening explains its own failures (`openDatasetStore`); a later
      // read is explained in the words of the format that is open.
      const shown = message?.method === 'open' || message?.method === 'describe'
        ? error
        : explainFormatError(error, format);
      return { reply: { id, error: toWire(shown) }, transfer: [] };
    } finally {
      if (running.get(id) === controller) running.delete(id);
      // What the caches keep may have changed: the page hears of it soon.
      noteMemoryChanged();
    }
  };
}

if (
  typeof self !== 'undefined' &&
  typeof self.postMessage === 'function' &&
  typeof window === 'undefined'
) {
  // This thread counts against the page's memory model: the page hands it
  // its state first (`receiveMemoryMessage`), and hears what it holds.
  setMemoryReporter(message => self.postMessage(message));
  registerResidentHolder('decodedBlocks', { label: 'decoded chunks', bytes: heldDecodedBytes, trim: trimDecodedChunks });
  registerResidentHolder('decodeWorkers', { label: 'decode workers', bytes: decodeWorkersHeldBytes, trim: trimDecodeWorkers });
  // The byte readers' kept requests, with those running reads still hold (`byte-reader.js`).
  registerResidentHolder('fetchedRanges', { label: 'fetched requests kept', bytes: heldReaderBytes, trim: trimReaderBytes });
  // What running reads hold of them, bounded by the same budget as they go.
  configureByteReaders({ holdBytes: () => residencyBudgetBytes('fetchedRanges') });
  // Decode workers are as many as the cores and their memory budget allow,
  // the budget as it is whenever one may be started.
  configureDecodePool({ memoryBytes: () => residencyBudgetBytes('decodeWorkers') });
  const handle = createAnnDataReaderHandler({
    post: (message, transfer = []) => self.postMessage(message, transfer),
  });
  // Requests interleave at the reader's await points: a field read never
  // waits for a gene index, and reads asked for together are planned
  // together by the byte reader.
  self.onmessage = async event => {
    // The page's memory state, or a release it asks for (`memory-budget.js`).
    if (receiveMemoryMessage(event.data)) return;
    const answer = await handle(event.data);
    if (answer !== null) self.postMessage(answer.reply, answer.transfer);
  };
}
