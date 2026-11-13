/**
 * What real public links taught (`scripts/efficiency-floor/public-links.*`):
 * each case here is a shape a published dataset has on its first opening,
 * pinned in a small synthetic copy of it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
// The plans asserted here weigh this machine's speed: held at rest (`helpers/machine-at-rest.mjs`).
import './helpers/machine-at-rest.mjs';

import { openDatasetStore } from '../assets/js/data/anndata/open.js';
import { until } from './helpers/until.mjs';
import { settle } from './helpers/virtual-time.mjs';

const CACHE_BYTES = 8 * 1024 * 1024;
const text = rows => new TextEncoder().encode(rows.map(row => row.join('\t')).join('\n') + '\n');

test('a multiome MatrixMarket sample with more peaks than the engine takes as arguments opens', async () => {
  // GEO GSE336826 (Cell Ranger ARC: 32,058 genes and 239,160 peaks) opens:
  // the MuData var index must not join each modality's features with one
  // spread call, which goes past the call stack.
  const genes = 3;
  const peaks = 300_000;
  const features = [];
  for (let g = 0; g < genes; g++) features.push([`ENSG${g}`, `GENE${g}`, 'Gene Expression']);
  for (let p = 0; p < peaks; p++) features.push([`chr1:${p * 10}-${p * 10 + 5}`, `chr1:${p * 10}-${p * 10 + 5}`, 'Peaks']);
  const entries = [[1, 1, 3], [2, 2, 4], [genes + 1, 1, 5], [genes + peaks, 2, 6]];
  const matrix = new TextEncoder().encode(
    '%%MatrixMarket matrix coordinate integer general\n' +
    `${genes + peaks} 2 ${entries.length}\n` + entries.map(row => row.join(' ')).join('\n') + '\n'
  );
  const files = new Map([
    ['x/matrix.mtx', new File([matrix], 'matrix.mtx')],
    ['x/features.tsv', new File([text(features)], 'features.tsv')],
    ['x/barcodes.tsv', new File([text([['A'], ['B']])], 'barcodes.tsv')],
    ['x/umap.csv', new File([text([['barcode,UMAP_1,UMAP_2'], ['A,0,1'], ['B,1,0']])], 'umap.csv')],
  ]);
  const opened = await openDatasetStore({ source: { files, rootName: 'x' } }, { decodedChunkCacheBytes: CACHE_BYTES, transcoding: { memory: true } });
  const peakVar = opened.root.get('mod/Peaks/var');
  const names = await peakVar.get(peakVar.attrs._index).read();
  assert.equal(names.length, peaks);
  assert.equal(names[peaks - 1], `chr1:${(peaks - 1) * 10}-${(peaks - 1) * 10 + 5}`);
});

// ---------------------------------------------------------------------------
// The matrix genes are read from prices the opening.
// ---------------------------------------------------------------------------

/**
 * An anndata 0.6-shaped file (the Dropbox pancreas tutorial file): a dense
 * X of the highly variable genes in gene-strip chunks, and a CSR raw.X of
 * every gene with many values a cell, which the default expression rule
 * reads (more genes than X).
 */
async function rawDefaultRoot({ nObs = 1200, nVars = 40, rawVars = 400, perCell = 120, launch = null } = {}) {
  const { annData, dataFrame, dense, mapping, sparse, strings, openStore } = await import('./helpers/anndata-store.mjs');
  const names = (prefix, n) => strings(Array.from({ length: n }, (_, i) => `${prefix}${i}`));
  const raw = sparse({
    data: new Float32Array(nObs * perCell).fill(1),
    indices: Int32Array.from({ length: nObs * perCell }, (_, e) => (e * 7) % rawVars),
    indptr: Int32Array.from({ length: nObs + 1 }, (_, i) => i * perCell),
    shape: [nObs, rawVars],
    chunks: 600,
    compressed: true,
  });
  const children = {
    obs: dataFrame({ _index: names('c', nObs) }),
    var: dataFrame({ _index: names('g', nVars) }),
    obsm: mapping({ X_umap: dense(new Float32Array(nObs * 2), [nObs, 2], { chunks: [nObs, 2] }) }),
    X: dense(new Float32Array(nObs * nVars).fill(1), [nObs, nVars], { chunks: [nObs, 4], compressed: true }),
    raw: mapping({ X: raw, var: dataFrame({ _index: names('r', rawVars) }) }),
  };
  if (launch !== null) children.uns = mapping({ cellucid: mapping({ defaults: mapping({ expression: strings([launch], { shape: [] }) }) }) });
  return (await openStore(annData(children))).root;
}

test('the default expression path is the matrix genes are read from: raw.X when it holds more genes, a launch default first', async () => {
  const { defaultExpressionPath } = await import('../assets/js/data/anndata/subsample-plan.js');
  assert.equal(await defaultExpressionPath(await rawDefaultRoot()), 'raw/X');
  assert.equal(await defaultExpressionPath(await rawDefaultRoot({ rawVars: 40 })), 'X', 'raw over the same genes: X (CELLxGENE)');
  assert.equal(await defaultExpressionPath(await rawDefaultRoot(), { launch: 'X' }), 'X', 'the file\'s own default wins');
  assert.equal(await defaultExpressionPath(await rawDefaultRoot(), { launch: 'layers/absent' }), 'raw/X', 'a launch default naming no matrix is not priced by');
});

test('auto-fit prices the first gene of the matrix genes are read from, not X', async () => {
  // Dropbox pancreas.h5ad (anndata 0.6): every cell opened, priced by its
  // gene-strip X, and the first gene then read every cell's entries of
  // raw.X: 122 MB in 57 s.
  const { resolveCellSubset, defaultBlockSize, defaultExpressionPath } = await import('../assets/js/data/anndata/subsample-plan.js');
  const root = await rawDefaultRoot();
  const nObs = 1200;
  const link = { measured: true, latencyMs: 100, bytesPerMs: 20, concurrency: 6, shapingConcurrency: 6 };
  const context = { valuesOnDemand: true, decodedChunkBytes: 1e9, budgets: { allowanceBytes: 1e12, columnIndexBytes: 1e12 }, link, geneTargetMs: 2000 };
  const expression = await defaultExpressionPath(root);
  const priced = await resolveCellSubset(root, { mode: 'auto' }, { ...context, expression });
  // The map opens every cell; a gene is read for the sample of them its
  // first read fits the target for, priced on raw.X.
  assert.equal(priced.kept, null, 'every cell of the map');
  assert.equal(priced.genes?.fit?.limit, 'geneTime', 'raw.X read over this link takes longer than the target for every cell');
  assert.equal(priced.genes.fit.matrix, 'raw.X');
  assert.ok(priced.genes.cells < nObs);
  // Blocks align to the chunks genes are read from: raw.X's (600 values,
  // 120 a cell: 5 cells a chunk, 20 a block), not X's 1,200-row strips.
  assert.equal(defaultBlockSize(root, nObs, 'raw/X'), 20);
  // Priced by X, every cell's raw.X would be read for the first gene.
  const byX = await resolveCellSubset(root, { mode: 'auto' }, { ...context, expression: 'X' });
  assert.equal(byX.genes, null);
});

test('a reader opening prices auto-fit by the file\'s default expression matrix', async () => {
  const { AnnDataReader } = await import('../assets/js/data/anndata/reader.js');
  const { ZARR_FORMAT } = await import('../assets/js/data/anndata/elements.js');
  const root = await rawDefaultRoot();
  // A link over which raw.X's first gene takes past the 20 s target.
  const link = { snapshot: () => ({ measured: true, latencyMs: 100, bytesPerMs: 1, concurrency: 6, shapingConcurrency: 6 }), mergeGapBytes: 0 };
  const reader = new AnnDataReader();
  await reader.open(root, { format: ZARR_FORMAT, name: 'pancreas', link, cellSubset: { mode: 'auto' } });
  try {
    const subset = reader.cellSubset;
    assert.equal(subset.genes?.fit?.matrix, 'raw.X');
    assert.ok(subset.genes.cells < 1200);
  } finally {
    reader.close();
  }
});

// ---------------------------------------------------------------------------
// Compressed copies (`.h5ad.gz`, as GEO ships many) open, read whole once.
// ---------------------------------------------------------------------------

const READY = new URL('./fixtures/cellucid-ready/ready.h5ad', import.meta.url);

async function readyBytes() {
  const { readFileSync } = await import('node:fs');
  return new Uint8Array(readFileSync(READY));
}

async function gzipped(bytes) {
  const { gzipSync } = await import('node:zlib');
  return new Uint8Array(gzipSync(bytes));
}

test('a compressed copy is named by the file it copies, read whole, never head-read, and never chosen over that file', async () => {
  const { fileFormatOfName, titleOfName, readsFromHead, filePickerAccept, compressedFormatOfName } = await import('../assets/js/data/input-formats.js');
  const { chooseOpenableFile } = await import('../assets/js/data/sources/remote-file.js');
  const { geoDatasets } = await import('../assets/js/data/sources/providers/geo.js');
  assert.deepEqual(fileFormatOfName('GSE194122_cite.h5ad.gz'), { format: 'h5ad', layout: 'file', compression: 'gzip' });
  assert.deepEqual(fileFormatOfName('atlas.zarr.zip.gz'), { format: 'zarr', layout: 'zip', compression: 'gzip' });
  assert.deepEqual(fileFormatOfName('pbmc.rds.gz'), { format: 'rds', layout: 'file' }, 'a stream format names its own compressed endings');
  assert.equal(fileFormatOfName('notes.txt.gz'), null);
  assert.equal(compressedFormatOfName('x.rds.gz'), null);
  assert.equal(titleOfName('GSE194122_cite.h5ad.gz'), 'GSE194122_cite');
  assert.equal(readsFromHead(fileFormatOfName('x.h5ad.gz')), false);
  assert.equal(readsFromHead(fileFormatOfName('x.h5ad')), true);
  assert.ok(filePickerAccept().split(',').includes('.h5ad.gz'));
  assert.ok(!filePickerAccept().split(',').includes('.gz'), 'never every gzip file');
  assert.ok(!filePickerAccept().split(',').includes('.h5seurat.gz'), 'never a format only refused');
  assert.equal(chooseOpenableFile(['a.h5ad.gz', 'readme.txt'], null, 'r', name => name), 'a.h5ad.gz');
  assert.equal(chooseOpenableFile(['a.h5ad', 'a.h5ad.gz'], null, 'r', name => name), 'a.h5ad', 'the file itself, read in parts');
  const files = [
    { name: 'GSE1_cite.h5ad.gz', url: 'u1', path: 'GSE1/GSE1_cite.h5ad.gz' },
    { name: 'GSE1_rna.h5ad', url: 'u2', path: 'GSE1/GSE1_rna.h5ad' },
    { name: 'GSE1_rna.h5ad.gz', url: 'u3', path: 'GSE1/GSE1_rna.h5ad.gz' },
  ];
  assert.deepEqual(geoDatasets(files).singles.map(file => file.name), ['GSE1_cite.h5ad.gz', 'GSE1_rna.h5ad']);
});

test('a linked compressed copy is downloaded once, decompressed as it arrives, and opened from what is kept; a second visit only asks its version', async t => {
  const { opfsOnDisk } = await import('./helpers/opfs-on-disk.mjs');
  const { describeRemoteFile } = await import('../assets/js/data/sources/remote-file.js');
  const { wholeFileOf } = await import('../assets/js/data/whole-download.js');
  const disk = opfsOnDisk({ handles: 'page' });
  const navigator = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value: { ...navigator, storage: disk.environment.navigator.storage, locks: disk.environment.navigator.locks }, configurable: true });
  t.after(() => Object.defineProperty(globalThis, 'navigator', { value: navigator, configurable: true }));
  const plain = await readyBytes();
  const bytes = await gzipped(plain);
  const url = 'https://ftp.example.org/geo/GSE1_ready.h5ad.gz';
  const modified = 'Fri, 21 Jan 2022 13:46:35 GMT';
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const range = new Headers(init.headers ?? {}).get('Range');
    calls.push([init.method ?? 'GET', range]);
    const headers = { 'Last-Modified': modified, 'Accept-Ranges': 'bytes', 'Content-Type': 'application/x-gzip' };
    const match = range === null ? null : /bytes=(\d+)-(\d*)/.exec(range);
    const start = match === null ? 0 : Number(match[1]);
    const end = match === null || match[2] === '' ? bytes.length - 1 : Math.min(Number(match[2]), bytes.length - 1);
    const body = (init.method ?? 'GET') === 'HEAD' ? null : bytes.slice(start, end + 1);
    const response = new Response(body, {
      status: match === null ? 200 : 206,
      headers: { ...headers, 'Content-Length': String(match === null ? bytes.length : end - start + 1), ...(match === null ? {} : { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` }) },
    });
    Object.defineProperty(response, 'url', { value: String(input) });
    return response;
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const described = await describeRemoteFile({ url, id: 'geo:GSE1:ready', name: 'GSE1_ready.h5ad.gz', attribution: { title: 'GEO GSE1', url } });
  assert.equal(described.transport, 'download');
  assert.deepEqual(described.format, { format: 'h5ad', layout: 'file', compression: 'gzip' });
  assert.equal(described.resource.compression, 'gzip');
  assert.equal(described.resource.head, undefined, 'a compressed copy has no head worth reading');
  assert.equal(calls.filter(([, range]) => range !== null && range !== 'bytes=0-' && range !== 'bytes=0-0').length, 0, 'the probe reads one byte, not a head');
  const before = calls.length;
  const said = [];
  const kept = await wholeFileOf(described.resource, { format: 'h5ad', opening: { step: text => said.push(text), notice: text => said.push(text) } });
  assert.deepEqual(calls.slice(before), [['GET', null]], 'one whole download');
  assert.match(said.join('\n'), /it is a gzip-compressed copy, which has no index a part could be found by/, 'the step says why it is read whole');
  assert.match(said.join('\n'), /GSE1_ready\.h5ad\.gz is a gzip-compressed copy.*decompressed as it arrives.*open that one/, 'never "serves this file only whole": its host serves parts');
  assert.equal(kept.downloaded.size, plain.length, 'kept decompressed');
  assert.deepEqual(new Uint8Array(await kept.downloaded.slice(0, 8).arrayBuffer()), plain.subarray(0, 8));
  const opened = await openDatasetStore({ source: { file: kept }, expect: described.format, fromLink: true }, { decodedChunkCacheBytes: CACHE_BYTES, transcoding: { environment: disk.environment } });
  assert.ok(opened.root.has('obs') && opened.root.has('obsm'), 'opens as the .h5ad it copies');
  // A second visit: the kept copy, nothing downloaded.
  const again = calls.length;
  const second = await wholeFileOf(described.resource, { format: 'h5ad' });
  assert.equal(calls.length, again, 'nothing asked: the kept copy opens');
  assert.equal(second.downloaded.size, plain.length);
});

test('a compressed copy picked from this computer is decompressed once into storage and read in parts from there', async () => {
  const { opfsOnDisk } = await import('./helpers/opfs-on-disk.mjs');
  const { findKeptDownload } = await import('../assets/js/data/anndata/transcode/space.js');
  const disk = opfsOnDisk({ handles: 'worker' });
  const plain = await readyBytes();
  const file = new File([await gzipped(plain)], 'atlas.h5ad.gz', { lastModified: 1_700_000_000_000 });
  const opened = await openDatasetStore({ source: { file } }, { decodedChunkCacheBytes: CACHE_BYTES, transcoding: { environment: disk.environment } });
  assert.ok(opened.root.has('obs'));
  assert.equal(opened.format, 'h5ad');
  const identity = { kind: 'file', name: 'atlas.h5ad.gz', size: file.size, lastModified: file.lastModified };
  const kept = await findKeptDownload(identity, 'atlas.h5ad.gz', disk.environment);
  assert.equal(kept?.file.size, plain.length, 'kept decompressed under the picked file\'s identity');
});

test('a GitHub file whose parts this browser keeps is not head-read again on a later visit', async t => {
  // A later visit of gh:theislab/cellucid-demo-custom-datasets/files/… read
  // its whole 512 KiB head again (274 KB, the whole file) beside the
  // commits API; its head is in what was kept. Only enough for an LFS
  // pointer is read now.
  const { opfsOnDisk } = await import('./helpers/opfs-on-disk.mjs');
  const { keepDownload } = await import('../assets/js/data/anndata/transcode/space.js');
  const { HEAD_BYTES } = await import('../assets/js/formats/io/byte-source.js');
  const github = (await import('../assets/js/data/sources/providers/github.js')).default;
  const disk = opfsOnDisk({ handles: 'page' });
  const navigator = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value: { ...navigator, storage: disk.environment.navigator.storage, locks: disk.environment.navigator.locks }, configurable: true });
  t.after(() => Object.defineProperty(globalThis, 'navigator', { value: navigator, configurable: true }));
  const commit = '3'.repeat(40);
  const size = 300_000;
  const ranges = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.host === 'api.github.com') return new Response(JSON.stringify([{ sha: commit }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const range = new Headers(init.headers ?? {}).get('Range');
    ranges.push([init.method ?? 'GET', range]);
    if ((init.method ?? 'GET') === 'HEAD') return new Response(null, { status: 206, headers: { 'Content-Length': String(size), 'Content-Range': `bytes 0-${size - 1}/${size}` } });
    const [, start, end] = /bytes=(\d+)-(\d+)/.exec(range);
    const length = Math.min(size - 1, Number(end)) - Number(start) + 1;
    return new Response(new Uint8Array(length), { status: 206, headers: { 'Content-Length': String(length), 'Content-Range': `bytes ${start}-${Number(start) + length - 1}/${size}` } });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const first = await github.open('owner/repo/data/atlas.h5ad');
  assert.deepEqual(ranges.filter(([method]) => method === 'GET'), [['GET', `bytes=0-${HEAD_BYTES - 1}`]], 'a first visit reads the head with the probe');
  // What a first visit keeps of the file, at its address.
  async function* bytes() { yield new Uint8Array(16); }
  await keepDownload(first.file.resource.identity, bytes(), { name: 'atlas.h5ad', environment: disk.environment });
  ranges.length = 0;
  const again = await github.open('owner/repo/data/atlas.h5ad');
  assert.deepEqual(ranges.filter(([method]) => method === 'GET'), [['GET', 'bytes=0-1023']], 'a later visit reads only what tells an LFS pointer');
  assert.equal(again.file.resource.head, undefined, 'its head comes from what is kept');
  assert.equal(again.file.resource.identity.version, `commit:${commit}`);
});

test('a Zenodo file whose parts this browser keeps is not head-read again beside its record', async t => {
  // A later visit of zenodo:10850398/liao20_sub.h5ad read its 512 KiB head
  // again beside the record (0.53 MB, and one of Zenodo's 133 requests a
  // minute); the record names its size and version, and its head is kept.
  const { opfsOnDisk } = await import('./helpers/opfs-on-disk.mjs');
  const { keepDownload } = await import('../assets/js/data/anndata/transcode/space.js');
  const zenodo = (await import('../assets/js/data/sources/providers/zenodo.js')).default;
  const disk = opfsOnDisk({ handles: 'page' });
  const navigator = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value: { ...navigator, storage: disk.environment.navigator.storage, locks: disk.environment.navigator.locks }, configurable: true });
  t.after(() => Object.defineProperty(globalThis, 'navigator', { value: navigator, configurable: true }));
  const size = 900_000;
  const requests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const range = new Headers(init.headers ?? {}).get('Range');
    requests.push([init.method ?? 'GET', new URL(url).pathname, range]);
    if (url === 'https://zenodo.org/api/records/7') {
      return new Response(JSON.stringify({ id: 7, conceptrecid: '7', metadata: { title: 'Atlas' }, files: [{ key: 'atlas.h5ad', size, checksum: 'md5:aa' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const [, start, end] = /bytes=(\d+)-(\d+)/.exec(range ?? 'bytes=0-0');
    const length = Math.min(size - 1, Number(end)) - Number(start) + 1;
    return new Response(new Uint8Array(length), { status: 206, headers: { 'Content-Length': String(length), 'Content-Range': `bytes ${start}-${Number(start) + length - 1}/${size}` } });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const first = await zenodo.open('7/atlas.h5ad');
  assert.equal(requests.filter(([, , range]) => range !== null).length, 1, 'a first visit reads the head beside the record');
  async function* bytes() { yield new Uint8Array(16); }
  await keepDownload(first.file.resource.identity, bytes(), { name: 'atlas.h5ad', environment: disk.environment });
  requests.length = 0;
  const again = await zenodo.open('7/atlas.h5ad');
  assert.deepEqual(requests.map(([method, pathname]) => [method, pathname]), [['GET', '/api/records/7']], 'a later visit asks only the record');
  assert.equal(again.file.resource.identity.version, 'zenodo:7:md5:aa');
});

test('a file whose host stops answering readably is left unasked for a doubling while after two lost rounds, and its first answer ends that', async () => {
  // Zenodo answers with an HTML "unusual traffic" page (HTTP 403) without
  // CORS headers for a while after many requests: a page sees only failed
  // requests.
  const { createHostBook, HostNotAnswering } = await import('../assets/js/formats/io/hosts.js');
  let at = 0;
  const book = createHostBook({ now: () => at, after: () => () => {}, epoch: () => 1_800_000_000_000 + at, channel: null });
  const url = 'https://zenodo.org/api/records/7/files/a.h5ad/content';
  const answered = new Response(new Uint8Array(1), { status: 206 });
  // A file's range reads: many requests to one address no person asked one by one.
  const burst = { burst: true };
  assert.equal(book.answeredBefore(url), false);
  book.delivered(url);
  assert.equal(book.answeredBefore(url), true, 'a delivery says the host answers this site readably');

  // Six requests on their way together are lost once: one round.
  const round1 = Array.from({ length: 6 }, () => book.admit(url, burst));
  round1.forEach(done => done(null, { lost: true }));
  // A request cancelled is not a loss.
  const cancelled = book.admit(url, burst);
  cancelled(null);
  // Their retries: the second round.
  const retry = book.admit(url, burst);
  assert.equal(typeof retry, 'function', 'one lost round is not a stopped host (a momentary 503 without CORS headers)');
  retry(null, { lost: true });
  await assert.rejects(book.admit(url, burst), HostNotAnswering, 'two rounds in a row: not asked');
  assert.equal(book.admit(url, { waits: false, burst: true }), null);
  // Refused before it answered any of these requests: a refusal, not a
  // rate it could not bear (no pace: `hosts.js` `learnPace`).
  assert.equal(book.pace(url), 0);
  const asked = book.admit(url);
  assert.equal(typeof asked, 'function', 'a request a person asked for (a record, a file\'s details) is still sent');
  asked(null);
  at += 1000;
  const probe = book.admit(url, burst);
  assert.equal(typeof probe, 'function', 'asked again after RFC 6298\'s one second');
  probe(null, { lost: true });
  at += 1500;
  await assert.rejects(book.admit(url, burst), HostNotAnswering, 'the next wait is doubled');
  at += 600;
  const recovered = book.admit(url, burst);
  recovered(answered);
  const after = book.admit(url, burst);
  assert.equal(typeof after, 'function', 'a readable answer ends the wait');
  after(answered);
});

test('a host that stopped answering this site is said to refuse this network for now, a burst of reads waits it out asking it a few times, not each read twice, and ends when cancelled', async () => {
  const { fetchOnce, httpByteSource } = await import('../assets/js/formats/io/byte-source.js');
  const { createByteReader } = await import('../assets/js/formats/io/byte-reader.js');
  const { createHostBook } = await import('../assets/js/formats/io/hosts.js');
  const refused = async () => {
    throw new TypeError('Failed to fetch');
  };
  // First contact: CORS cannot be ruled out.
  await assert.rejects(fetchOnce('https://first.test/a.h5ad', {}, { fetchImpl: refused, hosts: createHostBook({ channel: null }) }), error => {
    assert.match(error.message, /no answer this page may read \(no connection, or an answer without CORS headers.*refusing requests from this network for now\)/);
    assert.equal(error.details.answeredBefore, false);
    return true;
  });

  const size = 64 << 20;
  let answers = 0;
  let refusedAsked = 0;
  const fetchImpl = async (url, init) => {
    if (answers >= 3) {
      refusedAsked++;
      throw new TypeError('Failed to fetch');
    }
    answers++;
    const [, start, end] = /bytes=(\d+)-(\d+)/.exec(new Headers(init.headers).get('Range'));
    const length = Number(end) - Number(start) + 1;
    return new Response(new Uint8Array(length), { status: 206, headers: { 'Content-Length': String(length), 'Content-Range': `bytes ${start}-${end}/${size}` } });
  };
  // The pace learned from the block is waited on a clock that jumps to each wait.
  let clock = 0;
  const hosts = createHostBook({ channel: null, now: () => clock, after: (ms, callback) => { const timer = setImmediate(() => { clock += ms; callback(); }); return () => clearImmediate(timer); } });
  const { LinkMeter } = await import('../assets/js/formats/io/link.js');
  const { REMOTE_POLICY } = await import('../assets/js/formats/io/byte-source.js');
  const jump = (ms, callback) => { const timer = setImmediate(() => { clock += ms; callback(); }); return () => clearImmediate(timer); };
  const link = new LinkMeter(REMOTE_POLICY, { clock: () => clock, after: jump });
  const source = httpByteSource({ url: 'https://zenodo.test/a.h5ad', size, name: 'a.h5ad' }, { fetch: fetchImpl, hosts });
  // Six at a time, as the byte reader sends a host's requests (`REMOTE_POLICY.concurrency`).
  let running = 0;
  const queue = [];
  const reader = {
    read: async (offset, length, options) => {
      while (running >= REMOTE_POLICY.concurrency) await new Promise(resolve => queue.push(resolve));
      running++;
      try {
        return await source.read(offset, length, { ...options, link });
      } finally {
        running--;
        queue.shift()?.();
      }
    },
  };
  // The file delivered ranges before: its reads wait the refusal out
  // (`refusesForNow`), told so, until they are no longer wanted.
  const cancel = new AbortController();
  const told = [];
  const reads = Array.from({ length: 40 }, (_, i) => reader.read(i * (1 << 20), 4096, { signal: cancel.signal, onWait: wait => { if (wait !== null) told.push(wait.text); } })
    .then(() => null, error => error));
  // Ten minutes of the host refusing, on the jumping clock.
  while (clock < 600_000) await new Promise(resolve => setImmediate(resolve));
  assert.ok(told.some(text => /zenodo\.test stopped answering this site, which it answered before: it may be refusing requests from this network for now .*Asking again in .*what was read is kept/.test(text)), told[0]);
  // Before: every read asked twice (74 requests to the refusing host), each failing.
  // Now: the first two rounds, then one probe per quiet (RFC 6298: 1 s doubling to 60 s): about 17 in ten minutes.
  assert.ok(refusedAsked <= 16 + 20, `${refusedAsked} requests reached the refusing host in ten minutes`);
  cancel.abort(new Error('no longer wanted'));
  const ended = (await Promise.all(reads)).filter(error => error !== null);
  assert.equal(ended.length, 37, 'the three answered reads gave their bytes; the waiting ones end when cancelled');
  for (const error of ended) assert.match(String(error?.message ?? error), /no longer wanted/);
});

test('a store folder whose host stops answering is asked for the folder, not twice for each of its objects', async () => {
  // A Zarr folder's every object is its own URL: losses counted by URL let a
  // refusing host be asked twice for each object (40 objects: 80 requests).
  const { httpStore } = await import('../assets/js/formats/zarr/stores/http.js');
  const { createHostBook } = await import('../assets/js/formats/io/hosts.js');
  let answers = 0;
  let refusedAsked = 0;
  const fetchImpl = async () => {
    if (answers >= 3) {
      refusedAsked++;
      throw new TypeError('Failed to fetch');
    }
    answers++;
    return new Response(new Uint8Array(16), { status: 200, headers: { 'Content-Length': '16' } });
  };
  // The pace learned from the block is waited on a clock that jumps to each wait.
  let clock = 0;
  const hosts = createHostBook({ channel: null, now: () => clock, after: (ms, callback) => { const timer = setImmediate(() => { clock += ms; callback(); }); return () => clearImmediate(timer); } });
  const { LinkMeter } = await import('../assets/js/formats/io/link.js');
  const { REMOTE_POLICY } = await import('../assets/js/formats/io/byte-source.js');
  const jump = (ms, callback) => { const timer = setImmediate(() => { clock += ms; callback(); }); return () => clearImmediate(timer); };
  const store = httpStore('https://refusing.test/atlas.zarr/', { fetch: fetchImpl, hosts, concurrency: new LinkMeter({ ...REMOTE_POLICY, concurrency: 6, streams: 6 }, { clock: () => clock, after: jump }) });
  // The folder delivered objects before: its reads wait the refusal out until cancelled.
  const cancel = new AbortController();
  const reads = Array.from({ length: 43 }, (_, i) => store.get(`X/data/${i}`, { signal: cancel.signal }).then(() => null, error => error));
  while (clock < 600_000) await new Promise(resolve => setImmediate(resolve));
  assert.ok(refusedAsked <= 14 + 20, `${refusedAsked} requests reached the refusing host in ten minutes`);
  cancel.abort(new Error('no longer wanted'));
  const ended = (await Promise.all(reads)).filter(error => error !== null);
  assert.equal(ended.length, 40);
  // Another folder of the same host, which never delivered an object, fails as before; a provider's own request is never held.
  const other = httpStore('https://refusing.test/other.zarr/', { fetch: fetchImpl, hosts, concurrency: 6 });
  await assert.rejects(other.get('zarr.json'), /stopped answering this site/);
  // A provider's own request is never held for the losses: only spaced at the host's pace.
  assert.equal(typeof await hosts.admit('https://refusing.test/api/record'), 'function');
});

test('a provider whose host gives no readable answer is said not to answer this site, not to refuse CORS', async t => {
  await import('./helpers/anndata-reader-in-process.mjs');
  const { LinkDataSource } = await import('../assets/js/data/link-source.js');
  const { DEFAULT_PROVIDERS, ProviderRegistry } = await import('../assets/js/data/sources/registry.js');
  const realFetch = globalThis.fetch;
  let asked = 0;
  globalThis.fetch = async () => {
    asked++;
    throw new TypeError('Failed to fetch');
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const source = new LinkDataSource({ registry: new ProviderRegistry(DEFAULT_PROVIDERS) });
  await assert.rejects(source.connect('zenodo:7/atlas.h5ad'), error => {
    assert.equal(error.message, 'Zenodo (zenodo.org) is not answering this site: no answer arrived. Zenodo lets other ' +
      'websites read it, so this is a problem on Zenodo\'s side (an outage, or a block of this network for a while after ' +
      'many requests from it) or this computer\'s connection, not the link or Cellucid. Try again later.');
    assert.equal(error.details.explained, true);
    return true;
  });
  source.disconnect();
  // The record (asked again once) and the head read beside it.
  assert.ok(asked <= 4, `${asked} requests`);
});

// ---------------------------------------------------------------------------
// Streams: refused from their first bytes, and left early without reading on.
// ---------------------------------------------------------------------------

/** An R serialization stream written as R writes it (XDR, version 3), for the R refusal cases. */
function rStream() {
  const parts = [];
  const int = value => {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setInt32(0, value, false);
    parts.push(bytes);
  };
  const writer = {
    int(value) { int(value); return writer; },
    raw(bytes) { parts.push(bytes); return writer; },
    flags(type, { object = false, attr = false, tag = false, levels = 0 } = {}) {
      return writer.int(type | (object ? 1 << 8 : 0) | (attr ? 1 << 9 : 0) | (tag ? 1 << 10 : 0) | (levels << 12));
    },
    chars(text) {
      const bytes = new TextEncoder().encode(text);
      return writer.flags(9, { levels: 64 }).int(bytes.length).raw(bytes);
    },
    symbol(name) { return writer.flags(1).chars(name); },
    header() { return writer.raw(Uint8Array.of(0x58, 0x0a)).int(3).int(0x040503).int(0x030500).int(5).raw(new TextEncoder().encode('UTF-8')); },
    /** `n` doubles that do not compress (so the gzip stream is as large as the payload). */
    doubles(n, seed = 1) {
      writer.flags(14).int(n);
      const payload = new Uint8Array(n * 8);
      const words = new Uint32Array(payload.buffer);
      let state = seed;
      for (let i = 0; i < words.length; i++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        words[i] = state >>> 0;
      }
      return writer.raw(payload);
    },
    /** A data frame of one column of `n` doubles. */
    dataFrame(n, seed) {
      writer.flags(19, { object: true, attr: true }).int(1).doubles(n, seed);
      writer.flags(2, { tag: true }).symbol('names').flags(16).int(1).chars('x');
      writer.flags(2, { tag: true }).symbol('class').flags(16).int(1).chars('data.frame');
      return writer.int(254);
    },
    bytes() {
      const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
      let offset = 0;
      for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
      }
      return out;
    },
  };
  return writer;
}

/** A byte reader over `bytes` that answers slowly and records every request, whether it was cancelled and whether it ended. */
function countingReader(bytes, name) {
  const requests = [];
  return {
    requests,
    name,
    size: bytes.length,
    identity: null,
    link: null,
    read(offset, length, { signal = null } = {}) {
      const request = { offset, length, aborted: false, ended: false };
      requests.push(request);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          request.ended = true;
          resolve(bytes.slice(offset, offset + length));
        }, 5);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          request.aborted = true;
          request.ended = true;
          reject(signal.reason);
        });
      });
    },
  };
}

test('an .rds whose object is not an S4 object is refused from its first bytes, not after its whole download', async () => {
  // GEO GSE131907's raw_UMI_matrix.rds.gz (a 604 MB data frame) is refused
  // from its first word, which says it is a list, not after its whole download.
  const { gzipSync } = await import('node:zlib');
  const { readRFile } = await import('../assets/js/formats/rds/index.js');
  const { rObjectPlan } = await import('../assets/js/data/anndata/transcode/r-object.js');
  const gzipped = new Uint8Array(gzipSync(rStream().header().dataFrame(1_000_000).bytes()));
  const file = countingReader(gzipped, 'raw_UMI_matrix.rds.gz');
  await assert.rejects(readRFile(file, { plan: rObjectPlan('raw_UMI_matrix.rds.gz') }), error => {
    assert.equal(error.name, 'RObjectRefusal');
    assert.equal(error.reason, 'not-single-cell');
    assert.match(error.message, /^raw_UMI_matrix\.rds\.gz holds an R list with a class \(a data frame, for one\), not a Seurat object/);
    assert.match(error.message, /told from its first bytes, nothing more of it was read/);
    return true;
  });
  const asked = file.requests.filter(request => !request.aborted).reduce((sum, request) => sum + request.length, 0);
  assert.ok(gzipped.length > 7_000_000);
  assert.ok(asked <= 1 << 20, `read ${asked} of ${gzipped.length} bytes before the refusal`);
  assert.ok(file.requests.length < 8, 'the stream stops with the refusal');
  // Uncompressed, read by ranges: the same refusal, before any payload.
  const plain = countingReader(rStream().header().dataFrame(1_000_000).bytes(), 'frame.rds');
  await assert.rejects(readRFile(plain, { plan: rObjectPlan('frame.rds') }), /frame\.rds holds an R list with a class/);
  assert.ok(plain.requests.reduce((sum, request) => sum + request.length, 0) <= (1 << 20) + 16);
});

test('a save() file passes its objects that are not S4 objects over as they stream, keeping nothing of them, and names them', async () => {
  const { readRFile } = await import('../assets/js/formats/rds/index.js');
  const { rObjectPlan } = await import('../assets/js/data/anndata/transcode/r-object.js');
  const writer = rStream();
  writer.raw(new TextEncoder().encode('RDX3\n')).header();
  writer.flags(2, { tag: true }).symbol('counts').dataFrame(200_000, 3);
  writer.flags(2, { tag: true }).symbol('ids').flags(13).int(3).int(1).int(2).int(3);
  writer.int(254);
  const bytes = writer.bytes();
  const parsed = await readRFile(countingReader(bytes, 'objects.rda'), { plan: rObjectPlan('objects.rda') });
  const [counts, ids] = parsed.root.items;
  assert.equal(counts.value.kind, 'skipped');
  assert.deepEqual({ ...counts.value.item }, { type: 'list', s4: false, classed: true });
  assert.ok(counts.value.bytes > 1_600_000, 'the bytes it spanned are counted');
  assert.equal(ids.value.kind, 'skipped');
  assert.equal(ids.value.item.type, 'integer');
  await assert.rejects(
    openDatasetStore({ source: { file: new File([bytes], 'objects.rda') } }, { decodedChunkCacheBytes: CACHE_BYTES, transcoding: { memory: true } }),
    /objects\.rda holds counts \(an R list with a class \(a data frame, for one\)\), ids \(an R integer vector or matrix\), not a Seurat object/
  );
});

test('a stream read for its start only asks a few small parts of the file and cancels the rest', async () => {
  // A MatrixMarket size line must not read the first 12 MB of a 7.6 GB GEO
  // matrix (three 4 MB requests), nor leave its decompressor and reads going
  // after it.
  const { gzipSync } = await import('node:zlib');
  const { textPieces, forEachLine } = await import('../assets/js/formats/text/lines.js');
  const lines = ['%%MatrixMarket matrix coordinate integer general', '3 800000 800000'];
  for (let e = 0; e < 800_000; e++) lines.push(`${1 + (e % 3)} ${e + 1} ${(e * 7919) % 1000}`);
  const gzipped = new Uint8Array(gzipSync(new TextEncoder().encode(lines.join('\n') + '\n')));
  const file = countingReader(gzipped, 'matrix.mtx.gz');
  let seen = 0;
  await forEachLine(await textPieces(file, { head: true }), () => ++seen < 2);
  assert.equal(seen, 2);
  // The rest is cancelled as the reader leaves: once every request ended
  // (answered or cancelled) and the decompressor's work is done.
  await until(() => file.requests.every(request => request.ended), 'every request answered or cancelled');
  await settle();
  const asked = file.requests.filter(request => !request.aborted).reduce((sum, request) => sum + request.length, 0);
  assert.ok(gzipped.length > 1_500_000);
  assert.ok(asked <= 192 * 1024, `asked ${asked} bytes for a size line`);
  assert.ok(file.requests.every(request => request.length <= 512 * 1024));
  // Nothing is left that could read on: a while later, still nothing has.
  const settled = file.requests.length;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(file.requests.length, settled, 'nothing reads on once the reader left');
});

test('a GEO matrix named by any last word is paired with its lists, so it opens or is refused for what it lacks', async () => {
  // GSE158055 (1.46M cells): `…_covid19_counts.mtx.gz` is a matrix Cellucid
  // opens from a link, not "not a file Cellucid opens from a link";
  // GSE132044 names its lists `_cell`/`_gene`.
  const { geoDatasets } = await import('../assets/js/data/sources/providers/geo.js');
  const { isMatrixMarketMatrix } = await import('../assets/js/data/matrix-market-files.js');
  const listing = (accession, names) => names.map(name => ({ name, url: `u/${name}`, path: `${accession}/${name}` }));
  const covid = geoDatasets(listing('GSE158055', [
    'GSE158055_cell_annotation.csv.gz', 'GSE158055_covid19_BCR_TCR.tar.gz', 'GSE158055_covid19_barcodes.tsv.gz',
    'GSE158055_covid19_counts.mtx.gz', 'GSE158055_covid19_features.tsv.gz', 'GSE158055_sample_metadata.xlsx',
  ]));
  assert.equal(covid.samples.length, 1);
  assert.equal(covid.samples[0].matrix.name, 'GSE158055_covid19_counts.mtx.gz');
  assert.equal(covid.samples[0].prefix, 'GSE158055_covid19_');
  assert.deepEqual(covid.samples[0].tables.map(file => file.name), ['GSE158055_cell_annotation.csv.gz']);
  const cortex = geoDatasets(listing('GSE132044', [
    'GSE132044_cortex_mm10_cell.tsv.gz', 'GSE132044_cortex_mm10_count_matrix.mtx.gz', 'GSE132044_cortex_mm10_gene.tsv.gz',
    'GSE132044_pbmc_hg38_cell.tsv.gz', 'GSE132044_pbmc_hg38_count_matrix.mtx.gz', 'GSE132044_pbmc_hg38_gene.tsv.gz',
  ]));
  assert.deepEqual(cortex.samples.map(sample => [sample.matrix.name, sample.features.name, sample.cells.name]), [
    ['GSE132044_cortex_mm10_count_matrix.mtx.gz', 'GSE132044_cortex_mm10_gene.tsv.gz', 'GSE132044_cortex_mm10_cell.tsv.gz'],
    ['GSE132044_pbmc_hg38_count_matrix.mtx.gz', 'GSE132044_pbmc_hg38_gene.tsv.gz', 'GSE132044_pbmc_hg38_cell.tsv.gz'],
  ]);
  assert.equal(isMatrixMarketMatrix('GSE158055_covid19_counts.mtx.gz'), true);
  assert.equal(isMatrixMarketMatrix('cells_x_genes.mtx'), false, 'kb-python names its lists after it: the transcoder pairs it');
});

test('a MatrixMarket folder none of whose tables names an embedding is refused from their first lines, before its lists, tables or matrix are read', async () => {
  const read = new Map();
  class CountedFile extends File {
    slice(start = 0, end = this.size, type) {
      read.set(this.name, (read.get(this.name) ?? 0) + (Math.min(end, this.size) - start));
      return super.slice(start, end, type);
    }
  }
  const nCells = 60_000;
  const barcodes = Array.from({ length: nCells }, (_, i) => `CELL${i}-1`);
  const entries = ['%%MatrixMarket matrix coordinate integer general', `2 ${nCells} ${nCells}`];
  for (let c = 0; c < nCells; c++) entries.push(`${1 + (c % 2)} ${c + 1} ${1 + (c % 7)}`);
  const annotation = ['cellName,sampleID,celltype,majorType', ...barcodes.map((cell, i) => `${cell},S${i % 40},type${i % 25},major${i % 5}`)];
  const encode = lines => new TextEncoder().encode(lines.join('\n') + '\n');
  const files = new Map([
    ['g/GSE1_covid19_counts.mtx', new CountedFile([encode(entries)], 'GSE1_covid19_counts.mtx')],
    ['g/GSE1_covid19_features.tsv', new CountedFile([encode(['G1\tG1', 'G2\tG2'])], 'GSE1_covid19_features.tsv')],
    ['g/GSE1_covid19_barcodes.tsv', new CountedFile([encode(barcodes)], 'GSE1_covid19_barcodes.tsv')],
    ['g/GSE1_cell_annotation.csv', new CountedFile([encode(annotation)], 'GSE1_cell_annotation.csv')],
  ]);
  await assert.rejects(
    openDatasetStore({ source: { files, rootName: 'g' } }, { decodedChunkCacheBytes: CACHE_BYTES, transcoding: { memory: true } }),
    error => {
      assert.match(error.message, /This MatrixMarket matrix \(g\/GSE1_covid19_counts\.mtx\) has no cell embedding.*\(it does not compute them\)/);
      return true;
    }
  );
  assert.ok((read.get('GSE1_cell_annotation.csv') ?? 0) <= 192 * 1024, `table: ${read.get('GSE1_cell_annotation.csv')} bytes`);
  assert.equal(read.get('GSE1_covid19_barcodes.tsv') ?? 0, 0, 'its lists are not read');
  assert.ok((read.get('GSE1_covid19_counts.mtx') ?? 0) <= 192 * 1024, 'its matrix: the size line only');
  assert.ok(files.get('g/GSE1_cell_annotation.csv').size > 1_000_000);
});

// ---------------------------------------------------------------------------
// A private window's storage that keeps less than it reports writing.
// ---------------------------------------------------------------------------

/**
 * Chromium's off-the-record storage: once a site's
 * share is spent, a synchronous access handle's `write` reports every byte
 * and keeps the ones that fit; `getSize` and `read` then show what was kept.
 */
function keepingAtMost(capacity) {
  let kept = 0;
  const wrapHandle = real => ({
    ...real,
    write(view, options) {
      const room = Math.max(0, capacity - kept);
      const take = Math.min(room, view.byteLength);
      if (take > 0) {
        real.write(new Uint8Array(view.buffer, view.byteOffset, take), options);
        kept += take;
      }
      return view.byteLength;
    },
    read: (view, options) => real.read(view, options),
    getSize: () => real.getSize(),
    truncate: size => real.truncate(size),
    flush: () => real.flush(),
    close: () => real.close(),
  });
  const wrapFile = file => ({ ...file, createSyncAccessHandle: async () => wrapHandle(await file.createSyncAccessHandle()) });
  const wrapDirectory = directory => ({
    ...directory,
    getDirectoryHandle: async (name, options) => wrapDirectory(await directory.getDirectoryHandle(name, options)),
    getFileHandle: async (name, options) => wrapFile(await directory.getFileHandle(name, options)),
    removeEntry: (name, options) => directory.removeEntry(name, options),
    entries: () => directory.entries(),
  });
  return wrapDirectory;
}

test('a write the storage reports whole and keeps in part is refused as the full storage it is, never read back short', async t => {
  // In Chromium's off-the-record context a payload of 40,000,000 bytes can be
  // kept as 29,060,298, and the UMAP of a 10M-cell Seurat object read back as
  // 94,031,122 of its 160,000,000 bytes: "Offset is outside the bounds of the
  // DataView".
  const { writeWhole, readWhole, KeptBytesMissing } = await import('../assets/js/formats/io/sync-access.js');
  let stored = new Uint8Array(0);
  const short = {
    write: (view, { at }) => {
      const next = new Uint8Array(Math.max(stored.length, Math.min(at + view.byteLength, 6)));
      next.set(stored);
      next.set(new Uint8Array(view.buffer, view.byteOffset, Math.max(0, Math.min(view.byteLength, 6 - at))), at);
      stored = next;
      return view.byteLength;
    },
    getSize: () => stored.length,
    read: (view, { at }) => {
      const part = stored.subarray(at, at + view.byteLength);
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength).set(part);
      return part.length;
    },
  };
  assert.throws(() => writeWhole(short, new Uint8Array(10), 0), error => error.name === 'QuotaExceededError' && /kept 6 of 10 bytes/.test(error.message));
  assert.throws(() => readWhole(short, new Uint8Array(10), 0), KeptBytesMissing);

  const { opfsOnDisk } = await import('./helpers/opfs-on-disk.mjs');
  const { openZipArchive } = await import('../assets/js/formats/zip/index.js');
  const { createByteReader } = await import('../assets/js/formats/io/byte-reader.js');
  const { blobByteSource, bytesByteSource } = await import('../assets/js/formats/io/byte-source.js');
  const { TRANSCODERS } = await import('../assets/js/data/anndata/transcode/index.js');
  const { readFileSync } = await import('node:fs');
  const archive = await openZipArchive(createByteReader(bytesByteSource(
    new Uint8Array(readFileSync(new URL('./fixtures/rds/corpus.zip', import.meta.url))), { name: 'corpus.zip' })));
  const file = new File([(await archive.entry('rds/seurat4.rds').read()).slice()], 'seurat4.rds', { lastModified: 1 });
  const disk = opfsOnDisk();
  t.after(disk.cleanup);
  const wrap = keepingAtMost(4096);
  const environment = {
    navigator: {
      storage: { ...disk.environment.navigator.storage, getDirectory: async () => wrap(await disk.environment.navigator.storage.getDirectory()) },
      locks: disk.environment.navigator.locks,
    },
  };
  await assert.rejects(
    TRANSCODERS.rds.transcode({ file }, { byteReaderOf: source => createByteReader(blobByteSource(source)), environment }),
    error => {
      assert.equal(error.details?.reason, 'storage-full');
      assert.match(error.message, /storage for this site is full after .* \(a private window gives a site little\)/);
      return true;
    }
  );
});
