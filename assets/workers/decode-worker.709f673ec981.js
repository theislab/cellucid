// assets/js/utils/format-units.js
var BYTE_UNITS = Object.freeze(["B", "KB", "MB", "GB", "TB", "PB"]);
var GROUPED_INTEGER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0
});
function formatCount(value) {
  requireCount(value);
  return GROUPED_INTEGER.format(value);
}
function requireCount(value) {
  if (typeof value === "bigint") return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("Count must be a finite number");
  }
}
function formatCountOf(value, singular, plural = `${singular}s`) {
  return `${formatCount(value)} ${countNoun(value, singular, plural)}`;
}
function countNoun(value, singular, plural = `${singular}s`) {
  if (typeof singular !== "string" || singular.length === 0) {
    throw new TypeError("A counted noun must be non-empty text");
  }
  requireCount(value);
  return Number(value) === 1 ? singular : plural;
}

// assets/js/formats/io/inflate.js
var FORMATS = /* @__PURE__ */ new Set(["deflate", "gzip", "deflate-raw"]);
var InflateError = class extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "InflateError";
  }
};
function requireDecompressionStream(format, label) {
  if (typeof globalThis.DecompressionStream !== "function") {
    throw new InflateError(
      `${label}: this browser cannot decompress ${format} data; a current browser is required.`
    );
  }
}
var NATIVE_INFLATE_INPUT_SLICE_BYTES = 32 * 1024;
function createSlicedInputStream(parts) {
  for (const part of parts) {
    if (!(part instanceof Uint8Array)) {
      throw new TypeError("Native decompressor input must be Uint8Array parts.");
    }
  }
  let partIndex = 0;
  let partOffset = 0;
  return new ReadableStream({
    pull(controller) {
      while (partIndex < parts.length && partOffset >= parts[partIndex].byteLength) {
        partIndex += 1;
        partOffset = 0;
      }
      if (partIndex === parts.length) {
        controller.close();
        return;
      }
      const part = parts[partIndex];
      const end = Math.min(
        part.byteLength,
        partOffset + NATIVE_INFLATE_INPUT_SLICE_BYTES
      );
      controller.enqueue(part.subarray(partOffset, end));
      partOffset = end;
    }
  }, { highWaterMark: 0 });
}
function decompressed(input, format) {
  return createSlicedInputStream([input]).pipeThrough(new globalThis.DecompressionStream(format));
}
async function inflate(input, { format = "deflate", expectedSize = null, maxSize = null, label = "Compressed data" } = {}) {
  if (!(input instanceof Uint8Array)) throw new TypeError("inflate reads a Uint8Array.");
  if (!FORMATS.has(format)) throw new TypeError(`Unknown DEFLATE format '${format}'.`);
  if (expectedSize !== null && (!Number.isSafeInteger(expectedSize) || expectedSize < 0)) {
    throw new TypeError("An expected decompressed size must be a whole number of bytes.");
  }
  if (maxSize !== null && (!Number.isSafeInteger(maxSize) || maxSize < 0)) {
    throw new TypeError("A maximum decompressed size must be a whole number of bytes.");
  }
  requireDecompressionStream(format, label);
  const stream = decompressed(input, format);
  if (expectedSize === null && maxSize === null) {
    try {
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (cause) {
      throw new InflateError(`${label} could not be decompressed; the data is corrupt.`, { cause });
    }
  }
  if (expectedSize === null) {
    const reader2 = stream.getReader();
    const pieces = [];
    let total = 0;
    try {
      for (; ; ) {
        const { value, done } = await reader2.read();
        if (done) break;
        total += value.length;
        if (total > maxSize) {
          throw new InflateError(`${label} decompresses to more than the ${formatCountOf(maxSize, "byte")} it may hold.`);
        }
        pieces.push(value);
      }
    } catch (error) {
      await reader2.cancel().catch(() => {
      });
      if (error instanceof InflateError) throw error;
      throw new InflateError(`${label} could not be decompressed; the data is corrupt.`, { cause: error });
    }
    const output2 = new Uint8Array(total);
    let at = 0;
    for (const piece of pieces) {
      output2.set(piece, at);
      at += piece.length;
    }
    return output2;
  }
  const output = new Uint8Array(expectedSize);
  const reader = stream.getReader();
  let filled = 0;
  try {
    for (; ; ) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.length > expectedSize - filled) {
        throw new InflateError(`${label} decompresses to more than the ${formatCountOf(expectedSize, "byte")} it declares.`);
      }
      output.set(value, filled);
      filled += value.length;
    }
  } catch (error) {
    await reader.cancel().catch(() => {
    });
    if (error instanceof InflateError) throw error;
    throw new InflateError(`${label} could not be decompressed; the data is corrupt.`, { cause: error });
  }
  if (filled !== expectedSize) {
    throw new InflateError(`${label} decompresses to ${formatCountOf(filled, "byte")}, not the ${expectedSize} it declares.`);
  }
  return output;
}

// assets/js/formats/io/decode-pool.js
var POOL_MIN_BYTES = 32 * 1024;
var DECODE_WORKER_BYTES = 40 * 1024 * 1024;
function errorData(error) {
  if (error instanceof Error) {
    const data = { name: error.name, message: error.message };
    if (typeof error.feature === "string") data.feature = error.feature;
    if (typeof error.offset === "number" || error.offset === null) data.offset = error.offset;
    return data;
  }
  return { name: "Error", message: String(error) };
}

// assets/js/formats/io/shuffle.js
var LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
function transposeInto(words, w, step, w0, w1, w2, w3) {
  words[w] = w0 & 255 | (w1 & 255) << 8 | (w2 & 255) << 16 | w3 << 24;
  words[w + step] = w0 >>> 8 & 255 | w1 & 65280 | (w2 & 65280) << 8 | (w3 & 65280) << 16;
  words[w + 2 * step] = w0 >>> 16 & 255 | w1 >>> 8 & 65280 | w2 & 16711680 | (w3 & 16711680) << 8;
  words[w + 3 * step] = w0 >>> 24 | w1 >>> 16 & 65280 | w2 >>> 8 & 16711680 | w3 & 4278190080;
}
function byteUnshuffleInto(src, dest, at, size, typesize) {
  const count = Math.floor(size / typesize);
  let e = 0;
  if (LITTLE_ENDIAN && (typesize === 2 || typesize === 4 || typesize === 8) && (dest.byteOffset + at) % 4 === 0 && count >= 4) {
    const lanes = new DataView(src.buffer, src.byteOffset, size);
    const words = new Int32Array(dest.buffer, dest.byteOffset + at, count * typesize >>> 2);
    const quads = count - count % 4;
    if (typesize === 4) {
      for (let w = 0; e < quads; e += 4, w += 4) {
        transposeInto(
          words,
          w,
          1,
          lanes.getInt32(e, true),
          lanes.getInt32(count + e, true),
          lanes.getInt32(2 * count + e, true),
          lanes.getInt32(3 * count + e, true)
        );
      }
    } else if (typesize === 8) {
      for (let w = 0; e < quads; e += 4, w += 8) {
        transposeInto(
          words,
          w,
          2,
          lanes.getInt32(e, true),
          lanes.getInt32(count + e, true),
          lanes.getInt32(2 * count + e, true),
          lanes.getInt32(3 * count + e, true)
        );
        transposeInto(
          words,
          w + 1,
          2,
          lanes.getInt32(4 * count + e, true),
          lanes.getInt32(5 * count + e, true),
          lanes.getInt32(6 * count + e, true),
          lanes.getInt32(7 * count + e, true)
        );
      }
    } else {
      for (let w = 0; e < quads; e += 4, w += 2) {
        const low = lanes.getInt32(e, true);
        const high = lanes.getInt32(count + e, true);
        words[w] = low & 255 | (high & 255) << 8 | (low & 65280) << 8 | (high & 65280) << 16;
        words[w + 1] = low >>> 16 & 255 | high >>> 8 & 65280 | low >>> 8 & 16711680 | high & 4278190080;
      }
    }
  }
  for (let byte = 0; byte < typesize; byte++) {
    const lane = byte * count;
    for (let i = e, o = at + e * typesize + byte; i < count; i++, o += typesize) dest[o] = src[lane + i];
  }
  const done = count * typesize;
  if (done < size) dest.set(src.subarray(done, size), at + done);
}
function byteUnshuffle(input, typesize) {
  const output = new Uint8Array(input.length);
  if (typesize <= 1) output.set(input);
  else byteUnshuffleInto(input, output, 0, input.length, typesize);
  return output;
}

// assets/js/formats/zarr/errors.js
var ZarrFormatError = class extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ZarrFormatError";
  }
};
var ZarrUnsupportedError = class extends Error {
  /**
   * @param {string} feature - What is not supported, in a few words
   * @param {string} message
   */
  constructor(feature, message, options) {
    super(message, options);
    this.name = "ZarrUnsupportedError";
    this.feature = feature;
  }
};

// assets/js/formats/store.js
var INTEGER_NAMES = Object.freeze({
  int: Object.freeze({ 1: "int8", 2: "int16", 4: "int32", 8: "int64" }),
  uint: Object.freeze({ 1: "uint8", 2: "uint16", 4: "uint32", 8: "uint64" })
});
var FLOAT_NAMES = Object.freeze({ 2: "float16", 4: "float32", 8: "float64" });
var INTEGER_ARRAYS = Object.freeze({
  int: Object.freeze({ 1: Int8Array, 2: Int16Array, 4: Int32Array, 8: BigInt64Array }),
  uint: Object.freeze({ 1: Uint8Array, 2: Uint16Array, 4: Uint32Array, 8: BigUint64Array })
});
var BOOL_DTYPE = Object.freeze({ kind: "bool", name: "bool", bytes: 1, littleEndian: null });

// assets/js/formats/zarr/codecs/vlen.js
var utf8 = new TextDecoder("utf-8", { fatal: true });

// assets/js/formats/io/lz-match.js
var BLOCK_COPY_BYTES = 256;
function copyMatch(out, view, at, offset, length) {
  const stop = at + length;
  let from = at - offset;
  let o = at;
  if (length >= BLOCK_COPY_BYTES) {
    const base = from;
    while (o < stop) {
      const step = Math.min(o - base, stop - o);
      out.copyWithin(o, base, base + step);
      o += step;
    }
    return;
  }
  if (offset < 4) {
    if (length < 16) {
      while (o < stop) out[o++] = out[from++];
      return;
    }
    const period = offset === 3 ? 6 : 4;
    const head = at + period - offset;
    while (o < head) out[o++] = out[from++];
    from = o - period;
  }
  const last = stop - 4;
  while (o <= last) {
    view.setInt32(o, view.getInt32(from, true), true);
    o += 4;
    from += 4;
  }
  while (o < stop) out[o++] = out[from++];
}

// assets/js/formats/zarr/codecs/lz4.js
function corrupt(detail) {
  return new ZarrFormatError(`LZ4 data is corrupt: ${detail}.`);
}
function lz4DecodeBlockInto(input, output, outputStart = 0, outputEnd = output.length) {
  const inputEnd = input.length;
  const inputView = new DataView(input.buffer, input.byteOffset, input.length);
  const view = new DataView(output.buffer, output.byteOffset, output.length);
  let i = 0;
  let o = outputStart;
  for (; ; ) {
    if (i >= inputEnd) throw corrupt("the block ends without its final literals");
    const token = input[i++];
    let literals = token >>> 4;
    if (literals === 15) {
      let byte;
      do {
        if (i >= inputEnd) throw corrupt("a literal length is truncated");
        byte = input[i++];
        literals += byte;
      } while (byte === 255);
    }
    if (i + literals > inputEnd || o + literals > outputEnd) throw corrupt("a literal run exceeds its bounds");
    if (literals <= 16 && i + 16 <= inputEnd && o + 16 <= outputEnd) {
      view.setInt32(o, inputView.getInt32(i, true), true);
      view.setInt32(o + 4, inputView.getInt32(i + 4, true), true);
      view.setInt32(o + 8, inputView.getInt32(i + 8, true), true);
      view.setInt32(o + 12, inputView.getInt32(i + 12, true), true);
    } else if (literals > 32) {
      output.set(input.subarray(i, i + literals), o);
    } else {
      for (let k = 0; k < literals; k++) output[o + k] = input[i + k];
    }
    i += literals;
    o += literals;
    if (i === inputEnd) break;
    if (i + 2 > inputEnd) throw corrupt("a match offset is truncated");
    const offset = input[i] | input[i + 1] << 8;
    i += 2;
    if (offset === 0 || offset > o - outputStart) throw corrupt("a match offset reaches before the output");
    let length = token & 15;
    if (length === 15) {
      let byte;
      do {
        if (i >= inputEnd) throw corrupt("a match length is truncated");
        byte = input[i++];
        length += byte;
      } while (byte === 255);
    }
    length += 4;
    const stop = o + length;
    if (stop > outputEnd) throw corrupt("a match exceeds the output");
    if (offset >= 8 && length < BLOCK_COPY_BYTES && stop + 8 <= outputEnd) {
      let from = o - offset;
      do {
        view.setInt32(o, view.getInt32(from, true), true);
        view.setInt32(o + 4, view.getInt32(from + 4, true), true);
        o += 8;
        from += 8;
      } while (o < stop);
    } else {
      copyMatch(output, view, o, offset, length);
    }
    o = stop;
  }
  if (o !== outputEnd) throw corrupt(`it decodes to ${formatCountOf(o - outputStart, "byte")}, not ${outputEnd - outputStart}`);
}
function numcodecsLz4Decode(input, expectedSize) {
  if (input.length < 4) throw corrupt("the size header is truncated");
  const size = (input[0] | input[1] << 8 | input[2] << 16 | input[3] << 24) >>> 0;
  if (expectedSize !== null && size !== expectedSize) {
    throw corrupt(`it declares ${formatCountOf(size, "byte")}, not the ${expectedSize} expected`);
  }
  if (size > (input.length - 4) * 255 + 16) throw corrupt(`it declares more bytes than LZ4 can encode in ${input.length}`);
  const output = new Uint8Array(size);
  if (size > 0) lz4DecodeBlockInto(input.subarray(4), output);
  return output;
}

// assets/js/formats/zarr/codecs/zstd.js
var FRAME_MAGIC = 4247762216;
var SKIPPABLE_MASK = 4294967280;
var SKIPPABLE_MAGIC = 407710288;
var MAX_BLOCK_BYTES = 128 * 1024;
var LITERALS = new Uint8Array(MAX_BLOCK_BYTES);
function corrupt2(detail) {
  return new ZarrFormatError(`Zstandard data is corrupt: ${detail}.`);
}
function highBit(value) {
  return 31 - Math.clz32(value);
}
var LL_BASE = new Int32Array([
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  16,
  18,
  20,
  22,
  24,
  28,
  32,
  40,
  48,
  64,
  128,
  256,
  512,
  1024,
  2048,
  4096,
  8192,
  16384,
  32768,
  65536
]);
var LL_BITS = new Uint8Array([
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  1,
  1,
  1,
  2,
  2,
  3,
  3,
  4,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  16
]);
var ML_BASE = new Int32Array(53);
var ML_BITS = new Uint8Array(53);
(() => {
  for (let code = 0; code < 32; code++) ML_BASE[code] = code + 3;
  const base = [35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051, 4099, 8195, 16387, 32771, 65539];
  const bits = [1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  for (let i = 0; i < base.length; i++) {
    ML_BASE[32 + i] = base[i];
    ML_BITS[32 + i] = bits[i];
  }
})();
var LL_DEFAULT = [4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1];
var ML_DEFAULT = [1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1];
var OF_DEFAULT = [1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1];
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
      do
        position = position + step & mask;
      while (position > high);
    }
  }
  if (position !== 0) throw corrupt2("an FSE table does not fill its states");
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
var LL_PREDEFINED = buildFseTable(LL_DEFAULT, LL_DEFAULT.length, 6);
var ML_PREDEFINED = buildFseTable(ML_DEFAULT, ML_DEFAULT.length, 6);
var OF_PREDEFINED = buildFseTable(OF_DEFAULT, OF_DEFAULT.length, 5);
function peekForward(src, position, count) {
  const at = position >>> 3;
  const word = (src[at] | src[at + 1] << 8 | src[at + 2] << 16 | src[at + 3] << 24) >>> (position & 7);
  return word & (1 << count) - 1;
}
function readFseTable(src, start, end, maxSymbol, maxAccuracyLog) {
  if (start >= end) throw corrupt2("an FSE table description is missing");
  let position = start * 8;
  const accuracyLog = peekForward(src, position, 4) + 5;
  position += 4;
  if (accuracyLog > maxAccuracyLog) throw corrupt2(`an FSE table has accuracy ${accuracyLog}, above ${maxAccuracyLog}`);
  const counts = new Int16Array(maxSymbol + 1);
  let remaining = (1 << accuracyLog) + 1;
  let threshold = 1 << accuracyLog;
  let bitCount = accuracyLog + 1;
  let symbol = 0;
  let previousZero = false;
  while (remaining > 1 && symbol <= maxSymbol) {
    if (previousZero) {
      let zeros = symbol;
      for (; ; ) {
        const flag = peekForward(src, position, 2);
        position += 2;
        zeros += flag;
        if (flag !== 3) break;
      }
      if (zeros > maxSymbol) throw corrupt2("an FSE table names too many symbols");
      while (symbol < zeros) counts[symbol++] = 0;
    }
    const max = 2 * threshold - 1 - remaining;
    const value = peekForward(src, position, bitCount);
    let count;
    if ((value & threshold - 1) < max) {
      count = value & threshold - 1;
      position += bitCount - 1;
    } else {
      count = value & 2 * threshold - 1;
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
  if (remaining !== 1) throw corrupt2("an FSE table does not add up");
  const next = position + 7 >>> 3;
  if (next > end) throw corrupt2("an FSE table description runs past its block");
  return { table: buildFseTable(counts, symbol, accuracyLog), next };
}
var BackwardBits = class {
  constructor(src, start, end) {
    if (end <= start) throw corrupt2("a bit stream is empty");
    const last = src[end - 1];
    if (last === 0) throw corrupt2("a bit stream has no end marker");
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
      return this.at(0, position + count) << -position;
    }
    if (count > 24) return this.at(position, 16) + this.at(position + 16, count - 16) * 65536;
    const src = this.src;
    const index = this.start + (position >>> 3);
    const word = (src[index] | src[index + 1] << 8 | src[index + 2] << 16 | src[index + 3] << 24) >>> (position & 7);
    return word & (1 << count) - 1;
  }
};
function fseWeights(src, start, end) {
  const { table, next } = readFseTable(src, start, end, 255, 6);
  const bits = new BackwardBits(src, next, end);
  const weights = [];
  let state1 = bits.read(table.accuracyLog);
  let state2 = bits.read(table.accuracyLog);
  for (; ; ) {
    if (weights.length > 255) throw corrupt2("a Huffman table has too many weights");
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
  if (weights.length > 255) throw corrupt2("a Huffman table has too many weights");
  return weights;
}
function readHuffmanTable(src, start, end) {
  if (start >= end) throw corrupt2("a Huffman table is missing");
  const header = src[start];
  let weights;
  let next;
  if (header < 128) {
    next = start + 1 + header;
    if (next > end) throw corrupt2("a Huffman table runs past its block");
    weights = fseWeights(src, start + 1, next);
  } else {
    const count = header - 127;
    next = start + 1 + (count + 1 >> 1);
    if (next > end) throw corrupt2("a Huffman table runs past its block");
    weights = new Array(count);
    for (let i = 0; i < count; i++) {
      const byte = src[start + 1 + (i >> 1)];
      weights[i] = (i & 1) === 0 ? byte >> 4 : byte & 15;
    }
  }
  let total = 0;
  for (const weight of weights) {
    if (weight > 11) throw corrupt2("a Huffman weight is above 11");
    if (weight > 0) total += 1 << weight - 1;
  }
  if (total === 0) throw corrupt2("a Huffman table is empty");
  const maxBits = highBit(total) + 1;
  if (maxBits > 11) throw corrupt2("a Huffman code is longer than 11 bits");
  const rest = (1 << maxBits) - total;
  if ((rest & rest - 1) !== 0) throw corrupt2("Huffman weights do not add up");
  weights.push(highBit(rest) + 1);
  if (weights.length > 256) throw corrupt2("a Huffman table has too many symbols");
  const size = 1 << maxBits;
  const symbol = new Uint8Array(size);
  const bits = new Uint8Array(size);
  const rankStart = new Uint32Array(maxBits + 2);
  for (const weight of weights) if (weight > 0) rankStart[weight + 1] += 1 << weight - 1;
  for (let w = 1; w <= maxBits + 1; w++) rankStart[w] += rankStart[w - 1];
  for (let s = 0; s < weights.length; s++) {
    const weight = weights[s];
    if (weight === 0) continue;
    const length = 1 << weight - 1;
    const from = rankStart[weight];
    symbol.fill(s, from, from + length);
    bits.fill(maxBits + 1 - weight, from, from + length);
    rankStart[weight] = from + length;
  }
  return { table: { symbol, bits, maxBits }, next };
}
function huffmanStream(src, start, end, table, out, from, to) {
  const { symbol, bits, maxBits } = table;
  if (end <= start) throw corrupt2("a Huffman stream is empty");
  const last = src[end - 1];
  if (last === 0) throw corrupt2("a Huffman stream has no end marker");
  let position = (end - 1 - start) * 8 + highBit(last);
  const mask = (1 << maxBits) - 1;
  let o = from;
  if (position >= 24 && to - from >= 2) {
    const view = new DataView(src.buffer, src.byteOffset, src.length);
    const pairsEnd = to - 1;
    while (o < pairsEnd && position >= 24) {
      const at = (position >> 3) - 3;
      const cont = view.getInt32(start + at, true);
      let avail = position - (at << 3);
      let prefix = cont >>> avail - maxBits & mask;
      out[o++] = symbol[prefix];
      avail -= bits[prefix];
      prefix = cont >>> avail - maxBits & mask;
      out[o++] = symbol[prefix];
      avail -= bits[prefix];
      position = (at << 3) + avail;
    }
  }
  while (o < to && position >= maxBits) {
    const at = position - maxBits;
    const index = start + (at >>> 3);
    const prefix = (src[index] | src[index + 1] << 8 | src[index + 2] << 16) >>> (at & 7) & mask;
    out[o++] = symbol[prefix];
    position -= bits[prefix];
  }
  while (o < to) {
    if (position <= 0) throw corrupt2("a Huffman stream ends early");
    const index = start;
    const word = (src[index] | src[index + 1] << 8 | src[index + 2] << 16) & (1 << position) - 1;
    const prefix = word << maxBits - position & mask;
    out[o++] = symbol[prefix];
    position -= bits[prefix];
  }
  if (position !== 0) throw corrupt2("a Huffman stream does not end where it should");
}
var Output = class {
  constructor(expectedSize) {
    this.fixed = expectedSize !== null;
    this.bytes = new Uint8Array(this.fixed ? expectedSize : 64 * 1024);
    this.length = 0;
  }
  reserve(count) {
    const needed = this.length + count;
    if (needed <= this.bytes.length) return;
    if (this.fixed) throw corrupt2(`it decodes to more than the ${formatCountOf(this.bytes.length, "byte")} expected`);
    const grown = new Uint8Array(Math.max(needed, this.bytes.length * 2));
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
  }
};
function readLiterals(src, start, end, frame) {
  const b0 = src[start];
  const type = b0 & 3;
  const sizeFormat = b0 >> 2 & 3;
  let p = start;
  if (type < 2) {
    let size2;
    if ((sizeFormat & 1) === 0) {
      size2 = b0 >> 3;
      p += 1;
    } else if (sizeFormat === 1) {
      size2 = b0 >> 4 | src[p + 1] << 4;
      p += 2;
    } else {
      size2 = b0 >> 4 | src[p + 1] << 4 | src[p + 2] << 12;
      p += 3;
    }
    if (size2 > MAX_BLOCK_BYTES) throw corrupt2("a literals section is larger than a block");
    if (type === 0) {
      if (p + size2 > end) throw corrupt2("raw literals run past their block");
      return { literals: src.subarray(p, p + size2), next: p + size2 };
    }
    if (p >= end) throw corrupt2("run-length literals are missing their byte");
    return { literals: frame.literalBuffer.subarray(0, size2).fill(src[p]), next: p + 1 };
  }
  let size;
  let compressedSize;
  let streams = sizeFormat === 0 ? 1 : 4;
  if (sizeFormat < 2) {
    const v = b0 | src[p + 1] << 8 | src[p + 2] << 16;
    size = v >> 4 & 1023;
    compressedSize = v >> 14 & 1023;
    p += 3;
  } else if (sizeFormat === 2) {
    const v = (b0 | src[p + 1] << 8 | src[p + 2] << 16 | src[p + 3] << 24) >>> 0;
    size = v >>> 4 & 16383;
    compressedSize = v >>> 18;
    p += 4;
  } else {
    size = b0 >> 4 | src[p + 1] << 4 | (src[p + 2] & 63) << 12;
    compressedSize = src[p + 2] >> 6 | src[p + 3] << 2 | src[p + 4] << 10;
    p += 5;
  }
  if (size > MAX_BLOCK_BYTES) throw corrupt2("a literals section is larger than a block");
  const literalsEnd = p + compressedSize;
  if (literalsEnd > end) throw corrupt2("compressed literals run past their block");
  if (type === 2) {
    const { table, next } = readHuffmanTable(src, p, literalsEnd);
    frame.huffman = table;
    p = next;
  } else if (frame.huffman === null) {
    throw corrupt2("literals repeat a Huffman table that was never sent");
  }
  const out = frame.literalBuffer;
  if (streams === 1) {
    huffmanStream(src, p, literalsEnd, frame.huffman, out, 0, size);
  } else {
    if (p + 6 > literalsEnd) throw corrupt2("a four-stream jump table is truncated");
    const size1 = src[p] | src[p + 1] << 8;
    const size2 = src[p + 2] | src[p + 3] << 8;
    const size3 = src[p + 4] | src[p + 5] << 8;
    const s1 = p + 6;
    const s2 = s1 + size1;
    const s3 = s2 + size2;
    const s4 = s3 + size3;
    if (s4 > literalsEnd) throw corrupt2("four-stream literals run past their section");
    const segment = size + 3 >> 2;
    if (3 * segment > size) throw corrupt2("four-stream literals are too short");
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
    if (p >= end) throw corrupt2(`the ${what} code is missing`);
    if (src[p] > maxSymbol) throw corrupt2(`a ${what} code is out of range`);
    return { table: rleTable(src[p]), next: p + 1 };
  }
  if (mode === 2) return readFseTable(src, p, end, maxSymbol, maxAccuracyLog);
  if (previous === null) throw corrupt2(`${what} codes repeat a table that was never sent`);
  return { table: previous, next: p };
}
function copyLiterals(out, o, literals, from, count) {
  if (count > 32) {
    out.set(literals.subarray(from, from + count), o);
  } else {
    for (let i = 0; i < count; i++) out[o + i] = literals[from + i];
  }
}
function sequenceCodes(table, bases, extraBits) {
  if (table.transition === void 0) {
    const size = table.symbol.length;
    const transition = new Int32Array(size);
    const code = new Int32Array(size);
    for (let state = 0; state < size; state++) {
      const symbol = table.symbol[state];
      transition[state] = table.base[state] << 4 | table.bits[state];
      code[state] = bases === null ? symbol : bases[symbol] << 5 | extraBits[symbol];
    }
    table.transition = transition;
    table.code = code;
  }
  return table;
}
function compressedBlock(src, start, end, frame, output) {
  const { literals, next } = readLiterals(src, start, end, frame);
  let p = next;
  if (p >= end) throw corrupt2("a block has no sequences section");
  let sequences = src[p++];
  if (sequences >= 128) {
    if (sequences === 255) {
      if (p + 2 > end) throw corrupt2("a sequence count is truncated");
      sequences = src[p] + (src[p + 1] << 8) + 32512;
      p += 2;
    } else {
      if (p >= end) throw corrupt2("a sequence count is truncated");
      sequences = (sequences - 128 << 8) + src[p++];
    }
  }
  if (sequences === 0) {
    if (p !== end) throw corrupt2("a block has bytes after its literals");
    output.reserve(literals.length);
    copyLiterals(output.bytes, output.length, literals, 0, literals.length);
    output.length += literals.length;
    return;
  }
  if (p >= end) throw corrupt2("the sequence compression modes are missing");
  const modes = src[p++];
  if ((modes & 3) !== 0) throw corrupt2("reserved sequence mode bits are set");
  let found = sequenceTable(modes >> 6, src, p, end, LL_PREDEFINED, 35, 9, frame.literalLengths, "literal length");
  const ll = found.table;
  found = sequenceTable(modes >> 4 & 3, src, found.next, end, OF_PREDEFINED, 31, 8, frame.offsets, "offset");
  const of = found.table;
  found = sequenceTable(modes >> 2 & 3, src, found.next, end, ML_PREDEFINED, 52, 9, frame.matchLengths, "match length");
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
  let bitStart = found.next;
  if (end <= bitStart) throw corrupt2("a bit stream is empty");
  const lastByte = src[end - 1];
  if (lastByte === 0) throw corrupt2("a bit stream has no end marker");
  let avail = (end - 1 - bitStart) * 8 + highBit(lastByte);
  let bitSource = src;
  if (end - bitStart < 4) {
    bitSource = new Uint8Array(4);
    bitSource.set(src.subarray(bitStart, end));
    bitStart = 0;
  }
  const bitView = new DataView(bitSource.buffer, bitSource.byteOffset, bitSource.length);
  let at = 0;
  let cont = 0;
  avail += at << 3;
  at = (avail >> 3) - 3;
  if (at < 0) at = 0;
  avail -= at << 3;
  cont = bitView.getInt32(bitStart + at, true);
  let n = ll.accuracyLog;
  avail -= n;
  let llState = cont >>> avail & (1 << n) - 1;
  n = of.accuracyLog;
  if (avail < n) {
    avail += at << 3;
    at = (avail >> 3) - 3;
    if (at < 0) at = 0;
    avail -= at << 3;
    cont = bitView.getInt32(bitStart + at, true);
  }
  avail -= n;
  let ofState = cont >>> avail & (1 << n) - 1;
  n = ml.accuracyLog;
  if (avail < n) {
    avail += at << 3;
    at = (avail >> 3) - 3;
    if (at < 0) at = 0;
    avail -= at << 3;
    cont = bitView.getInt32(bitStart + at, true);
  }
  avail -= n;
  let mlState = cont >>> avail & (1 << n) - 1;
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
    const ofCode = ofCodes[ofState];
    if (avail < 24) {
      avail += at << 3;
      at = (avail >> 3) - 3;
      if (at < 0) at = 0;
      avail -= at << 3;
      cont = bitView.getInt32(bitStart + at, true);
    }
    let offset;
    if (ofCode <= 24) {
      avail -= ofCode;
      offset = (1 << ofCode) + (cont >>> avail & (1 << ofCode) - 1);
    } else {
      if (ofCode > 31) throw corrupt2("an offset code is out of range");
      n = ofCode - 16;
      avail -= n;
      const high = 1 << n | cont >>> avail & (1 << n) - 1;
      avail += at << 3;
      at = (avail >> 3) - 3;
      if (at < 0) at = 0;
      avail -= at << 3;
      cont = bitView.getInt32(bitStart + at, true);
      avail -= 16;
      offset = (high << 16 | cont >>> avail & 65535) >>> 0;
    }
    const mlCode = mlCodes[mlState];
    n = mlCode & 31;
    if (avail < n) {
      avail += at << 3;
      at = (avail >> 3) - 3;
      if (at < 0) at = 0;
      avail -= at << 3;
      cont = bitView.getInt32(bitStart + at, true);
    }
    avail -= n;
    const matchLength = (mlCode >> 5) + (cont >>> avail & (1 << n) - 1);
    const llCode = llCodes[llState];
    n = llCode & 31;
    if (avail < n) {
      avail += at << 3;
      at = (avail >> 3) - 3;
      if (at < 0) at = 0;
      avail -= at << 3;
      cont = bitView.getInt32(bitStart + at, true);
    }
    avail -= n;
    const literalLength = (llCode >> 5) + (cont >>> avail & (1 << n) - 1);
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
      if (avail < stateBits) {
        avail += at << 3;
        at = (avail >> 3) - 3;
        if (at < 0) at = 0;
        avail -= at << 3;
        cont = bitView.getInt32(bitStart + at, true);
      }
      let step = llNext[llState];
      n = step & 15;
      avail -= n;
      llState = (step >> 4) + (cont >>> avail & (1 << n) - 1);
      step = mlNext[mlState];
      n = step & 15;
      avail -= n;
      mlState = (step >> 4) + (cont >>> avail & (1 << n) - 1);
      step = ofNext[ofState];
      n = step & 15;
      if (avail < n) {
        avail += at << 3;
        at = (avail >> 3) - 3;
        if (at < 0) at = 0;
        avail -= at << 3;
        cont = bitView.getInt32(bitStart + at, true);
      }
      avail -= n;
      ofState = (step >> 4) + (cont >>> avail & (1 << n) - 1);
    }
    if (literalPos + literalLength > literalCount) throw corrupt2("a sequence uses more literals than the block holds");
    if (o + literalLength + matchLength > capacity) {
      output.length = o;
      output.reserve(literalLength + matchLength);
      out = output.bytes;
      view = new DataView(out.buffer, out.byteOffset, out.length);
      capacity = out.length;
    }
    if (literalLength > 0) {
      if (literalLength <= 8 && literalPos + 8 <= literalCount && o + 8 <= capacity) {
        view.setInt32(o, literalView.getInt32(literalPos, true), true);
        view.setInt32(o + 4, literalView.getInt32(literalPos + 4, true), true);
        o += literalLength;
        literalPos += literalLength;
      } else if (literalLength > 32) {
        out.set(literals.subarray(literalPos, literalPos + literalLength), o);
        o += literalLength;
        literalPos += literalLength;
      } else {
        for (const literalStop = literalPos + literalLength; literalPos < literalStop; ) out[o++] = literals[literalPos++];
      }
    }
    if (offset < 1 || offset > o - frameStart) throw corrupt2("a match reaches before the start of the frame");
    const stop = o + matchLength;
    if (offset >= 8 && matchLength < BLOCK_COPY_BYTES && stop + 8 <= capacity) {
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
  if (8 * at + avail !== 0) throw corrupt2("the sequence bit stream does not end where it should");
  const rest = literalCount - literalPos;
  output.reserve(rest);
  copyLiterals(output.bytes, output.length, literals, literalPos, rest);
  output.length += rest;
}
function readUint32(src, at) {
  return (src[at] | src[at + 1] << 8 | src[at + 2] << 16 | src[at + 3] << 24) >>> 0;
}
function decodeFrame(src, start, output) {
  let p = start + 4;
  if (p >= src.length) throw corrupt2("a frame header is truncated");
  const descriptor = src[p++];
  const contentSizeFlag = descriptor >> 6;
  const singleSegment = descriptor >> 5 & 1;
  const hasChecksum = descriptor >> 2 & 1;
  const dictionaryFlag = descriptor & 3;
  if ((descriptor & 8) !== 0) throw corrupt2("a reserved frame header bit is set");
  if (!singleSegment) p++;
  const dictionaryBytes = [0, 1, 2, 4][dictionaryFlag];
  let dictionary = 0;
  for (let i = 0; i < dictionaryBytes; i++) dictionary += src[p + i] * 2 ** (8 * i);
  p += dictionaryBytes;
  if (dictionary !== 0) {
    throw new ZarrUnsupportedError("Zstandard dictionary", "This Zstandard data was compressed with a dictionary, which Zarr never uses and this reader does not read.");
  }
  const sizeBytes = [singleSegment ? 1 : 0, 2, 4, 8][contentSizeFlag];
  let contentSize = null;
  if (sizeBytes > 0) {
    if (p + sizeBytes > src.length) throw corrupt2("a frame header is truncated");
    contentSize = 0;
    for (let i = 0; i < sizeBytes; i++) contentSize += src[p + i] * 2 ** (8 * i);
    if (sizeBytes === 2) contentSize += 256;
    p += sizeBytes;
  }
  if (contentSize !== null) output.reserve(contentSize);
  const frame = {
    outputStart: output.length,
    // Offsets reach 2^32 - 4 (code 31), past what an Int32Array holds.
    repeats: new Uint32Array([1, 4, 8]),
    huffman: null,
    literalLengths: null,
    offsets: null,
    matchLengths: null,
    literalBuffer: LITERALS
  };
  for (let last = 0; !last; ) {
    if (p + 3 > src.length) throw corrupt2("a block header is truncated");
    const header = src[p] | src[p + 1] << 8 | src[p + 2] << 16;
    p += 3;
    last = header & 1;
    const type = header >> 1 & 3;
    const size = header >>> 3;
    if (type === 0) {
      if (p + size > src.length) throw corrupt2("a raw block is truncated");
      output.reserve(size);
      output.bytes.set(src.subarray(p, p + size), output.length);
      output.length += size;
      p += size;
    } else if (type === 1) {
      if (p >= src.length) throw corrupt2("a run-length block is truncated");
      output.reserve(size);
      output.bytes.fill(src[p], output.length, output.length + size);
      output.length += size;
      p += 1;
    } else if (type === 2) {
      if (size > MAX_BLOCK_BYTES || p + size > src.length) throw corrupt2("a compressed block is truncated");
      compressedBlock(src, p, p + size, frame, output);
      p += size;
    } else {
      throw corrupt2("a block has the reserved type");
    }
  }
  if (hasChecksum) p += 4;
  if (p > src.length) throw corrupt2("the frame checksum is truncated");
  if (contentSize !== null && output.length - frame.outputStart !== contentSize) {
    throw corrupt2(`a frame declares ${formatCountOf(contentSize, "byte")} and holds ${output.length - frame.outputStart}`);
  }
  return p;
}
function zstdDecompress(input, expectedSize = null) {
  const output = new Output(expectedSize);
  let p = 0;
  while (p < input.length) {
    if (p + 4 > input.length) throw corrupt2("trailing bytes follow the last frame");
    const magic = readUint32(input, p);
    if (magic === FRAME_MAGIC) {
      p = decodeFrame(input, p, output);
    } else if ((magic & SKIPPABLE_MASK) >>> 0 === SKIPPABLE_MAGIC) {
      p += 8 + readUint32(input, p + 4);
    } else {
      throw corrupt2("it does not start with a Zstandard frame");
    }
  }
  if (p > input.length) throw corrupt2("a skippable frame is truncated");
  if (expectedSize !== null) {
    if (output.length !== expectedSize) {
      throw corrupt2(`it decodes to ${formatCountOf(output.length, "byte")}, not the ${expectedSize} expected`);
    }
    return output.bytes;
  }
  return output.bytes.length === output.length ? output.bytes : output.bytes.slice(0, output.length);
}

// assets/js/formats/zarr/codecs/blosc.js
var HEADER_BYTES = 16;
var DO_SHUFFLE = 1;
var MEMCPYED = 2;
var DO_BITSHUFFLE = 4;
var DO_DELTA = 8;
var DONT_SPLIT = 16;
var MAX_SPLITS = 16;
var MIN_SPLIT_ELEMENTS = 128;
var BLOSCLZ_MAX_DISTANCE = 8191;
var LZ4_MAX_EXPANSION = 255;
var CODEC_NAMES = ["blosclz", "lz4", "snappy", "zlib", "zstd"];
function corrupt3(detail) {
  return new ZarrFormatError(`Blosc data is corrupt: ${detail}.`);
}
function blosclzDecodeInto(input, output, start, end) {
  const limit = input.length;
  if (limit === 0) throw corrupt3("a blosclz stream is empty");
  const view = new DataView(output.buffer, output.byteOffset, output.length);
  let ip = 0;
  let op = start;
  let control = input[ip++] & 31;
  for (; ; ) {
    if (control >= 32) {
      let length = (control >>> 5) - 1;
      let distance = (control & 31) << 8;
      if (length === 6) {
        let code2;
        do {
          if (ip + 1 >= limit) throw corrupt3("a blosclz match is truncated");
          code2 = input[ip++];
          length += code2;
        } while (code2 === 255);
      } else if (ip + 1 >= limit) {
        throw corrupt3("a blosclz match is truncated");
      }
      const code = input[ip++];
      length += 3;
      let ref = op - distance - code;
      if (code === 255 && distance === 31 << 8) {
        if (ip + 1 >= limit) throw corrupt3("a blosclz match is truncated");
        distance = (input[ip] << 8) + input[ip + 1];
        ip += 2;
        ref = op - distance - BLOSCLZ_MAX_DISTANCE;
      }
      if (op + length > end) throw corrupt3("a blosclz match exceeds its block");
      if (ref - 1 < start) throw corrupt3("a blosclz match reaches before its block");
      if (ip >= limit) break;
      control = input[ip++];
      copyMatch(output, view, op, op - (ref - 1), length);
      op += length;
    } else {
      const run2 = control + 1;
      if (op + run2 > end || ip + run2 > limit) throw corrupt3("a blosclz literal run exceeds its bounds");
      if (run2 > 16) output.set(input.subarray(ip, ip + run2), op);
      else for (let k = 0; k < run2; k++) output[op + k] = input[ip + k];
      op += run2;
      ip += run2;
      if (ip >= limit) break;
      control = input[ip++];
    }
  }
  if (op !== end) throw corrupt3(`a blosclz stream decodes to ${formatCountOf(op - start, "byte")}, not ${end - start}`);
}
async function decodeStream(codec, stream, output, start, end) {
  if (codec === 1) {
    lz4DecodeBlockInto(stream, output, start, end);
  } else if (codec === 0) {
    blosclzDecodeInto(stream, output, start, end);
  } else if (codec === 4) {
    output.set(zstdDecompress(stream, end - start), start);
  } else if (codec === 3) {
    output.set(await inflate(stream, { format: "deflate", expectedSize: end - start, label: "A Blosc zlib stream" }), start);
  } else {
    const name = CODEC_NAMES[codec] ?? `codec ${codec}`;
    throw new ZarrUnsupportedError(`Blosc ${name}`, `This array is compressed with Blosc using ${name}, which this reader cannot decompress.`);
  }
}
function bitUntranspose(src, dest, at, count, typesize, scratch) {
  const rowBytes = count >>> 3;
  for (let j = 0; j < typesize; j++) {
    for (let i = 0; i < rowBytes; i++) {
      const base = i * 8 * typesize + j * 8;
      for (let k = 0; k < 8; k++) scratch[base + k] = src[(j * 8 + k) * rowBytes + i];
    }
  }
  const total = count * typesize;
  const groupBytes = 8 * typesize;
  for (let j = 0; j < groupBytes; j += 8) {
    const byteInElement = j >>> 3;
    for (let i = 0; i + groupBytes <= total; i += groupBytes) {
      const b = i + j;
      const b0 = scratch[b];
      const b1 = scratch[b + 1];
      const b2 = scratch[b + 2];
      const b3 = scratch[b + 3];
      const b4 = scratch[b + 4];
      const b5 = scratch[b + 5];
      const b6 = scratch[b + 6];
      const b7 = scratch[b + 7];
      for (let k = 0; k < 8; k++) {
        dest[at + i + byteInElement + k * typesize] = b0 >> k & 1 | (b1 >> k & 1) << 1 | (b2 >> k & 1) << 2 | (b3 >> k & 1) << 3 | (b4 >> k & 1) << 4 | (b5 >> k & 1) << 5 | (b6 >> k & 1) << 6 | (b7 >> k & 1) << 7;
      }
    }
  }
}
function bitUnshuffle(src, dest, at, size, typesize, version) {
  let count = Math.floor(size / typesize);
  if (version <= 2 && count % 8 !== 0) {
    dest.set(src.subarray(0, size), at);
    return;
  }
  count -= count % 8;
  if (count > 0) bitUntranspose(src, dest, at, count, typesize, new Uint8Array(count * typesize));
  const done = count * typesize;
  if (done < size) dest.set(src.subarray(done, size), at + done);
}
async function bloscDecode(input, expectedSize) {
  if (input.length < HEADER_BYTES) throw corrupt3("the header is truncated");
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
  if (cbytes !== input.length) throw corrupt3(`the frame declares ${formatCountOf(cbytes, "byte")} and holds ${input.length}`);
  if (expectedSize !== null && nbytes !== expectedSize) {
    throw corrupt3(`the frame decodes to ${formatCountOf(nbytes, "byte")}, not the ${expectedSize} expected`);
  }
  if (expectedSize === null && nbytes > input.length * LZ4_MAX_EXPANSION + 64) {
    throw corrupt3(`the frame declares more bytes than its codecs can encode in ${input.length}`);
  }
  if (typesize === 0) throw corrupt3("the element size is zero");
  const codec = flags >>> 5;
  if ((flags & MEMCPYED) !== 0) {
    if (cbytes !== HEADER_BYTES + nbytes) throw corrupt3("a plain-copy frame has the wrong size");
    return input.slice(HEADER_BYTES);
  }
  if (codec > 4) throw corrupt3(`the codec format ${codec} is unknown`);
  if (codecVersion !== 1 && codec !== 4 && codec !== 3) {
    throw new ZarrUnsupportedError(`Blosc ${CODEC_NAMES[codec]} format ${codecVersion}`, `This array uses Blosc ${CODEC_NAMES[codec]} stream format ${codecVersion}, which this reader does not read.`);
  }
  const output = new Uint8Array(nbytes);
  if (nbytes === 0) return output;
  if (blocksize === 0 || blocksize > nbytes) throw corrupt3("the block size is invalid");
  const blocks = Math.ceil(nbytes / blocksize);
  const tableEnd = HEADER_BYTES + blocks * 4;
  if (tableEnd > cbytes) throw corrupt3("the block table is truncated");
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
    const splits = !dontSplit && !leftover && typesize <= MAX_SPLITS && Math.floor(blocksize / typesize) >= MIN_SPLIT_ELEMENTS ? typesize : 1;
    if (size % splits !== 0) throw corrupt3("a block cannot be divided into its streams");
    const streamBytes = size / splits;
    const target = shuffled ? scratch : output;
    const targetStart = shuffled ? 0 : outStart;
    let cursor = view.getUint32(HEADER_BYTES + block * 4, true);
    if (cursor < tableEnd || cursor >= cbytes) throw corrupt3("a block offset is outside the frame");
    const streams = [];
    for (let split = 0; split < splits; split++) {
      if (cursor + 4 > cbytes) throw corrupt3("a stream length is truncated");
      const length = view.getInt32(cursor, true);
      cursor += 4;
      if (length <= 0 || length > streamBytes || cursor + length > cbytes) throw corrupt3("a stream length is invalid");
      const stream = input.subarray(cursor, cursor + length);
      cursor += length;
      const from = targetStart + split * streamBytes;
      if (length === streamBytes) target.set(stream, from);
      else {
        const decoding = decodeStream(codec, stream, target, from, from + streamBytes);
        decoding.catch(() => {
        });
        streams.push(decoding);
      }
    }
    if (shuffled) {
      await Promise.all(streams);
      if (byteShuffle) byteUnshuffleInto(scratch, output, outStart, size, typesize);
      else bitUnshuffle(scratch, output, outStart, size, typesize, version);
    } else {
      pending.push(...streams);
    }
  }
  await Promise.all(pending);
  if ((flags & DO_DELTA) !== 0) undoDelta(output, blocksize, typesize);
  return output;
}
function undoDelta(output, blocksize, typesize) {
  const word = typesize === 1 || typesize === 2 || typesize === 4 || typesize === 8 ? typesize : typesize % 8 === 0 ? 8 : 1;
  const first = Math.min(blocksize, output.length);
  const whole = first - first % word;
  for (let at = word; at < whole; at++) output[at] ^= output[at - word];
  for (let start = blocksize; start < output.length; start += blocksize) {
    const size = Math.min(blocksize, output.length - start);
    const end = start + size - size % word;
    for (let at = start; at < end; at++) output[at] ^= output[at - start];
  }
}

// assets/js/formats/zarr/codecs/crc32c.js
var TABLES = (() => {
  const tables = new Uint32Array(8 * 256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 2197175160 ^ c >>> 1 : c >>> 1;
    tables[n] = c >>> 0;
  }
  for (let n = 0; n < 256; n++) {
    let c = tables[n];
    for (let t = 1; t < 8; t++) {
      c = tables[c & 255] ^ c >>> 8;
      tables[t * 256 + n] = c >>> 0;
    }
  }
  return tables;
})();
function crc32c(bytes) {
  const t = TABLES;
  let crc = 4294967295;
  let i = 0;
  const length = bytes.length;
  const fast = length - length % 8;
  const view = new DataView(bytes.buffer, bytes.byteOffset, length);
  for (; i < fast; i += 8) {
    const a = view.getInt32(i, true) ^ crc;
    const b = view.getInt32(i + 4, true);
    crc = t[1792 + (a & 255)] ^ t[1536 + (a >>> 8 & 255)] ^ t[1280 + (a >>> 16 & 255)] ^ t[1024 + (a >>> 24)] ^ t[768 + (b & 255)] ^ t[512 + (b >>> 8 & 255)] ^ t[256 + (b >>> 16 & 255)] ^ t[b >>> 24];
  }
  for (; i < length; i++) crc = t[(crc ^ bytes[i]) & 255] ^ crc >>> 8;
  return ~crc >>> 0;
}
function crc32cDecode(input) {
  if (input.length < 4) throw new ZarrFormatError("A CRC-32C checksum is truncated.");
  const end = input.length - 4;
  const stored = (input[end] | input[end + 1] << 8 | input[end + 2] << 16 | input[end + 3] << 24) >>> 0;
  if (crc32c(input.subarray(0, end)) !== stored) {
    throw new ZarrFormatError("A chunk is damaged: its CRC-32C checksum does not match.");
  }
  return input.subarray(0, end);
}

// assets/js/formats/zarr/codecs/pipeline.js
var unknownSize = () => null;
var sameSize = (size) => size;
function inflateDecoder(name, format) {
  return {
    name,
    allocates: true,
    inputSize: unknownSize,
    async decode(bytes, expectedSize) {
      try {
        return await inflate(bytes, { format, expectedSize, label: `A ${name} chunk` });
      } catch (cause) {
        if (cause?.name === "InflateError") throw new ZarrFormatError(cause.message, { cause });
        throw cause;
      }
    }
  };
}
function shuffleDecoder(elementSize) {
  if (!Number.isSafeInteger(elementSize) || elementSize < 1) {
    throw new ZarrFormatError("A shuffle codec needs a positive element size.");
  }
  return {
    name: "shuffle",
    allocates: true,
    inputSize: sameSize,
    decode: (bytes) => byteUnshuffle(bytes, elementSize)
  };
}
var CRC32C = {
  name: "crc32c",
  allocates: false,
  inputSize: (size) => size === null ? null : size + 4,
  decode: (bytes) => crc32cDecode(bytes)
};
var IDENTITY = { name: "bitround", allocates: false, inputSize: sameSize, decode: (bytes) => bytes };
var Unsupported = class extends Error {
  constructor(feature, message) {
    super(message);
    this.error = new ZarrUnsupportedError(feature, message);
  }
};
function unsupportedCodec(name, what) {
  return new Unsupported(`codec ${name}`, `${what} is compressed or encoded with '${name}', which this reader cannot decode.`);
}
function numcodecsDecoder(id, configuration, what) {
  const decoder = numcodecsDecoderOf(id, configuration, what);
  return decoder === null ? null : { ...decoder, codec: { id, configuration: plainConfiguration(id, configuration) } };
}
function plainConfiguration(id, configuration) {
  return id === "shuffle" ? { elementsize: configuration?.elementsize ?? 4 } : {};
}
function numcodecsDecoderOf(id, configuration, what) {
  switch (id) {
    case "gzip":
      return inflateDecoder("gzip", "gzip");
    case "zlib":
      return inflateDecoder("zlib", "deflate");
    case "blosc":
      return { name: "blosc", allocates: true, inputSize: unknownSize, decode: bloscDecode };
    case "zstd":
      return { name: "zstd", allocates: true, inputSize: unknownSize, decode: zstdDecompress };
    case "lz4":
      return { name: "lz4", allocates: true, inputSize: unknownSize, decode: numcodecsLz4Decode };
    case "crc32c":
      return CRC32C;
    case "shuffle":
      return shuffleDecoder(configuration?.elementsize ?? 4);
    case "bitround":
      return IDENTITY;
    case "bz2":
    case "lzma":
    case "lzf":
    case "snappy":
    case "zfpy":
    case "pcodec":
      throw unsupportedCodec(id, what);
    default:
      return null;
  }
}
var rebuilt = /* @__PURE__ */ new Map();
async function decodeWithCodecs(input, codecs, sizes) {
  const key = JSON.stringify(codecs);
  let decoders = rebuilt.get(key);
  if (decoders === void 0) {
    decoders = codecs.map(({ id, configuration }) => {
      const decoder = numcodecsDecoder(id, configuration, "A chunk");
      if (decoder === null) throw new ZarrUnsupportedError(`codec ${id}`, `A chunk is compressed or encoded with '${id}', which this reader cannot decode.`);
      return decoder;
    });
    rebuilt.set(key, decoders);
  }
  let bytes = input;
  for (let i = 0; i < decoders.length; i++) bytes = await decoders[i].decode(bytes, sizes[i]);
  return bytes;
}

// assets/js/formats/hdf5/checksum.js
function fold(sum) {
  return (sum & 65535) + (sum >>> 16);
}
function fletcher32(bytes) {
  const words = bytes.length >>> 1;
  let sum1 = 0;
  let sum2 = 0;
  let index = 0;
  let remaining = words;
  while (remaining > 0) {
    let block = remaining > 360 ? 360 : remaining;
    remaining -= block;
    while (block-- > 0) {
      sum1 = sum1 + (bytes[index] << 8 | bytes[index + 1]) >>> 0;
      index += 2;
      sum2 = sum2 + sum1 >>> 0;
    }
    sum1 = fold(sum1);
    sum2 = fold(sum2);
  }
  if (bytes.length & 1) {
    sum1 = sum1 + (bytes[index] << 8) >>> 0;
    sum2 = sum2 + sum1 >>> 0;
    sum1 = fold(sum1);
    sum2 = fold(sum2);
  }
  sum1 = fold(sum1);
  sum2 = fold(sum2);
  return (sum2 << 16 | sum1) >>> 0;
}

// assets/js/formats/hdf5/errors.js
var Hdf5FormatError = class extends Error {
  /**
   * @param {string} message
   * @param {{cause?: unknown, offset?: number|null}} [options]
   */
  constructor(message, { cause, offset = null } = {}) {
    super(message, cause === void 0 ? void 0 : { cause });
    this.name = "Hdf5FormatError";
    this.offset = offset;
  }
};
var Hdf5UnsupportedError = class extends Error {
  /**
   * @param {string} feature - Short identifier, e.g. `'filter:szip'`
   * @param {string} message
   * @param {{cause?: unknown}} [options]
   */
  constructor(feature, message, { cause } = {}) {
    super(message, cause === void 0 ? void 0 : { cause });
    this.name = "Hdf5UnsupportedError";
    this.feature = feature;
  }
};

// assets/js/formats/hdf5/lzf.js
function lzfDecompress(input, outputSize) {
  const output = new Uint8Array(outputSize);
  const view = new DataView(output.buffer);
  const inputLength = input.length;
  let ip = 0;
  let op = 0;
  while (ip < inputLength) {
    const ctrl = input[ip++];
    if (ctrl < 32) {
      const length = ctrl + 1;
      if (op + length > outputSize || ip + length > inputLength) return null;
      if (length < 16) {
        for (let i = 0; i < length; i++) output[op++] = input[ip++];
      } else {
        output.set(input.subarray(ip, ip + length), op);
        ip += length;
        op += length;
      }
    } else {
      let length = ctrl >> 5;
      if (length === 7) {
        if (ip >= inputLength) return null;
        length += input[ip++];
      }
      length += 2;
      if (ip >= inputLength) return null;
      const offset = ((ctrl & 31) << 8) + input[ip++] + 1;
      if (offset > op || op + length > outputSize) return null;
      copyMatch(output, view, op, offset, length);
      op += length;
    }
  }
  return op === outputSize ? output : null;
}

// assets/js/formats/hdf5/filters.js
var FILTER = Object.freeze({ DEFLATE: 1, SHUFFLE: 2, FLETCHER32: 3, LZF: 32e3 });
var KNOWN_FILTERS = /* @__PURE__ */ new Map([
  [4, "szip"],
  [5, "nbit"],
  [6, "scaleoffset"],
  [305, "LZO"],
  [307, "bzip2"],
  [32001, "Blosc"],
  [32002, "MAFISC"],
  [32003, "Snappy"],
  [32004, "LZ4"],
  [32005, "APAX"],
  [32006, "CBF"],
  [32007, "JPEG-XR"],
  [32008, "bitshuffle"],
  [32009, "SPDP"],
  [32010, "LPC-Rice"],
  [32011, "CCSDS-123"],
  [32012, "JPEG-LS"],
  [32013, "zfp"],
  [32014, "fpzip"],
  [32015, "Zstandard"],
  [32016, "B³D"],
  [32017, "SZ"],
  [32018, "FCIDECOMP"],
  [32019, "JPEG"],
  [32020, "VBZ"],
  [32022, "FAPEC"],
  [32023, "BitGroom"],
  [32024, "Granular BitRound"],
  [32025, "SZ3"],
  [32026, "Blosc2"],
  [32028, "Delta-Rice"]
]);
var SUPPORTED = /* @__PURE__ */ new Set([FILTER.DEFLATE, FILTER.SHUFFLE, FILTER.FLETCHER32, FILTER.LZF]);
function filterName(filter) {
  if (filter.id === FILTER.DEFLATE) return "deflate";
  if (filter.id === FILTER.SHUFFLE) return "shuffle";
  if (filter.id === FILTER.FLETCHER32) return "fletcher32";
  if (filter.id === FILTER.LZF) return "lzf";
  return KNOWN_FILTERS.get(filter.id) ?? (filter.name || `filter ${filter.id}`);
}
function unsupportedFilter(filter, label) {
  const name = filterName(filter);
  return new Hdf5UnsupportedError(
    `filter:${name}`,
    `${label} is compressed with the ${name} filter (HDF5 filter id ${filter.id}), which this reader cannot decompress.`
  );
}
function verifyFletcher32(input, label) {
  if (input.length < 4) throw new Hdf5FormatError(`${label} is too short to hold its Fletcher-32 checksum.`);
  const data = input.subarray(0, input.length - 4);
  const end = input.length - 4;
  const stored = (input[end] | input[end + 1] << 8 | input[end + 2] << 16 | input[end + 3] << 24) >>> 0;
  const computed = fletcher32(data);
  const reversed = ((computed & 255) << 8 | computed >>> 8 & 255 | (computed >>> 16 & 255) << 24 | (computed >>> 24 & 255) << 16) >>> 0;
  if (stored !== computed && stored !== reversed) {
    throw new Hdf5FormatError(`${label} fails its Fletcher-32 checksum: the data is corrupt.`);
  }
  return data;
}
function deflateBound(n) {
  return n + Math.floor(n / 4096) + Math.floor(n / 16384) + Math.floor(n / 33554432) + 13;
}
function lzfBound(n) {
  return n + Math.ceil(n / 32);
}
function sizeBefore(filters, mask, i, chunkBytes, label) {
  let size = chunkBytes;
  let exact = true;
  for (let j = 0; j < i; j++) {
    if (mask & 1 << j) continue;
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
async function unfilter(stored, filters, mask, chunkBytes, label) {
  let bytes = stored;
  for (let i = filters.length - 1; i >= 0; i--) {
    if (mask & 1 << i) continue;
    const filter = filters[i];
    const before = sizeBefore(filters, mask, i, chunkBytes, label);
    switch (filter.id) {
      case FILTER.DEFLATE:
        try {
          bytes = await inflate(bytes, before.exact ? { format: "deflate", expectedSize: before.size, label } : { format: "deflate", maxSize: before.size, label });
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
          throw new Hdf5FormatError(`${label} declares ${formatCountOf(size, "byte")} of LZF-compressed data, more than the ${before.size} its chunk can hold.`);
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
    throw new Hdf5FormatError(`${label} holds ${formatCountOf(bytes.length, "byte")} once decoded, not the ${chunkBytes} of a chunk.`);
  }
  return bytes;
}

// assets/js/formats/io/decode-worker.js
function decode({ kind, description, input }) {
  if (kind === "zarr") return decodeWithCodecs(input, description.codecs, description.sizes);
  if (kind === "hdf5") return unfilter(input, description.filters, description.mask, description.chunkBytes, description.label);
  throw new TypeError(`A decode worker cannot decode '${kind}' chunks.`);
}
var contexts = /* @__PURE__ */ new Map();
function transferablesOf(value, found = /* @__PURE__ */ new Set()) {
  if (ArrayBuffer.isView(value)) {
    if (value.byteOffset === 0 && value.byteLength === value.buffer.byteLength) found.add(value.buffer);
  } else if (Array.isArray(value)) {
    for (const item of value) transferablesOf(item, found);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) transferablesOf(item, found);
  }
  return found;
}
async function run({ module, name, args, context }) {
  const data = context === null ? void 0 : contexts.get(context);
  const exported = (await import(module))[name];
  if (typeof exported !== "function") throw new TypeError(`${module} exports no function '${name}'.`);
  return exported(args, data);
}
self.addEventListener("message", async (event) => {
  const task = event.data;
  if (task.context !== void 0 && task.data !== void 0 && task.id === void 0) {
    contexts.set(task.context, task.data);
    return;
  }
  if (task.release !== void 0) {
    contexts.delete(task.release);
    return;
  }
  if (task.kind === "run") {
    try {
      const output = await run(task);
      self.postMessage({ id: task.id, output }, [...transferablesOf(output)]);
    } catch (error) {
      self.postMessage({ id: task.id, error: errorData(error) });
    }
    return;
  }
  if (Array.isArray(task.items)) {
    const transfer = [];
    const results = await Promise.all(task.items.map(async (item) => {
      try {
        const output = await decode({ ...item, input: task.input.subarray(item.start, item.end) });
        const own = output.buffer === task.input.buffer ? output.slice() : output;
        transfer.push(own.buffer);
        return { output: own };
      } catch (error) {
        return { error: errorData(error) };
      }
    }));
    self.postMessage({ id: task.id, results }, transfer);
    return;
  }
  try {
    const output = await decode(task);
    self.postMessage({ id: task.id, output }, [output.buffer]);
  } catch (error) {
    self.postMessage({ id: task.id, error: errorData(error) });
  }
});
//# sourceMappingURL=decode-worker.709f673ec981.js.map
