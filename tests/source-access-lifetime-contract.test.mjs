/**
 * A remote file's access (`data/sources/access.js`: the provider closure
 * holding its item, its download link or its token getter) lives as long as
 * the source that reads the file, never the page's life (F123, LC-4):
 *
 * - the reading source (`AnnDataFileSource`) lets its file's access go when
 *   another dataset replaces it and when it is closed;
 * - an opening that is not adopted (it failed, or was stopped) lets its
 *   file's access go at once;
 * - a provider registers an access only for a file it described (a refused
 *   file holds none), and a link whose opening fails before a reader took
 *   it lets its file's access go (`link-source.js`).
 *
 * A read asking for an access let go is told to open the file again.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import './helpers/anndata-reader-in-process.mjs';
import { AnnDataFileSource } from '../assets/js/data/anndata-file-source.js';
import {
  registerSourceAccess,
  releaseSourceAccess,
  releaseSourceAccessesOf,
  resolveSourceAccess,
} from '../assets/js/data/sources/access.js';

const BYTES = new Uint8Array(readFileSync(new URL('./fixtures/gene-read/cellxgene-shaped.h5ad', import.meta.url)));

/** A host serving the file with ranges at /ok/, refusing everything at /gone/. */
function host(t) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    if (init.signal?.aborted) throw init.signal.reason;
    if (String(input).includes('/gone/')) return new Response(null, { status: 404 });
    const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers ?? {}).get('Range') ?? '');
    const headers = { ETag: '"v1"', 'Accept-Ranges': 'bytes' };
    if (match === null) return new Response(BYTES.slice(), { status: 200, headers: { ...headers, 'Content-Length': String(BYTES.length) } });
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), BYTES.length - 1);
    return new Response(BYTES.slice(start, end + 1), {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${BYTES.length}`, 'Content-Length': String(end - start + 1) },
    });
  };
  t.after(() => { globalThis.fetch = original; });
}

function quiet(t) {
  const { log, info, debug, warn } = console;
  console.log = () => {};
  console.info = () => {};
  console.debug = () => {};
  console.warn = () => {};
  t.after(() => Object.assign(console, { log, info, debug, warn }));
}

/** A remote file read through a registered access (as Google Drive's, OneDrive's or Figshare's). */
function accessedFile(name, path = 'ok') {
  const access = registerSourceAccess({
    provider: 'test-drive',
    target: async () => ({ url: `https://host.test/${path}/${name}` }),
  });
  const file = {
    url: `https://display.test/${name}`,
    size: BYTES.length,
    name,
    identity: Object.freeze({ kind: 'remote', key: `test:${name}`, version: 'etag:"v1"' }),
    access,
  };
  return { file, access };
}

const held = async access => {
  try {
    await resolveSourceAccess(access.ref);
    return true;
  } catch (error) {
    assert.match(error.message, /no longer held by the page; open it again/);
    return false;
  }
};

test('a released access is told to open the file again; releasing twice is nothing', async () => {
  const { access } = accessedFile('a.h5ad');
  assert.equal(await held(access), true);
  releaseSourceAccess(access);
  releaseSourceAccess(access);
  assert.equal(await held(access), false);
  assert.throws(() => releaseSourceAccess(null), /descriptor/);
  const one = accessedFile('b.h5ad');
  const two = accessedFile('c.h5ad');
  releaseSourceAccessesOf({ files: new Map([['b', one.file], ['c', two.file], ['local', { name: 'x' }]]) });
  assert.deepEqual([await held(one.access), await held(two.access)], [false, false]);
  releaseSourceAccessesOf(null);
  releaseSourceAccessesOf({ url: 'https://store.test/x.zarr/', name: 'x' });
});

test('the reading source lets its file\'s access go when replaced, when closed, and when an opening is not adopted', async t => {
  quiet(t);
  host(t);
  const source = new AnnDataFileSource();
  t.after(() => source.clear());

  const first = accessedFile('first.h5ad');
  await source.loadFile(first.file);
  assert.equal(await held(first.access), true, 'the open dataset keeps its access');

  // An opening that fails is not adopted: its access goes, the open one stays.
  const failing = accessedFile('failing.h5ad', 'gone');
  await assert.rejects(source.loadFile(failing.file));
  assert.equal(await held(failing.access), false, 'a failed opening lets its access go');
  assert.equal(await held(first.access), true, 'the dataset still open keeps its access');

  // Another dataset replaces it: the first file's access goes.
  const second = accessedFile('second.h5ad');
  await source.loadFile(second.file);
  assert.equal(await held(first.access), false, 'a replaced source lets its access go');
  assert.equal(await held(second.access), true);

  // Reading the open dataset again (other cells) keeps its access.
  await source.reopenCells({ cellSubset: { mode: 'subsample', method: 'blocks', k: 100, seed: 0, blockSize: 10 } });
  assert.equal(await held(second.access), true, 'reading the same source again keeps it');

  source.clear();
  assert.equal(await held(second.access), false, 'a closed source lets its access go');
});

test('a link whose opening fails before a reader took it lets its file\'s access go', async t => {
  quiet(t);
  host(t);
  const { file, access } = accessedFile('whole.h5ad', 'gone');
  // A host that serves only whole files: the download fails (404) before
  // any reader is made.
  const opening = {
    title: 'whole.h5ad',
    file: {
      id: 'test:whole',
      name: 'whole.h5ad',
      title: 'whole.h5ad',
      transport: 'download',
      resource: Object.freeze({ ...file, url: 'https://host.test/gone/whole.h5ad' }),
      attribution: { title: 'whole.h5ad', url: 'https://host.test/gone/whole.h5ad' },
      format: { format: 'h5ad', layout: 'file' },
    },
  };
  const provider = { id: 'test-drive', label: 'Test Drive', publicValue: value => value, open: async () => opening };
  const registry = {
    resolve: input => ({ provider, value: input, locator: `test:${input}`, publicLocator: `test:${input}` }),
    publicFormOf: input => input,
  };
  const { LinkDataSource } = await import('../assets/js/data/link-source.js');
  const link = new LinkDataSource({ registry });
  await assert.rejects(link.connect('whole'));
  assert.equal(await held(access), false, 'the failed opening let its access go');
});
