/**
 * The Zarr codecs on their own: Zstandard decodes whatever a reference
 * encoder writes (Node's zstd, every level, many shapes of data), and every
 * decoder refuses damaged input with a ZarrFormatError instead of returning
 * wrong bytes, reading out of bounds or hanging.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { constants, zstdCompressSync } from 'node:zlib';

import { ZarrFormatError } from '../assets/js/formats/zarr/errors.js';
import { zstdDecompress } from '../assets/js/formats/zarr/codecs/zstd.js';
import { lz4DecodeBlockInto, numcodecsLz4Decode } from '../assets/js/formats/zarr/codecs/lz4.js';
import { bloscDecode } from '../assets/js/formats/zarr/codecs/blosc.js';
import { crc32c, crc32cDecode } from '../assets/js/formats/zarr/codecs/crc32c.js';
import { vlenDecode } from '../assets/js/formats/zarr/codecs/vlen.js';

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Data of several characters: runs, small alphabets, numbers, noise. */
function samples() {
  const next = random(11);
  const out = [];
  out.push(new Uint8Array(0), Uint8Array.of(7), new Uint8Array(300_000));
  out.push(new Uint8Array(new Int32Array(Array.from({ length: 70_000 }, (_, i) => i)).buffer));
  out.push(new Uint8Array(new Float32Array(Array.from({ length: 40_000 }, () => Math.round(next() * 100) / 4)).buffer));
  out.push(Uint8Array.from({ length: 200_001 }, () => Math.floor(next() * 7)));
  out.push(Uint8Array.from({ length: 50_000 }, () => Math.floor(next() * 256)));
  const words = ['T cell', 'B cell', 'monocyte', 'NK', 'cell_', 'ENSG000'];
  out.push(new TextEncoder().encode(Array.from({ length: 20_000 }, (_, i) => `${words[i % 6]}${i % 977}`).join('\n')));
  return out;
}

test('Zstandard: every frame Node writes, at every level, decodes exactly', () => {
  let frames = 0;
  for (const data of samples()) {
    for (const level of [-7, 1, 3, 6, 12, 19, 22]) {
      const frame = new Uint8Array(zstdCompressSync(data, { params: { [constants.ZSTD_c_compressionLevel]: level } }));
      assert.deepEqual(zstdDecompress(frame, data.length), data);
      assert.deepEqual(zstdDecompress(frame, null), data);
      frames++;
    }
  }
  assert.equal(frames, 56);
});

test('Zstandard: frames with checksums, without content size, and several frames in a row', () => {
  const data = new TextEncoder().encode('abcabcabc'.repeat(5000));
  const checked = new Uint8Array(zstdCompressSync(data, { params: { [constants.ZSTD_c_checksumFlag]: 1 } }));
  assert.deepEqual(zstdDecompress(checked, data.length), data);
  const unsized = new Uint8Array(zstdCompressSync(data, { params: { [constants.ZSTD_c_contentSizeFlag]: 0 } }));
  assert.deepEqual(zstdDecompress(unsized, null), data);
  const two = new Uint8Array([...checked, ...unsized]);
  const both = zstdDecompress(two, data.length * 2);
  assert.deepEqual(both.subarray(data.length), data);
  // A skippable frame is skipped.
  const skippable = Uint8Array.of(0x50, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 1, 2, 3);
  assert.deepEqual(zstdDecompress(new Uint8Array([...skippable, ...checked]), data.length), data);
});

test('Zstandard: damaged frames are refused, never decoded short, long or out of bounds', () => {
  const data = new Uint8Array(new Int32Array(Array.from({ length: 20_000 }, (_, i) => (i * 37) % 1000)).buffer);
  const frame = new Uint8Array(zstdCompressSync(data));
  assert.throws(() => zstdDecompress(frame, data.length + 1), ZarrFormatError);
  assert.throws(() => zstdDecompress(frame, data.length - 1), ZarrFormatError);
  assert.throws(() => zstdDecompress(frame.subarray(0, frame.length - 5), data.length), ZarrFormatError);
  assert.throws(() => zstdDecompress(Uint8Array.of(1, 2, 3, 4, 5), null), /does not start with a Zstandard frame/);
  // Flip bytes all over the frame: each result is an error or, rarely, other
  // bytes of exactly the expected size; never a crash.
  const next = random(3);
  let refused = 0;
  for (let trial = 0; trial < 300; trial++) {
    const damaged = frame.slice();
    const at = 6 + Math.floor(next() * (damaged.length - 6));
    damaged[at] ^= 1 + Math.floor(next() * 255);
    try {
      const out = zstdDecompress(damaged, data.length);
      assert.equal(out.length, data.length);
    } catch (error) {
      assert.ok(error instanceof ZarrFormatError || error.name === 'ZarrUnsupportedError', String(error));
      refused++;
    }
  }
  assert.ok(refused > 150, `${refused} of 300 damaged frames refused`);
});

test('LZ4: a block must end with literals and stay inside its buffers', () => {
  assert.throws(() => lz4DecodeBlockInto(Uint8Array.of(0x10, 0x41, 0x01, 0x00), new Uint8Array(5)), /final literals/);
  assert.throws(() => lz4DecodeBlockInto(Uint8Array.of(0x1f, 0x41, 0x05, 0x00, 0x00), new Uint8Array(30)), /before the output/);
  assert.throws(() => lz4DecodeBlockInto(Uint8Array.of(0x50, 0x41, 0x42), new Uint8Array(5)), /literal run exceeds/);
  // An overlapping match (a run) followed by final literals.
  const out = new Uint8Array(9);
  lz4DecodeBlockInto(Uint8Array.of(0x13, 0x61, 0x01, 0x00, 0x10, 0x62), out);
  assert.equal(new TextDecoder().decode(out), 'aaaaaaaab');
  assert.throws(() => numcodecsLz4Decode(Uint8Array.of(100, 0, 0, 0, 0x10, 0x61), 1), /declares 100 bytes/);
});

test('Blosc: headers that contradict the frame are refused', async () => {
  // A frame header claiming more than the frame holds.
  const header = new Uint8Array(16);
  const view = new DataView(header.buffer);
  header[0] = 2;
  header[1] = 1;
  header[2] = 0x02;
  header[3] = 4;
  view.setUint32(4, 8, true);
  view.setUint32(8, 8, true);
  view.setUint32(12, 24, true);
  await assert.rejects(bloscDecode(header, 8), /declares 24 bytes and holds 16/);
  view.setUint32(12, 16, true);
  view.setUint32(4, 0, true);
  await assert.rejects(bloscDecode(header, 8), /decodes to 0 bytes, not the 8/);
  header[0] = 3;
  await assert.rejects(bloscDecode(header, null), error => error.name === 'ZarrUnsupportedError');
});

test('CRC-32C matches its reference value, and a damaged chunk is refused', () => {
  const text = new TextEncoder().encode('123456789');
  assert.equal(crc32c(text), 0xe3069283);
  const framed = new Uint8Array([...text, 0x83, 0x92, 0x06, 0xe3]);
  assert.deepEqual(crc32cDecode(framed), text);
  framed[0] ^= 1;
  assert.throws(() => crc32cDecode(framed), /CRC-32C/);
});

test('variable-length strings must hold exactly the declared items', () => {
  const encode = values => {
    const parts = values.map(value => new TextEncoder().encode(value));
    const out = new Uint8Array(4 + parts.reduce((sum, part) => sum + 4 + part.length, 0));
    const view = new DataView(out.buffer);
    view.setUint32(0, values.length, true);
    let at = 4;
    for (const part of parts) {
      view.setUint32(at, part.length, true);
      out.set(part, at + 4);
      at += 4 + part.length;
    }
    return out;
  };
  assert.deepEqual(vlenDecode(encode(['a', '', 'üñí', 'x'.repeat(100)]), 4, 'x'), ['a', '', 'üñí', 'x'.repeat(100)]);
  assert.throws(() => vlenDecode(encode(['a']), 2, 'x'), /holds 1 strings, not the 2/);
  const bad = encode(['ab']);
  bad[8] = 0xff;
  assert.throws(() => vlenDecode(bad, 1, 'x'), /not valid UTF-8/);
  const truncated = encode(['abc']).subarray(0, 9);
  assert.throws(() => vlenDecode(truncated, 1, 'x'), /truncated/);
});
