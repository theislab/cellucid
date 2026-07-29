import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HighPerfRenderer,
} from '../assets/js/rendering/high-perf-renderer.js';

function makeRenderer() {
  const mainPositions = Float32Array.from([
    0, 0, 0,
    1, 0, 0,
    2, 0, 0,
    3, 0, 0,
  ]);
  const customPositions = Float32Array.from([
    3, 1, 0,
    2, 1, 0,
    1, 1, 0,
    0, 1, 0,
  ]);
  const mainIndices = Uint32Array.from([0, 2]);
  const customIndices = Uint32Array.from([1, 3]);
  const mainSpatialIndex = {
    dimensionLevel: 2,
    lodLevels: [{
      indices: mainIndices,
      isFullDetail: false,
      sizeMultiplier: 1.5,
    }],
    positions: mainPositions,
  };
  const customSpatialIndex = {
    dimensionLevel: 2,
    lodLevels: [{
      indices: customIndices,
      isFullDetail: false,
      sizeMultiplier: 2.5,
    }],
    positions: customPositions,
  };
  const renderer = Object.assign(
    Object.create(HighPerfRenderer.prototype),
    {
      _perViewState: new Map([
        ['live', { lastLodLevel: 0 }],
        ['snap_shared', { lastLodLevel: 0 }],
        ['snap_custom', { lastLodLevel: 0 }],
      ]),
      _positions: mainPositions,
      _liveGeometryGeneration: 10,
      pointCount: 4,
      snapshotBuffers: new Map([
        ['snap_shared', {
          dimensionLevel: 2,
          geometryGeneration: 10,
          positions: mainPositions.slice(),
          spatialIndex: null,
        }],
        ['snap_custom', {
          dimensionLevel: 2,
          geometryGeneration: 9,
          positions: customPositions,
          spatialIndex: customSpatialIndex,
        }],
      ]),
      spatialIndices: new Map([[2, mainSpatialIndex]]),
    }
  );
  return {
    customIndices,
    customPositions,
    mainIndices,
    mainSpatialIndex,
    renderer,
  };
}

test('LOD indices use the main spatial owner for live and shared-position views', () => {
  const fixture = makeRenderer();

  assert.equal(
    fixture.renderer.getCurrentLodIndices('live', 2),
    fixture.mainIndices
  );
  assert.equal(
    fixture.renderer.getCurrentLodIndices('snap_shared', 2),
    fixture.mainIndices
  );
});

test('LOD indices use the exact custom snapshot spatial owner', () => {
  const fixture = makeRenderer();

  const indices = fixture.renderer.getCurrentLodIndices('snap_custom', 2);

  assert.equal(indices, fixture.customIndices);
  assert.notEqual(indices, fixture.mainIndices);
});

test('custom snapshot LOD lookup never falls back to a stale or mismatched owner', () => {
  const fixture = makeRenderer();
  const snapshot = fixture.renderer.snapshotBuffers.get('snap_custom');

  snapshot.dimensionLevel = 3;
  assert.throws(
    () => fixture.renderer.getCurrentLodIndices('snap_custom', 2),
    /snapshot "snap_custom".*owns 3D.*2D spatial-owner request/i
  );

  snapshot.dimensionLevel = 2;
  snapshot.spatialIndex = {
    dimensionLevel: 2,
    lodLevels: [{ indices: fixture.customIndices }],
    positions: fixture.customPositions.slice(),
  };
  assert.throws(
    () => fixture.renderer.getCurrentLodIndices('snap_custom', 2),
    /snapshot "snap_custom".*no current 2D spatial index/i
  );

  snapshot.spatialIndex = null;
  assert.throws(
    () => fixture.renderer.getCurrentLodIndices('snap_custom', 2),
    /snapshot "snap_custom".*no current 2D spatial index/i
  );
});

test('a new live generation detaches snapshots even when live array identity is unchanged', () => {
  const fixture = makeRenderer();
  const snapshot = fixture.renderer.snapshotBuffers.get('snap_shared');
  const immutableSnapshotPositions = snapshot.positions;
  const liveIdentity = fixture.renderer._positions;

  fixture.renderer._liveGeometryGeneration = 11;

  assert.equal(fixture.renderer._positions, liveIdentity);
  assert.notEqual(snapshot.positions, liveIdentity);
  assert.equal(snapshot.positions, immutableSnapshotPositions);
  assert.throws(
    () => fixture.renderer.getCurrentLodIndices('snap_shared', 2),
    /snapshot "snap_shared".*no current 2D spatial index/i
  );

  const snapshotIndices = Uint32Array.from([1, 2]);
  snapshot.spatialIndex = {
    dimensionLevel: 2,
    lodLevels: [{ indices: snapshotIndices }],
    positions: snapshot.positions,
  };
  assert.equal(
    fixture.renderer.getCurrentLodIndices('snap_shared', 2),
    snapshotIndices
  );
  assert.notEqual(snapshotIndices, fixture.mainIndices);
});

test('snapshot picking uses the same generation owner as rendering and LOD', () => {
  const fixture = makeRenderer();
  const shared = fixture.renderer.snapshotBuffers.get('snap_shared');

  assert.equal(
    fixture.renderer.getSnapshotSpatialIndex('snap_shared', 2),
    fixture.mainSpatialIndex
  );

  fixture.renderer._liveGeometryGeneration = 11;
  assert.equal(
    fixture.renderer.getSnapshotSpatialIndex('snap_shared', 2),
    null
  );

  const snapshotSpatialIndex = {
    dimensionLevel: 2,
    lodLevels: [],
    positions: shared.positions,
  };
  shared.spatialIndex = snapshotSpatialIndex;
  assert.equal(
    fixture.renderer.getSnapshotSpatialIndex('snap_shared', 2),
    snapshotSpatialIndex
  );
});

test('snapshot LOD visibility and size use the exact generation owner', () => {
  const sharedFixture = makeRenderer();
  assert.deepEqual(
    Array.from(
      sharedFixture.renderer.getLodVisibilityArray(
        'snap_shared',
        2,
      ),
    ),
    [1, 0, 1, 0],
  );
  assert.equal(
    sharedFixture.renderer.getCurrentLODSizeMultiplier(
      'snap_shared',
      2,
    ),
    1.5,
  );

  const customFixture = makeRenderer();
  assert.deepEqual(
    Array.from(
      customFixture.renderer.getLodVisibilityArray(
        'snap_custom',
        2,
      ),
    ),
    [0, 1, 0, 1],
  );
  assert.equal(
    customFixture.renderer.getCurrentLODSizeMultiplier(
      'snap_custom',
      2,
    ),
    2.5,
  );
});
