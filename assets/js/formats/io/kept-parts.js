/**
 * The parts of a remote file downloaded before, kept in this browser across
 * visits: whoever opens the same version of the same file again (another
 * day, another tab) downloads none of the bytes any reader of it fetched
 * before (its structure, chunk indexes, embeddings, obs columns, the chunks
 * a gene read), only what no earlier reading fetched -- however short the
 * visit that fetched them.
 *
 * **What is kept, and under what.** Every byte a reader fetches of a
 * remote file is written through to the origin-private file system as it
 * arrives, kept as the kept-store machinery keeps converted stores and gene
 * indexes (`data/anndata/transcode/space.js`: a shared Web Lock while it is
 * used, removal under the browser's real quota, the Session panel's Stored
 * list), as **journals** (`space.js` `openKeptJournal`): a directory whose
 * manifest is written first, so it is kept from its first byte; each piece
 * fetched is appended to its bytes, then a record of where it is of the
 * file, framed by its length and CRC-32 and carrying the piece's page
 * checksums (`formats/io/page-checks.js`). A reader's journal is closed --
 * never appended to again, so another reader may read it -- once its reads
 * go quiet for the link's retransmission timeout, when the page is hidden
 * or left, and when the reader closes; the next piece begins a new one. A read
 * does not wait for its write, and a write is the operating system's once it
 * returns, so a visit of any length keeps what it fetched: a tab closed at once,
 * a worker ended, a browser that crashes loses at most the pieces still waiting
 * to be written, which the next visit fetches again; a machine that stops (power lost)
 * may lose what the disk had not yet stored, whose records then do not read
 * whole or do not match their checksums, and are not used. The page asks
 * its reader workers to have the disk hold what they wrote when it is
 * hidden or left (`flushKeptParts`, `data/anndata-reader-client.js`).
 * Every journal of a file is filed under `{parts: identity, size}`: the
 * file's identity (its key and the version its host or provider stated for
 * this opening; signature and token query parameters never part of it,
 * `kept-format.js` `cacheKey`) and its exact size, so a file that grew or shrank
 * is another file. Only a file whose identity names a version is kept
 * (`data/sources/identity.js` `persistsAcrossVisits`): a file known by its size alone may
 * change under it, and nothing of it is kept. Nothing is kept of a file
 * read from this machine or a notebook kernel (`sameMachine`: a loopback
 * address, `cellucid serve`, the widget's host) or of a store a Python or R
 * server serves (`keptParts: false`): a copy spares no download, and a
 * served store made from an object in memory is named anew every run. The
 * bytes of a file a transcoder reads whole (an R object) are not kept as
 * parts: its converted store is what is kept of it; nor are bytes read once
 * (a cell export's, a copy of the dataset's: `keepInMemory: false`), which
 * no view reads again. A store folder on a web
 * host keeps its objects only under a version that names its content (the
 * commit a provider reads it at: `data/anndata/open.js`).
 *
 * **How a read uses it.** The byte reader (`byte-reader.js`) answers a read
 * from its own memory first (cached metadata, surplus of merged requests),
 * then from the kept parts (a read of this machine's disk, never a request),
 * and fetches only what neither holds -- through the page's memory of
 * other readers' bytes (`range-cache.js`) and, past it, the host. Its plans
 * treat kept bytes as present: no request asks for them, and two ranges
 * are never merged across kept bytes (a merged request would fetch them
 * again). The kept ranges of a file are held in order (`SortedRanges`), so
 * finding them at an opening and every lookup cost a sort and a search,
 * whatever their number: an atlas whose analyses read a hundred thousand
 * ranges opens again at once.
 *
 * **What a kept part is checked against before it is used** (`ready`):
 *
 * - the file's version: its journals are filed under the identity this
 *   opening established from its host or provider (`data/sources`: a
 *   content name where the source has one -- a census build, a checksum, a
 *   commit or revision; else its exact size with its Last-Modified date and
 *   strong ETag). A journal of another version is never found, and opening
 *   a file removes what is kept of its other versions, of every kind
 *   (`space.js` `forgetOtherVersions`, called by `data/anndata/open.js`
 *   before anything kept is used);
 * - every journal's manifest is stamped with the code fingerprint of kept
 *   parts (`space.js` `codeFingerprintOf`: a digest of the code that says
 *   what a journal is, `kept-format.js`, `kept-journal.js` and the page
 *   checksums; a journal stamped by other code is removed, never read) and
 *   is of this identity, and its records are read only as far as they are
 *   whole, match their CRC-32s and name bytes its file holds; a journal
 *   still being written (by another tab: its writer holds its writing
 *   lock) is left to the next opening;
 * - every read of kept bytes checks each 16 KiB page it touches against its
 *   CRC-32; a page that does not match is damage: the journal is forgotten
 *   (its ranges are no longer used, its directory removed once nobody holds
 *   it) and the read fetches those bytes from the host.
 *
 * A file that changes while it is open is refused by its byte source
 * (`byte-source.js`, `CHANGED`); the kept parts then forget every kept copy
 * of the file (`onChanged`) and the read fails with that message: reopening
 * reads the new version. A file whose reads cannot name the version they
 * read (Google Drive's public reads: no validator) keeps its pieces only
 * once its provider confirms that the version it was opened as still holds
 * (`confirm`, `sources/access.js`): asked once its reads go quiet for the
 * link's retransmission timeout and when the page is hidden, and recorded
 * in the journal; a later opening uses only the pieces a confirmation
 * follows, and a version that no longer holds is a changed file.
 *
 * @module formats/io/kept-parts
 */

import { isLoopbackHostname } from '../../utils/loopback.js';
import { KeptCopyDamage } from './page-checks.js';
import { BYTE_SOURCE_FAILURES, ByteSourceError, fetchOnce, httpByteSource } from './byte-source.js';
import { routedFetch } from './host-fetch.js';
import { MIN_STALL_TIMEOUT_MS } from './link.js';
import { EMBEDDED_HOST_ORIGIN } from './host-fetch.js';
import {
  THIS_TAB,
  findKeptStores,
  forgetKeptFile,
  openKeptJournal,
} from '../../data/anndata/transcode/space.js';
import { identityDigest, keptAbout } from '../../data/anndata/transcode/kept-format.js';
import { keptPartsIdentity } from '../../data/anndata/transcode/kept-journal.js';
import { persistsAcrossVisits } from '../../data/sources/identity.js';
import { allocateTypedArray } from '../../data/sparse-column-index.js';
import { settleQuietly } from '../../utils/errors.js';
import { debounce } from '../../utils/debounce.js';

/** The kept parts in this realm that write a journal: what `flushKeptParts` asks to hold. */
const live = new Set();

/**
 * Have the disk hold what every reader of this realm wrote (the page is
 * hidden or being left: `data/anndata-reader-client.js` asks its reader
 * workers on `visibilitychange` and `pagehide`), once every write asked for
 * so far is made; a source whose reads name no version asks its provider to
 * confirm them. Resolves once each is done or let go. Never throws.
 *
 * @returns {Promise<void>}
 */
export function flushKeptParts() {
  return Promise.all([...live].map(parts => parts.flush())).then(() => {});
}

/** Whether the parts of a file with this identity are kept at all: only under a version. */
export function keepsParts(identity) {
  return persistsAcrossVisits(identity);
}

/** Entries a block of `SortedRanges` holds before it is split in two (a structure choice: a search, then a shift within one block). */
const BLOCK_ENTRIES = 512;

/**
 * The kept ranges of one object, sorted by start and disjoint
 * (`{start, end, ...}`), in blocks: finding the first that ends after an
 * offset is two binary searches, and an insertion shifts one block, so
 * neither grows with how many ranges are kept.
 */
export class SortedRanges {
  constructor() {
    /** @type {Array<Array<{start: number, end: number}>>} */
    this._blocks = [];
    this.size = 0;
  }

  /**
   * Ranges in any order, overlapping or not, as sorted disjoint ranges: a
   * byte two of them hold is the first's (by start); a range cut by another
   * keeps the rest, its `offset` moved with its start.
   *
   * @param {Array<{start: number, end: number, offset: number}>} entries
   * @returns {SortedRanges}
   */
  static of(entries) {
    const sorted = [...entries].sort((a, b) => a.start - b.start || b.end - a.end);
    const out = new SortedRanges();
    let block = [];
    let at = -Infinity;
    for (const entry of sorted) {
      const start = Math.max(entry.start, at);
      if (start >= entry.end) continue;
      block.push(start === entry.start ? entry : { ...entry, start, offset: entry.offset + (start - entry.start) });
      at = entry.end;
      if (block.length === BLOCK_ENTRIES) {
        out._blocks.push(block);
        block = [];
      }
    }
    if (block.length > 0) out._blocks.push(block);
    out.size = out._blocks.reduce((sum, item) => sum + item.length, 0);
    return out;
  }

  /** The block and the place in it of the first range that ends after `offset` (past the last: `[blocks, 0]`). */
  _find(offset) {
    const blocks = this._blocks;
    let low = 0;
    let high = blocks.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (blocks[middle][blocks[middle].length - 1].end <= offset) low = middle + 1;
      else high = middle;
    }
    if (low === blocks.length) return [low, 0];
    const block = blocks[low];
    let first = 0;
    let last = block.length;
    while (first < last) {
      const middle = (first + last) >>> 1;
      if (block[middle].end <= offset) first = middle + 1;
      else last = middle;
    }
    return [low, first];
  }

  /** The ranges that end after `offset`, in order. */
  *from(offset) {
    let [b, i] = this._find(offset);
    for (; b < this._blocks.length; b++, i = 0) {
      const block = this._blocks[b];
      for (; i < block.length; i++) yield block[i];
    }
  }

  *[Symbol.iterator]() {
    for (const block of this._blocks) yield* block;
  }

  /** Insert a range no kept range overlaps. */
  insert(entry) {
    this.size++;
    if (this._blocks.length === 0) {
      this._blocks.push([entry]);
      return;
    }
    let [b, i] = this._find(entry.start);
    if (b === this._blocks.length) {
      b = this._blocks.length - 1;
      i = this._blocks[b].length;
    }
    const block = this._blocks[b];
    block.splice(i, 0, entry);
    if (block.length > 2 * BLOCK_ENTRIES) this._blocks.splice(b, 1, block.slice(0, BLOCK_ENTRIES), block.slice(BLOCK_ENTRIES));
  }

  /** Keep only the ranges `keep` says to. */
  retain(keep) {
    this._blocks = this._blocks.map(block => block.filter(keep)).filter(block => block.length > 0);
    this.size = this._blocks.reduce((sum, block) => sum + block.length, 0);
  }
}

/**
 * The kept parts of one remote file, or of the objects of one store folder
 * on a web host (`formats/zarr/stores/http.js`), for one reader: what this
 * browser holds of it, read and written as the reader reads. Each object
 * (`''` for a file: its bytes) has its kept ranges and, when known, its
 * exact size and the validator its host answered it with. Made by
 * `keptPartsOf`.
 */
export class KeptParts {
  /**
   * @param {Object} identity - The file's or folder's identity (it names a version: `keepsParts`)
   * @param {number|null} size - The file's exact size (null: a folder of objects)
   * @param {{environment?: Object, tab?: string, about?: {name: string|null, host: string|null}|null,
   *   onStore?: ((store: {directory: string, state: string}) => (void|Promise<void>))|null,
   *   onChanged?: (() => void)|null, confirm?: (() => Promise<boolean>)|null}} [options] - `onStore`: told of
   *   each journal found or begun (`complete`: kept from then on): the page
   *   holds it for its tab's life (the reader worker's `transcoding.onStore`),
   *   and this reader lets its own hold go on one found once it does;
   *   `confirm()`: whether the version the file was opened as still holds
   *   (a source whose reads name no version, `sources/access.js`)
   */
  constructor(identity, size, { environment = globalThis, tab = THIS_TAB, about = null, onStore = null, onChanged = null, confirm = null } = {}) {
    this.identity = identity;
    this.size = size;
    this.filed = keptPartsIdentity(identity, size);
    this._environment = environment;
    this._tab = tab;
    this._about = about ?? keptAbout();
    this._onStore = onStore;
    this._onChanged = onChanged;
    this._confirm = confirm;
    /** The link the reads are measured on, once one read names it: its timeout is the confirmation's quiet window. */
    this._clock = null;
    /** Kept ranges of each object (`SortedRanges`): `{start, end, blob, offset, batch}`. */
    this._objects = new Map();
    /** What is known of each object: `{size: number|null, validator: string|null}`. */
    this._info = new Map();
    if (size !== null) this._info.set('', { size, validator: null });
    /** The objects of a folder its host answered as absent (under a content name they stay so). */
    this._absent = new Set();
    /** Every journal whose ranges are used: `{directory, release, discard, own: boolean}`. */
    this._batches = new Set();
    /** This reader's own journal, once one is begun (a promise of it; null inside when none can be kept). */
    this._journal = null;
    /** Writes run one after another. */
    this._queue = Promise.resolve();
    /** Whether new bytes are still kept (false once storage refused them, or the file changed). */
    this._keeping = true;
    /** Pieces written since the provider last confirmed the version (a source whose reads name none). */
    this._unconfirmed = 0;
    /** Closes the journal once the reads went quiet for the link's retransmission timeout (`_quietMs`). */
    this._closeWhenQuiet = debounce(() => void this.flush(), () => this._quietMs(), { unref: true });
    this._stats = { keptReads: 0, keptBytes: 0, written: 0 };
    this.loaded = false;
    this.ready = null;
  }

  /** How long the reads must have fetched nothing before the provider is asked to confirm: the link's retransmission timeout. */
  _quietMs() {
    return this._clock?.timeoutMs ?? MIN_STALL_TIMEOUT_MS;
  }

  /** The link the reads of the file are measured on (`ResponseClock`): its timeout times the quiet window. */
  measuredBy(clock) {
    if (clock != null && typeof clock.timeoutMs === 'number') this._clock ??= clock;
  }

  /**
   * Find what is kept of the file (under its version, `keptPartsIdentity`)
   * and read every journal's records; resolves once the kept parts may be
   * used (or none are). Never rejects. Once.
   *
   * @returns {Promise<void>}
   */
  open() {
    this.ready ??= this._open().catch(() => {
      this._objects.clear();
    }).finally(() => {
      this.loaded = true;
    });
    return this.ready;
  }

  async _open() {
    let found;
    try {
      found = await findKeptStores(this.filed, this._environment, { tab: this._tab });
    } catch {
      return;
    }
    /** Every kept range of every journal, by object, put in order at once below. */
    const pieces = new Map();
    for (const candidate of found) {
      const { manifest, journal } = candidate;
      const batch = { directory: candidate.directory, release: candidate.release, discard: candidate.discard, own: false };
      const ranges = journal == null ? null : manifest.confirms === true ? journal.ranges.slice(0, journal.confirmed) : journal.ranges;
      // Not a journal of this file's parts, damaged, or holding nothing (its
      // writer stopped before its first piece; pieces never confirmed): removed.
      if (manifest?.kind !== 'parts' || manifest.size !== this.size || ranges === null ||
          (ranges.length === 0 && journal.objects.size === 0 && journal.absent.size === 0) ||
          ![...journal.objects].every(([key, info]) => this._wellFormed(key, info.size, 0, 0)) ||
          ![...journal.absent].every(key => this._wellFormed(key, null, 0, 0)) ||
          !ranges.every(range => this._wellFormed(range.key, journal.objects.get(range.key)?.size ?? null, range.start, range.length))) {
        await settleQuietly(candidate.discard(), 'removing a damaged parts journal');
        continue;
      }
      this._batches.add(batch);
      for (const [key, info] of journal.objects) this._learn(key, info);
      for (const key of journal.absent) this._absent.add(key);
      for (const range of ranges) {
        let list = pieces.get(range.key);
        if (list === undefined) {
          list = [];
          pieces.set(range.key, list);
        }
        list.push({ start: range.start, end: range.start + range.length, blob: range, offset: 0, batch });
      }
      // The page holds it for the tab's life; this reader's hold goes once it does.
      await this._handOver(batch);
    }
    for (const [key, list] of pieces) this._objects.set(key, SortedRanges.of(list));
  }

  /** Whether a kept range of an object (or what is known of the object, `length` 0) fits it: its key and its bytes in the object. */
  _wellFormed(key, objectSize, start, length) {
    if (typeof key !== 'string' || (this.size === null) === (key === '')) return false;
    const size = key === '' ? this.size : objectSize;
    if (key === '' && objectSize !== null && objectSize !== this.size) return false;
    return Number.isSafeInteger(start) && Number.isSafeInteger(length) && start >= 0 && length >= 0 && (size === null || start + length <= size);
  }

  /** Record what is known of an object (a size or a validator learnt keeps the one known); whether anything new was learnt. */
  _learn(key, { size = null, validator = null }) {
    const known = this._info.get(key) ?? { size: null, validator: null };
    const next = { size: known.size ?? size, validator: validator ?? known.validator };
    this._info.set(key, next);
    return next.size !== known.size || next.validator !== known.validator;
  }

  /** What is known of an object: its exact size and the validator its host answered it with, each null when not known. */
  objectInfo(key = '') {
    return this._info.get(key) ?? null;
  }

  /** Whether the host answered an object of the folder as absent (404, 410) when it was read before, under this version. */
  isAbsent(key) {
    return this._absent.has(key);
  }

  /** Keep that the host answered an object of the folder as absent: a later opening of this version asks for it no more. */
  keepAbsent(key) {
    if (!this._keeping || typeof key !== 'string' || key === '' || this.size !== null || this._absent.has(key)) return;
    this._absent.add(key);
    live.add(this);
    this._queue = this._queue.then(() => this._write([], null, key)).catch(() => {});
  }

  /** The page holds a found journal for its tab's life; this reader lets its own hold go then. */
  async _handOver(batch) {
    if (this._onStore === null) return;
    try {
      await this._onStore({ directory: batch.directory, state: 'complete' });
    } finally {
      batch.release();
      batch.release = () => {};
    }
  }

  /** Forget every kept copy of the file (every kind, every version: `space.js` `forgetKeptFile`). */
  async _forgetAll() {
    this._keeping = false;
    this._closeWhenQuiet.cancel();
    this._objects.clear();
    const batches = [...this._batches];
    this._batches.clear();
    for (const batch of batches) batch.release();
    const journal = this._journal;
    this._journal = null;
    live.delete(this);
    // The kept file is forgotten first: a discard that fails cannot keep it.
    await settleQuietly(forgetKeptFile(this.identity, this._environment), 'forgetting the kept copies of a changed file');
    await settleQuietly(journal?.then(open => open?.writer.discard()), 'discarding the parts journal of a changed file');
  }

  /** The kept ranges of an object, made on first need. */
  _rangesOf(key) {
    let ranges = this._objects.get(key);
    if (ranges === undefined) {
      ranges = new SortedRanges();
      this._objects.set(key, ranges);
    }
    return ranges;
  }

  /** Insert one entry of an object (bytes another entry holds are left to it). */
  _insert(key, entry) {
    const ranges = this._rangesOf(key);
    for (const [start, end] of this.missing(entry.start, entry.end, key)) {
      ranges.insert(start === entry.start && end === entry.end ? entry : { ...entry, start, end, offset: entry.offset + (start - entry.start) });
    }
  }

  /** The parts of `[start, end)` of an object no kept range holds, as `[start, end)` pairs, ascending. */
  missing(start, end, key = '') {
    const ranges = this._objects.get(key);
    const out = [];
    let at = start;
    if (ranges !== undefined) {
      for (const entry of ranges.from(start)) {
        if (entry.start >= end || at >= end) break;
        if (entry.start > at) out.push([at, entry.start]);
        at = Math.max(at, entry.end);
      }
    }
    if (at < end) out.push([at, end]);
    return out;
  }

  /** Whether any byte of `[start, end)` of an object is kept. */
  touches(start, end, key = '') {
    const ranges = this._objects.get(key);
    if (ranges === undefined) return false;
    for (const entry of ranges.from(start)) return entry.start < end;
    return false;
  }

  /** The bytes of `[start, end)` of an object still to fetch: those no kept range holds. */
  bytesToFetch(start, end, key = '') {
    let bytes = 0;
    for (const [from, to] of this.missing(start, end, key)) bytes += to - from;
    return bytes;
  }

  /** Every kept byte. */
  keptBytes() {
    let bytes = 0;
    for (const ranges of this._objects.values()) for (const entry of ranges) bytes += entry.end - entry.start;
    return bytes;
  }

  /**
   * The kept bytes `[offset, offset + length)` of an object (every one of
   * them kept: `missing` is empty). A damaged page forgets its journal and
   * rejects with `KeptCopyDamage`: the caller fetches the bytes instead.
   */
  async read(offset, length, key = '') {
    const end = offset + length;
    const pieces = [];
    const ranges = this._objects.get(key);
    if (ranges !== undefined) {
      for (const entry of ranges.from(offset)) {
        if (entry.start >= end) break;
        pieces.push({ entry, from: Math.max(offset, entry.start), to: Math.min(end, entry.end) });
      }
    }
    const covered = pieces.reduce((sum, piece) => sum + piece.to - piece.from, 0);
    if (covered !== length) throw new KeptCopyDamage('The downloaded parts of a file', 0);
    const parts = await Promise.all(pieces.map(async ({ entry, from, to }) => {
      try {
        const bytes = await entry.blob.read(entry.offset + (from - entry.start), to - from);
        if (bytes.length !== to - from) throw new KeptCopyDamage('The downloaded parts of a file', 0);
        return bytes;
      } catch (error) {
        this._forgetBatch(entry.batch);
        throw error instanceof KeptCopyDamage ? error : new KeptCopyDamage('The downloaded parts of a file', 0);
      }
    }));
    this._stats.keptReads++;
    this._stats.keptBytes += length;
    if (parts.length === 1) return parts[0];
    const out = allocateTypedArray(Uint8Array, length, 'Kept bytes');
    pieces.forEach((piece, i) => out.set(parts[i], piece.from - offset));
    return out;
  }

  /** A journal found damaged: its ranges are not used again, and it is removed once nobody holds it. */
  _forgetBatch(batch) {
    if (!this._batches.has(batch)) return;
    this._batches.delete(batch);
    for (const ranges of this._objects.values()) ranges.retain(entry => entry.batch !== batch);
    if (batch.own) {
      // This reader's own: what is kept from here on goes to a new journal.
      const journal = this._journal;
      this._journal = null;
      void settleQuietly(journal?.then(open => open?.writer.discard()), 'discarding a damaged parts journal');
      return;
    }
    void settleQuietly(batch.discard?.(), 'discarding a damaged parts journal');
  }

  /**
   * Keep bytes fetched of an object at `start` (only those no kept range
   * holds), with what its host said of the object (`size`: its exact size,
   * when known; `validator`: its ETag or Last-Modified). Written in the
   * background as they arrive, one write after another; never throws.
   */
  keep(start, bytes, key = '', { size = null, validator = null } = {}) {
    if (!this._keeping || !(bytes instanceof Uint8Array) || bytes.length === 0) return;
    const learnt = this._learn(key, { size, validator }) && key !== '';
    const pieces = this.missing(start, start + bytes.length, key)
      .map(([from, to]) => ({ key, start: from, bytes: bytes.slice(from - start, to - start) }));
    if (pieces.length === 0 && !learnt) return;
    // A write asked for is one `flushKeptParts` waits for.
    live.add(this);
    this._queue = this._queue.then(() => this._write(pieces, learnt ? key : null)).catch(() => {});
  }

  /** This reader's journal, begun on first need; null inside when nothing more can be kept here. */
  _ownJournal() {
    if (!this._keeping) return Promise.resolve(null);
    this._journal ??= (async () => {
      const writer = await openKeptJournal(this.filed, {
        environment: this._environment,
        tab: this._tab,
        manifest: {
          kind: 'parts',
          // The file it is of, by its identity's digest: the Session panel lists a file once.
          source: await identityDigest(this.identity),
          about: this._about,
          size: this.size,
          // Its pieces are used only as far as a confirmation follows them.
          ...(this._confirm === null ? {} : { confirms: true }),
        },
      }).catch(() => null);
      if (writer === null) {
        this._keeping = false;
        return null;
      }
      // The file changed (every kept copy forgotten) while it was begun.
      if (!this._keeping) {
        await settleQuietly(writer.discard(), 'discarding a journal begun as its file changed');
        return null;
      }
      const batch = { directory: writer.directory, release: () => writer.release(), discard: () => writer.discard(), own: true };
      this._batches.add(batch);
      // Kept from its manifest on: the page holds it for its tab's life
      // beside this writer, which holds it until it closes.
      void Promise.resolve(this._onStore?.({ directory: writer.directory, state: 'complete' })).catch(() => {});
      return { writer, batch, reader: { read: async (offset, length) => writer.read(offset, length) } };
    })();
    return this._journal;
  }

  async _write(pieces, infoKey, absentKey = null) {
    if (!this._keeping) return;
    const journal = await this._ownJournal();
    if (journal === null || !this._keeping || !this._batches.has(journal.batch)) return;
    const { writer, batch, reader } = journal;
    try {
      if (absentKey !== null) await writer.appendAbsent(absentKey);
      if (infoKey !== null) await writer.appendObject(infoKey, this._info.get(infoKey));
      for (const piece of pieces) {
        // Kept since it was asked for (another read of the same bytes): only what is still missing.
        for (const [from, to] of this.missing(piece.start, piece.start + piece.bytes.length, piece.key)) {
          const offset = await writer.appendRange(piece.key, from, piece.bytes.subarray(from - piece.start, to - piece.start));
          this._stats.written += to - from;
          this._unconfirmed++;
          this._insert(piece.key, { start: from, end: to, blob: reader, offset, batch });
        }
      }
    } catch {
      // Refused for room (or the journal was let go): what is written is kept, nothing more.
      this._keeping = false;
      return;
    }
    // Once the reads go quiet for the link's retransmission timeout, the
    // journal is closed: another reader (a tab, the next generation of this
    // dataset in another worker) reads a journal only once its writer closed it.
    this._closeWhenQuiet();
  }

  /**
   * After every write asked for so far, close this reader's journal: a
   * source whose reads name no version has its provider confirm the version
   * still holds first (recorded in the journal: a later opening uses only
   * what a confirmation follows), the disk is asked to hold what is written,
   * and the journal is never appended to again (another reader may read it
   * now: its bytes do not change under it); the next piece fetched begins a
   * new one. Asked once the reads go quiet, when the page is hidden or left
   * (`flushKeptParts`) and when the reader closes. Never throws.
   */
  flush() {
    const run = this._queue.then(() => this._closeOwn());
    this._queue = run.catch(() => {});
    return run.catch(() => {});
  }

  async _closeOwn() {
    this._closeWhenQuiet.cancel();
    const pending = this._journal;
    const journal = await pending;
    if (journal == null || this._journal !== pending) return;
    this._journal = null;
    if (!this._batches.has(journal.batch)) return;
    if (this._confirm !== null && this._unconfirmed > 0) {
      // A version only its provider can vouch for is kept once it does.
      if (!(await this._confirm().catch(() => false))) {
        await settleQuietly(journal.writer.discard(), 'discarding parts of a version its provider did not confirm');
        this.changed();
        return;
      }
      await journal.writer.appendConfirmed().catch(() => {});
      this._unconfirmed = 0;
    }
    journal.writer.close();
    // Its bytes are read from its file from now on; it is no longer this reader's to write.
    const blob = await journal.writer.reader().catch(() => null);
    const { batch } = journal;
    batch.own = false;
    batch.discard = () => journal.writer.discard();
    if (blob === null) {
      this._forgetBatch(batch);
      return;
    }
    for (const ranges of this._objects.values()) for (const entry of ranges) if (entry.batch === batch) entry.blob = blob;
  }

  /** The file changed on its host while open: every kept copy of it is stale. */
  changed() {
    if (!this._keeping && this.keptBytes() === 0) return;
    void settleQuietly(this._forgetAll(), 'forgetting the kept copies of a changed file');
    this._onChanged?.();
  }

  /** Have every write made and held, close the journal, stop keeping, and let every hold go (the reader closed). */
  async close() {
    await this.flush();
    this._keeping = false;
    this._closeWhenQuiet.cancel();
    live.delete(this);
    for (const batch of this._batches) batch.release();
  }

  /** What this reader read from and wrote to the kept parts. */
  stats() {
    return { ...this._stats, held: this.keptBytes() };
  }
}

/**
 * Whether a link is read from this machine (a loopback address: `cellucid
 * serve`, a tunnel to it) or a notebook kernel (`EMBEDDED_HOST_ORIGIN`): a
 * copy of what it answers spares no download, and costs a second copy on
 * the same disk.
 */
function sameMachine(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.origin === EMBEDDED_HOST_ORIGIN || url.protocol === 'file:') return true;
  return isLoopbackHostname(url.hostname);
}

/**
 * The kept parts of one remote file, or null when nothing of it is kept:
 * its identity names no version (`keepsParts`); it is read from this
 * machine or a notebook kernel (`sameMachine`), or its source says so
 * (`keptParts: false`: a store a Python or R server serves, whose version
 * may be new for every run); or `keep` is false (a file a transcoder
 * reads whole: its converted store is kept instead).
 *
 * @param {{url: string, size: number|null, name?: string, identity?: Object|null}} file - `size`
 *   null: a store folder on a web host, whose objects are kept
 * @param {{keep?: boolean, environment?: Object, tab?: string,
 *   onStore?: Function|null, onChanged?: Function|null, confirm?: (() => Promise<boolean>)|null}} [options]
 *   `confirm`: a provider's check that the version opened still holds (`KeptParts`)
 * @returns {KeptParts|null}
 */
export function keptPartsOf(file, { keep = true, environment = globalThis, tab = THIS_TAB, onStore = null, onChanged = null, confirm = null } = {}) {
  const identity = file?.identity ?? null;
  // A folder of objects has no size of its own (`size` null).
  const size = file?.size ?? null;
  if (!keep || file?.keptParts === false || sameMachine(file?.url) || !keepsParts(identity) ||
      (size !== null && !(Number.isSafeInteger(size) && size > 0))) return null;
  return new KeptParts(identity, size, {
    environment,
    tab,
    about: keptAbout({ name: file.name ?? null, url: file.url ?? null }),
    onStore,
    onChanged,
    confirm,
  });
}

/**
 * `source` (a remote file's byte source), its kept parts written through:
 * every range it fetches is kept (`KeptParts.keep`), and its `kept` is what
 * the byte reader reads kept bytes from, and plans around
 * (`byte-reader.js`). A read refused because the file changed on its host
 * (`CHANGED`) forgets every kept copy of the file first. Without kept
 * parts, `source` itself.
 *
 * @param {import('./byte-source.js').ByteSource} source
 * @param {KeptParts|null} parts
 * @param {{head?: Uint8Array|null}} [options] - The file's first bytes, read
 *   from its host for this opening (beside the probe of its size): kept
 * @returns {import('./byte-source.js').ByteSource}
 */
export function withKeptParts(source, parts, { head = null } = {}) {
  if (parts === null) return source;
  parts.open();
  if (head instanceof Uint8Array && head.length > 0) void parts.ready.then(() => parts.keep(0, head));
  const read = async (offset, length, options = {}) => {
    parts.measuredBy(options.link?.responses);
    let bytes;
    try {
      bytes = await source.read(offset, length, options);
    } catch (error) {
      if (error?.code === BYTE_SOURCE_FAILURES.CHANGED) parts.changed();
      throw error;
    }
    // Bytes read once (a cell export's, a copy of the dataset's: `keepInMemory`
    // false, `ReadActivity.readOnce`) are kept neither in the page's memory
    // nor here: a whole-file pass would fill this browser's room with what
    // no view reads again, and push out what views do.
    if (options.keepInMemory !== false) parts.keep(offset, bytes);
    return bytes;
  };
  return Object.freeze({ ...source, read, kept: parts });
}

/**
 * Ask a remote file's source for its version now, before anything kept of
 * it is used: what a reader opened again without a new description of the
 * file runs (a dataset read again after its reader was ended -- no longer
 * shown, the page back from the back/forward cache -- from the description
 * of its first opening). An opening from a source's own description needs
 * none: the description is that check, made in the same opening (the probe
 * or the provider's answer, `data/sources`). One small request:
 *
 * - a source whose reads name no version (Google Drive's public reads, a
 *   OneDrive download address: `access.confirmVersion`) asks its provider;
 * - a file served only whole (`downloaded`) asks its host for its validators
 *   (a `HEAD`), which must be those it was described with;
 * - any other reads its first byte from the host, past every kept copy and
 *   the page's memory, under the validators it was described with
 *   (`httpByteSource`: another `ETag`, `Last-Modified` or size is `CHANGED`;
 *   a revision gone, `access.isChanged`).
 *
 * A version that no longer holds forgets every kept copy of the file
 * (`forgetKeptFile`) and fails as `CHANGED`: opened again, the file is
 * described anew.
 *
 * @param {{url: string, size: number, name?: string, identity?: Object|null, etag?: string|null,
 *   lastModified?: string|null, head?: {etag?: string|null}|null, downloaded?: Blob}} file
 * @param {{access?: Object|null, environment?: Object, signal?: AbortSignal|null, fetch?: typeof fetch,
 *   onChanged?: (() => void)|null}} [options]
 *   `access`: the file's access (`sourceAccess`), when it names one
 * @returns {Promise<number|null>} How long the host took to answer the
 *   check, in milliseconds (null: its provider was asked): a fresh measure
 *   of the link the file is read over
 */
export async function confirmFileVersion(file, { access = null, environment = globalThis, signal = null, fetch: fetchImpl = routedFetch, onChanged = null } = {}) {
  const name = file.name ?? file.url;
  const changed = async () => {
    await forgetKeptFile(file.identity ?? null, environment).catch(() => {});
    onChanged?.();
    return new ByteSourceError(
      BYTE_SOURCE_FAILURES.CHANGED,
      `${name} changed on its host since it was opened; open it again to read the new version.`,
      { url: file.url }
    );
  };
  if (typeof access?.confirmVersion === 'function') {
    if (!(await access.confirmVersion())) throw await changed();
    return null;
  }
  const started = performance.now();
  const etag = file.head?.etag ?? file.etag ?? null;
  const lastModified = file.lastModified ?? null;
  if (file.downloaded !== undefined) {
    const { response } = await fetchOnce(file.url, { method: 'HEAD', cache: 'no-store' }, { fetchImpl, signal, wantsBody: () => false });
    // Compared as a whole download's are (`downloadRemoteFile`): its date,
    // else its ETag without a weak mark.
    const strip = value => value.replace(/^W\//i, '');
    const tag = response.headers.get('ETag');
    const modified = response.headers.get('Last-Modified');
    const moved = !response.ok || (lastModified !== null
      ? modified !== null && modified !== lastModified
      : etag !== null && tag !== null && strip(tag) !== strip(etag));
    if (moved) throw await changed();
    return performance.now() - started;
  }
  try {
    await httpByteSource(
      { url: file.url, size: file.size, name: file.name, identity: file.identity ?? null, etag, lastModified },
      { fetch: fetchImpl, ...(access === null ? {} : { access }) }
    ).read(0, Math.min(1, file.size), { signal });
  } catch (error) {
    if (error?.code === BYTE_SOURCE_FAILURES.CHANGED) throw await changed();
    throw error;
  }
  return performance.now() - started;
}
