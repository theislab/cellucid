/**
 * @fileoverview gzip compress/decompress helpers for session chunks.
 *
 * Current runtime contract requires native stream-based gzip support.
 * - `DecompressionStream('gzip')` for decompression
 * - `CompressionStream('gzip')` for compression
 *
 * All functions support an AbortSignal and enforce output size guards to
 * mitigate zip-bomb style attacks on untrusted session files.
 *
 * @module session/codecs/gzip
 */

import {
  assertExactKeys,
  assertSafeInteger
} from '../schema-contract.js';

/**
 * @param {AbortSignal | null | undefined} signal
 */
function throwIfAborted(signal) {
  if (signal !== null && signal.aborted) {
    // DOMException is the browser-standard for abort flows.
    throw new DOMException('Aborted', 'AbortError');
  }
}

function assertSignal(signal, context) {
  if (
    signal !== null
    && (
      typeof signal !== 'object'
      || typeof signal.aborted !== 'boolean'
    )
  ) {
    throw new TypeError(`${context} must be an AbortSignal or null.`);
  }
  return signal;
}

const GZIP_FIXED_HEADER_BYTES = 10;
const GZIP_TRAILER_BYTES = 8;
const DEFLATE_MAX_CODE_BITS = 15;
const UINT32_MODULUS = 0x100000000;
const PREFLIGHT_ABORT_CHECK_SYMBOLS = 4 * 1024;
const PREFLIGHT_YIELD_SYMBOLS = 128 * 1024;
const PREFLIGHT_YIELD_INPUT_BYTES = 64 * 1024;

const CODE_LENGTH_ORDER = Uint8Array.of(
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5,
  11, 4, 12, 3, 13, 2, 14, 1, 15,
);

const LENGTH_BASES = Uint16Array.of(
  3, 4, 5, 6, 7, 8, 9, 10,
  11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115,
  131, 163, 195, 227, 258,
);

const LENGTH_EXTRA_BITS = Uint8Array.of(
  0, 0, 0, 0, 0, 0, 0, 0,
  1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4,
  5, 5, 5, 5, 0,
);

const DISTANCE_BASES = Uint16Array.of(
  1, 2, 3, 4, 5, 7, 9, 13,
  17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073,
  4097, 6145, 8193, 12289, 16385, 24577,
);

const DISTANCE_EXTRA_BITS = Uint8Array.of(
  0, 0, 0, 0, 1, 1, 2, 2,
  3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10,
  11, 11, 12, 12, 13, 13,
);

function readUint16LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32LE(bytes, offset) {
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;
}

async function crc32Range(bytes, start, end, signal) {
  let crc = 0xffffffff;
  for (let offset = start; offset < end; offset += 1) {
    if (
      offset !== start
      && (offset - start) % PREFLIGHT_YIELD_INPUT_BYTES === 0
    ) {
      await yieldToMacrotask();
      throwIfAborted(signal);
    }
    crc ^= bytes[offset];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function yieldToMacrotask() {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

async function findHeaderTerminator(
  bytes,
  start,
  deflateLimit,
  field,
  signal,
) {
  let offset = start;
  while (offset < deflateLimit && bytes[offset] !== 0) {
    offset += 1;
    if ((offset - start) % PREFLIGHT_YIELD_INPUT_BYTES === 0) {
      await yieldToMacrotask();
      throwIfAborted(signal);
    }
  }
  if (offset === deflateLimit) {
    throw new Error(`Gzip member has an unterminated ${field} header field.`);
  }
  return offset + 1;
}

/**
 * Parse one gzip member header and return the DEFLATE byte offset.
 *
 * @param {Uint8Array} bytes
 * @param {AbortSignal | null} signal
 * @returns {Promise<number>}
 */
async function parseGzipHeader(bytes, signal) {
  if (bytes.byteLength < GZIP_FIXED_HEADER_BYTES + GZIP_TRAILER_BYTES) {
    throw new Error('Gzip member is truncated before its header and trailer.');
  }
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    throw new Error('Gzip member has an invalid magic number.');
  }
  if (bytes[2] !== 8) {
    throw new Error(`Gzip member uses unsupported compression method ${bytes[2]}.`);
  }

  const flags = bytes[3];
  if ((flags & 0xe0) !== 0) {
    throw new Error('Gzip member sets reserved header flag bits.');
  }

  const deflateLimit = bytes.byteLength - GZIP_TRAILER_BYTES;
  let offset = GZIP_FIXED_HEADER_BYTES;

  const requireHeaderBytes = (count, field) => {
    if (offset + count > deflateLimit) {
      throw new Error(`Gzip member is truncated in its ${field} header field.`);
    }
  };

  if ((flags & 0x04) !== 0) {
    requireHeaderBytes(2, 'FEXTRA length');
    const extraLength = readUint16LE(bytes, offset);
    offset += 2;
    requireHeaderBytes(extraLength, 'FEXTRA');
    offset += extraLength;
  }

  if ((flags & 0x08) !== 0) {
    offset = await findHeaderTerminator(
      bytes,
      offset,
      deflateLimit,
      'FNAME',
      signal,
    );
  }

  if ((flags & 0x10) !== 0) {
    offset = await findHeaderTerminator(
      bytes,
      offset,
      deflateLimit,
      'FCOMMENT',
      signal,
    );
  }

  if ((flags & 0x02) !== 0) {
    requireHeaderBytes(2, 'FHCRC');
    const expectedHeaderCrc = readUint16LE(bytes, offset);
    const actualHeaderCrc = (
      await crc32Range(bytes, 0, offset, signal)
    ) & 0xffff;
    if (expectedHeaderCrc !== actualHeaderCrc) {
      throw new Error('Gzip member FHCRC does not match its header.');
    }
    offset += 2;
  }

  return offset;
}

class DeflateBitReader {
  constructor(bytes, byteOffset, byteLimit) {
    this.bytes = bytes;
    this.bitOffset = byteOffset * 8;
    this.bitLimit = byteLimit * 8;
  }

  readBits(count, context) {
    const end = this.bitOffset + count;
    if (end > this.bitLimit) {
      throw new Error(`DEFLATE stream is truncated while reading ${context}.`);
    }

    let position = this.bitOffset;
    let remaining = count;
    let result = 0;
    let resultShift = 0;
    while (remaining > 0) {
      const byteBitOffset = position % 8;
      const take = Math.min(remaining, 8 - byteBitOffset);
      const mask = (1 << take) - 1;
      result |= (
        (
          this.bytes[Math.floor(position / 8)]
          >>> byteBitOffset
        ) & mask
      ) << resultShift;
      position += take;
      remaining -= take;
      resultShift += take;
    }

    this.bitOffset = end;
    return result;
  }

  alignToByte() {
    this.bitOffset = Math.ceil(this.bitOffset / 8) * 8;
    if (this.bitOffset > this.bitLimit) {
      throw new Error('DEFLATE stream is truncated at a byte boundary.');
    }
  }

  skipAlignedBytes(count, context) {
    if ((this.bitOffset % 8) !== 0) {
      throw new Error('Internal DEFLATE parser alignment error.');
    }
    const end = this.bitOffset + (count * 8);
    if (end > this.bitLimit) {
      throw new Error(`DEFLATE stream is truncated while reading ${context}.`);
    }
    this.bitOffset = end;
  }

  get byteOffset() {
    if ((this.bitOffset % 8) !== 0) {
      throw new Error('Internal DEFLATE parser boundary error.');
    }
    return this.bitOffset / 8;
  }
}

/**
 * A canonical DEFLATE Huffman decoder with fixed-capacity scratch storage.
 * Storage is bounded by the alphabet size and never by decompressed output.
 *
 * Each table decodes exactly one alphabet, so the two strings that name that
 * alphabet in a decode failure are properties of the table rather than
 * arguments to `decode()`. They are built once here. Deriving them per call
 * cost one discarded string per *bit*: a 2.25 MB session chunk built and threw
 * away 1,932,736 of them purely to size-check bytes the native decompressor
 * then decoded again.
 */
class DeflateHuffmanTable {
  constructor(capacity, decodeContext) {
    this.capacity = capacity;
    this.decodeContext = decodeContext;
    this.codeContext = `${decodeContext} Huffman code`;
    this.counts = new Uint16Array(DEFLATE_MAX_CODE_BITS + 1);
    this.firstCodes = new Uint16Array(DEFLATE_MAX_CODE_BITS + 1);
    this.firstSymbols = new Uint16Array(DEFLATE_MAX_CODE_BITS + 1);
    this.writeOffsets = new Uint16Array(DEFLATE_MAX_CODE_BITS + 1);
    this.symbols = new Uint16Array(capacity);
    this.maxBits = 0;
  }

  build(
    lengths,
    symbolCount,
    context,
    allowEmpty,
    allowSingleCode,
  ) {
    if (symbolCount > this.capacity) {
      throw new Error(`Internal ${context} Huffman table capacity error.`);
    }

    this.counts.fill(0);
    this.firstCodes.fill(0);
    this.firstSymbols.fill(0);
    this.maxBits = 0;

    let populatedSymbols = 0;
    for (let symbol = 0; symbol < symbolCount; symbol += 1) {
      const length = lengths[symbol];
      if (length > DEFLATE_MAX_CODE_BITS) {
        throw new Error(`${context} Huffman code exceeds 15 bits.`);
      }
      if (length !== 0) {
        this.counts[length] += 1;
        populatedSymbols += 1;
        this.maxBits = Math.max(this.maxBits, length);
      }
    }

    if (populatedSymbols === 0) {
      if (!allowEmpty) {
        throw new Error(`${context} Huffman alphabet is empty.`);
      }
      return;
    }

    let unusedCodes = 1;
    for (let bits = 1; bits <= DEFLATE_MAX_CODE_BITS; bits += 1) {
      unusedCodes = (unusedCodes * 2) - this.counts[bits];
      if (unusedCodes < 0) {
        throw new Error(`${context} Huffman tree is oversubscribed.`);
      }
    }
    if (
      unusedCodes > 0
      && (!allowSingleCode || this.maxBits !== 1)
    ) {
      throw new Error(`${context} Huffman tree is incomplete.`);
    }

    let firstCode = 0;
    let firstSymbol = 0;
    for (let bits = 1; bits <= DEFLATE_MAX_CODE_BITS; bits += 1) {
      firstCode = (firstCode + this.counts[bits - 1]) << 1;
      this.firstCodes[bits] = firstCode;
      this.firstSymbols[bits] = firstSymbol;
      this.writeOffsets[bits] = firstSymbol;
      firstSymbol += this.counts[bits];
    }

    for (let symbol = 0; symbol < symbolCount; symbol += 1) {
      const length = lengths[symbol];
      if (length !== 0) {
        this.symbols[this.writeOffsets[length]] = symbol;
        this.writeOffsets[length] += 1;
      }
    }
  }

  decode(reader) {
    if (this.maxBits === 0) {
      throw new Error(`${this.decodeContext} Huffman alphabet is empty.`);
    }

    let code = 0;
    for (let bits = 1; bits <= this.maxBits; bits += 1) {
      code = (code << 1) | reader.readBits(1, this.codeContext);
      const firstCode = this.firstCodes[bits];
      const codeIndex = code - firstCode;
      if (codeIndex >= 0 && codeIndex < this.counts[bits]) {
        return this.symbols[this.firstSymbols[bits] + codeIndex];
      }
    }
    throw new Error(
      `${this.decodeContext} contains an invalid Huffman code.`
    );
  }
}

function createFixedHuffmanTables() {
  const literalLengths = new Uint8Array(288);
  literalLengths.fill(8, 0, 144);
  literalLengths.fill(9, 144, 256);
  literalLengths.fill(7, 256, 280);
  literalLengths.fill(8, 280, 288);

  const distanceLengths = new Uint8Array(32);
  distanceLengths.fill(5);

  const literalTable = new DeflateHuffmanTable(
    288,
    'DEFLATE literal/length stream',
  );
  literalTable.build(
    literalLengths,
    288,
    'Fixed literal/length',
    false,
    false,
  );
  const distanceTable = new DeflateHuffmanTable(
    32,
    'DEFLATE distance stream',
  );
  distanceTable.build(
    distanceLengths,
    32,
    'Fixed distance',
    false,
    false,
  );
  return Object.freeze({ literalTable, distanceTable });
}

const FIXED_HUFFMAN_TABLES = createFixedHuffmanTables();

class DeflateSizePreflight {
  constructor(bytes, byteOffset, byteLimit, maxOutputBytes, signal) {
    this.reader = new DeflateBitReader(bytes, byteOffset, byteLimit);
    this.maxOutputBytes = maxOutputBytes;
    this.signal = signal;
    this.outputBytes = 0;
    this.decodedSymbols = 0;
    this.lastYieldSymbol = 0;
    this.lastYieldInputByte = byteOffset;

    // Constant-size scratch space: no storage scales with decompressed output.
    this.codeLengthLengths = new Uint8Array(19);
    this.literalLengths = new Uint8Array(288);
    this.distanceLengths = new Uint8Array(32);
    this.codeLengthTable = new DeflateHuffmanTable(
      19,
      'DEFLATE code-length stream',
    );
    this.literalTable = new DeflateHuffmanTable(
      288,
      'DEFLATE literal/length stream',
    );
    this.distanceTable = new DeflateHuffmanTable(
      32,
      'DEFLATE distance stream',
    );
  }

  addOutputBytes(count) {
    const next = this.outputBytes + count;
    if (next > this.maxOutputBytes) {
      throw new Error(
        `Decompressed data exceeds limit `
        + `(${next} > ${this.maxOutputBytes} bytes).`,
      );
    }
    this.outputBytes = next;
  }

  isMacrotaskYieldDue() {
    return (
      this.decodedSymbols - this.lastYieldSymbol
        >= PREFLIGHT_YIELD_SYMBOLS
      || Math.floor(this.reader.bitOffset / 8) - this.lastYieldInputByte
        >= PREFLIGHT_YIELD_INPUT_BYTES
    );
  }

  async yieldAndCheckAbort() {
    await yieldToMacrotask();
    this.lastYieldSymbol = this.decodedSymbols;
    this.lastYieldInputByte = Math.floor(this.reader.bitOffset / 8);
    throwIfAborted(this.signal);
  }

  decodeCompressedSymbol(literalTable, distanceTable) {
    const symbol = literalTable.decode(this.reader);
    if (symbol < 256) {
      this.addOutputBytes(1);
      return false;
    }
    if (symbol === 256) {
      return true;
    }
    if (symbol > 285) {
      throw new Error(`DEFLATE uses reserved length symbol ${symbol}.`);
    }

    const lengthIndex = symbol - 257;
    const length = LENGTH_BASES[lengthIndex] + this.reader.readBits(
      LENGTH_EXTRA_BITS[lengthIndex],
      'DEFLATE match length',
    );
    const distanceSymbol = distanceTable.decode(this.reader);
    if (distanceSymbol > 29) {
      throw new Error(
        `DEFLATE uses reserved distance symbol ${distanceSymbol}.`,
      );
    }
    const distance = DISTANCE_BASES[distanceSymbol] + this.reader.readBits(
      DISTANCE_EXTRA_BITS[distanceSymbol],
      'DEFLATE match distance',
    );
    if (distance > this.outputBytes) {
      throw new Error(
        `DEFLATE match distance ${distance} exceeds `
        + `${this.outputBytes} available output bytes.`,
      );
    }
    this.addOutputBytes(length);
    return false;
  }

  readDynamicTables() {
    const encodedLiteralCount = this.reader.readBits(
      5,
      'DEFLATE HLIT',
    );
    if (encodedLiteralCount > 29) {
      throw new Error(
        `DEFLATE HLIT ${encodedLiteralCount} exceeds the maximum 29.`,
      );
    }
    const literalCount = encodedLiteralCount + 257;
    const distanceCount = this.reader.readBits(
      5,
      'DEFLATE HDIST',
    ) + 1;
    const codeLengthCount = this.reader.readBits(
      4,
      'DEFLATE HCLEN',
    ) + 4;

    this.codeLengthLengths.fill(0);
    for (let index = 0; index < codeLengthCount; index += 1) {
      this.codeLengthLengths[CODE_LENGTH_ORDER[index]] = this.reader.readBits(
        3,
        'DEFLATE code-length code',
      );
    }
    this.codeLengthTable.build(
      this.codeLengthLengths,
      19,
      'DEFLATE code-length',
      false,
      false,
    );

    this.literalLengths.fill(0);
    this.distanceLengths.fill(0);
    const totalCodeLengths = literalCount + distanceCount;
    let index = 0;
    let previousLength = 0;
    while (index < totalCodeLengths) {
      const symbol = this.codeLengthTable.decode(this.reader);
      let repeatedLength;
      let repeatCount;
      if (symbol <= 15) {
        repeatedLength = symbol;
        repeatCount = 1;
      } else if (symbol === 16) {
        if (index === 0) {
          throw new Error(
            'DEFLATE code-length repeat has no previous code length.',
          );
        }
        repeatedLength = previousLength;
        repeatCount = this.reader.readBits(
          2,
          'DEFLATE code-length repeat',
        ) + 3;
      } else if (symbol === 17) {
        repeatedLength = 0;
        repeatCount = this.reader.readBits(
          3,
          'DEFLATE zero-code repeat',
        ) + 3;
      } else if (symbol === 18) {
        repeatedLength = 0;
        repeatCount = this.reader.readBits(
          7,
          'DEFLATE long zero-code repeat',
        ) + 11;
      } else {
        throw new Error(`DEFLATE uses invalid code-length symbol ${symbol}.`);
      }

      if (index + repeatCount > totalCodeLengths) {
        throw new Error('DEFLATE code-length repeat exceeds its alphabets.');
      }
      for (let repeat = 0; repeat < repeatCount; repeat += 1) {
        if (index < literalCount) {
          this.literalLengths[index] = repeatedLength;
        } else {
          this.distanceLengths[index - literalCount] = repeatedLength;
        }
        index += 1;
      }
      previousLength = repeatedLength;
    }

    if (this.literalLengths[256] === 0) {
      throw new Error('DEFLATE literal/length alphabet omits end-of-block.');
    }
    this.literalTable.build(
      this.literalLengths,
      literalCount,
      'DEFLATE literal/length',
      false,
      true,
    );
    this.distanceTable.build(
      this.distanceLengths,
      distanceCount,
      'DEFLATE distance',
      true,
      true,
    );
  }

  async run() {
    let finalBlock = false;
    while (!finalBlock) {
      throwIfAborted(this.signal);
      finalBlock = this.reader.readBits(1, 'DEFLATE BFINAL') === 1;
      const blockType = this.reader.readBits(2, 'DEFLATE BTYPE');

      if (blockType === 0) {
        this.reader.alignToByte();
        const length = this.reader.readBits(16, 'DEFLATE stored LEN');
        const inverseLength = this.reader.readBits(
          16,
          'DEFLATE stored NLEN',
        );
        if ((length ^ 0xffff) !== inverseLength) {
          throw new Error('DEFLATE stored block LEN/NLEN do not match.');
        }
        this.addOutputBytes(length);
        this.reader.skipAlignedBytes(length, 'DEFLATE stored block bytes');
      } else if (blockType === 1 || blockType === 2) {
        let literalTable;
        let distanceTable;
        if (blockType === 1) {
          literalTable = FIXED_HUFFMAN_TABLES.literalTable;
          distanceTable = FIXED_HUFFMAN_TABLES.distanceTable;
        } else {
          this.readDynamicTables();
          literalTable = this.literalTable;
          distanceTable = this.distanceTable;
        }

        while (true) {
          if (
            this.decodedSymbols % PREFLIGHT_ABORT_CHECK_SYMBOLS
            === 0
          ) {
            throwIfAborted(this.signal);
            if (this.isMacrotaskYieldDue()) {
              await this.yieldAndCheckAbort();
            }
          }
          this.decodedSymbols += 1;
          if (this.decodeCompressedSymbol(
            literalTable,
            distanceTable,
          )) {
            break;
          }
        }
      } else {
        throw new Error('DEFLATE stream uses reserved block type 3.');
      }

      if (this.isMacrotaskYieldDue()) {
        await this.yieldAndCheckAbort();
      }
    }

    this.reader.alignToByte();
    return Object.freeze({
      outputBytes: this.outputBytes,
      trailerOffset: this.reader.byteOffset,
    });
  }
}

/**
 * Count one gzip member's exact output without materializing that output.
 *
 * The parser uses only constant-size Huffman scratch tables. It deliberately
 * rejects concatenated members and trailing bytes so the native decompressor
 * receives the same single-member envelope that was size-checked here.
 *
 * @param {Uint8Array} compressed
 * @param {number} maxOutputBytes
 * @param {AbortSignal | null} signal
 */
async function preflightSingleGzipMember(
  compressed,
  maxOutputBytes,
  signal,
) {
  const deflateOffset = await parseGzipHeader(compressed, signal);
  const parser = new DeflateSizePreflight(
    compressed,
    deflateOffset,
    compressed.byteLength - GZIP_TRAILER_BYTES,
    maxOutputBytes,
    signal,
  );
  const { outputBytes, trailerOffset } = await parser.run();

  if (trailerOffset + GZIP_TRAILER_BYTES !== compressed.byteLength) {
    throw new Error(
      'Gzip input must contain exactly one member with no trailing bytes.',
    );
  }
  const declaredSize = readUint32LE(compressed, trailerOffset + 4);
  const actualSize = outputBytes % UINT32_MODULUS;
  if (declaredSize !== actualSize) {
    throw new Error(
      `Gzip ISIZE ${declaredSize} does not match `
      + `${actualSize} parsed output bytes modulo 2^32.`,
    );
  }
  return outputBytes;
}

/**
 * Convert a Uint8Array into a ReadableStream<Uint8Array>.
 * @param {Uint8Array} bytes
 * @returns {ReadableStream<Uint8Array>}
 */
function bytesToStream(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('Gzip input must be a Uint8Array.');
  }
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    }
  });
}

/**
 * Read an entire ReadableStream into a single Uint8Array with an optional
 * maximum byte limit.
 *
 * @param {ReadableStream<Uint8Array>} stream
 * @param {{ maxBytes: number | null, signal: AbortSignal | null }} options
 * @returns {Promise<Uint8Array>}
 */
async function streamToUint8Array(stream, options) {
  assertExactKeys(
    options,
    ['maxBytes', 'signal'],
    'Gzip stream reader options'
  );
  if (
    stream === null
    || typeof stream !== 'object'
    || typeof stream.getReader !== 'function'
  ) {
    throw new TypeError('Gzip output must be a readable byte stream.');
  }
  const maxBytes = options.maxBytes === null
    ? null
    : assertSafeInteger(options.maxBytes, 'Gzip maximum output bytes');
  const signal = assertSignal(options.signal, 'Gzip stream signal');

  /** @type {Uint8Array[]} */
  const unboundedChunks = [];
  let firstBoundedChunk = null;
  let boundedOutput = null;
  let boundedOffset = 0;
  let total = 0;

  const reader = stream.getReader();
  try {
    while (true) {
      throwIfAborted(signal);
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new TypeError('Gzip byte stream must yield Uint8Array chunks.');
      }
      const chunk = value;
      if (!chunk.byteLength) continue;

      total += chunk.byteLength;
      if (maxBytes != null && total > maxBytes) {
        // Cancel the underlying stream ASAP to avoid continued decompression work.
        await reader.cancel('maxBytes exceeded');
        throw new Error(`Decompressed data exceeds limit (${total} > ${maxBytes} bytes).`);
      }

      if (maxBytes === null) {
        unboundedChunks.push(chunk);
      } else if (firstBoundedChunk === null && boundedOutput === null) {
        firstBoundedChunk = chunk;
      } else {
        if (boundedOutput === null) {
          boundedOutput = new Uint8Array(maxBytes);
          boundedOutput.set(firstBoundedChunk, 0);
          boundedOffset = firstBoundedChunk.byteLength;
          firstBoundedChunk = null;
        }
        boundedOutput.set(chunk, boundedOffset);
        boundedOffset += chunk.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (maxBytes !== null) {
    if (boundedOutput !== null) {
      if (boundedOffset !== maxBytes) {
        throw new Error(
          `Decompressed data produced ${boundedOffset} bytes; expected exactly ${maxBytes}.`
        );
      }
      return boundedOutput;
    }
    if (firstBoundedChunk !== null) {
      if (firstBoundedChunk.byteLength !== maxBytes) {
        throw new Error(
          `Decompressed data produced ${firstBoundedChunk.byteLength} bytes; `
          + `expected exactly ${maxBytes}.`
        );
      }
      return firstBoundedChunk;
    }
    if (maxBytes !== 0) {
      throw new Error(
        `Decompressed data produced 0 bytes; expected exactly ${maxBytes}.`
      );
    }
    return new Uint8Array(0);
  }

  // Fast path: single compression chunk.
  if (unboundedChunks.length === 1) return unboundedChunks[0];

  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of unboundedChunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * gzip-decompress bytes with an exact expected output bound.
 *
 * `maxOutputBytes` is both the hard allocation ceiling and the exact
 * manifest-owned output length. Under- and over-declared chunks are terminal.
 *
 * @param {Uint8Array} compressed
 * @param {{ maxOutputBytes: number, signal: AbortSignal | null }} options
 * @returns {Promise<Uint8Array>}
 */
export async function gzipDecompress(compressed, options) {
  if (!(compressed instanceof Uint8Array)) {
    throw new TypeError('Gzip compressed input must be a Uint8Array.');
  }
  assertExactKeys(
    options,
    ['maxOutputBytes', 'signal'],
    'Gzip decompression options'
  );
  const signal = assertSignal(options.signal, 'Gzip decompression signal');
  throwIfAborted(signal);

  const maxOutputBytes = assertSafeInteger(
    options.maxOutputBytes,
    'Gzip maximum output bytes'
  );

  const parsedOutputBytes = await preflightSingleGzipMember(
    compressed,
    maxOutputBytes,
    signal,
  );
  if (parsedOutputBytes !== maxOutputBytes) {
    throw new Error(
      `Gzip output size ${parsedOutputBytes} does not match `
      + `the exact ${maxOutputBytes}-byte contract.`,
    );
  }
  throwIfAborted(signal);

  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Gzip decompression requires DecompressionStream.');
  }

  const ds = new DecompressionStream('gzip');
  const decompressedStream = bytesToStream(compressed).pipeThrough(ds);
  return streamToUint8Array(decompressedStream, { maxBytes: maxOutputBytes, signal });
}

/**
 * gzip-compress bytes.
 *
 * @param {Uint8Array} uncompressed
 * @param {{ signal: AbortSignal | null }} options
 * @returns {Promise<Uint8Array>}
 */
export async function gzipCompress(uncompressed, options) {
  if (!(uncompressed instanceof Uint8Array)) {
    throw new TypeError('Gzip uncompressed input must be a Uint8Array.');
  }
  assertExactKeys(options, ['signal'], 'Gzip compression options');
  const signal = assertSignal(options.signal, 'Gzip compression signal');
  throwIfAborted(signal);

  if (typeof CompressionStream === 'undefined') {
    throw new Error('Gzip compression requires CompressionStream.');
  }

  const cs = new CompressionStream('gzip');
  const compressedStream = bytesToStream(uncompressed).pipeThrough(cs);
  return streamToUint8Array(compressedStream, { maxBytes: null, signal });
}
