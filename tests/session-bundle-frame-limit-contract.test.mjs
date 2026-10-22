/**
 * A session bundle's only size limit is its u32 frame: there is no fixed cap
 * on the manifest or a chunk below it, and a length that claims more bytes
 * than the file holds is refused before anything is allocated for it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_FRAME_BYTES,
  SESSION_BUNDLE_MAGIC_BYTES,
  u32ToBytesLE,
} from '../assets/js/app/session/bundle/format.js';
import { readBundle } from '../assets/js/app/session/bundle/reader.js';

test('the frame length is the format limit', () => {
  assert.equal(MAX_FRAME_BYTES, 0xffff_ffff);
  assert.throws(() => u32ToBytesLE(MAX_FRAME_BYTES + 1), /unsigned 32-bit/);
});

test('a manifest length past the end of the file is refused as truncated', async () => {
  // 64 MiB declared (above the former 16 MiB cap) in a file of a few bytes.
  const bytes = new Uint8Array([
    ...SESSION_BUNDLE_MAGIC_BYTES,
    ...u32ToBytesLE(64 * 1024 * 1024),
    0x7b,
  ]);
  await assert.rejects(
    readBundle(new Blob([bytes]), { signal: null, onProgress: null }),
    /more than the session file holds/
  );
});

test('a manifest above the former 16 MiB cap is read', async () => {
  const manifest = {
    createdAt: '2026-01-01T00:00:00.000Z',
    padding: 'x'.repeat(17 * 1024 * 1024),
    chunks: [],
  };
  const json = new TextEncoder().encode(JSON.stringify(manifest));
  const bytes = new Uint8Array([...SESSION_BUNDLE_MAGIC_BYTES, ...u32ToBytesLE(json.byteLength)]);
  const { manifest: read } = await readBundle(new Blob([bytes, json]), {
    signal: null,
    onProgress: null,
  });
  assert.equal(read.padding.length, 17 * 1024 * 1024);
});
