/**
 * bzip2 decompression, streaming, in plain JavaScript (`save()` and
 * `saveRDS(compress = "bzip2")`; SeuratObject's own `pbmc_small` is one).
 *
 * A bzip2 stream is a header (`BZh` and the block size, 1–9 hundred
 * thousand bytes), then blocks, each decoded on its own: Huffman-coded
 * symbols over up to six tables, a move-to-front and run-length stage, the
 * inverse Burrows–Wheeler transform, and a final run-length stage. A block's
 * compressed bits never exceed its block size by more than a few percent, so
 * the input is buffered a little past one block size and each block decoded
 * at once; memory is a few blocks. Every block's CRC is checked; the
 * randomised blocks of bzip2 0.9.0 and earlier, which no current writer
 * makes, are refused.
 * Concatenated streams (parallel compressors) are read one after another.
 *
 * @module formats/rds/bzip2
 */

import { RdsFormatError, RdsUnsupportedError } from './errors.js';

const BLOCK_MAGIC_HIGH = 0x314159;
const BLOCK_MAGIC_LOW = 0x265359;
const END_MAGIC_HIGH = 0x177245;
const END_MAGIC_LOW = 0x385090;
const GROUP_SIZE = 50;
const MAX_GROUPS = 6;
const MAX_CODE_LENGTH = 20;
const MAX_SELECTORS = 18002;

let crcTable = null;
function crcTableOf() {
  if (crcTable !== null) return crcTable;
  crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    crcTable[i] = c >>> 0;
  }
  return crcTable;
}

function damaged(message) {
  return new RdsFormatError(`The bzip2 stream is damaged: ${message}.`);
}

/** The compressed bytes buffered for the block being decoded, read bit by bit. */
class Bits {
  constructor() {
    this.bytes = new Uint8Array(0);
    this.pos = 0;
    this.buffer = 0;
    this.count = 0;
  }

  /** Append input, dropping what was read. */
  append(piece) {
    const rest = this.bytes.length - this.pos;
    const joined = new Uint8Array(rest + piece.length);
    joined.set(this.bytes.subarray(this.pos));
    joined.set(piece, rest);
    this.bytes = joined;
    this.pos = 0;
  }

  get buffered() {
    return this.bytes.length - this.pos;
  }

  read(n) {
    while (this.count < n) {
      if (this.pos >= this.bytes.length) throw damaged('it ends inside a block');
      this.buffer = ((this.buffer << 8) | this.bytes[this.pos++]) >>> 0;
      this.count += 8;
    }
    this.count -= n;
    return (this.buffer >>> this.count) & ((1 << n) - 1);
  }

  bit() {
    if (this.count === 0) {
      if (this.pos >= this.bytes.length) throw damaged('it ends inside a block');
      this.buffer = this.bytes[this.pos++];
      this.count = 8;
    }
    this.count -= 1;
    return (this.buffer >>> this.count) & 1;
  }

  read32() {
    return ((this.read(16) << 16) | this.read(16)) >>> 0;
  }

  /** Drop the bits left in the current byte (a stream ends on a byte boundary). */
  align() {
    this.count -= this.count % 8;
  }

  /** Whole bytes left, counting buffered bits. */
  get bytesLeft() {
    return this.bytes.length - this.pos + Math.floor(this.count / 8);
  }
}

/** Decode tables of one Huffman group (canonical code, as bzip2 builds them). */
function decodeTables(lengths, alphaSize) {
  let minLength = 32;
  let maxLength = 0;
  for (let i = 0; i < alphaSize; i++) {
    if (lengths[i] > maxLength) maxLength = lengths[i];
    if (lengths[i] < minLength) minLength = lengths[i];
  }
  const perm = new Int32Array(alphaSize);
  let p = 0;
  for (let length = minLength; length <= maxLength; length++) {
    for (let symbol = 0; symbol < alphaSize; symbol++) if (lengths[symbol] === length) perm[p++] = symbol;
  }
  const base = new Int32Array(MAX_CODE_LENGTH + 2);
  const limit = new Int32Array(MAX_CODE_LENGTH + 2).fill(-1);
  for (let i = 0; i < alphaSize; i++) base[lengths[i] + 1]++;
  for (let i = 1; i < base.length; i++) base[i] += base[i - 1];
  let vec = 0;
  for (let length = minLength; length <= maxLength; length++) {
    vec += base[length + 1] - base[length];
    limit[length] = vec - 1;
    vec <<= 1;
  }
  for (let length = minLength + 1; length <= maxLength; length++) {
    base[length] = ((limit[length - 1] + 1) << 1) - base[length];
  }
  return { minLength, maxLength, perm, base, limit };
}

/**
 * Decode one block (after its magic): its bytes, before the final
 * run-length stage is undone.
 */
function decodeBlock(bits, blockSize, tt) {
  const storedCrc = bits.read32();
  if (bits.bit()) {
    throw new RdsUnsupportedError('randomised bzip2 block', 'This bzip2 file uses randomised blocks, which no current bzip2 writes. Compress it again with bzip2 or gzip.');
  }
  const origPtr = bits.read(24);
  const used = bits.read(16);
  const seqToUnseq = [];
  for (let i = 0; i < 16; i++) {
    if (used & (1 << (15 - i))) {
      const word = bits.read(16);
      for (let j = 0; j < 16; j++) if (word & (1 << (15 - j))) seqToUnseq.push(i * 16 + j);
    }
  }
  if (seqToUnseq.length === 0) throw damaged('a block uses no byte value');
  const alphaSize = seqToUnseq.length + 2;
  const groups = bits.read(3);
  if (groups < 2 || groups > MAX_GROUPS) throw damaged(`a block has ${groups} Huffman tables`);
  const selectorCount = bits.read(15);
  if (selectorCount < 1) throw damaged('a block has no table selectors');
  const order = [0, 1, 2, 3, 4, 5].slice(0, groups);
  const selectors = new Uint8Array(Math.min(selectorCount, MAX_SELECTORS));
  for (let i = 0; i < selectorCount; i++) {
    let j = 0;
    while (bits.bit()) {
      j++;
      if (j >= groups) throw damaged('a table selector names no table');
    }
    const value = order[j];
    for (let k = j; k > 0; k--) order[k] = order[k - 1];
    order[0] = value;
    if (i < MAX_SELECTORS) selectors[i] = value;
  }
  const tables = [];
  for (let t = 0; t < groups; t++) {
    const lengths = new Uint8Array(alphaSize);
    let length = bits.read(5);
    for (let symbol = 0; symbol < alphaSize; symbol++) {
      for (;;) {
        if (length < 1 || length > MAX_CODE_LENGTH) throw damaged('a code length is out of range');
        if (!bits.bit()) break;
        length += bits.bit() ? -1 : 1;
      }
      lengths[symbol] = length;
    }
    tables.push(decodeTables(lengths, alphaSize));
  }

  const endOfBlock = alphaSize - 1;
  const counts = new Int32Array(256);
  const mtf = new Uint8Array(256);
  for (let i = 0; i < 256; i++) mtf[i] = i;
  let groupIndex = -1;
  let groupLeft = 0;
  let table = null;
  const nextSymbol = () => {
    if (groupLeft === 0) {
      groupIndex++;
      if (groupIndex >= selectors.length) throw damaged('a block uses more table selectors than it has');
      table = tables[selectors[groupIndex]];
      groupLeft = GROUP_SIZE;
    }
    groupLeft--;
    let length = table.minLength;
    let code = bits.read(length);
    while (code > table.limit[length]) {
      length++;
      if (length > table.maxLength) throw damaged('a Huffman code is not in its table');
      code = (code << 1) | bits.bit();
    }
    const index = code - table.base[length];
    if (index < 0 || index >= table.perm.length) throw damaged('a Huffman code is not in its table');
    return table.perm[index];
  };

  let count = 0;
  let symbol = nextSymbol();
  for (;;) {
    if (symbol === endOfBlock) break;
    if (symbol <= 1) {
      // A run of the front symbol, its length in bijective base 2 (RUNA, RUNB).
      let run = 0;
      let weight = 1;
      do {
        run += symbol === 0 ? weight : 2 * weight;
        weight *= 2;
        if (run > blockSize) throw damaged('a run is longer than its block');
        symbol = nextSymbol();
      } while (symbol <= 1);
      const value = seqToUnseq[mtf[0]];
      if (count + run > blockSize) throw damaged('a block is longer than its block size');
      counts[value] += run;
      tt.fill(value, count, count + run);
      count += run;
      continue;
    }
    const position = symbol - 1;
    if (position >= seqToUnseq.length) throw damaged('a symbol is outside the block alphabet');
    const front = mtf[position];
    mtf.copyWithin(1, 0, position);
    mtf[0] = front;
    const value = seqToUnseq[front];
    if (count >= blockSize) throw damaged('a block is longer than its block size');
    counts[value]++;
    tt[count++] = value;
    symbol = nextSymbol();
  }
  if (origPtr >= count) throw damaged('a block starts outside itself');

  // The inverse Burrows-Wheeler transform.
  const start = new Int32Array(256);
  for (let i = 0, sum = 0; i < 256; i++) {
    start[i] = sum;
    sum += counts[i];
  }
  for (let i = 0; i < count; i++) {
    const value = tt[i] & 0xff;
    tt[start[value]++] |= i << 8;
  }
  const out = new Uint8Array(count);
  let position = tt[origPtr] >>> 8;
  for (let i = 0; i < count; i++) {
    const entry = tt[position];
    out[i] = entry & 0xff;
    position = entry >>> 8;
  }
  return { out, storedCrc };
}

/** Undo the final run-length stage (four equal bytes, then a count of more). */
function expandRuns(bytes) {
  let total = 0;
  for (let i = 0, run = 0, last = -1; i < bytes.length; i++) {
    if (run === 4) {
      total += bytes[i];
      run = 0;
      last = -1;
      continue;
    }
    const value = bytes[i];
    run = value === last ? run + 1 : 1;
    last = value;
    total++;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (let i = 0, run = 0, last = -1; i < bytes.length; i++) {
    if (run === 4) {
      out.fill(last, o, o + bytes[i]);
      o += bytes[i];
      run = 0;
      last = -1;
      continue;
    }
    const value = bytes[i];
    run = value === last ? run + 1 : 1;
    last = value;
    out[o++] = value;
  }
  return out;
}

function blockCrc(bytes) {
  const table = crcTableOf();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = ((crc << 8) ^ table[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  return (~crc) >>> 0;
}

/**
 * Decompress bzip2 pieces as they arrive.
 *
 * @param {AsyncIterable<Uint8Array>} pieces
 * @param {{signal?: AbortSignal|null}} [options]
 * @returns {AsyncGenerator<Uint8Array>}
 */
export async function* bunzip2(pieces, { signal = null } = {}) {
  const iterator = pieces[Symbol.asyncIterator]();
  const bits = new Bits();
  let ended = false;
  const ensure = async bytes => {
    while (!ended && bits.buffered < bytes) {
      const { value, done } = await iterator.next();
      if (done) ended = true;
      else bits.append(value);
    }
  };
  let streams = 0;
  for (;;) {
    await ensure(4);
    if (bits.bytesLeft === 0 && streams > 0) return;
    if (bits.read(8) !== 0x42 || bits.read(8) !== 0x5a || bits.read(8) !== 0x68) {
      if (streams > 0) throw damaged('data follows its end');
      throw damaged('it does not start with BZh');
    }
    const level = bits.read(8) - 0x30;
    if (level < 1 || level > 9) throw damaged(`its block size digit is ${level}`);
    const blockSize = level * 100000;
    const tt = new Uint32Array(blockSize);
    streams++;
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('The read was aborted.', 'AbortError');
      // A compressed block is never much longer than its block size.
      await ensure(blockSize * 1.25 + 4096);
      const high = bits.read(24);
      const low = bits.read(24);
      if (high === END_MAGIC_HIGH && low === END_MAGIC_LOW) {
        bits.read32();
        bits.align();
        break;
      }
      if (high !== BLOCK_MAGIC_HIGH || low !== BLOCK_MAGIC_LOW) throw damaged('a block does not start with its marker');
      const { out, storedCrc } = decodeBlock(bits, blockSize, tt);
      const expanded = expandRuns(out);
      if (blockCrc(expanded) !== storedCrc) throw damaged('a block does not match its checksum');
      yield expanded;
    }
    await ensure(1);
    if (ended && bits.bytesLeft === 0) return;
  }
}
