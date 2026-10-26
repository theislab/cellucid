/**
 * The byte tokenizer of an R serialization stream: big-endian (XDR) 32-bit
 * integers, doubles, strings and payloads, over bytes that arrive in pieces
 * of any size.
 *
 * Two ways to get the bytes, one tokenizer:
 *
 * - **stream**: pieces in order from an async iterator (a decompressor's
 *   output). Engines deliver anything from 16 KiB (Chromium, Firefox) to
 *   130 MB (WebKit) at a time; a piece is never copied whole: a value that
 *   straddles two pieces is assembled from the remainder of one and the head
 *   of the next, and a payload passes through as views of the pieces.
 * - **ranges**: windows read at absolute offsets of a file that allows
 *   random access (an uncompressed `.rds`). A payload that is not wanted, or
 *   whose place in the file is all a caller needs, is jumped over: none of
 *   its bytes are read.
 *
 * `position` is the absolute offset in the (decompressed) stream of the next
 * byte to read. The fast accessors (`i32`, `f64`) assume their bytes are
 * buffered: callers check `available` and `await fill(n)` otherwise, so a
 * run of small items read from one piece costs no promise each.
 *
 * @module formats/rds/xdr
 */

import { RdsFormatError } from './errors.js';
import { formatCountOf } from '../../utils/format-units.js';

const EMPTY = new Uint8Array(0);

/**
 * Window size of a ranges reader: one read of an uncompressed file's
 * structure. Large enough that the many small items between two payloads
 * (names, attributes) cost a few reads; a payload is jumped over, so the
 * window never pulls a large vector in.
 */
export const RANGE_WINDOW_BYTES = 1024 * 1024;

export class XdrReader {
  /**
   * @param {() => Promise<{bytes: Uint8Array, start: number}|null>} next -
   *   The next piece and its absolute start, or null at the end
   * @param {{jump?: ((offset: number) => void)|null, size?: number|null}} [options]
   *   `jump(offset)`: the next piece starts at `offset` (ranges mode);
   *   `size`: the stream's length, when known
   */
  constructor(next, { jump = null, size = null } = {}) {
    this._next = next;
    this._jump = jump;
    this.size = size;
    this.buf = EMPTY;
    this.view = new DataView(EMPTY.buffer);
    this.pos = 0;
    /** Absolute offset of `buf[0]`. */
    this.base = 0;
    /** Pieces read ahead of `buf` (the rest of a piece whose head filled a value). */
    this.queue = [];
  }

  /**
   * A tokenizer over pieces that arrive in order.
   *
   * @param {AsyncIterable<Uint8Array>|AsyncIterator<Uint8Array>} pieces
   * @returns {XdrReader}
   */
  static ofStream(pieces) {
    const iterator = typeof pieces[Symbol.asyncIterator] === 'function' ? pieces[Symbol.asyncIterator]() : pieces;
    let start = 0;
    return new XdrReader(async () => {
      for (;;) {
        const { value, done } = await iterator.next();
        if (done) return null;
        if (!(value instanceof Uint8Array)) throw new TypeError('An R stream piece must be a Uint8Array.');
        if (value.length === 0) continue;
        const piece = { bytes: value, start };
        start += value.length;
        return piece;
      }
    });
  }

  /**
   * A tokenizer over a file read by ranges.
   *
   * @param {{size: number, read: (offset: number, length: number) => Promise<Uint8Array>}} file
   * @param {{windowBytes?: number, offset?: number}} [options]
   * @returns {XdrReader}
   */
  static ofRanges(file, { windowBytes = RANGE_WINDOW_BYTES, offset = 0 } = {}) {
    let next = offset;
    const reader = new XdrReader(async () => {
      if (next >= file.size) return null;
      const length = Math.min(windowBytes, file.size - next);
      const bytes = await file.read(next, length);
      if (bytes.length !== length) throw new RdsFormatError(`A read of ${formatCountOf(length, 'byte')} at ${next} returned ${bytes.length}.`);
      const piece = { bytes, start: next };
      next += length;
      return piece;
    }, { jump: target => { next = target; }, size: file.size });
    reader.base = offset;
    return reader;
  }

  /** Whether payloads can be jumped over (and referred to by their place in the file). */
  get random() {
    return this._jump !== null;
  }

  /** Absolute offset of the next byte. */
  get position() {
    return this.base + this.pos;
  }

  /** Bytes buffered from `position` on. */
  get available() {
    return this.buf.length - this.pos;
  }

  _setBuffer(bytes, start) {
    this.buf = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = 0;
    this.base = start;
  }

  async _piece() {
    if (this.queue.length > 0) return this.queue.shift();
    return this._next();
  }

  _ended(missing) {
    return new RdsFormatError(
      `The R stream ends ${formatCountOf(missing, 'byte')} before the item being read; the file is truncated or damaged.`
    );
  }

  /**
   * Buffer at least `n` contiguous bytes from `position` on. A value that
   * straddles pieces is assembled from the remainder and only as much of
   * the next pieces as it needs.
   *
   * @param {number} n
   */
  async fill(n) {
    while (this.buf.length - this.pos < n) {
      const piece = await this._piece();
      const remainder = this.buf.length - this.pos;
      if (piece === null) throw this._ended(n - remainder);
      if (remainder === 0) {
        this._setBuffer(piece.bytes, piece.start);
        continue;
      }
      if (piece.start !== this.base + this.buf.length) {
        throw new RdsFormatError('The R stream reader lost its place between two pieces.');
      }
      const take = Math.min(piece.bytes.length, n - remainder);
      const joined = new Uint8Array(remainder + take);
      joined.set(this.buf.subarray(this.pos));
      joined.set(piece.bytes.subarray(0, take), remainder);
      if (take < piece.bytes.length) this.queue.unshift({ bytes: piece.bytes.subarray(take), start: piece.start + take });
      this._setBuffer(joined, this.base + this.pos);
    }
  }

  /** A buffered big-endian int32 (`fill(4)` first). */
  i32() {
    const value = this.view.getInt32(this.pos, false);
    this.pos += 4;
    return value;
  }

  /** A buffered big-endian float64 (`fill(8)` first). */
  f64() {
    const value = this.view.getFloat64(this.pos, false);
    this.pos += 8;
    return value;
  }

  /** The next big-endian int32. */
  async int() {
    if (this.buf.length - this.pos < 4) await this.fill(4);
    return this.i32();
  }

  /**
   * The next `n` bytes, as a view valid until the next read (copy what is
   * kept).
   *
   * @param {number} n
   * @returns {Promise<Uint8Array>}
   */
  async bytes(n) {
    if (this.buf.length - this.pos < n) await this.fill(n);
    const view = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return view;
  }

  /**
   * Pass `n` bytes on to `write` as views of the pieces they arrive in, or
   * consume them when `write` is null. In ranges mode a payload nobody
   * writes is jumped over without reading it.
   *
   * @param {number} n
   * @param {((view: Uint8Array) => (void|Promise<void>))|null} write
   */
  async transfer(n, write) {
    if (this.size !== null && this.position + n > this.size) {
      throw new RdsFormatError(`An item declares ${formatCountOf(n, 'byte')} at offset ${this.position}, past the end of the ${this.size}-byte stream.`);
    }
    let left = n;
    if (write === null && this._jump !== null && left > this.available) {
      // Jump: the queue holds the bytes right after the buffer.
      left -= this.available;
      let target = this.base + this.buf.length;
      while (this.queue.length > 0 && left > 0) {
        const piece = this.queue.shift();
        if (piece.bytes.length > left) {
          this.queue.unshift({ bytes: piece.bytes.subarray(left), start: piece.start + left });
          target = piece.start + left;
          left = 0;
          break;
        }
        left -= piece.bytes.length;
        target = piece.start + piece.bytes.length;
      }
      target += left;
      this._setBuffer(EMPTY, target);
      if (this.queue.length === 0) this._jump(target);
      return;
    }
    while (left > 0) {
      if (this.buf.length === this.pos) {
        const piece = await this._piece();
        if (piece === null) throw this._ended(left);
        this._setBuffer(piece.bytes, piece.start);
      }
      const take = Math.min(left, this.buf.length - this.pos);
      if (write !== null) {
        const pending = write(this.buf.subarray(this.pos, this.pos + take));
        if (pending !== undefined) await pending;
      }
      this.pos += take;
      left -= take;
    }
  }

  /** Whether the stream has no byte left. */
  async atEnd() {
    if (this.available > 0) return false;
    const piece = await this._piece();
    if (piece === null) return true;
    this._setBuffer(piece.bytes, piece.start);
    return false;
  }
}
