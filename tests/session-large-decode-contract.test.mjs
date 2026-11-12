/**
 * Large state decodes and restores: a session file's cell sets
 * (`session/codecs/cell-set.js`, read by `session/history-file.js`) yield as
 * they decode, so a cancellation wins on any machine; a large user field put
 * back by the `field-overlays` state domain is laid in whole, with centroids
 * for the layouts that are resident.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeCellSet,
} from '../assets/js/app/session/codecs/cell-set.js';
import {
  encodeUvarints,
} from '../assets/js/app/session/codecs/varint.js';
import { createFieldOverlaysDomain } from '../assets/js/app/state/domains/field-overlays.js';
import { DataState } from '../assets/js/app/state/core/data-state.js';
import { createCellIdentity } from '../assets/js/data/cell-identity.js';
import {
  DimensionManager,
} from '../assets/js/data/dimension-manager.js';

/**
 * Schedule a cancellation as the next macrotask, queued behind the decode's
 * first yield (Node's yield is `setImmediate`, `utils/yield-macrotask.js`):
 * it runs at the decode's first yield, whatever the speed of the machine, and
 * only because the decode yields there. (A timer instead raced the decode: a
 * fast machine finished all of its cells before a millisecond passed.)
 */
function scheduleCancel(cancel) {
  return setImmediate(cancel);
}

/**
 * A real DimensionManager with two 2D layouts, only the first of them
 * resident. A restored user field gets centroids for exactly the resident
 * layout, computed from its positions: cell `i` sits at (i, 2i).
 */
function residentDimensionManager(pointCount) {
  const manager = new DimensionManager();
  manager.registerLayouts([
    {
      layoutKey: 'X_umap_2d',
      dimension: 2,
      label: 'UMAP',
      path: 'obsm/0/0-1',
      provenance: null,
      origin: 'identity',
    },
    {
      layoutKey: 'X_tsne_2d',
      dimension: 2,
      label: 'tSNE',
      path: 'obsm/1/0-1',
      provenance: null,
      origin: 'identity',
    },
  ]);
  manager.setRepresentations(['X_umap_2d', 'X_tsne_2d'], new Map([[2, 'X_umap_2d']]));
  manager.publishCellCount(pointCount);
  const positions = new Float32Array(pointCount * 2);
  for (let index = 0; index < pointCount; index++) {
    positions[index * 2] = index;
    positions[index * 2 + 1] = 2 * index;
  }
  manager.normalizedPositionCache.set('X_umap_2d', positions);
  return manager;
}

/** A DataState of `pointCount` cells, every one open, over `residentDimensionManager`. */
function stateWithResidentLayout(pointCount) {
  // The views a state domain covers: the live view alone.
  const viewer = { getSnapshotViews: () => [] };
  const state = new DataState(viewer, null);
  state.pointCount = pointCount;
  state.cellIdentity = createCellIdentity({ nObs: pointCount });
  state.dimensionManager = residentDimensionManager(pointCount);
  state.obsData = { fields: [] };
  state.varData = { fields: [] };
  state._resetViewContexts();
  return { state, viewer };
}

test('a large sorted-delta cell set yields so a scheduled cancellation wins', async () => {
  const count = 256 * 1024;
  const header = encodeUvarints([count]);
  // Encoding 0, the count, a first index of 0, then deltas of 1.
  const payload = new Uint8Array(1 + header.length + count);
  payload[0] = 0;
  payload.set(header, 1);
  payload[1 + header.length] = 0;
  payload.fill(1, 2 + header.length);

  const controller = new AbortController();
  const cancellation = new Error('scheduled highlight cancellation');
  let abortFired = false;
  const timer = scheduleCancel(() => {
    abortFired = true;
    controller.abort(cancellation);
  });
  try {
    await assert.rejects(
      decodeCellSet(payload, {
        cellCount: count,
        signal: controller.signal,
      }),
      error => error === cancellation,
    );
  } finally {
    clearImmediate(timer);
  }
  assert.equal(abortFired, true);
});

test('a large bitset cell set yields so a scheduled cancellation wins', async () => {
  const cellCount = 8 * 1024 * 1024;
  const payload = new Uint8Array(1 + cellCount / 8).fill(0xff);
  payload[0] = 1;
  const controller = new AbortController();
  const cancellation = new Error('scheduled bitset cancellation');
  const timer = scheduleCancel(() => controller.abort(cancellation));
  try {
    await assert.rejects(
      decodeCellSet(payload, { cellCount, signal: controller.signal }),
      error => error === cancellation,
    );
  } finally {
    clearImmediate(timer);
  }
});

test('a large user field is laid in whole, with centroids for the one resident layout', async () => {
  const pointCount = 128 * 1024;
  const codes = new Uint8Array(pointCount);
  for (let index = 0; index < pointCount; index++) codes[index] = index & 1;
  const categories = Array.from({ length: 200 }, (_value, index) => `c${index}`);
  // A field-overlays value as the history holds it (one user field, its
  // codes a column over every cell of the dataset).
  const value = {
    renamedFields: [],
    renamedCategories: [],
    deletedFields: [],
    userFields: [{
      id: 'user_cat_1', source: 'obs', kind: 'category', key: 'restored_groups', deleted: false, purged: false,
      createdAt: 1, sourceField: null, operation: null, categories, codes: { cells: null, values: codes },
      sourcePages: [], overlapStrategy: 'first', overlapLabel: null, intersectionLabels: null, uncoveredLabel: null, palette: null,
    }],
  };
  const { state, viewer } = stateWithResidentLayout(pointCount);
  await createFieldOverlaysDomain({ state, viewer, refreshUi: () => {} }).restore(value);
  const template = state.getUserDefinedFieldsRegistry().getField('user_cat_1');

  // Every cell open in its own order: the column is the field's codes, never
  // copied cell by cell.
  assert.equal(template.codes, codes);
  assert.equal(template.loaded, true);
  assert.equal(state.obsData.fields.at(-1)._userDefinedId, 'user_cat_1');

  // The value carried no centroids; restoring the field computed them for
  // the one resident layout, in normalized space.
  assert.deepEqual([...template.centroidsByLayout.keys()], ['X_umap_2d']);
  assert.deepEqual([...template._normalizedLayouts], ['X_umap_2d']);
  const centroids = template.centroidsByLayout.get('X_umap_2d');
  // Only c0 and c1 hold cells; the other 198 categories have no centroid.
  assert.equal(template.categories.length, 200);
  assert.deepEqual(centroids.map(centroid => centroid.category), ['c0', 'c1']);
  const half = pointCount / 2;
  // Even cells hold code 0, odd cells code 1.
  assert.deepEqual(centroids[0], {
    category: 'c0',
    position: [half - 1, 2 * (half - 1)],
    n_points: half,
  });
  assert.deepEqual(centroids[1], {
    category: 'c1',
    position: [half, 2 * half],
    n_points: half,
  });
});
