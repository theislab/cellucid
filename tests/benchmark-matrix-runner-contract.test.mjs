import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBenchmarkMatrixRunner,
  expandMatrix,
  MAX_BENCHMARK_VIEWS
} from '../assets/js/app/ui/modules/benchmark/matrix-runner.js';
import { instrumentGlUploads } from '../assets/js/app/ui/modules/benchmark/gl-upload-counter.js';

/** A scheduler that runs animation frames as fast as the event loop allows. */
function createScheduler() {
  const pending = new Map();
  let nextHandle = 1;
  let cancelled = 0;
  const requestFrame = callback => {
    const handle = nextHandle++;
    pending.set(handle, callback);
    queueMicrotask(() => {
      const scheduled = pending.get(handle);
      if (scheduled === undefined) return;
      pending.delete(handle);
      scheduled(handle);
    });
    return handle;
  };
  const cancelFrame = handle => {
    if (pending.delete(handle)) cancelled++;
  };
  return {
    requestFrame,
    cancelFrame,
    get cancelledFrames() {
      return cancelled;
    },
    get pendingFrames() {
      return pending.size;
    }
  };
}

function createElement(id) {
  const listeners = new Map();
  return {
    id,
    value: 'grid',
    disabled: false,
    clicks: 0,
    click() {
      this.clicks++;
      const handler = listeners.get('click');
      if (handler !== undefined) handler();
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    dispatchEvent(event) {
      const handler = listeners.get(event.type);
      if (handler !== undefined) handler(event);
      return true;
    },
    on(type, handler) {
      listeners.set(type, handler);
    }
  };
}

function createHarnessDouble({ lodLevels = [4] } = {}) {
  const keepViewButton = createElement('split-keep-view-btn');
  const clearButton = createElement('split-clear-btn');
  const layoutSelect = createElement('view-layout-mode');
  layoutSelect.value = 'single';

  const snapshots = [];
  let layoutMode = 'single';
  let lodIndex = 0;
  const record = {
    adaptiveLod: [],
    frustumCulling: [],
    forceLod: [],
    cameraPublications: 0,
    cameraStates: new Set()
  };

  keepViewButton.on('click', () => {
    snapshots.push({ id: `snap_${snapshots.length + 1}` });
  });
  clearButton.on('click', () => {
    snapshots.length = 0;
  });
  layoutSelect.on('change', () => {
    layoutMode = layoutSelect.value;
  });

  const viewer = {
    getCameraState() {
      return {
        navigationMode: 'orbit',
        orbit: {
          radius: 3,
          targetRadius: 3,
          theta: 0.5,
          phi: 1,
          target: [0, 0, 0]
        },
        freefly: { position: [0, 0, 3], yaw: 0, pitch: 0 }
      };
    },
    setCameraState(state) {
      record.cameraPublications++;
      record.cameraStates.add(state);
      record.lastPose = {
        radius: state.orbit.radius,
        theta: state.orbit.theta,
        target: [...state.orbit.target]
      };
    },
    getCurrentLODLevel() {
      const level = lodLevels[lodIndex % lodLevels.length];
      lodIndex++;
      return level;
    },
    getSnapshotViews() {
      return snapshots.slice();
    },
    getViewLayout() {
      return { mode: layoutMode, activeId: 'live', liveViewHidden: false };
    },
    setAdaptiveLOD(enabled) {
      record.adaptiveLod.push(enabled);
    },
    setFrustumCulling(enabled) {
      record.frustumCulling.push(enabled);
    },
    setForceLOD(level) {
      record.forceLod.push(level);
    },
    setCamerasLocked() {}
  };

  const elements = new Map([
    ['split-keep-view-btn', keepViewButton],
    ['split-clear-btn', clearButton],
    ['view-layout-mode', layoutSelect]
  ]);
  const ownerDocument = {
    getElementById(id) {
      return elements.get(id) ?? null;
    }
  };

  return { viewer, ownerDocument, record, keepViewButton, layoutSelect };
}

test('the matrix expands LOD, culling and view count into ordered cells', () => {
  const cells = expandMatrix({
    lod: [false, true],
    frustumCulling: [false, true],
    viewCount: [1, 2, 4]
  });
  assert.equal(cells.length, 2 * 2 * 3 * 2);
  assert.deepEqual(cells[0], {
    viewCount: 1,
    lod: false,
    frustumCulling: false,
    forceLodLevel: -1,
    regime: 'static'
  });
  assert.deepEqual(cells[1].regime, 'orbit');
  // Every cell must run under both regimes: the difference between them is the
  // measurement, so a single-regime cell is not a cell.
  const regimeCounts = new Map();
  for (const cell of cells) {
    const key = `${cell.viewCount}|${cell.lod}|${cell.frustumCulling}`;
    regimeCounts.set(key, (regimeCounts.get(key) ?? 0) + 1);
  }
  for (const count of regimeCounts.values()) assert.equal(count, 2);
});

test('a forced LOD probe is never scheduled with adaptive LOD off', () => {
  const cells = expandMatrix({
    lod: [false, true],
    frustumCulling: [true],
    viewCount: [1],
    forceLodLevel: [-1, 0, 17]
  });
  for (const cell of cells) {
    if (cell.forceLodLevel !== -1) {
      assert.equal(cell.lod, true, 'a forced level requires adaptive LOD');
    }
  }
  assert.equal(cells.filter(cell => cell.lod === false).length, 2);
});

test('the view-count axis stops at the viewer snapshot ceiling', () => {
  assert.equal(MAX_BENCHMARK_VIEWS, 4);
  assert.throws(
    () => expandMatrix({ viewCount: [5] }),
    /exceeds the viewer ceiling of 4 views/
  );
  assert.throws(() => expandMatrix({ lod: [] }), /non-empty array/);
  assert.throws(() => expandMatrix({ regime: ['spin'] }), /Matrix regime/);
  assert.throws(() => expandMatrix({ lod: ['yes'] }), /exact boolean/);
  assert.throws(
    () => expandMatrix({ forceLodLevel: [-2] }),
    /-1 or greater/
  );
});

test('view count is driven through the application controls and verified', async () => {
  const scheduler = createScheduler();
  const { viewer, ownerDocument, keepViewButton, layoutSelect } =
    createHarnessDouble();
  const runner = createBenchmarkMatrixRunner({
    viewer,
    document: ownerDocument,
    requestFrame: scheduler.requestFrame,
    cancelFrame: scheduler.cancelFrame
  });

  // Setting the layout alone changes nothing while only one view exists, so
  // the runner must publish snapshots first and then confirm the layout.
  const four = await runner.ensureViewCount(4);
  assert.deepEqual(four, { viewCount: 4, layoutMode: 'grid' });
  assert.equal(keepViewButton.clicks, 3);
  assert.equal(layoutSelect.value, 'grid');
  assert.equal(viewer.getSnapshotViews().length, 3);

  const one = await runner.ensureViewCount(1);
  assert.deepEqual(one, { viewCount: 1, layoutMode: 'single' });
  assert.equal(viewer.getSnapshotViews().length, 0);
});

test('a view count beyond the ceiling is refused before anything is clicked', async () => {
  const scheduler = createScheduler();
  const { viewer, ownerDocument, keepViewButton } = createHarnessDouble();
  const runner = createBenchmarkMatrixRunner({
    viewer,
    document: ownerDocument,
    requestFrame: scheduler.requestFrame,
    cancelFrame: scheduler.cancelFrame
  });
  await assert.rejects(
    () => runner.ensureViewCount(5),
    /exceeds the viewer ceiling/
  );
  assert.equal(keepViewButton.clicks, 0);
});

test('a disabled keep-view control fails loudly instead of measuring one view', async () => {
  const scheduler = createScheduler();
  const { viewer, ownerDocument, keepViewButton } = createHarnessDouble();
  keepViewButton.disabled = true;
  const runner = createBenchmarkMatrixRunner({
    viewer,
    document: ownerDocument,
    requestFrame: scheduler.requestFrame,
    cancelFrame: scheduler.cancelFrame
  });
  await assert.rejects(
    () => runner.ensureViewCount(2),
    /keep-view control is disabled/
  );
});

test('both regimes publish a camera every frame; only orbit moves it', async () => {
  for (const regime of ['static', 'orbit']) {
    const scheduler = createScheduler();
    const { viewer, ownerDocument, record } = createHarnessDouble();
    const runner = createBenchmarkMatrixRunner({
      viewer,
      document: ownerDocument,
      requestFrame: scheduler.requestFrame,
      cancelFrame: scheduler.cancelFrame
    });
    const path = runner.createPathFromCurrentCamera();
    const poses = new Set();
    const originalSetCameraState = viewer.setCameraState;
    viewer.setCameraState = function trackPose(state) {
      poses.add(
        `${state.orbit.radius}|${state.orbit.theta}|${state.orbit.target[0]}`
      );
      return originalSetCameraState.call(this, state);
    };

    const summary = await runner.runWindow({
      regime,
      path,
      warmupFrames: 2,
      measureFrames: 20
    });
    assert.equal(summary.samples, 20);
    assert.ok(
      record.cameraPublications >= 20,
      `${regime} must publish a camera on every frame`
    );
    assert.equal(record.cameraStates.size, 1, 'one reused camera state');
    if (regime === 'static') {
      assert.equal(poses.size, 1, 'the static regime must hold one pose');
    } else {
      assert.ok(poses.size > 15, 'the orbit regime must visit new poses');
    }
  }
});

test('the measured window carries the upload counters it was given', async () => {
  const scheduler = createScheduler();
  const { viewer, ownerDocument } = createHarnessDouble();
  const gl = {
    ELEMENT_ARRAY_BUFFER: 0x8893,
    bufferData() {},
    bufferSubData() {},
    texImage2D() {},
    texSubImage2D() {},
    drawArrays() {},
    drawElements() {},
    drawArraysInstanced() {},
    drawElementsInstanced() {},
    getError() {
      return 0;
    },
    finish() {},
    flush() {},
    readPixels() {},
    getBufferSubData() {}
  };
  const uploadCounters = instrumentGlUploads(gl);
  const runner = createBenchmarkMatrixRunner({
    viewer,
    document: ownerDocument,
    uploadCounters,
    requestFrame: scheduler.requestFrame,
    cancelFrame: scheduler.cancelFrame
  });

  // One element-buffer reallocation per frame is exactly the shape the audit
  // predicts under camera motion. The renderer draws between two of the
  // harness callbacks, so the upload is issued when the camera is published
  // and must be attributed to the frame that is measured next.
  const originalSetCameraState = viewer.setCameraState;
  viewer.setCameraState = function uploadOnPublish(state) {
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(1000), 0x88e8);
    return originalSetCameraState.call(this, state);
  };

  const summary = await runner.runWindow({
    regime: 'orbit',
    path: runner.createPathFromCurrentCamera(),
    warmupFrames: 1,
    measureFrames: 10
  });
  assert.equal(summary.samples, 10);
  assert.equal(summary.uploads.totalCalls, 10);
  assert.equal(summary.uploads.totalElementCalls, 10);
  assert.equal(summary.uploads.totalBytes, 10 * 4000);
  assert.equal(summary.uploads.framesWithUploadPercent, 100);
  uploadCounters.restore();
});

test('the window cancels its own frame callback when it closes', async () => {
  const scheduler = createScheduler();
  const { viewer, ownerDocument } = createHarnessDouble();
  const runner = createBenchmarkMatrixRunner({
    viewer,
    document: ownerDocument,
    requestFrame: scheduler.requestFrame,
    cancelFrame: scheduler.cancelFrame
  });
  await runner.runWindow({
    regime: 'static',
    path: runner.createPathFromCurrentCamera(),
    warmupFrames: 1,
    measureFrames: 5
  });
  assert.equal(scheduler.cancelledFrames, 1);
  assert.equal(scheduler.pendingFrames, 0);
});

test('a configuration applies every axis and reports what it achieved', async () => {
  const scheduler = createScheduler();
  const { viewer, ownerDocument, record } = createHarnessDouble({
    lodLevels: [3, 4, 5, 4]
  });
  const runner = createBenchmarkMatrixRunner({
    viewer,
    document: ownerDocument,
    requestFrame: scheduler.requestFrame,
    cancelFrame: scheduler.cancelFrame
  });
  const results = await runner.runMatrix({
    axes: {
      lod: [true],
      frustumCulling: [true],
      viewCount: [2],
      regime: ['orbit']
    },
    warmupFrames: 1,
    measureFrames: 12
  });

  assert.equal(results.length, 1);
  const cell = results[0];
  assert.deepEqual(cell.configuration, {
    viewCount: 2,
    lod: true,
    frustumCulling: true,
    forceLodLevel: -1,
    regime: 'orbit'
  });
  assert.deepEqual(cell.layout, { viewCount: 2, layoutMode: 'grid' });
  assert.deepEqual(record.adaptiveLod, [true]);
  assert.deepEqual(record.frustumCulling, [true]);
  assert.deepEqual(record.forceLod, [-1]);
  assert.equal(cell.summary.samples, 12);
  assert.equal(cell.summary.lod.distinctLevels, 3);
  assert.ok(cell.cameraPath.distanceBounds.farDistance > cell.cameraPath.distanceBounds.nearDistance);
});

test('the runner refuses a viewer that cannot drive the axes', () => {
  assert.throws(
    () => createBenchmarkMatrixRunner({ viewer: null }),
    /requires one viewer/
  );
  assert.throws(
    () => createBenchmarkMatrixRunner({ viewer: {} }),
    /requires viewer\.getCameraState\(\)/
  );
  const { viewer } = createHarnessDouble();
  assert.throws(
    () => createBenchmarkMatrixRunner({ viewer, document: null }),
    /requires one document/
  );
  assert.throws(
    () =>
      createBenchmarkMatrixRunner({
        viewer,
        document: { getElementById: () => null },
        uploadCounters: {},
        requestFrame: () => 1,
        cancelFrame: () => {}
      }),
    /instrumentGlUploads/
  );
});
