/**
 * Closing what a read goes through stops the read, wherever it is and
 * whoever asked for it; disconnecting a source, or an opening that fails,
 * leaves no request in flight.
 *
 * Every read through an open Zarr store or HDF5 file runs within the store's
 * lifetime (`utils/abort.js` `withinLifetime`), which `close()` aborts; the
 * reader closes its store on `leave` (`anndata-reader-worker.js`), not only
 * when the worker ends; and a link, remote or viewer-host opening that fails
 * cancels the requests it started beside the one that failed. Otherwise a
 * source disconnected while the reader kept a built gene index on disk would
 * leave that background read (`X/indptr/0` of a Zarr folder over HTTP) going
 * with no signal of its own, retrying a host that had stopped answering for
 * as long as the worker lives, and a contract suite's process would never end
 * (found under `scripts/slow-delivery-preload.mjs`).
 *
 * The host here answers every request after a delay and, once told to
 * hold, answers none: a held request ends only when its signal aborts. So
 * "no request left in flight" is proven by every held request ending, and
 * a read that could not be stopped would leave the test waiting.
 */
import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { getNotificationCenter } from '../assets/js/app/notification-center.js';
import { createByteReader } from '../assets/js/formats/io/byte-reader.js';
import { httpByteSource } from '../assets/js/formats/io/byte-source.js';
import { openHdf5 } from '../assets/js/formats/hdf5/index.js';
import { httpStore, openZarr } from '../assets/js/formats/zarr/index.js';
import { LinkDataSource } from '../assets/js/data/link-source.js';
import { RemoteDataSource } from '../assets/js/data/remote-source.js';
import { viewerProtocolDocument } from '../assets/js/data/viewer-protocol.js';
import { cancellationKind, cancelled, isCancellation, onAbort } from '../assets/js/utils/abort.js';
import { undoLater } from './helpers/teardown.mjs';
import { until } from './helpers/until.mjs';
import { zippedStoreEntries } from './helpers/zarr-corpus.mjs';

const FIXTURES = new URL('./fixtures/gene-read/', import.meta.url);
const H5AD = new Uint8Array(readFileSync(new URL('cellxgene-shaped.h5ad', FIXTURES)));
const STORE = await zippedStoreEntries(fileURLToPath(new URL('cellxgene-shaped.zarr.zip', FIXTURES)));
const DELAY_MS = 2;

function quiet(t) {
  const notifications = getNotificationCenter();
  const names = ['loading', 'complete', 'fail', 'dismiss', 'progress', 'updateProgress', 'warning', 'error', 'info',
    'startDownload', 'updateDownload', 'completeDownload', 'failDownload', 'dismissDownload'];
  const originals = new Map(names.map(name => [name, notifications[name]]));
  let next = 0;
  for (const name of names) notifications[name] = () => `close-stops-reads-${++next}`;
  const { log, warn, info } = console;
  console.log = () => {};
  console.warn = () => {};
  console.info = () => {};
  undoLater(t, () => {
    for (const [name, method] of originals) notifications[name] = method;
    Object.assign(console, { log, warn, info });
  });
}

/** One object's bytes as a static host answers: HEAD, a ranged GET (206), a whole GET. */
function bytesAnswer(bytes, init) {
  const base = { 'Accept-Ranges': 'bytes', ETag: `"${bytes.length}"` };
  if ((init?.method ?? 'GET') === 'HEAD') {
    return new Response(null, { status: 200, headers: { ...base, 'Content-Length': String(bytes.length) } });
  }
  const range = new Headers(init?.headers ?? {}).get('Range');
  if (range !== null) {
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    const start = Number(match[1]);
    const end = match[2] === '' ? bytes.length - 1 : Math.min(Number(match[2]), bytes.length - 1);
    return new Response(bytes.slice(start, end + 1), {
      status: 206,
      headers: { ...base, 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': String(end - start + 1) },
    });
  }
  return new Response(bytes.slice(), { status: 200, headers: { ...base, 'Content-Length': String(bytes.length) } });
}

function jsonAnswer(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * A host faked as `fetch` for test `t` (put back once everything the test
 * made is torn down: `undoLater`): `route(url, init)` answers, `DELAY_MS`
 * later; what it does not answer is a 404. `hold(url)` true (or `holding`
 * set) holds a request: it is answered never, and ends only when its signal
 * aborts. `open` counts the held requests not yet ended.
 */
function slowHost(t, route, { hold = () => false } = {}) {
  const original = globalThis.fetch;
  const host = { started: 0, open: 0, ended: 0, unstoppable: 0, holding: false, reasons: [] };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    host.started++;
    const signal = init.signal ?? null;
    if (host.holding || hold(url, init)) {
      host.open++;
      if (signal === null) host.unstoppable++;
      return new Promise((_resolve, reject) => {
        onAbort(signal, () => {
          host.open--;
          host.ended++;
          host.reasons.push(signal.reason);
          reject(signal.reason);
        });
      });
    }
    await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    if (signal?.aborted) throw signal.reason;
    return (await route(url, init)) ?? new Response('not found', { status: 404 });
  };
  undoLater(t, () => {
    globalThis.fetch = original;
  });
  return host;
}

/**
 * How `work` ended, once it has: a read that cannot be stopped never ends,
 * so the test waits for this (`until`, bounded) rather than for the read.
 */
function settling(work) {
  const outcome = { done: false, error: null };
  work.then(() => {
    outcome.done = true;
  }, error => {
    outcome.done = true;
    outcome.error = error;
  });
  return outcome;
}

/** Wait for `outcome` to end, then check it ended as `check` says. */
async function stopped(outcome, check, what) {
  await until(() => outcome.done, `${what} stopped`);
  assert.ok(outcome.error !== null, `${what} was stopped, not answered`);
  check(outcome.error);
}

const zarrRoute = prefix => (url, init) => {
  if (!url.startsWith(prefix)) return null;
  const entry = STORE.get(decodeURIComponent(url.slice(prefix.length)));
  return entry === undefined ? null : bytesAnswer(entry, init);
};

test('a read of a Zarr store over HTTP with no signal of its own stops when the store is closed, with the reason it is closed with', async t => {
  const prefix = 'https://data.example.org/close/hlca.zarr/';
  const host = slowHost(t, zarrRoute(prefix), { hold: url => url.includes('/X/') });
  for (const reason of [null, cancelled('released', 'The dataset was replaced under the read.')]) {
    const root = await openZarr(httpStore(prefix, { fetch: globalThis.fetch }));
    const ended = host.ended;
    // As a background pass reads: no signal.
    const read = settling(root.get('X/indptr').read());
    await until(() => host.open > 0, 'a chunk request held');
    if (reason === null) root.close();
    else root.close(reason);
    await stopped(read, error => {
      assert.ok(isCancellation(error), `a cancellation, not a failure: ${error}`);
      if (reason === null) assert.equal(cancellationKind(error), 'closed');
      else assert.equal(error, reason);
    }, 'the read');
    await until(() => host.open === 0, 'every held request ended');
    assert.ok(host.ended > ended);
  }
  assert.equal(host.unstoppable, 0, 'every request carries a signal');
  // A closed store reads nothing more.
  const root = await openZarr(httpStore(prefix, { fetch: globalThis.fetch }));
  root.close();
  const started = host.started;
  await assert.rejects(root.get('X/indptr').read(), /closed/);
  assert.equal(host.started, started);
});

test('a read of an HDF5 file over HTTP with no signal of its own stops when the file is closed', async t => {
  const url = 'https://data.example.org/close/hlca.h5ad';
  const host = slowHost(t, (asked, init) => (asked === url ? bytesAnswer(H5AD, init) : null));
  const reader = createByteReader(httpByteSource({ url, size: H5AD.length, name: 'hlca.h5ad' }, { fetch: globalThis.fetch }));
  const root = await openHdf5(reader, { load: ['X'] });
  // Opening read this small file whole: what it holds goes, so the read asks the host.
  reader.clear();
  host.holding = true;
  const read = settling(root.get('X/data').read());
  await until(() => host.open > 0, 'a range request held');
  root.close();
  await stopped(read, error => assert.equal(cancellationKind(error), 'closed', String(error)), 'the read');
  await until(() => host.open === 0, 'every held request ended');
  assert.equal(host.unstoppable, 0, 'every request carries a signal');
});

/** The first gene's read through `adapter`, left in flight: held once the host holds. */
function geneReadInFlight(adapter) {
  return settling(adapter.getGeneValues('var/0'));
}

test('a link to a Zarr folder: disconnecting it while a gene is read leaves no request in flight', async t => {
  quiet(t);
  const link = 'https://data.example.org/link/hlca.zarr/';
  const host = slowHost(t, zarrRoute(link));
  const source = new LinkDataSource();
  undoLater(t, () => source.disconnect());
  const connection = await source.connect(link);
  const id = connection.defaultDatasetId ?? connection.datasets[0].id;
  await source.getMetadata(id);
  const adapter = source.getAnnDataSource(id).getAdapter();
  host.holding = true;
  const read = geneReadInFlight(adapter);
  await until(() => host.open > 0, 'the gene read\'s request held');
  source.disconnect();
  await stopped(read, error => assert.ok(isCancellation(error), String(error)), 'the gene read');
  await until(() => host.open === 0, 'every held request ended');
  assert.equal(host.unstoppable, 0, 'every request carries a signal');
});

// A small file is read whole as it opens (the reader's first read of an
// HDF5 file or ZIP archive takes its head): it is disconnected while the
// reader worker's ranged reads of it are held.
for (const [format, name, bytes] of [
  ['an .h5ad file', 'hlca.h5ad', H5AD],
  ['a Zarr zip', 'hlca.zarr.zip', new Uint8Array(readFileSync(new URL('cellxgene-shaped.zarr.zip', FIXTURES)))],
]) {
  test(`a link to ${format}: disconnecting it while it is read leaves no request in flight`, async t => {
    quiet(t);
    const link = `https://data.example.org/link/${name}`;
    const host = slowHost(t, (url, init) => (url === link ? bytesAnswer(bytes, init) : null), {
      hold: (url, init) => new Headers(init?.headers ?? {}).has('Range') && host.reading,
    });
    host.reading = false;
    const source = new LinkDataSource();
    undoLater(t, () => source.disconnect());
    host.reading = true;
    const opening = settling(source.connect(link));
    await until(() => host.open > 0, 'a ranged read of the file held');
    source.disconnect();
    await stopped(opening, error => assert.ok(isCancellation(error), String(error)), 'the opening');
    await until(() => host.open === 0, 'every held request ended');
    assert.equal(host.unstoppable, 0, 'every request carries a signal');
  });
}

test('a served Zarr folder (cellucid serve): disconnecting while a gene is read leaves no request in flight', async t => {
  quiet(t);
  const server = 'http://127.0.0.1:8765';
  const folder = '_cellucid/anndata/hlca.zarr/';
  const counts = { n_cells: 1, n_genes: 1 };
  const host = slowHost(t, (url, init) => {
    const path = decodeURIComponent(new URL(url).pathname.slice(1));
    if (path === '_cellucid/health') return jsonAnswer({ status: 'ok', type: 'anndata', version: '1.2.3', format: 'zarr', ...counts });
    if (path === '_cellucid/info') return jsonAnswer({ version: '1.2.3', type: 'anndata', format: 'zarr', host: '127.0.0.1', port: 8765, ...counts, runtime: 'python' });
    if (path === '_cellucid/protocol') return jsonAnswer(viewerProtocolDocument());
    if (path === '_cellucid/datasets') {
      return jsonAnswer({ datasets: [{ id: 'cells', name: 'Served cells', anndata: { file: { url: folder, kind: 'zarr', layout: 'folder' }, defaults: {} } }] });
    }
    if (!path.startsWith(folder)) return null;
    const entry = STORE.get(path.slice(folder.length));
    return entry === undefined ? null : bytesAnswer(entry, init);
  });
  const source = new RemoteDataSource();
  undoLater(t, () => source.disconnect());
  await source.connect({ url: server });
  await source.listDatasets();
  await source.getMetadata('cells');
  host.holding = true;
  const read = geneReadInFlight(source.getAnnDataSource().getAdapter());
  await until(() => host.open > 0, 'the gene read\'s request held');
  source.disconnect();
  await stopped(read, error => assert.ok(isCancellation(error), String(error)), 'the gene read');
  await until(() => host.open === 0, 'every held request ended');
  assert.equal(host.unstoppable, 0, 'every request carries a signal');
});

test('a link whose opening fails leaves none of the requests it asked for beside the failed one in flight', async t => {
  quiet(t);
  // The Hub is asked for the revision and the path at once: the revision
  // is refused, and the path's answer is held.
  const host = slowHost(t, url => (url.includes('/revision/') ? jsonAnswer({ error: 'Repository not found' }, 404) : null), {
    hold: url => url.includes('/paths-info/'),
  });
  const source = new LinkDataSource();
  undoLater(t, () => source.disconnect());
  await assert.rejects(source.connect('hf:user/repo'), /does not exist or is not public/);
  await until(() => host.open === 0, 'the held paths-info request ended');
  assert.equal(host.ended, 1);
  assert.equal(host.unstoppable, 0, 'every request carries a signal');
});
