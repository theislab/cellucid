/**
 * @fileoverview A purged user-defined field must stop costing anything.
 *
 * Purging is irreversible: `field-selector-deleted-fields.js` excludes purged
 * fields from the restore list, so nothing in the UI can ever bring one back.
 * A purged field that kept its full per-cell codes array, and kept it in
 * every saved state, costs megabytes of resident memory and megabytes added
 * to every session file on a dataset the size of the published `suo` sample,
 * for a column the user has explicitly and permanently discarded.
 *
 * These tests pin both halves together, because either one alone
 * leaves the cost in place: the purge must release the payload, and the
 * `field-overlays` state domain (`app/state/domains/field-overlays.js`), which
 * the history and the session file save, must hold a tombstone for it (its
 * identity, so the id stays taken) rather than a description of an array that
 * no longer exists, and put it back as one.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  UserDefinedFieldsRegistry
} from '../assets/js/app/registries/user-defined-fields.js';
import { createFieldOverlaysDomain } from '../assets/js/app/state/domains/field-overlays.js';
import { sameValue } from '../assets/js/app/state/domains/same-value.js';
import { DataState } from '../assets/js/app/state/core/data-state.js';
import { createCellIdentity } from '../assets/js/data/cell-identity.js';

const POINT_COUNT = 8;

/** A viewer with one view and no GPU: every method the state calls on it exists. */
function headlessViewer() {
  const own = { getSnapshotViews: () => [], isDisposed: () => false };
  return new Proxy(own, { get: (target, key) => (key in target ? target[key] : () => undefined) });
}

/** A DataState of `count` cells, every one open, with no dataset field. */
function stateOfCells(count) {
  const viewer = headlessViewer();
  const state = new DataState(viewer, null);
  state.pointCount = count;
  state.cellIdentity = createCellIdentity({ nObs: count });
  state.colorsArray = new Uint8Array(count * 4);
  state.categoryTransparency = new Uint8Array(count).fill(1);
  state.cellVisibilityMask = new Uint8Array(count).fill(1);
  // One 2-D layout whose positions are not held: no centroid is computed.
  state.dimensionManager = {
    getResidentPositions: () => null,
    getRegisteredLayouts: () => [{ layoutKey: '2d', dimension: 2 }],
  };
  state.obsData = { fields: [] };
  state.varData = { fields: [] };
  state._resetViewContexts();
  return { state, viewer };
}

function registryWithCategoricalField() {
  const registry = new UserDefinedFieldsRegistry();
  const { id, field } = registry.createFromCategoricalCodes(
    {
      key: 'purge_me',
      categories: ['A', 'B'],
      codes: new Uint8Array([0, 1, 0, 1, 0, 1, 0, 1]),
      source: 'obs'
    },
    {
      pointCount: POINT_COUNT,
      dimensionManager: {
        getResidentPositions: () => null,
        getRegisteredLayouts: () => [{ layoutKey: '2d', dimension: 2 }]
      }
    }
  );
  return { registry, field, id };
}

test('a purged field releases its per-cell codes', () => {
  const { registry, field, id } = registryWithCategoricalField();
  assert.ok(
    field.codes instanceof Uint8Array,
    'the field must start with real codes for this test to mean anything'
  );

  field._isDeleted = true;
  registry.purgeField(id);

  const purged = registry.getField(id);
  assert.equal(
    purged._isPurged,
    true,
    'the field must actually be purged'
  );
  assert.equal(
    purged.codes,
    null,
    'a purged field must not retain the per-cell codes array it can never use again'
  );
  assert.deepEqual(
    purged.categories,
    [],
    'a purged field must not retain its category inventory'
  );
});

test('a purged field holds no codes in the field-overlays state, and comes back purged', async () => {
  const { state, viewer } = stateOfCells(POINT_COUNT);
  const overlays = createFieldOverlaysDomain({ state, viewer, refreshUi: () => {} });
  const purged = state.upsertUserDefinedCategoricalField({
    key: 'purge_me', categories: ['A', 'B'], codes: new Uint8Array([0, 1, 0, 1, 0, 1, 0, 1]),
  });
  state.upsertUserDefinedCategoricalField({
    key: 'keep_me', categories: ['A', 'B'], codes: new Uint8Array([1, 0, 1, 0, 1, 0, 1, 0]),
  });
  const purgedId = state.obsData.fields[purged.fieldIndex]._userDefinedId;
  state.deleteField('obs', purged.fieldIndex);
  state.purgeUserDefinedField(purgedId, 'obs');

  const value = overlays.capture();
  const [gone, kept] = value.userFields;
  assert.equal(kept.key, 'keep_me');
  assert.deepEqual(
    [...kept.codes.values],
    [1, 0, 1, 0, 1, 0, 1, 0],
    'the live field must still hold its codes, or this test proves nothing'
  );
  assert.equal(gone.id, purgedId, 'the purged field must still appear, so its id stays taken');
  assert.deepEqual([gone.deleted, gone.purged], [true, true]);
  assert.deepEqual(
    Object.keys(gone).sort(),
    ['createdAt', 'deleted', 'id', 'key', 'kind', 'operation', 'purged', 'source', 'sourceField'],
    'a purged field must hold no codes, categories or values - that column is the bulk '
      + 'of what a purged field was adding to every saved state'
  );

  // Put back on a page that never had it: the tombstone comes back as one.
  const fresh = stateOfCells(POINT_COUNT);
  await createFieldOverlaysDomain({ state: fresh.state, viewer: fresh.viewer, refreshUi: () => {} }).restore(value);
  const back = fresh.state.getUserDefinedFieldsRegistry().getField(purgedId);
  assert.ok(back, 'the purged field must survive a round trip');
  assert.deepEqual([back._isDeleted, back._isPurged, back.loaded], [true, true, false]);
  assert.equal(back.codes, null, 'restoring a tombstone must not invent a codes array');
  assert.deepEqual(back.categories, []);
  assert.equal(back.centroidsByLayout.size, 0);
  assert.ok(sameValue(createFieldOverlaysDomain({ state: fresh.state, viewer: fresh.viewer, refreshUi: () => {} }).capture(), value));
});
