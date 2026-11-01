/**
 * Random access into one DEFLATE stream (the body of a gzip member) that has
 * no index: GEO's `.mtx.gz` and `.csv.gz` are each one member of several
 * gigabytes, which a range request can reach anywhere but no inflater can
 * start in the middle of.
 *
 * Three things make a start in the middle possible (the technique of
 * rapidgzip, Knespel & Brunst 2023):
 *
 * 1. **A block start is found by trial** (`findBlockStart`): DEFLATE blocks
 *    are not byte aligned and carry no marker, but a dynamic-Huffman block's
 *    header is a strong code: its code-length code and both its codes must
 *    be complete prefix codes, its end-of-block code present, and the block
 *    must then decode to its end and be followed by another block's header.
 *    A random bit offset passes all of that about never; the caller's
 *    `accept` (the bytes a text format may hold) makes it never in practice.
 * 2. **The 32 KiB window before it is unknown**: a match that copies from
 *    before the start copies unknown bytes, kept as markers (a decoder in
 *    `marked` mode works on 16-bit symbols: 0–255 a byte, `MARKER` unknown).
 *    A marker spreads only by being copied again, and every byte a literal
 *    writes is exact, so once the last 32 KiB written hold no marker
 *    (`clean`), no later byte can be unknown: from there on the output is the
 *    file's own, and the decoder continues on bytes (`exactFrom`).
 *    Every byte that is not a marker is exact before that too; a reader of
 *    self-describing records (a MatrixMarket line names its cell and gene)
 *    can use what lies after the last marker.
 * 3. **An access point** (zlib's zran) is a block start's bit offset with
 *    the 32 KiB of output before it: decoding resumes there exactly, with no
 *    warm-up (`DeflateDecoder` given a `window`). A clean decode collects
 *    them as it passes block starts (`onBlock`).
 *
 * Only random access goes through this decoder: a stream read from its
 * start is decompressed by the browser's native `DecompressionStream`
 * (`formats/rds/stream.js`), several times faster than any JavaScript
 * inflater. A seek decodes the span asked for (a few hundred kilobytes to a
 * few megabytes), where a JavaScript inflater's rate (about 100–200 MB/s)
 * is far above the network's.
 *
 * Huffman codes are decoded with one table per code of `2^maxLength`
 * entries indexed by the next bits as they arrive (least significant first),
 * each entry `symbol << 4 | length`, built once per block.
 *
 * Status: no reader imports this module. It is the measurement behind the
 * decision not to seek inside gzip members (`data/anndata/transcode/
 * matrix-market.js` reads such files as one stream, and says why), kept
 * with its test (`tests/text-matrix-stream-contract.test.mjs`); whether it
 * stays in the shipped tree is an open decision.
 *
 * @module formats/io/deflate-seek
 */

/** The window of DEFLATE: the farthest a match reaches back. */
const DEFLATE_WINDOW_BYTES = 32768;

/** In a marked decoder's output: a byte from before the start, unknown. */
export const MARKER = 256;

/** A DEFLATE stream that is not one (or not one from this bit offset). */
class DeflateSeekError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DeflateSeekError';
  }
}

const LENGTH_BASE = new Uint16Array([3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]);
const LENGTH_EXTRA = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]);
const DISTANCE_BASE = new Uint16Array([1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]);
const DISTANCE_EXTRA = new Uint8Array([0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]);
const CODE_LENGTH_ORDER = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);

/** Bits reversed, for codes read least significant bit first. */
const REVERSED = new Uint16Array(32768);
for (let i = 0; i < 32768; i++) {
  let x = i;
  x = ((x & 0xaaaa) >>> 1) | ((x & 0x5555) << 1);
  x = ((x & 0xcccc) >>> 2) | ((x & 0x3333) << 2);
  x = ((x & 0xf0f0) >>> 4) | ((x & 0x0f0f) << 4);
  REVERSED[i] = (((x & 0xff00) >>> 8) | ((x & 0x00ff) << 8)) >>> 1;
}

/**
 * A Huffman decoding table from code lengths, or null when the lengths are
 * no prefix code DEFLATE allows: over-subscribed, or incomplete unless
 * `incompleteSingle` and one code of length 1 (zlib's rule for the
 * literal/length and distance codes; the code-length code must be
 * complete). A code with no lengths at all is allowed as `incompleteSingle`
 * (a block without matches has no distance code); its table decodes nothing.
 *
 * @returns {{table: Uint16Array, bits: number}|null}
 */
function huffmanTable(lengths, start, count, incompleteSingle) {
  const perLength = new Uint16Array(16);
  let max = 0;
  for (let i = 0; i < count; i++) {
    const length = lengths[start + i];
    perLength[length]++;
    if (length > max) max = length;
  }
  if (max === 0) return incompleteSingle ? { table: new Uint16Array(2), bits: 1 } : null;
  let left = 1;
  for (let length = 1; length <= 15; length++) {
    left = (left << 1) - perLength[length];
    if (left < 0) return null;
  }
  if (left > 0 && !(incompleteSingle && max === 1)) return null;
  // Canonical codes: each length's first code follows the shorter ones'.
  const next = new Uint16Array(16);
  for (let length = 2; length <= 15; length++) next[length] = (next[length - 1] + perLength[length - 1]) << 1;
  const table = new Uint16Array(1 << max);
  for (let i = 0; i < count; i++) {
    const length = lengths[start + i];
    if (length === 0) continue;
    const code = next[length]++;
    const entry = (i << 4) | length;
    const reversed = REVERSED[code << (15 - length)];
    for (let index = reversed; index < table.length; index += 1 << length) table[index] = entry;
  }
  return { table, bits: max };
}

const FIXED_LENGTHS = (() => {
  const lengths = new Uint8Array(320);
  lengths.fill(8, 0, 144);
  lengths.fill(9, 144, 256);
  lengths.fill(7, 256, 280);
  lengths.fill(8, 280, 288);
  lengths.fill(5, 288, 320);
  return lengths;
})();
const FIXED_LITERALS = huffmanTable(FIXED_LENGTHS, 0, 288, false);
const FIXED_DISTANCES = huffmanTable(FIXED_LENGTHS, 288, 30, false);

/** Output a decoder holds beyond its window: what one `decode` call may make. */
const DECODE_BYTES = 1 << 20;

/** `count` bits at bit `p` of `bytes` (count ≤ 24; bytes past the end read as zero). */
function bitsAt(bytes, p, count) {
  const byte = p >>> 3;
  return ((bytes[byte] | (bytes[byte + 1] << 8) | (bytes[byte + 2] << 16) | (bytes[byte + 3] << 24)) >>> (p & 7)) & ((1 << count) - 1);
}

/**
 * A dynamic block's header at bit `p`: its two tables and the bit after the
 * header, or null when it is no valid header (or runs past `end` bits).
 */
function dynamicHeader(bytes, p, end) {
  if (p + 17 > end) return null;
  const literals = bitsAt(bytes, p, 5) + 257;
  const distances = bitsAt(bytes, p + 5, 5) + 1;
  const codeLengths = bitsAt(bytes, p + 10, 4) + 4;
  if (literals > 286 || distances > 30) return null;
  p += 14;
  if (p + codeLengths * 3 > end) return null;
  const clLengths = new Uint8Array(19);
  for (let i = 0; i < codeLengths; i++, p += 3) clLengths[CODE_LENGTH_ORDER[i]] = bitsAt(bytes, p, 3);
  const cl = huffmanTable(clLengths, 0, 19, false);
  if (cl === null) return null;
  const lengths = new Uint8Array(literals + distances);
  const clMask = (1 << cl.bits) - 1;
  for (let i = 0; i < lengths.length;) {
    if (p + 16 > end) return null;
    const entry = cl.table[bitsAt(bytes, p, cl.bits) & clMask];
    const length = entry & 15;
    if (length === 0) return null;
    p += length;
    const symbol = entry >>> 4;
    if (symbol < 16) {
      lengths[i++] = symbol;
    } else if (symbol === 16) {
      if (i === 0) return null;
      const repeat = 3 + bitsAt(bytes, p, 2);
      p += 2;
      if (i + repeat > lengths.length) return null;
      lengths.fill(lengths[i - 1], i, i + repeat);
      i += repeat;
    } else {
      const repeat = symbol === 17 ? 3 + bitsAt(bytes, p, 3) : 11 + bitsAt(bytes, p, 7);
      p += symbol === 17 ? 3 : 7;
      if (i + repeat > lengths.length) return null;
      i += repeat;
    }
  }
  if (lengths[256] === 0) return null;
  const literalTable = huffmanTable(lengths, 0, literals, true);
  if (literalTable === null) return null;
  const distanceTable = huffmanTable(lengths, literals, distances, true);
  if (distanceTable === null) return null;
  return { literals: literalTable, distances: distanceTable, bit: p };
}

/**
 * One DEFLATE stream decoded from a bit offset of its compressed bytes.
 *
 * The compressed bytes arrive in pieces (`push`, the first at
 * `inputStart`, the stream's byte offset of the first pushed byte); the
 * decoder starts at absolute bit `bit` (the start of a block) with the 32 KiB
 * of output before it (`window`), or without it (`marked`: what lies before
 * is unknown, `MARKER`). `decode(limit)` decodes until about `limit` bytes
 * were output since the last call, the input runs short (`needInput`), or
 * the stream ends (`done`); its output is valid until the next call.
 */
export class DeflateDecoder {
  /**
   * @param {{bit: number, inputStart?: number, window?: Uint8Array|null, marked?: boolean,
   *   onBlock?: ((bit: number, produced: number, decoder: DeflateDecoder) => void)|null}} options
   *   `onBlock(bit, produced)`: told at every block start reached after the
   *   first (its absolute bit offset, and the bytes output before it), where
   *   `windowNow()` is the access point's window.
   */
  constructor({ bit, inputStart = Math.floor(bit / 8), window = null, marked = window === null, onBlock = null }) {
    if (marked && window !== null) throw new TypeError('A marked decoder has no window.');
    if (!marked && window === null) throw new TypeError('A decoder of known bytes starts from a window (empty at the stream start).');
    this._input = new Uint8Array(0);
    this._inputStart = inputStart;
    this._p = bit - inputStart * 8;
    if (this._p < 0) throw new RangeError('The start bit lies before the first byte pushed.');
    this._final = false;
    this._ended = false;
    this._marked = marked;
    this._onBlock = onBlock;
    // The output: the last 32 KiB first, then what this call decodes.
    const capacity = DEFLATE_WINDOW_BYTES + DECODE_BYTES + 512;
    this._out = marked ? new Uint16Array(capacity) : new Uint8Array(capacity);
    if (marked) {
      this._out.fill(MARKER, 0, DEFLATE_WINDOW_BYTES);
      this._at = DEFLATE_WINDOW_BYTES;
      this._lastMarker = DEFLATE_WINDOW_BYTES - 1;
    } else {
      const w = window.subarray(Math.max(0, window.length - DEFLATE_WINDOW_BYTES));
      this._out.set(w, 0);
      this._at = w.length;
      this._lastMarker = -1;
    }
    // The output offset of `_out[0]` (output offsets count from the start bit).
    this._base = -this._at;
    this._exactFrom = marked ? null : 0;
    this._inputLength = 0;
    this._block = null;
    this._blocks = 0;
    this._bytesOut = null;
  }

  /** The absolute bit offset decoding has reached. */
  get bit() {
    return this._inputStart * 8 + this._p;
  }

  /** Whether the output from here on is exact: no marker in the last 32 KiB. */
  get clean() {
    return this._exactFrom !== null;
  }

  /** Output bytes from the start; every one from `exactFrom` on is the file's own. */
  get exactFrom() {
    return this._exactFrom;
  }

  /** Bytes output since the start. */
  get produced() {
    return this._base + this._at;
  }

  /** Whether the last block ended (the stream is over). */
  get done() {
    return this._ended;
  }

  /** Blocks begun. */
  get blocks() {
    return this._blocks;
  }

  /** The last 32 KiB output (an access point's window); only when clean. */
  windowNow() {
    if (!this.clean) throw new DeflateSeekError('The window holds bytes from before the start.');
    const from = Math.max(0, this._at - DEFLATE_WINDOW_BYTES);
    const window = new Uint8Array(this._at - from);
    for (let i = from, j = 0; i < this._at; i++, j++) window[j] = this._out[i];
    return window;
  }

  /** More compressed bytes, following those pushed. */
  push(bytes) {
    const keep = Math.min(this._p >>> 3, this._inputLength);
    const rest = this._inputLength - keep;
    const input = new Uint8Array(rest + bytes.length + 4);
    input.set(this._input.subarray(keep), 0);
    input.set(bytes, rest);
    this._input = input;
    this._inputLength = rest + bytes.length;
    this._inputStart += keep;
    this._p -= keep * 8;
  }

  /** No more compressed bytes: the stream's end lies in what was pushed. */
  end() {
    this._final = true;
  }

  /**
   * Decode until about `limit` bytes are output, the input runs short or the
   * stream ends.
   *
   * @param {number} [limit]
   * @returns {{output: Uint8Array|Uint16Array, needInput: boolean, done: boolean}}
   *   `output`: the bytes decoded by this call (16-bit symbols while marked)
   */
  decode(limit = DECODE_BYTES) {
    if (this._marked && this._exactFrom !== null) this._becomeExact();
    this._slide();
    const begin = this._at;
    const goal = this._at + Math.max(1, Math.min(limit, this._out.length - this._at - 512));
    let needInput = false;
    const inputBits = this._inputLength * 8;
    // A symbol takes at most 48 bits; a dynamic header at most ~300 bytes.
    const margin = this._final ? 0 : 64;
    while (!this._ended && this._at < goal) {
      if (this._block === null) {
        if (!this._final && this._p + 8 * 1024 > inputBits) {
          needInput = true;
          break;
        }
        this._startBlock(inputBits);
        continue;
      }
      if (this._block.stored !== undefined) {
        const available = (inputBits >>> 3) - (this._p >>> 3);
        const take = Math.min(this._block.stored, goal - this._at, available);
        if (take === 0) {
          if (this._final) throw new DeflateSeekError('The stream ends inside a stored block.');
          needInput = true;
          break;
        }
        const from = this._p >>> 3;
        for (let i = 0; i < take; i++) this._out[this._at++] = this._input[from + i];
        this._p += take * 8;
        this._block.stored -= take;
        if (this._block.stored === 0) this._endBlock();
        continue;
      }
      const stop = this._marked
        ? this._decodeMarked(goal, inputBits - margin * 8)
        : this._decodeBytes(goal, inputBits - margin * 8);
      if (stop === 'input') {
        if (this._final) {
          if (this._p > inputBits) throw new DeflateSeekError('The stream ends inside a block.');
          // The last symbols lie within the margin: decoded without it.
          const last = this._marked ? this._decodeMarked(goal, inputBits) : this._decodeBytes(goal, inputBits);
          if (last === 'input') throw new DeflateSeekError('The stream ends inside a block.');
          continue;
        }
        needInput = true;
        break;
      }
    }
    const output = this._out.subarray(begin, this._at);
    return { output, needInput, done: this._ended };
  }

  /** Keep the last 32 KiB at the front of the output buffer. @private */
  _slide() {
    if (this._at <= DEFLATE_WINDOW_BYTES) return;
    const from = this._at - DEFLATE_WINDOW_BYTES;
    this._out.copyWithin(0, from, this._at);
    this._base += from;
    this._lastMarker -= from;
    this._at = DEFLATE_WINDOW_BYTES;
  }

  /** Read a block header at the current bit. @private */
  _startBlock(inputBits) {
    if (this._blocks > 0) this._onBlock?.(this.bit, this.produced, this);
    this._blocks++;
    const p = this._p;
    if (p + 3 > inputBits) throw new DeflateSeekError('The stream ends before a block.');
    const head = bitsAt(this._input, p, 3);
    const final = (head & 1) === 1;
    const type = head >>> 1;
    if (type === 0) {
      const byte = (p + 3 + 7) >>> 3;
      if (byte * 8 + 32 > inputBits) throw new DeflateSeekError('The stream ends inside a stored block header.');
      const length = this._input[byte] | (this._input[byte + 1] << 8);
      const check = this._input[byte + 2] | (this._input[byte + 3] << 8);
      if ((length ^ 0xffff) !== check) throw new DeflateSeekError('A stored block\'s length is damaged.');
      this._p = (byte + 4) * 8;
      this._block = { final, stored: length };
      if (length === 0) this._endBlock();
      return;
    }
    if (type === 1) {
      this._p = p + 3;
      this._block = { final, literals: FIXED_LITERALS, distances: FIXED_DISTANCES };
      return;
    }
    if (type === 3) throw new DeflateSeekError('A block of reserved type: the stream is damaged.');
    const header = dynamicHeader(this._input, p + 3, inputBits);
    if (header === null) throw new DeflateSeekError('A dynamic block header is damaged.');
    this._p = header.bit;
    this._block = { final, literals: header.literals, distances: header.distances };
  }

  /** @private */
  _endBlock() {
    if (this._block.final) this._ended = true;
    this._block = null;
    // No marker in the last 32 KiB: none can come again. The output becomes
    // bytes at the next call (this call's output keeps its markers).
    if (this._marked && this._exactFrom === null && this._at - this._lastMarker > DEFLATE_WINDOW_BYTES) {
      this._exactFrom = this._base + this._lastMarker + 1;
    }
  }

  /** Clean since the last call: decode bytes from here on. @private */
  _becomeExact() {
    const bytes = new Uint8Array(this._out.length);
    for (let i = 0; i < this._at; i++) bytes[i] = this._out[i];
    this._out = bytes;
    this._marked = false;
  }

  /** Decode symbols of the current block onto bytes. @private */
  _decodeBytes(goal, inputBits) {
    const input = this._input;
    const out = this._out;
    const { literals, distances } = this._block;
    const lt = literals.table;
    const lb = literals.bits;
    const lm = (1 << lb) - 1;
    const dt = distances.table;
    const db = distances.bits;
    const dm = (1 << db) - 1;
    let p = this._p;
    let at = this._at;
    while (at < goal) {
      if (p > inputBits) {
        this._p = p;
        this._at = at;
        return 'input';
      }
      let byte = p >>> 3;
      let entry = lt[((input[byte] | (input[byte + 1] << 8) | (input[byte + 2] << 16)) >>> (p & 7)) & lm];
      const length = entry & 15;
      if (length === 0) throw new DeflateSeekError('An invalid literal/length code.');
      p += length;
      const symbol = entry >>> 4;
      if (symbol < 256) {
        out[at++] = symbol;
        continue;
      }
      if (symbol === 256) {
        this._p = p;
        this._at = at;
        this._endBlock();
        return 'block';
      }
      const index = symbol - 257;
      if (index > 28) throw new DeflateSeekError('An invalid length symbol.');
      let count = LENGTH_BASE[index];
      const extra = LENGTH_EXTRA[index];
      if (extra > 0) {
        byte = p >>> 3;
        count += ((input[byte] | (input[byte + 1] << 8)) >>> (p & 7)) & ((1 << extra) - 1);
        p += extra;
      }
      byte = p >>> 3;
      entry = dt[((input[byte] | (input[byte + 1] << 8) | (input[byte + 2] << 16)) >>> (p & 7)) & dm];
      const dLength = entry & 15;
      if (dLength === 0) throw new DeflateSeekError('An invalid distance code.');
      p += dLength;
      const dSymbol = entry >>> 4;
      if (dSymbol > 29) throw new DeflateSeekError('An invalid distance symbol.');
      let distance = DISTANCE_BASE[dSymbol];
      const dExtra = DISTANCE_EXTRA[dSymbol];
      if (dExtra > 0) {
        byte = p >>> 3;
        distance += ((input[byte] | (input[byte + 1] << 8) | (input[byte + 2] << 16)) >>> (p & 7)) & ((1 << dExtra) - 1);
        p += dExtra;
      }
      if (distance > at) throw new DeflateSeekError('A match reaches before the stream.');
      let from = at - distance;
      const stop = at + count;
      while (at < stop) out[at++] = out[from++];
    }
    this._p = p;
    this._at = at;
    return 'goal';
  }

  /** Decode symbols of the current block onto 16-bit symbols, markers copied as such. @private */
  _decodeMarked(goal, inputBits) {
    const input = this._input;
    const out = this._out;
    const { literals, distances } = this._block;
    const lt = literals.table;
    const lm = (1 << literals.bits) - 1;
    const dt = distances.table;
    const dm = (1 << distances.bits) - 1;
    let p = this._p;
    let at = this._at;
    let lastMarker = this._lastMarker;
    while (at < goal) {
      if (p > inputBits) {
        this._p = p;
        this._at = at;
        this._lastMarker = lastMarker;
        return 'input';
      }
      let byte = p >>> 3;
      let entry = lt[((input[byte] | (input[byte + 1] << 8) | (input[byte + 2] << 16)) >>> (p & 7)) & lm];
      const length = entry & 15;
      if (length === 0) throw new DeflateSeekError('An invalid literal/length code.');
      p += length;
      const symbol = entry >>> 4;
      if (symbol < 256) {
        out[at++] = symbol;
        continue;
      }
      if (symbol === 256) {
        this._p = p;
        this._at = at;
        this._lastMarker = lastMarker;
        this._endBlock();
        return 'block';
      }
      const index = symbol - 257;
      if (index > 28) throw new DeflateSeekError('An invalid length symbol.');
      let count = LENGTH_BASE[index];
      const extra = LENGTH_EXTRA[index];
      if (extra > 0) {
        byte = p >>> 3;
        count += ((input[byte] | (input[byte + 1] << 8)) >>> (p & 7)) & ((1 << extra) - 1);
        p += extra;
      }
      byte = p >>> 3;
      entry = dt[((input[byte] | (input[byte + 1] << 8) | (input[byte + 2] << 16)) >>> (p & 7)) & dm];
      const dLength = entry & 15;
      if (dLength === 0) throw new DeflateSeekError('An invalid distance code.');
      p += dLength;
      const dSymbol = entry >>> 4;
      if (dSymbol > 29) throw new DeflateSeekError('An invalid distance symbol.');
      let distance = DISTANCE_BASE[dSymbol];
      const dExtra = DISTANCE_EXTRA[dSymbol];
      if (dExtra > 0) {
        byte = p >>> 3;
        distance += ((input[byte] | (input[byte + 1] << 8) | (input[byte + 2] << 16)) >>> (p & 7)) & ((1 << dExtra) - 1);
        p += dExtra;
      }
      if (distance > at) throw new DeflateSeekError('A match reaches before the window.');
      let from = at - distance;
      const stop = at + count;
      while (at < stop) {
        const value = out[from++];
        if (value === MARKER) lastMarker = at;
        out[at++] = value;
      }
    }
    this._p = p;
    this._at = at;
    this._lastMarker = lastMarker;
    return 'goal';
  }
}

/**
 * The first bit offset in `[fromBit, toBit)` of `bytes` (bit 0 its first
 * byte) where a dynamic-Huffman block starts that decodes, unmarked bytes
 * all `accept`ed, to its end and is followed by another block's header; null
 * when none does. Finding one in a few hundred kilobytes is the cost of a
 * start in the middle of a stream (DEFLATE writers end a block every few
 * tens of kilobytes).
 *
 * @param {Uint8Array} bytes
 * @param {number} fromBit
 * @param {number} toBit
 * @param {{accept?: ((byte: number) => boolean)|null}} [options]
 * @returns {number|null}
 */
export function findBlockStart(bytes, fromBit, toBit, { accept = null } = {}) {
  const end = bytes.length * 8;
  const padded = new Uint8Array(bytes.length + 4);
  padded.set(bytes);
  const allowed = accept === null ? null : Uint8Array.from({ length: 256 }, (_, byte) => (accept(byte) ? 1 : 0));
  for (let p = fromBit; p < toBit && p + 17 < end; p++) {
    // A non-final dynamic block: bits 0, 1 0 (low bit first).
    if (bitsAt(padded, p, 3) !== 4) continue;
    const header = dynamicHeader(padded, p + 3, end);
    if (header === null) continue;
    if (trialBlock(padded, p, end, allowed)) return p;
  }
  return null;
}

/** Whether the block at `bit` decodes to its end within `bytes`, its bytes allowed, a valid header after it. */
function trialBlock(bytes, bit, end, allowed) {
  const decoder = new DeflateDecoder({ bit, inputStart: 0, marked: true });
  decoder.push(bytes.subarray(0, Math.ceil(end / 8)));
  decoder.end();
  try {
    for (;;) {
      const { output } = decoder.decode(1 << 16);
      if (allowed !== null) {
        for (let i = 0; i < output.length; i++) {
          const value = output[i];
          if (value !== MARKER && allowed[value] === 0) return false;
        }
      }
      if (decoder.blocks > 1 || decoder.done) return true;
      if (output.length === 0) return false;
    }
  } catch {
    return false;
  }
}

/**
 * The length of a gzip member's header at the start of `bytes` (RFC 1952:
 * its flags' optional fields), or null when `bytes` does not start one or
 * ends inside it.
 *
 * @param {Uint8Array} bytes
 * @returns {{length: number, extra: Uint8Array|null}|null}
 */
export function gzipHeader(bytes) {
  if (bytes.length < 10 || bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8) return null;
  const flags = bytes[3];
  let at = 10;
  let extra = null;
  if (flags & 4) {
    if (at + 2 > bytes.length) return null;
    const length = bytes[at] | (bytes[at + 1] << 8);
    extra = bytes.subarray(at + 2, at + 2 + length);
    at += 2 + length;
  }
  for (const flag of [8, 16]) {
    if (flags & flag) {
      while (at < bytes.length && bytes[at] !== 0) at++;
      at++;
    }
  }
  if (flags & 2) at += 2;
  return at > bytes.length ? null : { length: at, extra };
}
