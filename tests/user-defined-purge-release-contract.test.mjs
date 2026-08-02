/**
 * @fileoverview A purged user-defined field must stop costing anything.
 *
 * Purging is irreversible: `field-selector-deleted-fields.js` excludes purged
 * fields from the restore list, so nothing in the UI can ever bring one back.
 * Despite that, the template kept its full per-cell codes array, and both the
 * session metadata and the codes contributor kept writing it out. On a
 * dataset the size of the published `suo` sample that is megabytes of resident
 * memory and megabytes added to every session bundle, for a column the user
 * has explicitly and permanently discarded.
 *
 * These tests pin the three halves of the fix together, because any one of
 * them alone leaves the cost in place: the purge must release the payload, the
 * session metadata must emit a tombstone rather than a description of an array
 * that no longer exists, and the codes contributor must write no chunk.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  UserDefinedFieldsRegistry
} from '../assets/js/app/registries/user-defined-fields.js';

const POINT_COUNT = 8;

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
        positionCache: new Map(),
        getAvailableDimensions: () => [2]
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

test('a purged field is written to a session as a tombstone, not a description of released data', () => {
  const { registry, field, id } = registryWithCategoricalField();
  field._isDeleted = true;
  registry.purgeField(id);

  const meta = registry.toSessionMeta();
  const entry = meta.find(item => item.id === id);
  assert.ok(entry, 'the purged field must still appear, so its id stays taken');
  assert.equal(entry.isPurged, true);
  assert.equal(entry.isDeleted, true);

  for (const absent of ['codesLength', 'codesType', 'categories', 'centroidsByDim']) {
    assert.equal(
      Object.hasOwn(entry, absent),
      false,
      `a purged tombstone must not carry "${absent}" - there is no array left to describe`
    );
  }
});

test('a purged tombstone round-trips without a codes chunk', () => {
  const { registry, field, id } = registryWithCategoricalField();
  field._isDeleted = true;
  registry.purgeField(id);
  const meta = registry.toSessionMeta();

  const restored = new UserDefinedFieldsRegistry();
  restored.fromSessionMeta(meta);

  const back = restored.getField(id);
  assert.ok(back, 'the purged field must survive a round trip');
  assert.equal(back._isPurged, true);
  assert.equal(back._isDeleted, true);
  assert.equal(
    back.codes,
    null,
    'restoring a tombstone must not invent a codes array'
  );
});

test('a purged field contributes no codes chunk to a session', async () => {
  const codesContributor = await import(
    '../assets/js/app/session/contributors/user-defined-codes.js'
  );
  const { registry, field, id } = registryWithCategoricalField();
  const live = registry.createFromCategoricalCodes(
    {
      key: 'keep_me',
      categories: ['A', 'B'],
      codes: new Uint8Array([1, 0, 1, 0, 1, 0, 1, 0]),
      source: 'obs'
    },
    {
      pointCount: POINT_COUNT,
      dimensionManager: {
        positionCache: new Map(),
        getAvailableDimensions: () => [2]
      }
    }
  );

  field._isDeleted = true;
  registry.purgeField(id);

  const state = {
    pointCount: POINT_COUNT,
    viewContexts: new Map(),
    activeFieldSource: null,
    activeFieldIndex: -1,
    activeVarFieldIndex: -1,
    getUserDefinedFieldsRegistry: () => registry
  };
  const chunks = codesContributor.capture({ state });
  const labels = chunks.map(chunk => chunk.label);

  assert.ok(
    labels.includes('User-defined codes: keep_me'),
    'the live field must still be written, or this test proves nothing'
  );
  assert.equal(
    labels.includes('User-defined codes: purge_me'),
    false,
    'a purged field must contribute no codes chunk - that payload is the bulk '
      + 'of what a purged column was adding to every bundle'
  );
  assert.ok(live.id);
});
