/**
 * @fileoverview The AnnData reader worker: it owns one `AnnDataReader`
 * (`anndata/reader.js`) over one opened store and answers the calls
 * `AnnDataReaderClient` makes on the main thread. Every file read, every
 * decompression and every gene index runs here, so the page never blocks on
 * a file.
 *
 * Protocol (every request carries a numeric `id`, echoed in its reply):
 * - `{id, method: 'open', args: [{source, expect, fromLink}]}` opens a dataset
 *   (`openDatasetStore` in `anndata/open.js`): `source` is one file
 *   `{file}` (a `File` or a remote file `{url, size, name, identity}`), a
 *   picked folder `{files: Map<path, File>, rootName}` (or remote files that
 *   make one dataset, `Map<path, {url, size, name}>`) or a store folder on
 *   a web host `{url, name}`; `expect` (or null) is what the caller was told
 *   it is (`{format, layout}`). What it is is decided from its content.
 *   `fromLink` says it was opened from a link (else from this computer), so
 *   a refusal's advice is what can be done from there. The
 *   reply is the reader's snapshot (`nObs`, `nVars`, `obsKeys`, `varNames`,
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
 * - `{id, method: 'readEmbedding', args: [key, columns, normalize]}` answers
 *   one embedding's display coordinates, its display transform and bounds;
 *   `{id, method: 'readVectorField', args: [key, columns, {key, columns},
 *   normalize]}` a vector field scaled by that embedding's transform, with
 *   its largest magnitude (`embedding-payload.js`).
 * - `getConnectivityEdges` answers a graph's edges, render strengths and
 *   k-NN adjacency (`ConnectivityEdges`, `connectivity-edges.js`).
 * - `getObsField` answers a categorical field with its codes already narrowed
 *   to the storage the page keeps (`narrowCategoricalCodes`).
 * - `getMatrixColumns` answers dense float32 gene columns,
 *   `getMatrixColumnsSparse` their non-zero entries (`{length, indices,
 *   values}`), `getMatrixCellSubset` some genes in some cells as a gene-major
 *   block (read by cell or by gene, whichever costs less).
 * - Gene routes (`gene-delivery.js`): `openRoute(id, ports)` takes an
 *   analysis run's ports, one per analysis worker (transferred);
 *   `replaceRoutePort(id, worker, port, generation)` the port of a worker
 *   the pool replaced; `closeRoute(id)` lets them go.
 *   `deliverColumns(element, genes, owner, delivery)` reads genes' non-zero
 *   entries and posts them to the workers the delivery names (each run of
 *   the genes to its worker, or each worker its range of cells);
 *   `deliverCellSubset(element, cells,
 *   genes, owner, delivery)` reads a cell subset and posts each run of genes
 *   to its worker. Each answers only the bytes it sent (`{bytes}`, one
 *   number per gene for columns): the genes never reach the page.
 * - `{id, method, args}` for every other reader method; the reply is
 *   `{id, result}` with typed arrays transferred, or `{id, error}`. Every
 *   typed array of a reply owns its whole buffer (a view is copied out
 *   first), so nothing is cloned on the way.
 * - `{cancel: id}` cancels request `id`: its reads stop (a request the
 *   network has not sent is never sent), it stops waiting for shared work (a
 *   gene index other reads still need goes on), and it replies with an
 *   `AbortError`. Nothing replies to the cancel itself.
 * - `{event: 'link', latencyMs, bytesPerMs, backgroundConcurrency, protocol}`
 *   whenever the measured link of the open dataset changes
 *   (`linkMeasurementOf`: a local source reports latency 0 and its decode
 *   rate); the client keeps the latest (`linkMeasurement()`).
 * - Events: `{event: 'transfer', url, bytes, reads, ms}` with a remote file's running
 *   totals, `{event: 'transfer', url, arriving: true}` while bytes of a
 *   request still under way arrive (at most every 250 ms), and
 *   `{event: 'transfer', url, retrying}` when a request is made again after
 *   a transient failure (`retrying` says why, naming the request's URL); `{event: 'activity', ...}` for every read operation (what it
 *   reads, requests, bytes fetched, chunks decoded, progress, outcome), live
 *   while it runs (at most every `ACTIVITY_INTERVAL_MS`) and once when it ends.
 *
 * - A single-stream file (an R object, a MatrixMarket folder) is read once
 *   into a store kept for the tab's life (`anndata/transcode/`):
 *   `{event: 'transcoded', directory, state}` says where (`writing` when
 *   the pass starts, `complete` when its store is whole), so the page keeps
 *   a complete store and removes an unfinished one. A file holding several
 *   objects asks the page which to open with `{event: 'choose', request,
 *   question, options}`, answered `{choice: request, index}` or
 *   `{choice: request, error}`.
 * - A remote file behind a sign-in or an expiring link (Google Drive,
 *   OneDrive) names its access, `{provider, ref, stale, unreadable}`; the
 *   page owns it.
 *   The worker asks the page for the URL and headers to read from with
 *   `{event: 'source-access', request, provider, ref, refresh}` and is
 *   answered `{sourceAccess: request, target}` (`{url, headers?, expiresAt?}`)
 *   or `{sourceAccess: request, error}`. A read that gets no answer from
 *   a file whose access names `unreadable` asks the page whether the
 *   provider confirms it, `{event: 'source-unreadable', request, provider,
 *   ref}`, answered `{sourceUnreadable: request, unreadable}` (a boolean).
 *   `{sourceAccessRevoked: ref}` (a
 *   sign-out) drops the target it holds. Targets live in this worker's memory
 *   only and are never posted back, logged or put in an error.
 *
 * Errors cross as plain records (`serializeReaderError`) and are rebuilt
 * with their original class, code and cause on the main thread.
 *
 * @module data/anndata-reader-worker
 */

import { AnnDataReader, describeAnnDataStore } from './anndata/reader.js';
import { explainFormatError, openDatasetStore } from './anndata/open.js';
import { ReadActivity } from '../formats/io/activity.js';
import { LatentOutlierReader } from './latent-outliers-stream.js';
import { residencyBudgetBytes } from './memory-budget.js';
import { configureDecodePool, decodePoolStats, warmDecodePool } from '../formats/io/decode-pool.js';
import { narrowCategoricalCodes } from './categorical-storage-contract.js';
import {
  requireColumnDelivery,
  requireRunDelivery,
  splitColumnsByCellRanges,
  subsetRun,
} from './gene-delivery.js';

/** How often a running activity is reported, at most. */
const ACTIVITY_INTERVAL_MS = 250;

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

/** The error the page answered a source access request with, as a plain record. */
function accessError(record) {
  const error = new Error(typeof record?.message === 'string' ? record.message : 'The file could not be accessed.');
  if (typeof record?.name === 'string') error.name = record.name;
  if (record?.code !== undefined) error.code = record.code;
  if (typeof record?.sourceType === 'string') error.source = record.sourceType;
  if (record?.details !== undefined) error.details = record.details;
  return error;
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
    if (value.buffer instanceof ArrayBuffer &&
        value.byteOffset === 0 &&
        value.byteLength === value.buffer.byteLength) {
      into.add(value.buffer);
    }
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
    varNames: reader.varNames,
    hasExpressionMatrix: reader.hasExpressionMatrix,
    isOpen: reader.isOpen,
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
 * `{latencyMs, bytesPerMs, backgroundConcurrency, protocol}`. A remote
 * source reports its measured link (`formats/io/link.js`); a local one (a
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
    bytesPerMs: snapshot.bytesPerMs,
    backgroundConcurrency: snapshot.backgroundConcurrency,
    protocol: snapshot.protocol,
  };
}

/**
 * Create the message handler of one reader worker.
 *
 * @param {Object} [options]
 * @param {(message: Object) => void} [options.post] - Posts events
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
    let access = accesses.get(ref);
    if (access === undefined) {
      access = {
        generation: 0,
        isStale: status => stale.has(status),
        unreadable: typeof descriptor.unreadable === 'string' ? descriptor.unreadable : null,
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
      };
      accesses.set(ref, access);
    }
    return access;
  };
  // The page's answers to `choose` events, by request.
  const choices = new Map();
  let nextChoice = 1;
  const transcoding = {
    createActivity,
    onStore: ({ directory, state }) => post({ event: 'transcoded', directory, state }),
    choose: ({ question, options }) => new Promise((resolve, reject) => {
      const request = nextChoice++;
      choices.set(request, { resolve, reject });
      post({ event: 'choose', request, question, options });
    }),
  };
  let reader = null;
  let latent = null;
  /** The input format id of the open dataset, for the messages of its later reads. */
  let format = null;

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
    async open(_context, { source, expect = null, fromLink = false }) {
      // Decode workers start while the structure is read, not on the first chunk.
      warmDecodePool();
      // One activity for the whole opening: the file's structure, then the
      // AnnData elements the first view needs.
      const activity = createActivity({ kind: 'open', label: `the structure of ${sourceName(source)}` });
      let opened;
      const next = new AnnDataReader();
      // A remote source's running totals carry how many requests its link
      // answers at once now, which the page's download scheduler follows.
      let link = null;
      const onTransfer = ({ url, bytes, requests, ms, arriving = false, retrying = null }) => {
        post(arriving || retrying !== null
          ? { event: 'transfer', url, arriving, retrying }
          : { event: 'transfer', url, bytes, reads: requests, ms, requestConcurrency: requestConcurrencyOf(source, link) });
        if (!arriving && retrying === null) postLink();
      };
      try {
        opened = await openDatasetStore({ source, expect, fromLink }, {
          decodedChunkCacheBytes: residencyBudgetBytes('decodedBlocks'),
          onTransfer,
          activity,
          sourceAccess,
          transcoding,
        });
        link = opened.link ?? null;
        // From here on, the link this dataset is read over is reported as it
        // is measured (`{event: 'link'}`).
        measured = { source, link };
        lastMeasurement = null;
        postLink();
        next.createActivity = createActivity;
        try {
          await next.open(opened.root, {
            format: opened.readerFormat,
            name: opened.name,
            decodedChunkBytes: residencyBudgetBytes('decodedBlocks'),
            link: opened.link,
            activity,
          });
        } catch (error) {
          opened.root.close?.();
          throw explainFormatError(error, opened.format);
        }
        activity.finish();
      } catch (error) {
        activity.finish(error);
        throw error;
      }
      const previous = reader;
      reader = next;
      format = opened.format;
      latent = new LatentOutlierReader(next);
      previous?.close();
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
      };
    },
    /**
     * What a catalog lists about one store (`describeAnnDataStore`): its
     * metadata and `uns` only. The store is closed again; the open dataset,
     * if any, is untouched.
     */
    async describe({ signal }, { source, expect = null }) {
      // A catalog's files are on a web host: its refusals advise as a link's.
      const opened = await openDatasetStore({ source, expect, fromLink: true }, {
        decodedChunkCacheBytes: 0,
        sourceAccess,
        onTransfer: ({ url, bytes, requests, ms, arriving = false, retrying = null }) => post(
          arriving || retrying !== null
            ? { event: 'transfer', url, arriving, retrying }
            : { event: 'transfer', url, bytes, reads: requests, ms }),
        signal,
        // A catalog listing has no one to ask: a file of several objects is
        // described by its first, and kept for the opening that follows.
        transcoding: { onStore: transcoding.onStore, choose: () => Promise.resolve(0) },
      });
      try {
        return await describeAnnDataStore(opened.root, { format: opened.readerFormat }, { signal });
      } catch (error) {
        throw explainFormatError(error, opened.format);
      } finally {
        opened.root.close?.();
      }
    },
    probeMapping: () => reader.probeMapping(),
    // Display coordinates and bound vectors, checked and scaled here
    // (`embedding-payload.js`): the page draws them as they arrive.
    readEmbedding: ({ signal }, key, columns, normalize) => reader.readEmbedding(key, columns, normalize, { signal }),
    readVectorField: ({ signal }, key, columns, embedding, normalize) =>
      reader.readVectorField(key, columns, embedding, normalize, { signal }),
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
    readVarFlags: (_context, axis, column) => reader.readVarFlags(axis, column),
    getMatrixColumn: ({ signal }, element, index, owner = null, keys = null) =>
      reader.getMatrixColumn(element, index, { signal, owner, keys }),
    getMatrixColumns: ({ signal }, element, genes, owner = null, keys = null) =>
      reader.getMatrixColumns(element, genes, { signal, owner, keys }),
    getMatrixColumnsSparse: ({ signal }, element, genes, owner = null) =>
      reader.getMatrixColumnsSparse(element, genes, { signal, owner }),
    getMatrixRows: ({ signal }, element, cells) => reader.getMatrixRows(element, cells, { signal }),
    getMatrixCellSubset: ({ signal }, element, cells, genes, owner = null) =>
      reader.getMatrixCellSubset(element, cells, genes, { signal, owner }),
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
    async deliverCellSubset({ signal }, element, cells, genes, owner, delivery) {
      requireRunDelivery(delivery, genes.length);
      const route = requireRoute(delivery.route);
      const block = await reader.getMatrixCellSubset(element, cells, genes, { signal, owner });
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
    async getObsField({ signal }, key) {
      const field = await reader.getObsField(key, { signal });
      // The payload is transferred to the caller, which owns it from now on;
      // the reader keeps nothing that would be detached.
      reader.detachObsField(key, field);
      if (field.dtype === 'categorical') {
        // Narrowed here, off the page's thread: the page keeps this array.
        return {
          dtype: field.dtype,
          codes: narrowCategoricalCodes(field.codes, field.categories.length, `Categorical observation field '${key}'`),
          categories: field.categories,
          ordered: field.ordered,
        };
      }
      return field;
    },
    releaseObsField: (_context, key) => reader.releaseObsField(key),
    hasConnectivities: (_context, key) => reader.hasConnectivities(key),
    getConnectivityEdges: ({ signal }, key) => reader.getConnectivityEdges(key, { signal }),
    getDatasetMetadata: () => reader.getDatasetMetadata(),
    clearCache() {
      latent?.clear();
      reader?.clearCache();
    },
    close() {
      const current = reader;
      reader = null;
      latent = null;
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
    if (message?.sourceAccess !== undefined) {
      const waiting = accessRequests.get(message.sourceAccess);
      accessRequests.delete(message.sourceAccess);
      if (waiting !== undefined) {
        if (message.error === undefined) waiting.resolve(message.target);
        else waiting.reject(accessError(message.error));
      }
      return null;
    }
    if (message?.sourceUnreadable !== undefined) {
      const waiting = accessRequests.get(message.sourceUnreadable);
      accessRequests.delete(message.sourceUnreadable);
      waiting?.resolve(message.unreadable === true);
      return null;
    }
    if (message?.sourceAccessRevoked !== undefined) {
      const access = accesses.get(message.sourceAccessRevoked);
      if (access !== undefined) access.generation += 1;
      return null;
    }
    if (message?.cancel !== undefined) {
      running.get(message.cancel)?.abort(new DOMException('The request was cancelled.', 'AbortError'));
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
      const result = ownedBuffers(await method({ signal: controller.signal }, ...(Array.isArray(message.args) ? message.args : [])));
      return { reply: { id, result }, transfer: [...transferables(result)] };
    } catch (error) {
      // Opening explains its own failures (`openDatasetStore`); a later
      // read is explained in the words of the format that is open.
      const shown = message?.method === 'open' || message?.method === 'describe'
        ? error
        : explainFormatError(error, format);
      return { reply: { id, error: serializeReaderError(shown) }, transfer: [] };
    } finally {
      if (running.get(id) === controller) running.delete(id);
    }
  };
}

if (
  typeof self !== 'undefined' &&
  typeof self.postMessage === 'function' &&
  typeof window === 'undefined'
) {
  // Decode workers are as many as the cores and their memory budget allow.
  configureDecodePool({ memoryBytes: residencyBudgetBytes('decodeWorkers') });
  const handle = createAnnDataReaderHandler({
    post: message => self.postMessage(message),
  });
  // Requests interleave at the reader's await points: a field read never
  // waits for a gene index, and reads asked for together are planned
  // together by the byte reader.
  self.onmessage = async event => {
    const answer = await handle(event.data);
    if (answer !== null) self.postMessage(answer.reply, answer.transfer);
  };
}
