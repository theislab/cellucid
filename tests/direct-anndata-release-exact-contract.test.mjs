import './helpers/anndata-reader-in-process.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { H5adDataSource } from '../assets/js/data/h5ad.js';
import { H5adLoader } from '../assets/js/data/h5ad-loader.js';
import { AnnDataReaderClient } from '../assets/js/data/anndata-reader-client.js';
import { ZarrDataSource } from '../assets/js/data/zarr.js';

test('H5AD loader propagates the exact owned file-release failure', () => {
  const loader = new H5adLoader();
  const releaseFailure = new Error('exact HDF5 close failure');
  loader._file = {
    close() {
      throw releaseFailure;
    },
  };

  assert.throws(
    () => loader.close(),
    (error) => error === releaseFailure
  );
  assert.notEqual(loader._file, null);
});

test('H5AD loader reports every required resource-release failure', () => {
  const loader = new H5adLoader();
  const fileFailure = new Error('exact HDF5 close failure');
  const unmountFailure = new Error('exact virtual file release failure');
  loader._file = {
    close() {
      throw fileFailure;
    },
  };
  loader._unmount = () => {
    throw unmountFailure;
  };

  assert.throws(
    () => loader.close(),
    error => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], fileFailure);
      assert.equal(error.errors[1], unmountFailure);
      return true;
    }
  );
  assert.notEqual(loader._file, null);
  assert.notEqual(loader._unmount, null);
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
