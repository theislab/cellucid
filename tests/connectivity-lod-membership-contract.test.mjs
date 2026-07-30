import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  MIN_VISIBLE_ALPHA_BYTE,
  POINT_VISIBILITY_THRESHOLD,
} from '../assets/js/rendering/alpha-visibility.js';
import {
  viewContextViewerSyncMethods,
} from '../assets/js/app/state/managers/view-context-viewer-sync.js';

const mainSource = await readFile(
  new URL('../assets/js/app/main.js', import.meta.url),
  'utf8'
);
const viewerSource = await readFile(
  new URL('../assets/js/rendering/viewer.js', import.meta.url),
  'utf8'
);

function extractSource(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.notEqual(start, -1, `Missing source marker: ${startNeedle}`);
  const end = source.indexOf(endNeedle, start);
  assert.notEqual(end, -1, `Missing source marker: ${endNeedle}`);
  return source.slice(start, end).trim();
}

function nextFloat32(value, direction) {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  const bits = view.getUint32(0, true);
  view.setUint32(0, bits + direction, true);
  return view.getFloat32(0, true);
}

const membershipValidatorSource = extractSource(
  mainSource,
  'function requireConnectivityLodMembership(',
  '/**\n       * Resolve one exact compositional visibility owner.'
);
const targetedVisibilitySource = extractSource(
  mainSource,
  'function updateEdgeVisibilityForView(',
  'function publishActiveConnectivityCounts('
);
const activeCountsSource = extractSource(
  mainSource,
  'function publishActiveConnectivityCounts(',
  'function updateActiveConnectivityCounts()'
);
const updateActiveCountsSource = extractSource(
  mainSource,
  'function updateActiveConnectivityCounts()',
  '/**\n       * Update edge visibility with combined filter + LOD visibility.'
);
const visibilityCoreSource = extractSource(
  mainSource,
  'function updateEdgeVisibilityCore()',
  '// Throttled active-view edge counting:'
);
const throttledVisibilitySource = extractSource(
  mainSource,
  'function updateEdgeVisibility()',
  '// Point transparency publication has already updated the active view'
);
const edgeLimitSource = extractSource(
  mainSource,
  'function applyEdgeLodLimit()',
  '// Initial slider setup and info display'
);
const visibilityEventSource = extractSource(
  mainSource,
  'const onVisibilityChange = () =>',
  '// LOD publications occur inside the render stack.'
);
const lodTrackingSource = extractSource(
  mainSource,
  'let lodTrackingActive = false;',
  "state.on('visibility:changed', onVisibilityChange);"
);
const edgePublicationSource = extractSource(
  mainSource,
  'function publishConnectivityEdges(owner, edgeData)',
  'function clearPublishedConnectivityEdges()'
);
const visibilityTextureSource = extractSource(
  viewerSource,
  'function updateVisibilityTextureV2ForView(',
  '/**\n   * Delete edge textures for a specific view'
);

test('connectivity validates the exact immutable compact LOD owner', () => {
  const requireMembership = new Function(
    `${membershipValidatorSource}
     return requireConnectivityLodMembership;`
  )();
  const generationToken = Object.freeze({});
  const valid = Object.freeze({
    admissionLevels: Uint8Array.from([0, 2, 1]),
    dimensionLevel: 2,
    generationToken,
    indices: Uint32Array.from([0, 2]),
    lodLevel: 1,
    pointCount: 3
  });

  assert.equal(requireMembership(null, 3, 2), null);
  assert.equal(requireMembership(valid, 3, 2), valid);
  assert.throws(
    () => requireMembership({ ...valid }, 3, 2),
    /exact immutable admission owner/
  );
  assert.throws(
    () => requireMembership(Object.freeze({
      ...valid,
      admissionLevels: Uint8Array.from([0, 1])
    }), 3, 2),
    /exact immutable admission owner/
  );
  assert.throws(
    () => requireMembership(Object.freeze({
      ...valid,
      dimensionLevel: 3
    }), 3, 2),
    /exact immutable admission owner/
  );
  assert.throws(
    () => requireMembership(Object.freeze({
      ...valid,
      generationToken: null
    }), 3, 2),
    /exact immutable admission owner/
  );
  assert.throws(
    () => requireMembership(Object.freeze({
      ...valid,
      generationToken: 1
    }), 3, 2),
    /exact immutable admission owner/
  );
  assert.throws(
    () => requireMembership(Object.freeze({
      ...valid,
      lodLevel: 0xff
    }), 3, 2),
    /exact immutable admission owner/
  );
});

test('connectivity R8 publication keeps the byte-3 threshold and LOD admission boundary', () => {
  const belowThreshold = nextFloat32(
    POINT_VISIBILITY_THRESHOLD,
    -1
  );
  const aboveThreshold = nextFloat32(
    POINT_VISIBILITY_THRESHOLD,
    1
  );

  assert.equal(MIN_VISIBLE_ALPHA_BYTE, 3);
  assert.equal(
    Math.round(belowThreshold * 255),
    MIN_VISIBLE_ALPHA_BYTE - 1
  );
  assert.equal(
    Math.round(POINT_VISIBILITY_THRESHOLD * 255),
    MIN_VISIBLE_ALPHA_BYTE
  );
  assert.equal(
    Math.round(aboveThreshold * 255),
    MIN_VISIBLE_ALPHA_BYTE
  );
  assert.match(
    visibilityTextureSource,
    /alpha >= POINT_VISIBILITY_THRESHOLD/
  );
  assert.match(
    visibilityTextureSource,
    /lodVisibility\.admissionLevels\[index\] <=\s*lodVisibility\.lodLevel/
  );
  assert.match(
    visibilityTextureSource,
    /\)\s*\?\s*255\s*:\s*0/
  );
});

test('each updated view refreshes its viewer-owned prefix and active UI consumes those stats', () => {
  const visibilityByView = Object.freeze({
    live: Object.freeze({
      transparency: Float32Array.of(1),
      lodMembership: null,
      pointCount: 1,
      visibleCount: 99
    }),
    snap_1: Object.freeze({
      transparency: Float32Array.of(1),
      lodMembership: null,
      pointCount: 1,
      visibleCount: 88
    })
  });
  const statsByView = Object.freeze({
    live: Object.freeze({
      current: true,
      viewId: 'live',
      visibleCount: 11
    }),
    snap_1: Object.freeze({
      current: true,
      viewId: 'snap_1',
      visibleCount: 7
    })
  });
  let activeViewId = 'snap_1';
  const calls = [];
  const harness = new Function(
    'state',
    'viewer',
    'getConnectivityVisibilityOwner',
    'updateSliderRange',
    'calls',
    `
      let edgesLoaded = true;
      let activeConnectivityStatsViewId = null;
      let actualVisibleEdges = 0;
      const connectivityCheckbox = { checked: false };
      function applyEdgeLodLimit() {
        calls.push(['target', actualVisibleEdges]);
      }
      ${targetedVisibilitySource}
      ${activeCountsSource}
      return {
        updateEdgeVisibilityForView,
        getStatsViewId: () => activeConnectivityStatsViewId,
        getVisibleCount: () => actualVisibleEdges
      };
    `
  )(
    { getActiveViewId: () => activeViewId },
    {
      getViewDimension: () => 2,
      updateEdgeVisibilityV2FromLod: () => {
        calls.push(['texture', 'live']);
        return true;
      },
      updateEdgeVisibilityV2ForViewFromLod: (viewId) => {
        calls.push(['texture', viewId]);
        return true;
      },
      refreshEdgePrefixForView: (viewId) => {
        calls.push(['prefix', viewId]);
        return statsByView[viewId];
      }
    },
    (viewId) => visibilityByView[viewId],
    (visibleCount) => calls.push(['slider', visibleCount]),
    calls
  );

  assert.equal(
    harness.updateEdgeVisibilityForView('live'),
    statsByView.live
  );
  assert.deepEqual(calls, [
    ['texture', 'live'],
    ['prefix', 'live']
  ]);
  assert.equal(harness.getStatsViewId(), null);
  assert.equal(harness.getVisibleCount(), 0);

  assert.equal(
    harness.updateEdgeVisibilityForView('snap_1'),
    statsByView.snap_1
  );
  assert.deepEqual(calls.slice(2), [
    ['texture', 'snap_1'],
    ['prefix', 'snap_1'],
    ['slider', 7]
  ]);
  assert.equal(harness.getStatsViewId(), 'snap_1');
  assert.equal(harness.getVisibleCount(), 7);

  activeViewId = 'live';
  harness.updateEdgeVisibilityForView('snap_1', false);
  assert.equal(harness.getStatsViewId(), 'snap_1');
  assert.equal(harness.getVisibleCount(), 7);
  harness.updateEdgeVisibilityForView('live');
  assert.equal(harness.getStatsViewId(), 'live');
  assert.equal(harness.getVisibleCount(), 11);
});

test('full connectivity refresh completes every pane before publishing one shared target', () => {
  const statsByView = Object.freeze({
    live: Object.freeze({
      current: true,
      viewId: 'live',
      visibleCount: 11
    }),
    snap_1: Object.freeze({
      current: true,
      viewId: 'snap_1',
      visibleCount: 9
    }),
    snap_2: Object.freeze({
      current: true,
      viewId: 'snap_2',
      visibleCount: 7
    })
  });
  const calls = [];
  const harness = new Function(
    'state',
    'viewer',
    'updateSliderRange',
    'updateConnectivityInfo',
    'statsByView',
    'calls',
    `
      let edgesLoaded = true;
      let activeConnectivityStatsViewId = null;
      let actualVisibleEdges = 0;
      let currentEdgeLimit = 5;
      const connectivityCheckbox = { checked: true };
      function updateEdgeVisibilityForView(viewId, publishActive) {
        calls.push(['refresh', viewId, publishActive]);
        return statsByView[viewId];
      }
      ${edgeLimitSource}
      ${activeCountsSource}
      ${visibilityCoreSource}
      return {
        updateEdgeVisibilityCore,
        getStatsViewId: () => activeConnectivityStatsViewId,
        getVisibleCount: () => actualVisibleEdges
      };
    `
  )(
    { getActiveViewId: () => 'snap_2' },
    {
      getSnapshotViews: () => [
        { id: 'snap_1' },
        { id: 'snap_2' }
      ],
      getEdgePrefixStatsForView: (viewId) => {
        calls.push(['stats', viewId]);
        return statsByView[viewId];
      },
      setEdgeVisibleTarget: (target) => {
        calls.push(['target', target]);
        return true;
      }
    },
    (visibleCount) => calls.push(['slider', visibleCount]),
    (visibleCount, shownCount) => {
      calls.push(['info', visibleCount, shownCount]);
    },
    statsByView,
    calls
  );

  harness.updateEdgeVisibilityCore();
  assert.deepEqual(calls, [
    ['refresh', 'live', false],
    ['refresh', 'snap_1', false],
    ['refresh', 'snap_2', false],
    ['slider', 7],
    ['stats', 'snap_2'],
    ['target', 5],
    ['stats', 'snap_2'],
    ['info', 7, 5]
  ]);
  assert.equal(harness.getStatsViewId(), 'snap_2');
  assert.equal(harness.getVisibleCount(), 7);
});

test('main connectivity lifecycle uses compact APIs and owns no dense LOD mask', () => {
  const connectivityControlsSource = extractSource(
    mainSource,
    'function initializeConnectivityControls()',
    '// ========================================\n    // PERFORMANCE BENCHMARK CONTROLS'
  );

  assert.match(
    mainSource,
    /viewer\.getCurrentLodMembership\(viewId,\s*dimensionLevel\)/
  );
  assert.match(
    mainSource,
    /viewer\.updateEdgeVisibilityV2FromLod\(/
  );
  assert.match(
    mainSource,
    /viewer\.updateEdgeVisibilityV2ForViewFromLod\(/
  );
  assert.match(
    targetedVisibilitySource,
    /const stats = viewer\.refreshEdgePrefixForView\(viewId\)/
  );
  assert.match(
    targetedVisibilitySource,
    /publishActiveConnectivityCounts\(viewId,\s*stats\)/
  );
  assert.match(
    activeCountsSource,
    /stats\.current !== true[\s\S]*stats\.viewId !== viewId/
  );
  assert.match(
    activeCountsSource,
    /actualVisibleEdges = stats\.visibleCount/
  );
  assert.match(
    updateActiveCountsSource,
    /viewer\.refreshEdgePrefixForView\(activeViewId\)/
  );
  assert.match(
    visibilityCoreSource,
    /updateEdgeVisibilityForView\('live', false\)/
  );
  assert.match(
    visibilityCoreSource,
    /updateEdgeVisibilityForView\(snapshot\.id, false\)/
  );
  assert.match(
    visibilityCoreSource,
    /publishActiveConnectivityCounts\(activeViewId, activeStats\)/
  );
  assert.match(
    edgeLimitSource,
    /viewer\.setEdgeVisibleTarget\(currentEdgeLimit\)/
  );
  assert.doesNotMatch(
    edgeLimitSource,
    /setEdgeLodLimit|findLodLimitFast/
  );
  assert.doesNotMatch(
    connectivityControlsSource,
    /getLodVisibilityArray|combinedVisibilityBuffers|cachedCombinedVisibility|cachedConnectivityVisibility|cachedConnectivityViewId|visibleEdgePrefixSum|countVisibleEdges|findLodLimitFast/
  );
  assert.doesNotMatch(
    connectivityControlsSource,
    /new (?:Float32Array|Uint32Array)\(\s*(?:n|nEdges|pointCount|edgeSources\.length)\s*(?:\+\s*1)?\s*\)/
  );
  assert.match(mainSource, /viewer\.onLodChanged\(event =>/);
  assert.match(mainSource, /pendingLodViewIds\.add\(event\.viewId\)/);
  assert.match(
    lodTrackingSource,
    /MAX_LOD_VISIBILITY_RETRIES\s*=\s*2/
  );
  assert.match(
    lodTrackingSource,
    /catch\s*\(error\)[\s\S]*pendingLodViewIds\.add\(viewId\)/
  );
  assert.match(
    lodTrackingSource,
    /notifications\.error\([\s\S]*GPU visibility upload failures/
  );
  assert.match(
    visibilityEventSource,
    /activeConnectivityStatsViewId !== state\.getActiveViewId\(\)/
  );
  assert.match(
    visibilityEventSource,
    /updateActiveConnectivityCounts\(\)/
  );
  assert.doesNotMatch(
    visibilityEventSource,
    /updateEdgeVisibilityCore|updateEdgeVisibilityForView|updateEdgeVisibilityV2/
  );
  assert.match(
    throttledVisibilitySource,
    /updateActiveConnectivityCounts\(\)/
  );
  assert.doesNotMatch(
    throttledVisibilitySource,
    /updateEdgeVisibilityCore|updateEdgeVisibilityForView|updateEdgeVisibilityV2/
  );
  assert.doesNotMatch(
    updateActiveCountsSource,
    /updateEdgeVisibilityV2/
  );
  assert.doesNotMatch(mainSource, /setInterval\(/);
  assert.doesNotMatch(
    edgePublicationSource,
    /(?:sources|destinations|weights)\.slice\(\)/
  );
  assert.match(
    edgePublicationSource,
    /loadedEdgeData\s*=\s*publishedEdgeData/
  );
});

test('application transparency rolls back to the accepted viewer owner on publication failure', () => {
  const accepted = Float32Array.from([1, 0.25, 0]);
  const categoryTransparency = Float32Array.from([0, 0, 1]);
  const publicationError = new Error('synthetic GPU upload failure');
  let alphaSyncs = 0;
  let countSyncs = 0;
  const state = {
    activeViewId: 'live',
    categoryTransparency,
    viewer: {
      getViewTransparency(viewId) {
        assert.equal(viewId, 'live');
        return accepted;
      },
      updateTransparency(owner) {
        assert.equal(owner, categoryTransparency);
        throw publicationError;
      },
    },
    _isLiveView() {
      return true;
    },
    _syncColorsAlpha() {
      alphaSyncs += 1;
    },
    _updateActiveCategoryCounts() {
      countSyncs += 1;
    },
  };

  assert.throws(
    () => viewContextViewerSyncMethods._pushTransparencyToViewer.call(state),
    (error) => error === publicationError
  );
  assert.deepEqual(Array.from(categoryTransparency), Array.from(accepted));
  assert.equal(alphaSyncs, 1);
  assert.equal(countSyncs, 1);
});
