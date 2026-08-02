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

test('the cell axis is published through one validating seam', () => {
  const manager = new DimensionManager({ embeddingsMetadata: metadata('a.bin') });

  // Nothing is known before an identity states it or an embedding teaches it,
  // and that zero is what leaves the first payload ceiling-bounded.
  assert.equal(manager.getCellCount(), 0);

  // `stats.n_cells` reaching the manager as a raw property write is how a
  // wrong axis becomes a wrong byte bound. Every non-count is refused instead.
  for (const rejected of [
    0, -1, 1.5, NaN, Infinity, -Infinity,
    Number.MAX_SAFE_INTEGER + 2,
    '120', null, undefined, true, [120], { n_cells: 120 },
  ]) {
    assert.throws(
      () => manager.publishCellCount(rejected),
      /positive safe integer/,
      `publishing ${String(rejected)} must be refused`
    );
    assert.equal(manager.getCellCount(), 0, 'a refused axis must not be stored');
  }

  assert.equal(manager.publishCellCount(120), 120);
  assert.equal(manager.getCellCount(), 120);
  // Republishing the same axis is the idempotent case, not a conflict.
  assert.equal(manager.publishCellCount(120), 120);

  // A second dataset's axis must not overwrite the first one's silently.
  assert.throws(
    () => manager.publishCellCount(121),
    /already 120/
  );
  assert.equal(manager.getCellCount(), 120);

  // Clearing is the documented way to reuse a manager, and it restores both
  // the axis and the right to publish one.
  manager.clearCache();
  assert.equal(manager.getCellCount(), 0);
  assert.equal(manager.publishCellCount(7), 7);
});

test('publishing the cell axis before the metadata is refused, not discarded', () => {
  // `initFromMetadata` clears the cache and a cache clear zeroes the axis, so
  // publishing first used to be silently dropped and left the first embedding
  // bounded only by the browser byte ceiling. The owning module now refuses
  // the order instead of relying on each construction site to remember it.
  const manager = new DimensionManager();
  manager.publishCellCount(120);
  assert.throws(
    () => manager.initFromMetadata(metadata('a.bin')),
    /must be installed before the cell axis is published/
  );
  assert.equal(manager.getCellCount(), 120, 'the refused call must not clear');

  // The correct order is unaffected.
  const ordered = new DimensionManager();
  ordered.initFromMetadata(metadata('a.bin'));
  ordered.publishCellCount(120);
  assert.equal(ordered.getCellCount(), 120);
  assert.deepEqual(ordered.availableDimensions, [2]);

  // A construction site that supplies metadata up front is already past the
  // hazard, so it may publish immediately.
  const constructed = new DimensionManager({
    embeddingsMetadata: metadata('a.bin'),
  });
  assert.equal(constructed.publishCellCount(120), 120);

  // An axis learned from a decoded payload is downstream of the metadata and
  // does not pin the ordering.
  const learned = new DimensionManager({ embeddingsMetadata: metadata('a.bin') });
  learned.nCells = 120;
  assert.equal(learned.initFromMetadata(metadata('b.bin', 3)), undefined);
  assert.equal(learned.getCellCount(), 0);
});
