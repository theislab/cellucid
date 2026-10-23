/**
 * The filter pipeline: undoing what was done to each chunk when it was
 * written.
 *
 * Filters were applied in pipeline order on write, so they are undone in
 * reverse on read, skipping those the chunk's filter mask says were not
 * applied (an optional filter that failed, e.g. LZF on incompressible data).
 *
 * | id | filter | |
 * | --- | --- | --- |
 * | 1 | deflate (gzip) | native `DecompressionStream` (io/inflate.js) |
 * | 2 | shuffle | byte un-interleaving (io/shuffle.js) |
 * | 3 | fletcher32 | checksum verified, then stripped |
 * | 32000 | LZF (h5py) | lzf.js |
 *
 * `unfilter` runs wherever a chunk is decoded: in the reader thread, or on a
 * decode worker (io/decode-pool.js), whose errors `reviveHdf5Error` turns
 * back into the same `Hdf5FormatError` or `Hdf5UnsupportedError`.
 *
 * Decompression never produces more than the chunk can hold: the size each
 * filter must restore is known from the chunk's size (its shape times its
 * element size) and the filters applied before it, exactly when those keep
 * or fix sizes (shuffle, Fletcher-32), as a bound otherwise (what DEFLATE or
 * LZF can expand to). A stream that inflates past it is refused as soon as
 * it does, never decompressed in full.
 *
 * Any other filter (szip, nbit, scale-offset, Blosc, Zstandard, LZ4,
 * bitshuffle, bzip2, …) raises `Hdf5UnsupportedError` naming it, when a chunk
 * that needs it is read: the file still opens and everything else in it
 * still reads.
 *
 * @module formats/hdf5/filters
 */

import { inflate, InflateError } from '../io/inflate.js';
import { byteUnshuffle } from '../io/shuffle.js';
import { fletcher32 } from './checksum.js';
import { Hdf5FormatError, Hdf5UnsupportedError } from './errors.js';
import { lzfDecompress } from './lzf.js';
import { genericError } from '../io/decode-pool.js';

export const FILTER = Object.freeze({ DEFLATE: 1, SHUFFLE: 2, FLETCHER32: 3, LZF: 32000 });

/** Names of filters this reader does not undo, for messages. */
const KNOWN_FILTERS = new Map([
  [4, 'szip'], [5, 'nbit'], [6, 'scaleoffset'], [305, 'LZO'], [307, 'bzip2'], [32001, 'Blosc'],
  [32002, 'MAFISC'], [32003, 'Snappy'], [32004, 'LZ4'], [32005, 'APAX'], [32006, 'CBF'],
  [32007, 'JPEG-XR'], [32008, 'bitshuffle'], [32009, 'SPDP'], [32010, 'LPC-Rice'], [32011, 'CCSDS-123'],
  [32012, 'JPEG-LS'], [32013, 'zfp'], [32014, 'fpzip'], [32015, 'Zstandard'], [32016, 'B³D'],
  [32017, 'SZ'], [32018, 'FCIDECOMP'], [32019, 'JPEG'], [32020, 'VBZ'], [32022, 'FAPEC'],
  [32023, 'BitGroom'], [32024, 'Granular BitRound'], [32025, 'SZ3'], [32026, 'Blosc2'], [32028, 'Delta-Rice'],
]);

const SUPPORTED = new Set([FILTER.DEFLATE, FILTER.SHUFFLE, FILTER.FLETCHER32, FILTER.LZF]);

/** A filter's display name. */
export function filterName(filter) {
  if (filter.id === FILTER.DEFLATE) return 'deflate';
  if (filter.id === FILTER.SHUFFLE) return 'shuffle';
  if (filter.id === FILTER.FLETCHER32) return 'fletcher32';
  if (filter.id === FILTER.LZF) return 'lzf';
  return KNOWN_FILTERS.get(filter.id) ?? (filter.name || `filter ${filter.id}`);
}

function unsupportedFilter(filter, label) {
  const name = filterName(filter);
  return new Hdf5UnsupportedError(
    `filter:${name}`,
    `${label} is compressed with the ${name} filter (HDF5 filter id ${filter.id}), which this reader cannot decompress.`
  );
}

/** Whether every filter of `filters` can be undone. */
export function unsupportedFilters(filters) {
  return filters.filter(filter => !SUPPORTED.has(filter.id));
}

/**
 * Verify and strip a Fletcher-32 checksum. Files written before HDF5 1.6.3
 * on some platforms stored it with its 16-bit halves byte-swapped; the
 * library accepts both, and so does this.
 */
export function verifyFletcher32(input, label) {
  if (input.length < 4) throw new Hdf5FormatError(`${label} is too short to hold its Fletcher-32 checksum.`);
  const data = input.subarray(0, input.length - 4);
  const end = input.length - 4;
  const stored = (input[end] | (input[end + 1] << 8) | (input[end + 2] << 16) | (input[end + 3] << 24)) >>> 0;
  const computed = fletcher32(data);
  const reversed = (((computed & 0xff) << 8) | ((computed >>> 8) & 0xff) |
    (((computed >>> 16) & 0xff) << 24) | (((computed >>> 24) & 0xff) << 16)) >>> 0;
  if (stored !== computed && stored !== reversed) {
    throw new Hdf5FormatError(`${label} fails its Fletcher-32 checksum: the data is corrupt.`);
  }
  return data;
}

/** zlib's `compressBound`: the most a DEFLATE (zlib) stream of `n` bytes can hold. */
function deflateBound(n) {
  return n + Math.floor(n / 4096) + Math.floor(n / 16384) + Math.floor(n / 33554432) + 13;
}

/** The most LZF output for `n` bytes: every byte a literal, one control byte per 32. */
function lzfBound(n) {
  return n + Math.ceil(n / 32);
}

/**
 * The size of a chunk's bytes before filter `i` was applied: its decoded
 * `chunkBytes` passed through the filters before `i` that were applied.
 * Exact when those keep or fix sizes, otherwise the most they can produce.
 */
function sizeBefore(filters, mask, i, chunkBytes, label) {
  let size = chunkBytes;
  let exact = true;
  for (let j = 0; j < i; j++) {
    if (mask & (1 << j)) continue;
    switch (filters[j].id) {
      case FILTER.SHUFFLE:
        break;
      case FILTER.FLETCHER32:
        size += 4;
        break;
      case FILTER.DEFLATE:
        size = deflateBound(size);
        exact = false;
        break;
      case FILTER.LZF:
        size = lzfBound(size);
        exact = false;
        break;
      default:
        throw unsupportedFilter(filters[j], label);
    }
  }
  return { size, exact };
}

/**
 * Undo `filters` on one stored chunk.
 *
 * @param {Uint8Array} stored
 * @param {import('./messages.js').Filter[]} filters
 * @param {number} mask - Bit i set: filter i was not applied
 * @param {number} chunkBytes - Size of the chunk once every filter is undone
 * @param {string} label - What is read, for messages
 * @returns {Promise<Uint8Array>}
 */
export async function unfilter(stored, filters, mask, chunkBytes, label) {
  let bytes = stored;
  for (let i = filters.length - 1; i >= 0; i--) {
    if (mask & (1 << i)) continue;
    const filter = filters[i];
    const before = sizeBefore(filters, mask, i, chunkBytes, label);
    switch (filter.id) {
      case FILTER.DEFLATE:
        try {
          bytes = await inflate(bytes, before.exact
            ? { format: 'deflate', expectedSize: before.size, label }
            : { format: 'deflate', maxSize: before.size, label });
        } catch (error) {
          if (error instanceof InflateError) throw new Hdf5FormatError(error.message, { cause: error });
          throw error;
        }
        break;
      case FILTER.SHUFFLE: {
        const typesize = filter.clientData[0] ?? 1;
        if (typesize > 1) bytes = byteUnshuffle(bytes, typesize);
        break;
      }
      case FILTER.FLETCHER32:
        bytes = verifyFletcher32(bytes, label);
        break;
      case FILTER.LZF: {
        const declared = filter.clientData[2] ?? 0;
        const size = before.exact ? before.size : declared;
        if (!(size > 0)) throw new Hdf5FormatError(`${label}: the size of its LZF-compressed data is unknown.`);
        if (size > before.size) {
          throw new Hdf5FormatError(`${label} declares ${size} bytes of LZF-compressed data, more than the ${before.size} its chunk can hold.`);
        }
        const output = lzfDecompress(bytes, size);
        if (output === null) throw new Hdf5FormatError(`${label} could not be LZF-decompressed; the data is corrupt.`);
        bytes = output;
        break;
      }
      default:
        throw unsupportedFilter(filter, label);
    }
  }
  if (bytes.length !== chunkBytes) {
    throw new Hdf5FormatError(`${label} holds ${bytes.length} bytes once decoded, not the ${chunkBytes} of a chunk.`);
  }
  return bytes;
}

/**
 * A decode worker's error data as the error it was: HDF5 errors keep their
 * class, feature, offset and message.
 *
 * @param {{name: string, message: string, feature?: string, offset?: number|null}} data
 * @returns {Error}
 */
export function reviveHdf5Error(data) {
  if (data.name === 'Hdf5FormatError') return new Hdf5FormatError(data.message, { offset: data.offset ?? null });
  if (data.name === 'Hdf5UnsupportedError') return new Hdf5UnsupportedError(data.feature, data.message);
  return genericError(data);
}
