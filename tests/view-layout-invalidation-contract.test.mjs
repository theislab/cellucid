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
import { resolveExportDataMapping } from '../assets/js/data/dataset-mapping.js';
import {
  createVectorFieldManager,
  resolveVectorFields,
} from '../assets/js/data/vector-field-manager.js';
import { VelocityOverlay } from '../assets/js/rendering/overlays/velocity/velocity-overlay.js';

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
      file: 'embeddings/0_2d.bin',
      source: { key: 'X_tsne', columns: [0, 1] },
    },
    X_umap: {
      label: 'UMAP',
      dimension: 2,
      file: 'embeddings/1_2d.bin',
      source: { key: 'X_umap', columns: [0, 1] },
    },
    X_umap_3d: {
      label: 'X_umap_3d',
      dimension: 3,
      file: 'embeddings/2_3d.bin',
      source: { key: 'X_umap_3d', columns: [0, 1, 2] },
    },
  },
});

async function createTwoLayoutManager() {
  const manager = new DimensionManager({ embeddingsMetadata: EMBEDDINGS });
  manager.loadLayout = async layoutKey =>
    Float32Array.from(RAW_LAYOUTS[layoutKey]);
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

// An export embedding is named by its id; an AnnData obsm array by its key
// and the columns plotted, which is the layout's provenance.
const TSNE = Object.freeze({ key: 'X_tsne', columns: null });
const TSNE_BY_PROVENANCE = Object.freeze({ key: 'X_tsne', columns: [0, 1] });

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
  assert.equal(manager.resolveRepresentation(TSNE_BY_PROVENANCE), 'X_tsne');

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
  await state.setViewEmbedding('live', TSNE_BY_PROVENANCE);
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

test('centroids are built for the layout a view shows, from that layout\'s transform', async () => {
  const viewer = createRecordingViewer();
  const state = createDataState({ viewer, labelLayer: null });
  const manager = await createTwoLayoutManager();
  state.setDimensionManager(manager);
  const positions = await manager.getPositions('X_umap', { showProgress: false });
  await manager.getPositions('X_tsne', { showProgress: false });
  await manager.getPositions('X_umap_3d', { showProgress: false });
  const umapCentroids = [
    { category: 'a', position: [0, 0], n_points: 1 },
    { category: 'b', position: [2, 2], n_points: 1 },
  ];
  const tsneCentroids = [
    { category: 'a', position: [0, 0], n_points: 1 },
    { category: 'b', position: [10, -10], n_points: 1 },
  ];
  state.initScene(positions, {
    fields: [{
      key: 'group',
      kind: 'category',
      categories: ['a', 'b'],
      codes: Uint8Array.from([0, 1]),
      // compact_v2 keys centroids by embedding id, the layout key: each
      // declared embedding carries its own, in its own coordinates. The 3D
      // embedding has none.
      centroidsByEmbedding: { X_tsne: tsneCentroids, X_umap: umapCentroids },
    }],
  });
  const field = state.obsData.fields[0];
  assert.equal(Object.hasOwn(field, 'centroidsByEmbedding'), false);
  assert.deepEqual([...field.centroidsByLayout.keys()], ['X_tsne', 'X_umap']);

  state.buildCentroidsForField(field, { viewId: 'other', layoutKey: 'X_umap' });
  assert.deepEqual([...state.centroidPositions], [-1, -1, 0, 1, 1, 0]);
  assert.deepEqual([...field._normalizedLayouts], ['X_umap']);
  assert.deepEqual(umapCentroids[1].position, [2, 2], 'the manifest is not rewritten');

  // The second 2D layout shows its own centroids, normalized with its own
  // transform, never the slot layout's.
  state.buildCentroidsForField(field, { viewId: 'other', layoutKey: 'X_tsne' });
  assert.deepEqual([...state.centroidPositions], [-1, 1, 0, 1, -1, 0]);
  assert.deepEqual([...field._normalizedLayouts], ['X_umap', 'X_tsne']);
  assert.deepEqual(tsneCentroids[1].position, [10, -10]);

  // A layout with no manifest centroids (an embedding the mapping enabled)
  // gets its own, computed from the codes and that layout's resident
  // normalized positions -- never another layout's at the wrong coordinates
  // -- and keeps them, already normalized.
  const umap3d = manager.getResidentPositions('X_umap_3d');
  state.buildCentroidsForField(field, { viewId: 'other', layoutKey: 'X_umap_3d' });
  assert.deepEqual([...state.centroidPositions], [...umap3d]);
  assert.deepEqual(
    field.centroidsByLayout.get('X_umap_3d').map(centroid => centroid.category),
    ['a', 'b'],
  );
  assert.deepEqual([...field._normalizedLayouts], ['X_umap', 'X_tsne', 'X_umap_3d']);
  const cached = field.centroidsByLayout.get('X_umap_3d');
  state.buildCentroidsForField(field, { viewId: 'other', layoutKey: 'X_umap_3d' });
  assert.equal(field.centroidsByLayout.get('X_umap_3d'), cached, 'computed once per layout');
  assert.deepEqual([...state.centroidPositions], [...umap3d]);
});

test('vector bindings belong to exactly the embeddings their files name', async () => {
  const manager = await createTwoLayoutManager();
  const identity = {
    version: 3,
    embeddings: EMBEDDINGS,
    vector_fields: {
      default_field: 'velocity_umap',
      fields: {
        // Field index 0, bound to X_tsne (item 0) only.
        drift: {
          label: 'drift',
          files: { X_tsne: 'vectors/0_0.bin' },
        },
        // Field index 1, bound to X_umap (item 1) only.
        velocity_umap: {
          label: 'velocity_umap',
          files: { X_umap: 'vectors/1_1.bin' },
        },
      },
    },
  };
  const vectors = createVectorFieldManager({
    baseUrl: 'https://example.test/dataset/',
    vectorFields: resolveVectorFields({
      identity,
      // The export mapping uses every binding the identity declares.
      mapping: resolveExportDataMapping(identity, null),
      candidates: null,
      dimensionManager: manager,
    }),
    dimensionManager: manager,
  });

  assert.equal(vectors.hasFieldLayout('velocity_umap', 'X_umap'), true);
  assert.equal(vectors.hasFieldLayout('velocity_umap', 'X_tsne'), false);
  // A second layout of the same dimension is bound only when a field says so.
  assert.equal(vectors.hasFieldLayout('drift', 'X_tsne'), true);
  assert.equal(vectors.hasFieldLayout('drift', 'X_umap'), false);
  await assert.rejects(
    vectors.loadField('velocity_umap', 'X_tsne', { showProgress: false }),
    /declares no data for layout "X_tsne"/,
  );

  // The overlay stores vectors per layout and draws nothing for a view whose
  // layout has no binding, instead of the slot layout's vectors.
  const released = [];
  const overlay = Object.assign(Object.create(VelocityOverlay.prototype), {
    _activeFieldId: 'velocity_umap',
    _contextLost: false,
    _fieldsById: new Map([
      ['velocity_umap', new Map([['X_umap', { cellCount: 2, components: 2 }]])],
    ]),
    _spawnByView: new Map([['live', { dirty: false, ready: true, version: 3 }]]),
    _assertMutableLifecycle() {},
    _invalidateViewGeneration: viewId => released.push(['generation', viewId]),
    _disposeParticleState: viewId => released.push(['particles', viewId]),
    _disposeFBOs: viewId => released.push(['trails', viewId]),
  });
  assert.equal(overlay.hasFieldForLayout('velocity_umap', 'X_umap'), true);
  assert.equal(overlay.hasFieldForLayout('velocity_umap', 'X_tsne'), false);

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
