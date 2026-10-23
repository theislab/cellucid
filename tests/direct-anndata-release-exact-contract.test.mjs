import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { H5adDataSource } from '../assets/js/data/h5ad.js';
import { AnnDataReader } from '../assets/js/data/anndata/reader.js';
import { AnnDataReaderClient } from '../assets/js/data/anndata-reader-client.js';
import { ZarrDataSource } from '../assets/js/data/zarr.js';

test('the AnnData reader propagates the exact store-release failure', () => {
  const reader = new AnnDataReader();
  const releaseFailure = new Error('exact store close failure');
  let closeCalls = 0;
  const store = {
    close() {
      closeCalls++;
      throw releaseFailure;
    },
  };
  reader._store = store;
  reader._root = {};

  assert.throws(
    () => reader.close(),
    (error) => error === releaseFailure
  );
  assert.equal(reader.isOpen, false);
  // A store whose release failed stays owned: a later close retries it.
  assert.equal(reader._store, store);
  assert.throws(() => reader.close(), error => error === releaseFailure);
  assert.equal(closeCalls, 2);
});

test('the AnnData reader reports every required resource-release failure', () => {
  const reader = new AnnDataReader();
  const storeFailure = new Error('exact store close failure');
  const matrixFailure = new Error('exact matrix index release failure');
  reader._store = {
    close() {
      throw storeFailure;
    },
  };
  reader._root = {};
  reader._matrices.set('X', {
    element: 'X',
    loadPromise: null,
    columns: {
      dispose() {
        throw matrixFailure;
      },
    },
  });

  assert.throws(
    () => reader.close(),
    error => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], storeFailure);
      assert.equal(error.errors[1], matrixFailure);
      return true;
    }
  );
  assert.notEqual(reader._store, null, 'the store whose release failed stays owned');
});

test('direct AnnData sources propagate cache-release failures', () => {
  for (const source of [new H5adDataSource(), new ZarrDataSource()]) {
    const releaseFailure = new Error(`${source.getType()} cache release failed`);
    source.clearCaches = () => {
      throw releaseFailure;
    };
    assert.throws(
      () => source.onDeactivate(),
      (error) => error === releaseFailure
    );
  }
});

test('direct AnnData connectivity access without an active adapter is terminal', async () => {
  await assert.rejects(
    new H5adDataSource().getConnectivityEdges(),
    /No h5ad file loaded/
  );
  await assert.rejects(
    new ZarrDataSource().getConnectivityEdges(),
    /No zarr directory loaded/
  );
});

test('Zarr candidate loading preserves both opening and cleanup failures', async () => {
  const source = new ZarrDataSource();
  const openingFailure = new Error('exact Zarr opening failure');
  const cleanupFailure = new Error('exact Zarr cleanup failure');
  const { open, close } = AnnDataReaderClient.prototype;
  AnnDataReaderClient.prototype.open = async () => {
    throw openingFailure;
  };
  AnnDataReaderClient.prototype.close = () => {
    throw cleanupFailure;
  };
  try {
    await assert.rejects(
      source._loadCandidate(
        0,
        { files: new Map(), rootName: 'broken.zarr' },
        {
          datasetId: null,
          description: 'broken',
          source: { name: 'test' },
        },
        false
      ),
      error => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [openingFailure, cleanupFailure]);
        return true;
      }
    );
  } finally {
    AnnDataReaderClient.prototype.open = open;
    AnnDataReaderClient.prototype.close = close;
  }
});
