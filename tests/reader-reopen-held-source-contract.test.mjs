/**
 * A dataset read again with other cells (Apply in Cells to open, a growth
 * step) is read through the source the reader worker holds: the page sends
 * no copy of it (`AnnDataReaderClient.reopenCells` `heldSource`). A file
 * picked from this computer copied to the worker a second time read as
 * empty in Linux WebKit (Web contracts run 41269083996), while the copy the
 * worker held read on. A file that cannot be read is said to be that, not
 * empty (`anndata/open.js`).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createAnnDataReaderHandler } from '../assets/js/data/anndata-reader-worker.js';
import { openDatasetStore } from '../assets/js/data/anndata/open.js';

const FIXTURE = new URL('./browser/fixtures/current-ui-smoke.h5ad', import.meta.url);
const bytes = new Uint8Array(readFileSync(FIXTURE));

function worker() {
  const handle = createAnnDataReaderHandler({ post: () => {} });
  let id = 0;
  const call = async (method, ...args) => {
    const { reply } = await handle({ id: ++id, method, args });
    if (reply.error) throw Object.assign(new Error(reply.error.message), { name: reply.error.name });
    return reply.result;
  };
  return { call };
}

test('a read again with other cells needs no source: the worker reads the one it holds', async () => {
  const { call } = worker();
  const file = new File([bytes], 'x.h5ad', { lastModified: 1 });
  const first = await call('open', { source: { file } });
  const all = first.nObs;
  const again = await call('open', { source: null, heldSource: true, reopen: true, cellSubset: { mode: 'subsample', method: 'uniform', k: 40, seed: 7, strict: true } });
  assert.equal(again.cellSubset.nObs, all, 'the same dataset');
  assert.equal(again.sameVersion, true, 'its store is taken over, nothing opened anew');
  assert.equal(again.nObs, 40);
  const whole = await call('open', { source: null, heldSource: true, reopen: true, cellSubset: { mode: 'all' } });
  assert.equal(whole.sameVersion, true);
  assert.equal(whole.nObs, all);
});

test('a worker holding no dataset refuses to read one again from nothing', async () => {
  const { call } = worker();
  await assert.rejects(
    call('open', { source: null, heldSource: true, reopen: true, cellSubset: { mode: 'all' } }),
    /holds no dataset to read again/
  );
  await call('open', { source: { file: new File([bytes], 'x.h5ad', { lastModified: 1 }) } });
  await call('close');
  await assert.rejects(
    call('open', { source: null, heldSource: true, reopen: true, cellSubset: { mode: 'all' } }),
    /holds no dataset to read again/
  );
});

test('a picked file of no bytes is empty; one the browser cannot read is said to be unreadable', async () => {
  const options = { decodedChunkCacheBytes: 0 };
  await assert.rejects(
    openDatasetStore({ source: { file: new File([], 'empty.h5ad') } }, options),
    /The selected H5AD file is empty/
  );
  // As a browser answers for a file it lost: no bytes, and reading fails.
  const lost = new File([], 'lost.h5ad');
  Object.defineProperty(lost, 'arrayBuffer', { value: () => Promise.reject(new DOMException('The file could not be read.', 'NotReadableError')) });
  await assert.rejects(
    openDatasetStore({ source: { file: lost } }, options),
    error => /lost\.h5ad can no longer be read by this browser/.test(error.message) && error.cause?.name === 'NotReadableError'
  );
});

test('the page sends a live worker no copy of the source to read again', async t => {
  const { createInProcessAnnDataReaderWorker } = await import('./helpers/anndata-reader-in-process.mjs');
  const { AnnDataReaderClient, setAnnDataReaderWorkerFactory } = await import('../assets/js/data/anndata-reader-client.js');
  const workers = [];
  setAnnDataReaderWorkerFactory(() => {
    const created = createInProcessAnnDataReaderWorker();
    workers.push(created);
    return created;
  });
  const client = new AnnDataReaderClient();
  t.after(() => {
    client.close();
    setAnnDataReaderWorkerFactory(() => createInProcessAnnDataReaderWorker());
  });
  const file = new File([bytes], 'x.h5ad', { lastModified: 1 });
  await client.open({ file });
  await client.reopenCells({ cellSubset: { mode: 'subsample', method: 'uniform', k: 40, seed: 7, strict: true } });
  const opens = workers[0].messages.filter(message => message.method === 'open');
  assert.equal(opens.length, 2);
  assert.equal(opens[0].args[0].source.file, file);
  assert.equal(opens[1].args[0].source, null, 'no copy of the file is sent');
  assert.equal(opens[1].args[0].heldSource, true);
  assert.equal(client.cellSubset.kept.length, 40);
});
