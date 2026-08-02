import assert from 'node:assert/strict';
import test from 'node:test';
import * as codes from '../assets/js/app/session/contributors/user-defined-codes.js';
import { UserDefinedFieldsRegistry } from '../assets/js/app/registries/user-defined-fields.js';

const DIMS = { positionCache: new Map(), getAvailableDimensions: () => [2] };

test('restore refuses codes that name categories the field does not have', async () => {
  const registry = new UserDefinedFieldsRegistry();
  const { id, field } = registry.createFromCategoricalCodes(
    { key: 'k', categories: ['A', 'B'], codes: new Uint8Array([0, 1, 0, 1]), source: 'obs' },
    { pointCount: 4, dimensionManager: DIMS }
  );
  const state = {
    pointCount: 4,
    viewContexts: new Map(),
    activeFieldSource: null,
    activeFieldIndex: -1,
    activeVarFieldIndex: -1,
    getUserDefinedFieldsRegistry: () => registry,
    getActiveField: () => null,
    obsData: { fields: [] },
    varData: { fields: [] }
  };
  const chunk = codes.capture({ state })[0];
  const { payload, ...meta } = chunk;
  const chunkMeta = {
    ...meta,
    storedBytes: payload.byteLength,
    uncompressedBytes: payload.byteLength
  };

  // The bundle's own metadata is untouched and self-consistent: the length and
  // the width both check out. Only the inventory the codes point into is
  // smaller than the codes claim.
  field.codes = null;
  field.loaded = false;
  field.categories = ['A'];
  field._codesLengthHint = 4;
  field._codesTypeHint = 'Uint8Array';

  await assert.rejects(
    () => codes.restore({ state, abortSignal: null }, chunkMeta, payload),
    /outside the category inventory/,
    'a code naming a category that does not exist must be refused, not stored'
  );
  assert.equal(field.codes, null, 'the refused array must not reach the field');
  assert.ok(id);
});
