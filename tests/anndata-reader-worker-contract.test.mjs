/**
 * The AnnData reader worker's own contract: which reads it starts when, what
 * it reports while it reads, and how a file it cannot read is explained.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { activityReporter, createAnnDataReaderHandler } from '../assets/js/data/anndata-reader-worker.js';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';

const FIXTURE = new URL('./browser/fixtures/current-ui-smoke.h5ad', import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));

/**
 * A worker handler whose posted messages go to `events`; `onPost` hears each
 * one as it is posted.
 */
function handlerWith(events = [], onPost = null) {
  const handle = createAnnDataReaderHandler({ post: message => { events.push(message); onPost?.(message); } });
  return async (method, ...args) => {
    const { reply } = await handle({ id: 1, method, args });
    if (reply.error) {
      const error = new Error(reply.error.message);
      error.details = reply.error.details;
      throw error;
    }
    return reply.result;
  };
}

/** A fetch serving the fixture over HTTP range requests, counting them. */
function servingFixture() {
  const requests = [];
  const fetch = async (url, { headers }) => {
    const [, start, end] = /bytes=(\d+)-(\d+)/.exec(headers.Range);
    requests.push([Number(start), Number(end)]);
    return new Response(bytes.slice(Number(start), Number(end) + 1), { status: 206 });
  };
  return { fetch, requests };
}

/** A fetch serving the fixture over a link with `latency` ms round trips and `rate` bytes per ms. */
function servingOverLink(latency, rate) {
  return async (url, { headers, signal }) => {
    const [, start, end] = /bytes=(\d+)-(\d+)/.exec(headers.Range);
    const body = bytes.slice(Number(start), Number(end) + 1);
    await new Promise(resolve => setTimeout(resolve, latency + body.length / rate));
    if (signal?.aborted) throw signal.reason;
    return new Response(body, { status: 206 });
  };
}

test('a cell-major matrix is indexed by gene at open over a link as fast as a disk, a dense one and any over a slower link at the first gene', async t => {
  // The index of a cell-major matrix reads its whole index array: over a
  // slow link that waits until a gene is shown, so opening downloads only
  // what its first view draws. The decision follows the link the reader
  // measured while opening, not where the file is.
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const isIndex = event => event.event === 'activity' && event.kind === 'index';
  const indexStarted = events => events.some(isIndex);
  // What is not started by `prepareMatrix` is decided there, before it
  // returns (`AnnDataReader.prepareMatrix`); a while after, it still is not.
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));

  // A local cell-major (CSR) matrix: its index starts at once, on its own,
  // once the matrix's layout is read (whenever the file's reads answer): the
  // test waits for the index's activity, not for a while.
  const csr = new Uint8Array(readFileSync(new URL('./browser/fixtures/legacy-twin-current.h5ad', import.meta.url)));
  const local = [];
  let indexPosted;
  const localIndex = new Promise(resolve => { indexPosted = resolve; });
  const localCall = handlerWith(local, message => { if (isIndex(message)) indexPosted(message); });
  await localCall('open', { source: { file: new File([csr], 'csr.h5ad') } });
  assert.ok(!indexStarted(local), 'nothing is indexed before the matrix is prepared');
  await localCall('prepareMatrix', 'X');
  await localIndex;
  assert.ok(indexStarted(local), 'a local CSR file starts its index at once');

  // A dense matrix's index holds every value: even local, it is built when
  // its first gene is asked for, never ahead.
  const dense = [];
  const denseCall = handlerWith(dense);
  await denseCall('open', { source: { file: new File([bytes], 'x.h5ad') } });
  await denseCall('prepareMatrix', 'X');
  await settle();
  assert.ok(!indexStarted(dense), 'a dense matrix is not indexed ahead');
  await denseCall('getMatrixColumn', 'X', 0);
  assert.ok(indexStarted(dense), 'its first gene starts its index');

  // A slow link: a 20 ms round trip, 100 kB/s.
  globalThis.fetch = servingOverLink(20, 100);
  const slow = [];
  const slowCall = handlerWith(slow);
  await slowCall('open', { source: { file: { url: 'https://example.org/x.h5ad', size: bytes.length, name: 'x.h5ad' } } });
  await slowCall('prepareMatrix', 'X');
  await settle();
  assert.ok(!indexStarted(slow), 'a file over a slow link does not');
  await slowCall('getMatrixColumn', 'X', 0);
  assert.ok(indexStarted(slow), 'its first gene starts it');
});

test('a remote file reports its transfers, and every read operation reports its activity', async t => {
  const { fetch, requests } = servingFixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const events = [];
  const call = handlerWith(events);
  await call('open', {
    source: { file: { url: 'https://example.org/x.h5ad', size: bytes.length, name: 'x.h5ad' } },
  });
  await call('getObsField', 'cell_type');
  await call('getMatrixColumns', 'X', [0, 5]);
  const transfers = events.filter(event => event.event === 'transfer');
  assert.ok(transfers.length > 0);
  assert.equal(transfers.at(-1).reads, requests.length, 'running totals count every request');
  assert.equal(transfers.at(-1).url, 'https://example.org/x.h5ad');
  const finished = events.filter(event => event.event === 'activity' && event.status !== 'running');
  const labels = finished.map(event => `${event.kind}:${event.label}`);
  assert.ok(labels.includes('open:the structure of x.h5ad'), labels.join(' | '));
  assert.ok(labels.includes("field:obs['cell_type']"), labels.join(' | '));
  assert.ok(labels.some(label => label.startsWith('genes:2 genes of X')), labels.join(' | '));
  for (const event of finished) {
    assert.equal(event.status, 'done');
    assert.ok(Number.isSafeInteger(event.requests) && event.requests >= 0);
    assert.ok(event.elapsedMs >= 0);
  }
  const fetchedTotal = finished.reduce((sum, event) => sum + event.bytesFetched, 0);
  assert.ok(fetchedTotal > 0 && fetchedTotal <= bytes.length, 'operations account for what was fetched');
});

test('an activity\'s last change is posted even when nothing changes after it', async () => {
  // A whole R file from a fast host arrives within one reporting interval and
  // is then parsed: the bytes that arrived are shown, not the 0 B of the
  // first report, until the pass ends.
  const posts = [];
  const activity = activityReporter(message => posts.push(message))({ kind: 'transcode', label: 'pancreas.rds' });
  activity.expect(9_816_256);
  for (let piece = 0; piece < 3; piece += 1) activity.fetched(3_272_085, 1);
  assert.equal(posts.length, 1, 'changes within the interval wait for it to end');
  assert.equal(posts[0].bytesFetched, 0);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(posts.length, 2, 'the interval ends with one post of the latest state');
  assert.equal(posts[1].status, 'running');
  assert.equal(posts[1].bytesFetched, 9_816_255);
  activity.finish();
  assert.equal(posts.at(-1).status, 'done');
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(posts.at(-1).status, 'done', 'nothing is posted after the end');

  // An activity that ends within the interval posts its end only.
  const quick = [];
  const brief = activityReporter(message => quick.push(message))({ kind: 'open', label: 'x' });
  brief.expect(10);
  brief.fetched(10, 1);
  brief.finish();
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.deepEqual(quick.map(post => post.status), ['running', 'done']);
});

test('a file that is not HDF5, or is damaged, is explained', async () => {
  const call = handlerWith();
  await assert.rejects(
    call('open', { source: { file: new File([new TextEncoder().encode('not an hdf5 file at all')], 'x.h5ad') } }),
    error => /not a valid HDF5 file, so it cannot be an AnnData \(\.h5ad\) file/.test(error.message) && error.details?.explained === true
  );
  await assert.rejects(
    call('open', { source: { file: new File([bytes.subarray(0, 4000)], 'cut.h5ad') } }),
    error => /could not be read .*corrupted or truncated/s.test(error.message) && error.details?.explained === true
  );
  await assert.rejects(
    call('open', { source: { file: new File([], 'empty.h5ad') } }),
    error => /empty/.test(error.message)
  );
});

test('the Transfers log counts reads per file or catalog and closes only its own entry', async () => {
  const { TransferLog } = await import('../assets/js/data/transfer-log.js');
  const lines = [];
  const log = new TransferLog({ console: { info: line => lines.push(line), error() {} } });
  const file = log.begin({ key: 'https://h.org/a.h5ad', label: 'a', why: 'on demand', total: 2048 });
  const catalog = log.begin({ key: 'https://h.org/exports/', label: 'exports', why: 'on demand' });
  log.record('https://h.org/a.h5ad', { bytes: 1024, requests: 2, absolute: true });
  log.record('https://h.org/exports/x/obs/0.bin.gz', { bytes: 10 });
  log.record('https://h.org/exports/x/obs/1.bin.gz', { bytes: 5 });
  log.record('https://elsewhere.org/z', { bytes: 99 });
  assert.deepEqual(log.entries().map(entry => [entry.key, entry.bytes, entry.requests]), [
    ['https://h.org/exports/', 15, 2],
    ['https://h.org/a.h5ad', 1024, 2],
  ]);
  const reopened = log.begin({ key: 'https://h.org/a.h5ad', label: 'a', why: 'on demand' });
  log.finish(file);
  assert.equal(log.entries().find(entry => entry.key === 'https://h.org/a.h5ad').status, 'active');
  log.finish(reopened, { error: new Error('gone') });
  log.finish(catalog);
  assert.deepEqual(log.entries().map(entry => entry.status), ['failed', 'closed']);
  assert.ok(lines.every(line => line.startsWith('[cellucid:transfer] ')));
  assert.ok(lines.every(line => !line.includes('?')), 'no query string is ever logged');
});

test('the read activity log keeps the open dataset\'s operations and describes them', async () => {
  const { describeReadActivity, getReadActivityLog } = await import('../assets/js/data/read-activity-log.js');
  const log = getReadActivityLog();
  log.clear();
  const seen = [];
  const unsubscribe = log.subscribe(activity => seen.push(activity.id));
  const original = console.debug;
  const debugCalls = [];
  console.debug = (...args) => debugCalls.push(args);
  try {
    log.record({ id: 1, kind: 'genes', label: '2 genes of X', status: 'running', requests: 1, bytesFetched: 100, cacheHits: 0, chunks: 0, decodedBytes: 0, elapsedMs: 5, progress: null, detail: null });
    log.record({ id: 1, kind: 'genes', label: '2 genes of X', status: 'done', requests: 3, bytesFetched: 4096, cacheHits: 1, chunks: 2, decodedBytes: 8192, elapsedMs: 12, progress: null, detail: null });
    log.record({ id: 2, kind: 'genes', label: '1 gene of X', status: 'done', requests: 1, bytesFetched: 10, cacheHits: 0, chunks: 0, decodedBytes: 0, elapsedMs: 3, progress: null, detail: null });
    assert.deepEqual(seen, [], 'reports are acted on once per frame, not as they arrive');
    log.flush();
  } finally {
    console.debug = original;
    unsubscribe();
  }
  // One announcement per operation per flush, with its latest report; the
  // operations that ended quietly are one debug entry, a line each.
  assert.deepEqual(seen, [1, 2]);
  assert.equal(debugCalls.length, 1);
  assert.equal(debugCalls[0][0].split('\n').length, 2);
  assert.match(debugCalls[0][0], /^\[cellucid:read\] 2 genes of X — /);
  log.clear();
  log.record({ id: 3, kind: 'genes', label: '1 gene of X', status: 'done', requests: 1, bytesFetched: 4096, cacheHits: 0, chunks: 0, decodedBytes: 0, elapsedMs: 3, progress: null, detail: null });
  log.record({ id: 1, kind: 'genes', label: '2 genes of X', status: 'done', requests: 3, bytesFetched: 4096, cacheHits: 1, chunks: 2, decodedBytes: 8192, elapsedMs: 12, progress: null, detail: null });
  console.debug = () => {};
  try {
    // Reading the log acts on what it has taken in.
    assert.equal(log.entries().length, 2);
  } finally {
    console.debug = original;
  }
  log.clear();
  log.record({ id: 1, kind: 'genes', label: '2 genes of X', status: 'done', requests: 3, bytesFetched: 4096, cacheHits: 1, chunks: 2, decodedBytes: 8192, elapsedMs: 12, progress: null, detail: null });
  console.debug = () => {};
  try {
    log.flush();
  } finally {
    console.debug = original;
  }
  assert.equal(log.entries().length, 1, 'one entry per operation, updated in place');
  assert.deepEqual(log.totals(), { operations: 1, requests: 3, bytesFetched: 4096, decodedBytes: 8192 });
  assert.match(describeReadActivity(log.entries()[0]), /^2 genes of X — 4\.0 KB read, 3 requests, 1 from cache, 2 chunks decoded to 8\.0 KB, 12 ms \(done\)$/);
  log.clear();
  assert.equal(log.entries().length, 0);
});

test('the store and the reader keep decoded chunks within the decoded-block residency budget', async () => {
  const { residencyBudgetBytes } = await import('../assets/js/data/memory-budget.js');
  const source = readFileSync(new URL('../assets/js/data/anndata-reader-worker.js', import.meta.url), 'utf8');
  assert.match(source, /decodedChunkCacheBytes: residencyBudgetBytes\('decodedBlocks'\)/);
  assert.match(source, /decodedChunkBytes: residencyBudgetBytes\('decodedBlocks'\)/);
  assert.ok(residencyBudgetBytes('decodedBlocks') > 0);
});

/** A client over the in-process worker, with the messages the worker received. */
async function openedClient(t) {
  const { createInProcessAnnDataReaderWorker } = await import('./helpers/anndata-reader-in-process.mjs');
  const { AnnDataReaderClient, setAnnDataReaderWorkerFactory } = await import('../assets/js/data/anndata-reader-client.js');
  let worker = null;
  setAnnDataReaderWorkerFactory(() => {
    worker = createInProcessAnnDataReaderWorker();
    return worker;
  });
  const client = new AnnDataReaderClient();
  t.after(() => {
    client.close();
    setAnnDataReaderWorkerFactory(() => createInProcessAnnDataReaderWorker());
  });
  await client.open({ file: new File([bytes], 'x.h5ad') });
  const sent = () => worker.messages.filter(message => message.method !== 'open' && message.method !== 'prepareMatrix');
  return { client, sent };
}

test('genes asked for in one task go to the worker as one request, each caller owning its array', async t => {
  const { client, sent } = await openedClient(t);
  const expected = await client.getMatrixColumns('X', [0, 2, 5]);
  const before = sent().length;
  const [a, b, again, c] = await Promise.all([
    client.getMatrixColumn('X', 0),
    client.getMatrixColumn('X', 2),
    client.getMatrixColumn('X', 0),
    client.getMatrixColumn('X', 5),
  ]);
  const requests = sent().slice(before);
  // Then the job the read is for (none for a view's genes), the shared
  // loads it serves (none named here), and whether a caller waits to see
  // the genes on more cells as they are read (none here).
  assert.deepEqual(requests.map(message => [message.method, message.args]), [['getMatrixColumns', ['X', [0, 2, 5], null, [], false]]]);
  assert.deepEqual(Array.from(a), Array.from(expected[0]));
  assert.deepEqual(Array.from(b), Array.from(expected[1]));
  assert.deepEqual(Array.from(c), Array.from(expected[2]));
  assert.deepEqual(Array.from(again), Array.from(a), 'a gene asked twice is read once');
  assert.notEqual(again.buffer, a.buffer, 'and each caller gets its own array');

  // A gene alone keeps its own request.
  const single = await client.getMatrixColumn('X', 3);
  assert.equal(single.length, 120);
  assert.deepEqual(sent().at(-1).method, 'getMatrixColumn');
});

test('a cancelled read rejects at once and cancels its worker request once no caller wants it', async t => {
  const { client, sent } = await openedClient(t);
  // One of two genes cancelled: the request goes on for the other.
  const keep = client.getMatrixColumn('X', 1);
  const dropping = new AbortController();
  const dropped = client.getMatrixColumn('X', 4, { signal: dropping.signal });
  dropping.abort();
  await assert.rejects(dropped, { name: 'AbortError' });
  assert.equal((await keep).length, 120);
  assert.equal(sent().filter(message => message.cancel !== undefined).length, 0);

  // Every gene of a request cancelled after it was sent: the worker is told,
  // and the reader's read is aborted.
  const original = AnnDataReader.prototype.getMatrixColumns;
  let readerSignal = null;
  AnnDataReader.prototype.getMatrixColumns = function (element, genes, { signal }) {
    readerSignal = signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  };
  try {
    const controller = new AbortController();
    const both = [
      client.getMatrixColumn('X', 2, { signal: controller.signal }),
      client.getMatrixColumn('X', 3, { signal: controller.signal }),
    ];
    while (readerSignal === null) await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    for (const read of both) await assert.rejects(read, { name: 'AbortError' });
    const request = sent().find(message => message.method === 'getMatrixColumns' && message.args[1].includes(3));
    assert.ok(sent().some(message => message.cancel === request.id), 'the worker request is cancelled');
    assert.equal(readerSignal.aborted, true, 'and so is the reader\'s read');
  } finally {
    AnnDataReader.prototype.getMatrixColumns = original;
  }

  // Other reads take the same signal; one aborted beforehand sends nothing.
  const count = sent().length;
  await assert.rejects(client.getObsField('score', { signal: AbortSignal.abort() }), { name: 'AbortError' });
  await assert.rejects(client.readEmbedding('X_umap', [0, 1], true, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(sent().length, count);
  // The client still answers afterwards.
  assert.equal((await client.getObsField('score')).values.length, 120);
});

test('the worker cancels a request by id and answers it with an AbortError', async () => {
  const handle = createAnnDataReaderHandler();
  await handle({ id: 1, method: 'open', args: [{ source: { file: new File([bytes], 'x.h5ad') } }] });
  const original = AnnDataReader.prototype.getObsField;
  let seen = null;
  AnnDataReader.prototype.getObsField = function (key, { signal }) {
    seen = signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  };
  try {
    const answer = handle({ id: 2, method: 'getObsField', args: ['score'] });
    while (seen === null) await new Promise(resolve => setImmediate(resolve));
    assert.equal(await handle({ cancel: 2 }), null, 'a cancel has no reply of its own');
    assert.equal(seen.aborted, true);
    const { reply } = await answer;
    assert.equal(reply.id, 2);
    assert.equal(reply.error.name, 'AbortError');
    assert.equal(await handle({ cancel: 99 }), null, 'cancelling a finished request does nothing');
  } finally {
    AnnDataReader.prototype.getObsField = original;
  }
});

test('genes in a few cells are read by cell through the worker and the adapter, equal to their columns', async t => {
  const { client } = await openedClient(t);
  const columns = await client.getMatrixColumns('X', [0, 1, 2, 3, 4, 5]);
  const cells = [7, 3, 99];
  const block = await client.getMatrixCellSubset('X', cells, [5, 0, 2]);
  assert.ok(block !== null, 'a dense matrix is read by cell for a few cells');
  [5, 0, 2].forEach((gene, g) => {
    const values = new Array(cells.length).fill(0);
    for (let entry = block.pointers[g]; entry < block.pointers[g + 1]; entry++) {
      values[block.cellIndex[entry]] = block.values[entry];
    }
    assert.deepEqual(values, cells.map(cell => columns[gene][cell]));
  });
  // Every cell of one gene: read by gene, the same values as its column.
  const all = Array.from({ length: 120 }, (_, cell) => cell);
  const byGene = await client.getMatrixCellSubset('X', all, [0]);
  const gene0 = new Array(all.length).fill(0);
  for (let entry = byGene.pointers[0]; entry < byGene.pointers[1]; entry++) gene0[byGene.cellIndex[entry]] = byGene.values[entry];
  assert.deepEqual(gene0, Array.from(columns[0]));

  const { BaseAnnDataAdapter } = await import('../assets/js/data/base-anndata-adapter.js');
  const adapter = new BaseAnnDataAdapter(client);
  await adapter.initialize();
  const subset = await adapter.getGeneCellSubset(['var/5', 'var/2'], cells);
  [5, 2].forEach((gene, g) => {
    const values = new Array(cells.length).fill(0);
    for (let entry = subset.pointers[g]; entry < subset.pointers[g + 1]; entry++) {
      values[subset.cellIndex[entry]] = subset.values[entry];
    }
    assert.deepEqual(values, cells.map(cell => columns[gene][cell]));
  });
  await assert.rejects(adapter.getGeneCellSubset([], cells), /at least one gene/);
});

test('opening another cell subset of the same file reads through the store already open: no structure read again', async t => {
  const { fetch, requests } = servingFixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const call = handlerWith();
  const file = { url: 'https://example.org/x.h5ad', size: bytes.length, name: 'x.h5ad', identity: { kind: 'remote', key: 'x', version: '"v1"' } };
  const all = await call('open', { source: { file } });
  const every = await call('getObsField', 'cell_type');
  const everyName = Array.from(every.codes, code => every.categories[code]);
  const k = Math.ceil(all.nObs / 2);
  const opening = requests.length;
  const half = await call('open', { source: { file }, cellSubset: { mode: 'subsample', method: 'uniform', k, seed: 7 } });
  assert.equal(half.nObs, k);
  assert.equal(requests.length, opening, 'the structure is not read again');
  // The kept cells, in the order they open (their priority order), read
  // through the store the first open read.
  const kept = half.cellSubset.openOrder;
  const keptField = await call('getObsField', 'cell_type');
  assert.deepEqual(Array.from(keptField.codes, code => keptField.categories[code]), Array.from(kept, cell => everyName[cell]));
  // Another version of the file is opened anew.
  const before = requests.length;
  await call('open', { source: { file: { ...file, identity: { ...file.identity, version: '"v2"' } } } });
  assert.ok(requests.length > before, 'a new version reads its structure');
});

test('another subsample of the same method and seed, opened in place, takes over the gene index of the cells both keep', async t => {
  const { fetch, requests } = servingFixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const file = { url: 'https://example.org/x.h5ad', size: bytes.length, name: 'x.h5ad', identity: { kind: 'remote', key: 'x', version: '"v1"' } };
  const request = k => ({ mode: 'subsample', method: 'uniform', k, seed: 7 });
  // A fresh opening at 30 cells: its gene index is not built.
  const fresh = handlerWith();
  await fresh('open', { source: { file }, cellSubset: request(30) });
  assert.equal((await fresh('geneReadPlan', 'X')).built, false);
  const freshGene = await fresh('getMatrixColumn', 'X', 1);
  // Opened at 90, its index built (a gene read, then every segment), then
  // lowered to 30 in place: the 30 are the first 30 of the 90 (priority
  // order), and their index is the 90's, cut.
  const call = handlerWith();
  const wide = await call('open', { source: { file }, cellSubset: request(90) });
  await call('getMatrixColumn', 'X', 1);
  for (let wait = 0; (await call('geneReadPlan', 'X')).built !== true; wait++) {
    assert.ok(wait < 500, 'the index of the 90 is built');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const lowered = await call('open', { source: { file }, cellSubset: request(30) });
  assert.deepEqual(lowered.cellSubset.openOrder, wide.cellSubset.openOrder.subarray(0, 30));
  assert.equal((await call('geneReadPlan', 'X')).built, true, 'the index is taken over');
  assert.deepEqual(Array.from(await call('getMatrixColumn', 'X', 1)), Array.from(freshGene));
  // Raised again to 90: the 30's index is taken over, the rest is to read.
  const raised = await call('open', { source: { file }, cellSubset: request(90) });
  assert.deepEqual(raised.cellSubset.openOrder, wide.cellSubset.openOrder);
  const plan = await call('geneReadPlan', 'X');
  assert.equal(plan.built, false);
  assert.equal(plan.progressive?.done ?? 30, 30);
});

test('a reader in a new worker fetches nothing another reader of the same file fetched: the page keeps the ranges', async t => {
  const { createByteRangeCache } = await import('../assets/js/data/byte-range-cache.js');
  const { adoptRangeCachePort } = await import('../assets/js/formats/io/range-cache.js');
  const { fetch, requests } = servingFixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetch;
  const cache = createByteRangeCache({ budgetBytes: 64 * 1024 * 1024 });
  const { port1, port2 } = new MessageChannel();
  cache.connect(port1);
  adoptRangeCachePort(port2);
  t.after(() => {
    globalThis.fetch = originalFetch;
    adoptRangeCachePort(null);
    port1.close();
  });
  const file = { url: 'https://example.org/x.h5ad', size: bytes.length, name: 'x.h5ad', identity: { kind: 'remote', key: 'x', version: '"v1"' } };
  const first = handlerWith();
  await first('open', { source: { file } });
  const codes = (await first('getObsField', 'cell_type')).codes;
  const fetchedByFirst = requests.length;
  // What a worker hands the page arrives as messages do.
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(cache.stats().bytes > 0, 'the first reader handed its ranges to the page');
  // Another worker (a new handler: its own reader, its own store).
  const second = handlerWith();
  await second('open', { source: { file } });
  assert.deepEqual(Array.from((await second('getObsField', 'cell_type')).codes), Array.from(codes));
  assert.equal(requests.length, fetchedByFirst, 'the second reader fetched nothing the first one had');
  // Another version of the file shares nothing.
  const third = handlerWith();
  await third('open', { source: { file: { ...file, identity: { ...file.identity, version: '"v2"' } } } });
  assert.ok(requests.length > fetchedByFirst);
});

test('a reader\'s channel to the page\'s byte range cache ends with it: no channel is left open', async t => {
  const { createInProcessAnnDataReaderWorker } = await import('./helpers/anndata-reader-in-process.mjs');
  const { AnnDataReaderClient, setAnnDataReaderWorkerFactory } = await import('../assets/js/data/anndata-reader-client.js');
  const { pageByteRangeCache } = await import('../assets/js/data/byte-range-cache.js');
  const channels = () => pageByteRangeCache().stats().channels;
  setAnnDataReaderWorkerFactory(() => createInProcessAnnDataReaderWorker());
  t.after(() => setAnnDataReaderWorkerFactory(() => createInProcessAnnDataReaderWorker()));
  const before = channels();
  for (let i = 0; i < 3; i++) {
    const client = new AnnDataReaderClient();
    await client.open({ file: new File([bytes], 'x.h5ad') });
    assert.equal(channels(), before + 1, 'an open reader holds its channel');
    client.close();
    assert.equal(channels(), before, 'a closed reader has ended it');
  }
});
