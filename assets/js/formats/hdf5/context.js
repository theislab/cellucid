/**
 * One open HDF5 file: its byte reader, the sizes its superblock declares,
 * and the bounds-checked reads every other module makes through it.
 *
 * Addresses in an HDF5 file are relative to the base address (the
 * superblock's position, after any user block). Every read is checked
 * against the file's size before it is made, so a corrupt pointer becomes an
 * `Hdf5FormatError` naming the structure, never an out-of-range read.
 *
 * Metadata (headers, B-tree nodes, heaps, index blocks) is read with the
 * byte reader's block cache; raw data (chunks, contiguous storage) is read
 * exactly and never cached there.
 *
 * @module formats/hdf5/context
 */

import { Cursor } from './binary.js';
import { hasValidChecksum } from './checksum.js';
import { formatError } from './errors.js';
import { ByteBudget, ByteCache } from './lru.js';
import { SharedWorks } from '../io/abort.js';
import { formatCountOf } from '../../utils/format-units.js';

const MiB = 1024 * 1024;

/**
 * Chunks decompressed at once per file: enough to keep every core busy,
 * few enough that their native buffers stay small (measured: 16 decodes as
 * fast as 64 and holds about 40 MiB less).
 */
const DECOMPRESSIONS_AT_ONCE = 16;

/** Stored bytes of neighbouring chunks fetched and decoded as one group. */
export const CHUNK_GROUP_BYTES = 4 * MiB;

/** Byte reader options; `activity` (a caller's per-read tally) is passed on when given. */
function readOptions(cache, signal, activity) {
  return activity ? { cache, signal, activity } : { cache, signal };
}

export class FileContext {
  /**
   * @param {import('../io/byte-reader.js').ByteReader} reader
   * @param {{decodedChunkCacheBytes?: number|import('../io/decoded-budget.js').DecodedBudget, verifyChecksums?: boolean}} [options]
   */
  constructor(reader, { decodedChunkCacheBytes = 64 * MiB, verifyChecksums = true } = {}) {
    this.reader = reader;
    this.size = reader.size;
    this.name = reader.name;
    this.base = 0;
    this.offsetSize = 8;
    this.lengthSize = 8;
    this.verifyChecksums = verifyChecksums;
    /** Group and chunk B-tree 'K' values (defaults until the superblock says otherwise). */
    this.btreeK = { groupLeaf: 4, groupInternal: 16, chunk: 32 };
    /** Decoded chunks and parsed global heap collections, by key. */
    this.cache = new ByteCache(decodedChunkCacheBytes);
    /**
     * Loads of shared metadata in progress (global heap collections), by
     * key: one load however many reads ask, stopped only once every one of
     * them withdrew (`SharedWorks`).
     */
    this.loading = new SharedWorks();
    /** Chunk fetch-and-decodes in progress, shared by concurrent reads. */
    this.inflight = new Map();
    /**
     * The weight (stored plus decoded bytes) of the largest chunk group and
     * of the largest chunk a read has asked for, which the decode budget
     * follows (`noteGroup`).
     */
    this.largestGroupWeight = 0;
    this.largestChunkWeight = 0;
    /**
     * Chunk bytes in flight across all reads (fetched and being decoded):
     * twice what keeps the link full -- its bandwidth-delay product as
     * measured (`formats/io/link.js`), and at least a 4 MiB group per
     * connection of the source's prior -- and twice what keeps the decoders
     * busy: every decompression slot with a chunk, and the next group
     * fetched while one decodes (Suo's 1,580 expression chunks, Chromium:
     * read in 210 ms at the link's budget alone, 175 ms at this one, against
     * 121 ms of decoding them all at once). A remote link stays full and every decoder works,
     * while memory stays bounded however many reads run.
     */
    const policy = reader.source?.policy ?? { concurrency: 4 };
    const link = reader.link ?? null;
    const decodeBudgetBytes = () => Math.max(16 * MiB,
      2 * Math.max(link?.roundTripBytes ?? 0, policy.concurrency * CHUNK_GROUP_BYTES,
        this.largestGroupWeight, DECOMPRESSIONS_AT_ONCE * this.largestChunkWeight));
    // Reads a view waits for take room before background work (a gene index
    // built ahead of need), which also leaves one decompression free for them.
    this.decodeBudget = new ByteBudget(decodeBudgetBytes);
    /** Chunks being decompressed at once (each decompressor holds native buffers). */
    this.decodeSlots = new ByteBudget(DECOMPRESSIONS_AT_ONCE, { waves: false, reserve: 1 });
    this.closed = false;
    /** The file itself, under no read's activity (`withActivity`). */
    this.unscoped = this;
    /** Reads made through the file itself are not background work. */
    this.background = false;
  }

  /**
   * A read is about to fetch a chunk group of `weight` bytes (stored plus
   * decoded) whose chunks weigh `chunkWeight` each: the decode budget grows
   * to hold it (`decodeBudget`).
   */
  noteGroup(weight, chunkWeight) {
    // On the file itself: a view (`withActivity`) is never assigned to.
    const file = this.unscoped;
    if (weight > file.largestGroupWeight) file.largestGroupWeight = weight;
    if (chunkWeight > file.largestChunkWeight) file.largestChunkWeight = chunkWeight;
  }

  /**
   * This file with `activity` (a caller's per-read tally, passed on to the
   * byte reader) attached to every read made through it. The view shares
   * every property with the file; it is only read from, never assigned to.
   */
  withActivity(activity) {
    // A view of a view reads under its own activity, not its parent's.
    const file = this.unscoped;
    if (!activity) return file;
    const scoped = Object.create(file);
    scoped.meta = (address, length, what, signal = null) => file.meta(address, length, what, signal, activity);
    scoped.metaUpTo = (address, length, what, signal = null) => file.metaUpTo(address, length, what, signal, activity);
    scoped.data = (address, length, what, signal = null) => file.data(address, length, what, signal, activity);
    scoped.dataUpTo = (address, length, what, signal = null) => file.dataUpTo(address, length, what, signal, activity);
    /** Whether the reads made through this view are background work. */
    scoped.background = activity.background === true;
    return scoped;
  }

  /**
   * How reads are shaped into requests now: the link's merge gap and request
   * size as measured (`formats/io/link.js`), the source's prior until then.
   * @returns {{mergeGapBytes: number, maxRequestBytes: number}}
   */
  get shaping() {
    return this.reader.link ?? this.reader.source.policy;
  }

  /** Absolute file offset of `address`. */
  absolute(address) {
    return this.base + address;
  }

  /**
   * Check that `length` bytes at `address` lie inside the file; returns the
   * absolute offset.
   */
  requireRange(address, length, what) {
    if (address === null || address === undefined) {
      throw formatError(what, NaN, 'its address is undefined');
    }
    if (!Number.isSafeInteger(address) || address < 0 || !Number.isSafeInteger(length) || length < 0) {
      throw formatError(what, address, `cannot read ${formatCountOf(length, 'byte')} at address ${address}`);
    }
    const start = this.base + address;
    if (start + length > this.size) {
      throw formatError(what, start, `${formatCountOf(length, 'byte')} run past the end of the ${this.size}-byte file`);
    }
    return start;
  }

  requireOpen() {
    if (this.closed) throw new Error(`${this.name} has been closed.`);
  }

  /** Read metadata (cached in blocks). */
  meta(address, length, what, signal = null, activity = null) {
    const start = this.requireRange(address, length, what);
    return this.reader.read(start, length, readOptions(true, signal, activity));
  }

  /** Read up to `length` bytes of metadata, fewer when the file ends first. */
  metaUpTo(address, length, what, signal = null, activity = null) {
    const start = this.requireRange(address, 0, what);
    return this.reader.read(start, Math.min(length, this.size - start), readOptions(true, signal, activity));
  }

  /** Read raw data (exact, not cached). */
  data(address, length, what, signal = null, activity = null) {
    const start = this.requireRange(address, length, what);
    return this.reader.read(start, length, readOptions(false, signal, activity));
  }

  /**
   * Read up to `length` bytes exactly (not cached), fewer when the file ends
   * first: a structure that lies among bulk data (a chunk index node), where
   * a cached block would fetch mostly chunk bytes around it.
   */
  dataUpTo(address, length, what, signal = null, activity = null) {
    const start = this.requireRange(address, 0, what);
    return this.reader.read(start, Math.min(length, this.size - start), readOptions(false, signal, activity));
  }

  /** A cursor over `bytes` read from `address`, with this file's sizes. */
  cursor(bytes, address, label, position = 0) {
    return new Cursor(bytes, {
      fileOffset: this.base + address,
      label,
      offsetSize: this.offsetSize,
      lengthSize: this.lengthSize,
      position,
    });
  }

  /** Require the trailing lookup3 checksum of a newer-format structure. */
  checkChecksum(bytes, address, what) {
    if (this.verifyChecksums && !hasValidChecksum(bytes)) {
      throw formatError(what, this.base + address, 'its checksum does not match; the file is corrupt');
    }
  }
}

export { MiB };
