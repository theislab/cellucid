/**
 * @fileoverview Byte-bounded cache of decoded dense-matrix storage blocks.
 *
 * A dense expression matrix that is too large to hold in memory is read one
 * gene (column) at a time. Its storage blocks (Zarr chunks, HDF5 chunks) span
 * many columns, and a compressed block can only be decoded whole, so reading
 * one column decodes every block of the column strip it lies in. Without a
 * cache, every gene of the same strip decodes the same blocks again; with
 * row-wise chunking (one strip spanning every column) every gene decodes the
 * whole matrix.
 *
 * This cache keeps decoded blocks so that consecutive reads sharing a strip
 * decode each block once:
 *
 * - Retained bytes are bounded (the `decodedBlocks` residency budget of
 *   `memory-budget.js` by default, a share of the reported device memory) and
 *   counted by each block's underlying `ArrayBuffer`, so a view onto a larger
 *   buffer cannot under-report what it keeps alive.
 * - Eviction is least-recently-used, but a block never evicts a block of its
 *   own strip. A strip larger than the budget therefore keeps a stable
 *   resident prefix that every later read of that strip hits, instead of a
 *   sequential scan evicting each block just before it is needed again.
 * - Concurrent reads of one block share a single in-flight decode.
 * - A failed decode is never stored: every waiter receives the failure and the
 *   next read decodes afresh.
 * - `clear()` drops every block and detaches every in-flight decode, whose
 *   result is then returned to its waiters but never stored. Owners call it
 *   whenever the dataset is closed or replaced.
 *
 * @module data/decoded-block-cache
 */

import { residencyBudgetBytes } from './memory-budget.js';

function retainedByteLength(block) {
  if (!ArrayBuffer.isView(block)) {
    throw new TypeError('A decoded matrix block must be a typed array view.');
  }
  return block.buffer.byteLength;
}

export class DecodedBlockCache {
  /**
   * @param {number} [maxBytes] - Residency budget; a share of device memory by default
   */
  constructor(maxBytes = residencyBudgetBytes('decodedBlocks')) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError(
        'Decoded block cache budget must be a non-negative safe integer.'
      );
    }
    this._maxBytes = maxBytes;
    /** @type {Map<string, {block: ArrayBufferView, bytes: number, strip: string}>} LRU order, oldest first */
    this._entries = new Map();
    /** @type {Map<string, Promise<ArrayBufferView>>} */
    this._pending = new Map();
    this._bytes = 0;
    this._epoch = 0;
  }

  /** The decoded bytes this cache may retain (its residency budget). */
  get capacityBytes() {
    return this._maxBytes;
  }

  /** Decoded bytes currently retained. */
  get retainedBytes() {
    return this._bytes;
  }

  /** Number of retained blocks. */
  get size() {
    return this._entries.size;
  }

  /** Number of decodes currently in flight. */
  get pendingCount() {
    return this._pending.size;
  }

  /**
   * Return one decoded block, decoding it only when it is neither retained
   * nor already being decoded.
   *
   * @param {string} key - Identity of the block within the current dataset
   * @param {string} strip - Identity of the column strip the block belongs to
   * @param {() => Promise<ArrayBufferView>|ArrayBufferView} decode
   * @returns {Promise<ArrayBufferView>}
   */
  read(key, strip, decode) {
    if (typeof key !== 'string' || typeof strip !== 'string') {
      throw new TypeError('Decoded block key and strip must be strings.');
    }
    if (typeof decode !== 'function') {
      throw new TypeError('Decoded block read requires a decode function.');
    }
    const entry = this._entries.get(key);
    if (entry !== undefined) {
      this._entries.delete(key);
      this._entries.set(key, entry);
      return Promise.resolve(entry.block);
    }
    const pending = this._pending.get(key);
    if (pending !== undefined) return pending;

    const epoch = this._epoch;
    const load = Promise.resolve()
      .then(decode)
      .then(
        block => {
          const bytes = retainedByteLength(block);
          if (this._pending.get(key) === load) this._pending.delete(key);
          if (epoch === this._epoch) this._admit(key, strip, block, bytes);
          return block;
        },
        error => {
          if (this._pending.get(key) === load) this._pending.delete(key);
          throw error;
        }
      );
    this._pending.set(key, load);
    return load;
  }

  _admit(key, strip, block, bytes) {
    if (bytes > this._maxBytes) return;
    while (this._bytes + bytes > this._maxBytes) {
      let victimKey = null;
      for (const [candidateKey, candidate] of this._entries) {
        if (candidate.strip !== strip) {
          victimKey = candidateKey;
          break;
        }
      }
      // Only this strip's own blocks remain: keep its resident prefix.
      if (victimKey === null) return;
      this._bytes -= this._entries.get(victimKey).bytes;
      this._entries.delete(victimKey);
    }
    this._entries.set(key, { block, bytes, strip });
    this._bytes += bytes;
  }

  /** Release every retained block and detach every in-flight decode. */
  clear() {
    this._epoch++;
    this._entries.clear();
    this._pending.clear();
    this._bytes = 0;
  }
}
