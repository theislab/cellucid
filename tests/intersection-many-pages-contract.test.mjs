/**
 * A field made from highlight pages with one category per intersection
 * combines any number of pages (not a 32-bit mask per cell, which refuses a
 * 33rd page, and keys each intersection's label in the session by
 * that mask). The action, the registry, the validator and the session's
 * reader key a combination by its pages' positions (`intersectionKey`); no
 * other key is read (one reader, no second path for an older shape).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { getActions } from '../assets/js/app/actions/index.js';
import { ActionRefused } from '../assets/js/app/actions/dispatcher.js';
import { installFieldActions } from '../assets/js/app/state/actions/field-actions.js';
import { UserDefinedFieldsRegistry } from '../assets/js/app/registries/user-defined-fields.js';
import { StateValidator } from '../assets/js/app/utils/state-validator.js';
import { OverlapStrategy } from '../assets/js/app/utils/field-constants.js';
import { createFieldOverlaysDomain } from '../assets/js/app/state/domains/field-overlays.js';
import { DataState } from '../assets/js/app/state/core/data-state.js';
import { createCellIdentity } from '../assets/js/data/cell-identity.js';

const PAGE_COUNT = 41;
const ALL_PAGES = Array.from({ length: PAGE_COUNT }, (_, position) => position).join('+');

/**
 * 41 pages over 43 cells: cell 0 is on every page, cell p + 1 on page p
 * alone, cell 42 on pages 0 (listed in two of its groups) and 40.
 */
function pagesState() {
  const highlightPages = Array.from({ length: PAGE_COUNT }, (_, position) => ({
    id: `id${position}`,
    name: `Page ${position}`,
    highlightedGroups: [
      { enabled: true, label: 'g', cellIndices: [0, position + 1, ...(position === 0 || position === 40 ? [42] : [])] },
      ...(position === 0 ? [{ enabled: true, label: 'again', cellIndices: Uint32Array.of(42) }] : []),
    ],
  }));
  return {
    pointCount: 43,
    highlightPages,
    getHighlightPageColor: () => '#2563eb',
    dimensionManager: {
      getResidentPositions: () => null,
      getRegisteredLayouts: () => [{ layoutKey: '2d', dimension: 2 }],
    },
  };
}

function pageOptions(intersectionLabels) {
  return {
    key: 'many',
    pages: Array.from({ length: PAGE_COUNT }, (_, position) => ({ pageId: `id${position}`, label: `P${position}` })),
    uncoveredLabel: 'Unassigned',
    overlapStrategy: OverlapStrategy.INTERSECTIONS,
    overlapLabel: '',
    intersectionLabels,
  };
}

test('a field combines the intersections of 41 pages, each keyed by its pages', () => {
  const registry = new UserDefinedFieldsRegistry();
  const { field, conflicts, uncoveredCount } = registry.createFromPages(
    pageOptions({ '0+40': 'First and last', [ALL_PAGES]: 'Every page' }),
    pagesState(),
  );
  const pageLabels = Array.from({ length: PAGE_COUNT }, (_, position) => `P${position}`);
  // Pairs before larger combinations; every cell is on a page, so no uncovered category.
  assert.deepEqual(field.categories, [...pageLabels, 'First and last', 'Every page']);
  const expected = [PAGE_COUNT + 1, ...pageLabels.map((_, position) => position), PAGE_COUNT];
  assert.deepEqual([...field.codes], expected);
  assert.equal(conflicts, 2);
  assert.equal(uncoveredCount, 0);
  assert.deepEqual(field._intersectionLabels, { '0+40': 'First and last', [ALL_PAGES]: 'Every page' });

  // Every combination holding cells needs its label; a key names pages in order, two or more.
  assert.throws(
    () => new UserDefinedFieldsRegistry().createFromPages(pageOptions({ '0+40': 'First and last' }), pagesState()),
    /name every combination of pages that holds cells exactly once/,
  );
  for (const key of ['40+0', '0+0', '0', '0+41', '00+1', '1099511627775']) {
    assert.throws(
      () => StateValidator.validateUserDefinedOptions(pageOptions({ [key]: 'X' })),
      /Intersection key/,
      key,
    );
  }
});

test('the action names 41 pages and their combinations by name', async t => {
  const pages = pagesState();
  const registry = new UserDefinedFieldsRegistry();
  const state = {
    pointCount: pages.pointCount,
    getFields: () => [],
    getVarFields: () => [],
    getHighlightPages: () => pages.highlightPages,
    createCategoricalFromPages: options => registry.createFromPages(options, pages),
  };
  t.after(installFieldActions({ state }));
  const actions = getActions();
  const names = pages.highlightPages.map(page => page.name);
  const params = {
    key: 'many',
    pages: names.map((page, position) => ({ page, label: `P${position}` })),
    overlap: 'intersections',
    intersection_labels: [
      { pages: [...names].reverse(), label: 'Every page' },
      { pages: ['Page 40', 'Page 0'], label: 'First and last' },
    ],
  };
  const { outcome } = await actions.dispatch('field.create-from-pages', params);
  assert.equal(outcome.categories, PAGE_COUNT + 2);
  const [field] = registry.getAllFields();
  assert.deepEqual(field._intersectionLabels, { [ALL_PAGES]: 'Every page', '0+40': 'First and last' });

  // One combination labelled twice is refused, whatever order names its pages.
  await assert.rejects(
    actions.dispatch('field.create-from-pages', {
      ...params,
      key: 'twice',
      intersection_labels: [...params.intersection_labels, { pages: ['Page 0', 'Page 40'], label: 'Again' }],
    }),
    error => error instanceof ActionRefused && /Two labels are given for the cells on/.test(error.message),
  );
});

/** A viewer with no GPU: every method the state calls on it exists. */
function headlessViewer() {
  const own = { getSnapshotViews: () => [], isDisposed: () => false };
  return new Proxy(own, { get: (target, key) => (key in target ? target[key] : () => undefined) });
}

test('a session value keys intersections by their pages; restore reads those keys and no other', async () => {
  const viewer = headlessViewer();
  const state = new DataState(viewer, null);
  state.pointCount = 4;
  state.cellIdentity = createCellIdentity({ nObs: 4 });
  state.colorsArray = new Uint8Array(16);
  state.categoryTransparency = new Uint8Array(4).fill(1);
  state.cellVisibilityMask = new Uint8Array(4).fill(1);
  state.dimensionManager = {
    getResidentPositions: () => null,
    getRegisteredLayouts: () => [{ layoutKey: '2d', dimension: 2 }],
  };
  state.obsData = { fields: [] };
  state.varData = { fields: [] };
  state._resetViewContexts();
  const overlays = createFieldOverlaysDomain({ state, viewer, refreshUi: () => {} });
  const item = {
    id: 'user_cat_1', source: 'obs', kind: 'category', key: 'pages', deleted: false, purged: false,
    createdAt: 0, sourceField: null, operation: null,
    categories: ['A', 'B', 'C', 'A & C', 'A & B & C'],
    codes: { cells: null, values: Uint8Array.of(0, 1, 3, 4) },
    sourcePages: [{ pageId: 'a', label: 'A' }, { pageId: 'b', label: 'B' }, { pageId: 'c', label: 'C' }],
    overlapStrategy: 'intersections', overlapLabel: null,
    intersectionLabels: { '0+2': 'A & C', '0+1+2': 'A & B & C' },
    uncoveredLabel: null, palette: null,
  };
  const base = overlays.capture();
  await overlays.restore({ ...base, userFields: [item] });
  assert.deepEqual(overlays.capture().userFields[0].intersectionLabels, { '0+2': 'A & C', '0+1+2': 'A & B & C' });

  // A key naming a page the field does not have, one page, out of order, or a 0.9.7 bit mask
  // (`5`) is refused and changes nothing.
  for (const intersectionLabels of [{ '0+3': 'A & D' }, { 2: 'C' }, { '2+0': 'C & A' }, { 5: 'A & C' }]) {
    await assert.rejects(
      overlays.restore({ ...base, userFields: [{ ...item, key: 'other', intersectionLabels }] }),
      /labels an intersection it cannot hold/,
    );
    assert.equal(overlays.capture().userFields[0].key, 'pages');
  }
});

test('with rest, the cells on no page of a 41-page intersection field keep their category of another field', () => {
  // Two more cells, on no page: 43 is Stromal in the kept field, 44 is "P3" there (a page's label: that page's category).
  const pages = { ...pagesState(), pointCount: 45 };
  const restCodes = new Uint8Array(45).fill(255);
  restCodes[43] = 0;
  restCodes[44] = 2;
  const options = {
    ...pageOptions({ '0+40': 'First and last', [ALL_PAGES]: 'Every page' }),
    rest: { categories: ['Stromal', 'Immune', 'P3'], codes: restCodes, missing: 255 },
  };
  assert.doesNotThrow(() => StateValidator.validateUserDefinedOptions(options));
  const { field } = new UserDefinedFieldsRegistry().createFromPages(options, pages);
  const pageLabels = Array.from({ length: PAGE_COUNT }, (_, position) => `P${position}`);
  // The pages, their combinations, then the kept categories the open cells use (Immune: none).
  assert.deepEqual(field.categories, [...pageLabels, 'First and last', 'Every page', 'Stromal']);
  assert.equal(field.codes[43], field.categories.indexOf('Stromal'));
  assert.equal(field.codes[44], 3);
  // The combinations are still keyed by their pages, whatever the cells on no page keep.
  assert.deepEqual(field._intersectionLabels, { '0+40': 'First and last', [ALL_PAGES]: 'Every page' });
  assert.equal(field.codes[0], PAGE_COUNT + 1);
  assert.equal(field.codes[42], PAGE_COUNT);
});
