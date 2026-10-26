/**
 * A level-of-detail build is admitted against the tab's heap before it starts.
 *
 * The renderer already refuses a dataset larger than the device's alpha-texture
 * capacity before allocating anything, because `MAX_TEXTURE_SIZE` is a number
 * the device publishes and the renderer can compare against. The JS heap
 * publishes one too on Chromium, and it is the one that actually bites: a LOD
 * build whose peak exceeds `jsHeapSizeLimit` produces no error at all. The
 * engine collects a multi-GiB heap for as long as the tab is open -- alive,
 * busy, nothing returned, nothing logged. That was measured: 40M points with
 * LOD enabled did not return after 26 minutes on Chromium, while WebKit
 * rendered the same load and Firefox refused it with a stated WebGL
 * `OUT_OF_MEMORY`.
 *
 * These tests hold the admission check to the curve it was fitted from, and to
 * the boundary bytes of its own arithmetic, without ever running the size that
 * hangs.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  getNotificationCenter,
} from '../assets/js/app/notification-center.js';
import {
  HighPerfRenderer,
} from '../assets/js/rendering/high-perf-renderer.js';

const RENDERER_SOURCE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../assets/js/rendering/high-perf-renderer.js',
);

const MIB = 1024 * 1024;

// The published coefficients the admission check is built on, fitted from a
// 5M/10M/20M/30M curve measured on Chromium (ANGLE Metal, Apple M1 Pro).
// Retained by the build: 79.8 - 51.9 B a point. Transient scratch live at the
// same time: 12 (hierarchical ordering) + 8.6 (leaves and child chain) + 16
// (the calibration-time packing scratch, kept as margin).
const RETAINED_BYTES_PER_POINT = 27.9;
const TRANSIENT_BYTES_PER_POINT = 36.6;
const BUILD_FIXED_BYTES = 4 * MIB;
const PEAK_BYTES_PER_POINT =
  RETAINED_BYTES_PER_POINT + TRANSIENT_BYTES_PER_POINT;

// Measured on the same run: the renderer process's own cap, and the heap the
// dataset already occupies before any LOD work begins.
const MEASURED_CHROMIUM_HEAP_LIMIT_BYTES = 4_395_630_592;
const PRE_BUILD_BYTES_PER_POINT = 51.9;
const PRE_BUILD_FIXED_BYTES = 20 * MIB;

/** Peak heap the build is projected to add for `pointCount` points. */
function projectedBuildBytes(pointCount) {
  return Math.ceil(pointCount * PEAK_BYTES_PER_POINT + BUILD_FIXED_BYTES);
}

/** Heap the loaded dataset already occupies, LOD not yet built. */
function measuredPreBuildBytes(pointCount) {
  return Math.round(
    pointCount * PRE_BUILD_BYTES_PER_POINT + PRE_BUILD_FIXED_BYTES,
  );
}

/**
 * Publish a simulated `performance.memory` for the duration of one test.
 *
 * Passing `null` removes it, which is what WebKit and Firefox present.
 */
function simulateHeap(t, usage) {
  const had = Object.hasOwn(performance, 'memory');
  const previous = had ? performance.memory : null;
  const restore = () => {
    if (had) {
      Object.defineProperty(performance, 'memory', {
        configurable: true,
        value: previous,
        writable: true,
      });
    } else {
      delete performance.memory;
    }
  };
  if (usage === null) {
    if (had) delete performance.memory;
  } else {
    Object.defineProperty(performance, 'memory', {
      configurable: true,
      value: {
        jsHeapSizeLimit: usage.limitBytes,
        usedJSHeapSize: usage.usedBytes,
      },
      writable: true,
    });
  }
  t.after(restore);
}

/** Record every calculation notification started during one test. */
function recordCalculationNotifications(t) {
  const notifications = getNotificationCenter();
  const previous = {
    completeCalculation: notifications.completeCalculation,
    failCalculation: notifications.failCalculation,
    hasNotification: notifications.hasNotification,
    startCalculation: notifications.startCalculation,
  };
  const started = [];
  let nextId = 1;
  Object.assign(notifications, {
    completeCalculation() {},
    failCalculation() {},
    hasNotification: () => true,
    startCalculation(message, kind) {
      started.push({ kind, message });
      return `lod-admission-${nextId++}`;
    },
  });
  t.after(() => Object.assign(notifications, previous));
  return started;
}

/** Record every error notification posted during one test. */
function recordErrorNotifications(t) {
  const notifications = getNotificationCenter();
  const previous = notifications.error;
  const posted = [];
  notifications.error = message => {
    posted.push(message);
    return 'lod-admission-error';
  };
  t.after(() => {
    notifications.error = previous;
  });
  return posted;
}

/**
 * Turn LOD on, then make the request the view's next frame makes: the
 * build is admitted there, off the toggle (no worker here, so an admitted
 * build runs inline).
 */
function enableLodAndRequest(renderer) {
  renderer.setAdaptiveLOD(true);
  renderer._requestSpatialIndex({ kind: 'live' }, true);
}

function makePositions(pointCount) {
  const positions = new Float32Array(pointCount * 3);
  for (let index = 0; index < pointCount; index++) {
    positions[index * 3] = index / pointCount;
    positions[index * 3 + 1] = ((index * 7) % pointCount) / pointCount;
    positions[index * 3 + 2] = ((index * 13) % pointCount) / pointCount;
  }
  return positions;
}

/**
 * A renderer carrying only the state the LOD preparation paths read.
 *
 * `pointCount` is deliberately separable from the length of `_positions`: the
 * admission check runs before the geometry is touched, so a 40,000,000-point
 * refusal can be driven without allocating 480 MB of positions in a test.
 */
function makeRenderer({
  adaptiveLOD = false,
  frustumCulling = false,
  geometryPoints = 8,
  pointCount = 8,
} = {}) {
  const renderer = Object.assign(
    Object.create(HighPerfRenderer.prototype),
    {
      _colors: new Uint8Array(geometryPoints * 4),
      _contextLost: false,
      _disposed: false,
      _liveGeometryGeneration: 1,
      _perViewState: new Map(),
      _positions: makePositions(geometryPoints),
      _snapshotGeometryPools: new Map(),
      currentDimensionLevel: 3,
      forceLODLevel: -1,
      options: { LOD_MAX_DEPTH: 8, LOD_MAX_POINTS_PER_NODE: 1000 },
      pointCount,
      snapshotBuffers: new Map(),
      spatialIndices: new Map(),
      stats: {},
      useAdaptiveLOD: adaptiveLOD,
      useFrustumCulling: frustumCulling,
    },
  );
  renderer._invalidateViewStateRecord = () => {};
  renderer._refreshGpuMemoryStats = () => {};
  // A LOD build is CPU work that publishes a tree carrying levels; its GPU
  // draw order is adopted at the next render. The trees with levels are the
  // builds that ran.
  const staged = {
    get length() {
      return [...renderer.spatialIndices].filter(
        ([, tree]) => Array.isArray(tree.lodLevels) && tree.lodLevels.length > 0,
      ).length;
    },
    get 0() {
      const entry = [...renderer.spatialIndices].find(
        ([, tree]) => Array.isArray(tree.lodLevels) && tree.lodLevels.length > 0,
      );
      return entry === undefined ? undefined : { dimensionLevel: entry[0], candidate: entry[1] };
    },
  };
  return { renderer, staged };
}

test(
  'the size measured to hang is refused, naming the count and the cap',
  (t) => {
    const pointCount = 40_000_000;
    simulateHeap(t, {
      limitBytes: MEASURED_CHROMIUM_HEAP_LIMIT_BYTES,
      usedBytes: measuredPreBuildBytes(pointCount),
    });
    const started = recordCalculationNotifications(t);
    const errors = recordErrorNotifications(t);
    const { renderer, staged } = makeRenderer({ pointCount });

    enableLodAndRequest(renderer);
    assert.equal(errors.length, 1, 'the refusal is reported once');
    ((error) => {
        // Grouped as the renderer writes every count (`formatCount`, en-US),
        // whatever locale the runner carries.
        const affordable = Math.floor(
          (
            MEASURED_CHROMIUM_HEAP_LIMIT_BYTES -
            measuredPreBuildBytes(pointCount) -
            BUILD_FIXED_BYTES
          ) / PEAK_BYTES_PER_POINT,
        );
        for (const expected of [
          `${pointCount.toLocaleString('en-US')} points`,
          `${Math.round(
            MEASURED_CHROMIUM_HEAP_LIMIT_BYTES / MIB,
          ).toLocaleString('en-US')} MiB`,
          `${Math.round(
            projectedBuildBytes(pointCount) / MIB,
          ).toLocaleString('en-US')} MiB`,
          `${Math.round(
            measuredPreBuildBytes(pointCount) / MIB,
          ).toLocaleString('en-US')} MiB`,
          `${affordable.toLocaleString('en-US')} points`,
        ]) {
          assert.ok(
            error.message.includes(expected),
            `refusal must state ${expected}; received "${error.message}"`,
          );
        }
        // The projection is what makes 40M refusable at all: it must exceed
        // the cap, and the settled size alone must not.
        assert.ok(
          measuredPreBuildBytes(pointCount) +
          projectedBuildBytes(pointCount) >
          MEASURED_CHROMIUM_HEAP_LIMIT_BYTES,
        );
      })({ message: errors[0] });

    // The flag is the user's: it stays on, and the view draws full detail.
    assert.equal(renderer.useAdaptiveLOD, true);
    assert.equal(renderer.spatialIndices.size, 0);
    assert.equal(staged.length, 0);
    assert.deepEqual(started, [], 'no build was started');
    // A refused build is not retried every frame.
    renderer._requestSpatialIndex({ kind: 'live' }, true);
    assert.equal(errors.length, 1);
  },
);

test(
  'the largest size measured to complete is still admitted and built',
  (t) => {
    const pointCount = 30_000_000;
    simulateHeap(t, {
      limitBytes: MEASURED_CHROMIUM_HEAP_LIMIT_BYTES,
      usedBytes: measuredPreBuildBytes(pointCount),
    });
    recordCalculationNotifications(t);
    const { renderer, staged } = makeRenderer({ pointCount });

    enableLodAndRequest(renderer);

    assert.equal(renderer.useAdaptiveLOD, true);
    assert.equal(staged.length, 1);
    assert.equal(staged[0].dimensionLevel, 3);
    assert.ok(
      Array.isArray(staged[0].candidate.lodLevels) &&
      staged[0].candidate.lodLevels.length > 0,
      'the admitted build must produce LOD levels',
    );
    assert.equal(
      renderer.spatialIndices.get(3),
      staged[0].candidate,
    );
  },
);

test('the admission boundary is exact to the byte', (t) => {
  const pointCount = 1_000_000;
  const usedBytes = 100_000_000;
  const projected = projectedBuildBytes(pointCount);
  assert.equal(projected, 68_694_304);

  const admitting = makeRenderer({ pointCount });
  simulateHeap(t, { limitBytes: usedBytes + projected, usedBytes });
  recordCalculationNotifications(t);
  enableLodAndRequest(admitting.renderer);
  assert.equal(admitting.renderer.useAdaptiveLOD, true);
  assert.equal(admitting.staged.length, 1);
});

test('one byte less headroom refuses the same build', (t) => {
  const pointCount = 1_000_000;
  const usedBytes = 100_000_000;
  const projected = projectedBuildBytes(pointCount);

  const refusing = makeRenderer({ pointCount });
  simulateHeap(t, { limitBytes: usedBytes + projected - 1, usedBytes });
  const errors = recordErrorNotifications(t);
  enableLodAndRequest(refusing.renderer);
  assert.equal(errors.length, 1);
  assert.ok(
    errors[0].includes(`level-of-detail index for ${pointCount.toLocaleString('en-US')} points`),
    errors[0],
  );
  assert.equal(refusing.staged.length, 0);
});

test(
  'an engine that publishes no heap limit is never refused',
  (t) => {
    // WebKit and Firefox expose no `performance.memory`. WebKit completes the
    // build Chromium hangs on and Firefox refuses it with a real WebGL error,
    // so neither may be refused against a limit this renderer invented.
    simulateHeap(t, null);
    recordCalculationNotifications(t);
    const { renderer, staged } = makeRenderer({ pointCount: 40_000_000 });

    enableLodAndRequest(renderer);

    assert.equal(renderer.useAdaptiveLOD, true);
    assert.equal(staged.length, 1);
  },
);

test('the plain path is never refused by the LOD admission check', (t) => {
  // LOD off and frustum culling being switched on: the tree carries no LOD
  // levels, so none of the projected heap applies. The limit here is far below
  // anything a LOD build of this size could fit in.
  simulateHeap(t, { limitBytes: 1, usedBytes: 0 });
  recordCalculationNotifications(t);
  const { renderer, staged } = makeRenderer({ pointCount: 40_000_000 });

  renderer.setFrustumCulling(true);
  renderer._requestSpatialIndex({ kind: 'live' }, false);

  assert.equal(renderer.useFrustumCulling, true);
  assert.equal(staged.length, 0);
  const tree = renderer.spatialIndices.get(3);
  assert.ok(tree !== undefined, 'a frustum-only tree must still be built');
  assert.ok(
    !Array.isArray(tree.lodLevels) || tree.lodLevels.length === 0,
    'a frustum-only tree must carry no LOD levels',
  );
});

test(
  'the live-geometry build path refuses before it starts any work',
  (t) => {
    // `_getOrBuildSpatialIndexForDimension` is the path `loadData` takes. The
    // refusal must land before the calculation notification, not after: a
    // notification that opens and never settles is the same unbounded state
    // this check exists to remove.
    const geometryPoints = 8;
    const projected = projectedBuildBytes(geometryPoints);
    simulateHeap(t, { limitBytes: projected - 1, usedBytes: 0 });
    const started = recordCalculationNotifications(t);
    const { renderer } = makeRenderer({ geometryPoints, pointCount: 8 });

    assert.throws(
      () => renderer._getOrBuildSpatialIndexForDimension(3, false, true),
      (error) => {
        assert.ok(error instanceof RangeError);
        assert.ok(
          error.message.includes(
            `level-of-detail index for ${geometryPoints.toLocaleString('en-US')} points`,
          ),
          error.message,
        );
        return true;
      },
    );
    assert.deepEqual(started, []);
    assert.equal(renderer.spatialIndices.size, 0);
  },
);

test('every LOD tree construction is admitted first', async () => {
  // A construction site added without an admission check would restore the
  // unbounded path for one entry point while the others stayed bounded. A
  // build request (`_buildSpatialTreeJob`, worker or inline) is a LOD build
  // like any other.
  const source = await readFile(RENDERER_SOURCE_PATH, 'utf8');
  const events = [];
  const pattern =
    /(?<definition>function\s+)?requireLodBuildHeapHeadroom\(|new SpatialIndex\(|this\._buildSpatialTreeJob\(|\.ensureLODLevels\(\)/g;
  for (const match of source.matchAll(pattern)) {
    if (match[0].startsWith('new SpatialIndex') || match[0].startsWith('this._buildSpatialTreeJob') || match[0] === '.ensureLODLevels()') {
      events.push('construct');
    } else if (match.groups.definition === undefined) {
      events.push('admit');
    }
  }
  const constructions = events.filter((e) => e === 'construct').length;
  assert.ok(
    constructions >= 3,
    `expected the known LOD construction sites, found ${constructions}`,
  );
  assert.deepEqual(
    events,
    Array.from(
      { length: constructions * 2 },
      (_unused, index) => (index % 2 === 0 ? 'admit' : 'construct'),
    ),
    'every `new SpatialIndex(` must be immediately preceded by its ' +
    '`requireLodBuildHeapHeadroom(` admission check',
  );
});
