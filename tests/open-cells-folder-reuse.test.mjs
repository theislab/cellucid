/**
 * Apply on a Zarr store folder read over HTTP (a served store: one validator
 * for the whole store, as the Python and R servers answer; a folder on a web
 * host: one per file) reuses the reader worker's opened store and the gene
 * index segments of the cells both openings share, while the store's
 * version is unchanged (`httpStore.version` / `unchanged`, one `HEAD` of its
 * consolidated metadata), or its validators moved and what was read is the
 * same (a site deployed again gives every file new ones); other bytes, or a
 * host that names no version, open it anew.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
// The plans asserted here weigh this machine's speed: held at rest (`helpers/machine-at-rest.mjs`).
// The link too: the host below is a function in this process, so what its
// requests measure is how busy this machine is, never a link. Measured, a
// loaded runner's 900-cell opening took over no index of the 300 cells open
// before it (`undefined !== 300`, Web contracts run 42180511574, Windows).
// With every interval timed 40 times longer it does so on every run: the
// first gene of its 900 cells is priced at 14.7 s, genes are read for 8 of
// them, and the share opens in the file's cell order, of which the cells
// open before are no prefix.
import { LINK_AT_REST, holdMachineAtRest } from './helpers/machine-at-rest.mjs';

import { annData, categorical, dataFrame, dense, mapping, sparse, strings, zarrEntries } from './helpers/anndata-store.mjs';
import { cellsToOpen, createAnnDataReaderHandler } from '../assets/js/data/anndata-reader-worker.js';
import { createMulberry32 } from '../assets/js/app/utils/random-utils.js';

holdMachineAtRest({ link: LINK_AT_REST });

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

// Genes read for every open cell, whatever the link: fitted, a gene sample follows what the reads
// measured, and a loaded machine measures the fake host in tens of KB/s (8 of 900 cells on a CI runner).
const request = k => ({ mode: 'subsample', method: 'uniform', k, seed: 7, strict: true, genes: 'all' });

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
    // Deployed again with the same bytes: its validators moved, what was read decides.
    version = 2;
    const deployed = await call('open', { source, cellSubset: request(450), reopen: true });
    assert.equal(deployed.sameVersion, true, 'the same bytes: the store is taken over');
    // A new version of the store: other bytes, opened anew.
    version = 3;
    for (const [key, bytes] of files) if (key !== '.zmetadata') files.set(key, bytes.map(byte => byte ^ 0x5a));
    const again = requests.length;
    const opened = await call('open', { source, cellSubset: request(400), reopen: true }).catch(error => error);
    const reread = requests.slice(again).filter(item => item.key === '.zmetadata').map(item => item.method);
    assert.deepEqual(reread, ['HEAD', 'GET', 'GET'], 'a store of another version is read again');
    assert.notEqual(opened.sameVersion, true);
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

test('a progressive opening is planned only where it can grow in place: a folder whose host names no version opens every cell at once', () => {
  // Each step of a growth reads the same bytes again; a folder no later
  // reading can tell to be the same is read anew, other cells than those
  // shown, and its growth stopped at the first view (the Garcia sample on
  // a host naming no validator: 48,860 of 219,731 cells, "A progressive
  // opening step read other cells than the ones shown and more").
  const asked = { mode: 'all', progressive: { targetMs: 1000, msPerCell: 0.02 } };
  assert.deepEqual(cellsToOpen(asked, { key: null, folder: { version: null } }), { mode: 'all' }, 'every cell at once');
  assert.equal(cellsToOpen(asked, { key: null, folder: { version: '"v1"' } }), asked, 'a versioned folder grows');
  assert.equal(cellsToOpen(asked, { key: '["file","a.h5ad",1,2]', folder: null }), asked, 'a file by its key grows');
  assert.equal(cellsToOpen({ mode: 'all' }, { key: null, folder: { version: null } }).progressive, undefined);
  assert.equal(cellsToOpen(null, { key: null, folder: null }), null);
});

test('a folder read at a version naming its content is taken over on every reading again, though its host shows the page no validator', async t => {
  // GitHub's raw host sends an ETag but exposes no header to a page (no
  // Access-Control-Expose-Headers): read at a commit, the folder is the same
  // bytes for the same address and commit. Opened anew, every step of a
  // progressive opening read other cells than those shown and the page
  // stopped growing at its first view (Suo: 32,768 of 561,947 cells).
  const files = storeFiles();
  const requests = serveStore(t, files, () => null);
  const call = handler();
  const source = { url: BASE, name: 'store.zarr', key: 'gh:owner%2Frepo%40HEAD%2Fstore.zarr', version: 'commit:abc' };
  await call('open', { source, cellSubset: request(300) });
  await call('getMatrixColumn', 'X', 3);
  await indexBuilt(call);
  let before = requests.length;
  const raised = await call('open', { source, cellSubset: request(900), reopen: true });
  assert.equal(raised.sameVersion, true, 'the same bytes: the cells shown stay shown');
  assert.deepEqual(requests.slice(before).filter(item => item.key === '.zmetadata').map(item => item.method), [], 'taken over, nothing asked again');
  assert.equal((await call('geneReadPlan', 'X')).progressive?.done, 300, 'the index of the first 300 cells is taken over');
  // Another commit: other bytes, opened anew.
  before = requests.length;
  const other = await call('open', { source: { ...source, version: 'commit:def' }, cellSubset: request(600), reopen: true });
  assert.equal(other.sameVersion, false);
  assert.deepEqual(requests.slice(before).filter(item => item.key === '.zmetadata').map(item => item.method), ['GET']);
  await call('close');
});

test('a store with byte-identical metadata and a new write time: the bytes read decide, not the time', async t => {
  // An ETag made from the bytes (S3, GitHub) stays when the metadata is
  // written again with the same bytes; the write time moves, as it does for a
  // site deployed again with the same files.
  const files = storeFiles();
  let written = 'Mon, 26 Oct 2026 10:00:00 GMT';
  const requests = serveStore(t, files, key => ({ etag: `"sha-${key.length}"`, modified: written }));
  const call = handler();
  const source = { url: BASE, name: 'store.zarr' };
  await call('open', { source, cellSubset: request(300) });
  await call('getMatrixColumn', 'X', 3);
  await indexBuilt(call);
  let before = requests.length;
  await call('open', { source, cellSubset: request(600), reopen: true });
  assert.deepEqual(requests.slice(before).filter(item => item.key === '.zmetadata').map(item => item.method), ['HEAD'], 'unchanged: taken over');
  written = 'Tue, 27 Oct 2026 09:00:00 GMT';
  const deployed = await call('open', { source, cellSubset: request(900), reopen: true });
  assert.equal(deployed.sameVersion, true, 'written again with the same bytes: taken over');
  written = 'Wed, 28 Oct 2026 09:00:00 GMT';
  for (const [key, bytes] of files) if (key !== '.zmetadata') files.set(key, bytes.map(byte => byte ^ 0x5a));
  before = requests.length;
  const rewritten = await call('open', { source, cellSubset: request(800), reopen: true }).catch(error => error);
  assert.deepEqual(requests.slice(before).filter(item => item.key === '.zmetadata').map(item => item.method), ['HEAD', 'GET', 'GET'], 'other bytes: opened anew');
  assert.notEqual(rewritten.sameVersion, true);
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
