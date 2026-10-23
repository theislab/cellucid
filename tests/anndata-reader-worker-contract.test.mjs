/**
 * The AnnData reader worker's own contract: which reads it starts when, what
 * it reports while it reads, and how a file it cannot read is explained.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createAnnDataReaderHandler } from '../assets/js/data/anndata-reader-worker.js';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';

const FIXTURE = new URL('./browser/fixtures/current-ui-smoke.h5ad', import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));

function handlerWith(events = []) {
  const handle = createAnnDataReaderHandler({ post: message => events.push(message) });
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

test('a matrix is indexed by gene at open over a link as fast as a disk, at the first gene over a slower one', async t => {
  // The index of a cell-major matrix reads its whole index array: over a
  // slow link that waits until a gene is shown, so opening downloads only
  // what its first view draws. The decision follows the link the reader
  // measured while opening, not where the file is.
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const indexStarted = events => events.some(event => event.event === 'activity' && event.kind === 'index');
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));

  const local = [];
  const localCall = handlerWith(local);
  await localCall('open', { kind: 'h5ad', source: new File([bytes], 'x.h5ad') });
  await localCall('prepareMatrix', 'X');
  await settle();
  assert.ok(indexStarted(local), 'a local file starts its index at once');

  // A slow link: a 20 ms round trip, 100 kB/s.
  globalThis.fetch = servingOverLink(20, 100);
  const slow = [];
  const slowCall = handlerWith(slow);
  await slowCall('open', { kind: 'h5ad', source: { url: 'https://example.org/x.h5ad', size: bytes.length, name: 'x.h5ad' } });
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
    kind: 'h5ad',
    source: { url: 'https://example.org/x.h5ad', size: bytes.length, name: 'x.h5ad' },
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

test('a file that is not HDF5, or is damaged, is explained', async () => {
  const call = handlerWith();
  await assert.rejects(
    call('open', { kind: 'h5ad', source: new File([new TextEncoder().encode('not an hdf5 file at all')], 'x.h5ad') }),
    error => /not a valid HDF5\/H5AD file/.test(error.message) && error.details?.explained === true
  );
  await assert.rejects(
    call('open', { kind: 'h5ad', source: new File([bytes.subarray(0, 4000)], 'cut.h5ad') }),
    error => /could not be read .*corrupted or truncated/s.test(error.message) && error.details?.explained === true
  );
  await assert.rejects(
    call('open', { kind: 'h5ad', source: new File([], 'empty.h5ad') }),
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
  const client = new AnnDataReaderClient({ kind: 'h5ad' });
  t.after(() => {
    client.close();
    setAnnDataReaderWorkerFactory(() => createInProcessAnnDataReaderWorker());
  });
  await client.open(new File([bytes], 'x.h5ad'));
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
  // Then the job the read is for (none for a view's genes) and the shared
  // loads it serves (none named here).
  assert.deepEqual(requests.map(message => [message.method, message.args]), [['getMatrixColumns', ['X', [0, 2, 5], null, []]]]);
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
  await handle({ id: 1, method: 'open', args: [{ kind: 'h5ad', source: new File([bytes], 'x.h5ad') }] });
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
