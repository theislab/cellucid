import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { HighPerfRenderer } from '../assets/js/rendering/high-perf-renderer.js';
import {
  resolvePresentedViewLayout,
  runSynchronousBorrowedViewDataCallback,
  selectPresentedCameraState,
} from '../assets/js/rendering/viewer.js';

function cameraState(seed, navigationMode = 'orbit') {
  return {
    navigationMode,
    orbit: {
      radius: seed + 2,
      targetRadius: seed + 3,
      theta: seed + 0.1,
      phi: seed + 0.2,
      target: [seed, seed + 1, seed + 2],
    },
    freefly: {
      position: [seed + 3, seed + 4, seed + 5],
      yaw: seed + 0.3,
      pitch: seed + 0.4,
    },
  };
}

function extractSourceRange(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

test('borrowed view callbacks are synchronous and validate every exit path', async () => {
  const payload = Object.freeze({
    positions: new Float32Array(),
    colors: new Uint8Array(),
    transparency: new Float32Array(),
    pointCount: 0,
    dimensionLevel: 2,
    geometryGeneration: 1,
    lodMembership: null,
  });

  let validations = 0;
  const result = runSynchronousBorrowedViewDataCallback(
    value => {
      assert.equal(value, payload);
      return value.pointCount + 7;
    },
    payload,
    () => {
      validations += 1;
    },
  );
  assert.equal(result, 7);
  assert.equal(validations, 1);

  const callbackFailure = new Error('callback failed');
  validations = 0;
  assert.throws(
    () => runSynchronousBorrowedViewDataCallback(
      () => {
        throw callbackFailure;
      },
      payload,
      () => {
        validations += 1;
      },
    ),
    callbackFailure,
  );
  assert.equal(validations, 1);

  let dualFailure = null;
  try {
    runSynchronousBorrowedViewDataCallback(
      () => {
        throw callbackFailure;
      },
      payload,
      () => {
        throw new Error('ownership changed too');
      },
    );
    assert.fail('dual ownership failure must throw');
  } catch (error) {
    dualFailure = error;
  }
  assert.ok(dualFailure instanceof AggregateError);
  assert.deepEqual(
    dualFailure.errors.map(error => error.message),
    ['callback failed', 'ownership changed too'],
  );

  validations = 0;
  assert.throws(
    () => runSynchronousBorrowedViewDataCallback(
      async () => 1,
      payload,
      () => {
        validations += 1;
      },
    ),
    /synchronously|Promise|thenable/i,
  );
  assert.equal(validations, 1);

  const thenGetterFailure = new Error('hostile then getter');
  validations = 0;
  assert.throws(
    () => runSynchronousBorrowedViewDataCallback(
      () => Object.defineProperty({}, 'then', {
        get() {
          throw thenGetterFailure;
        },
      }),
      payload,
      () => {
        validations += 1;
      },
    ),
    thenGetterFailure,
  );
  assert.equal(validations, 1);

  let generation = 1;
  assert.throws(
    () => runSynchronousBorrowedViewDataCallback(
      () => {
        generation += 1;
        return 1;
      },
      payload,
      () => {
        if (generation !== 1) {
          throw new Error('borrowed generation changed');
        }
      },
    ),
    /generation changed/i,
  );

  const viewerSource = await readFile(
    new URL('../assets/js/rendering/viewer.js', import.meta.url),
    'utf8',
  );
  const borrowSource = extractSourceRange(
    viewerSource,
    'withBorrowedViewData(viewId, callback)',
    'updateHighlight(highlightData',
  );
  assert.match(
    borrowSource,
    /positions:\s*owner\.positions[\s\S]*colors:\s*owner\.colors[\s\S]*transparency:\s*owner\.transparency/,
  );
  assert.match(
    borrowSource,
    /runSynchronousBorrowedViewDataCallback/,
  );
  assert.doesNotMatch(
    viewerSource,
    /pointCountForView\s*<=\s*0/,
    'zero-point publications must remain valid borrowed owners',
  );
});

test('presented layout mirrors exact odd-sized framebuffer grid arithmetic', () => {
  const canvasWidth = 1441;
  const canvasHeight = 1001;
  for (let viewCount = 1; viewCount <= 6; viewCount += 1) {
    const viewIds = Array.from(
      { length: viewCount },
      (_, index) => `view_${index}`,
    );
    const expectedCols = viewCount === 1
      ? 1
      : viewCount <= 3
        ? viewCount
        : Math.ceil(Math.sqrt(viewCount));
    const expectedRows = Math.ceil(viewCount / expectedCols);
    for (let viewIndex = 0; viewIndex < viewCount; viewIndex += 1) {
      const layout = resolvePresentedViewLayout({
        canvasHeight,
        canvasWidth,
        focusedViewId: viewIds[0],
        mode: 'grid',
        viewId: viewIds[viewIndex],
        viewIds,
      });
      const gridMultiview = viewCount > 1;
      const cols = gridMultiview ? expectedCols : 1;
      const rows = gridMultiview ? expectedRows : 1;
      const viewportWidth = gridMultiview
        ? Math.floor(canvasWidth / cols)
        : canvasWidth;
      const viewportHeight = gridMultiview
        ? Math.floor(canvasHeight / rows)
        : canvasHeight;
      const col = gridMultiview ? viewIndex % cols : 0;
      const row = gridMultiview ? Math.floor(viewIndex / cols) : 0;

      assert.equal(layout.cols, cols);
      assert.equal(layout.rows, rows);
      assert.equal(layout.viewportWidth, viewportWidth);
      assert.equal(layout.viewportHeight, viewportHeight);
      assert.equal(layout.viewportX, col * viewportWidth);
      assert.equal(
        layout.viewportY,
        (rows - 1 - row) * viewportHeight,
      );
      assert.equal(layout.paneLeftRatio, col / cols);
      assert.equal(layout.paneWidthRatio, 1 / cols);
      assert.equal(layout.scissorEnabled, gridMultiview);
      assert.ok(Object.isFrozen(layout));
    }
  }

  const viewIds = ['live', 'snap_1'];
  assert.throws(
    () => resolvePresentedViewLayout({
      canvasHeight,
      canvasWidth,
      focusedViewId: 'snap_1',
      mode: 'single',
      viewId: 'live',
      viewIds,
    }),
    /not presented/i,
  );
  const focused = resolvePresentedViewLayout({
    canvasHeight,
    canvasWidth,
    focusedViewId: 'snap_1',
    mode: 'single',
    viewId: 'snap_1',
    viewIds,
  });
  assert.equal(focused.viewportWidth, canvasWidth);
  assert.equal(focused.viewportHeight, canvasHeight);
  assert.equal(focused.scissorEnabled, false);

  assert.throws(
    () => resolvePresentedViewLayout({
      canvasHeight,
      canvasWidth,
      focusedViewId: 'live',
      mode: 'grid',
      viewId: 'live',
      viewIds: ['live', 'live'],
    }),
    /unique/i,
  );
  assert.throws(
    () => resolvePresentedViewLayout({
      canvasHeight,
      canvasWidth,
      focusedViewId: 'live',
      mode: 'grid',
      viewId: 'missing',
      viewIds: ['live'],
    }),
    /absent/i,
  );
});

test('presented camera selection follows focused, locked, and grid owners', () => {
  const globalCameraState = cameraState(1, 'planar');
  const storedCameraState = cameraState(10, 'free');

  for (const options of [
    {
      camerasLocked: true,
      focusedViewId: 'live',
      globalCameraState,
      gridMultiview: true,
      storedCameraState,
      viewId: 'snap_1',
      expected: globalCameraState,
    },
    {
      camerasLocked: false,
      focusedViewId: 'live',
      globalCameraState,
      gridMultiview: true,
      storedCameraState,
      viewId: 'live',
      expected: globalCameraState,
    },
    {
      camerasLocked: false,
      focusedViewId: 'live',
      globalCameraState,
      gridMultiview: true,
      storedCameraState,
      viewId: 'snap_1',
      expected: storedCameraState,
    },
    {
      camerasLocked: false,
      focusedViewId: 'live',
      globalCameraState,
      gridMultiview: false,
      storedCameraState,
      viewId: 'snap_1',
      expected: globalCameraState,
    },
  ]) {
    const selected = selectPresentedCameraState(options);
    assert.deepEqual(selected, options.expected);
    assert.notEqual(selected, options.expected);
    assert.notEqual(selected.orbit, options.expected.orbit);
    assert.notEqual(
      selected.freefly.position,
      options.expected.freefly.position,
    );
    selected.orbit.target[0] = -999;
    assert.notEqual(options.expected.orbit.target[0], -999);
  }

  assert.throws(
    () => selectPresentedCameraState({
      camerasLocked: false,
      focusedViewId: 'live',
      globalCameraState,
      gridMultiview: true,
      storedCameraState: null,
      viewId: 'snap_1',
    }),
    /camera state/i,
  );
});

test('view fog ranges use exact live and snapshot owners without mutation', () => {
  const renderer = Object.create(HighPerfRenderer.prototype);
  renderer._positions = new Float32Array([1, 2, 3]);
  renderer._liveGeometryGeneration = 7;
  renderer._boundingSphere = {
    center: [1, 2, 3],
    radius: 2,
  };
  renderer.snapshotBuffers = new Map([
    ['shared', {
      geometryGeneration: 7,
      bounds: {
        minX: -100,
        maxX: 100,
        minY: -100,
        maxY: 100,
        minZ: -100,
        maxZ: 100,
      },
    }],
    ['snap_1', {
      geometryGeneration: 6,
      bounds: {
        minX: -1,
        maxX: 3,
        minY: 0,
        maxY: 4,
        minZ: 2,
        maxZ: 2,
      },
    }],
  ]);
  renderer.fogNear = 91;
  renderer.fogFar = 92;

  const liveRange = renderer.getViewFogRange('live', [1, 2, 8]);
  assert.deepEqual(liveRange, { fogNear: 3, fogFar: 7 });
  assert.ok(Object.isFrozen(liveRange));
  assert.equal(renderer.fogNear, 91);
  assert.equal(renderer.fogFar, 92);

  assert.deepEqual(
    renderer.getViewFogRange('shared', [1, 2, 8]),
    { fogNear: 3, fogFar: 7 },
    'shared geometry must match renderWithSnapshot live-sphere fog',
  );

  const snapshotRange = renderer.getViewFogRange(
    'snap_1',
    [1, 2, 7],
  );
  const radius = Math.sqrt(8);
  assert.ok(Math.abs(snapshotRange.fogNear - (5 - radius)) < 1e-12);
  assert.ok(Math.abs(snapshotRange.fogFar - (5 + radius)) < 1e-12);
  assert.equal(renderer.fogNear, 91);
  assert.equal(renderer.fogFar, 92);

  renderer.autoComputeFogRange([1, 2, 8]);
  assert.equal(renderer.fogNear, 3);
  assert.equal(renderer.fogFar, 7);

  renderer._boundingSphere = {
    center: [1, 2, 3],
    radius: 0,
  };
  assert.deepEqual(
    renderer.getViewFogRange('live', [1, 2, 8]),
    { fogNear: 5, fogFar: 5 },
  );
  assert.throws(
    () => renderer.getViewFogRange('missing', [0, 0, 0]),
    /does not exist/i,
  );
  assert.throws(
    () => renderer.getViewFogRange('live', [0, Number.NaN, 0]),
    /finite/i,
  );

  renderer.snapshotBuffers.set('invalid', {
    bounds: {
      minX: 1,
      maxX: -1,
      minY: 0,
      maxY: 0,
      minZ: 0,
      maxZ: 0,
    },
  });
  assert.throws(
    () => renderer.getViewFogRange('invalid', [0, 0, 0]),
    /minima/i,
  );
});

test('LOD observer identity stays O(1) and changes with the spatial owner', () => {
  const renderer = Object.create(HighPerfRenderer.prototype);
  renderer._perViewState = new Map([
    ['live', { lastLodLevel: 0 }],
  ]);
  renderer.snapshotBuffers = new Map();
  renderer._lodSpatialOwnerTokens = new WeakMap();
  const firstSpatialOwner = {
    lodLevels: [{ isFullDetail: false }],
  };
  renderer.spatialIndices = new Map([[2, firstSpatialOwner]]);

  const firstToken = renderer.getCurrentLodOwnerToken('live', 2);
  assert.ok(Object.isFrozen(firstToken));
  assert.equal(
    renderer.getCurrentLodOwnerToken('live', 2),
    firstToken,
  );
  assert.equal(firstSpatialOwner._lodMembershipOwner, undefined);

  const replacementSpatialOwner = {
    lodLevels: [{ isFullDetail: false }],
  };
  renderer.spatialIndices.set(2, replacementSpatialOwner);
  const replacementToken =
    renderer.getCurrentLodOwnerToken('live', 2);
  assert.notEqual(replacementToken, firstToken);
  assert.equal(replacementSpatialOwner._lodMembershipOwner, undefined);

  replacementSpatialOwner.lodLevels[0].isFullDetail = true;
  assert.equal(
    renderer.getCurrentLodOwnerToken('live', 2),
    null,
  );
});

test('sequential LOD ownership stays O(K) without materializing random membership', () => {
  const renderer = Object.create(HighPerfRenderer.prototype);
  renderer._perViewState = new Map([
    ['live', { lastLodLevel: 0 }],
  ]);
  renderer.snapshotBuffers = new Map();
  renderer._lodSpatialOwnerTokens = new WeakMap();
  renderer._lodSequentialMemberships = new WeakMap();
  const admitted = Uint32Array.from([7, 1, 9]);
  const reducedLevel = {
    indices: admitted,
    isFullDetail: false,
    pointCount: admitted.length,
  };
  const spatialOwner = {
    dimensionLevel: 2,
    lodLevels: [reducedLevel],
    pointCount: 10_000_000,
  };
  renderer.spatialIndices = new Map([[2, spatialOwner]]);

  const membership =
    renderer.getCurrentLodSequentialMembership('live', 2);
  assert.ok(Object.isFrozen(membership));
  assert.deepEqual(
    Reflect.ownKeys(membership).sort(),
    [
      'dimensionLevel',
      'generationToken',
      'indices',
      'lodLevel',
      'pointCount',
    ],
  );
  assert.equal(membership.indices, admitted);
  assert.equal(membership.pointCount, spatialOwner.pointCount);
  assert.equal(
    renderer.getCurrentLodSequentialMembership('live', 2),
    membership,
    'one stable descriptor must be reused for the same spatial level',
  );
  assert.equal(
    spatialOwner._lodMembershipOwner,
    undefined,
    'sequential ownership must not allocate the N-byte admission table',
  );
});

test('presented state owns renderer-equivalent layout, camera, fog, and LOD certificates', async () => {
  const viewerSource = await readFile(
    new URL('../assets/js/rendering/viewer.js', import.meta.url),
    'utf8',
  );
  const presentedSource = extractSourceRange(
    viewerSource,
    'getPresentedViewState(viewId)',
    '// HP renderer controls',
  );
  assert.match(presentedSource, /resolvePresentedViewLayout\(\{/);
  assert.match(presentedSource, /selectPresentedCameraState\(\{/);
  assert.match(presentedSource, /configureInteractiveProjection\(/);
  assert.match(presentedSource, /hpRenderer\.getViewFogRange\(/);
  assert.match(
    presentedSource,
    /lodGenerationToken[\s\S]*owner\.lodMembership\?\.generationToken/,
  );
  assert.match(
    presentedSource,
    /lodGenerationId[\s\S]*getPresentedLodGenerationId/,
  );
  assert.match(
    presentedSource,
    /createPresentedLodMembership\(owner\.lodMembership\)/,
  );
  assert.doesNotMatch(
    presentedSource,
    /lodMembership:\s*owner\.lodMembership/,
    'presented state must not disclose renderer-owned index arrays',
  );
  const certificateSource = extractSourceRange(
    presentedSource,
    'const certificate = Object.freeze({',
    'const renderState = {',
  );
  assert.doesNotMatch(
    certificateSource,
    /lodMembership\s*:/,
    'retained cache certificates must not own O(N) membership arrays',
  );
  for (const field of [
    'projectionCenterNdcX',
    'viewportHeight',
    'viewportWidth',
    'viewportX',
    'viewportY',
    'fogNear',
    'fogFar',
  ]) {
    assert.match(presentedSource, new RegExp(`\\b${field}\\b`));
  }

  const publicationSource = extractSourceRange(
    viewerSource,
    'function publishLodLevelChange(viewId)',
    'function getPublishedDimensionLevel(viewId)',
  );
  assert.match(
    publicationSource,
    /previous\.lodOwnerToken\s*===\s*lodOwnerToken/,
    'same-level LOD replacement must compare its lightweight spatial identity',
  );
  assert.match(
    publicationSource,
    /hpRenderer\.getCurrentLodOwnerToken\(/,
  );
  assert.doesNotMatch(
    publicationSource,
    /getCurrentLodMembership\(/,
    'LOD event publication must not materialize an O(N) membership owner',
  );
  assert.match(
    viewerSource,
    /hpRenderer\.getCurrentLodSequentialMembership\(/,
    'borrowed preview/export ownership must consume the compact K-prefix descriptor',
  );
  assert.match(
    publicationSource,
    /const next = Object\.freeze\(\{\s*dimensionLevel,\s*geometryGeneration,\s*lodLevel,\s*viewId:/,
    'public LOD events must retain their exact four-key contract',
  );
});

test('presented-state observers stay semantic and allocation-bounded at frame cadence', async () => {
  const [source, settlementSource] = await Promise.all([
    readFile(
      new URL('../assets/js/rendering/viewer.js', import.meta.url),
      'utf8',
    ),
    readFile(
      new URL(
        '../assets/js/rendering/presented-camera-settlement.js',
        import.meta.url,
      ),
      'utf8',
    ),
  ]);
  const trackerSource = extractSourceRange(
    source,
    'function trackPresentedFrameState(now, canvasWidth, canvasHeight)',
    'function publishViewDataGeneration(viewId)',
  );
  assert.match(
    settlementSource,
    /const DEFAULT_SETTLE_MILLISECONDS = 120;/,
  );
  assert.match(
    settlementSource,
    /const MINIMUM_UNCHANGED_FRAMES = 2;/,
  );
  assert.match(
    settlementSource,
    /const MAXIMUM_UNCHANGED_FRAMES = 12;/,
  );
  assert.match(
    settlementSource,
    /this\._unchangedFrameCount < MINIMUM_UNCHANGED_FRAMES[\s\S]*now - this\._lastChangeTime < DEFAULT_SETTLE_MILLISECONDS[\s\S]*this\._unchangedFrameCount < MAXIMUM_UNCHANGED_FRAMES/,
  );
  assert.match(
    trackerSource,
    /presentedCameraSettlement\.observeFrame\(\s*true,\s*now,\s*wasInitialized\s*\)/,
  );
  assert.match(
    trackerSource,
    /presentedCameraSettlement\.observeFrame\(\s*false,\s*now,\s*true\s*\)/,
  );
  assert.match(trackerSource, /'camera-changing'/);
  assert.match(trackerSource, /'camera-settled'/);
  assert.doesNotMatch(
    trackerSource,
    /Object\.freeze|\bnew\s+|\[\s*\]|\{\s*\}/,
    'frame tracking must compare generation-owned scalars without allocating',
  );

  const renderSource = extractSourceRange(
    source,
    'function render()',
    'function renderSingleView(',
  );
  const guardedTracking = renderSource.match(
    /if \(presentedViewStateListeners\.size !== 0\) \{\s*trackPresentedFrameState\(now, width, height\);\s*\}/,
  );
  assert.ok(
    guardedTracking,
    'unsubscribed frames must not call the presentation tracker',
  );
  assert.ok(
    renderSource.indexOf(guardedTracking[0]) <
      renderSource.indexOf('if (!pointCount)'),
    'subscribed zero-point frames must still establish and settle camera state',
  );

  const publisherSource = extractSourceRange(
    source,
    'function publishPresentedViewStateChange(',
    'function trackPresentedFrameState(',
  );
  assert.ok(
    publisherSource.indexOf(
      'if (presentedViewStateListeners.size === 0) return;',
    ) < publisherSource.indexOf('const event = Object.freeze({'),
    'events must not be allocated when no observers exist',
  );
  assert.match(
    publisherSource,
    /const event = Object\.freeze\(\{\s*generation:\s*presentedViewStateGeneration,\s*reason,\s*viewId:\s*exactViewId\s*\}\);/,
  );

  const subscriptionSource = extractSourceRange(
    source,
    'onPresentedViewStateChanged(listener)',
    'start()',
  );
  assert.match(
    subscriptionSource,
    /presentedViewStateListeners\.add\(exactListener\)/,
  );
  assert.match(subscriptionSource, /let subscribed = true;/);
  assert.match(subscriptionSource, /if \(!subscribed\) return;/);
  assert.match(
    subscriptionSource,
    /presentedViewStateListeners\.delete\(exactListener\)/,
  );

  const controlsSource = extractSourceRange(
    source,
    'setShowCentroidPoints(show, viewId)',
    'setRenderMode(mode)',
  );
  assert.match(
    controlsSource,
    /if \(setViewFlags\(key, \{ points: exactShow \}\)\) \{\s*publishPresentedViewStateChange\('overlay', key\)/,
  );
  assert.match(
    controlsSource,
    /const changed = setViewFlags\(key, \{ labels: exactShow \}\)[\s\S]*if \(changed\) \{\s*publishPresentedViewStateChange\('overlay', key\)/,
  );

  const shaderSource = extractSourceRange(
    source,
    'setShaderQuality(quality)',
    'setFrustumCulling(enabled)',
  );
  assert.match(shaderSource, /if \(quality === currentShaderQuality\) return;/);
  assert.match(
    shaderSource,
    /currentShaderQuality = quality;[\s\S]*publishPresentedViewStateChange\(\s*'style'/,
  );
});
