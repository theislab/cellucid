// Remote binary and metadata payloads must be bounded while they stream.
//
// A dataset opened from someone else's GitHub repository is untrusted input.
// A small `.bin.gz` can declare — or simply produce — gigabytes of output, so
// no remote payload may be materialized before its size has been checked
// against the manifest-declared length and the browser byte ceiling.

import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import { loadPointsBinary } from '../assets/js/data/data-loaders.js';
import {
  MAX_METADATA_JSON_BYTES,
  MAX_PREPARED_BROWSER_BYTES,
  fetchJson,
} from '../assets/js/data/data-source.js';

function installFetch(t, handler) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  });
}

function chunkedResponse(bytes, chunkSize, counter) {
  const body = new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
      }
      controller.close();
    },
    pull() {
      if (counter) counter.pulls++;
    },
    cancel() {
      if (counter) counter.cancelled = true;
    },
  });
  return new Response(body, { status: 200 });
}

test('browser byte ceilings are shared with the prepared local-directory path', () => {
  assert.equal(MAX_PREPARED_BROWSER_BYTES, 512 * 1024 * 1024);
  assert.equal(MAX_METADATA_JSON_BYTES, 64 * 1024 * 1024);
});

test('a gzip payload larger than the declared length is refused mid-stream', async t => {
  // ~4 MiB of zeros compresses to a few kilobytes: the classic decompression
  // bomb shape. The manifest declares two float32 positions (8 bytes).
  const bomb = gzipSync(new Uint8Array(4 * 1024 * 1024));
  const counter = { pulls: 0, cancelled: false };
  installFetch(t, async () => chunkedResponse(bomb, 512, counter));

  await assert.rejects(
    loadPointsBinary('https://untrusted.test/data/points_2d.bin.gz', {
      expectedBytes: 8,
    }),
    error => {
      assert.match(error.message, /exceeds/i);
      return true;
    }
  );
  assert.ok(
    counter.cancelled,
    'the response stream must be cancelled instead of read to completion'
  );
  assert.ok(
    counter.pulls * 512 < bomb.byteLength,
    `the reader must stop early; pulled ${counter.pulls * 512} of ${bomb.byteLength} bytes`
  );
});

test('a gzip trailer declaring more than the browser ceiling is refused before inflating', async t => {
  const payload = gzipSync(new Uint8Array(64));
  const forged = Uint8Array.from(payload);
  // Rewrite the little-endian ISIZE trailer to ~4 GiB.
  forged[forged.length - 4] = 0xff;
  forged[forged.length - 3] = 0xff;
  forged[forged.length - 2] = 0xff;
  forged[forged.length - 1] = 0xff;

  installFetch(t, async () => new Response(forged, { status: 200 }));

  await assert.rejects(
    loadPointsBinary('https://untrusted.test/data/points_2d.bin.gz', {
      expectedBytes: null,
    }),
    /declares 4294967295 bytes|exceeds/i
  );
});

test('a gzip payload whose trailer disagrees with the manifest is refused', async t => {
  const payload = gzipSync(new Uint8Array(64));
  installFetch(t, async () => new Response(payload, { status: 200 }));

  await assert.rejects(
    loadPointsBinary('https://untrusted.test/data/points_2d.bin.gz', {
      expectedBytes: 8,
    }),
    /expected 8 bytes|exceeds/i
  );
});

test('an uncompressed payload longer than the declared length is refused mid-stream', async t => {
  const oversized = new Uint8Array(64 * 1024);
  const counter = { pulls: 0, cancelled: false };
  installFetch(t, async () => chunkedResponse(oversized, 512, counter));

  await assert.rejects(
    loadPointsBinary('https://untrusted.test/data/points_2d.bin', {
      expectedBytes: 8,
    }),
    /exceeds/i
  );
  assert.ok(
    counter.cancelled,
    'the response stream must be cancelled instead of read to completion'
  );
});

test('an uncompressed payload shorter than the declared length is refused', async t => {
  installFetch(t, async () => new Response(
    Float32Array.of(1).buffer,
    { status: 200 }
  ));

  await assert.rejects(
    loadPointsBinary('https://untrusted.test/data/points_2d.bin', {
      expectedBytes: 8,
    }),
    /expected exactly 8 bytes/i
  );
});

test('an exactly declared payload still loads, compressed or not', async t => {
  const positions = Float32Array.of(1, 2, 3, 4);
  const raw = new Uint8Array(positions.buffer);

  installFetch(t, async url => new Response(
    String(url).endsWith('.gz') ? gzipSync(raw) : raw,
    { status: 200 }
  ));

  assert.deepEqual(
    Array.from(await loadPointsBinary(
      'https://trusted.test/data/points_2d.bin',
      { expectedBytes: 16 }
    )),
    [1, 2, 3, 4]
  );
  assert.deepEqual(
    Array.from(await loadPointsBinary(
      'https://trusted.test/data/points_2d.bin.gz',
      { expectedBytes: 16 }
    )),
    [1, 2, 3, 4]
  );
});

test('a declared length beyond the browser ceiling is refused before fetching', async t => {
  let fetchCalls = 0;
  installFetch(t, async () => {
    fetchCalls++;
    return new Response(new Uint8Array(4), { status: 200 });
  });

  await assert.rejects(
    loadPointsBinary('https://untrusted.test/data/points_2d.bin', {
      expectedBytes: MAX_PREPARED_BROWSER_BYTES + 4,
    }),
    /512 MiB|exceeds/i
  );
  assert.equal(fetchCalls, 0, 'an over-budget payload must never be requested');
});

test('loadPointsBinary requires an explicit declared length', async t => {
  installFetch(t, async () => new Response(
    Float32Array.of(1, 2).buffer,
    { status: 200 }
  ));

  await assert.rejects(
    loadPointsBinary('https://untrusted.test/data/points_2d.bin', {}),
    /expectedBytes/i
  );
});

test('metadata JSON is bounded while it streams', async t => {
  const megabyte = new Uint8Array(1024 * 1024).fill(0x20);
  const chunks = MAX_METADATA_JSON_BYTES / megabyte.byteLength + 4;
  const counter = { cancelled: false };

  installFetch(t, async () => new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(Uint8Array.of(0x22));
        for (let index = 0; index < chunks; index++) {
          controller.enqueue(megabyte);
        }
        controller.enqueue(Uint8Array.of(0x22));
        controller.close();
      },
      cancel() {
        counter.cancelled = true;
      },
    }),
    { status: 200 }
  ));

  await assert.rejects(
    fetchJson('https://untrusted.test/data/dataset_identity.json', 'github'),
    /exceeds/i
  );
  assert.ok(
    counter.cancelled,
    'an oversized metadata body must be cancelled, not buffered'
  );
});
