/**
 * A reader worker can be started ahead of the client that reads with it
 * (`prewarmAnnDataReaderWorker`), so its module graph loads while a link is
 * still being resolved. The next client that needs a worker adopts it, wired
 * as one it made itself; there is never more than one spare, and a spare
 * nothing adopts never outlives the page or the abandoned open it was for.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AnnDataReaderClient,
  hasSpareAnnDataReaderWorker,
  prewarmAnnDataReaderWorker,
  releaseSpareAnnDataReaderWorker,
  setAnnDataReaderWorkerFactory,
} from '../assets/js/data/anndata-reader-client.js';
import { createInProcessAnnDataReaderWorker } from './helpers/anndata-reader-in-process.mjs';

function countingFactory(t) {
  const made = [];
  setAnnDataReaderWorkerFactory(() => {
    const worker = createInProcessAnnDataReaderWorker();
    made.push(worker);
    return worker;
  });
  t.after(() => setAnnDataReaderWorkerFactory(() => createInProcessAnnDataReaderWorker()));
  return made;
}

function fakeWindow(t) {
  const listeners = new Map();
  const original = globalThis.window;
  globalThis.window = {
    addEventListener: (type, listener) => listeners.set(listener, type),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    hide: () => [...listeners].filter(([, type]) => type === 'pagehide').forEach(([listener]) => listener()),
    get count() { return listeners.size; },
  };
  t.after(() => {
    if (original === undefined) delete globalThis.window;
    else globalThis.window = original;
  });
  return globalThis.window;
}

test('the next client adopts the spare worker, wired as its own, and one spare exists at a time', async t => {
  const made = countingFactory(t);
  prewarmAnnDataReaderWorker();
  prewarmAnnDataReaderWorker();
  assert.equal(made.length, 1, 'calling it twice leaves a single spare');
  assert.equal(hasSpareAnnDataReaderWorker(), true);

  const client = new AnnDataReaderClient({ kind: 'zarr' });
  t.after(() => client.close());
  // Any call starts the worker; the reader answers that nothing is open.
  await assert.rejects(client._call('getDatasetMetadata'), /No AnnData file is open/);
  assert.equal(made.length, 1, 'no second worker was made');
  assert.equal(hasSpareAnnDataReaderWorker(), false);
  assert.equal(typeof made[0].onmessage, 'function');
  assert.equal(typeof made[0].onerror, 'function');
  client.close();
  assert.equal(made[0].terminated, true, 'closing the client ends the adopted worker');
});

test('a spare nothing adopts ends when the page is left, or when the open it was for is abandoned', t => {
  const made = countingFactory(t);
  const page = fakeWindow(t);
  prewarmAnnDataReaderWorker();
  assert.equal(page.count, 1);
  page.hide();
  assert.equal(made[0].terminated, true);
  assert.equal(hasSpareAnnDataReaderWorker(), false);
  assert.equal(page.count, 0, 'its page-hide listener goes with it');

  prewarmAnnDataReaderWorker();
  const abandoned = new AnnDataReaderClient({ kind: 'h5ad' });
  abandoned.close();
  assert.equal(made[1].terminated, true, 'a client closed before it started a worker releases the spare');

  prewarmAnnDataReaderWorker();
  releaseSpareAnnDataReaderWorker();
  assert.equal(made[2].terminated, true);
  assert.equal(page.count, 0);
});
