/**
 * Blosc (version 1 frames, as numcodecs and Zarr's `blosc` codec write them).
 *
 * A frame is a 16-byte header (format version, codec version, flags, element
 * size, decoded size, block size, frame size), then, unless the frame is a
 * plain copy, one start offset per block. Each block is decoded on its own:
 * it may be split into one stream per byte of an element (when Blosc chose
 * to split, so similar bytes compress together), each stream compressed with
 * the frame's codec (blosclz, lz4/lz4hc, zlib or zstd; snappy is refused) or
 * stored as is, and the block is then un-shuffled (byte shuffle, or bit
 * shuffle).
 *
 * The header is the authority on how a frame was written; the codec's
 * metadata (`cname`, `shuffle`, `blocksize`) only records what the writer
 * asked for. The decoded size must be the one the array declares.
 *
 * @module formats/zarr/codecs/blosc
 */

import { inflate } from '../../io/inflate.js';
import { byteUnshuffleInto } from '../../io/shuffle.js';
import { copyMatch } from '../../io/lz-match.js';
import { ZarrFormatError, ZarrUnsupportedError } from '../errors.js';
import { lz4DecodeBlockInto } from './lz4.js';
import { zstdDecompress } from './zstd.js';

const HEADER_BYTES = 16;
const DO_SHUFFLE = 0x01;
const MEMCPYED = 0x02;
const DO_BITSHUFFLE = 0x04;
const DONT_SPLIT = 0x10;
/** Blosc splits a block into per-byte streams only for elements this small... */
const MAX_SPLITS = 16;
/** ...and blocks of at least this many elements. */
const MIN_SPLIT_ELEMENTS = 128;
/** blosclz's long-distance matches start past this offset. */
const BLOSCLZ_MAX_DISTANCE = 8191;
/** LZ4 expands at most 255:1: the bound on a frame's declared size. */
const LZ4_MAX_EXPANSION = 255;

const CODEC_NAMES = ['blosclz', 'lz4', 'snappy', 'zlib', 'zstd'];

function corrupt(detail) {
  return new ZarrFormatError(`Blosc data is corrupt: ${detail}.`);
}

/**
 * Decode one blosclz stream into `output[start, end)`, which it must fill.
 * The format is FastLZ's: literal runs (control < 32) and matches whose
 * length and distance live in the control byte and the bytes after it.
 */
function blosclzDecodeInto(input, output, start, end) {
  const limit = input.length;
  if (limit === 0) throw corrupt('a blosclz stream is empty');
  const view = new DataView(output.buffer, output.byteOffset, output.length);
  let ip = 0;
  let op = start;
  let control = input[ip++] & 31;
  for (;;) {
    if (control >= 32) {
      let length = (control >>> 5) - 1;
      let distance = (control & 31) << 8;
      if (length === 6) {
        let code;
        do {
          if (ip + 1 >= limit) throw corrupt('a blosclz match is truncated');
          code = input[ip++];
          length += code;
        } while (code === 255);
      } else if (ip + 1 >= limit) {
        throw corrupt('a blosclz match is truncated');
      }
      const code = input[ip++];
      length += 3;
      let ref = op - distance - code;
      if (code === 255 && distance === (31 << 8)) {
        if (ip + 1 >= limit) throw corrupt('a blosclz match is truncated');
        distance = (input[ip] << 8) + input[ip + 1];
        ip += 2;
        ref = op - distance - BLOSCLZ_MAX_DISTANCE;
      }
      if (op + length > end) throw corrupt('a blosclz match exceeds its block');
      if (ref - 1 < start) throw corrupt('a blosclz match reaches before its block');
      if (ip >= limit) break;
      control = input[ip++];
      copyMatch(output, view, op, op - (ref - 1), length);
      op += length;
    } else {
      const run = control + 1;
      if (op + run > end || ip + run > limit) throw corrupt('a blosclz literal run exceeds its bounds');
      if (run > 16) output.set(input.subarray(ip, ip + run), op);
      else for (let k = 0; k < run; k++) output[op + k] = input[ip + k];
      op += run;
      ip += run;
      if (ip >= limit) break;
      control = input[ip++];
    }
  }
  if (op !== end) throw corrupt(`a blosclz stream decodes to ${op - start} bytes, not ${end - start}`);
}

/** Decode one compressed stream into `output[start, end)`. */
async function decodeStream(codec, stream, output, start, end) {
  if (codec === 1) {
    lz4DecodeBlockInto(stream, output, start, end);
  } else if (codec === 0) {
    blosclzDecodeInto(stream, output, start, end);
  } else if (codec === 4) {
    output.set(zstdDecompress(stream, end - start), start);
  } else if (codec === 3) {
    output.set(await inflate(stream, { format: 'deflate', expectedSize: end - start, label: 'A Blosc zlib stream' }), start);
  } else {
    const name = CODEC_NAMES[codec] ?? `codec ${codec}`;
    throw new ZarrUnsupportedError(`Blosc ${name}`, `This array is compressed with Blosc using ${name}, which this reader cannot decompress.`);
  }
}

/**
 * Reverse bitshuffle's bit transpose of `count` elements (a multiple of 8):
 * `src` holds, for each bit of each byte of an element, one row of
 * `count / 8` bytes. Inverse of bitshuffle's `bshuf_trans_bit_elem`.
 */
function bitUntranspose(src, dest, at, count, typesize, scratch) {
  const rowBytes = count >>> 3;
  // Gather the eight bit-rows of each element byte, eight elements at a time.
  for (let j = 0; j < typesize; j++) {
    for (let i = 0; i < rowBytes; i++) {
      const base = i * 8 * typesize + j * 8;
      for (let k = 0; k < 8; k++) scratch[base + k] = src[(j * 8 + k) * rowBytes + i];
    }
  }
  // Transpose each 8x8 bit matrix back to eight element bytes.
  const total = count * typesize;
  const groupBytes = 8 * typesize;
  for (let j = 0; j < groupBytes; j += 8) {
    const byteInElement = j >>> 3;
    for (let i = 0; i + groupBytes <= total; i += groupBytes) {
      const b = i + j;
      const b0 = scratch[b]; const b1 = scratch[b + 1]; const b2 = scratch[b + 2]; const b3 = scratch[b + 3];
      const b4 = scratch[b + 4]; const b5 = scratch[b + 5]; const b6 = scratch[b + 6]; const b7 = scratch[b + 7];
      for (let k = 0; k < 8; k++) {
        dest[at + i + byteInElement + k * typesize] =
          ((b0 >> k) & 1) | (((b1 >> k) & 1) << 1) | (((b2 >> k) & 1) << 2) | (((b3 >> k) & 1) << 3) |
          (((b4 >> k) & 1) << 4) | (((b5 >> k) & 1) << 5) | (((b6 >> k) & 1) << 6) | (((b7 >> k) & 1) << 7);
      }
    }
  }
}

/** Reverse Blosc's bit shuffle of one block, as c-blosc 1 does for `version`. */
function bitUnshuffle(src, dest, at, size, typesize, version) {
  let count = Math.floor(size / typesize);
  if (version <= 2 && count % 8 !== 0) {
    // Format version 2 shuffled only blocks of whole groups of 8 elements.
    dest.set(src.subarray(0, size), at);
    return;
  }
  count -= count % 8;
  if (count > 0) bitUntranspose(src, dest, at, count, typesize, new Uint8Array(count * typesize));
  const done = count * typesize;
  if (done < size) dest.set(src.subarray(done, size), at + done);
}

/**
 * Decode one Blosc frame.
 *
 * @param {Uint8Array} input
 * @param {number|null} expectedSize - The decoded size the array declares
 * @returns {Promise<Uint8Array>}
 */
export async function bloscDecode(input, expectedSize) {
  if (input.length < HEADER_BYTES) throw corrupt('the header is truncated');
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const version = input[0];
  const codecVersion = input[1];
  const flags = input[2];
  const typesize = input[3];
  const nbytes = view.getUint32(4, true);
  const blocksize = view.getUint32(8, true);
  const cbytes = view.getUint32(12, true);
  if (version < 1 || version > 2) {
    throw new ZarrUnsupportedError(`Blosc format version ${version}`, `This array uses Blosc format version ${version}; this reader reads Blosc 1 frames (versions 1 and 2), as numcodecs writes them.`);
  }
  if (cbytes !== input.length) throw corrupt(`the frame declares ${cbytes} bytes and holds ${input.length}`);
  if (expectedSize !== null && nbytes !== expectedSize) {
    throw corrupt(`the frame decodes to ${nbytes} bytes, not the ${expectedSize} expected`);
  }
  if (expectedSize === null && nbytes > input.length * LZ4_MAX_EXPANSION + 64) {
    throw corrupt(`the frame declares more bytes than its codecs can encode in ${input.length}`);
  }
  if (typesize === 0) throw corrupt('the element size is zero');
  const codec = flags >>> 5;
  if ((flags & MEMCPYED) !== 0) {
    if (cbytes !== HEADER_BYTES + nbytes) throw corrupt('a plain-copy frame has the wrong size');
    return input.slice(HEADER_BYTES);
  }
  if (codec > 4) throw corrupt(`the codec format ${codec} is unknown`);
  if (codecVersion !== 1 && codec !== 4 && codec !== 3) {
    throw new ZarrUnsupportedError(`Blosc ${CODEC_NAMES[codec]} format ${codecVersion}`, `This array uses Blosc ${CODEC_NAMES[codec]} stream format ${codecVersion}, which this reader does not read.`);
  }
  const output = new Uint8Array(nbytes);
  if (nbytes === 0) return output;
  if (blocksize === 0 || blocksize > nbytes) throw corrupt('the block size is invalid');
  const blocks = Math.ceil(nbytes / blocksize);
  const tableEnd = HEADER_BYTES + blocks * 4;
  if (tableEnd > cbytes) throw corrupt('the block table is truncated');
  const byteShuffle = (flags & DO_SHUFFLE) !== 0 && typesize > 1;
  const bitShuffle = !byteShuffle && (flags & DO_BITSHUFFLE) !== 0 && blocksize >= typesize;
  const shuffled = byteShuffle || bitShuffle;
  const dontSplit = (flags & DONT_SPLIT) !== 0;
  const scratch = shuffled ? new Uint8Array(blocksize) : null;
  const pending = [];

  for (let block = 0; block < blocks; block++) {
    const outStart = block * blocksize;
    const size = Math.min(blocksize, nbytes - outStart);
    const leftover = size !== blocksize;
    const splits = !dontSplit && !leftover && typesize <= MAX_SPLITS && Math.floor(blocksize / typesize) >= MIN_SPLIT_ELEMENTS
      ? typesize
      : 1;
    if (size % splits !== 0) throw corrupt('a block cannot be divided into its streams');
    const streamBytes = size / splits;
    const target = shuffled ? scratch : output;
    const targetStart = shuffled ? 0 : outStart;
    let cursor = view.getUint32(HEADER_BYTES + block * 4, true);
    if (cursor < tableEnd || cursor >= cbytes) throw corrupt('a block offset is outside the frame');
    const streams = [];
    for (let split = 0; split < splits; split++) {
      if (cursor + 4 > cbytes) throw corrupt('a stream length is truncated');
      const length = view.getInt32(cursor, true);
      cursor += 4;
      if (length <= 0 || length > streamBytes || cursor + length > cbytes) throw corrupt('a stream length is invalid');
      const stream = input.subarray(cursor, cursor + length);
      cursor += length;
      const from = targetStart + split * streamBytes;
      if (length === streamBytes) target.set(stream, from);
      else {
        const decoding = decodeStream(codec, stream, target, from, from + streamBytes);
        decoding.catch(() => {});
        streams.push(decoding);
      }
    }
    if (shuffled) {
      // The scratch block is reused: finish this block before the next.
      await Promise.all(streams);
      if (byteShuffle) byteUnshuffleInto(scratch, output, outStart, size, typesize);
      else bitUnshuffle(scratch, output, outStart, size, typesize, version);
    } else {
      pending.push(...streams);
    }
  }
  await Promise.all(pending);
  return output;
}
