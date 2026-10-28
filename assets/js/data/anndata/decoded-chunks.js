/**
 * Whole decoded chunks of a store's arrays, which a subsample's view reads
 * its kept rows through (`views/cell-subset.js`, `gatheredArray`): one
 * chunk decoded serves every kept row in it, in this read and the next.
 *
 * A subsample's cells lie across the whole file (uniform, blocks), so every
 * step of a progressive opening's growth (`progressive-open.js`) reads, for
 * its added cells, rows of nearly every chunk an earlier step already
 * decoded: HLCA's 1 % blocks share decoded the 182 chunks of `X_umap` again
 * at its last step (7.8 MB, mostly page-cache hits, 575 ms). Here each chunk
 * a read decodes is kept, so a later step, or a column read again, copies
 * its rows out of it instead of decoding it again.
 *
 * Kept by recency within the store's decoded-chunk budget
 * (`memory-budget.js`, `decodedBlocks`), shared with the store's own cache
 * of decoded chunks (`formats/io/decoded-budget.js`): together they hold no
 * more than it. A chunk evicted is decoded again when asked for, nothing
 * else changes. The chunks are a store's, keyed by array path, column range
 * and chunk, so they serve every opening of that store
 * (`AnnDataReader.open`, `carry`).
 *
 * Every opening reading through them holds them (`retain`, `release`): two
 * openings of the same store may be live at once (a reopen in flight while
 * the open one still reads), and the chunks go only when the last of them
 * lets go. A chunk being decoded is shared by every read asking for it
 * (`SharedWorks`): its decode stops only once every one of them withdrew,
 * so a read cancelled never fails another.
 *
 * @module data/anndata/decoded-chunks
 */

import { DecodedBudget } from '../../formats/io/decoded-budget.js';
import { SharedWorks } from '../../formats/io/abort.js';

/** Bytes a decoded block holds (a plain array, of strings, counted at a pointer a value). */
function blockBytes(block) {
  return ArrayBuffer.isView(block) ? block.byteLength : 8 * (block?.length ?? 0);
}

export class DecodedChunks {
  /**
   * @param {number|DecodedBudget} budget - The most the kept chunks hold, or
   *   the store's decoded-chunk budget, shared with its own cache
   */
  constructor(budget) {
    if (typeof budget === 'number' && !(budget >= 0)) throw new RangeError(`Decoded chunks are kept within a budget of 0 or more bytes, not ${budget}.`);
    this._budget = DecodedBudget.of(budget);
    this.bytes = 0;
    /** Chunks decoded through `get` (not served from the kept ones). */
    this.decoded = 0;
    /** @type {Map<string, {block: any, bytes: number}>} Most recently used last. */
    this._kept = new Map();
    /** Chunks being decoded, shared by every read asking for them. */
    this._decoding = new SharedWorks();
    /** The openings holding these chunks (`retain`, `release`). */
    this._holders = 1;
    this._budget.attach(this);
  }

  /** The most the kept chunks, and the store's own cache beside them, hold. */
  get budgetBytes() {
    return this._budget.budgetBytes;
  }

  /**
   * The decoded chunk `key`: kept, or `decode(options)`d now (and kept
   * within the budget). Concurrent asks for one chunk share its decode,
   * which runs with a signal of its own (in the options it is given): it
   * stops once every ask withdrew (`options.signal`), never before.
   *
   * @param {string} key
   * @param {(options: Object) => Promise<any>} decode
   * @param {Object} [options] - The asking read's options (`signal`, `activity`)
   * @returns {Promise<any>}
   */
  get(key, decode, options = {}) {
    const kept = this._kept.get(key);
    if (kept !== undefined) {
      this._kept.delete(key);
      this._kept.set(key, kept);
      return Promise.resolve(kept.block);
    }
    return this._decoding.run(key, async decodeOptions => {
      this.decoded++;
      const block = await decode(decodeOptions);
      const bytes = blockBytes(block);
      // Alone more than the budget: it serves its reads and is not kept.
      if (bytes <= this._budget.budgetBytes && !this._kept.has(key)) {
        this._kept.set(key, { block, bytes });
        this.bytes += bytes;
        this._budget.settle(this);
      }
      return block;
    }, options);
  }

  /**
   * Let the least recently used kept chunk go, never the most recent (the
   * one just kept); false when there is none other.
   */
  evictOldest() {
    if (this._kept.size <= 1) return false;
    const [key, entry] = this._kept.entries().next().value;
    this._kept.delete(key);
    this.bytes -= entry.bytes;
    return true;
  }

  /** Let every kept chunk go (a cache cleared); later reads keep theirs again. */
  clear() {
    this._kept.clear();
    this.bytes = 0;
  }

  /** One more opening holds these chunks (returned, for chaining). */
  retain() {
    if (this._holders === 0) throw new Error('Decoded chunks let go by every opening are not held again.');
    this._holders++;
    return this;
  }

  /**
   * One opening lets go of these chunks. Once the last has, every kept chunk
   * goes and none is kept from then on: views made before still read
   * through this object, decoding what they ask for.
   */
  release() {
    if (this._holders === 0) return;
    if (--this._holders > 0) return;
    this._kept.clear();
    this.bytes = 0;
    this._budget.detach(this);
    this._budget = new DecodedBudget(0);
  }

  /** Whether any opening still holds these chunks. */
  get held() {
    return this._holders > 0;
  }
}
