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
import {
  connectivityVisibleCells,
  countVisibleConnectivityEdges,
  createConnectivityEdgeIndex,
  createConnectivitySelectionScratch,
  selectConnectivityEdges,
} from '../assets/js/rendering/connectivity-edge-selection.js';
import { requireLodMembership } from '../assets/js/rendering/high-perf/renderer-contracts.js';
import { connectivityEdgesFromPairs } from './helpers/connectivity-edges.mjs';
import { admissionMembership, prefixMembership } from './helpers/lod-membership.mjs';

const mainSource = await readFile(
  new URL('../assets/js/app/ui/modules/connectivity-controls.js', import.meta.url),
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

const visibilityOwnerSource = extractSource(
  mainSource,
  'function getConnectivityVisibilityOwner(viewId, dimensionLevel)',
  '// Format edge count for display (compact)'
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
  '/**\n   * Update edge visibility with combined filter + LOD visibility.'
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

test('connectivity takes the level of detail through the one shared LodMembership validator', () => {
  // main.js keeps no validator of its own (a hand copy pinned the key set
  // and threw on every rank-order level).
  assert.match(
    visibilityOwnerSource,
    /requireLodMembership\(\s*viewer\.getCurrentLodMembership\(viewId, dimensionLevel\),\s*\{ pointCount, dimensionLevel, owner: 'Connectivity level of detail' \}/
  );
  assert.doesNotMatch(mainSource, /requireConnectivityLodMembership|admissionLevels,dimensionLevel/);
  const owner = { pointCount: 3, dimensionLevel: 2, owner: 'Connectivity level of detail' };
  const tree = admissionMembership(Uint8Array.from([0, 2, 1]), 1, { dimensionLevel: 2 });
  const rank = prefixMembership(3, 2, { dimensionLevel: 2 });
  assert.equal(requireLodMembership(null, owner), null);
  assert.equal(requireLodMembership(tree, owner), tree);
  assert.equal(requireLodMembership(rank, owner), rank);
  // A record carrying more fields than the contract names still passes.
  const extra = Object.freeze({ ...rank, ownerNote: 'kept' });
  assert.equal(requireLodMembership(extra, owner), extra);
  assert.throws(() => requireLodMembership({ ...tree }, owner), /frozen/);
  assert.throws(
    () => requireLodMembership(Object.freeze({ ...tree, admissionLevels: Uint8Array.from([0, 1]) }), owner),
    /one byte a cell/
  );
  assert.throws(() => requireLodMembership(Object.freeze({ ...tree, dimensionLevel: 3 }), owner), /in 3D/);
  assert.throws(() => requireLodMembership(Object.freeze({ ...tree, generationToken: null }), owner), /generationToken/);
  assert.throws(() => requireLodMembership(Object.freeze({ ...tree, generationToken: 1 }), owner), /generationToken/);
  assert.throws(() => requireLodMembership(Object.freeze({ ...tree, lodLevel: 0xff }), owner), /reduced level/);
  assert.throws(() => requireLodMembership(Object.freeze({ ...rank, count: 4 }), owner), /reduced level/);
  assert.throws(
    () => requireLodMembership(Object.freeze({ ...rank, indices: Uint32Array.of(0) }), owner),
    /indices/
  );
});

test('an edge is visible exactly when both endpoints pass the point threshold and the LOD admission boundary', () => {
  const belowThreshold = nextFloat32(
    POINT_VISIBILITY_THRESHOLD,
    -1
  );
  const aboveThreshold = nextFloat32(
    POINT_VISIBILITY_THRESHOLD,
    1
  );
  assert.equal(MIN_VISIBLE_ALPHA_BYTE, 3);
  assert.equal(Math.round(belowThreshold * 255), MIN_VISIBLE_ALPHA_BYTE - 1);
  assert.equal(Math.round(POINT_VISIBILITY_THRESHOLD * 255), MIN_VISIBLE_ALPHA_BYTE);
  assert.equal(Math.round(aboveThreshold * 255), MIN_VISIBLE_ALPHA_BYTE);

  // Transparency bytes are 0 or 1 (alpha-visibility.js): 1 passes the shared
  // threshold, 0 does not. Admission level <= the pane's level passes LOD.
  const sources = Uint32Array.from([0, 0, 1, 2]);
  const destinations = Uint32Array.from([1, 2, 3, 3]);
  const transparency = Uint8Array.from([1, 1, 1, 0]);
  const admissionLevels = Uint8Array.from([0, 1, 2, 0]);
  const index = createConnectivityEdgeIndex(connectivityEdgesFromPairs(sources, destinations, 4));
  const visibleAt = (lodMembership) => {
    const visibility = { transparency, lodMembership };
    const { mask } = connectivityVisibleCells(visibility, null);
    const output = new Uint32Array(4 * 3);
    const { shown } = selectConnectivityEdges(index, mask, 4, output, createConnectivitySelectionScratch());
    assert.equal(shown, countVisibleConnectivityEdges(index, mask, 0, 4));
    // Each record names its endpoints: map it back to its edge.
    return Array.from({ length: shown }, (_value, record) => {
      const edge = Array.from(sources).findIndex(
        (source, at) => source === output[record * 3] && destinations[at] === output[record * 3 + 1]
      );
      assert.notEqual(edge, -1);
      return edge;
    }).sort();
  };
  // Cell 3 is hidden: edges 1-3 and 2-3 are not visible.
  assert.deepEqual(visibleAt(null), [0, 1]);
  // LOD level 1 admits cells 0, 1 and 3: edge 0-2 (cell 2 at level 2) goes.
  assert.deepEqual(visibleAt(admissionMembership(admissionLevels, 1)), [0]);
  assert.deepEqual(visibleAt(admissionMembership(admissionLevels, 2)), [0, 1]);
  // A rank-order level of the first two cells keeps only edge 0-1.
  assert.deepEqual(visibleAt(prefixMembership(4, 2)), [0]);
  assert.deepEqual(visibleAt(prefixMembership(4, 3)), [0, 1]);
});

test('each updated view refreshes its viewer-owned edge selection and active UI consumes those stats', () => {
  const visibilityByView = Object.freeze({
    live: Object.freeze({
      transparency: Uint8Array.of(1),
      lodMembership: null,
      pointCount: 1,
      visibleCount: 99
    }),
    snap_1: Object.freeze({
      transparency: Uint8Array.of(1),
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
      // The shown graph and the working set it counts in (memory-budget.js).
      const loadedEdgeData = null;
      const setWorkingSet = () => { throw new Error('no graph is published here'); };
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
      refreshEdgeSelectionForView: (viewId) => {
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
      shownCount: 5,
      viewId: 'live',
      visibleCount: 11
    }),
    snap_1: Object.freeze({
      current: true,
      shownCount: 5,
      viewId: 'snap_1',
      visibleCount: 9
    }),
    snap_2: Object.freeze({
      current: true,
      shownCount: 5,
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
      // The shown graph and the working set it counts in (memory-budget.js).
      const loadedEdgeData = null;
      const setWorkingSet = () => { throw new Error('no graph is published here'); };
      let activeConnectivityStatsViewId = null;
      let actualVisibleEdges = 0;
      const getTotalEdges = () => 20;
      const currentEdgeLimit = () => Math.min(5, getTotalEdges());
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
      getEdgeSelectionStatsForView: (viewId) => {
        calls.push(['stats', viewId]);
        return statsByView[viewId];
      },
      setEdgeVisibleTarget: (target) => {
        calls.push(['target', target]);
        return true;
      },
      onConnectivityVisibleCount: () => () => {}
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
    'function initializeConnectivityControls({',
    '\n}\n'
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
    /const stats = viewer\.refreshEdgeSelectionForView\(viewId\)/
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
    /actualVisibleEdges = stats\.visibleCount \?\? actualVisibleEdges/
  );
  assert.match(
    updateActiveCountsSource,
    /viewer\.refreshEdgeSelectionForView\(activeViewId\)/
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
    /viewer\.setEdgeVisibleTarget\(currentEdgeLimit\(\)\)/
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
  const accepted = Uint8Array.from([1, 1, 0]);
  const categoryTransparency = Uint8Array.from([0, 0, 1]);
  const publicationError = new Error('synthetic GPU upload failure');
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
    _updateActiveCategoryCounts() {
      countSyncs += 1;
    },
  };

  assert.throws(
    () => viewContextViewerSyncMethods._pushTransparencyToViewer.call(state),
    (error) => error === publicationError
  );
  // The transparency is restored; the colors carry no visibility to restore.
  assert.deepEqual(Array.from(categoryTransparency), Array.from(accepted));
  assert.equal(countSyncs, 1);
});
