/**
 * Page checksums of a file kept in this browser: a CRC-32 of every
 * `CHECK_PAGE_BYTES` of it, taken as the file is written (one pass, in
 * order), and checked on every read of it, page by page, so damaged kept
 * bytes are never read as data. One mechanism for every copy the app keeps
 * of a file's bytes: a converted store's files (`p<n>.bin`, `d.bin`) and a
 * file downloaded whole (`data/anndata/transcode/space.js`). A kept gene
 * index checks each gene's piece with the same checksums
 * (`PieceChecksums` over its genes, `data/anndata/kept-column-index.js`):
 * it is read a gene at a time, and a gene is its unit of rebuilding.
 *
 * A read of `[offset, offset + length)` reads the whole pages it touches
 * (at most one page more on each side), checks each against its CRC-32, and
 * returns the bytes asked for; a read that returns fewer bytes than the
 * pages hold (the copy shortened) is damage too. CRC-32 finds every change
 * of up to 32 bits in a page and all but one in 2^32 of any other.
 *
 * @module formats/io/page-checks
 */

import { crc32 } from '../zip/crc32.js';
import { formatCountOf } from '../../utils/format-units.js';

/**
 * The bytes one checksum covers. A read reads whole pages, so a page is the
 * largest extra a read pays on each side; the table costs 4 bytes a page
 * (0.025 % of the file), read once when the copy is opened.
 */
export const CHECK_PAGE_BYTES = 16 * 1024;

/** Bytes of a kept copy that do not match the checksums written with them. */
export class KeptCopyDamage extends Error {
  /**
   * @param {string} label - What the copy is ("The converted copy of a file")
   * @param {number} page - The first page that does not match
   */
  constructor(label, page) {
    super(`${label} kept in this browser is damaged (its bytes from ${page * CHECK_PAGE_BYTES} on do not match the checksum written with them); it was removed: opening the file again reads it again.`);
    this.name = 'KeptCopyDamage';
    this.page = page;
  }
}

/** The CRC-32 of `bytes`, continuing `previous` (one checksum for every kept copy). */
export function checksumOf(bytes, previous = 0) {
  return crc32(bytes, previous);
}

/** Whether `bytes` are what the checksum `expected` was written of. */
export function matchesChecksum(bytes, expected) {
  return crc32(bytes) === expected;
}

/**
 * The CRC-32 of each piece of bytes written in order, as they are written:
 * piece `i` ends at byte `pieceEnd(i)` (pages of a kept file; a kept gene
 * index's genes, `kept-column-index.js`). `count`: how many pieces there are
 * (no bound for pages).
 */
export class PieceChecksums {
  /**
   * @param {(piece: number) => number} pieceEnd
   * @param {number} [count]
   */
  constructor(pieceEnd, count = Infinity) {
    this._pieceEnd = pieceEnd;
    this._count = count;
    this._sums = [];
    this._crc = 0;
    this._at = 0;
    this._open = false;
  }

  /** Close every piece that ends at or before `through`. */
  _close(through) {
    while (this._sums.length < this._count && this._pieceEnd(this._sums.length) <= through) {
      this._sums.push(this._crc);
      this._crc = 0;
      this._open = false;
    }
  }

  /** The next bytes. */
  add(bytes) {
    let offset = 0;
    while (offset < bytes.length) {
      this._close(this._at);
      if (this._sums.length >= this._count) throw new Error('More bytes were written than their pieces hold.');
      const end = Math.min(bytes.length, offset + this._pieceEnd(this._sums.length) - this._at);
      this._crc = crc32(bytes.subarray(offset, end), this._crc);
      this._open = true;
      this._at += end - offset;
      offset = end;
    }
  }

  /** Every piece's CRC-32 (a last page's for the bytes it holds; a piece with no bytes: 0). */
  finish() {
    if (Number.isFinite(this._count)) this._close(Infinity);
    else {
      this._close(this._at);
      if (this._open) this._sums.push(this._crc);
    }
    return Uint32Array.from(this._sums);
  }
}

/** The page checksums of bytes written in order (`CHECK_PAGE_BYTES` a page). */
export class PageChecksums extends PieceChecksums {
  constructor(pageBytes = CHECK_PAGE_BYTES) {
    super(page => (page + 1) * pageBytes);
    this.pageBytes = pageBytes;
  }
}

/** The page checksums of bytes already whole. */
export function pageChecksumsOf(bytes, pageBytes = CHECK_PAGE_BYTES) {
  const sums = new PageChecksums(pageBytes);
  sums.add(bytes);
  return sums.finish();
}

/** A table of checksums as its stored bytes (little-endian). */
export function checksumBytes(sums) {
  const bytes = new Uint8Array(sums.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < sums.length; i++) view.setUint32(i * 4, sums[i], true);
  return bytes;
}

/** A table of checksums from its stored bytes; null when they are not one. */
export function checksumsFromBytes(bytes) {
  if (bytes.length % 4 !== 0) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sums = new Uint32Array(bytes.length / 4);
  for (let i = 0; i < sums.length; i++) sums[i] = view.getUint32(i * 4, true);
  return sums;
}

/** Whether `sums` is the table of a file of `size` bytes in pages of `pageBytes`. */
export function checksumsFit(sums, size, pageBytes = CHECK_PAGE_BYTES) {
  return sums instanceof Uint32Array && sums.length === Math.ceil(size / pageBytes);
}

/**
 * A read of a kept copy checked against its page checksums.
 *
 * @param {(offset: number, length: number, options?: Object) => Promise<Uint8Array>} read - Reads the copy's bytes
 * @param {{size: number, sums: Uint32Array, pageBytes?: number, label: string, onDamage?: (error: KeptCopyDamage) => void}} copy
 * @returns {(offset: number, length: number, options?: Object) => Promise<Uint8Array>}
 */
export function checkedRead(read, { size, sums, pageBytes = CHECK_PAGE_BYTES, label, onDamage = null }) {
  if (!checksumsFit(sums, size, pageBytes)) throw new TypeError(`${label}: its checksums do not cover its ${formatCountOf(size, 'byte')}.`);
  return async (offset, length, options) => {
    if (length === 0) return new Uint8Array(0);
    const first = Math.floor(offset / pageBytes);
    const start = first * pageBytes;
    const end = Math.min(size, Math.ceil((offset + length) / pageBytes) * pageBytes);
    const bytes = await read(start, end - start, options);
    const damaged = page => {
      const damage = new KeptCopyDamage(label, page);
      onDamage?.(damage);
      return damage;
    };
    // A copy that no longer holds every byte it was written with (a short
    // read, even one ending on a page boundary) is damaged: its first page
    // not read whole is the first that does not match.
    if (bytes.length !== end - start) throw damaged(first + Math.floor(Math.min(bytes.length, end - start) / pageBytes));
    for (let page = first, at = 0; at < bytes.length; page++, at += pageBytes) {
      if (!matchesChecksum(bytes.subarray(at, Math.min(bytes.length, at + pageBytes)), sums[page])) throw damaged(page);
    }
    return bytes.subarray(offset - start, offset - start + length);
  };
}
