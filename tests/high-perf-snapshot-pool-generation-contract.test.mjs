import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HighPerfRenderer,
} from '../assets/js/rendering/high-perf-renderer.js';
import { SpatialIndex } from '../assets/js/rendering/high-perf/spatial-index.js';

function createPoolFixture() {
  // A 2D embedding: two components per point.
  const positions = Float32Array.from([
    -1, -1,
    1, -1,
    -1, 1,
    1, 1,
  ]);
  const renderer = Object.assign(
    Object.create(HighPerfRenderer.prototype),
    {
      _liveGeometryGeneration: 1,
      _nextGeometryGeneration: 8,
      _snapshotGeometryPools: new Map([
        [7, {
          dimension: 2,
          generation: 7,
          positions,
          refCount: 2,
          spatialIndices: new Map(),
        }],
      ]),
    },
  );
  return { positions, renderer };
}

test('one snapshot geometry/dimension owns one tree; one with LOD levels replaces one without', () => {
  const { positions, renderer } = createPoolFixture();
  const plain = { dimensionLevel: 2, lodLevels: [], positions };
  const banded = {
    dimensionLevel: 2,
    lodLevels: [{ depth: 0, indices: Uint32Array.from([2, 0]), isFullDetail: false, pointCount: 2 }],
    positions,
  };
  renderer._publishPooledSnapshotSpatialIndex(7, positions, 2, false, plain);
  const geometry = renderer._snapshotGeometryPools.get(7);

  // No in-place promotion: the pool answers with what it holds, and the
  // caller asks a worker for the tree with levels.
  assert.strictEqual(renderer._getPooledSnapshotSpatialIndex(7, positions, 2, true), plain);
  assert.deepEqual(plain.lodLevels, []);

  // A different owner is refused unless it replaces (a tree built off the
  // main thread with the levels the pool lacked).
  assert.throws(
    () => renderer._publishPooledSnapshotSpatialIndex(7, positions, 2, true, banded),
    /already owns a different 2D spatial index/,
  );
  renderer._publishPooledSnapshotSpatialIndex(7, positions, 2, true, banded, true);
  assert.equal(geometry.spatialIndices.size, 1);
  assert.strictEqual(renderer._getPooledSnapshotSpatialIndex(7, positions, 2, false), banded);
  assert.strictEqual(renderer._getPooledSnapshotSpatialIndex(7, positions, 2, true), banded);
});

test('geometry-only SpatialIndex accepts null colors only without node stats', () => {
  const positions = Float32Array.from([
    -1, 0,
    1, 0,
  ]);
  const sourceColors = Uint8Array.from([
    255, 0, 0, 255,
    0, 0, 255, 127,
  ]);
  const normalSpatialIndex = new SpatialIndex(
    positions,
    sourceColors,
    2,
    1,
    2,
    { buildLOD: false },
  );
  assert.strictEqual(
    normalSpatialIndex.colors,
    sourceColors,
    'the ordinary public SpatialIndex ABI retains provided source colors',
  );

  const spatialIndex = new SpatialIndex(
    positions,
    null,
    2,
    1,
    2,
    { buildLOD: true },
  );

  assert.equal(spatialIndex.colors, null);
  assert.equal(
    spatialIndex.lodLevels.at(-1).isFullDetail,
    true,
  );
  assert.equal(spatialIndex.lodLevels.at(-1).colors, null);
});
