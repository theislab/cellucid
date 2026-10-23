// Remote documents are bounded only by what the browser can hold.
//
// A catalog (`datasets.json`), a default session or a served dataset list is
// read whole; there is no fixed size ceiling, and an AnnData file's arrays
// are read in place by the AnnData reader, never fetched as one payload.

import assert from 'node:assert/strict';
import test from 'node:test';

import { loadPointsBinary } from '../assets/js/data/data-loaders.js';
import * as dataSource from '../assets/js/data/data-source.js';

const { fetchJson } = dataSource;

function installFetch(t, handler) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  });
}

test('metadata JSON has no fixed ceiling, and no payload helper survives', () => {
  assert.equal('MAX_METADATA_JSON_BYTES' in dataSource, false);
  assert.equal('maxGzipTransferBytes' in dataSource, false);
  assert.equal('requireDeclaredPayloadLength' in dataSource, false);
});

test('loadPointsBinary requires the layout dimension and never reads it from the path', async () => {
  // The payload path names its dimension, but the loader takes it only from
  // the caller's layout descriptor.
  for (const dimension of [undefined, null, 0, 4, '2', 2.5]) {
    const options = {};
    if (dimension !== undefined) options.dimension = dimension;
    await assert.rejects(
      loadPointsBinary('h5ad://dataset/obsm/0/0-1', options),
      /payload dimension: exactly 1, 2, or 3/i
    );
  }
});

test('loadPointsBinary reads only an AnnData dataset', async () => {
  await assert.rejects(
    loadPointsBinary('https://untrusted.test/data/obsm/0/0-1', { dimension: 2 }),
    /h5ad:\/\/ or zarr:\/\/ URL/
  );
  await assert.rejects(
    loadPointsBinary('h5ad://dataset/obsm/0/0-1', { dimension: 2, expectedBytes: 16 }),
    /unexpected key\(s\): expectedBytes/
  );
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

  const parsed = await fetchJson('https://untrusted.test/data/datasets.json', 'github');
  assert.equal(parsed.length, chunks * megabyte.byteLength);
});
