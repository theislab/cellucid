/**
 * xz decompression, streaming, in plain JavaScript (`save(compress = "xz")`,
 * the compression of most CRAN and Bioconductor data files; no WebAssembly,
 * so no change to the page's script policy).
 *
 * An xz file is streams of blocks; each block is an LZMA2 stream (the only
 * filter R's `xzfile()` writes; any other filter chain is refused) followed
 * by its check (CRC32 for R, verified; CRC64 and SHA-256 are skipped, the
 * LZMA2 decoder catching a damaged stream on its own). LZMA2 is a sequence of
 * chunks: stored ones, and LZMA ones of at most 2 MiB of output and 64 KiB
 * of input, each decoded at once from the buffered input into the sliding
 * dictionary, from which the new bytes are handed on. Memory is the
 * dictionary (the size the file states, at most what the block's stated
 * output needs) and one chunk of input.
 *
 * The LZMA decoder follows the reference decoder (LZMA SDK `LzmaDec.c`,
 * xz-embedded `xz_dec_lzma2.c`): an adaptive binary range coder over the
 * literal, match, repeat-match, length and distance models.
 *
 * @module formats/rds/xz
 */

import { crc32 } from '../zip/crc32.js';
import { RdsFormatError, RdsUnsupportedError } from './errors.js';

function damaged(message) {
  return new RdsFormatError(`The xz stream is damaged: ${message}.`);
}

/** The compressed input, buffered as it arrives. */
class Input {
  constructor(iterator) {
    this.iterator = iterator;
    this.bytes = new Uint8Array(0);
    this.pos = 0;
    this.ended = false;
    /** Bytes dropped from the front of `bytes` so far: `base + pos` is the absolute position. */
    this.base = 0;
  }

  /** The absolute position in the compressed stream. */
  get position() {
    return this.base + this.pos;
  }

  get buffered() {
    return this.bytes.length - this.pos;
  }

  async ensure(count) {
    while (this.bytes.length - this.pos < count && !this.ended) {
      const { value, done } = await this.iterator.next();
      if (done) {
        this.ended = true;
        break;
      }
      const rest = this.bytes.length - this.pos;
      const joined = new Uint8Array(rest + value.length);
      joined.set(this.bytes.subarray(this.pos));
      joined.set(value, rest);
      this.base += this.pos;
      this.bytes = joined;
      this.pos = 0;
    }
    if (this.bytes.length - this.pos < count) throw damaged('it ends early');
  }

  byte() {
    return this.bytes[this.pos++];
  }

  /** A multibyte integer, reading more input as it needs. */
  async varintAsync() {
    let value = 0;
    for (let shift = 0; shift < 63; shift += 7) {
      await this.ensure(1);
      const b = this.bytes[this.pos++];
      value += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return value;
    }
    throw damaged('a size field is too long');
  }

  /** A multibyte integer (7 bits per byte, low first). */
  varint() {
    let value = 0;
    for (let shift = 0; shift < 63; shift += 7) {
      if (this.pos >= this.bytes.length) throw damaged('a size field ends early');
      const b = this.bytes[this.pos++];
      value += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return value;
    }
    throw damaged('a size field is too long');
  }
}

const STATES = 12;
const POS_STATES_MAX = 16;
const LITERAL_STATES = 7;
const END_POS_MODEL_INDEX = 14;
const FULL_DISTANCES = 128;
const ALIGN_BITS = 4;
const MATCH_MIN = 2;

class LengthModel {
  constructor() {
    this.choice = new Uint16Array(2);
    this.low = new Uint16Array(POS_STATES_MAX << 3);
    this.mid = new Uint16Array(POS_STATES_MAX << 3);
    this.high = new Uint16Array(256);
  }

  reset() {
    this.choice.fill(1024);
    this.low.fill(1024);
    this.mid.fill(1024);
    this.high.fill(1024);
  }
}

/** An LZMA decoder over one sliding dictionary (LZMA2 keeps it across chunks). */
class Lzma {
  constructor(dictionarySize) {
    this.dict = new Uint8Array(dictionarySize);
    this.dictSize = dictionarySize;
    /** Write position in `dict`, and how full it has ever been. */
    this.pos = 0;
    this.full = 0;
    /** Bytes written since the last `take()`. */
    this.pending = 0;
    this.isMatch = new Uint16Array(STATES << 4);
    this.isRep = new Uint16Array(STATES);
    this.isRepG0 = new Uint16Array(STATES);
    this.isRepG1 = new Uint16Array(STATES);
    this.isRepG2 = new Uint16Array(STATES);
    this.isRep0Long = new Uint16Array(STATES << 4);
    this.posSlot = new Uint16Array(4 << 6);
    this.specPos = new Uint16Array(FULL_DISTANCES - END_POS_MODEL_INDEX + 1);
    this.align = new Uint16Array(1 << ALIGN_BITS);
    this.lengths = new LengthModel();
    this.repLengths = new LengthModel();
    this.literal = new Uint16Array(0x300 << 4);
    this.lc = 0;
    this.lp = 0;
    this.pb = 0;
    this.state = 0;
    this.reps = [0, 0, 0, 0];
    this.haveProperties = false;
    /** Bytes decoded since the stream began (positions for the literal and match models). */
    this.total = 0;
  }

  resetDictionary() {
    this.pos = 0;
    this.full = 0;
  }

  setProperties(byte) {
    if (byte > (4 * 5 + 4) * 9 + 8) throw damaged('an LZMA properties byte is out of range');
    this.lc = byte % 9;
    const rest = Math.floor(byte / 9);
    this.lp = rest % 5;
    this.pb = Math.floor(rest / 5);
    if (this.lc + this.lp > 4) throw damaged('LZMA2 literal bits exceed four');
    const size = 0x300 << (this.lc + this.lp);
    if (this.literal.length !== size) this.literal = new Uint16Array(size);
    this.haveProperties = true;
  }

  resetState() {
    this.isMatch.fill(1024);
    this.isRep.fill(1024);
    this.isRepG0.fill(1024);
    this.isRepG1.fill(1024);
    this.isRepG2.fill(1024);
    this.isRep0Long.fill(1024);
    this.posSlot.fill(1024);
    this.specPos.fill(1024);
    this.align.fill(1024);
    this.lengths.reset();
    this.repLengths.reset();
    this.literal.fill(1024);
    this.state = 0;
    this.reps = [0, 0, 0, 0];
  }

  /** Copy `length` stored bytes into the dictionary. */
  putStored(bytes, start, length, emit) {
    for (let i = 0; i < length; i++) {
      this.dict[this.pos++] = bytes[start + i];
      this.pending++;
      if (this.pos === this.dictSize) this.wrap(emit);
    }
    this.full = Math.min(this.dictSize, this.full + length);
  }

  /** The dictionary filled to its end: hand on what it holds, start again at 0. */
  wrap(emit) {
    this.flush(emit);
    this.pos = 0;
  }

  /** Hand on the bytes written since the last flush. */
  flush(emit) {
    if (this.pending === 0) return;
    emit(this.dict.slice(this.pos - this.pending, this.pos));
    this.pending = 0;
  }

  /**
   * Decode one LZMA chunk of `outSize` bytes from `input[start, start +
   * inSize)`.
   */
  decodeChunk(input, start, inSize, outSize, emit) {
    const end = start + inSize;
    let p = start;
    if (input[p++] !== 0) throw damaged('a range coder does not start with 0');
    let range = 0xffffffff;
    let code = 0;
    for (let i = 0; i < 4; i++) code = ((code << 8) | input[p++]) >>> 0;
    const dict = this.dict;
    const dictSize = this.dictSize;
    const { isMatch, isRep, isRepG0, isRepG1, isRepG2, isRep0Long, posSlot, specPos, align, literal } = this;
    const lc = this.lc;
    const lpMask = (1 << this.lp) - 1;
    const pbMask = (1 << this.pb) - 1;
    let state = this.state;
    let [rep0, rep1, rep2, rep3] = this.reps;
    let pos = this.pos;
    let full = this.full;
    let pending = this.pending;
    let total = this.total;
    let left = outSize;

    const bit = (probs, index) => {
      if (range < 0x1000000) {
        if (p >= end) throw damaged('an LZMA chunk ends early');
        range = (range << 8) >>> 0;
        code = ((code << 8) | input[p++]) >>> 0;
      }
      const prob = probs[index];
      const bound = (range >>> 11) * prob;
      if (code < bound) {
        range = bound;
        probs[index] = prob + ((2048 - prob) >>> 5);
        return 0;
      }
      range = (range - bound) >>> 0;
      code = (code - bound) >>> 0;
      probs[index] = prob - (prob >>> 5);
      return 1;
    };
    const tree = (probs, offset, bits) => {
      let m = 1;
      for (let i = 0; i < bits; i++) m = (m << 1) | bit(probs, offset + m);
      return m - (1 << bits);
    };
    const reverseTree = (probs, offset, bits) => {
      let m = 1;
      let symbol = 0;
      for (let i = 0; i < bits; i++) {
        const b = bit(probs, offset + m);
        m = (m << 1) | b;
        symbol |= b << i;
      }
      return symbol;
    };
    const direct = bits => {
      let result = 0;
      for (let i = 0; i < bits; i++) {
        if (range < 0x1000000) {
          if (p >= end) throw damaged('an LZMA chunk ends early');
          range = (range << 8) >>> 0;
          code = ((code << 8) | input[p++]) >>> 0;
        }
        range >>>= 1;
        if (code >= range) {
          code = (code - range) >>> 0;
          result = result * 2 + 1;
        } else {
          result *= 2;
        }
      }
      return result;
    };
    const length = (model, posState) => {
      if (bit(model.choice, 0) === 0) return tree(model.low, posState << 3, 3);
      if (bit(model.choice, 1) === 0) return 8 + tree(model.mid, posState << 3, 3);
      return 16 + tree(model.high, 0, 8);
    };
    const byteAt = distance => {
      let index = pos - distance - 1;
      if (index < 0) index += dictSize;
      return dict[index];
    };
    const put = value => {
      dict[pos++] = value;
      pending++;
      if (pos === dictSize) {
        emit(dict.slice(pos - pending, pos));
        pending = 0;
        pos = 0;
      }
      if (full < dictSize) full++;
    };

    while (left > 0) {
      const posState = total & pbMask;
      if (bit(isMatch, (state << 4) | posState) === 0) {
        const previous = full > 0 ? byteAt(0) : 0;
        const base = 0x300 * ((((total & lpMask) << lc) + (previous >>> (8 - lc))));
        let symbol = 1;
        if (state < LITERAL_STATES) {
          do symbol = (symbol << 1) | bit(literal, base + symbol); while (symbol < 0x100);
        } else {
          let matchByte = byteAt(rep0);
          do {
            const matchBit = (matchByte >>> 7) & 1;
            matchByte <<= 1;
            const b = bit(literal, base + ((1 + matchBit) << 8) + symbol);
            symbol = (symbol << 1) | b;
            if (matchBit !== b) {
              while (symbol < 0x100) symbol = (symbol << 1) | bit(literal, base + symbol);
              break;
            }
          } while (symbol < 0x100);
        }
        put(symbol & 0xff);
        total++;
        left--;
        state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
        continue;
      }
      let len;
      if (bit(isRep, state) === 0) {
        rep3 = rep2;
        rep2 = rep1;
        rep1 = rep0;
        len = length(this.lengths, posState);
        state = state < LITERAL_STATES ? 7 : 10;
        const lenState = len < 4 ? len : 3;
        const slot = tree(posSlot, lenState << 6, 6);
        if (slot < 4) {
          rep0 = slot;
        } else {
          const bits = (slot >>> 1) - 1;
          let distance = (2 | (slot & 1)) * 2 ** bits;
          if (slot < END_POS_MODEL_INDEX) {
            distance += reverseTree(specPos, distance - slot - 1, bits);
          } else {
            distance += direct(bits - ALIGN_BITS) * (1 << ALIGN_BITS);
            distance += reverseTree(align, 0, ALIGN_BITS);
          }
          rep0 = distance;
        }
        if (rep0 === 0xffffffff) throw damaged('an LZMA chunk holds an end marker');
      } else {
        if (bit(isRepG0, state) === 0) {
          if (bit(isRep0Long, (state << 4) | posState) === 0) {
            if (full === 0) throw damaged('a repeated byte refers before the start');
            state = state < LITERAL_STATES ? 9 : 11;
            put(byteAt(rep0));
            total++;
            left--;
            continue;
          }
        } else {
          let distance;
          if (bit(isRepG1, state) === 0) {
            distance = rep1;
          } else {
            if (bit(isRepG2, state) === 0) {
              distance = rep2;
            } else {
              distance = rep3;
              rep3 = rep2;
            }
            rep2 = rep1;
          }
          rep1 = rep0;
          rep0 = distance;
        }
        len = length(this.repLengths, posState);
        state = state < LITERAL_STATES ? 8 : 11;
      }
      len += MATCH_MIN;
      if (rep0 >= full) throw damaged('a match refers before the start of the dictionary');
      if (len > left) throw damaged('a match runs past its chunk');
      // The match, copied straight within the dictionary.
      let from = pos - rep0 - 1;
      if (from < 0) from += dictSize;
      for (let i = 0; i < len; i++) {
        dict[pos++] = dict[from++];
        if (from === dictSize) from = 0;
        if (pos === dictSize) {
          emit(dict.slice(pos - pending - i - 1, pos));
          pending = -i - 1;
          pos = 0;
        }
      }
      pending += len;
      full = Math.min(dictSize, full + len);
      total += len;
      left -= len;
    }
    this.state = state;
    this.reps = [rep0, rep1, rep2, rep3];
    this.pos = pos;
    this.full = full;
    this.pending = pending;
    this.total = total;
    this.flush(emit);
    return p;
  }
}

const CHECK_SIZES = [0, 4, 4, 4, 8, 8, 8, 16, 16, 16, 32, 32, 32, 64, 64, 64];

/** One block's LZMA2 data, handed on as it decodes. */
async function* decodeLzma2(input, lzma, signal) {
  const out = [];
  const emit = bytes => out.push(bytes);
  for (;;) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('The read was aborted.', 'AbortError');
    await input.ensure(1);
    const control = input.byte();
    if (control === 0x00) return;
    if (control === 0x01 || control === 0x02) {
      await input.ensure(2);
      const size = ((input.byte() << 8) | input.byte()) + 1;
      if (control === 0x01) lzma.resetDictionary();
      await input.ensure(size);
      lzma.putStored(input.bytes, input.pos, size, emit);
      lzma.total += size;
      input.pos += size;
      lzma.flush(emit);
    } else if (control >= 0x80) {
      await input.ensure(4);
      const outSize = ((control & 0x1f) << 16) + ((input.byte() << 8) | input.byte()) + 1;
      const inSize = ((input.byte() << 8) | input.byte()) + 1;
      const reset = (control >>> 5) & 3;
      if (reset >= 2) {
        await input.ensure(1);
        lzma.setProperties(input.byte());
      }
      if (reset === 3) lzma.resetDictionary();
      if (!lzma.haveProperties) throw damaged('an LZMA chunk comes before its properties');
      if (reset >= 1) lzma.resetState();
      await input.ensure(inSize);
      const used = lzma.decodeChunk(input.bytes, input.pos, inSize, outSize, emit);
      if (used > input.pos + inSize) throw damaged('an LZMA chunk is longer than it says');
      input.pos += inSize;
    } else {
      throw damaged(`an LZMA2 chunk has the control byte ${control}`);
    }
    while (out.length > 0) yield out.shift();
  }
}

/** The dictionary size an LZMA2 properties byte states. */
function dictionarySizeOf(byte) {
  if (byte > 40) throw damaged('the LZMA2 dictionary size is out of range');
  if (byte === 40) return 0xffffffff;
  return (2 | (byte & 1)) * 2 ** (Math.floor(byte / 2) + 11);
}

/**
 * Decompress xz pieces as they arrive.
 *
 * @param {AsyncIterable<Uint8Array>} pieces
 * @param {{signal?: AbortSignal|null}} [options]
 * @returns {AsyncGenerator<Uint8Array>}
 */
export async function* unxz(pieces, { signal = null } = {}) {
  const input = new Input(pieces[Symbol.asyncIterator]());
  let streams = 0;
  for (;;) {
    // Stream padding (zero words) may follow a stream.
    if (streams > 0) {
      try {
        await input.ensure(1);
      } catch {
        return;
      }
      while (input.buffered > 0 && input.bytes[input.pos] === 0) {
        await input.ensure(4);
        input.pos += 4;
        if (input.buffered === 0) {
          try {
            await input.ensure(1);
          } catch {
            return;
          }
        }
      }
    }
    await input.ensure(12);
    const header = input.pos;
    const magic = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];
    for (let i = 0; i < 6; i++) if (input.bytes[header + i] !== magic[i]) throw damaged(streams === 0 ? 'it does not start with the xz signature' : 'data follows its end');
    const check = input.bytes[header + 7] & 0x0f;
    const storedHeaderCrc = new DataView(input.bytes.buffer, input.bytes.byteOffset + header + 8, 4).getUint32(0, true);
    if (crc32(input.bytes.subarray(header + 6, header + 8)) !== storedHeaderCrc) throw damaged('its stream header does not match its checksum');
    input.pos += 12;
    streams++;
    for (;;) {
      await input.ensure(1);
      const sizeByte = input.bytes[input.pos];
      if (sizeByte === 0) break;
      const headerSize = (sizeByte + 1) * 4;
      await input.ensure(headerSize);
      const headerAt = input.pos;
      const blockStart = input.position;
      const storedCrc = new DataView(input.bytes.buffer, input.bytes.byteOffset + headerAt + headerSize - 4, 4).getUint32(0, true);
      if (crc32(input.bytes.subarray(headerAt, headerAt + headerSize - 4)) !== storedCrc) throw damaged('a block header does not match its checksum');
      input.pos += 1;
      const flags = input.byte();
      const filters = (flags & 3) + 1;
      let uncompressedSize = null;
      if (flags & 0x40) input.varint();
      if (flags & 0x80) uncompressedSize = input.varint();
      let lzma2Properties = null;
      for (let f = 0; f < filters; f++) {
        const id = input.varint();
        const size = input.varint();
        if (id !== 0x21 || f !== filters - 1) {
          throw new RdsUnsupportedError('xz filter', `This xz file uses the filter ${id} besides LZMA2, which Cellucid does not read. Compress it again with xz defaults, or with gzip.`);
        }
        if (size !== 1) throw damaged('the LZMA2 filter properties are not one byte');
        lzma2Properties = input.byte();
      }
      input.pos = headerAt + headerSize;
      let dictionarySize = dictionarySizeOf(lzma2Properties);
      if (uncompressedSize !== null) dictionarySize = Math.max(4096, Math.min(dictionarySize, uncompressedSize));
      const lzma = new Lzma(dictionarySize);
      let produced = 0;
      let crc = check === 1 ? 0 : null;
      for await (const piece of decodeLzma2(input, lzma, signal)) {
        produced += piece.length;
        if (crc !== null) {
          crc = crc32(piece, crc);
        }
        yield piece;
      }
      if (uncompressedSize !== null && produced !== uncompressedSize) throw damaged('a block does not decode to the size its header states');
      // Block padding to four bytes, then the check.
      while ((input.position - blockStart) % 4 !== 0) {
        await input.ensure(1);
        if (input.byte() !== 0) throw damaged('block padding is not zero');
      }
      const checkSize = CHECK_SIZES[check];
      await input.ensure(checkSize);
      if (check === 1) {
        const stored = new DataView(input.bytes.buffer, input.bytes.byteOffset + input.pos, 4).getUint32(0, true);
        if (crc !== stored) throw damaged('a block does not match its CRC32');
      }
      input.pos += checkSize;
    }
    // The index: records, padding, CRC32; then the stream footer.
    const indexStart = input.position;
    input.pos += 1;
    const records = await input.varintAsync();
    for (let i = 0; i < records; i++) {
      await input.varintAsync();
      await input.varintAsync();
    }
    while ((input.position - indexStart) % 4 !== 0) {
      await input.ensure(1);
      input.pos += 1;
    }
    await input.ensure(4 + 12);
    input.pos += 4;
    if (input.bytes[input.pos + 10] !== 0x59 || input.bytes[input.pos + 11] !== 0x5a) throw damaged('its stream footer is missing');
    input.pos += 12;
  }
}
