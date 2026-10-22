import assert from 'node:assert/strict';
import test from 'node:test';

import { readBoundedBody } from '../assets/js/data/data-source.js';

/**
 * `readBoundedBody()` owns every prepared-payload transfer. Whatever ends a
 * read early must cancel the body so the network transfer stops, and a
 * declared size must land the body in one buffer of exactly that size.
 */
function pulledResponse(chunks, record) {
  let index = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (index === chunks.length) {
        controller.close();
        return;
      }
      record.pulled += 1;
      controller.enqueue(chunks[index]);
      index += 1;
    },
    cancel(reason) {
      record.cancelled += 1;
      record.reason = reason;
    },
  }, { highWaterMark: 0 }));
}

function chunksOf(count, size) {
  return Array.from({ length: count }, (_, index) => {
    const chunk = new Uint8Array(size);
    chunk.fill(index + 1);
    return chunk;
  });
}

test('a throwing progress callback cancels the body', async () => {
  const record = { pulled: 0, cancelled: 0, reason: null };
  const failure = new Error('progress sink failed');
  await assert.rejects(
    readBoundedBody(pulledResponse(chunksOf(8, 16), record), {
      label: 'Payload points.bin',
      maxBytes: 1024,
      onProgress() {
        throw failure;
      },
    }),
    failure,
  );
  assert.equal(record.cancelled, 1);
  assert.equal(record.reason, failure);
  assert.equal(record.pulled, 1);
});

test('an abort between chunks cancels the body', async () => {
  const record = { pulled: 0, cancelled: 0, reason: null };
  const controller = new AbortController();
  await assert.rejects(
    readBoundedBody(pulledResponse(chunksOf(8, 16), record), {
      label: 'Payload points.bin',
      maxBytes: 1024,
      signal: controller.signal,
      onProgress(loadedBytes) {
        if (loadedBytes === 32) controller.abort();
      },
    }),
    error => error?.name === 'AbortError',
  );
  assert.equal(record.cancelled, 1);
  assert.ok(record.pulled <= 3, `pulled ${record.pulled} chunks after abort`);
});

test('a ceiling overrun cancels the body', async () => {
  const record = { pulled: 0, cancelled: 0, reason: null };
  await assert.rejects(
    readBoundedBody(pulledResponse(chunksOf(8, 16), record), {
      label: 'Payload points.bin',
      maxBytes: 40,
    }),
    /transfer of at least 48 bytes exceeds its 40-byte ceiling/,
  );
  assert.equal(record.cancelled, 1);
  assert.equal(record.pulled, 3);
});

test('a declared size lands the body in one exact buffer', async () => {
  const chunks = chunksOf(5, 16);
  const record = { pulled: 0, cancelled: 0, reason: null };
  const progress = [];
  const bytes = await readBoundedBody(pulledResponse(chunks, record), {
    label: 'Payload points.bin',
    maxBytes: 1024,
    totalBytes: 80,
    onProgress: (loaded, total) => progress.push([loaded, total]),
  });
  assert.equal(bytes.byteLength, 80);
  assert.equal(bytes.byteOffset, 0);
  assert.equal(bytes.buffer.byteLength, 80);
  for (const [index, chunk] of chunks.entries()) {
    assert.ok(
      bytes.buffer !== chunk.buffer,
      'the body must be copied into its own preallocated buffer',
    );
    assert.deepEqual(bytes.subarray(index * 16, (index + 1) * 16), chunk);
  }
  assert.deepEqual(progress.at(-1), [80, 80]);
  assert.equal(record.cancelled, 0);
});

test('a body that over- or under-runs its declared size is still read exactly', async () => {
  const chunks = chunksOf(5, 16);
  const expected = new Uint8Array(80);
  chunks.forEach((chunk, index) => expected.set(chunk, index * 16));
  for (const totalBytes of [24, 79, 81, 500, null]) {
    const record = { pulled: 0, cancelled: 0, reason: null };
    const bytes = await readBoundedBody(pulledResponse(chunks, record), {
      label: 'Payload points.bin',
      maxBytes: 1024,
      totalBytes,
    });
    assert.deepEqual(bytes, expected, `declared ${totalBytes}`);
    assert.equal(bytes.buffer.byteLength, 80, `declared ${totalBytes}`);
  }
});
