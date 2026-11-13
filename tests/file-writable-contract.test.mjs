/**
 * A file's writable stream writes exactly what it is given, in every engine
 * (`assets/js/utils/file-writable.js`).
 *
 * WebKit writes the whole buffer under a typed-array view handed to
 * `FileSystemWritableFileStream.write()`, not the view (a 1 MB `subarray`
 * of an 8 MB buffer wrote an 8 MB file); Chromium and Firefox write the
 * view. So:
 *
 * - a view of part of its buffer is handed over as a Blob of its bytes; an
 *   array that is its whole buffer, a Blob, an `ArrayBuffer` and text as
 *   they are;
 * - every writable stream of the app is opened through that module: no
 *   other module calls `createWritable`;
 * - with a storage whose streams write whole buffers, as WebKit's, a file
 *   downloaded whole is kept exactly from pieces that are views of larger
 *   buffers, with its checksums and manifest, and found again.
 *
 * In the engines themselves: `tests/browser/file-writable.spec.mjs`.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { exactChunk, openFileWritable } from '../assets/js/utils/file-writable.js';
import { TRANSCODED_DIRECTORY, findKeptDownload, keepDownload } from '../assets/js/data/anndata/transcode/space.js';
import { pageChecksumsOf } from '../assets/js/formats/io/page-checks.js';
import { createLocks, opfsOnDisk } from './helpers/opfs-on-disk.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const bytesOf = async chunk => new Uint8Array(chunk instanceof Blob ? await chunk.arrayBuffer() : ArrayBuffer.isView(chunk) ? chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) : chunk);

test('a view of part of its buffer is handed over as a Blob of its bytes; anything written exactly everywhere as it is', async () => {
  const buffer = Uint8Array.from({ length: 64 }, (_, i) => i);
  // Views of part of a buffer: the start, the middle, the end, none of it.
  for (const view of [buffer.subarray(0, 10), buffer.subarray(20, 30), buffer.subarray(60), buffer.subarray(7, 7), new DataView(buffer.buffer, 8, 16), new Float32Array(buffer.buffer, 4, 3)]) {
    const chunk = exactChunk(view);
    assert.ok(chunk instanceof Blob, 'a Blob');
    assert.equal(chunk.size, view.byteLength);
    assert.deepEqual(await bytesOf(chunk), new Uint8Array(buffer.buffer, view.byteOffset, view.byteLength));
  }
  // The whole of its buffer: itself (nothing is copied).
  for (const whole of [buffer, new DataView(buffer.buffer), new Float64Array(8), new Uint8Array(0)]) assert.equal(exactChunk(whole), whole);
  const blob = new Blob(['abc']);
  assert.equal(exactChunk(blob), blob);
  assert.equal(exactChunk(buffer.buffer), buffer.buffer);
  assert.equal(exactChunk('text'), 'text');
});

test('a stream opened through it writes each write exactly, on an engine that writes the whole buffer under a view', async () => {
  const written = [];
  const calls = [];
  // WebKit's stream, in effect: a view is written as its whole buffer.
  const handle = {
    createWritable: async () => ({
      write: async data => { written.push(ArrayBuffer.isView(data) ? new Uint8Array(data.buffer.slice(0)) : await bytesOf(data)); },
      close: async () => { calls.push('close'); },
      abort: async reason => { calls.push(['abort', reason]); },
    }),
  };
  const large = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
  const writable = await openFileWritable(handle);
  await writable.write(large.subarray(100, 200));
  await writable.write(large.slice(300, 400));
  await writable.write(new Blob([large.subarray(0, 5)]));
  assert.deepEqual(written.map(piece => piece.length), [100, 100, 5]);
  assert.deepEqual(written[0], large.slice(100, 200));
  assert.deepEqual(written[1], large.slice(300, 400));
  await writable.close();
  await writable.abort('why');
  assert.deepEqual(calls, ['close', ['abort', 'why']]);
});

test('every writable stream of the app is opened through utils/file-writable.js: no other module calls createWritable', () => {
  const callers = [];
  const walk = folder => {
    for (const entry of readdirSync(path.join(ROOT, folder), { withFileTypes: true })) {
      const file = `${folder}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      // A call, not a test of whether a handle has the method (`typeof handle.createWritable`).
      else if (entry.name.endsWith('.js') && /\.createWritable\s*\??\.?\s*\(/.test(readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''))) callers.push(file);
    }
  };
  walk('assets/js');
  assert.deepEqual(callers, ['assets/js/utils/file-writable.js'],
    'Open a file\'s writable stream with openFileWritable (assets/js/utils/file-writable.js): WebKit writes the whole buffer under a view handed to a stream\'s write().');
  // The writers that are there use it.
  for (const file of ['assets/js/data/anndata/transcode/space.js', 'assets/js/app/exports/cell-exports.js', 'assets/js/app/history/anndata-copy-save.js']) {
    assert.match(readFileSync(path.join(ROOT, file), 'utf8'), /\bopenFileWritable\(handle\)/, file);
  }
});

test('a page whose streams write whole buffers keeps a download exactly from pieces that are views of larger buffers, and finds it again', async t => {
  const disk = opfsOnDisk({ handles: 'page', wholeBufferWrites: true });
  t.after(disk.cleanup);
  const bytes = Uint8Array.from({ length: 150_000 }, (_, i) => (i * 37 + 11) % 256);
  // Pieces as a decompressor or a response body hands them: each a view of a larger buffer.
  async function* pieces() {
    for (let at = 0; at < bytes.length; at += 40_000) {
      const buffer = new Uint8Array(100_000).fill(0xee);
      const piece = bytes.subarray(at, Math.min(bytes.length, at + 40_000));
      buffer.set(piece, 1000);
      yield buffer.subarray(1000, 1000 + piece.length);
    }
  }
  const identity = Object.freeze({ kind: 'remote', key: 'example:views.h5ad', version: '"etag-1"' });
  const kept = await keepDownload(identity, pieces(), { name: 'views.h5ad', size: bytes.length, environment: disk.environment });
  assert.equal(kept.kept, 'opfs');
  assert.equal(kept.file.size, bytes.length, 'the file holds the pieces\' bytes, not their buffers\'');
  assert.deepEqual(new Uint8Array(await kept.file.arrayBuffer()), bytes);
  assert.deepEqual(kept.checks.sums, pageChecksumsOf(bytes));
  // Its small files too (the manifest, the checksum table, the last-used time), written by the same streams.
  const folder = path.join(disk.root, TRANSCODED_DIRECTORY, kept.checks.directory);
  const manifest = JSON.parse(readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.blobs, { source: bytes.length });
  assert.equal(readFileSync(path.join(folder, 'source.sums')).length, 4 * kept.checks.sums.length);
  assert.ok(Number(readFileSync(path.join(folder, 'used'), 'utf8')) > 0);
  // A later visit finds it and reads it through its checksums.
  disk.environment.navigator.locks = createLocks();
  const found = await findKeptDownload(identity, 'views.h5ad', disk.environment);
  assert.deepEqual(new Uint8Array(await found.file.arrayBuffer()), bytes);
  assert.deepEqual(found.checks.sums, kept.checks.sums);
});
