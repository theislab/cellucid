/**
 * Zstandard decompression (RFC 8878), the default codec of Zarr v3 as
 * zarr-python 3 writes it, and one of Blosc's and numcodecs' codecs.
 *
 * Written for this reader rather than taken from a library so that it decodes
 * straight into one output of the size the array declares, refuses to write a
 * byte past it, and checks every bound a hostile frame could abuse (table
 * sizes, offsets reaching before the frame, literals and bit streams that run
 * short or long). Frames written with a dictionary are refused: Zarr never
 * uses one. A frame's optional content checksum is skipped, not verified:
 * the decoded size is always checked, and a chunk's own codecs (CRC-32C in
 * Zarr v3) cover integrity where the writer asked for it.
 *
 * Structure follows the RFC: a frame holds blocks (raw, run-length, or
 * compressed); a compressed block holds literals (raw, run-length, or
 * Huffman-coded in one or four streams) and sequences (literal length, match
 * length, offset), each coded with a finite-state-entropy (FSE) table that is
 * predefined, a single symbol, described in the block, or repeated from the
 * previous block.
 *
 * The sequence loop keeps its bit stream in a 32-bit container held in local
 * variables, refilled only when the next fields may not fit, and copies
 * matches and short literal runs eight bytes at a time when the output has
 * room past them (the bytes written past a match are overwritten by what
 * follows it, before anything reads them).
 *
 * @module formats/zarr/codecs/zstd
 */

import { ZarrFormatError, ZarrUnsupportedError } from '../errors.js';
import { BLOCK_COPY_BYTES, copyMatch } from '../../io/lz-match.js';

const FRAME_MAGIC = 0xfd2fb528;
const SKIPPABLE_MASK = 0xfffffff0;
const SKIPPABLE_MAGIC = 0x184d2a50;
const MAX_BLOCK_BYTES = 128 * 1024;

/**
 * Decoded literals of the block being decoded. Decoding is synchronous and a
 * block's literals are used up before the next block starts, so one buffer
 * serves every frame.
 */
const LITERALS = new Uint8Array(MAX_BLOCK_BYTES);

function corrupt(detail) {
  return new ZarrFormatError(`Zstandard data is corrupt: ${detail}.`);
}

function highBit(value) {
  return 31 - Math.clz32(value);
}

// Literal-length and match-length codes: base value and extra bits (RFC 3.1.1.3.2.1.1).
const LL_BASE = new Int32Array([
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128, 256, 512, 1024, 2048, 4096,
  8192, 16384, 32768, 65536,
]);
const LL_BITS = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12,
  13, 14, 15, 16,
]);
const ML_BASE = new Int32Array(53);
const ML_BITS = new Uint8Array(53);
(() => {
  for (let code = 0; code < 32; code++) ML_BASE[code] = code + 3;
  const base = [35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051, 4099, 8195, 16387, 32771, 65539];
  const bits = [1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  for (let i = 0; i < base.length; i++) {
    ML_BASE[32 + i] = base[i];
    ML_BITS[32 + i] = bits[i];
  }
})();

// Predefined distributions (RFC 3.1.1.3.2.2).
const LL_DEFAULT = [4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1];
const ML_DEFAULT = [1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1];
const OF_DEFAULT = [1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1];

/**
 * An FSE decoding table from normalized counts (RFC 4.1.1): `symbol`,
 * `bits` to read after it and the `base` of the next state.
 */
function buildFseTable(counts, symbolCount, accuracyLog) {
  const size = 1 << accuracyLog;
  const symbol = new Uint8Array(size);
  const bits = new Uint8Array(size);
  const base = new Uint16Array(size);
  const next = new Uint16Array(symbolCount);
  let high = size - 1;
  for (let s = 0; s < symbolCount; s++) {
    if (counts[s] === -1) {
      symbol[high--] = s;
      next[s] = 1;
    } else {
      next[s] = counts[s];
    }
  }
  const step = (size >> 1) + (size >> 3) + 3;
  const mask = size - 1;
  let position = 0;
  for (let s = 0; s < symbolCount; s++) {
    for (let i = 0; i < counts[s]; i++) {
      symbol[position] = s;
      do position = (position + step) & mask; while (position > high);
    }
  }
  if (position !== 0) throw corrupt('an FSE table does not fill its states');
  for (let state = 0; state < size; state++) {
    const x = next[symbol[state]]++;
    const n = accuracyLog - highBit(x);
    bits[state] = n;
    base[state] = (x << n) - size;
  }
  return { symbol, bits, base, accuracyLog };
}

function rleTable(value) {
  return { symbol: Uint8Array.of(value), bits: new Uint8Array(1), base: new Uint16Array(1), accuracyLog: 0 };
}

const LL_PREDEFINED = buildFseTable(LL_DEFAULT, LL_DEFAULT.length, 6);
const ML_PREDEFINED = buildFseTable(ML_DEFAULT, ML_DEFAULT.length, 6);
const OF_PREDEFINED = buildFseTable(OF_DEFAULT, OF_DEFAULT.length, 5);

/** Up to 24 bits of `src` starting at absolute bit `position` (forward order). */
function peekForward(src, position, count) {
  const at = position >>> 3;
  const word = (src[at] | (src[at + 1] << 8) | (src[at + 2] << 16) | (src[at + 3] << 24)) >>> (position & 7);
  return word & ((1 << count) - 1);
}

/**
 * Read an FSE table description (normalized counts) at byte `start`.
 * Returns the table and the byte after the description.
 */
function readFseTable(src, start, end, maxSymbol, maxAccuracyLog) {
  if (start >= end) throw corrupt('an FSE table description is missing');
  let position = start * 8;
  const accuracyLog = peekForward(src, position, 4) + 5;
  position += 4;
  if (accuracyLog > maxAccuracyLog) throw corrupt(`an FSE table has accuracy ${accuracyLog}, above ${maxAccuracyLog}`);
  const counts = new Int16Array(maxSymbol + 1);
  let remaining = (1 << accuracyLog) + 1;
  let threshold = 1 << accuracyLog;
  let bitCount = accuracyLog + 1;
  let symbol = 0;
  let previousZero = false;
  while (remaining > 1 && symbol <= maxSymbol) {
    if (previousZero) {
      let zeros = symbol;
      for (;;) {
        const flag = peekForward(src, position, 2);
        position += 2;
        zeros += flag;
        if (flag !== 3) break;
      }
      if (zeros > maxSymbol) throw corrupt('an FSE table names too many symbols');
      while (symbol < zeros) counts[symbol++] = 0;
    }
    const max = (2 * threshold - 1) - remaining;
    const value = peekForward(src, position, bitCount);
    let count;
    if ((value & (threshold - 1)) < max) {
      count = value & (threshold - 1);
      position += bitCount - 1;
    } else {
      count = value & (2 * threshold - 1);
      if (count >= threshold) count -= max;
      position += bitCount;
    }
    count--;
    remaining -= count < 0 ? -count : count;
    counts[symbol++] = count;
    previousZero = count === 0;
    while (remaining < threshold) {
      bitCount--;
      threshold >>= 1;
    }
  }
  if (remaining !== 1) throw corrupt('an FSE table does not add up');
  const next = (position + 7) >>> 3;
  if (next > end) throw corrupt('an FSE table description runs past its block');
  return { table: buildFseTable(counts, symbol, accuracyLog), next };
}

/**
 * A bit stream read backward (RFC 4.1): it starts at the last byte's highest
 * set bit and ends at the first byte's lowest. `position` counts the bits
 * still unread; reading past the start yields zeros and leaves it negative.
 */
class BackwardBits {
  constructor(src, start, end) {
    if (end <= start) throw corrupt('a bit stream is empty');
    const last = src[end - 1];
    if (last === 0) throw corrupt('a bit stream has no end marker');
    this.src = src;
    this.start = start;
    this.position = (end - 1 - start) * 8 + highBit(last);
  }

  /** Read `count` (at most 31) bits. */
  read(count) {
    if (count === 0) return 0;
    this.position -= count;
    return this.at(this.position, count);
  }

  /** The `count` bits at `position` (bits below the stream are zero). */
  at(position, count) {
    if (position < 0) {
      if (position + count <= 0) return 0;
      return this.at(0, position + count) * (2 ** -position);
    }
    if (count > 24) return this.at(position, 16) + this.at(position + 16, count - 16) * 65536;
    const src = this.src;
    const index = this.start + (position >>> 3);
    const word = (src[index] | (src[index + 1] << 8) | (src[index + 2] << 16) | (src[index + 3] << 24)) >>> (position & 7);
    return word & ((1 << count) - 1);
  }
}

/** Decode Huffman weights coded with FSE (RFC 4.2.1.2). */
function fseWeights(src, start, end) {
  const { table, next } = readFseTable(src, start, end, 255, 6);
  const bits = new BackwardBits(src, next, end);
  const weights = [];
  let state1 = bits.read(table.accuracyLog);
  let state2 = bits.read(table.accuracyLog);
  for (;;) {
    if (weights.length > 255) throw corrupt('a Huffman table has too many weights');
    weights.push(table.symbol[state1]);
    state1 = table.base[state1] + bits.read(table.bits[state1]);
    if (bits.position < 0) {
      weights.push(table.symbol[state2]);
      break;
    }
    weights.push(table.symbol[state2]);
    state2 = table.base[state2] + bits.read(table.bits[state2]);
    if (bits.position < 0) {
      weights.push(table.symbol[state1]);
      break;
    }
  }
  if (weights.length > 255) throw corrupt('a Huffman table has too many weights');
  return weights;
}

/**
 * Read a Huffman tree description at `start`; returns the decoding table
 * (`symbol` and `bits` per `maxBits`-bit prefix) and the byte after it.
 */
function readHuffmanTable(src, start, end) {
  if (start >= end) throw corrupt('a Huffman table is missing');
  const header = src[start];
  let weights;
  let next;
  if (header < 128) {
    next = start + 1 + header;
    if (next > end) throw corrupt('a Huffman table runs past its block');
    weights = fseWeights(src, start + 1, next);
  } else {
    const count = header - 127;
    next = start + 1 + ((count + 1) >> 1);
    if (next > end) throw corrupt('a Huffman table runs past its block');
    weights = new Array(count);
    for (let i = 0; i < count; i++) {
      const byte = src[start + 1 + (i >> 1)];
      weights[i] = (i & 1) === 0 ? byte >> 4 : byte & 15;
    }
  }
  let total = 0;
  for (const weight of weights) {
    if (weight > 11) throw corrupt('a Huffman weight is above 11');
    if (weight > 0) total += 1 << (weight - 1);
  }
  if (total === 0) throw corrupt('a Huffman table is empty');
  const maxBits = highBit(total) + 1;
  if (maxBits > 11) throw corrupt('a Huffman code is longer than 11 bits');
  const rest = (1 << maxBits) - total;
  if ((rest & (rest - 1)) !== 0) throw corrupt('Huffman weights do not add up');
  weights.push(highBit(rest) + 1);
  if (weights.length > 256) throw corrupt('a Huffman table has too many symbols');

  const size = 1 << maxBits;
  const symbol = new Uint8Array(size);
  const bits = new Uint8Array(size);
  const rankStart = new Uint32Array(maxBits + 2);
  for (const weight of weights) if (weight > 0) rankStart[weight + 1] += 1 << (weight - 1);
  for (let w = 1; w <= maxBits + 1; w++) rankStart[w] += rankStart[w - 1];
  for (let s = 0; s < weights.length; s++) {
    const weight = weights[s];
    if (weight === 0) continue;
    const length = 1 << (weight - 1);
    const from = rankStart[weight];
    symbol.fill(s, from, from + length);
    bits.fill(maxBits + 1 - weight, from, from + length);
    rankStart[weight] = from + length;
  }
  return { table: { symbol, bits, maxBits }, next };
}

/** Decode one Huffman stream `[start, end)` into `out[from, to)`. */
function huffmanStream(src, start, end, table, out, from, to) {
  const { symbol, bits, maxBits } = table;
  if (end <= start) throw corrupt('a Huffman stream is empty');
  const last = src[end - 1];
  if (last === 0) throw corrupt('a Huffman stream has no end marker');
  let position = (end - 1 - start) * 8 + highBit(last);
  const mask = (1 << maxBits) - 1;
  let o = from;
  // Fast path: a 32-bit container refilled to at least 24 unread bits holds
  // two whole prefixes (codes are at most 11 bits).
  if (position >= 24 && to - from >= 2) {
    const view = new DataView(src.buffer, src.byteOffset, src.length);
    const pairsEnd = to - 1;
    while (o < pairsEnd && position >= 24) {
      const at = (position >> 3) - 3;
      const cont = view.getInt32(start + at, true);
      let avail = position - (at << 3);
      let prefix = (cont >>> (avail - maxBits)) & mask;
      out[o++] = symbol[prefix];
      avail -= bits[prefix];
      prefix = (cont >>> (avail - maxBits)) & mask;
      out[o++] = symbol[prefix];
      avail -= bits[prefix];
      position = (at << 3) + avail;
    }
  }
  while (o < to && position >= maxBits) {
    const at = position - maxBits;
    const index = start + (at >>> 3);
    const prefix = ((src[index] | (src[index + 1] << 8) | (src[index + 2] << 16)) >>> (at & 7)) & mask;
    out[o++] = symbol[prefix];
    position -= bits[prefix];
  }
  while (o < to) {
    if (position <= 0) throw corrupt('a Huffman stream ends early');
    const index = start;
    const word = (src[index] | (src[index + 1] << 8) | (src[index + 2] << 16)) & ((1 << position) - 1);
    const prefix = (word << (maxBits - position)) & mask;
    out[o++] = symbol[prefix];
    position -= bits[prefix];
  }
  if (position !== 0) throw corrupt('a Huffman stream does not end where it should');
}

/** Output of a frame: fixed when the size is known, growing otherwise. */
class Output {
  constructor(expectedSize) {
    this.fixed = expectedSize !== null;
    this.bytes = new Uint8Array(this.fixed ? expectedSize : 64 * 1024);
    this.length = 0;
  }

  reserve(count) {
    const needed = this.length + count;
    if (needed <= this.bytes.length) return;
    if (this.fixed) throw corrupt(`it decodes to more than the ${this.bytes.length} bytes expected`);
    const grown = new Uint8Array(Math.max(needed, this.bytes.length * 2));
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
  }
}

/** Decode the literals section at `start`; returns the literals and the byte after it. */
function readLiterals(src, start, end, frame) {
  const b0 = src[start];
  const type = b0 & 3;
  const sizeFormat = (b0 >> 2) & 3;
  let p = start;
  if (type < 2) {
    let size;
    if ((sizeFormat & 1) === 0) {
      size = b0 >> 3;
      p += 1;
    } else if (sizeFormat === 1) {
      size = (b0 >> 4) | (src[p + 1] << 4);
      p += 2;
    } else {
      size = (b0 >> 4) | (src[p + 1] << 4) | (src[p + 2] << 12);
      p += 3;
    }
    if (size > MAX_BLOCK_BYTES) throw corrupt('a literals section is larger than a block');
    if (type === 0) {
      if (p + size > end) throw corrupt('raw literals run past their block');
      return { literals: src.subarray(p, p + size), next: p + size };
    }
    if (p >= end) throw corrupt('run-length literals are missing their byte');
    return { literals: frame.literalBuffer.subarray(0, size).fill(src[p]), next: p + 1 };
  }
  let size;
  let compressedSize;
  let streams = sizeFormat === 0 ? 1 : 4;
  if (sizeFormat < 2) {
    const v = b0 | (src[p + 1] << 8) | (src[p + 2] << 16);
    size = (v >> 4) & 0x3ff;
    compressedSize = (v >> 14) & 0x3ff;
    p += 3;
  } else if (sizeFormat === 2) {
    const v = (b0 | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24)) >>> 0;
    size = (v >>> 4) & 0x3fff;
    compressedSize = v >>> 18;
    p += 4;
  } else {
    size = (b0 >> 4) | (src[p + 1] << 4) | ((src[p + 2] & 0x3f) << 12);
    compressedSize = (src[p + 2] >> 6) | (src[p + 3] << 2) | (src[p + 4] << 10);
    p += 5;
  }
  if (size > MAX_BLOCK_BYTES) throw corrupt('a literals section is larger than a block');
  const literalsEnd = p + compressedSize;
  if (literalsEnd > end) throw corrupt('compressed literals run past their block');
  if (type === 2) {
    const { table, next } = readHuffmanTable(src, p, literalsEnd);
    frame.huffman = table;
    p = next;
  } else if (frame.huffman === null) {
    throw corrupt('literals repeat a Huffman table that was never sent');
  }
  const out = frame.literalBuffer;
  if (streams === 1) {
    huffmanStream(src, p, literalsEnd, frame.huffman, out, 0, size);
  } else {
    if (p + 6 > literalsEnd) throw corrupt('a four-stream jump table is truncated');
    const size1 = src[p] | (src[p + 1] << 8);
    const size2 = src[p + 2] | (src[p + 3] << 8);
    const size3 = src[p + 4] | (src[p + 5] << 8);
    const s1 = p + 6;
    const s2 = s1 + size1;
    const s3 = s2 + size2;
    const s4 = s3 + size3;
    if (s4 > literalsEnd) throw corrupt('four-stream literals run past their section');
    const segment = (size + 3) >> 2;
    if (3 * segment > size) throw corrupt('four-stream literals are too short');
    huffmanStream(src, s1, s2, frame.huffman, out, 0, segment);
    huffmanStream(src, s2, s3, frame.huffman, out, segment, 2 * segment);
    huffmanStream(src, s3, s4, frame.huffman, out, 2 * segment, 3 * segment);
    huffmanStream(src, s4, literalsEnd, frame.huffman, out, 3 * segment, size);
  }
  return { literals: out.subarray(0, size), next: literalsEnd };
}

function sequenceTable(mode, src, p, end, predefined, maxSymbol, maxAccuracyLog, previous, what) {
  if (mode === 0) return { table: predefined, next: p };
  if (mode === 1) {
    if (p >= end) throw corrupt(`the ${what} code is missing`);
    if (src[p] > maxSymbol) throw corrupt(`a ${what} code is out of range`);
    return { table: rleTable(src[p]), next: p + 1 };
  }
  if (mode === 2) return readFseTable(src, p, end, maxSymbol, maxAccuracyLog);
  if (previous === null) throw corrupt(`${what} codes repeat a table that was never sent`);
  return { table: previous, next: p };
}

function copyLiterals(out, o, literals, from, count) {
  if (count > 32) {
    out.set(literals.subarray(from, from + count), o);
  } else {
    for (let i = 0; i < count; i++) out[o + i] = literals[from + i];
  }
}

/**
 * A sequence table's per-state values packed for the sequence loop, built
 * once per table (a table repeated from the previous block keeps them):
 * `transition` is the next state's base and the bits to read for it
 * (`base << 4 | bits`); `code` is, for literal and match lengths, the code's
 * base value and extra-bit count (`value << 5 | extra`), and for offsets the
 * offset code.
 */
function sequenceCodes(table, bases, extraBits) {
  if (table.transition === undefined) {
    const size = table.symbol.length;
    const transition = new Int32Array(size);
    const code = new Int32Array(size);
    for (let state = 0; state < size; state++) {
      const symbol = table.symbol[state];
      transition[state] = (table.base[state] << 4) | table.bits[state];
      code[state] = bases === null ? symbol : (bases[symbol] << 5) | extraBits[symbol];
    }
    table.transition = transition;
    table.code = code;
  }
  return table;
}

/** Decode one compressed block `[start, end)` into the frame's output. */
function compressedBlock(src, start, end, frame, output) {
  const { literals, next } = readLiterals(src, start, end, frame);
  let p = next;
  if (p >= end) throw corrupt('a block has no sequences section');
  let sequences = src[p++];
  if (sequences >= 128) {
    if (sequences === 255) {
      if (p + 2 > end) throw corrupt('a sequence count is truncated');
      sequences = src[p] + (src[p + 1] << 8) + 0x7f00;
      p += 2;
    } else {
      if (p >= end) throw corrupt('a sequence count is truncated');
      sequences = ((sequences - 128) << 8) + src[p++];
    }
  }
  if (sequences === 0) {
    if (p !== end) throw corrupt('a block has bytes after its literals');
    output.reserve(literals.length);
    copyLiterals(output.bytes, output.length, literals, 0, literals.length);
    output.length += literals.length;
    return;
  }
  if (p >= end) throw corrupt('the sequence compression modes are missing');
  const modes = src[p++];
  if ((modes & 3) !== 0) throw corrupt('reserved sequence mode bits are set');
  let found = sequenceTable(modes >> 6, src, p, end, LL_PREDEFINED, 35, 9, frame.literalLengths, 'literal length');
  const ll = found.table;
  found = sequenceTable((modes >> 4) & 3, src, found.next, end, OF_PREDEFINED, 31, 8, frame.offsets, 'offset');
  const of = found.table;
  found = sequenceTable((modes >> 2) & 3, src, found.next, end, ML_PREDEFINED, 52, 9, frame.matchLengths, 'match length');
  const ml = found.table;
  frame.literalLengths = ll;
  frame.offsets = of;
  frame.matchLengths = ml;

  sequenceCodes(ll, LL_BASE, LL_BITS);
  sequenceCodes(ml, ML_BASE, ML_BITS);
  sequenceCodes(of, null, null);
  const llCodes = ll.code;
  const llNext = ll.transition;
  const mlCodes = ml.code;
  const mlNext = ml.transition;
  const ofCodes = of.code;
  const ofNext = of.transition;
  const stateBits = ll.accuracyLog + ml.accuracyLog;

  // The sequence bit stream, read backward (RFC 4.1) through a 32-bit
  // container held in locals: `cont` holds stream bytes [at, at + 4), and
  // `avail` bits of it, from the bottom, are still unread (so `8 * at +
  // avail` bits of the stream are). A refill moves the container down to the
  // next unread bits, leaving at least 24 of them in it. Reading past the
  // stream's start reads garbage that can only decode to bounded values, and
  // leaves the stream's position negative, which is refused below.
  let bitStart = found.next;
  if (end <= bitStart) throw corrupt('a bit stream is empty');
  const lastByte = src[end - 1];
  if (lastByte === 0) throw corrupt('a bit stream has no end marker');
  let avail = (end - 1 - bitStart) * 8 + highBit(lastByte);
  // Every refill reads four bytes of the stream; a shorter stream is padded.
  let bitSource = src;
  if (end - bitStart < 4) {
    bitSource = new Uint8Array(4);
    bitSource.set(src.subarray(bitStart, end));
    bitStart = 0;
  }
  const bitView = new DataView(bitSource.buffer, bitSource.byteOffset, bitSource.length);
  let at = 0;
  let cont = 0;
  // Refill (written out at each use, so the container stays in registers).
  avail += at << 3; at = (avail >> 3) - 3; if (at < 0) at = 0; avail -= at << 3;
  cont = bitView.getInt32(bitStart + at, true);

  let n = ll.accuracyLog;
  avail -= n;
  let llState = (cont >>> avail) & ((1 << n) - 1);
  n = of.accuracyLog;
  if (avail < n) {
    avail += at << 3; at = (avail >> 3) - 3; if (at < 0) at = 0; avail -= at << 3;
    cont = bitView.getInt32(bitStart + at, true);
  }
  avail -= n;
  let ofState = (cont >>> avail) & ((1 << n) - 1);
  n = ml.accuracyLog;
  if (avail < n) {
    avail += at << 3; at = (avail >> 3) - 3; if (at < 0) at = 0; avail -= at << 3;
    cont = bitView.getInt32(bitStart + at, true);
  }
  avail -= n;
  let mlState = (cont >>> avail) & ((1 << n) - 1);

  const repeats = frame.repeats;
  let rep0 = repeats[0];
  let rep1 = repeats[1];
  let rep2 = repeats[2];
  let literalPos = 0;
  const literalCount = literals.length;
  const literalView = new DataView(literals.buffer, literals.byteOffset, literals.length);
  const frameStart = frame.outputStart;
  let out = output.bytes;
  let view = new DataView(out.buffer, out.byteOffset, out.length);
  let capacity = out.length;
  let o = output.length;

  for (let i = 0; i < sequences; i++) {
    // Offset, then match length, then literal length extra bits.
    const ofCode = ofCodes[ofState];
    if (avail < 24) {
      avail += at << 3; at = (avail >> 3) - 3; if (at < 0) at = 0; avail -= at << 3;
      cont = bitView.getInt32(bitStart + at, true);
    }
    let offset;
    if (ofCode <= 24) {
      avail -= ofCode;
      offset = (1 << ofCode) + ((cont >>> avail) & ((1 << ofCode) - 1));
    } else {
      // More extra bits than one refill guarantees: the high bits, then 16.
      if (ofCode > 31) throw corrupt('an offset code is out of range');
      n = ofCode - 16;
      avail -= n;
      const high = (cont >>> avail) & ((1 << n) - 1);
      avail += at << 3; at = (avail >> 3) - 3; if (at < 0) at = 0; avail -= at << 3;
      cont = bitView.getInt32(bitStart + at, true);
      avail -= 16;
      offset = 2 ** ofCode + high * 65536 + ((cont >>> avail) & 0xffff);
    }
    const mlCode = mlCodes[mlState];
    n = mlCode & 31;
    if (avail < n) {
      avail += at << 3; at = (avail >> 3) - 3; if (at < 0) at = 0; avail -= at << 3;
      cont = bitView.getInt32(bitStart + at, true);
    }
    avail -= n;
    const matchLength = (mlCode >> 5) + ((cont >>> avail) & ((1 << n) - 1));
    const llCode = llCodes[llState];
    n = llCode & 31;
    if (avail < n) {
      avail += at << 3; at = (avail >> 3) - 3; if (at < 0) at = 0; avail -= at << 3;
      cont = bitView.getInt32(bitStart + at, true);
    }
    avail -= n;
    const literalLength = (llCode >> 5) + ((cont >>> avail) & ((1 << n) - 1));

    if (offset > 3) {
      offset -= 3;
      rep2 = rep1;
      rep1 = rep0;
      rep0 = offset;
    } else {
      const index = offset - (literalLength !== 0 ? 1 : 0);
      if (index === 0) {
        offset = rep0;
      } else {
        offset = index === 3 ? rep0 - 1 : index === 1 ? rep1 : rep2;
        if (index > 1) rep2 = rep1;
        rep1 = rep0;
        rep0 = offset;
      }
    }

    if (i + 1 < sequences) {
      // States: literal length, match length, offset.
      if (avail < stateBits) {
        avail += at << 3; at = (avail >> 3) - 3; if (at < 0) at = 0; avail -= at << 3;
        cont = bitView.getInt32(bitStart + at, true);
      }
      let step = llNext[llState];
      n = step & 15;
      avail -= n;
      llState = (step >> 4) + ((cont >>> avail) & ((1 << n) - 1));
      step = mlNext[mlState];
      n = step & 15;
      avail -= n;
      mlState = (step >> 4) + ((cont >>> avail) & ((1 << n) - 1));
      step = ofNext[ofState];
      n = step & 15;
      if (avail < n) {
        avail += at << 3; at = (avail >> 3) - 3; if (at < 0) at = 0; avail -= at << 3;
        cont = bitView.getInt32(bitStart + at, true);
      }
      avail -= n;
      ofState = (step >> 4) + ((cont >>> avail) & ((1 << n) - 1));
    }

    if (literalPos + literalLength > literalCount) throw corrupt('a sequence uses more literals than the block holds');
    if (o + literalLength + matchLength > capacity) {
      output.length = o;
      output.reserve(literalLength + matchLength);
      out = output.bytes;
      view = new DataView(out.buffer, out.byteOffset, out.length);
      capacity = out.length;
    }
    if (literalLength > 0) {
      if (literalLength <= 8 && literalPos + 8 <= literalCount && o + 8 <= capacity) {
        // Eight bytes, the rest overwritten by the match that follows.
        view.setInt32(o, literalView.getInt32(literalPos, true), true);
        view.setInt32(o + 4, literalView.getInt32(literalPos + 4, true), true);
        o += literalLength;
        literalPos += literalLength;
      } else if (literalLength > 32) {
        out.set(literals.subarray(literalPos, literalPos + literalLength), o);
        o += literalLength;
        literalPos += literalLength;
      } else {
        for (const literalStop = literalPos + literalLength; literalPos < literalStop;) out[o++] = literals[literalPos++];
      }
    }
    if (offset < 1 || offset > o - frameStart) throw corrupt('a match reaches before the start of the frame');
    const stop = o + matchLength;
    if (offset >= 8 && matchLength < BLOCK_COPY_BYTES && stop + 8 <= capacity) {
      // Eight bytes at a time, possibly past the match's end (bytes the
      // sequences after it overwrite): a source at least eight bytes back is
      // already written, so this also repeats a pattern of eight or more.
      let from = o - offset;
      do {
        view.setInt32(o, view.getInt32(from, true), true);
        view.setInt32(o + 4, view.getInt32(from + 4, true), true);
        o += 8;
        from += 8;
      } while (o < stop);
    } else {
      copyMatch(out, view, o, offset, matchLength);
    }
    o = stop;
  }
  output.length = o;
  repeats[0] = rep0;
  repeats[1] = rep1;
  repeats[2] = rep2;
  if (8 * at + avail !== 0) throw corrupt('the sequence bit stream does not end where it should');
  const rest = literalCount - literalPos;
  output.reserve(rest);
  copyLiterals(output.bytes, output.length, literals, literalPos, rest);
  output.length += rest;
}

function readUint32(src, at) {
  return (src[at] | (src[at + 1] << 8) | (src[at + 2] << 16) | (src[at + 3] << 24)) >>> 0;
}

/** Decode one frame starting at `start`; returns the byte after it. */
function decodeFrame(src, start, output) {
  let p = start + 4;
  if (p >= src.length) throw corrupt('a frame header is truncated');
  const descriptor = src[p++];
  const contentSizeFlag = descriptor >> 6;
  const singleSegment = (descriptor >> 5) & 1;
  const hasChecksum = (descriptor >> 2) & 1;
  const dictionaryFlag = descriptor & 3;
  if ((descriptor & 8) !== 0) throw corrupt('a reserved frame header bit is set');
  if (!singleSegment) p++;
  const dictionaryBytes = [0, 1, 2, 4][dictionaryFlag];
  let dictionary = 0;
  for (let i = 0; i < dictionaryBytes; i++) dictionary += src[p + i] * 2 ** (8 * i);
  p += dictionaryBytes;
  if (dictionary !== 0) {
    throw new ZarrUnsupportedError('Zstandard dictionary', 'This Zstandard data was compressed with a dictionary, which Zarr never uses and this reader does not read.');
  }
  const sizeBytes = [singleSegment ? 1 : 0, 2, 4, 8][contentSizeFlag];
  let contentSize = null;
  if (sizeBytes > 0) {
    if (p + sizeBytes > src.length) throw corrupt('a frame header is truncated');
    contentSize = 0;
    for (let i = 0; i < sizeBytes; i++) contentSize += src[p + i] * 2 ** (8 * i);
    if (sizeBytes === 2) contentSize += 256;
    p += sizeBytes;
  }
  if (contentSize !== null) output.reserve(contentSize);

  const frame = {
    outputStart: output.length,
    repeats: new Int32Array([1, 4, 8]),
    huffman: null,
    literalLengths: null,
    offsets: null,
    matchLengths: null,
    literalBuffer: LITERALS,
  };
  for (let last = 0; !last;) {
    if (p + 3 > src.length) throw corrupt('a block header is truncated');
    const header = src[p] | (src[p + 1] << 8) | (src[p + 2] << 16);
    p += 3;
    last = header & 1;
    const type = (header >> 1) & 3;
    const size = header >>> 3;
    if (type === 0) {
      if (p + size > src.length) throw corrupt('a raw block is truncated');
      output.reserve(size);
      output.bytes.set(src.subarray(p, p + size), output.length);
      output.length += size;
      p += size;
    } else if (type === 1) {
      if (p >= src.length) throw corrupt('a run-length block is truncated');
      output.reserve(size);
      output.bytes.fill(src[p], output.length, output.length + size);
      output.length += size;
      p += 1;
    } else if (type === 2) {
      if (size > MAX_BLOCK_BYTES || p + size > src.length) throw corrupt('a compressed block is truncated');
      compressedBlock(src, p, p + size, frame, output);
      p += size;
    } else {
      throw corrupt('a block has the reserved type');
    }
  }
  if (hasChecksum) p += 4;
  if (p > src.length) throw corrupt('the frame checksum is truncated');
  if (contentSize !== null && output.length - frame.outputStart !== contentSize) {
    throw corrupt(`a frame declares ${contentSize} bytes and holds ${output.length - frame.outputStart}`);
  }
  return p;
}

/**
 * Decompress every frame of `input`.
 *
 * @param {Uint8Array} input
 * @param {number|null} [expectedSize] - The exact decompressed size, when known:
 *   the output is allocated once at that size and nothing is written past it
 * @returns {Uint8Array}
 */
export function zstdDecompress(input, expectedSize = null) {
  const output = new Output(expectedSize);
  let p = 0;
  while (p < input.length) {
    if (p + 4 > input.length) throw corrupt('trailing bytes follow the last frame');
    const magic = readUint32(input, p);
    if (magic === FRAME_MAGIC) {
      p = decodeFrame(input, p, output);
    } else if (((magic & SKIPPABLE_MASK) >>> 0) === SKIPPABLE_MAGIC) {
      p += 8 + readUint32(input, p + 4);
    } else {
      throw corrupt('it does not start with a Zstandard frame');
    }
  }
  if (p > input.length) throw corrupt('a skippable frame is truncated');
  if (expectedSize !== null) {
    if (output.length !== expectedSize) {
      throw corrupt(`it decodes to ${output.length} bytes, not the ${expectedSize} expected`);
    }
    return output.bytes;
  }
  return output.bytes.length === output.length ? output.bytes : output.bytes.slice(0, output.length);
}
