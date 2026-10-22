/**
 * @fileoverview The downloaded bytes of gene payloads, kept for the dataset
 * load that fetched them.
 *
 * A gene's decoded values are 4 bytes per cell and leave memory under the
 * field residency budget; its download is the compressed payload, usually a
 * hundredth of that or less. Keeping the download means a gene that was
 * evicted — every gene of a differential expression run is, one after another
 * — is decoded again from memory instead of being requested again: each such
 * request is a round trip even when the server answers 304, and a second run
 * over 5,000 genes was 5,000 of them.
 *
 * The cache belongs to one dataset load (the var field loader that created
 * it), so it holds bytes of exactly the export generation whose manifests
 * describe them, and is dropped with that load. Every request inside the load
 * is still revalidated with the origin the first time (see
 * `DATASET_ARTIFACT_CACHE`). Across loads and sessions the browser's HTTP cache
 * holds the bytes; skipping the revalidation needs a content identity in the
 * manifests (plans/network-performance.md, format v4).
 *
 * `fetch` is the one way a payload is downloaded into the cache: it returns a
 * copy of the kept bytes, joins a download of the same payload already under
 * way, or starts one. A long run downloads its next genes this way ahead of
 * decoding them (`decode: false`), so how many requests are in flight no
 * longer depends on how many decoded genes fit in memory.
 *
 * Bytes are counted against one budget. A download that evicts (one the user
 * asked for, or a long run's download ahead of decoding, which must survive
 * until it is decoded) makes room by dropping the least recently used entries;
 * one that does not (a long run's gene decoded at once) is kept only while
 * there is room, so a run over more genes than fit keeps its first ones instead
 * of evicting each just before the next run asks for it again, as a plain LRU
 * does on every repeated scan.
 *
 * @module data/payload-transfer-cache
 */

/** Bytes of downloaded payloads one dataset load keeps. */
export const PAYLOAD_TRANSFER_CACHE_BYTES = 64 * 1024 * 1024;

/**
 * @typedef {{bytes: Uint8Array, gzipOutputBytes: number|null}} BinaryTransfer
 */

export class PayloadTransferCache {
  /**
   * @param {number} [budgetBytes]
   */
  constructor(budgetBytes = PAYLOAD_TRANSFER_CACHE_BYTES) {
    if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 0) {
      throw new TypeError('A payload cache budget must be a non-negative integer.');
    }
    this._budget = budgetBytes;
    this._bytes = 0;
    /** @type {Map<string, BinaryTransfer>} Least recently used first. */
    this._entries = new Map();
    /** @type {Map<string, Promise<BinaryTransfer>>} Downloads under way. */
    this._pending = new Map();
  }

  /** The byte budget. */
  get budget() {
    return this._budget;
  }

  /** Bytes kept. */
  get byteLength() {
    return this._bytes;
  }

  /** Payloads kept. */
  get size() {
    return this._entries.size;
  }

  /** Whether the payload is kept. */
  has(key) {
    return this._entries.has(key);
  }

  /**
   * The payload of `key`: the kept download, the download already under way,
   * or a new one (`start`), kept as `evict` allows.
   *
   * A caller that joined a download another caller then cancelled downloads
   * again under its own signal, so one caller's cancellation never fails
   * another.
   *
   * @param {string} key
   * @param {{evict: boolean, decode?: boolean}} use - `evict`: whether a new
   *   download may drop older entries to be kept; `decode: false` asks only
   *   that the payload be kept (nothing is copied out)
   * @param {AbortSignal|null} signal - This caller's
   * @param {() => Promise<BinaryTransfer>} start - Downloads the payload
   * @returns {Promise<BinaryTransfer|{kept: boolean, byteLength: number}>} The
   *   caller's own copy, or with `decode: false` whether the payload is kept
   */
  async fetch(key, use, signal, start) {
    const { evict, decode = true } = use;
    if (typeof evict !== 'boolean' || typeof decode !== 'boolean') {
      throw new TypeError('A payload fetch needs exactly boolean evict and decode.');
    }
    for (;;) {
      const kept = this._entries.get(key);
      if (kept !== undefined) {
        this._touch(key, kept);
        return decode ? copyOf(kept) : { kept: true, byteLength: kept.bytes.byteLength };
      }
      let pending = this._pending.get(key);
      const own = pending === undefined;
      if (own) {
        pending = Promise.resolve().then(start);
        this._pending.set(key, pending);
        pending.then(
          transfer => {
            if (this._pending.get(key) === pending) this._pending.delete(key);
            this._keep(key, transfer, evict);
          },
          () => {
            if (this._pending.get(key) === pending) this._pending.delete(key);
          }
        );
      }
      let transfer;
      try {
        transfer = await pending;
      } catch (error) {
        if (!own && error?.name === 'AbortError' && signal?.aborted !== true) continue;
        throw error;
      }
      signal?.throwIfAborted();
      return decode
        ? copyOf(transfer)
        : { kept: this._entries.has(key), byteLength: transfer.bytes.byteLength };
    }
  }

  _touch(key, entry) {
    this._entries.delete(key);
    this._entries.set(key, entry);
  }

  /** Keep a download the cache started (its bytes are the cache's own). */
  _keep(key, transfer, evict) {
    const { bytes } = transfer;
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError('A cached payload must be a Uint8Array.');
    }
    const size = bytes.byteLength;
    if (size > this._budget || this._entries.has(key)) return;
    if (this._bytes + size > this._budget) {
      if (!evict) return;
      for (const [oldKey, old] of this._entries) {
        if (this._bytes + size <= this._budget) break;
        this._entries.delete(oldKey);
        this._bytes -= old.bytes.byteLength;
      }
    }
    this._entries.set(key, transfer);
    this._bytes += size;
  }

  clear() {
    this._entries.clear();
    this._pending.clear();
    this._bytes = 0;
  }
}

function copyOf(transfer) {
  return { bytes: transfer.bytes.slice(), gzipOutputBytes: transfer.gzipOutputBytes };
}
