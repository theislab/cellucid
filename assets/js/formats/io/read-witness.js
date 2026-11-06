/**
 * What was read of a file or a store, as evidence: a checksum of each read,
 * so an answer under a new validator can be told from new bytes.
 *
 * A host's validator (`ETag`, `Last-Modified`) says when an object was written,
 * not what it holds: GitHub Pages gives every file of a site new validators
 * at every deployment although its bytes are the same. What must never happen
 * is one read made of two versions, a chunk of the new one beside the
 * categories of the old. So a validator that moved is a question, and the
 * bytes answer it:
 *
 * - the same range read before is compared with what it held (`compare`);
 * - a range never read has nothing of its own to compare: a few ranges read
 *   before are asked for again, under the new validator, and compared
 *   (`witnesses`). A read and its witnesses are CRC-32 (all but one in 2^32 of
 *   any change, `zip/crc32.js`, 2.2 GB/s on the reader's thread) with the exact
 *   length. Witnesses are evidence, not proof: a rewrite that keeps every byte
 *   read so far and changes only bytes never read is not seen, which no client
 *   can see.
 *
 * One read's cost is its checksum; a witness costs at most `WITNESS_BYTES`,
 * and nothing is asked until a validator moves. The owners: `formats/io/byte-source.js`
 * (a file) and `formats/zarr/stores/http.js` (a store's objects).
 *
 * @module formats/io/read-witness
 */

import { crc32 } from '../zip/crc32.js';

/** What a witness asks for again: its first bytes. Their checksum is the start of the whole read's. */
export const WITNESS_BYTES = 64 * 1024;

/**
 * @param {string} key - The object read (`''` for a file)
 * @returns {string} What groups an object's witnesses: its folder, one Zarr array
 */
function groupOf(key) {
  const end = key.lastIndexOf('/');
  return end < 0 ? key : key.slice(0, end);
}

export class ReadWitness {
  constructor() {
    /** @type {Map<string, Map<string, {start: number, length: number, crc: number, firstBytes: number, firstCrc: number}>>} */
    this._reads = new Map();
    /** The size of each object, as a whole read or a range's answer stated it. @type {Map<string, number>} */
    this._sizes = new Map();
  }

  /** Whether `size`, when known, is not what `key` was before. */
  sizeDiffers(key, size) {
    return size !== null && this._sizes.has(key) && this._sizes.get(key) !== size;
  }

  /** Keep the size of `key` (null: not stated). */
  noteSize(key, size) {
    if (size !== null) this._sizes.set(key, size);
  }

  /** Whether anything was read of `key`. */
  has(key) {
    return this._reads.has(key);
  }

  /** What `bytes` read of `key` at `start` are, from now on what that range holds. */
  note(key, start, bytes) {
    const firstBytes = Math.min(bytes.length, WITNESS_BYTES);
    const firstCrc = crc32(bytes.subarray(0, firstBytes));
    const crc = firstBytes === bytes.length ? firstCrc : crc32(bytes.subarray(firstBytes), firstCrc);
    let ranges = this._reads.get(key);
    if (ranges === undefined) {
      ranges = new Map();
      this._reads.set(key, ranges);
    }
    ranges.set(`${start}:${bytes.length}`, { start, length: bytes.length, crc, firstBytes, firstCrc });
  }

  /**
   * `bytes` at `start` of `key` against what the same range held.
   *
   * @returns {'same'|'different'|'unknown'} `unknown`: that range was not read
   */
  compare(key, start, bytes) {
    const read = this._reads.get(key)?.get(`${start}:${bytes.length}`);
    if (read === undefined) return 'unknown';
    const firstCrc = crc32(bytes.subarray(0, read.firstBytes));
    if (firstCrc !== read.firstCrc) return 'different';
    const crc = read.firstBytes === bytes.length ? firstCrc : crc32(bytes.subarray(read.firstBytes), firstCrc);
    return crc === read.crc ? 'same' : 'different';
  }

  /** The smallest read of `key`, as a witness, or null. */
  witnessOf(key) {
    const ranges = this._reads.get(key);
    if (ranges === undefined) return null;
    let smallest = null;
    for (const read of ranges.values()) if (smallest === null || read.length < smallest.length) smallest = read;
    return { key, start: smallest.start, length: smallest.firstBytes, crc: smallest.firstCrc };
  }

  /**
   * What to ask for again when a store's validators moved: the smallest read
   * of each array read, so a rewrite of any of them shows, for a few bytes each.
   *
   * @returns {Array<{key: string, start: number, length: number, crc: number}>}
   */
  witnessesOfArrays() {
    const smallest = new Map();
    for (const [key, ranges] of this._reads) {
      for (const read of ranges.values()) {
        const group = groupOf(key);
        const held = smallest.get(group);
        if (held === undefined || read.length < held.read.length) smallest.set(group, { key, read });
      }
    }
    return [...smallest.values()].map(({ key, read }) => ({ key, start: read.start, length: read.firstBytes, crc: read.firstCrc }));
  }

  /**
   * What to ask for again when a file's validators moved: its first, last and
   * middle reads (its structure, what lies at its end, a read in between).
   *
   * @param {string} [key]
   * @returns {Array<{key: string, start: number, length: number, crc: number}>}
   */
  witnessesAcross(key = '') {
    const ranges = this._reads.get(key);
    if (ranges === undefined) return [];
    const reads = [...ranges.values()].sort((a, b) => a.start - b.start);
    const picked = new Set([reads[0], reads[Math.floor((reads.length - 1) / 2)], reads[reads.length - 1]]);
    return [...picked].map(read => ({ key, start: read.start, length: read.firstBytes, crc: read.firstCrc }));
  }
}

/** Whether `bytes` are what a witness (`witnessOf`) held. */
export function witnessHolds(witness, bytes) {
  return bytes !== null && bytes.length === witness.length && crc32(bytes) === witness.crc;
}
