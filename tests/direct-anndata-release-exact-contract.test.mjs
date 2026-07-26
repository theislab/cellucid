import assert from 'node:assert/strict';
import test from 'node:test';

import {
  H5adDataSource,
  H5adLoader,
} from '../assets/js/data/h5ad.js';
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
  loader._file = {
    close() {
      throw fileFailure;
    },
  };
  loader._virtualPath = '/owned-dataset.h5ad';

  assert.throws(
    () => loader.close(),
    error => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], fileFailure);
      assert.match(
        error.errors[1].message,
        /virtual filesystem ownership is unavailable/
      );
      return true;
    }
  );
  assert.notEqual(loader._file, null);
  assert.equal(loader._virtualPath, '/owned-dataset.h5ad');
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

  await assert.rejects(
    source._loadCandidate(
      0,
      'broken.zarr',
      loader => {
        loader.close = () => {
          throw cleanupFailure;
        };
        throw openingFailure;
      },
      {
        datasetId: null,
        description: 'broken',
        source: { name: 'test' },
      }
    ),
    error => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [openingFailure, cleanupFailure]);
      return true;
    }
  );
});
