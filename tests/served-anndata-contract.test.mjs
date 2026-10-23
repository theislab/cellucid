/**
 * A served AnnData store: what `cellucid serve`, `serve_anndata()` and
 * `show_anndata()` declare in `_cellucid/datasets` is read in place by the
 * browser's AnnData reader -- an `.h5ad` and a zipped Zarr store with range
 * requests, a Zarr store folder key by key -- under the server's dataset id
 * and name, with the server's launch defaults, by the remote source and by
 * the notebook bridge alike. The server here answers exactly as the Python
 * server does (`cellucid.anndata_server`): `206` with `Content-Range` for a
 * range, `HEAD` with the length, 404 for an absent Zarr key.
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { RemoteDataSource } from '../assets/js/data/remote-source.js';
import { JupyterBridgeDataSource } from '../assets/js/data/jupyter-source.js';
import { requireServedAnnData } from '../assets/js/data/served-anndata.js';
import { bytesByteSource } from '../assets/js/formats/io/byte-source.js';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { entryMap, openZipArchive } from '../assets/js/formats/zip/index.js';

const SERVER = 'http://127.0.0.1:8765';
const FIXTURES = new URL('./browser/fixtures/', import.meta.url);
const DEFAULTS = Object.freeze({
  embedding2d: { key: 'X_pca', columns: [3, 1] },
  knn: 'scvi_connectivities',
  normalizeEmbeddings: true,
  centroidMinPoints: 10,
});
const PROTOCOL = Object.freeze({
  events: ['click', 'command_error', 'data_mapping', 'debug_snapshot', 'hover', 'pong', 'ready', 'selection', 'session_bundle'],
  commands: ['clearHighlights', 'debug_snapshot', 'freeze', 'highlight', 'ping', 'requestSessionBundle', 'resetCamera', 'setColorBy', 'setDataMapping', 'setVisibility'],
});

function silenceNotifications(t) {
  const notifications = getNotificationCenter();
  const names = ['startDownload', 'updateDownload', 'completeDownload', 'failDownload', 'dismissDownload', 'warning', 'error', 'info', 'loading', 'complete', 'fail', 'dismiss'];
  const originals = new Map(names.map(name => [name, notifications[name]]));
  for (const name of names) notifications[name] = () => name;
  t.after(() => {
    for (const [name, method] of originals) {
      if (method === undefined) delete notifications[name];
      else notifications[name] = method;
    }
  });
}

function json(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** One resource as the Python server answers it: HEAD, a whole GET, or one range. */
function bytesResponse(bytes, method, range) {
  const headers = { 'Accept-Ranges': 'bytes', ETag: '"fixture"', 'Content-Type': 'application/octet-stream' };
  if (range === undefined) {
    return new Response(method === 'HEAD' ? null : bytes, {
      status: 200,
      headers: { ...headers, 'Content-Length': String(bytes.length) },
    });
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  assert.ok(match, `one exact byte range, got ${range}`);
  const start = match[1] === '' ? Math.max(0, bytes.length - Number(match[2])) : Number(match[1]);
  const end = match[1] === '' || match[2] === '' ? bytes.length - 1 : Math.min(Number(match[2]), bytes.length - 1);
  const part = bytes.subarray(start, end + 1);
  return new Response(method === 'HEAD' ? null : part, {
    status: 206,
    headers: { ...headers, 'Content-Length': String(part.length), 'Content-Range': `bytes ${start}-${end}/${bytes.length}` },
  });
}

async function zarrFolderKeys() {
  const bytes = new Uint8Array(await readFile(new URL('data-mapping-full.zarr.zip', FIXTURES)));
  const archive = await openZipArchive(createByteReader(bytesByteSource(bytes)), { name: 'data-mapping-full.zarr.zip' });
  const keys = new Map();
  for (const [key, entry] of entryMap(archive, 'data-mapping-full.zarr/')) {
    if (key !== '' && !key.endsWith('/')) keys.set(key, await entry.read());
  }
  return keys;
}

async function servedStore(layout) {
  if (layout === 'file') {
    const bytes = new Uint8Array(await readFile(new URL('data-mapping-full.h5ad', FIXTURES)));
    return { file: { url: '_cellucid/anndata/data-mapping-full.h5ad', kind: 'h5ad', layout, size: bytes.length }, bytes, type: 'h5ad' };
  }
  if (layout === 'zip') {
    const bytes = new Uint8Array(await readFile(new URL('data-mapping-full.zarr.zip', FIXTURES)));
    return { file: { url: '_cellucid/anndata/data-mapping-full.zarr.zip', kind: 'zarr', layout, size: bytes.length }, bytes, type: 'zarr' };
  }
  return { file: { url: '_cellucid/anndata/data-mapping-full.zarr/', kind: 'zarr', layout }, keys: await zarrFolderKeys(), type: 'zarr' };
}

/** The Python AnnData server, for one store. Returns the store requests seen. */
function installServer(t, store) {
  const original = globalThis.fetch;
  const storeRequests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(url.origin, SERVER);
    const path = decodeURIComponent(url.pathname.slice(1));
    const method = init.method ?? 'GET';
    const range = init.headers?.Range;
    if (path === '_cellucid/health') {
      return json({ status: 'ok', type: 'anndata', version: '1.2.3', format: store.file.kind, n_cells: 300, n_genes: 40 });
    }
    if (path === '_cellucid/info') {
      return json({ version: '1.2.3', type: 'anndata', format: store.file.kind, host: '127.0.0.1', port: 8765, n_cells: 300, n_genes: 40 });
    }
    if (path === '_cellucid/protocol') return json(PROTOCOL);
    if (path === '_cellucid/datasets') {
      return json({ datasets: [{ id: 'cells', name: 'Served cells', anndata: { file: store.file, defaults: DEFAULTS } }] });
    }
    const route = decodeURIComponent(store.file.url);
    if (store.bytes !== undefined && path === route) {
      storeRequests.push({ method, range });
      return bytesResponse(store.bytes, method, range);
    }
    if (store.keys !== undefined && path.startsWith(route)) {
      storeRequests.push({ method, range });
      const bytes = store.keys.get(path.slice(route.length));
      if (bytes === undefined) return new Response('absent', { status: 404 });
      return bytesResponse(bytes, method, range);
    }
    return new Response('not found', { status: 404 });
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return storeRequests;
}

/**
 * What a listing of the served store shows, read without opening it: the
 * server's id and name, the store's counts, and nothing open yet.
 */
function assertListedUnopened(source, summary) {
  assert.deepEqual(summary, {
    id: 'cells',
    name: 'Served cells',
    description: summary.description,
    stats: { n_cells: summary.stats.n_cells, n_genes: summary.stats.n_genes },
  });
  assert.ok(summary.stats.n_cells > 0, 'the store\'s own cell count');
  assert.equal(typeof summary.description, 'string');
  assert.equal(source.getAnnDataSource(), null, 'listing opens nothing');
  assert.throws(() => source.getBaseUrl('cells'), /not open/);
}

function assertOpenedWithServerIdentityAndDefaults(source, metadata, type) {
  assert.equal(metadata.id, 'cells');
  assert.equal(metadata.name, 'Served cells');
  assert.equal(source.getBaseUrl('cells'), `${type}://cells/`);
  assert.equal(source.datasetId, 'cells');
  const annData = source.getAnnDataSource();
  assert.equal(annData.getType(), type);
  const defaults = annData.getAdapter().getMappingCandidates().defaults;
  assert.deepEqual(defaults.embeddings.defaults['2d'], { key: 'X_pca', columns: [3, 1] });
  assert.equal(defaults.knn, 'scvi_connectivities');
}

for (const layout of ['file', 'zip', 'folder']) {
  test(`the remote source reads a served ${layout} in place, as the server names it`, async t => {
    silenceNotifications(t);
    const store = await servedStore(layout);
    const requests = installServer(t, store);
    const source = new RemoteDataSource();
    await source.connect({ url: SERVER });
    const [summary] = await source.listDatasets();
    assertListedUnopened(source, summary);
    // Choosing the dataset opens it, under the listing's id, name and counts.
    const metadata = await source.getMetadata('cells');
    assertOpenedWithServerIdentityAndDefaults(source, metadata, store.type);
    assert.equal(metadata.stats.n_cells, summary.stats.n_cells);
    assert.equal(metadata.stats.n_genes, summary.stats.n_genes);
    assert.equal(metadata.description, summary.description);
    // Only the bytes opening needed were read: ranges of a file, keys of a folder.
    if (layout === 'folder') {
      assert.ok(requests.every(request => request.method === 'GET'));
      assert.ok(requests.length < store.keys.size, 'a folder is read key by key, not whole');
    } else {
      assert.ok(requests.length > 0);
      assert.ok(
        requests.every(request => /^bytes=\d+-\d+$/.test(request.range ?? '')),
        'a file is only ever read by single byte ranges'
      );
    }
    // The metadata is the store's; asking again does not open it again.
    const count = requests.length;
    assert.equal(await source.getMetadata('cells'), metadata);
    assert.equal(requests.length, count);
    source.disconnect();
    assert.equal(source.getAnnDataSource(), null);
  });
}

test('the notebook bridge reads a served store in place and keeps its channel', async t => {
  silenceNotifications(t);
  const store = await servedStore('file');
  installServer(t, store);
  const listeners = new Map();
  const previousWindow = globalThis.window;
  globalThis.window = {
    location: new URL(`${SERVER}/?jupyter=true&viewerId=viewer-1&viewerToken=secret-1&anndata=true`),
    parent: {},
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) {
      listeners.get(type)?.delete(callback);
    },
  };
  t.after(() => {
    globalThis.window = previousWindow;
  });
  const source = new JupyterBridgeDataSource({ serverUrl: SERVER, viewerId: 'viewer-1', viewerToken: 'secret-1' });
  assert.equal(await source.initialize(), true);
  const [summary] = await source.listDatasets();
  assertListedUnopened(source, summary);
  const metadata = await source.getMetadata('cells');
  assertOpenedWithServerIdentityAndDefaults(source, metadata, 'h5ad');
  assert.equal(metadata.stats.n_cells, summary.stats.n_cells);
  // The notebook channel is the server's.
  assert.equal(source.acceptsEvent('selection'), true);
  assert.equal(listeners.get('message')?.size, 1);
  source.disconnect();
  assert.equal(source.getAnnDataSource(), null);
});

test('a served store is declared exactly', () => {
  const file = { url: '_cellucid/anndata/a%20b.h5ad', kind: 'h5ad', layout: 'file', size: 9 };
  const declared = requireServedAnnData({ file, defaults: {} }, 'anndata');
  assert.equal(declared.file.name, 'a b.h5ad');
  assert.equal(declared.file.route, file.url);
  assert.deepEqual(declared.defaults, {});
  for (const [label, value, match] of [
    ['an absolute URL', { ...file, url: 'http://elsewhere/a.h5ad' }, /route under/],
    ['a nested path', { ...file, url: '_cellucid/anndata/x/a.h5ad' }, /one file/],
    ['a parent segment', { ...file, url: '_cellucid/anndata/..' }, /canonically/],
    ['a missing size', { url: file.url, kind: 'h5ad', layout: 'file' }, /missing size/],
    ['an empty file', { ...file, size: 0 }, /positive byte length/],
  ]) {
    assert.throws(() => requireServedAnnData({ file: value, defaults: {} }, 'anndata'), match, label);
  }
  assert.throws(() => requireServedAnnData({ file }, 'anndata'), /missing defaults/);
});

test('concurrent metadata reads open the store once', async t => {
  silenceNotifications(t);
  const store = await servedStore('file');
  const requests = installServer(t, store);
  const once = new RemoteDataSource();
  await once.connect({ url: SERVER });
  await once.getMetadata('cells');
  const singleOpen = requests.length;
  once.disconnect();

  requests.length = 0;
  const source = new RemoteDataSource();
  await source.connect({ url: SERVER });
  const [first, second] = await Promise.all([
    source.getMetadata('cells'),
    source.getMetadata('cells'),
  ]);
  assert.equal(first, second);
  assert.equal(requests.length, singleOpen);
  assert.equal(await source.getMetadata('cells'), first);
  assert.equal(requests.length, singleOpen);
  source.disconnect();
});

test('a store that cannot be opened adopts nothing', async t => {
  silenceNotifications(t);
  const store = await servedStore('file');
  installServer(t, { ...store, bytes: new Uint8Array(store.bytes.length) });
  const source = new RemoteDataSource();
  await source.connect({ url: SERVER });
  await assert.rejects(source.listDatasets());
  await assert.rejects(source.getMetadata('cells'));
  assert.equal(source.getAnnDataSource(), null);
  assert.throws(() => source.getBaseUrl('cells'), /not open/);
  assert.equal(source.isConnected(), true);
});

test('a store still opening when the connection closes is released, not adopted', async t => {
  silenceNotifications(t);
  const store = await servedStore('file');
  installServer(t, store);
  const served = globalThis.fetch;
  let release;
  const held = new Promise(resolve => {
    release = resolve;
  });
  let holding = true;
  globalThis.fetch = async (input, init) => {
    if (holding && String(input).includes('/_cellucid/anndata/')) await held;
    return served(input, init);
  };
  const source = new RemoteDataSource();
  await source.connect({ url: SERVER });
  const opening = source.getMetadata('cells');
  const rejection = assert.rejects(opening);
  await new Promise(resolve => setImmediate(resolve));
  source.disconnect();
  holding = false;
  release();
  await rejection;
  assert.equal(source.getAnnDataSource(), null);
});

test('reading the dataset list again while a dataset opens does not cancel the open', async t => {
  silenceNotifications(t);
  const store = await servedStore('file');
  installServer(t, store);
  const served = globalThis.fetch;
  let release;
  const held = new Promise(resolve => {
    release = resolve;
  });
  let holding = false;
  globalThis.fetch = async (input, init) => {
    if (holding && String(input).includes('/_cellucid/anndata/')) await held;
    return served(input, init);
  };
  const source = new RemoteDataSource();
  await source.connect({ url: SERVER });
  await source.listDatasets();
  holding = true;
  const opening = source.getMetadata('cells');
  await new Promise(resolve => setImmediate(resolve));
  // The controls list every source while the startup dataset opens.
  holding = false;
  const relisted = source.listDatasets();
  release();
  const [metadata, [summary]] = await Promise.all([opening, relisted]);
  assert.equal(metadata.id, 'cells');
  assert.equal(summary.id, 'cells');
  assert.equal(source.getAnnDataSource()?.getType(), 'h5ad');
  assert.equal(await source.getMetadata('cells'), metadata, 'the open stands');
  source.disconnect();
});

test('a store the server declares unchanged is described once, however often the list is read', async t => {
  silenceNotifications(t);
  const store = await servedStore('file');
  const requests = installServer(t, store);
  const source = new RemoteDataSource();
  await source.connect({ url: SERVER });
  const [first] = await source.listDatasets();
  const described = requests.length;
  assert.ok(described > 0);
  const [again] = await source.listDatasets();
  assert.deepEqual(again, first);
  assert.equal(requests.length, described, 'the second listing reads nothing from the store');
  source.refresh();
  await source.listDatasets();
  assert.ok(requests.length > described, 'a refresh describes it again');
  source.disconnect();
});
