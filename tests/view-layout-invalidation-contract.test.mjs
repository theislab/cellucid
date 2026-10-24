/**
 * A view's geometry is identified by its layout, not by its dimension.
 *
 * Dataset identity version 3 declares any number of embeddings per dimension,
 * and every embedding is a layout keyed by its embedding id. These tests load
 * an identity with two 2D embeddings and switch between them: a
 * same-dimension switch must be a complete view publication, and every
 * per-view cache derived from geometry (LOD, frustum culling, picking, vector
 * spawn sources, centroids) must follow the layout. Keyed by dimension, such a
 * switch was an early-return no-op that left all of that state describing the
 * previous embedding.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createDataState } from '../assets/js/app/state/core/data-state.js';
import { DimensionManager } from '../assets/js/data/dimension-manager.js';
import {
  assembleAnnDataCandidates,
  describeAnnDataProbes,
} from '../assets/js/data/data-mapping-candidates.js';
import {
  createVectorFieldManager,
  resolveVectorFields,
} from '../assets/js/data/vector-field-manager.js';
import { VelocityOverlay } from '../assets/js/rendering/overlays/velocity/velocity-overlay.js';
import { loadsAsReader } from './helpers/dimension-loads.mjs';

const viewerSource = readFileSync(
  new URL('../assets/js/rendering/viewer.js', import.meta.url),
  'utf8',
);

const RAW_LAYOUTS = Object.freeze({
  // Two cells per layout. "X_umap" fills the 2D slot; "X_tsne" is a second
  // declared 2D embedding of the same cells.
  X_umap: [0, 0, 2, 2],
  X_tsne: [0, 0, 10, -10],
  X_umap_3d: [0, 0, 0, 1, 2, 3],
});

// Items in (dimension, id) order; an item's position is its payload index.
const EMBEDDINGS = Object.freeze({
  default_dimension: 2,
  defaults: { '2d': 'X_umap', '3d': 'X_umap_3d' },
  items: {
    X_tsne: {
      label: 't-SNE',
      dimension: 2,
      path: 'obsm/0/0-1',
      source: { key: 'X_tsne', columns: [0, 1] },
    },
    X_umap: {
      label: 'UMAP',
      dimension: 2,
      path: 'obsm/1/0-1',
      source: { key: 'X_umap', columns: [0, 1] },
    },
    X_umap_3d: {
      label: 'X_umap_3d',
      dimension: 3,
      path: 'obsm/2/0-1-2',
      source: { key: 'X_umap_3d', columns: [0, 1, 2] },
    },
  },
});

async function createTwoLayoutManager() {
  const manager = new DimensionManager({ embeddingsMetadata: EMBEDDINGS });
  loadsAsReader(manager, async layoutKey =>
    Float32Array.from(RAW_LAYOUTS[layoutKey]));
  manager.publishCellCount(2);
  return manager;
}

function createRecordingViewer({ failEmbedding = null } = {}) {
  const calls = [];
  const viewPositions = new Map();
  const viewer = {
    calls,
    getViewLayout() {
      return { mode: 'grid' };
    },
    getViewPositions(viewId) {
      return viewPositions.get(viewId);
    },
    hasVectorFieldForLayout() {
      return false;
    },
    isDisposed() {
      return false;
    },
    resetVectorFieldOverlay() {},
    setCentroidLabels() {},
    setCentroids() {},
    setData(payload) {
      viewPositions.set('live', payload.positions);
      calls.push(['setData', payload.layoutKey, payload.dimensionLevel]);
    },
    setViewEmbedding(viewId, embedding) {
      calls.push(['setViewEmbedding', viewId, { ...embedding }]);
      if (failEmbedding !== null && embedding.layoutKey === failEmbedding) {
        throw new Error('viewer rejected the embedding');
      }
    },
    setViewLayout() {},
    setViewPositions(viewId, positions, dimension) {
      viewPositions.set(viewId, positions);
      calls.push(['setViewPositions', viewId, positions, dimension]);
    },
    updatePositions(positions, dimension) {
      viewPositions.set('live', positions);
      calls.push(['updatePositions', positions, dimension]);
    },
    updateColors() {},
    updateSnapshotAttributes() {},
    updateTransparency() {},
  };
  return viewer;
}

async function createScene(viewerOptions = {}) {
  const viewer = createRecordingViewer(viewerOptions);
  const state = createDataState({ viewer, labelLayer: null });
  const manager = await createTwoLayoutManager();
  state.setDimensionManager(manager);
  const positions = await manager.getPositions('X_umap', { showProgress: false });
  state.initScene(positions, { fields: [] });
  const notifications = [];
  state.on('view:representation-changed', change => notifications.push(change));
  viewer.calls.length = 0;
  return { manager, notifications, positions, state, viewer };
}

// An embedding is named by its obsm key and the columns plotted, which is the
// layout's provenance.
const TSNE = Object.freeze({ key: 'X_tsne', columns: [0, 1] });

test('two layouts of one dimension are distinct registry entries with their own caches', async () => {
  const manager = await createTwoLayoutManager();

  assert.deepEqual(
    manager.getLayoutsForDimension(2).map(layout => layout.layoutKey),
    ['X_tsne', 'X_umap'],
  );
  // The default is the item `defaults` names, not the first 2D item; both
  // are enabled, so a view can show either.
  assert.equal(manager.getDefaultLayout(2), 'X_umap');
  assert.deepEqual(manager.getEnabledLayoutKeys(), ['X_tsne', 'X_umap', 'X_umap_3d']);
  assert.equal(manager.resolveRepresentation(TSNE), 'X_tsne');
  assert.throws(
    () => manager.resolveRepresentation({ key: 'X_tsne', columns: null }),
    /must list the columns it plots/,
  );

  const umap = await manager.getPositions('X_umap', { showProgress: false });
  const tsne = await manager.getPositions('X_tsne', { showProgress: false });
  assert.notStrictEqual(umap, tsne);
  assert.deepEqual([...umap], [-1, -1, 1, 1]);
  assert.deepEqual([...tsne], [-1, 1, 1, -1]);
  assert.deepEqual(manager.getNormTransform('X_umap'), { center: [1, 1, 0], scale: 1 });
  assert.deepEqual(manager.getNormTransform('X_tsne'), { center: [5, -5, 0], scale: 0.2 });
});

test('a same-dimension layout switch is a complete live-view publication', async () => {
  const { manager, notifications, positions, state, viewer } = await createScene();
  const tsne = await manager.getPositions('X_tsne', { showProgress: false });
  viewer.calls.length = 0;
  assert.equal(state.viewFollowsDefault('live'), true, 'a dataset opens on its default');

  assert.equal(await state.setViewEmbedding('live', TSNE), 'X_tsne');

  assert.deepEqual(viewer.calls, [
    ['updatePositions', tsne, 2],
    ['setViewEmbedding', 'live', { dimension: 2, layoutKey: 'X_tsne' }],
  ]);
  assert.equal(manager.getViewLayout('live'), 'X_tsne');
  assert.equal(state.getViewLayoutKey('live'), 'X_tsne');
  assert.strictEqual(state.positionsArray, tsne);
  // The dimension is the representation's: there is no second copy of it.
  assert.equal(state.getDimensionLevel(), 2);
  assert.equal(state.getViewDimensionLevel('live'), 2);
  assert.equal(Object.hasOwn(state.viewContexts.get('live'), 'dimensionLevel'), false);
  assert.equal(Object.hasOwn(state.viewContexts.get('live'), 'embeddingOverride'), false);
  assert.equal(Object.hasOwn(state, 'activeDimensionLevel'), false);
  assert.equal(state.viewFollowsDefault('live'), false, 'an explicit choice is kept');
  assert.deepEqual(
    notifications,
    [{ viewId: 'live', layoutKey: 'X_tsne', dimension: 2, previousLayoutKey: 'X_umap' }],
    'listeners observe the new geometry'
  );
  assert.ok(Object.isFrozen(notifications[0]));
  assert.equal(manager._layoutPins.size, 0, 'the staging pin is released');

  // A request for the layout the view already shows publishes nothing.
  viewer.calls.length = 0;
  await state.setViewEmbedding('live', TSNE);
  assert.deepEqual(viewer.calls, []);
  assert.equal(notifications.length, 1);

  // The dimension's default: the view follows it again.
  assert.equal(await state.showDefaultRepresentation('live', 2), 'X_umap');
  assert.deepEqual(viewer.calls, [
    ['updatePositions', positions, 2],
    ['setViewEmbedding', 'live', { dimension: 2, layoutKey: 'X_umap' }],
  ]);
  assert.equal(manager.getViewLayout('live'), 'X_umap');
  assert.equal(state.viewFollowsDefault('live'), true);
  assert.equal(notifications.length, 2);

  // A reference must name one registered layout exactly.
  await assert.rejects(
    state.setViewEmbedding('live', { key: 'X_tsne' }),
    /exactly \{ key, columns \}/,
  );
  // Columns no layout plots name no layout: nothing is guessed.
  await assert.rejects(
    state.setViewEmbedding('live', { key: 'X_tsne', columns: [1, 0] }),
    /cannot plot obsm\['X_tsne'\] columns \[1, 0\]/,
  );
  assert.equal(manager.getViewLayout('live'), 'X_umap');

  // The same layout named by its provenance is the same publication.
  viewer.calls.length = 0;
  await state.setViewEmbedding('live', TSNE);
  assert.deepEqual(viewer.calls, [
    ['updatePositions', tsne, 2],
    ['setViewEmbedding', 'live', { dimension: 2, layoutKey: 'X_tsne' }],
  ]);
  assert.equal(manager.getViewLayout('live'), 'X_tsne');

  // Only an enabled representation can be shown.
  manager.setRepresentations(['X_umap', 'X_umap_3d'], new Map([[2, 'X_umap'], [3, 'X_umap_3d']]));
  viewer.calls.length = 0;
  await state.showDefaultRepresentation('live', 2);
  viewer.calls.length = 0;
  await assert.rejects(state.setViewEmbedding('live', TSNE), /not enabled/);
  assert.deepEqual(viewer.calls, []);
  assert.equal(manager.getViewLayout('live'), 'X_umap');
});

test('keys 1, 2 and 3 show a dimension\'s default, then step through its other representations', async () => {
  const { manager, notifications, state } = await createScene();
  // Resident already, so no load notice is drawn.
  await manager.getPositions('X_tsne', { showProgress: false });
  await manager.getPositions('X_umap_3d', { showProgress: false });
  // The cycle lists the dimension's default first (X_umap), then the rest in
  // mapping order (X_tsne): the order the picker lists them in.
  assert.equal(manager.getViewLayout('live'), 'X_umap');

  assert.deepEqual(
    await state.cycleRepresentation('live', 2),
    { layoutKey: 'X_tsne', position: 2, count: 2 },
    'a view already showing 2D moves to the next 2D representation'
  );
  assert.equal(state.viewFollowsDefault('live'), false);
  assert.deepEqual(
    await state.cycleRepresentation('live', 2),
    { layoutKey: 'X_umap', position: 1, count: 2 },
    'and wraps back to the default'
  );
  assert.equal(state.viewFollowsDefault('live'), true, 'landing on the default follows it');

  // Another dimension: its default first.
  assert.deepEqual(
    await state.cycleRepresentation('live', 3),
    { layoutKey: 'X_umap_3d', position: 1, count: 1 },
  );
  assert.equal(state.getViewDimensionLevel('live'), 3);
  assert.deepEqual(
    notifications.map(change => [change.layoutKey, change.dimension]),
    [['X_tsne', 2], ['X_umap', 2], ['X_umap_3d', 3]],
  );
  // One representation of a dimension: pressing again shows it again.
  assert.deepEqual(
    await state.cycleRepresentation('live', 3),
    { layoutKey: 'X_umap_3d', position: 1, count: 1 },
  );
  assert.equal(notifications.length, 3, 'showing what is shown publishes nothing');

  // No 1D representation is enabled: the gesture is refused, nothing moves.
  await assert.rejects(state.cycleRepresentation('live', 1), /No 1D representation is enabled/);
  await assert.rejects(state.showDefaultRepresentation('live', 1), /No 1D representation is enabled/);
  await assert.rejects(state.cycleRepresentation('live', 4), /exactly 1, 2, or 3/);
  await assert.rejects(state.cycleRepresentation('snap_9', 2), /does not exist/);
  assert.equal(manager.getViewLayout('live'), 'X_umap_3d');
});

test('a kept view switches layout on its own and the switch rolls back atomically', async () => {
  const { manager, notifications, state, viewer } = await createScene({
    failEmbedding: 'X_umap_3d',
  });
  state.createViewFromSource('live', 'snap_1');
  manager.copyViewLayout('live', 'snap_1');
  viewer.setViewPositions('snap_1', state.positionsArray, 2);
  viewer.calls.length = 0;
  const tsne = await manager.getPositions('X_tsne', { showProgress: false });

  await state.setViewEmbedding('snap_1', TSNE);
  assert.deepEqual(viewer.calls, [
    ['setViewPositions', 'snap_1', tsne, 2],
    ['setViewEmbedding', 'snap_1', { dimension: 2, layoutKey: 'X_tsne' }],
  ]);
  assert.equal(manager.getViewLayout('snap_1'), 'X_tsne');
  assert.equal(manager.getViewLayout('live'), 'X_umap', 'the live view is untouched');
  // Every view announces its own change, active or not: its row, badge and
  // overlays follow it.
  assert.deepEqual(notifications, [
    { viewId: 'snap_1', layoutKey: 'X_tsne', dimension: 2, previousLayoutKey: 'X_umap' },
  ]);

  // Focusing a view of the same dimension but another layout is a geometry
  // change for every listener of the active view.
  state.setActiveView('snap_1');
  assert.deepEqual(notifications.at(-1), {
    viewId: 'snap_1', layoutKey: 'X_tsne', dimension: 2, previousLayoutKey: 'X_umap',
  });
  state.setActiveView('live');
  assert.deepEqual(notifications.at(-1), {
    viewId: 'live', layoutKey: 'X_umap', dimension: 2, previousLayoutKey: 'X_tsne',
  });
  assert.equal(notifications.length, 3);

  // "Keep view" copies whether the view follows its default with the rest of
  // the view; the representation itself is the dimension manager's.
  assert.equal(state.viewFollowsDefault('snap_1'), false);
  assert.equal(
    state._cloneViewContext(state.viewContexts.get('snap_1'), 'snap_2').followsDefault,
    false,
  );
  assert.equal(
    state._cloneViewContext(state.viewContexts.get('live'), 'snap_2').followsDefault,
    true,
  );

  // A rejected viewer publication restores every owner to the prior layout.
  await manager.getPositions('X_umap_3d', { showProgress: false });
  viewer.calls.length = 0;
  await assert.rejects(
    state.showDefaultRepresentation('snap_1', 3),
    /viewer rejected the embedding/,
  );
  assert.equal(manager.getViewLayout('snap_1'), 'X_tsne');
  assert.equal(state.getViewDimensionLevel('snap_1'), 2);
  assert.equal(state.viewFollowsDefault('snap_1'), false);
  assert.deepEqual(viewer.calls.at(-1), [
    'setViewEmbedding',
    'snap_1',
    { dimension: 2, layoutKey: 'X_tsne' },
  ]);
  assert.equal(notifications.length, 3, 'a rolled-back change announces nothing');
  assert.equal(manager._layoutPins.size, 0);
});

test('centroids are built for the layout a view shows, from that layout\'s positions', async () => {
  const viewer = createRecordingViewer();
  const state = createDataState({ viewer, labelLayer: null });
  const manager = await createTwoLayoutManager();
  state.setDimensionManager(manager);
  const positions = await manager.getPositions('X_umap', { showProgress: false });
  await manager.getPositions('X_tsne', { showProgress: false });
  await manager.getPositions('X_umap_3d', { showProgress: false });
  state.initScene(positions, {
    fields: [{
      key: 'group',
      kind: 'category',
      categories: ['a', 'b'],
      codes: Uint8Array.from([0, 1]),
    }],
  });
  const field = state.obsData.fields[0];
  assert.ok(field.centroidsByLayout instanceof Map);
  assert.equal(field.centroidsByLayout.size, 0, 'centroids are computed in the browser, never listed');

  // Each layout gets its own centroids, computed from the codes and that
  // layout's resident normalized positions -- never another layout's at the
  // wrong coordinates -- and keeps them, already normalized. One cell per
  // category: each centroid is its cell.
  const layouts = ['X_umap', 'X_tsne', 'X_umap_3d'];
  for (const layoutKey of layouts) {
    state.buildCentroidsForField(field, { viewId: 'other', layoutKey });
    const resident = manager.getResidentPositions(layoutKey);
    const dimension = manager.getLayout(layoutKey).dimension;
    const padded = [];
    for (let cell = 0; cell < 2; cell++) {
      for (let axis = 0; axis < 3; axis++) padded.push(axis < dimension ? resident[cell * dimension + axis] : 0);
    }
    assert.deepEqual([...state.centroidPositions], padded, layoutKey);
    assert.deepEqual(field.centroidsByLayout.get(layoutKey).map(centroid => centroid.category), ['a', 'b']);
  }
  assert.deepEqual([...field._normalizedLayouts], layouts);
  const cached = field.centroidsByLayout.get('X_umap_3d');
  state.buildCentroidsForField(field, { viewId: 'other', layoutKey: 'X_umap_3d' });
  assert.equal(field.centroidsByLayout.get('X_umap_3d'), cached, 'computed once per layout');
});

test('vector bindings belong to exactly the embeddings their mapping names', async () => {
  const manager = await createTwoLayoutManager();
  const dense = (key, width) => ({
    key, storage: 'dense', shape: [2, width], dtype: 'float32', numeric: true,
  });
  const candidates = assembleAnnDataCandidates(describeAnnDataProbes({
    nObs: 2,
    nVars: 0,
    obsm: [
      dense('X_tsne', 2),
      dense('X_umap', 2),
      dense('X_umap_3d', 3),
      dense('drift_tsne', 2),
      dense('velocity_umap', 2),
    ],
    obsp: [],
    varColumns: [],
    X: null,
    layers: [],
    raw: null,
    log1p: null,
  }), {
    slots: {
      '1d': null,
      '2d': { key: 'X_umap', columns: [0, 1] },
      '3d': { key: 'X_umap_3d', columns: [0, 1, 2] },
    },
    guessed: [],
  });
  const vectors = createVectorFieldManager({
    baseUrl: 'h5ad://dataset/',
    vectorFields: resolveVectorFields({
      // drift_tsne is bound to X_tsne only, velocity_umap to X_umap only.
      mapping: {
        kind: 'anndata',
        vectorFields: [
          { key: 'drift_tsne', embedding: { key: 'X_tsne', columns: [0, 1] } },
          { key: 'velocity_umap', embedding: { key: 'X_umap', columns: [0, 1] } },
        ],
      },
      candidates,
      dimensionManager: manager,
    }),
    dimensionManager: manager,
  });

  // Each field is named for its prefix (scVelo's `<field>_<basis>`).
  assert.deepEqual(vectors.getAvailableFields(), [
    { id: 'drift', label: 'drift', layoutKeys: ['X_tsne'] },
    { id: 'velocity', label: 'velocity', layoutKeys: ['X_umap'] },
  ]);
  assert.equal(vectors.hasFieldLayout('velocity', 'X_umap'), true);
  assert.equal(vectors.hasFieldLayout('velocity', 'X_tsne'), false);
  // A second layout of the same dimension is bound only when a binding says so.
  assert.equal(vectors.hasFieldLayout('drift', 'X_tsne'), true);
  assert.equal(vectors.hasFieldLayout('drift', 'X_umap'), false);
  await assert.rejects(
    vectors.loadField('velocity', 'X_tsne'),
    /declares no data for layout "X_tsne"/,
  );

  // The overlay stores vectors per layout and draws nothing for a view whose
  // layout has no binding, instead of the slot layout's vectors.
  const released = [];
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    _activeFieldId: 'velocity',
    _contextLost: false,
    _fieldsById: new Map([
      ['velocity', new Map([['X_umap', { cellCount: 2, components: 2 }]])],
    ]),
    _spawnByView: new Map([['live', { dirty: false, ready: true, version: 3 }]]),
    _assertMutableLifecycle() {},
    _invalidateViewGeneration: viewId => released.push(['generation', viewId]),
    _disposeParticleState: viewId => released.push(['particles', viewId]),
    _disposeFBOs: viewId => released.push(['trails', viewId]),
  });
  assert.equal(overlay.hasFieldForLayout('velocity', 'X_umap'), true);
  assert.equal(overlay.hasFieldForLayout('velocity', 'X_tsne'), false);

  overlay._doUpdate(1 / 60, {
    dimensionLevel: 2,
    frameId: 1,
    layoutKey: 'X_tsne',
    viewId: 'live',
  });
  assert.deepEqual(released, [
    ['generation', 'live'],
    ['particles', 'live'],
    ['trails', 'live'],
  ]);

  // A layout change rebuilds the view's spawn sources. The update above found
  // no field for X_tsne, so the table serves no particles (and keeps no
  // frames going) until one is published.
  released.length = 0;
  overlay.markLayoutDirty('live');
  assert.deepEqual(overlay._spawnByView.get('live'), {
    dirty: true,
    ready: false,
    targetCount: 0,
    version: 4,
  });
  assert.deepEqual(released, [['generation', 'live']]);
});

test('the viewer invalidates LOD, picking and vector state whenever a view\'s layout changes', () => {
  const start = viewerSource.indexOf('    setViewEmbedding(viewId, embedding) {');
  const end = viewerSource.indexOf('\n    /**', start + 1);
  assert.ok(start >= 0 && end > start);
  const body = viewerSource.slice(start, end);

  assert.match(body, /const layoutChanged = oldLayoutKey !== layoutKey;/);
  // Each per-view geometry cache is keyed on the layout, not the dimension.
  assert.match(
    body,
    /if \(vid === LIVE_VIEW_ID && layoutChanged\) \{\s*cancelPendingProjectileBuild\(/,
  );
  assert.match(
    body,
    /if \(layoutChanged\) \{\s*hpRenderer\.invalidateViewState\(vid\);\s*highlightTools\.retireSpatialInteractions\(vid\);\s*\}/,
  );
  assert.match(
    body,
    /if \(layoutChanged\) \{\s*vectorFieldOverlay\?\.markLayoutDirty\?\.\(vid\);\s*\}/,
  );
  assert.match(body, /cachedViewMatrices\.delete\(vid\);/);
  assert.doesNotMatch(body, /oldLevel !== level\) \{\s*hpRenderer/);
  assert.doesNotMatch(viewerSource, /setViewDimension|markDimensionDirty/);

  // A kept view starts on its source view's layout.
  assert.match(
    viewerSource,
    /viewLayoutKeys\.set\(id, viewLayoutKeys\.get\(sourceViewId\) \?\? null\);/,
  );
});
