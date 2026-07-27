import assert from 'node:assert/strict';
import test from 'node:test';
import { constants, gunzipSync, gzipSync } from 'node:zlib';

import {
  gzipDecompress,
} from '../assets/js/app/session/codecs/gzip.js';

const encoder = new TextEncoder();

function concatBytes(...parts) {
  const byteLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function gzipWithEveryHeaderOption(input) {
  const standard = new Uint8Array(gzipSync(input));
  const header = [
    0x1f, 0x8b, 8,
    0x1f, // FTEXT | FHCRC | FEXTRA | FNAME | FCOMMENT
    0, 0, 0, 0,
    0,
    255,
    3, 0,
    0xde, 0xad, 0xbe,
    ...encoder.encode('pancreas.bin'),
    0,
    ...encoder.encode('Cellucid session chunk'),
    0,
  ];
  const headerCrc = crc32(Uint8Array.from(header)) & 0xffff;
  header.push(headerCrc & 0xff, headerCrc >>> 8);
  return concatBytes(
    Uint8Array.from(header),
    standard.subarray(10),
  );
}

function bitBytes(writes) {
  const result = [];
  let byte = 0;
  let usedBits = 0;
  for (const [value, count, mostSignificantFirst = false] of writes) {
    for (let bit = 0; bit < count; bit += 1) {
      const valueBit = mostSignificantFirst
        ? count - bit - 1
        : bit;
      byte |= ((value >>> valueBit) & 1) << usedBits;
      usedBits += 1;
      if (usedBits === 8) {
        result.push(byte);
        byte = 0;
        usedBits = 0;
      }
    }
  }
  if (usedBits !== 0) {
    result.push(byte);
  }
  return Uint8Array.from(result);
}

function gzipEnvelope(deflateBytes) {
  return concatBytes(
    Uint8Array.of(
      0x1f, 0x8b, 8, 0,
      0, 0, 0, 0,
      0,
      255,
    ),
    deflateBytes,
    new Uint8Array(8),
  );
}

function writeUint32LE(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = value >>> 24;
}

function largeFixedLiteralGzip(outputBytes) {
  const input = new Uint8Array(outputBytes);
  input.fill(65);
  const deflate = new Uint8Array(
    Math.ceil((3 + (outputBytes * 8) + 7) / 8),
  );
  let bitOffset = 0;

  const writeBit = bit => {
    deflate[Math.floor(bitOffset / 8)] |= bit << (bitOffset % 8);
    bitOffset += 1;
  };
  const writeLsbBits = (value, count) => {
    for (let bit = 0; bit < count; bit += 1) {
      writeBit((value >>> bit) & 1);
    }
  };
  const writeHuffmanCode = (value, count) => {
    for (let bit = count - 1; bit >= 0; bit -= 1) {
      writeBit((value >>> bit) & 1);
    }
  };

  writeLsbBits(1, 1); // BFINAL
  writeLsbBits(1, 2); // fixed-Huffman BTYPE
  const fixedACode = 0x30 + 65;
  for (let index = 0; index < outputBytes; index += 1) {
    writeHuffmanCode(fixedACode, 8);
  }
  writeHuffmanCode(0, 7); // fixed end-of-block symbol 256

  const trailer = new Uint8Array(8);
  writeUint32LE(trailer, 0, crc32(input));
  writeUint32LE(trailer, 4, outputBytes);
  return concatBytes(
    Uint8Array.of(
      0x1f, 0x8b, 8, 0,
      0, 0, 0, 0,
      0,
      255,
    ),
    deflate.subarray(0, Math.ceil(bitOffset / 8)),
    trailer,
  );
}

function storedThenMaxDistanceGzip(prefixBytes) {
  const storedBlock = new Uint8Array(5 + prefixBytes);
  storedBlock[0] = 0; // non-final stored block plus byte padding
  storedBlock[1] = prefixBytes & 0xff;
  storedBlock[2] = prefixBytes >>> 8;
  const inverseLength = prefixBytes ^ 0xffff;
  storedBlock[3] = inverseLength & 0xff;
  storedBlock[4] = inverseLength >>> 8;
  storedBlock.fill(65, 5);

  const fixedBlock = bitBytes([
    [1, 1], // BFINAL
    [1, 2], // fixed-Huffman BTYPE
    [1, 7, true], // length symbol 257: three bytes
    [29, 5, true], // distance symbol 29
    [8191, 13], // 24,577 + 8,191 = 32,768
    [0, 7, true], // end-of-block symbol 256
  ]);
  const output = new Uint8Array(prefixBytes + 3);
  output.fill(65);
  const trailer = new Uint8Array(8);
  writeUint32LE(trailer, 0, crc32(output));
  writeUint32LE(trailer, 4, output.byteLength);
  return concatBytes(
    Uint8Array.of(
      0x1f, 0x8b, 8, 0,
      0, 0, 0, 0,
      0,
      255,
    ),
    storedBlock,
    fixedBlock,
    trailer,
  );
}

async function expectRejectedBeforeNative(
  compressed,
  maxOutputBytes,
  expectedError,
  signal = null,
) {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'DecompressionStream',
  );
  let nativeConstructions = 0;
  Object.defineProperty(globalThis, 'DecompressionStream', {
    configurable: true,
    writable: true,
    value: class SentinelDecompressionStream {
      constructor() {
        nativeConstructions += 1;
        throw new Error('Sentinel native decompressor was constructed.');
      }
    },
  });

  try {
    await assert.rejects(
      gzipDecompress(compressed, {
        maxOutputBytes,
        signal,
      }),
      expectedError,
    );
    assert.equal(
      nativeConstructions,
      0,
      'preflight rejection must precede native decompressor construction',
    );
  } finally {
    if (originalDescriptor === undefined) {
      delete globalThis.DecompressionStream;
    } else {
      Object.defineProperty(
        globalThis,
        'DecompressionStream',
        originalDescriptor,
      );
    }
  }
}

test('gzip preflight counts stored, fixed, and dynamic DEFLATE exactly', async t => {
  const fixtures = [
    {
      blockType: 0,
      input: encoder.encode('stored block '.repeat(400)),
      options: { level: 0 },
      title: 'stored',
    },
    {
      blockType: 1,
      input: encoder.encode('fixed Huffman backreference '.repeat(400)),
      options: {
        level: 9,
        strategy: constants.Z_FIXED,
      },
      title: 'fixed Huffman',
    },
    {
      blockType: 2,
      input: encoder.encode(
        `${'a'.repeat(10_000)}${'bcdefghijklmnopqrstuvwxyz'.repeat(100)}`,
      ),
      options: { level: 9 },
      title: 'dynamic Huffman',
    },
  ];

  for (const fixture of fixtures) {
    await t.test(fixture.title, async () => {
      const compressed = new Uint8Array(
        gzipSync(fixture.input, fixture.options),
      );
      assert.equal(
        (compressed[10] >>> 1) & 0x03,
        fixture.blockType,
        'fixture must exercise the intended first DEFLATE block type',
      );

      const restored = await gzipDecompress(compressed, {
        maxOutputBytes: fixture.input.byteLength,
        signal: null,
      });
      assert.deepEqual(restored, fixture.input);

      await expectRejectedBeforeNative(
        compressed,
        fixture.input.byteLength - 1,
        /Decompressed data exceeds limit/i,
      );
    });
  }
});

test('gzip preflight parses optional header fields and validates FHCRC', async () => {
  const input = encoder.encode('optional gzip header fields '.repeat(80));
  const compressed = gzipWithEveryHeaderOption(input);
  const restored = await gzipDecompress(compressed, {
    maxOutputBytes: input.byteLength,
    signal: null,
  });
  assert.deepEqual(restored, input);

  const invalidHeaderCrc = compressed.slice();
  invalidHeaderCrc[invalidHeaderCrc.indexOf(0xde)] ^= 0x01;
  await expectRejectedBeforeNative(
    invalidHeaderCrc,
    input.byteLength,
    /FHCRC does not match/i,
  );

  const reservedFlags = compressed.slice();
  reservedFlags[3] |= 0x20;
  await expectRejectedBeforeNative(
    reservedFlags,
    input.byteLength,
    /reserved header flag/i,
  );
});

test('oversized gzip bombs are rejected before native construction', async () => {
  const bombOutputBytes = 128 * 1024;
  const compressed = new Uint8Array(
    gzipSync(new Uint8Array(bombOutputBytes), { level: 9 }),
  );
  assert.ok(
    compressed.byteLength < 1024,
    'fixture must remain a highly compressed expansion bomb',
  );

  await expectRejectedBeforeNative(
    compressed,
    64 * 1024,
    /Decompressed data exceeds limit/i,
  );
});

test('over-declared gzip output is rejected before native construction', async () => {
  const input = encoder.encode('exact manifest length '.repeat(64));
  const compressed = new Uint8Array(gzipSync(input));

  await expectRejectedBeforeNative(
    compressed,
    input.byteLength + 1,
    /output size .* does not match .* exact/i,
  );
});

test('large fixed-literal preflight yields so scheduled abort wins', async () => {
  const outputBytes = 512 * 1024;
  const compressed = largeFixedLiteralGzip(outputBytes);
  assert.equal(
    (compressed[10] >>> 1) & 0x03,
    1,
    'fixture must be one fixed-Huffman block',
  );
  const independentlyDecoded = gunzipSync(compressed);
  assert.equal(independentlyDecoded.byteLength, outputBytes);
  assert.equal(independentlyDecoded[0], 65);
  assert.equal(independentlyDecoded.at(-1), 65);

  const controller = new AbortController();
  let abortFired = false;
  const timer = setTimeout(() => {
    abortFired = true;
    controller.abort();
  }, 0);
  try {
    await expectRejectedBeforeNative(
      compressed,
      outputBytes,
      error => error instanceof DOMException && error.name === 'AbortError',
      controller.signal,
    );
  } finally {
    clearTimeout(timer);
  }
  assert.equal(abortFired, true);
});

test('published-size gzip preflight avoids a cooperative host yield', async () => {
  const input = new Uint8Array(64 * 1024);
  const compressed = new Uint8Array(gzipSync(input, { level: 9 }));
  assert.ok(compressed.byteLength < 32 * 1024);

  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'MessageChannel',
  );
  let yieldChannelConstructions = 0;
  Object.defineProperty(globalThis, 'MessageChannel', {
    configurable: true,
    writable: true,
    value: class UnexpectedYieldChannel {
      constructor() {
        yieldChannelConstructions += 1;
        throw new Error('Published-size preflight unexpectedly yielded.');
      }
    },
  });
  try {
    const restored = await gzipDecompress(compressed, {
      maxOutputBytes: input.byteLength,
      signal: null,
    });
    assert.deepEqual(restored, input);
    assert.equal(yieldChannelConstructions, 0);
  } finally {
    if (originalDescriptor === undefined) {
      delete globalThis.MessageChannel;
    } else {
      Object.defineProperty(
        globalThis,
        'MessageChannel',
        originalDescriptor,
      );
    }
  }
});

test('bounded native collection copies multiple output chunks into one exact allocation', async () => {
  const input = encoder.encode('multi-chunk native output '.repeat(6_000));
  const compressed = new Uint8Array(gzipSync(input, { level: 9 }));
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'DecompressionStream',
  );
  let constructions = 0;
  Object.defineProperty(globalThis, 'DecompressionStream', {
    configurable: true,
    writable: true,
    value: class MultiChunkDecompressionStream {
      constructor(format) {
        assert.equal(format, 'gzip');
        constructions += 1;
        return new TransformStream({
          transform() {
            // The fixture supplies the already-decoded output from flush().
          },
          flush(controller) {
            const firstEnd = Math.floor(input.byteLength / 3);
            const secondEnd = Math.floor(input.byteLength * 2 / 3);
            controller.enqueue(input.subarray(0, firstEnd));
            controller.enqueue(input.subarray(firstEnd, secondEnd));
            controller.enqueue(input.subarray(secondEnd));
          },
        });
      }
    },
  });

  try {
    const restored = await gzipDecompress(compressed, {
      maxOutputBytes: input.byteLength,
      signal: null,
    });
    assert.deepEqual(restored, input);
    assert.equal(constructions, 1);
  } finally {
    if (originalDescriptor === undefined) {
      delete globalThis.DecompressionStream;
    } else {
      Object.defineProperty(
        globalThis,
        'DecompressionStream',
        originalDescriptor,
      );
    }
  }
});

test('gzip preflight rejects trailer mismatch, trailing bytes, and members', async () => {
  const input = encoder.encode('single member '.repeat(100));
  const compressed = new Uint8Array(gzipSync(input));

  const wrongSize = compressed.slice();
  wrongSize[wrongSize.byteLength - 4] ^= 0x01;
  await expectRejectedBeforeNative(
    wrongSize,
    input.byteLength,
    /ISIZE .* does not match/i,
  );

  await expectRejectedBeforeNative(
    concatBytes(compressed, Uint8Array.of(0)),
    input.byteLength,
    /exactly one member with no trailing bytes/i,
  );

  await expectRejectedBeforeNative(
    concatBytes(compressed, compressed),
    input.byteLength * 2,
    /exactly one member with no trailing bytes/i,
  );
});

test('gzip preflight accepts the exact 32,768-byte backreference boundary', async () => {
  const outputBytes = 32_768 + 3;
  const compressed = storedThenMaxDistanceGzip(32_768);
  const independent = gunzipSync(compressed);
  assert.equal(independent.byteLength, outputBytes);

  const restored = await gzipDecompress(compressed, {
    maxOutputBytes: outputBytes,
    signal: null,
  });
  assert.equal(Buffer.compare(restored, independent), 0);
});

test('gzip preflight rejects malformed DEFLATE envelopes before native use', async () => {
  await expectRejectedBeforeNative(
    Uint8Array.of(0x1f, 0x8b, 8),
    0,
    /truncated before its header and trailer/i,
  );

  const completeForTruncation = new Uint8Array(
    gzipSync(encoder.encode('truncated deflate stream')),
  );
  const truncatedDeflate = concatBytes(
    completeForTruncation.subarray(
      0,
      completeForTruncation.byteLength - 9,
    ),
    completeForTruncation.subarray(
      completeForTruncation.byteLength - 8,
    ),
  );
  await expectRejectedBeforeNative(
    truncatedDeflate,
    encoder.encode('truncated deflate stream').byteLength,
    /DEFLATE stream is truncated/i,
  );

  const storedInput = encoder.encode('stored validation '.repeat(20));
  const stored = new Uint8Array(gzipSync(storedInput, { level: 0 }));
  assert.equal((stored[10] >>> 1) & 0x03, 0);
  const invalidStoredLength = stored.slice();
  invalidStoredLength[13] ^= 0x01;
  await expectRejectedBeforeNative(
    invalidStoredLength,
    storedInput.byteLength,
    /stored block LEN\/NLEN do not match/i,
  );

  const reservedBlock = stored.slice();
  reservedBlock[10] = (reservedBlock[10] & ~0x06) | 0x06;
  await expectRejectedBeforeNative(
    reservedBlock,
    storedInput.byteLength,
    /reserved block type 3/i,
  );

  const incompleteCodeLengthTree = gzipEnvelope(bitBytes([
    [1, 1], // BFINAL
    [2, 2], // dynamic Huffman block
    [0, 5], // HLIT = 257
    [0, 5], // HDIST = 1
    [0, 4], // HCLEN = 4
    [0, 3], // symbol 16
    [0, 3], // symbol 17
    [0, 3], // symbol 18
    [1, 3], // symbol 0: the sole one-bit code is incomplete
  ]));
  await expectRejectedBeforeNative(
    incompleteCodeLengthTree,
    0,
    /code-length Huffman tree is incomplete/i,
  );

  const oversubscribedCodeLengthTree = gzipEnvelope(bitBytes([
    [1, 1], // BFINAL
    [2, 2], // dynamic Huffman block
    [0, 5], // HLIT = 257
    [0, 5], // HDIST = 1
    [0, 4], // HCLEN = 4
    [1, 3], // symbol 16
    [1, 3], // symbol 17
    [1, 3], // symbol 18
    [1, 3], // symbol 0: four one-bit codes oversubscribe the tree
  ]));
  await expectRejectedBeforeNative(
    oversubscribedCodeLengthTree,
    0,
    /code-length Huffman tree is oversubscribed/i,
  );

  const reservedHlit = gzipEnvelope(bitBytes([
    [1, 1], // BFINAL
    [2, 2], // dynamic Huffman block
    [30, 5], // HLIT values 30 and 31 are reserved
  ]));
  await expectRejectedBeforeNative(
    reservedHlit,
    0,
    /HLIT 30 exceeds the maximum 29/i,
  );

  const distanceBeforeOutput = gzipEnvelope(bitBytes([
    [1, 1], // BFINAL
    [1, 2], // fixed-Huffman BTYPE
    [1, 7, true], // length symbol 257: three bytes
    [0, 5, true], // distance symbol 0: one byte
  ]));
  await expectRejectedBeforeNative(
    distanceBeforeOutput,
    3,
    /match distance 1 exceeds 0 available output bytes/i,
  );

  await expectRejectedBeforeNative(
    storedThenMaxDistanceGzip(32_767),
    32_770,
    /match distance 32768 exceeds 32767 available output bytes/i,
  );
});
