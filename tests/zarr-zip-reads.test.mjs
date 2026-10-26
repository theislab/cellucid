/**
 * A `.zarr.zip` no longer than the end read at open is read once: one
 * request, every entry served from it, locally and over HTTP.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { blobByteSource, httpByteSource } from '../assets/js/formats/io/byte-source.js';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { openZipArchive } from '../assets/js/formats/zip/index.js';
import { openZarr, zipStore } from '../assets/js/formats/zarr/index.js';

import { ZARR_CORPUS } from './helpers/zarr-corpus.mjs';

function arraysOf(group, out = []) {
  for (const key of group.keys()) {
    const node = group.get(key);
    if (node.kind === 'group') arraysOf(node, out);
    else out.push(node);
  }
  return out;
}

for (const mode of ['local', 'http']) {
  test(`a small .zarr.zip is read in one request, every array included (${mode})`, async () => {
    const bytes = new Uint8Array(readFileSync(path.join(ZARR_CORPUS, 'anndata', 'v3.zarr.zip')));
    const asked = [];
    let source;
    if (mode === 'local') {
      const base = blobByteSource(new Blob([bytes]), { name: 'v3.zarr.zip' });
      source = { ...base, read: (offset, length, options) => { asked.push([offset, length]); return base.read(offset, length, options); } };
    } else {
      const fetch = async (url, init) => {
        const [, start, end] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range).map(Number);
        const stop = Math.min(bytes.length, end + 1);
        asked.push([start, stop - start]);
        return new Response(bytes.slice(start, stop), { status: 206, headers: { 'Content-Range': `bytes ${start}-${stop - 1}/${bytes.length}` } });
      };
      source = httpByteSource({ url: 'https://host.test/v3.zarr.zip', size: bytes.length }, { fetch });
    }
    const archive = await openZipArchive(createByteReader(source), { name: 'v3.zarr.zip' });
    const root = await openZarr(zipStore(archive));
    for (const array of arraysOf(root)) await array.read();
    assert.deepEqual(asked, [[0, bytes.length]]);
  });
}
