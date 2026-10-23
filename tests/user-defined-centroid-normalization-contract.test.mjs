/**
 * User-defined categorical centroids live in the space the viewer draws.
 *
 * Positions are normalized in place as they load, so the raw coordinates of a
 * layout are gone by the time anyone can create a field. User-defined
 * centroids used to be computed only from those raw coordinates: a new field
 * had no centroids and therefore no labels, and switching a view's dimension
 * while one was active threw "Raw 2D positions are unavailable for centroid
 * computation". They are now computed from each layout's normalized positions,
 * recorded as normalized, and recomputed after every category edit. A session
 * stores only the codes: restoring them computes the centroids again from the
 * positions of each resident layout.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDataState } from '../assets/js/app/state/core/data-state.js';
import { createDimensionManager } from '../assets/js/data/dimension-manager.js';
import { normalizePositions } from '../assets/js/rendering/gl-utils.js';
import { UserDefinedFieldsRegistry } from '../assets/js/app/registries/user-defined-fields.js';
import {
  computeCentroidsForDimension,
} from '../assets/js/app/registries/user-defined-fields/centroids.js';
import * as fieldOverlays from '../assets/js/app/session/contributors/field-overlays.js';
import * as userDefinedCodes from '../assets/js/app/session/contributors/user-defined-codes.js';
import { loadsAsReader } from './helpers/dimension-loads.mjs';

/** The embedding id of each dimension: one v3 `embeddings.items` entry each. */
const LAYOUT_OF = { 1: 'X_umap_1d', 2: 'X_umap_2d', 3: 'X_umap_3d' };

/** Deterministic, deliberately unround raw coordinates. */
function rawPositions(pointCount, dimension, seed) {
  let value = seed >>> 0;
  const positions = new Float32Array(pointCount * dimension);
  for (let index = 0; index < positions.length; index++) {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    positions[index] = (value / 2 ** 32) * 37.3 - 11.9 + (index % dimension) * 5.1;
  }
  return positions;
}

const POINTS = 9;
const RAW = Object.freeze({
  X_umap_1d: rawPositions(POINTS, 1, 11),
  X_umap_2d: rawPositions(POINTS, 2, 22),
  X_umap_3d: rawPositions(POINTS, 3, 33),
});

/**
 * The centroid the old path produced: the mean of raw coordinates, then the
 * layout's normalization transform applied to that mean.
 */
function rawThenNormalized(codes, categories, raw, dimension) {
  const normalized = new Float32Array(raw);
  const { center, scale } = normalizePositions(normalized, dimension);
  return computeCentroidsForDimension(codes, categories, raw, dimension).map(
    centroid => ({
      ...centroid,
      position: centroid.position.map(
        (coordinate, axis) => (coordinate - center[axis]) * scale
      ),
    })
  );
}

function assertCentroidsClose(actual, expected, tolerance, label) {
  assert.equal(actual.length, expected.length, `${label}: centroid count`);
  actual.forEach((centroid, index) => {
    assert.equal(centroid.category, expected[index].category, `${label}: category`);
    assert.equal(centroid.n_points, expected[index].n_points, `${label}: n_points`);
    assert.equal(centroid.position.length, expected[index].position.length);
    centroid.position.forEach((coordinate, axis) => {
      assert.ok(
        Math.abs(coordinate - expected[index].position[axis]) <= tolerance,
        `${label}: centroid ${index} axis ${axis}: ${coordinate} vs ${expected[index].position[axis]}`
      );
    });
  });
}

function datasetManager(dimensions = [1, 2, 3]) {
  const items = {};
  const defaults = {};
  dimensions.forEach((dimension, index) => {
    const id = LAYOUT_OF[dimension];
    const columns = Array.from({ length: dimension }, (_value, axis) => axis);
    items[id] = {
      label: id,
      dimension,
      path: `obsm/${index}/${columns.join('-')}`,
      source: { key: id, columns },
    };
    defaults[`${dimension}d`] = id;
  });
  const manager = createDimensionManager({
    embeddingsMetadata: {
      default_dimension: dimensions.includes(2) ? 2 : dimensions[0],
      defaults,
      items,
    },
  });
  // The decoded bytes of each layout; the manager normalizes them in place.
  loadsAsReader(manager, async layoutKey => new Float32Array(RAW[layoutKey]));
  const getPositions = manager.getPositions.bind(manager);
  manager.getPositions = layoutKey => getPositions(layoutKey, { showProgress: false });
  return manager;
}

function recordingViewer() {
  const centroidPublications = [];
  const viewer = {
    hasVectorFieldForLayout: () => false,
    isDisposed: () => false,
    resetVectorFieldOverlay() {},
    setCentroidLabels() {},
    setCentroids({ positions }) {
      centroidPublications.push(Array.from(positions));
    },
    setData() {},
    setViewEmbedding() {},
    updateColors() {},
    updatePositions() {},
    updateTransparency() {},
  };
  return { centroidPublications, viewer };
}

/**
 * A real DataState on a real DimensionManager whose live view shows 2D.
 * `resident` names the layouts loaded before anything else happens.
 */
async function createScene({ resident = ['X_umap_2d'], dimensions = [1, 2, 3] } = {}) {
  const manager = datasetManager(dimensions);
  for (const layoutKey of resident) await manager.getPositions(layoutKey);
  const { centroidPublications, viewer } = recordingViewer();
  const state = createDataState({ viewer, labelLayer: null });
  state.setDimensionManager(manager);
  // A dataset with an empty gene list, as the boot sequence installs it.
  state.initVarData({ fields: [] });
  const live = await manager.getPositions('X_umap_2d');
  manager.setViewLayout('live', 'X_umap_2d');
  state.initScene(live, { fields: [] });
  return { centroidPublications, manager, state };
}

/** Two highlight pages turned into a categorical, the Category Builder path. */
function createFieldFromPages(state, key = 'regions') {
  const pageIds = [];
  for (const [label, cellIndices] of [
    ['left', [0, 1, 2, 3]],
    ['right', [4, 5, 6]],
  ]) {
    const page = state.createHighlightPage(label);
    state.switchToPage(page.id);
    state.addHighlightDirect({ type: 'lasso', label, cellIndices: Uint32Array.from(cellIndices) });
    pageIds.push({ pageId: page.id, label });
  }
  const result = state.createCategoricalFromPages({
    key,
    pages: pageIds,
    uncoveredLabel: 'rest',
    overlapStrategy: 'first',
    overlapLabel: '',
    intersectionLabels: {},
  });
  const fieldIndex = state.obsData.fields.indexOf(result.field);
  assert.ok(fieldIndex >= 0);
  return { field: result.field, fieldIndex, id: result.id };
}

function expectedFromResident(manager, field, layoutKey) {
  const dimension = manager.getLayout(layoutKey).dimension;
  return computeCentroidsForDimension(
    field.codes,
    field.categories,
    manager.getResidentPositions(layoutKey),
    dimension
  );
}

function padded(centroids) {
  return centroids.flatMap(({ position }) => [
    position[0],
    position.length >= 2 ? position[1] : 0,
    position.length >= 3 ? position[2] : 0,
  ]);
}

test('the mean of normalized positions is the normalized raw mean in 1D, 2D and 3D', () => {
  const pointCount = 4096;
  const codes = new Uint8Array(pointCount);
  for (let index = 0; index < pointCount; index++) {
    // Three categories and some cells with no category at all.
    codes[index] = index % 11 === 0 ? 255 : index % 3;
  }
  const categories = ['alpha', 'beta', 'gamma'];
  for (const dimension of [1, 2, 3]) {
    const raw = rawPositions(pointCount, dimension, 100 + dimension);
    const normalized = new Float32Array(raw);
    normalizePositions(normalized, dimension);
    const fromNormalized = computeCentroidsForDimension(
      codes,
      categories,
      normalized,
      dimension
    );
    // Normalization is affine per axis, so the two agree up to the Float32
    // rounding of each normalized coordinate (about 6e-8 on [-1, 1]).
    assertCentroidsClose(
      fromNormalized,
      rawThenNormalized(codes, categories, raw, dimension),
      1e-6,
      `${dimension}D`
    );
  }
});

test('a new field gets normalized centroids for every resident layout, and only those', async () => {
  const manager = datasetManager();
  await manager.getPositions('X_umap_1d');
  await manager.getPositions('X_umap_2d');
  const registry = new UserDefinedFieldsRegistry();
  const codes = Uint8Array.from([0, 0, 1, 1, 2, 2, 0, 1, 255]);
  const categories = ['a', 'b', 'c'];
  const { field } = registry.createFromCategoricalCodes(
    { key: 'groups', categories, codes, source: 'obs' },
    { pointCount: POINTS, dimensionManager: manager }
  );

  assert.deepEqual([...field.centroidsByLayout.keys()], ['X_umap_1d', 'X_umap_2d']);
  assert.deepEqual([...field._normalizedLayouts], ['X_umap_1d', 'X_umap_2d']);
  for (const layoutKey of ['X_umap_1d', 'X_umap_2d']) {
    const dimension = manager.getLayout(layoutKey).dimension;
    assert.deepEqual(
      field.centroidsByLayout.get(layoutKey),
      expectedFromResident(manager, field, layoutKey),
      `${layoutKey} centroids are the means of the drawn positions`
    );
    assertCentroidsClose(
      field.centroidsByLayout.get(layoutKey),
      rawThenNormalized(codes, categories, RAW[layoutKey], dimension),
      1e-6,
      layoutKey
    );
  }
  assert.equal(manager.positionCache.size, 0, 'no raw coordinates were needed');
});

test('a field created from highlight pages shows its labels at once', async () => {
  const { centroidPublications, manager, state } = await createScene();
  const { field, fieldIndex } = createFieldFromPages(state);

  assert.deepEqual(field.categories, ['left', 'right', 'rest']);
  assert.deepEqual([...field._normalizedLayouts], ['X_umap_2d']);
  state.setActiveField(fieldIndex);
  const expected = expectedFromResident(manager, field, 'X_umap_2d');
  assert.equal(state.centroidCount, 3);
  assert.deepEqual(centroidPublications.at(-1), padded(expected).map(Math.fround));
  // Building again (any later recolour) never moves them.
  state.setActiveField(fieldIndex);
  assert.deepEqual(field.centroidsByLayout.get('X_umap_2d'), expected);
});

test('switching representation computes the next layout from the positions it loaded', async () => {
  const { centroidPublications, manager, state } = await createScene();
  const { field, fieldIndex } = createFieldFromPages(state);
  state.setActiveField(fieldIndex);
  assert.equal(field.centroidsByLayout.has('X_umap_3d'), false);
  assert.equal(manager.positionCache.size, 0);

  for (const dimension of [3, 1, 2, 3]) {
    await state.showDefaultRepresentation('live', dimension);
    const layoutKey = LAYOUT_OF[dimension];
    const expected = expectedFromResident(manager, field, layoutKey);
    assert.deepEqual(field.centroidsByLayout.get(layoutKey), expected);
    assert.ok(field._normalizedLayouts.has(layoutKey));
    assert.deepEqual(
      centroidPublications.at(-1),
      padded(expected).map(Math.fround),
      `${dimension}D labels sit at the means of the positions drawn`
    );
  }
  assert.deepEqual(
    [...field.centroidsByLayout.keys()].sort(),
    [...field._normalizedLayouts].sort()
  );
});

test('every category edit recomputes normalized centroids with a matching record', async () => {
  const { manager, state } = await createScene({ resident: ['X_umap_1d', 'X_umap_2d', 'X_umap_3d'] });
  const { field, fieldIndex } = createFieldFromPages(state);
  const assertNormalized = (target, label) => {
    assert.deepEqual([...target.centroidsByLayout.keys()], ['X_umap_1d', 'X_umap_2d', 'X_umap_3d'], label);
    assert.deepEqual([...target._normalizedLayouts], ['X_umap_1d', 'X_umap_2d', 'X_umap_3d'], label);
    for (const layoutKey of ['X_umap_1d', 'X_umap_2d', 'X_umap_3d']) {
      assert.deepEqual(
        target.centroidsByLayout.get(layoutKey),
        expectedFromResident(manager, target, layoutKey),
        `${label}: ${layoutKey}`
      );
    }
  };
  assertNormalized(field, 'created');

  state.deleteCategoryToUnassigned(fieldIndex, 0, {
    editInPlace: true,
    unassignedLabel: 'unassigned',
  });
  assertNormalized(field, 'delete to unassigned, in place');

  state.mergeCategoriesToNewField(fieldIndex, 0, 1, { editInPlace: true });
  assertNormalized(field, 'merge, in place');

  // Editing without editing in place derives a new user-defined field.
  const derived = state.mergeCategoriesToNewField(fieldIndex, 0, 1, {
    editInPlace: false,
  });
  assertNormalized(state.obsData.fields[derived.newFieldIndex], 'merge, derived');

  const upserted = state.upsertUserDefinedCategoricalField({
    key: 'consensus',
    categories: ['x', 'y'],
    codes: Uint8Array.from([0, 1, 0, 1, 0, 1, 0, 1, 0]),
  });
  const consensus = state.obsData.fields[upserted.fieldIndex];
  assertNormalized(consensus, 'upsert, created');
  state.upsertUserDefinedCategoricalField({
    key: 'consensus',
    categories: ['x', 'y', 'z'],
    codes: Uint8Array.from([0, 1, 2, 1, 0, 1, 2, 1, 0]),
  });
  assertNormalized(consensus, 'upsert, updated in place');
});

test('a built-in categorical edited into a derived field gets normalized centroids', async () => {
  const manager = datasetManager();
  for (const layoutKey of ['X_umap_1d', 'X_umap_2d', 'X_umap_3d']) await manager.getPositions(layoutKey);
  const { viewer } = recordingViewer();
  const state = createDataState({ viewer, labelLayer: null });
  state.setDimensionManager(manager);
  manager.setViewLayout('live', 'X_umap_2d');
  state.initScene(manager.getResidentPositions('X_umap_2d'), {
    fields: [{
      key: 'cell_type',
      kind: 'category',
      categories: ['t', 'b', 'nk'],
      codes: Uint8Array.from([0, 0, 0, 1, 1, 1, 2, 2, 2]),
    }],
  });

  const deleted = state.deleteCategoryToUnassigned(0, 2, {
    editInPlace: false,
    unassignedLabel: 'unassigned',
  });
  const derived = state.obsData.fields[deleted.newFieldIndex];
  assert.equal(derived._isUserDefined, true);
  assert.deepEqual([...derived._normalizedLayouts], ['X_umap_1d', 'X_umap_2d', 'X_umap_3d']);
  for (const layoutKey of ['X_umap_1d', 'X_umap_2d', 'X_umap_3d']) {
    assert.deepEqual(
      derived.centroidsByLayout.get(layoutKey),
      expectedFromResident(manager, derived, layoutKey)
    );
  }
});

async function saveAndRestore(state, makeTarget) {
  const [overlayChunk] = fieldOverlays.capture({ state });
  // Exactly what the bundle writer stores and the reader parses.
  const overlayPayload = JSON.parse(JSON.stringify(overlayChunk.payload));
  const codeChunks = userDefinedCodes.capture({ state });

  const target = await makeTarget();
  fieldOverlays.restore({ state: target.state }, overlayChunk, overlayPayload);
  const restoredBeforeCodes = new Map(
    target.state.obsData.fields
      .filter(candidate => candidate._isUserDefined === true)
      .map(candidate => [
        candidate._userDefinedId,
        {
          centroids: [...candidate.centroidsByLayout.keys()],
          normalized: [...candidate._normalizedLayouts],
        },
      ])
  );
  for (const { payload, ...meta } of codeChunks) {
    await userDefinedCodes.restore(
      { state: target.state, abortSignal: null },
      { ...meta, storedBytes: payload.byteLength, uncompressedBytes: payload.byteLength },
      payload
    );
  }
  return { overlayPayload, restoredBeforeCodes, target };
}

const SESSION_RECORD_KEYS = Object.freeze([
  'categories',
  'codesLength',
  'codesType',
  'createdAt',
  'id',
  'intersectionLabels',
  'isDeleted',
  'isPurged',
  'key',
  'kind',
  'operation',
  'overlapLabel',
  'overlapStrategy',
  'source',
  'sourceField',
  'sourcePages',
  'uncoveredLabel',
]);

test('a session restores user-defined centroids exactly where they were drawn, 1D to 3D', async () => {
  const source = await createScene({ resident: ['X_umap_1d', 'X_umap_2d', 'X_umap_3d'] });
  const { field, fieldIndex, id } = createFieldFromPages(source.state);
  source.state.setActiveField(fieldIndex);
  const drawnBefore = {};
  for (const dimension of [1, 3, 2]) {
    await source.state.showDefaultRepresentation('live', dimension);
    drawnBefore[dimension] = source.centroidPublications.at(-1);
  }

  const { overlayPayload, restoredBeforeCodes, target } = await saveAndRestore(
    source.state,
    // Only the live layout is resident, so the 1D and 3D centroids drawn
    // after the restore are computed when each layout loads.
    () => createScene()
  );
  // The session record holds the field's definition and code shape only:
  // centroids are derived state, never stored.
  const record = overlayPayload.userDefinedFields.find(item => item.id === id);
  assert.deepEqual(Object.keys(record).sort(), SESSION_RECORD_KEYS);
  assert.equal(Object.hasOwn(record, 'centroidsByDim'), false);
  assert.equal(Object.hasOwn(record, 'normalizedDims'), false);
  // The metadata restore publishes no centroids before the codes exist.
  assert.deepEqual(restoredBeforeCodes.get(id), { centroids: [], normalized: [] });

  const restored = target.state.obsData.fields.find(
    candidate => candidate._userDefinedId === id
  );
  // Restoring the codes recomputed the centroids of the one resident layout
  // from its positions; they equal the ones the source drew there.
  assert.deepEqual([...restored.centroidsByLayout.keys()], ['X_umap_2d']);
  assert.deepEqual([...restored._normalizedLayouts], ['X_umap_2d']);
  assert.deepEqual(
    restored.centroidsByLayout.get('X_umap_2d'),
    field.centroidsByLayout.get('X_umap_2d')
  );
  assert.deepEqual(
    restored.centroidsByLayout.get('X_umap_2d'),
    expectedFromResident(target.manager, restored, 'X_umap_2d')
  );
  assert.equal(target.manager.getResidentPositions('X_umap_3d'), null);

  target.state.setActiveField(target.state.obsData.fields.indexOf(restored));
  for (const dimension of [1, 3, 2]) {
    await target.state.showDefaultRepresentation('live', dimension);
    assert.deepEqual(
      target.centroidPublications.at(-1),
      drawnBefore[dimension],
      `${dimension}D labels land where they did before saving`
    );
  }
  assert.deepEqual(restored.centroidsByLayout, field.centroidsByLayout);
  assert.deepEqual(
    [...restored._normalizedLayouts].sort(),
    ['X_umap_1d', 'X_umap_2d', 'X_umap_3d']
  );
});

test('a session record carrying centroids is refused; one without them restores empty', () => {
  const centroids = [{ category: 'a', position: [0], n_points: 1 }];
  const item = {
    id: 'user_cat_1',
    source: 'obs',
    kind: 'category',
    key: 'groups',
    categories: ['a'],
    isDeleted: false,
    isPurged: false,
    codesLength: 1,
    codesType: 'Uint8Array',
    sourceField: null,
    operation: null,
    sourcePages: [],
    overlapStrategy: 'first',
    overlapLabel: null,
    intersectionLabels: null,
    uncoveredLabel: null,
    createdAt: 1,
  };
  assert.deepEqual(Object.keys(item).sort(), SESSION_RECORD_KEYS);
  const registry = new UserDefinedFieldsRegistry();
  const state = {
    applyFieldOverlays() {},
    getRenameRegistry: () => ({ clear() {}, fromJSON() {}, toJSON() {} }),
    getDeleteRegistry: () => ({ clear() {}, fromJSON() {}, toJSON() {} }),
    getUserDefinedFieldsRegistry: () => registry,
  };
  const payloadWith = record => ({
    renames: { fields: {}, categories: {} },
    deletedFields: { deleted: [], purged: [] },
    userDefinedFields: [record],
  });

  // The per-dimension record of the earlier session schema is not part of
  // this one, in either half or together.
  for (const extra of [
    { centroidsByDim: { 1: centroids }, normalizedDims: [1] },
    { centroidsByDim: {} },
    { normalizedDims: [] },
  ]) {
    assert.throws(
      () => fieldOverlays.restore({ state }, null, payloadWith({ ...item, ...extra })),
      /exact keys/
    );
  }

  fieldOverlays.restore({ state }, null, payloadWith(item));
  const restored = registry.getField('user_cat_1');
  assert.equal(restored.loaded, false);
  assert.equal(restored.codes, null);
  assert.ok(restored.centroidsByLayout instanceof Map);
  assert.equal(restored.centroidsByLayout.size, 0);
  assert.ok(restored._normalizedLayouts instanceof Set);
  assert.equal(restored._normalizedLayouts.size, 0);
});
