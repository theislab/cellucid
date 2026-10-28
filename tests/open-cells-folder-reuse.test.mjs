/**
 * Apply on a Zarr store folder read over HTTP (a served store: one validator
 * for the whole store, as the Python and R servers answer; a folder on a web
 * host: one per file) reuses the reader worker's opened store and the gene
 * index segments of the cells both openings share, while the store's
 * version is unchanged (`httpStore.version` / `unchanged`, one `HEAD` of its
 * consolidated metadata); a new version, or a host that names none, opens it
 * anew.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { annData, categorical, dataFrame, dense, mapping, sparse, strings, zarrEntries } from './helpers/anndata-store.mjs';
import { createAnnDataReaderHandler } from '../assets/js/data/anndata-reader-worker.js';
import { createMulberry32 } from '../assets/js/app/utils/random-utils.js';

const CELLS = 1200;
const GENES = 60;
const BASE = 'https://host.example/store.zarr/';

function storeFiles() {
  const random = createMulberry32(11);
  const data = [];
  const indices = [];
  const indptr = [0];
  for (let cell = 0; cell < CELLS; cell++) {
    for (let gene = 0; gene < GENES; gene++) {
      if (random() < 0.3) {
        indices.push(gene);
        data.push(Math.fround(1 + random() * 4));
      }
    }
    indptr.push(data.length);
  }
  const X = sparse({ format: 'csr', data: Float32Array.from(data), indices: Int32Array.from(indices), indptr: Int32Array.from(indptr), shape: [CELLS, GENES] });
  X.children.data.chunks = [512];
  X.children.indices.chunks = [512];
  X.children.indptr.chunks = [128];
  const entries = zarrEntries(annData({
    obs: dataFrame({
      _index: strings(Array.from({ length: CELLS }, (_, i) => `c${i}`), { chunks: [200] }),
      cluster: categorical(Int8Array.from({ length: CELLS }, (_, i) => i % 3), ['a', 'b', 'c']),
    }),
    var: dataFrame({ _index: strings(Array.from({ length: GENES }, (_, g) => `g${g}`)) }),
    obsm: mapping({ X_umap: dense(Float32Array.from({ length: CELLS * 2 }, () => random()), [CELLS, 2], { chunks: [200, 2] }) }),
    X,
  }));
  // Consolidated, as a store on a web host must be.
  const metadata = {};
  for (const [key, bytes] of entries) {
    if (/(^|\/)\.(zgroup|zattrs|zarray)$/.test(key)) metadata[key] = JSON.parse(new TextDecoder().decode(bytes));
  }
  entries.set('.zmetadata', new TextEncoder().encode(JSON.stringify({ metadata, zarr_consolidated_format: 1 })));
  return entries;
}

/**
 * A host serving the store: `validator(key)` names each object's version
 * (null: none; a string: its ETag; `{etag, modified}`: an ETag and a write
 * time), and every request is recorded.
 */
function serveStore(t, files, validator) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init.method ?? 'GET';
    const key = decodeURIComponent(url.slice(BASE.length));
    requests.push({ key, method });
    const bytes = files.get(key);
    if (bytes === undefined) return new Response('absent', { status: 404 });
    const tag = validator(key);
    // A string is an ETag; `{etag, modified}` names a write time too.
    const named = tag === null ? {} : typeof tag === 'string' ? { ETag: tag } : { ETag: tag.etag, 'Last-Modified': tag.modified };
    const headers = { 'Content-Length': String(bytes.byteLength), ...named };
    if (method === 'HEAD') return new Response(null, { status: 200, headers });
    const range = new Headers(init.headers ?? {}).get('Range');
    if (range !== null) {
      const [, start, end] = /bytes=(\d+)-(\d+)/.exec(range);
      const last = Math.min(Number(end), bytes.byteLength - 1);
      return new Response(bytes.slice(Number(start), last + 1), { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${last}/${bytes.byteLength}`, 'Content-Length': String(last - Number(start) + 1) } });
    }
    return new Response(bytes, { status: 200, headers });
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return requests;
}

function handler() {
  const handle = createAnnDataReaderHandler({ post: () => {} });
  let id = 0;
  return async (method, ...args) => {
    const { reply } = await handle({ id: ++id, method, args });
    if (reply.error) throw new Error(reply.error.message);
    return reply.result;
  };
}

const request = k => ({ mode: 'subsample', method: 'uniform', k, seed: 7, strict: true });

async function indexBuilt(call) {
  for (let wait = 0; (await call('geneReadPlan', 'X')).built !== true; wait++) {
    assert.ok(wait < 1000, 'the index is built');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

for (const [label, validatorOf] of [
  ['a served store (one validator for the store)', () => '"served-1"'],
  ['a folder on a web host (one validator a file)', key => `"${key.length}-1"`],
]) {
  test(`Apply on ${label} reuses the opened store and the gene index of the cells kept`, async t => {
    const files = storeFiles();
    let version = 1;
    const requests = serveStore(t, files, key => validatorOf(key).replace('-1"', `-${version}"`).replace('"served-1"', `"served-${version}"`));
    const call = handler();
    const source = { url: BASE, name: 'store.zarr' };
    await call('open', { source, cellSubset: request(300) });
    await call('getMatrixColumn', 'X', 3);
    await indexBuilt(call);
    // Raised in place: the store's metadata is asked again with one HEAD, not read again.
    const before = requests.length;
    const raised = await call('open', { source, cellSubset: request(900), reopen: true });
    const asked = requests.slice(before).filter(item => item.key === '.zmetadata');
    assert.deepEqual(asked.map(item => item.method), ['HEAD'], 'the store is taken over');
    assert.equal(raised.nObs, 900);
    const plan = await call('geneReadPlan', 'X');
    assert.equal(plan.progressive?.done, 300, 'the index of the first 300 cells is taken over');
    // A new version of the store: opened anew.
    version = 2;
    const again = requests.length;
    await call('open', { source, cellSubset: request(450), reopen: true });
    const reread = requests.slice(again).filter(item => item.key === '.zmetadata').map(item => item.method);
    assert.deepEqual(reread, ['HEAD', 'GET'], 'a store of another version is read again');
    await call('close');
  });
}

test('a folder whose host names no version is opened anew on Apply', async t => {
  const files = storeFiles();
  const requests = serveStore(t, files, () => null);
  const call = handler();
  const source = { url: BASE, name: 'store.zarr' };
  await call('open', { source, cellSubset: request(300) });
  const before = requests.length;
  await call('open', { source, cellSubset: request(600), reopen: true });
  assert.deepEqual(requests.slice(before).filter(item => item.key === '.zmetadata').map(item => item.method), ['GET']);
  await call('close');
});

test('a store rewritten with byte-identical metadata is opened anew when its host names a write time', async t => {
  // An ETag made from the bytes (S3, GitHub) stays when the metadata is
  // written again with the same bytes; the write time moves.
  const files = storeFiles();
  let written = 'Mon, 26 Oct 2026 10:00:00 GMT';
  const requests = serveStore(t, files, key => ({ etag: `"sha-${key.length}"`, modified: written }));
  const call = handler();
  const source = { url: BASE, name: 'store.zarr' };
  await call('open', { source, cellSubset: request(300) });
  let before = requests.length;
  await call('open', { source, cellSubset: request(600), reopen: true });
  assert.deepEqual(requests.slice(before).filter(item => item.key === '.zmetadata').map(item => item.method), ['HEAD'], 'unchanged: taken over');
  written = 'Tue, 27 Oct 2026 09:00:00 GMT';
  before = requests.length;
  await call('open', { source, cellSubset: request(900), reopen: true });
  assert.deepEqual(requests.slice(before).filter(item => item.key === '.zmetadata').map(item => item.method), ['HEAD', 'GET'], 'written again: opened anew');
  await call('close');
});

test('Apply on a folder picked from this computer reuses the opened store while every file is the same; a rewritten file opens it anew', async () => {
  const entries = storeFiles();
  const folderOf = modified => ({
    files: new Map([...entries].map(([key, bytes]) => [key, new File([bytes], key.split('/').at(-1), { lastModified: modified(key) })])),
    rootName: 'store.zarr',
  });
  const call = handler();
  const picked = folderOf(() => 1_700_000_000_000);
  await call('open', { source: picked, cellSubset: request(300) });
  await call('getMatrixColumn', 'X', 3);
  await indexBuilt(call);
  // The same files (picked again: new File objects, the same names, sizes and times).
  const raised = await call('open', { source: folderOf(() => 1_700_000_000_000), cellSubset: request(900), reopen: true });
  assert.equal(raised.nObs, 900);
  assert.equal((await call('geneReadPlan', 'X')).progressive?.done, 300, 'the opened store and the index of the first 300 cells are taken over');
  // One file rewritten (its time changed): another source, opened anew.
  await call('open', { source: folderOf(key => (key === 'X/data/0' ? 1_700_000_000_001 : 1_700_000_000_000)), cellSubset: request(600), reopen: true });
  assert.notEqual((await call('geneReadPlan', 'X')).progressive?.done, 300, 'nothing of the earlier store is taken over');
});
