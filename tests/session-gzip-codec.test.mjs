import assert from 'node:assert/strict';
import test from 'node:test';
import { constants, gunzipSync, gzipSync } from 'node:zlib';

import { gzipDecompress } from '../assets/js/app/session/codecs/gzip.js';
import {
  NATIVE_INFLATE_INPUT_SLICE_BYTES,
  createSlicedInputStream,
} from '../assets/js/formats/io/inflate.js';

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

function writeUint32LE(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = value >>> 24;
}

function withIsize(compressed, outputBytes) {
  const forged = compressed.slice();
  writeUint32LE(forged, forged.byteLength - 4, outputBytes);
  return forged;
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
    Uint8Array.of(0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255),
    storedBlock,
    fixedBlock,
    trailer,
  );
}

/**
 * Replace the global native decompressor for one call. `factory` receives the
 * real constructor and returns the stream the codec pipes through.
 */
async function withDecompressionStream(factory, run) {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'DecompressionStream',
  );
  const Native = globalThis.DecompressionStream;
  Object.defineProperty(globalThis, 'DecompressionStream', {
    configurable: true,
    writable: true,
    value: class InstrumentedDecompressionStream {
      constructor(format) {
        return factory(Native, format);
      }
    },
  });
  try {
    return await run();
  } finally {
    Object.defineProperty(
      globalThis,
      'DecompressionStream',
      originalDescriptor,
    );
  }
}

async function expectRejectedBeforeNative(compressed, maxOutputBytes, expected) {
  let constructions = 0;
  await withDecompressionStream(() => {
    constructions += 1;
    throw new Error('Sentinel native decompressor was constructed.');
  }, () => assert.rejects(
    gzipDecompress(compressed, { maxOutputBytes, signal: null }),
    expected,
  ));
  assert.equal(
    constructions,
    0,
    'envelope rejection must precede native decompressor construction',
  );
}

const MALFORMED_MEMBER = /Gzip input is not exactly one well-formed member/;

test('gzip decode restores stored, fixed, and dynamic DEFLATE exactly', async t => {
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
      options: { level: 9, strategy: constants.Z_FIXED },
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
        /ISIZE \d+ does not match the exact \d+-byte contract/,
      );
    });
  }
});

test('gzip decode leaves DEFLATE decoding to the single native inflate', async () => {
  // A valid envelope around bytes that are not DEFLATE at all: only the native
  // decoder may judge them, so the codec must hand them over undecoded and
  // inflate exactly once.
  const output = encoder.encode('decoded by the native stream only');
  const body = new Uint8Array(3 * NATIVE_INFLATE_INPUT_SLICE_BYTES + 7);
  body.fill(0xff);
  const trailer = new Uint8Array(8);
  writeUint32LE(trailer, 4, output.byteLength);
  const compressed = concatBytes(
    Uint8Array.of(0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255),
    body,
    trailer,
  );
  let constructions = 0;
  const written = [];
  const restored = await withDecompressionStream(() => {
    constructions += 1;
    return new TransformStream({
      transform(chunk) {
        written.push(chunk.byteLength);
      },
      flush(controller) {
        controller.enqueue(output);
      },
    });
  }, () => gzipDecompress(compressed, {
    maxOutputBytes: output.byteLength,
    signal: null,
  }));
  assert.deepEqual(restored, output);
  assert.equal(constructions, 1);
  assert.equal(
    written.reduce((sum, bytes) => sum + bytes, 0),
    compressed.byteLength,
  );
  assert.ok(written.every(bytes => bytes <= NATIVE_INFLATE_INPUT_SLICE_BYTES));
});

test('gzip decode accepts optional header fields and rejects a bad FHCRC', async () => {
  const input = encoder.encode('optional gzip header fields '.repeat(80));
  const compressed = gzipWithEveryHeaderOption(input);
  const restored = await gzipDecompress(compressed, {
    maxOutputBytes: input.byteLength,
    signal: null,
  });
  assert.deepEqual(restored, input);

  const invalidHeaderCrc = compressed.slice();
  invalidHeaderCrc[invalidHeaderCrc.indexOf(0xde)] ^= 0x01;
  await assert.rejects(
    gzipDecompress(invalidHeaderCrc, {
      maxOutputBytes: input.byteLength,
      signal: null,
    }),
    MALFORMED_MEMBER,
  );

  const reservedFlags = compressed.slice();
  reservedFlags[3] |= 0x20;
  await expectRejectedBeforeNative(
    reservedFlags,
    input.byteLength,
    /reserved header flag/i,
  );
});

test('honest oversized gzip bombs are rejected before native construction', async () => {
  const compressed = new Uint8Array(
    gzipSync(new Uint8Array(128 * 1024), { level: 9 }),
  );
  assert.ok(compressed.byteLength < 1024);
  await expectRejectedBeforeNative(
    compressed,
    64 * 1024,
    /ISIZE 131072 does not match the exact 65536-byte contract/,
  );
});

test('over-declared gzip output is rejected before native construction', async () => {
  const input = encoder.encode('exact manifest length '.repeat(64));
  const compressed = new Uint8Array(gzipSync(input));
  await expectRejectedBeforeNative(
    compressed,
    input.byteLength + 1,
    /ISIZE \d+ does not match the exact \d+-byte contract/,
  );
});

test('a forged ISIZE cannot pass an under- or over-producing member', async () => {
  const input = encoder.encode('forged trailer '.repeat(200));
  const compressed = new Uint8Array(gzipSync(input));
  for (const declared of [input.byteLength - 1, input.byteLength + 1]) {
    await assert.rejects(
      gzipDecompress(withIsize(compressed, declared), {
        maxOutputBytes: declared,
        signal: null,
      }),
      /Decompressed data (exceeds limit|produced \d+ bytes; expected exactly)|not exactly one well-formed member/,
    );
  }
});

test('bounded native collection copies multiple output chunks into one exact allocation', async () => {
  const input = encoder.encode('multi-chunk native output '.repeat(6_000));
  const compressed = new Uint8Array(gzipSync(input, { level: 9 }));
  let constructions = 0;
  const restored = await withDecompressionStream((Native, format) => {
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
  }, () => gzipDecompress(compressed, {
    maxOutputBytes: input.byteLength,
    signal: null,
  }));
  assert.deepEqual(restored, input);
  assert.equal(constructions, 1);
});

test('gzip decode accepts the exact 32,768-byte backreference boundary', async () => {
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

test('gzip decode rejects malformed DEFLATE streams', async () => {
  await expectRejectedBeforeNative(
    Uint8Array.of(0x1f, 0x8b, 8),
    0,
    /truncated before its header and trailer/i,
  );
  await expectRejectedBeforeNative(
    concatBytes(Uint8Array.of(0x1f, 0x8c, 8, 0), new Uint8Array(14)),
    0,
    /invalid magic number/i,
  );
  await expectRejectedBeforeNative(
    concatBytes(Uint8Array.of(0x1f, 0x8b, 7, 0), new Uint8Array(14)),
    0,
    /unsupported compression method 7/i,
  );

  const truncatedSource = encoder.encode('truncated deflate stream');
  const complete = new Uint8Array(gzipSync(truncatedSource));
  const truncatedDeflate = concatBytes(
    complete.subarray(0, complete.byteLength - 9),
    complete.subarray(complete.byteLength - 8),
  );
  await assert.rejects(
    gzipDecompress(truncatedDeflate, {
      maxOutputBytes: truncatedSource.byteLength,
      signal: null,
    }),
    MALFORMED_MEMBER,
  );

  const storedInput = encoder.encode('stored validation '.repeat(20));
  const stored = new Uint8Array(gzipSync(storedInput, { level: 0 }));
  const invalidStoredLength = stored.slice();
  invalidStoredLength[13] ^= 0x01;
  const reservedBlock = stored.slice();
  reservedBlock[10] = (reservedBlock[10] & ~0x06) | 0x06;
  for (const malformed of [invalidStoredLength, reservedBlock]) {
    await assert.rejects(
      gzipDecompress(malformed, {
        maxOutputBytes: storedInput.byteLength,
        signal: null,
      }),
      MALFORMED_MEMBER,
    );
  }

  const distanceBeforeOutput = withIsize(
    storedThenMaxDistanceGzip(32_767),
    32_770,
  );
  await assert.rejects(
    gzipDecompress(distanceBeforeOutput, {
      maxOutputBytes: 32_770,
      signal: null,
    }),
    MALFORMED_MEMBER,
  );
});

test('sliced input streams every part in bounded slices and in order', async () => {
  const first = new Uint8Array(NATIVE_INFLATE_INPUT_SLICE_BYTES * 2 + 5);
  first.fill(1);
  const second = Uint8Array.of(2, 3);
  const reader = createSlicedInputStream([first, new Uint8Array(0), second])
    .getReader();
  const slices = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    slices.push(value);
  }
  assert.deepEqual(
    slices.map(slice => slice.byteLength),
    [
      NATIVE_INFLATE_INPUT_SLICE_BYTES,
      NATIVE_INFLATE_INPUT_SLICE_BYTES,
      5,
      2,
    ],
  );
  assert.deepEqual(concatBytes(...slices), concatBytes(first, second));
  assert.throws(
    () => createSlicedInputStream([new ArrayBuffer(1)]),
    /Uint8Array parts/,
  );
});
