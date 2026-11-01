/**
 * One dataset file on a web host, described without downloading it: its
 * format from the file name (`data/input-formats.js`; the reader confirms it
 * from the content), its exact size and the identity the host reports.
 * Providers that open single files (any single-file format: `.h5ad`, Zarr
 * ZIP, `.loom`, `.rds`, …) build their entries with this, so every provider names formats and failures the same way.
 *
 * A file is read in place with range requests. A host that ignores range
 * requests serves only the whole file, and so does one that content-codes
 * the file even in a range (`contentCoded`: a part of it cannot be decoded,
 * `probeHttpResource`): its entry says so (`transport: 'download'`), and
 * the link source downloads it once, showing how much has arrived, into
 * this browser's storage as it arrives (never gathered in memory), kept for
 * later visits like a transcoded store (`downloadRemoteFile`,
 * `transcode/space.js`), then reads it from there. A host that does
 * not let other sites read its files (CORS) cannot be read at all, and the
 * refusal says so and what to do instead.
 *
 * @module data/sources/remote-file
 */

import {
  DataSourceError,
  DataSourceErrorCode,
  explainedFailure,
  hostFaultCause,
  hostFaultFailure,
  hostFaultOf,
} from '../data-source.js';
import {
  BYTE_SOURCE_FAILURES,
  ByteSourceError,
  HEAD_BYTES,
  fetchOnce,
  hostFaultOfStatus,
  isTransientAnswer,
  isTransientFailure,
  probeHttpResource,
  spreadOf,
  transientStatusError,
  withRetries,
} from '../../formats/io/byte-source.js';
import { ResponseClock } from '../../formats/io/link.js';
import { realmHosts } from '../../formats/io/hosts.js';
import { fileFormatOfName, inputFormat, openableNamesText, readsFromHead, titleOfName } from '../input-formats.js';
import { formatCountOf } from '../../utils/format-units.js';
import { keepDownload, keptAtAddress } from '../anndata/transcode/space.js';
import { decompressed } from '../../formats/rds/stream.js';
import { writeVersion } from './identity.js';
import { noEmbeddingRefusal, tenxEmbeddingHint } from '../anndata/views/refusal.js';
import { isCancellation } from '../../utils/abort.js';

/**
 * How much of a file's head a provider reads beside its own request for the
 * file (a Drive or OneDrive item): the whole head (`HEAD_BYTES`), or one
 * byte when this browser keeps something of the file at its key
 * (`transcode/space.js` `keptAtAddress`), whose head is then read from what
 * is kept under the version this opening establishes. The one byte still
 * proves the file can be read.
 *
 * @param {string} key - The file's identity key
 * @returns {Promise<number>}
 */
export async function headBytesFor(key) {
  return (await keptAtAddress({ kind: 'remote', key })) ? 1 : HEAD_BYTES;
}

/**
 * The size and identity a host reports for one file, or the refusal that
 * names why it cannot be read. The head of a file whose structure starts at
 * byte 0 (an `.h5ad`: its first read, `HEAD_BYTES`) is read in the same
 * round trip (`readsFromHead`), unless this browser keeps something of the
 * file at `address` (`kept`, `transcode/space.js` `keptAtAddress`): its
 * head is then read from what is kept when the version is the same, and
 * the probe asks only for the version.
 */
async function probeRemoteFile(url, name, format, signal, { kept = false, onStep = null } = {}) {
  // Whether the host answered this site before this probe: its own refusal
  // is an answer too.
  const answeredBefore = realmHosts.answeredBefore(url);
  try {
    return await probeHttpResource(url, {
      signal,
      // A wait the host names (its request budget, a server preparing the
      // file) is the opening's step while it lasts, in the host's words.
      onWait: onStep === null ? null : wait => {
        if (wait !== null) onStep(wait.text);
      },
      headBytes: readsFromHead(format) && !kept ? HEAD_BYTES : 0,
      // A file read from its start as a stream (an R file is gzip, a
      // compressed copy is) may be content-coded by its host: that a range
      // of it can be read is proven.
      checkRange: format !== null && (inputFormat(format.format).access === 'stream' || format.compression !== undefined),
    });
  } catch (error) {
    if (isCancellation(error)) throw error;
    throw await hostRefusal({ url, name, format, error, signal, answeredBefore });
  }
}

/**
 * Formats whose files never hold a cell embedding themselves: a 10x Cell
 * Ranger matrix file (its UMAP and t-SNE are beside it, in `outs/`). Such a
 * file opened from this computer is refused too (`views/tenx-h5.js`), so a
 * host that will not let this site read one is not answered with "download
 * it and open it from your computer".
 */
const FORMATS_WITHOUT_AN_EMBEDDING = new Set(['tenx-h5']);

/**
 * What to do about a file this site may not read from its host, once it is
 * known it cannot: what can succeed for that file. A format whose files hold
 * no embedding says both facts at once: the file downloaded alone would be
 * refused too, for having none, and what does open -- the folder its
 * embedding is in, or one computed (`noEmbeddingRefusal`, with the same
 * hint the file itself is refused with, `tenxEmbeddingHint`); any other
 * opens from this computer as it is.
 */
export function nextStepWithoutTheHost(name, format) {
  if (format !== null && FORMATS_WITHOUT_AN_EMBEDDING.has(format.format)) {
    return `Downloaded alone it would be refused too: ${
      noEmbeddingRefusal(`${name} is a 10x Cell Ranger count matrix that`, tenxEmbeddingHint('file', true)).message}`;
  }
  return 'Download it and open it from your computer (Open… › File…).';
}

/**
 * Whether `url`'s host can be reached at all, asked without reading its
 * answer (`no-cors`): a host that answers, whatever it answers, is there and
 * refuses to let this site read it (CORS); one that cannot be reached (a
 * mistyped name, no connection, a network that blocks it) fails.
 */
async function hostAnswers(url, signal) {
  try {
    await fetch(url, { method: 'HEAD', mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal });
    return true;
  } catch (error) {
    if (isCancellation(error)) throw error;
    return false;
  }
}

/**
 * The refusal of a file whose host did not let this site read it, written for
 * the person: what happened, in one sentence, and what can succeed; the
 * host's own answer (its HTTP status) under Details (`cause`).
 *
 * Each fault is said by who is at fault (`hostFaultFailure`, `HOST_FAULTS`):
 *
 * - Not there (404, 410): `missing`, check the link.
 * - Refused (401, 403): from a host that answered this site before this
 *   probe (`answeredBefore`), `refusing` this network for now (hosts do so
 *   after many requests); else `refused`, the link's permissions.
 * - A host-side status (5xx, 408, 429): `failing` or `limiting`.
 * - Any other status: the host refused the request; check the link.
 * - No answer this page may read: `offline`, connect; from a host that
 *   answered this site before, `refusing` this network for now; else the
 *   host is asked once more without reading its answer (`hostAnswers`): one
 *   that answers does not let other websites read its files (CORS), and the
 *   way on is what can succeed for this file (`nextStepWithoutTheHost`); one
 *   that does not could not be reached.
 */
async function hostRefusal({ url, name, format, error, signal, answeredBefore }) {
  const status = Number.isInteger(error?.status) ? error.status : null;
  const host = new URL(url).host;
  const refuse = (message, code) => explainedFailure(message, code, 'link', { url, status, cause: error });
  const fault = kind => hostFaultFailure({ kind, host, status, what: name, retryAfterMs: error?.details?.hostFault?.retryAfterMs ?? null },
    { url, cause: hostFaultCause(error) });
  if (status === 404 || status === 410) return fault('missing');
  // A refusal from a host that answered this site before is a refusal of
  // this network for now (hosts do so after many requests), not the file's
  // permissions.
  if (status === 401 || status === 403) return fault(answeredBefore ? 'refusing' : 'refused');
  if (hostFaultOfStatus(status) !== null) return fault(hostFaultOfStatus(status));
  if (status !== null) {
    return refuse(
      `${host} answered HTTP ${status} for ${name}, so it cannot be read. Check the link, or ask its owner whether it moved.`,
      DataSourceErrorCode.NETWORK_ERROR
    );
  }
  // Offline first: a host that answered before and gives no answer now,
  // while this computer is offline, is not refusing anything.
  if (globalThis.navigator?.onLine === false) return fault('offline');
  // Unrelated hosts all silent at once: this side's connection.
  if (realmHosts.connectionDown(url)) return fault('connection');
  if (answeredBefore || error?.details?.answeredBefore === true) return fault('refusing');
  if (await hostAnswers(url, signal)) {
    return refuse(
      `${host} does not let other websites read its files, so this site cannot read ${name}. ` +
        nextStepWithoutTheHost(name, format),
      DataSourceErrorCode.PERMISSION_DENIED
    );
  }
  return refuse(
    `${host} could not be reached. Check the address and your connection, then try again.`,
    DataSourceErrorCode.NETWORK_ERROR
  );
}

/**
 * The version a host reported of a file, for its identity, from the answers
 * of this opening's own probe: its size with its Last-Modified date and its
 * strong ETag, each the host sent (`writeVersion`), else only its size
 * (`size:<bytes>`: no version, so nothing kept of the file is used).
 */
function versionOf(probed) {
  return writeVersion({ size: probed.size, lastModified: probed.lastModified ?? null, etag: probed.etag ?? null }) ??
    `size:${probed.size}`;
}

/**
 * Probe one remote file and return the entry a link source opens.
 *
 * @param {Object} options
 * @param {string} options.url - Where the bytes are
 * @param {string} options.id - Dataset id; stable for this file wherever it
 *   is opened from, and without '/' (it becomes `anndata://<id>/`)
 * @param {string} options.name - File name, which also declares the format
 *   (`fileFormatOfName`): the entry's `format` is `{format, layout}`
 * @param {string} [options.title] - What the dataset is called when the file
 *   does not name itself (`uns['title']`); its name without the extension
 *   by default (`titleOfName`)
 * @param {Object} options.attribution - `{title, url, licence?, citation?}`
 * @param {string|null} [options.version] - The version the provider's own
 *   answer of this opening names (a checksum, a commit, a revision, a
 *   release); else the host's validators (`versionOf`)
 * @param {number|null} [options.size] - The exact size, when the provider's
 *   listing gives it: no probe request is made (rate-limited hosts) when the
 *   provider names the version too, or read the head beside it (whose
 *   `ETag` then names it); else the file is probed for its version
 * @param {{bytes: Uint8Array, etag: string|null, ms: number}|null} [options.head]
 *   The file's first bytes, when the provider read them beside its own probe
 *   of the size (`readFileHead`): opening starts from them
 * @param {AbortSignal|null} [options.signal]
 * @param {((step: string) => void)|null} [options.onStep] - Told what is
 *   being done, for the opening progress
 * @returns {Promise<Object>}
 */
export async function describeRemoteFile({
  url,
  id,
  name,
  title = titleOfName(name),
  attribution,
  version = null,
  size = null,
  head = null,
  signal = null,
  onStep = null,
}) {
  if (typeof id !== 'string' || id.length === 0 || id.includes('/')) {
    throw new TypeError('A remote file id must be a non-empty string without "/".');
  }
  const format = fileFormatOfName(name);
  if (format === null) {
    throw new DataSourceError(
      `${name} is not a file Cellucid opens from a link. Links open ` +
      `${openableNamesText({ layouts: ['file', 'zip'] })}, a Zarr store folder, or a ` +
      'dataset catalog folder holding datasets.json (a URL ending in "/").',
      DataSourceErrorCode.UNSUPPORTED,
      'link',
      { url, name }
    );
  }
  // A format recognised only to be refused (h5Seurat) is refused before a
  // compressed copy of it is downloaded whole to say so.
  if (format.compression !== undefined && inputFormat(format.format).refusal !== undefined) {
    throw new DataSourceError(inputFormat(format.format).refusal, DataSourceErrorCode.UNSUPPORTED, 'link', { url, name, explained: true });
  }
  // A size a listing states stands without a probe only beside a version
  // asked of the source in this opening: never by itself.
  const known = Number.isSafeInteger(size) && size >= 0 && (version !== null || head !== null);
  if (!known) onStep?.(`Checking ${name} on ${new URL(url).host}`);
  const probed = known
    ? { size, etag: head?.etag ?? null, lastModified: null, rangeSupported: null, head }
    : await probeRemoteFile(url, name, format, signal, { kept: await keptAtAddress({ kind: 'remote', key: id }), onStep });
  return Object.freeze({
    id,
    name,
    title,
    format,
    // A host that ignores range requests, or content-codes the file, serves
    // only the whole file; a compressed copy (`.h5ad.gz`) is read whole,
    // decompressed as it arrives (`downloadRemoteFile`).
    transport: probed.rangeSupported === false || format.compression !== undefined ? 'download' : 'ranges',
    attribution: Object.freeze({ ...attribution }),
    resource: Object.freeze({
      url,
      size: probed.size,
      name,
      identity: Object.freeze({
        kind: 'remote',
        key: id,
        version: version ?? versionOf(probed),
      }),
      // What the host said of the version read, which every later answer
      // must say again (`httpByteSource`, `downloadRemoteFile`): a change
      // between this description and a read is refused there, never kept
      // under this version.
      ...(probed.etag == null ? {} : { etag: probed.etag }),
      ...(probed.lastModified == null ? {} : { lastModified: probed.lastModified }),
      // How long its host took to answer here (the provider's own request,
      // when the size came without a probe): the reader's stall timeout
      // starts from it (`ResponseClock`).
      ...(realmHosts.rememberedAnswer(url) === null ? {} : { answeredMs: realmHosts.rememberedAnswer(url) }),
      // The file's first bytes, read with the probe: opening starts from them.
      ...(probed.head == null ? {} : { head: Object.freeze({ ...probed.head }) }),
      // Sent content-coded: what arrives is decoded, its size known once it has.
      ...(probed.contentCoded === true ? { contentCoded: true } : {}),
      // A host that ignores ranges: a download cut short starts over.
      ...(probed.rangeSupported === false && probed.contentCoded !== true ? { rangesIgnored: true } : {}),
      // A compressed copy: kept decompressed, its decompressed size known once it has arrived.
      ...(format.compression === undefined ? {} : { compression: format.compression }),
    }),
  });
}

/**
 * Several files on one host that make one dataset together (a MatrixMarket
 * matrix and its feature and barcode lists, listed apart by GEO), as the
 * entry a link source opens: `{id, rootName, title, format, attribution,
 * files}`, `files` a `Map` from each file's name to its remote file
 * (`{url, size, name, identity, etag?, lastModified?}`), the source
 * `{files, rootName}` the reader opens. Each file's identity is
 * `{kind: 'remote', key: '<id>:<name>', version}`, its version the content
 * name the listing states of it (`version`, read in this opening), else its
 * host's validators (`versionOf`): every file without one is probed, all at
 * once, together, even when the listing states its size.
 *
 * @param {Object} options
 * @param {Array<{url: string, name: string, size?: number|null, version?: string|null}>} options.files
 * @param {string} options.id - Dataset id, without '/'
 * @param {string} options.rootName - The name of the set, as a folder's
 * @param {string} options.title
 * @param {{format: string, layout: 'folder'}} options.format
 * @param {Object} options.attribution
 * @param {AbortSignal|null} [options.signal]
 * @param {((step: string) => void)|null} [options.onStep]
 * @returns {Promise<Object>}
 */
export async function describeRemoteFileSet({ files, id, rootName, title, format, attribution, signal = null, onStep = null }) {
  if (typeof id !== 'string' || id.length === 0 || id.includes('/')) {
    throw new TypeError('A remote file set id must be a non-empty string without "/".');
  }
  const named = file => typeof file.version === 'string' && file.version !== '' && Number.isSafeInteger(file.size) && file.size >= 0;
  const unknown = files.filter(file => !named(file));
  if (unknown.length > 0) onStep?.(`Checking ${unknown.map(file => file.name).join(', ')} on ${new URL(unknown[0].url).host}`);
  const described = await Promise.all(files.map(async file => {
    const probed = named(file)
      ? { size: file.size, etag: null, lastModified: null }
      : await probeRemoteFile(file.url, file.name, format, signal, { onStep });
    return [file.name, Object.freeze({
      url: file.url,
      size: probed.size,
      name: file.name,
      identity: Object.freeze({ kind: 'remote', key: `${id}:${file.name}`, version: named(file) ? file.version : versionOf(probed) }),
      ...(probed.etag == null ? {} : { etag: probed.etag }),
      ...(probed.lastModified == null ? {} : { lastModified: probed.lastModified }),
      // Sent content-coded: downloaded whole before the set opens.
      ...(probed.contentCoded === true ? { contentCoded: true } : {}),
    })];
  }));
  return Object.freeze({
    id,
    rootName,
    title,
    format: Object.freeze({ ...format }),
    attribution: Object.freeze({ ...attribution }),
    files: new Map(described),
  });
}

/**
 * The one file a link opens from a listing: the requested one, or the only
 * openable one (a name `fileFormatOfName` knows: `.h5ad`, `.zip`). Several openable files are named back, each
 * with the exact locator that opens it, so the person can choose.
 *
 * @param {string[]} names - Every file name the listing holds
 * @param {string|null} requested - The file the link names, if any
 * @param {string} where - The record, series or folder, as the person knows it
 * @param {(name: string) => string} locatorFor - The `?data=` value of a file
 * @returns {string}
 */
export function chooseOpenableFile(names, requested, where, locatorFor) {
  if (requested !== null) {
    if (!names.includes(requested)) {
      throw new DataSourceError(
        `${where} has no file named ${requested}.`,
        DataSourceErrorCode.NOT_FOUND,
        'link',
        { where, requested }
      );
    }
    return requested;
  }
  // A compressed copy beside the file it is a copy of is the same dataset,
  // read whole: the file itself is read in parts.
  const listed = new Set(names);
  const openable = names.filter(name => {
    const format = fileFormatOfName(name);
    return format !== null && !(format.compression !== undefined && listed.has(name.slice(0, -3)));
  });
  if (openable.length === 1) return openable[0];
  if (openable.length === 0) {
    throw new DataSourceError(
      `${where} holds no file Cellucid opens (${openableNamesText({ layouts: ['file', 'zip'] })})` +
      `${names.length > 0 ? `; it has: ${names.join(', ')}` : ''}.`,
      DataSourceErrorCode.UNSUPPORTED,
      'link',
      { where, files: names }
    );
  }
  throw new DataSourceError(
    `${where} has ${formatCountOf(openable.length, 'file')} Cellucid opens. Open one of them: ` +
    `${openable.map(locatorFor).join(', ')}.`,
    DataSourceErrorCode.VALIDATION_ERROR,
    'link',
    { where, files: openable }
  );
}

/**
 * Download a whole file from a host that serves no part of it (it ignores
 * range requests, or content-codes the file), as a `File` the AnnData
 * reader then reads: written to this browser's storage as it arrives and
 * kept there (`keepDownload`: for later visits when the file's identity
 * names its version), or, without storage, joined into one Blob a batch at
 * a time; never gathered in memory. `onBytes(received)` hears each piece as
 * it arrives. When the browser refuses it for its quota part way and the
 * files kept from earlier openings that no tab holds made room
 * (`keepDownload`), it is downloaded once more. A content-coded file arrives decoded, so its length is not the
 * size the host stated. With it come its page checksums when it is kept
 * in storage (`checks`, `formats/io/page-checks.js`: every read of it is
 * checked against them), null when it is in memory.
 *
 * Its request rides out a host's transient failures as every request does
 * (`withRetries`: a busy answer, a lost connection, a stall before the
 * answer; within the host's request budget, waiting as long as it names),
 * and its body is watched for silence (`fetchOnce`, `stream`): a host that
 * stops sending fails it as stalled instead of holding the opening until
 * Cancel. A body cut short (a dropped connection, a stall) goes on from the
 * byte it stopped at (`Range: bytes=<received>-`, asked again as any
 * request is, counted afresh once bytes arrive again), under the version it
 * started with: a compressed copy on a host that serves ranges (GEO's
 * `.h5ad.gz`, 616 MB at 1.5-8 MB/s) never starts over on an unsteady link.
 * Only a host that ignores ranges (`rangesIgnored`, or one that answers the
 * resumption whole) or content-codes the file has it downloaded again from
 * its start, as a failed request is asked again, for as long as one would be.
 *
 * @param {{url: string, name: string, size: number, identity?: Object, contentCoded?: boolean, compression?: 'gzip'}} resource
 *   `compression`: a compressed copy (`.h5ad.gz`), kept decompressed
 * @param {{signal?: AbortSignal|null, onBytes?: (received: number) => void, environment?: Object,
 *   onRetry?: ((error: Error, attempts: number) => void)|null}} [options]
 *   `environment`: whose `navigator.storage` keeps it (the page's own);
 *   `onRetry`: hears each failure asked again (the Transfers log)
 * @returns {Promise<{file: File, checks: {pageBytes: number, sums: Uint32Array, directory: string}|null}>}
 */
export async function downloadRemoteFile(resource, { signal = null, onBytes = () => {}, environment = globalThis, onRetry = null } = {}) {
  // `onBytes` hears every byte that arrived, a second download's included.
  let before = 0;
  let arrived = 0;
  const heard = received => {
    arrived = before + received;
    onBytes(arrived);
  };
  const clock = new ResponseClock();
  clock.onRetry = onRetry;
  const once = () => {
    before = arrived;
    return downloadOnce(resource, { signal, onBytes: heard, environment, clock, delivered: arrived > 0 });
  };
  // A body cut short: downloaded again from its start, as a request is asked again.
  const whole = () => withRetries(once, {
    signal,
    clock,
    retryable: error => isTransientFailure(error) && error.details?.phase === 'body',
    onRetry: error => clock.onRetry?.(error),
    random: spreadOf(`${resource.url} whole`),
  });
  try {
    return await whole();
  } catch (error) {
    // The browser refused it for its quota part way, and the kept files
    // nobody holds made room: once more, from the start.
    if (error?.details?.reason !== 'storage-full' || !(error.details.freed > 0)) throw error;
    return whole();
  }
}

/**
 * One download of `resource`; `delivered`: whether its host delivered bytes
 * of it before (a download started again), so a busy answer is asked again
 * for the whole patience, not reported after a few (`withRetries`).
 */
async function downloadOnce(resource, { signal, onBytes, environment, clock, delivered }) {
  const host = new URL(resource.url).host;
  let response;
  let body;
  try {
    // The answer, asked again while the host is busy or does not answer.
    ({ response, pieces: body } = await withRetries(async () => {
      const answer = await fetchOnce(resource.url, { cache: 'no-store' }, {
        fetchImpl: globalThis.fetch,
        signal,
        clock,
        stream: true,
        wantsBody: reply => reply.ok,
      });
      if (isTransientAnswer(answer.response, answer.said)) throw transientStatusError(answer.response, resource.url, answer.said);
      return answer;
    }, { signal, clock, onRetry: error => clock.onRetry?.(error), random: spreadOf(`${resource.url} answer`), delivered: () => delivered }));
  } catch (error) {
    if (isCancellation(error) || signal?.aborted) throw error;
    if (error?.details?.hostFault !== undefined || hostFaultOfStatus(error?.status) !== null) {
      throw hostFaultFailure({ ...hostFaultOf(error), what: resource.name }, { url: resource.url, cause: hostFaultCause(error) });
    }
    throw new DataSourceError(
      `${resource.name} could not be downloaded from ${host}: ${error?.message ?? error}`,
      DataSourceErrorCode.NETWORK_ERROR,
      'link',
      { url: resource.url, ...(error?.status === undefined ? {} : { status: error.status }) }
    );
  }
  if (!response.ok || body === undefined) {
    // The download is a second request of a file its probe found: a 401 or
    // 403 now is its host refusing this network (`refusing`).
    const kind = response.status === 404 || response.status === 410 ? 'missing'
      : response.status === 401 || response.status === 403 ? 'refusing'
        : hostFaultOfStatus(response.status);
    if (kind !== null) {
      throw hostFaultFailure({ kind, host, status: response.status, what: resource.name }, { url: resource.url });
    }
    throw new DataSourceError(
      `${host} answered HTTP ${response.status} for ${resource.name}.`,
      DataSourceErrorCode.NETWORK_ERROR,
      'link',
      { url: resource.url, status: response.status }
    );
  }
  // Another version than the one described: refused, never kept under its
  // identity. Its date is compared; its ETag only from a host that sends no
  // date, and without a weak mark (a whole answer a host compresses on the
  // way gets `W/` or a suffix naming the coding, which a range never does).
  const tag = response.headers.get('ETag');
  const modified = response.headers.get('Last-Modified');
  const strip = value => value.replace(/^W\//i, '');
  const changed = typeof resource.lastModified === 'string'
    ? modified !== null && modified !== resource.lastModified
    : typeof resource.etag === 'string' && tag !== null && strip(tag) !== strip(resource.etag);
  if (changed) {
    await body.return();
    throw new ByteSourceError(
      BYTE_SOURCE_FAILURES.CHANGED,
      `${resource.name} changed on ${host} since it was checked; open it again to read the new version.`,
      { url: resource.url }
    );
  }
  let received = 0;
  // Where the bytes still to come are asked for after a body cut short: the
  // rest of the file, of the version that started arriving.
  const resumable = resource.contentCoded !== true && resource.rangesIgnored !== true;
  const resumeFrom = at => withRetries(async () => {
    const answer = await fetchOnce(resource.url, { headers: { Range: `bytes=${at}-` }, cache: 'no-store' }, {
      fetchImpl: globalThis.fetch,
      signal,
      clock,
      stream: true,
      wantsBody: reply => reply.status === 206,
    });
    if (isTransientAnswer(answer.response, answer.said)) throw transientStatusError(answer.response, resource.url, answer.said);
    return answer;
  }, { signal, clock, onRetry: error => clock.onRetry?.(error), random: spreadOf(`${resource.url} ${at}-`), delivered: () => true });
  // A short or long answer fails the download before it is kept; a body
  // that stops arriving fails it as stalled (`fetchOnce`, `stream`), and
  // goes on from where it stopped where the host serves the rest.
  async function* pieces() {
    let rest = body;
    for (;;) {
      try {
        for await (const value of rest) {
          received += value.byteLength;
          onBytes(received);
          yield value;
        }
        break;
      } catch (cut) {
        if (!resumable || received === 0 || !isTransientFailure(cut) || cut.details?.phase !== 'body' || signal?.aborted) throw cut;
        let answer;
        try {
          answer = await resumeFrom(received);
        } catch (error) {
          if (isCancellation(error) || signal?.aborted) throw error;
          throw cut;
        }
        const { response: resumed, pieces: more } = answer;
        const range = /^\s*bytes\s+(\d+)-/i.exec(resumed.headers.get('Content-Range') ?? '');
        const resumedTag = resumed.headers.get('ETag');
        const resumedModified = resumed.headers.get('Last-Modified');
        // Not the rest of this version (a host that answered whole, another
        // range, or a file replaced meanwhile): from its start, or refused.
        if (resumed.status !== 206 || more === undefined || (range !== null && Number(range[1]) !== received)) {
          await more?.return();
          throw cut;
        }
        if ((modified !== null && resumedModified !== null && resumedModified !== modified) ||
            (tag !== null && resumedTag !== null && strip(resumedTag) !== strip(tag))) {
          await more.return();
          throw new ByteSourceError(
            BYTE_SOURCE_FAILURES.CHANGED,
            `${resource.name} changed on ${host} while it was downloaded; open it again to read the new version.`,
            { url: resource.url }
          );
        }
        // Said as every failure asked again is (the Transfers log); a cut
        // that starts over is said by the download asked again.
        clock.onRetry?.(cut, 1);
        rest = more;
      }
    }
    if (resource.contentCoded !== true && Number.isSafeInteger(resource.size) && received !== resource.size) {
      throw new DataSourceError(
        `${host} sent ${formatCountOf(received, 'byte')} of ${resource.name}, not the ${resource.size} it reported.`,
        DataSourceErrorCode.NETWORK_ERROR,
        'link',
        { url: resource.url }
      );
    }
  }
  // A compressed copy (`.h5ad.gz`) is kept decompressed, decompressed as it
  // arrives (on a worker of its own when large), so it is read in parts from
  // storage. What decides is its content, not its name: a host that
  // content-coded it has had it decoded by the browser already, and a
  // stream that is not gzip passes as it is. Its length is checked as it
  // arrived (above), its decompressed length by gzip's own trailer.
  const arriving = pieces();
  const kept = resource.compression === undefined ? arriving : (await decompressed(arriving, { signal, bytes: resource.size })).pieces;
  const { file, checks } = await keepDownload(resource.identity ?? null, kept, {
    name: resource.name,
    url: resource.url,
    size: resource.contentCoded === true || resource.compression !== undefined ? null : resource.size,
    environment,
  });
  return { file, checks };
}
