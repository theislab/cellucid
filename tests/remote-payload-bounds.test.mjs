// Remote binary and metadata payloads must be bounded while they stream.
//
// A dataset opened from someone else's GitHub repository is untrusted input.
// A small `.bin.gz` can declare — or simply produce — gigabytes of output, so
// no remote payload may be materialized beyond its manifest-declared length
// or, undeclared, its gzip trailer. There is no fixed size ceiling: a payload
// as large as the browser can allocate loads, and one it cannot is a size
// refusal (DataSourceErrorCode.TOO_LARGE).

import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import { loadPointsBinary } from '../assets/js/data/data-loaders.js';
import * as dataSource from '../assets/js/data/data-source.js';

const { DataSourceErrorCode, fetchJson } = dataSource;

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

test('neither binary payloads nor metadata JSON have a fixed ceiling', () => {
  assert.equal('MAX_PREPARED_BROWSER_BYTES' in dataSource, false);
  assert.equal('MAX_METADATA_JSON_BYTES' in dataSource, false);
});

test('a gzip payload larger than the declared length is refused mid-stream', async t => {
  // ~4 MiB of zeros compresses to a few kilobytes: the classic decompression
  // bomb shape. The manifest declares two float32 positions (8 bytes).
  const bomb = gzipSync(new Uint8Array(4 * 1024 * 1024));
  const counter = { pulls: 0, cancelled: false };
  installFetch(t, async () => chunkedResponse(bomb, 512, counter));

  await assert.rejects(
    loadPointsBinary('https://untrusted.test/data/embeddings/0_2d.bin.gz', {
      dimension: 2,
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

test('a forged gzip trailer is refused without allocating what it declares', async t => {
  const payload = gzipSync(new Uint8Array(64));
  const forged = Uint8Array.from(payload);
  // Rewrite the little-endian ISIZE trailer to ~4 GiB.
  forged[forged.length - 4] = 0xff;
  forged[forged.length - 3] = 0xff;
  forged[forged.length - 2] = 0xff;
  forged[forged.length - 1] = 0xff;

  installFetch(t, async () => new Response(forged, { status: 200 }));

  await assert.rejects(
    loadPointsBinary('https://untrusted.test/data/embeddings/0_2d.bin.gz', {
      dimension: 2,
      expectedBytes: null,
    }),
    /well-formed member|produced 64 bytes/i
  );
});

test('a gzip payload whose trailer disagrees with the manifest is refused', async t => {
  const payload = gzipSync(new Uint8Array(64));
  installFetch(t, async () => new Response(payload, { status: 200 }));

  await assert.rejects(
    loadPointsBinary('https://untrusted.test/data/embeddings/0_2d.bin.gz', {
      dimension: 2,
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
    loadPointsBinary('https://untrusted.test/data/embeddings/0_2d.bin', {
      dimension: 2,
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
    loadPointsBinary('https://untrusted.test/data/embeddings/0_2d.bin', {
      dimension: 2,
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
      'https://trusted.test/data/embeddings/0_2d.bin',
      { dimension: 2, expectedBytes: 16 }
    )),
    [1, 2, 3, 4]
  );
  assert.deepEqual(
    Array.from(await loadPointsBinary(
      'https://trusted.test/data/embeddings/0_2d.bin.gz',
      { dimension: 2, expectedBytes: 16 }
    )),
    [1, 2, 3, 4]
  );
});

test('a declared length the browser cannot allocate is a size refusal', async t => {
  // Larger than any typed array: the allocation itself fails.
  const declared = 2 ** 52;
  installFetch(t, async () => new Response(new Uint8Array(4), {
    status: 200,
    headers: { 'content-length': String(declared) },
  }));

  await assert.rejects(
    loadPointsBinary('https://untrusted.test/data/embeddings/0_2d.bin', {
      dimension: 2,
      expectedBytes: declared,
    }),
    error => {
      assert.equal(error.code, DataSourceErrorCode.TOO_LARGE);
      assert.match(error.message, /could not allocate/i);
      return true;
    }
  );
});

test('a gzip payload above 4 GiB is checked against its trailer modulo 2^32', async t => {
  // ISIZE is the length modulo 2^32 (RFC 1952): a 4 GiB + 64 declaration
  // matches a trailer of 64, and only the inflate can tell them apart.
  const payload = gzipSync(new Uint8Array(64));
  installFetch(t, async () => new Response(payload, { status: 200 }));
  await assert.rejects(
    loadPointsBinary('https://untrusted.test/data/embeddings/0_2d.bin.gz', {
      dimension: 2,
      expectedBytes: 2 ** 32 + 64,
    }),
    /produced 64 bytes|expected exactly/i
  );
});

test('loadPointsBinary requires an explicit declared length', async t => {
  installFetch(t, async () => new Response(
    Float32Array.of(1, 2).buffer,
    { status: 200 }
  ));

  await assert.rejects(
    loadPointsBinary('https://untrusted.test/data/embeddings/0_2d.bin', {
      dimension: 2,
    }),
    /expectedBytes/i
  );
});

test('loadPointsBinary requires the layout dimension and never reads it from the path', async t => {
  let fetchCalls = 0;
  installFetch(t, async () => {
    fetchCalls++;
    return new Response(Float32Array.of(1, 2).buffer, { status: 200 });
  });

  // The v3 payload path names its dimension, but the loader must take it
  // only from the caller's layout descriptor.
  for (const dimension of [undefined, null, 0, 4, '2', 2.5]) {
    const options = { expectedBytes: 8 };
    if (dimension !== undefined) options.dimension = dimension;
    await assert.rejects(
      loadPointsBinary('https://untrusted.test/data/embeddings/0_2d.bin', options),
      /payload dimension: exactly 1, 2, or 3/i
    );
  }
  assert.equal(fetchCalls, 0, 'a payload without a dimension must never be requested');
});

test('metadata JSON above the former 64 MiB ceiling streams and parses', async t => {
  const megabyte = new Uint8Array(1024 * 1024).fill(0x20);
  const chunks = 68;
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
    }),
    { status: 200 }
  ));

  const parsed = await fetchJson('https://untrusted.test/data/dataset_identity.json', 'github');
  assert.equal(parsed.length, chunks * megabyte.byteLength);
});
