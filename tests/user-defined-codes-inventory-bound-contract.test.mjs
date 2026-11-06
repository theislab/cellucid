/**
 * A user-defined categorical's codes are bounded by its own category
 * inventory when the `field-overlays` state domain puts a field back
 * (`app/state/domains/field-overlays.js`): a value whose codes name a
 * category the field does not list is refused, and the refused codes never
 * reach the field.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createFieldOverlaysDomain } from '../assets/js/app/state/domains/field-overlays.js';
import { DataState } from '../assets/js/app/state/core/data-state.js';
import { createCellIdentity } from '../assets/js/data/cell-identity.js';

/** A viewer with one view and no GPU: every method the state calls on it exists. */
function headlessViewer() {
  const own = { getSnapshotViews: () => [], isDisposed: () => false };
  return new Proxy(own, { get: (target, key) => (key in target ? target[key] : () => undefined) });
}

/** A DataState of 4 cells, every one open, with no dataset field. */
function stateOfFourCells() {
  const viewer = headlessViewer();
  const state = new DataState(viewer, null);
  state.pointCount = 4;
  state.cellIdentity = createCellIdentity({ nObs: 4 });
  state.colorsArray = new Uint8Array(16);
  state.categoryTransparency = new Uint8Array(4).fill(1);
  state.cellVisibilityMask = new Uint8Array(4).fill(1);
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

test('restore refuses codes that name categories the field does not have', async () => {
  const { state, viewer } = stateOfFourCells();
  const overlays = createFieldOverlaysDomain({ state, viewer, refreshUi: () => {} });
  const { fieldIndex } = state.upsertUserDefinedCategoricalField({ key: 'k', categories: ['A', 'B'], codes: Uint8Array.of(0, 1, 0, 1) });
  const field = state.obsData.fields[fieldIndex];
  const codes = field.codes;
  const value = overlays.capture();

  // The value's codes are untouched and fit the dataset: four cells, one byte
  // each. Only the inventory the codes point into is smaller than the codes
  // claim.
  const narrowed = structuredClone(value);
  narrowed.userFields[0].categories = ['A'];
  await assert.rejects(
    overlays.restore(narrowed),
    /code 1 is outside the category inventory/,
    'a code naming a category that does not exist must be refused, not stored'
  );
  const template = state.getUserDefinedFieldsRegistry().getField(value.userFields[0].id);
  assert.equal(template.codes, codes, 'the refused array must not reach the field');
  assert.equal(field.codes, codes, 'nor the view\'s copy of it');
  assert.deepEqual(template.categories, ['A', 'B']);
  assert.deepEqual([...template.codes], [0, 1, 0, 1]);
});
