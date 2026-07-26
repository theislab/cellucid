import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DimensionManager,
} from '../assets/js/data/dimension-manager.js';

function metadata(filename, dimension = 2) {
  return {
    available_dimensions: [dimension],
    default_dimension: dimension,
    files: {
      [`${dimension}d`]: filename,
    },
  };
}

test('valid embedding metadata replacement invalidates all prior coordinate state', () => {
  const manager = new DimensionManager({
    embeddingsMetadata: metadata('old.bin'),
  });
  const oldRaw = new Float32Array([1, 2, 3, 4]);
  const oldPadded = new Float32Array([1, 2, 0, 3, 4, 0]);
  let aborted = false;

  manager.positionCache.set(2, oldRaw);
  manager.paddedPositionCache.set(2, oldPadded);
  manager.normTransformCache.set(2, {
    center: [2, 3, 0],
    scale: 1,
  });
  manager.loadingPromises.set(2, Promise.resolve(oldRaw));
  manager.paddedLoadingPromises.set(2, Promise.resolve(oldPadded));
  manager.loadingControllers.set(2, {
    abort() {
      aborted = true;
    },
  });
  manager.viewDimensions.set('main', 2);
  manager.nCells = 2;
  const priorGeneration = manager._generation;

  manager.initFromMetadata(metadata('new.bin', 3));

  assert.equal(aborted, true);
  assert.ok(manager._generation > priorGeneration);
  assert.deepEqual(manager.availableDimensions, [3]);
  assert.equal(manager.defaultDimension, 3);
  assert.deepEqual(manager.dimensionFiles, { '3d': 'new.bin' });
  assert.equal(manager.positionCache.size, 0);
  assert.equal(manager.paddedPositionCache.size, 0);
  assert.equal(manager.normTransformCache.size, 0);
  assert.equal(manager.loadingPromises.size, 0);
  assert.equal(manager.paddedLoadingPromises.size, 0);
  assert.equal(manager.loadingControllers.size, 0);
  assert.equal(manager.viewDimensions.size, 0);
  assert.equal(manager.nCells, 0);
});

test('invalid view dimensions reject without substituting or mutating state', () => {
  const manager = new DimensionManager({
    embeddingsMetadata: metadata('points.bin'),
  });
  manager.setViewDimension('main', 2);

  assert.throws(
    () => manager.setViewDimension('main', 3),
    /3D.*not available|available.*2D/i
  );
  assert.equal(manager.getViewDimension('main'), 2);
  assert.equal(manager.viewDimensions.get('main'), 2);
});

test('dimension metadata and configuration reject coercive normalization', () => {
  assert.throws(
    () => new DimensionManager({
      embeddingsMetadata: {
        ...metadata('points.bin'),
        umap_resolution: {
          source_key: 'X_umap',
          action: 'used_as',
        },
      },
    }),
    /embeddings metadata.*unsupported field.*umap_resolution/i
  );
  assert.throws(
    () => new DimensionManager({
      embeddingsMetadata: {
        available_dimensions: [3, 2],
        default_dimension: 2,
        files: {
          '2d': 'points-2d.bin',
          '3d': 'points-3d.bin',
        },
      },
    }),
    /available_dimensions.*increasing|order/i
  );
  assert.throws(
    () => new DimensionManager({
      keepRawPositions: 'false',
    }),
    /keepRawPositions.*boolean/i
  );

  const manager = new DimensionManager({
    embeddingsMetadata: metadata('points.bin'),
  });
  assert.throws(
    () => manager.setViewDimension('', 2),
    /view.*id.*non-empty/i
  );
  assert.throws(
    () => manager.getViewDimension(''),
    /view.*id.*non-empty/i
  );
  assert.equal(manager.viewDimensions.size, 0);
});

test('per-view dimension lookup requires an explicitly published view', () => {
  const manager = new DimensionManager({
    embeddingsMetadata: metadata('points.bin'),
  });

  assert.throws(
    () => manager.getViewDimension('missing'),
    /dimension.*not published.*missing/i,
  );
  assert.throws(
    () => manager.copyViewDimension('missing', 'snapshot'),
    /dimension.*not published.*missing/i,
  );
  assert.equal(manager.viewDimensions.size, 0);
});
