/**
 * The owners of the state domains (`assets/js/app/state/domains/`): every
 * domain of `app/actions/domains.js` has one; values name cells by original
 * position, fields by name and views by position; equality agrees with the
 * value pool's content hash; restores put a value back exactly and leave what
 * matches alone; describe lines say what changed; the fingerprint names the
 * domain that differs. The browser spec
 * (`tests/browser/state-domains-roundtrip.spec.mjs`) drives the same owners
 * through the real interface.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DOMAIN_IDS, createDomainRegistry } from '../assets/js/app/actions/domains.js';
import { hashValue } from '../assets/js/app/history/value-pool.js';
import { OWNERS, installStateDomains } from '../assets/js/app/state/domains/index.js';
import { openCellList, openColumn, originalCellList, originalColumn } from '../assets/js/app/state/domains/cell-positions.js';
import { sameValue } from '../assets/js/app/state/domains/same-value.js';
import { compareRefs, fieldRef, findField, loadFields, refId } from '../assets/js/app/state/domains/fields.js';
import { captureFieldFilter, captureViewFilters, createFiltersDomain } from '../assets/js/app/state/domains/filters.js';
import { captureFieldColors, createColorsDomain } from '../assets/js/app/state/domains/colors.js';
import { createActiveFieldDomain } from '../assets/js/app/state/domains/active-field.js';
import { createVisibilityDomain } from '../assets/js/app/state/domains/visibility.js';
import { createHighlightFieldBinder, createHighlightsDomain } from '../assets/js/app/state/domains/highlights.js';
import { createFieldOverlaysDomain } from '../assets/js/app/state/domains/field-overlays.js';
import { createGeneSetsDomain } from '../assets/js/app/state/domains/gene-sets.js';
import { createMappingDomain } from '../assets/js/app/state/domains/mapping.js';
import { createCellsDomain, openCellsKey, openCellsValueOf, requestOfOpenCellsValue } from '../assets/js/app/state/domains/cells.js';
import { createCameraPathDomain } from '../assets/js/app/state/domains/camera-path.js';
import { createAnalysisDomain } from '../assets/js/app/state/domains/analysis.js';
import { createViewsDomain } from '../assets/js/app/state/domains/views.js';
import { createCameraDomain } from '../assets/js/app/state/domains/camera.js';
import { controlDomainOf, createUiControlSerializer } from '../assets/js/app/state-serializer/ui-controls.js';
import { differingDomains, fingerprintOf } from '../assets/js/app/state/domains/fingerprint.js';
import { requireViewsFit } from '../assets/js/app/state/domains/view-list.js';
import { createCellIdentity } from '../assets/js/data/cell-identity.js';
import { DataState } from '../assets/js/app/state/core/data-state.js';
import { RenameRegistry } from '../assets/js/app/registries/rename-registry.js';
import { DeleteRegistry } from '../assets/js/app/registries/delete-registry.js';
import { heldCategoriesOf, pendingCategoryState, holdPendingCategoryState } from '../assets/js/app/state/managers/field/pending-categories.js';
import { heldCategoriesNotice } from '../assets/js/app/session/session-serializer.js';
import { createDefaultCameraPose } from '../assets/js/rendering/camera-state-contract.js';

const INDEX_HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/** A viewer with one view and no GPU: every method the state calls on it exists. */
function headlessViewer() {
  const flags = new Map([['live', { points: false, labels: false }]]);
  const own = {
    getSnapshotViews: () => [],
    getViewLayout: () => ({ mode: 'grid', activeId: 'live', liveViewHidden: false }),
    getCentroidFlags: id => ({ ...flags.get(id) }),
    getCamerasLocked: () => true,
    getFocusedViewId: () => 'live',
    isDisposed: () => false,
  };
  return new Proxy(own, { get: (target, key) => (key in target ? target[key] : () => undefined) });
}

/**
 * A DataState of 6 open cells (a subsample of 12, rows 1, 3, …, 11) with a
 * category field, a continuous field and a gene.
 */
function stateOfSixCells() {
  const viewer = headlessViewer();
  const state = new DataState(viewer, null);
  state.pointCount = 6;
  state.cellIdentity = createCellIdentity({ nObs: 12, kept: Uint32Array.of(1, 3, 5, 7, 9, 11) });
  state.highlightArray = new Uint8Array(6);
  state.colorsArray = new Uint8Array(24);
  state.categoryTransparency = new Uint8Array(6).fill(1);
  state.cellVisibilityMask = new Uint8Array(6).fill(1);
  // One 2-D layout whose positions are not held: no centroid is computed.
  state.dimensionManager = {
    getViewLayout: () => 'umap',
    getLayout: () => ({ layoutKey: 'umap', dimension: 2, provenance: null }),
    getNormTransform: () => null,
    getRegisteredLayouts: () => [],
    getResidentPositions: () => null,
    unshownBytes: () => 0,
    trimUnshown: () => null,
  };
  state.obsData = {
    fields: [
      {
        key: 'cell_type', kind: 'category', categories: ['B', 'T', 'NK'], codes: Uint8Array.of(0, 1, 2, 0, 1, 2), loaded: true,
        centroidsByLayout: new Map(),
      },
      { key: 'score', kind: 'continuous', values: Float32Array.of(0, 1, 2, 3, 4, 5), loaded: true },
    ],
  };
  state.varData = { fields: [{ key: 'CD3E', kind: 'continuous', values: Float32Array.of(0, 0, 1, 2, 0, 3), loaded: true }] };
  state._resetViewContexts();
  state.ensureHighlightPage();
  return { state, viewer };
}

/**
 * The open data's controls the `cells` domain reads and puts back
 * (`ui-coordinator.js` `openCells`), over a dataset of 100 cells: a reading
 * again on other cells replaces the subset, and genes read grow the sample.
 */
function fakeOpenCells() {
  const log = [];
  let subset = { nObs: 100, kept: null, spec: null };
  let sample = { cells: 10, of: 100 };
  let asked = null;
  const openCells = {
    subset: () => subset,
    geneSample: () => sample,
    genesAsked: () => (asked !== null && asked.key === openCellsKey(subset) ? asked.cells : null),
    setGenesAsked: cells => { asked = cells === null ? null : { cells, key: openCellsKey(subset) }; },
    async reopen(request) {
      log.push(['reopen', request]);
      subset = request.mode === 'all'
        ? { nObs: 100, kept: null, spec: null }
        : { nObs: 100, kept: new Uint32Array(request.k), spec: { method: request.method, k: request.k, seed: request.seed } };
      sample = { cells: Math.min(10, subset.kept?.length ?? 100), of: subset.kept?.length ?? 100 };
      return { restoring: Promise.resolve() };
    },
    async readGenes(cells) {
      log.push(['read', cells]);
      sample = { cells: Math.min(cells, sample.of), of: sample.of };
    },
  };
  return { openCells, log, ask: cells => openCells.setGenesAsked(cells) };
}

test('open cells: a subsample by its specification, genes asked for on these cells; restore reads them again', async () => {
  const { openCells, log, ask } = fakeOpenCells();
  const domain = createCellsDomain({ openCells });
  const every = domain.capture();
  assert.deepEqual(every, { open: null, genes: null });
  await openCells.reopen({ mode: 'subsample', method: 'uniform', k: 40, seed: 3 });
  ask(30);
  const sub = domain.capture();
  assert.deepEqual(sub, { open: { method: 'uniform', k: 40, seed: 3 }, genes: 30 });
  log.length = 0;
  // Back to every cell: read again, and the genes asked for on the subsample say nothing of every cell.
  await domain.restore(every);
  assert.deepEqual(log, [['reopen', { mode: 'all' }]]);
  assert.deepEqual(domain.capture(), every);
  // The same value again reads nothing (idempotent).
  log.length = 0;
  await domain.restore(every);
  assert.deepEqual(log, []);
  // The subsample with its genes: read again exactly (strict), then genes read for 30 of its cells.
  await domain.restore(sub);
  assert.deepEqual(log, [['reopen', { mode: 'subsample', method: 'uniform', k: 40, seed: 3, strict: true }], ['read', 30]]);
  assert.deepEqual(domain.capture(), sub);
  // Fewer genes asked for keeps what is read (reading is never undone).
  log.length = 0;
  await domain.restore({ ...sub, genes: 20 });
  assert.deepEqual(log, []);
  assert.deepEqual(domain.capture(), { ...sub, genes: 20 });
  assert.deepEqual(domain.describe(every, sub), [
    'Cells open: every cell → 40 cells (uniform, seed 3)',
    'Genes read for: the opening\'s sample → 30 cells',
  ]);
  await assert.rejects(domain.restore({ open: null }), /name the cells and the genes asked for/);
  // A reading that does not give the cells asked for is a failure, never a silent other share.
  const stubborn = createCellsDomain({ openCells: { ...openCells, reopen: async () => ({ restoring: Promise.resolve() }) } });
  await assert.rejects(stubborn.restore(every), /could not be read again: every cell were asked for, 40 cells/);
  assert.throws(() => createCellsDomain({ openCells: { ...openCells, reopen: undefined } }), /needs openCells\.reopen\(\)/);
  // The pure helpers: a subset to its value, a value to its request.
  assert.equal(openCellsValueOf(null), null);
  assert.equal(openCellsValueOf({ nObs: 100, kept: Uint32Array.of(1), spec: { method: 'uniform', k: 1, seed: 0 }, chunks: { target: 100 } }), null);
  assert.deepEqual(requestOfOpenCellsValue(null), { mode: 'all' });
});

test('every state domain has exactly one owner module, and installing provides each', () => {
  assert.deepEqual(Object.keys(OWNERS).sort(), [...DOMAIN_IDS].sort());
  const domains = createDomainRegistry();
  const previousDocument = globalThis.document;
  globalThis.document = { getElementById: () => null };
  try {
    const { state, viewer } = stateOfSixCells();
    const sidebar = { querySelectorAll: () => [] };
    const uninstall = installStateDomains({
      domains, state, viewer, sidebar, refreshUi: () => {}, cinematicCamera: null, figureExport: null,
      analysis: async () => null, getDockable: () => null, openCells: fakeOpenCells().openCells,
      sidebarLayout: { isSidebarShown: () => true, showSidebar() {}, setSidebarWidth() {} },
    });
    assert.deepEqual(domains.missing(), []);
    for (const id of DOMAIN_IDS) assert.equal(typeof domains.owner(id).describe, 'function', `${id} describes its changes`);
    uninstall();
    assert.deepEqual(domains.missing(), [...DOMAIN_IDS]);
    assert.throws(() => installStateDomains({
      domains, state, viewer, sidebar, refreshUi: () => {}, openCells: fakeOpenCells().openCells,
      sidebarLayout: { isSidebarShown: () => true, showSidebar() {}, setSidebarWidth() {} },
    }), /need analysis\(\)/);
    assert.throws(() => installStateDomains({
      domains, state, viewer, sidebar, refreshUi: () => {}, analysis: async () => null, getDockable: () => null,
    }), /need the page's openCells/);
  } finally {
    globalThis.document = previousDocument;
  }
});

test('cells: lists and columns by original position, laid back over whatever cells are open', () => {
  // Open cells 1, 3, 5, 7, 9, 11 of 12, in priority order 9, 1, 11, 3, 5, 7.
  const ordered = createCellIdentity({ nObs: 12, kept: Uint32Array.of(1, 3, 5, 7, 9, 11), openOrder: Uint32Array.of(9, 1, 11, 3, 5, 7) });
  const list = originalCellList(ordered, Uint32Array.of(0, 2, 3));
  assert.deepEqual([...list], [3, 9, 11]);
  assert.equal(originalCellList(ordered, Uint32Array.of(0, 2, 3)) === list, false, 'a new positions array is converted again');
  const positions = Uint32Array.of(1, 4);
  assert.equal(originalCellList(ordered, positions), originalCellList(ordered, positions), 'an unchanged array gives the same value');
  // Restored on another share: a cell that is not open is left out.
  const other = createCellIdentity({ nObs: 12, kept: Uint32Array.of(0, 3, 4, 11) });
  assert.deepEqual([...openCellList(other, list)], [1, 3]);
  // Every cell open in its own order: the list is its own value.
  const whole = createCellIdentity({ nObs: 4 });
  const ascending = Uint32Array.of(0, 2);
  assert.equal(originalCellList(whole, ascending), ascending);

  const codes = Uint8Array.of(10, 11, 12, 13, 14, 15);
  const column = originalColumn(ordered, codes);
  assert.deepEqual([...column.cells], [1, 3, 5, 7, 9, 11]);
  // Open cell i is original ordered.openOrder[i]: 9→10, 1→11, 11→12, 3→13, 5→14, 7→15.
  assert.deepEqual([...column.values], [11, 13, 14, 15, 10, 12]);
  assert.equal(originalColumn(ordered, codes), column);
  assert.equal(openColumn(ordered, column, Uint8Array, 255), codes, 'the open values it came from are reused');
  assert.deepEqual([...openColumn(other, column, Uint8Array, 255)], [255, 13, 255, 12]);
  assert.throws(() => openColumn(whole, { cells: null, values: new Uint8Array(3) }, Uint8Array, 255), /does not fit the 4 cells/);
});

test('equality of values is the value pool hash equality', async () => {
  const pairs = [
    [{ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }],
    [{ a: Uint32Array.of(1, 2) }, { a: Uint32Array.of(1, 2) }],
    [{ a: Uint32Array.of(1, 2) }, { a: Int32Array.of(1, 2) }],
    [{ a: 1, b: undefined }, { a: 1 }],
    [{ a: Number.NaN }, { a: Number.NaN }],
    [{ a: 0 }, { a: -0 }],
    [[1, 2], [2, 1]],
    [{ a: null }, { a: 0 }],
  ];
  for (const [x, y] of pairs) {
    assert.equal(sameValue(x, y), (await hashValue(x)) === (await hashValue(y)), JSON.stringify([x, y], (k, v) => (ArrayBuffer.isView(v) ? [...v] : v)));
  }
});

test('fields are named by their dataset key or their user id, so a rename changes no reference', () => {
  const field = { key: 'clusters', _originalKey: 'leiden', kind: 'category' };
  assert.deepEqual(fieldRef(field, 'obs'), { source: 'obs', key: 'leiden' });
  assert.deepEqual(fieldRef({ key: 'x', _isUserDefined: true, _userDefinedId: 'user_cat_1' }, 'obs'), { source: 'obs', user: 'user_cat_1' });
  assert.notEqual(refId({ source: 'obs', key: 'a' }), refId({ source: 'obs', user: 'a' }));
  assert.equal(compareRefs({ source: 'obs', key: 'b' }, { source: 'obs', key: 'a' }), 1);
  const owner = { obsData: { fields: [field] }, varData: { fields: [] } };
  assert.equal(findField(owner, { source: 'obs', key: 'leiden' }).field, field);
  assert.equal(findField(owner, { source: 'obs', key: 'clusters' }), null);
});

test('filters and colors record only what differs from a field\'s opening state, each in its own domain', () => {
  const field = { key: 'cell_type', kind: 'category', categories: ['B', 'T', 'NK'] };
  assert.equal(captureFieldFilter(field, 'obs'), null);
  // Opened: its defaults filled in. Still nothing.
  field._categoryVisible = Uint8Array.of(1, 1, 1);
  field._categoryFilterEnabled = true;
  field._categoryColors = undefined;
  assert.equal(captureFieldFilter(field, 'obs'), null);
  field._categoryVisible = Uint8Array.of(1, 0, 1);
  field._missingVisible = false;
  field._outlierThreshold = 0.8;
  holdPendingCategoryState(field, { visibility: [{ categoryName: 'gdT', visible: false }], colors: [{ categoryName: 'gdT', color: [1, 0, 0] }] });
  assert.deepEqual(captureFieldFilter(field, 'obs'), {
    field: { source: 'obs', key: 'cell_type' }, hidden: ['T', 'gdT'], missingHidden: true, outlier: 0.8,
  });
  assert.deepEqual(captureFieldColors(field, 'obs'), { field: { source: 'obs', key: 'cell_type' }, colors: [{ category: 'gdT', color: '#ff0000' }] });

  const score = { key: 'score', kind: 'continuous', _continuousStats: { min: 0, max: 5 } };
  score._continuousFilter = { min: 0, max: 5 };
  score._continuousColorRange = { min: 0, max: 5 };
  score._useFilterColorRange = true;
  score._colormapId = 'viridis';
  assert.equal(captureFieldFilter(score, 'obs'), null);
  assert.equal(captureFieldColors(score, 'obs'), null);
  // A narrower filter is the filter's; the color range, measured against
  // the data and not the filter, is unchanged.
  score._continuousFilter = { min: 1, max: 4 };
  assert.deepEqual(captureFieldFilter(score, 'obs'), { field: { source: 'obs', key: 'score' }, range: { min: 1, max: 4 } });
  assert.equal(captureFieldColors(score, 'obs'), null);
  score._continuousColorRange = { min: 1, max: 4 };
  score._useLogScale = true;
  score._zeroGray = true;
  score._colormapId = 'magma';
  assert.deepEqual(captureFieldColors(score, 'obs'), {
    field: { source: 'obs', key: 'score' }, range: { min: 1, max: 4 }, log: true, zeroGray: true, colormap: 'magma',
  });
});

test('filters and colors restore exactly, view by view, and leave what matches alone', async () => {
  const { state, viewer } = stateOfSixCells();
  let refreshed = 0;
  const filters = createFiltersDomain({ state, viewer, refreshUi: () => { refreshed++; } });
  const colors = createColorsDomain({ state, viewer, refreshUi: () => { refreshed++; } });
  const empty = filters.capture();
  assert.deepEqual(empty, { views: [[]] });
  const cellType = state.obsData.fields[0];
  state.setVisibilityForCategory(cellType, 1, false);
  state.setColorForCategory(cellType, 2, [0, 0, 1]);
  state.applyContinuousFilter(1, 1, 4);
  state.setContinuousColormap(1, 'magma');
  const filtered = filters.capture();
  const colored = colors.capture();
  assert.deepEqual(filtered.views[0].map(entry => Object.keys(entry).sort()), [['field', 'hidden'], ['field', 'range']]);
  assert.deepEqual([...state.categoryTransparency], [1, 0, 1, 1, 0, 1].map((shown, i) => shown && state.obsData.fields[1].values[i] >= 1 && state.obsData.fields[1].values[i] <= 4 ? 1 : 0));

  await filters.restore(empty);
  assert.deepEqual(filters.capture(), empty);
  assert.deepEqual(colors.capture(), colored, 'restoring filters leaves colors alone');
  assert.deepEqual([...state.categoryTransparency], [1, 1, 1, 1, 1, 1]);
  await colors.restore({ views: [[]] });
  assert.deepEqual(colors.capture(), { views: [[]] });
  assert.equal(state.obsData.fields[1]._colormapId, 'viridis');

  await filters.restore(filtered);
  await colors.restore(colored);
  assert.deepEqual(filters.capture(), filtered);
  assert.deepEqual(colors.capture(), colored);
  const before = refreshed;
  await filters.restore(filtered);
  await colors.restore(colored);
  assert.equal(refreshed, before, 'a restore of what is shown changes nothing');
  await assert.rejects(filters.restore({ views: [[], []] }), /for 2 views, and 1 is shown/);
  await assert.rejects(
    filters.restore({ views: [[{ field: { source: 'obs', key: 'gone' }, off: true }]] }),
    /names the obs field "gone", which this dataset does not have now/,
  );

  // A category that keeps only some of its cells (filter by cell count) is a filter, by label.
  state.setCategoryCellLimit(cellType, 0, { count: 1, seed: 3 });
  const limited = filters.capture();
  assert.deepEqual(limited.views[0].find(entry => entry.field.key === 'cell_type').limits, [{ category: 'B', count: 1, seed: 3 }]);
  assert.deepEqual(filters.describe(filtered, limited), ['cell_type: 1 cell of B kept']);
  await filters.restore(filtered);
  assert.deepEqual(filters.capture(), filtered);
  assert.equal(cellType._categoryCellLimits, undefined);
  await filters.restore(limited);
  assert.deepEqual(filters.capture(), limited);
  assert.deepEqual(filters.describe(limited, filtered), ['cell_type: every cell of B shown']);
  await assert.rejects(
    filters.restore({ views: [[{ field: { source: 'obs', key: 'cell_type' }, limits: [{ category: 'Monocyte', count: 1, seed: 0 }] }]] }),
    /A filter names the category "Monocyte", which "cell_type" no longer has/,
  );
});

test('the active field and the cells hidden by hand restore by name and by original position', async () => {
  const { state, viewer } = stateOfSixCells();
  const active = createActiveFieldDomain({ state, viewer, refreshUi: () => {} });
  const visibility = createVisibilityDomain({ state, viewer, refreshUi: () => {} });
  assert.deepEqual(active.capture(), { views: [null] });
  state.setActiveVarField(0);
  assert.deepEqual(active.capture(), { views: [{ source: 'var', key: 'CD3E' }] });
  await active.restore({ views: [{ source: 'obs', key: 'cell_type' }] });
  assert.equal(state.getActiveField(), state.obsData.fields[0]);
  await active.restore({ views: [null] });
  assert.equal(state.activeFieldSource, null);
  assert.deepEqual(active.describe({ views: [null] }, { views: [{ source: 'obs', key: 'cell_type' }] }), ['colored by cell_type']);

  assert.deepEqual([...visibility.capture().views[0]], []);
  state.setCellVisibility(Uint32Array.of(0, 5), false);
  const hidden = visibility.capture();
  assert.deepEqual([...hidden.views[0]], [1, 11], 'open cells 0 and 5 are rows 1 and 11');
  assert.equal(visibility.capture().views[0], hidden.views[0], 'an unchanged mask gives the same array');
  await visibility.restore({ views: [new Uint32Array(0)] });
  assert.deepEqual([...state.cellVisibilityMask], [1, 1, 1, 1, 1, 1]);
  await visibility.restore(hidden);
  assert.deepEqual([...state.cellVisibilityMask], [0, 1, 1, 1, 1, 0]);
  assert.deepEqual(visibility.describe({ views: [new Uint32Array(0)] }, hidden), ['2 cells hidden by hand (was 0)']);
});

test('highlights keep their pages and ids, name cells by original position, and bind category groups by name', async () => {
  const { state } = stateOfSixCells();
  const highlights = createHighlightsDomain({ state, refreshUi: () => {} });
  state.addHighlightDirect({ type: 'lasso', label: 'Lasso', cellIndices: Uint32Array.of(0, 2) });
  state.addHighlightFromCategory(0, 1, 'obs');
  const page2 = state.createHighlightPage('Second');
  const captured = highlights.capture();
  assert.equal(captured.pages.length, 2);
  const [lasso, tCells] = captured.pages[0].groups;
  assert.deepEqual([...lasso.cells], [1, 5]);
  assert.deepEqual({ ...tCells, cells: [...tCells.cells] }, {
    id: 'highlight_2', type: 'category', label: 'cell_type: T', enabled: true,
    cells: [3, 9], field: { source: 'obs', key: 'cell_type' }, category: 'T',
  });
  state.deleteHighlightPage(page2.id);
  state.clearActivePageHighlights();
  await highlights.restore(captured);
  assert.ok(sameValue(highlights.capture(), captured));
  const restoredGroup = state.getHighlightPages()[0].highlightedGroups[1];
  assert.deepEqual([restoredGroup.fieldIndex, restoredGroup.categoryIndex], [0, 1]);
  // A new page after the restore never takes an id the history holds.
  assert.equal(state.createHighlightPage('Third').id, 'page_3');
  assert.deepEqual(highlights.describe(captured, highlights.capture()), ['Highlight page "Third" added']);
  // Undone to a value of fewer pages and groups, the id counters stay where they went:
  // ids stay unique across every step of the history (an analysis names a page by id).
  const withThird = highlights.capture();
  await highlights.restore(captured);
  assert.equal(state.createHighlightPage('Fourth').id, 'page_4');
  assert.equal(state.addHighlightDirect({ type: 'lasso', label: 'Again', cellIndices: Uint32Array.of(1) }).id, 'highlight_3');
  await highlights.restore(withThird);
  assert.ok(sameValue(highlights.capture(), withThird));
  // A selection's preview is drawn, never part of the value.
  state.setPreviewHighlightFromIndices(Uint32Array.of(4, 5));
  assert.ok(sameValue(highlights.capture(), withThird));
  state.clearPreviewHighlight();

  // A deleted field still binds its groups in the history (not in a session file).
  state.obsData.fields[0]._isDeleted = true;
  assert.throws(() => createHighlightFieldBinder(state)({ type: 'category', fieldSource: 'obs', fieldKey: 'cell_type', categoryName: 'T' }, 'A group'),
    /which the dataset that is open now does not have/);
  assert.deepEqual(createHighlightFieldBinder(state, { allowDeleted: true })({ type: 'category', fieldSource: 'obs', fieldKey: 'cell_type', categoryName: 'T' }, 'A group'),
    { fieldIndex: 0, categoryIndex: 1 });
});

test('renames and deletions are entries by name; their registries round-trip them exactly', () => {
  const renames = new RenameRegistry();
  renames.setFieldRename('obs', 'leiden', 'clusters');
  renames.setFieldRename('var', 'chr1:100-200', 'peak A');
  renames.setCategoryRename('obs', 'a:b', 'c:d', 'Plasma');
  renames.setCategoryRename('obs', 'flag', true, 'yes');
  renames.setCategoryRename('obs', 'n', 1, 'one');
  const entries = renames.toEntries();
  assert.deepEqual(entries.categories, [
    { source: 'obs', field: 'a:b', category: 'c:d', name: 'Plasma' },
    { source: 'obs', field: 'flag', category: true, name: 'yes' },
    { source: 'obs', field: 'n', category: 1, name: 'one' },
  ]);
  const copy = new RenameRegistry();
  copy.fromEntries(entries);
  assert.deepEqual(copy.toJSON(), renames.toJSON());
  assert.equal(copy.getDisplayCategory('obs', 'n', 1), 'one');
  assert.equal(copy.getDisplayCategory('obs', 'n', '1'), '1');

  const deleted = new DeleteRegistry();
  deleted.markDeleted('obs', 'batch');
  deleted.markPurged('var', 'MT-CO1');
  const deletions = deleted.toEntries();
  assert.deepEqual(deletions, [{ source: 'obs', key: 'batch', purged: false }, { source: 'var', key: 'MT-CO1', purged: true }]);
  const deletedCopy = new DeleteRegistry();
  deletedCopy.fromEntries(deletions);
  assert.deepEqual(deletedCopy.toJSON(), deleted.toJSON());
  assert.throws(() => deletedCopy.fromEntries([{ source: 'obs', key: 'a', purged: false }, { source: 'obs', key: 'a', purged: true }]), /deleted twice/);
});

test('field overlays: user fields come and go in every view, their codes by original position', async () => {
  const { state, viewer } = stateOfSixCells();
  const overlays = createFieldOverlaysDomain({ state, viewer, refreshUi: () => {} });
  const empty = overlays.capture();
  assert.deepEqual(empty, { renamedFields: [], renamedCategories: [], deletedFields: [], userFields: [] });
  state.upsertUserDefinedCategoricalField({ key: 'annotation', categories: ['x', 'y'], codes: Uint8Array.of(0, 1, 1, 0, 255, 1) });
  state.upsertUserDefinedContinuousField({ key: 'pushed', values: Float32Array.of(1, 2, 3, 4, 5, Number.NaN), operation: { type: 'notebook-push' } });
  state.getRenameRegistry().setFieldRename('obs', 'score', 'Score');
  state.applyFieldOverlays();
  const made = overlays.capture();
  assert.equal(made.userFields.length, 2);
  const [annotation, pushed] = made.userFields;
  assert.deepEqual(annotation.categories, ['x', 'y']);
  assert.deepEqual([...annotation.codes.cells], [1, 3, 5, 7, 9, 11]);
  assert.deepEqual([...annotation.codes.values], [0, 1, 1, 0, 255, 1]);
  assert.ok(pushed.values.values instanceof Float32Array);
  assert.deepEqual(made.renamedFields, [{ source: 'obs', key: 'score', name: 'Score' }]);

  // Back to before: the fields leave every list, the rename goes.
  const userField = state.obsData.fields.find(field => field.key === 'annotation');
  state.setActiveField(state.obsData.fields.indexOf(userField));
  await overlays.restore(empty);
  assert.deepEqual(overlays.capture(), empty);
  assert.deepEqual(state.obsData.fields.map(field => field.key), ['cell_type', 'score']);
  assert.equal(state.activeFieldSource, null, 'a view colored by a field that went is colored by nothing');

  // And forward again: the same ids, codes and values.
  await overlays.restore(made);
  assert.ok(sameValue(overlays.capture(), made));
  assert.deepEqual(state.obsData.fields.map(field => field.key), ['cell_type', 'Score', 'annotation', 'pushed']);
  const back = state.obsData.fields[2];
  assert.equal(back._userDefinedId, annotation.id);
  assert.deepEqual([...back.codes], [0, 1, 1, 0, 255, 1]);
  assert.deepEqual(overlays.describe(empty, made), [
    'Field "score" shown as "Score"', 'Annotation "annotation" made', 'Field "pushed" made',
  ]);

  // A category renamed in the user field's definition: a view's recolor of
  // a category it still has is carried by label.
  state.setColorForCategory(back, 1, [1, 0, 0]);
  const renamedDefinition = structuredClone(made);
  renamedDefinition.userFields[0].categories = ['y', 'x'];
  renamedDefinition.userFields[0].codes = { cells: annotation.codes.cells, values: Uint8Array.of(1, 0, 0, 1, 255, 0) };
  await overlays.restore(renamedDefinition);
  const carried = state.obsData.fields[2];
  assert.deepEqual(carried.categories, ['y', 'x']);
  assert.deepEqual(captureViewFilters(state), []);
  assert.deepEqual(captureFieldColors(carried, 'obs').colors, [{ category: 'y', color: '#ff0000' }]);
});

test('field overlays: a user field a view shows as itself takes a definition with other categories, its colors carried by label', async () => {
  // A category deleted into "unassigned" makes "cell_type (edited)": the
  // registry's template is the very field the view shows. Putting back a
  // definition whose categories differ (another category deleted, then the
  // step before shown) must not keep the colors of the categories it had.
  const { state, viewer } = stateOfSixCells();
  const overlays = createFieldOverlaysDomain({ state, viewer, refreshUi: () => {} });
  state.setActiveField(0);
  state.setColorForCategory(state.obsData.fields[0], 1, [1, 0, 0]);
  state.deleteCategoryToUnassigned(0, 0, { editInPlace: false, unassignedLabel: 'unassigned' });
  const edited = state.getActiveField();
  assert.equal(edited.key, 'cell_type (edited)');
  assert.equal(state.getUserDefinedFieldsRegistry().getField(edited._userDefinedId), edited, 'the view shows the template itself');
  // [T, NK, unassigned]: NK keeps its #ad50e0, the palette color of Unassigned's place, so
  // Unassigned takes the first palette color told apart from T's red and NK's (F111: it
  // was NK's color, two categories in one).
  assert.deepEqual([...edited.categories], ['T', 'NK', 'unassigned']);
  assert.deepEqual([...edited._categoryColors], [255, 0, 0, 0xad, 0x50, 0xe0, 0xff, 0x99, 0x00]);
  const once = overlays.capture();
  const categoriesOnce = [...edited.categories];
  state.deleteCategoryToUnassigned(state.activeFieldIndex, edited.categories.indexOf('NK'), { editInPlace: true, unassignedLabel: 'unassigned' });
  assert.notDeepEqual([...state.getActiveField().categories], categoriesOnce);

  await overlays.restore(once);
  const back = state.getActiveField();
  assert.deepEqual([...back.categories], categoriesOnce);
  assert.ok(sameValue(overlays.capture(), once));
  assert.deepEqual(captureFieldColors(back, 'obs').colors, [
    { category: 'T', color: '#ff0000' },
    // Kept by label: the color it was given beside NK (above), not its place's.
    { category: 'unassigned', color: '#ff9900' },
  ], 'T keeps the red it was given');
});

test('gene sets, the data mapping and the camera path restore whole', async () => {
  const { state } = stateOfSixCells();
  const geneSets = createGeneSetsDomain({ state });
  assert.deepEqual(geneSets.capture(), { sets: [] });
  state.getDerivedResults().upsertNotebookGeneSet({ name: 'T', description: 'T cells', genes: ['CD3E', 'CD3D'] });
  const one = geneSets.capture();
  geneSets.restore({ sets: [] });
  assert.deepEqual(geneSets.capture(), { sets: [] });
  geneSets.restore(one);
  assert.deepEqual(geneSets.capture(), one);
  assert.deepEqual(geneSets.describe({ sets: [] }, one), ['Gene set T added (2 genes)']);

  const mapping = createMappingDomain({ state, refreshUi: () => {} });
  assert.equal(mapping.capture(), null);
  await assert.rejects(mapping.restore({ kind: 'anndata' }), /cannot be restored while no dataset is open/);

  const restored = [];
  const path = {
    record: { keyframes: [], nextIndex: 1, loopBackKeyframeId: null, autoplay: false, loopPlayback: false, positionMethod: 'catmull-rom',
      rotationMethod: 'slerp', easing: 'ease-in-out', defaultSpeed: '30' },
    exportPath() { return this.record; },
    restorePath(data) { restored.push(data); this.record = structuredClone(data); },
  };
  const cameraPath = createCameraPathDomain({ cinematicCamera: path });
  const value = cameraPath.capture();
  assert.deepEqual(value, path.record, 'the value is the Camera Path\'s own state, nothing more');
  assert.notEqual(value, path.record, 'a value is a copy, never the live record');
  cameraPath.restore(value);
  assert.equal(restored.length, 0, 'what is shown is not restored again');
  const looping = { ...value, loopPlayback: true };
  cameraPath.restore(looping);
  assert.equal(restored.length, 1);
  assert.deepEqual(restored[0], looping, 'the Camera Path is handed exactly the value');
  assert.notEqual(restored[0], looping, 'and a copy of it, so the value stays as captured');
  assert.deepEqual(cameraPath.describe(value, looping), ['Camera path: loop on']);
  // A page without the Camera Path: no value, and none can be restored.
  const absent = createCameraPathDomain({ cinematicCamera: null });
  assert.equal(absent.capture(), null);
  absent.restore(null);
  assert.throws(() => absent.restore(value), /The Camera Path is not available on this page/);
});

test('analyses: results kept by reference, settings copied, restored only when they differ', async () => {
  const result = { kind: 'markers', version: 1, payload: { scores: Float32Array.of(1, 2) } };
  let docked = { openMode: 'markers', modes: { markers: { settings: { k: 5 }, result } } };
  const imported = [];
  const refs = {
    comparisonModule: {
      exportSessionState: () => docked,
      importSessionState: async state => { imported.push(state); docked = state; },
    },
    analysisWindowManager: { exportSessionWindows: () => [] },
  };
  const analysis = createAnalysisDomain({ analysis: async () => refs });
  const value = await analysis.capture();
  assert.equal(value.docked.modes.markers.result.payload.scores, result.payload.scores);
  assert.notEqual(value.docked.modes.markers.settings, docked.modes.markers.settings);
  await analysis.restore(value);
  assert.equal(imported.length, 0);
  await analysis.restore({ ...value, docked: { ...value.docked, modes: { markers: { settings: { k: 9 }, result: null } } } });
  assert.deepEqual(imported[0].modes.markers.settings, { k: 9 });
  const none = createAnalysisDomain({ analysis: async () => null });
  assert.deepEqual(await none.capture(), { windows: [], docked: null });
  await assert.rejects(none.restore(value), /could not load on this page/);
});

test('views and cameras: by position; a per-view value that does not fit the views is refused', () => {
  assert.throws(() => requireViewsFit({ views: [1, 2, 3] }, ['live'], 'cameras'), /for 3 views, and 1 is shown/);
  const views = createViewsDomain({ state: null, viewer: null, refreshUi: () => {} });
  const one = { layout: 'grid', focus: 0, liveHidden: false, camerasLinked: true, views: [{ embedding: { key: 'X_umap', columns: [0, 1] }, followsDefault: true, centroids: { points: false, labels: false } }] };
  const two = structuredClone(one);
  two.views.push({ embedding: { key: 'X_pca', columns: [0, 1, 2] }, followsDefault: false, centroids: { points: true, labels: false } });
  two.focus = 1;
  assert.deepEqual(views.describe(one, two), ['1 kept view (was 0)', 'View 2 focused']);
  const camera = createCameraDomain({ viewer: null, refreshUi: () => {} });
  const pose = { navigationMode: 'orbit', orbit: { radius: 3, targetRadius: 3, theta: 1, phi: 1, target: [0, 0, 0] }, freefly: { position: [0, 0, 3], yaw: 0, pitch: 0 } };
  assert.deepEqual(camera.describe({ views: [pose] }, { views: [{ ...pose, orbit: { ...pose.orbit, theta: 2 } }] }), ['camera moved']);
  assert.deepEqual(camera.describe({ views: [pose] }, { views: [{ ...pose, navigationMode: 'free' }] }), ['free-fly navigation']);
});

test('one map splits the control inventory: each control\'s value is held by one domain, and the controls it names exist', () => {
  // Another domain holds what these show; the inventory still lists them.
  for (const [id, type, domain] of [
    ['theme-select', 'select', 'layout'],
    ['toggle-centroid-points', 'checkbox', 'views'],
    ['toggle-centroid-labels', 'checkbox', 'views'],
  ]) {
    assert.match(INDEX_HTML, new RegExp(`id="${id}"`), `#${id} is still in the markup`);
    assert.equal(controlDomainOf(id, type), domain, `#${id} is held by ${domain}`);
  }
  assert.equal(controlDomainOf('accordion:visualization-section', 'details'), 'layout');
  assert.equal(controlDomainOf('point-size', 'range'), 'settings');
  assert.equal(controlDomainOf('a-control-added-tomorrow', 'checkbox'), 'settings', 'a new control is a setting with no edit');
  for (const domain of new Set(['theme-select', 'toggle-centroid-points', 'point-size'].map(id => controlDomainOf(id, 'checkbox')))) {
    assert.ok(DOMAIN_IDS.includes(domain), `${domain} is a state domain`);
  }
  assert.throws(() => createUiControlSerializer({ sidebar: { querySelectorAll: () => [] }, domains: ['camera'] }), /selected by state domains/);
});

test('the fingerprint is one digest of every domain and names the domain that differs', async () => {
  const values = Object.fromEntries(DOMAIN_IDS.map(id => [id, { id }]));
  const a = await fingerprintOf(values);
  const b = await fingerprintOf({ ...values, colors: { views: [[]] } });
  assert.match(a.digest, /^[0-9a-f]{64}$/);
  assert.notEqual(a.digest, b.digest);
  assert.deepEqual(differingDomains(a, b), ['colors']);
  assert.equal((await fingerprintOf(structuredClone(values))).digest, a.digest);
  await assert.rejects(fingerprintOf({ colors: {} }), /needs the "cells" domain's value/);
});

test('held category state is read back as it was held', () => {
  const field = {};
  holdPendingCategoryState(field, { visibility: [{ categoryName: true, visible: false }], colors: [] });
  assert.deepEqual(pendingCategoryState(field), { visibility: [{ categoryName: true, visible: false }], colors: [] });
  assert.deepEqual(pendingCategoryState({}), { visibility: [], colors: [] });
});

test('field overlays: a value that cannot be put back is refused whole, before anything changes', async () => {
  const { state, viewer } = stateOfSixCells();
  const overlays = createFieldOverlaysDomain({ state, viewer, refreshUi: () => {} });
  state.upsertUserDefinedCategoricalField({ key: 'annotation', categories: ['x', 'y'], codes: Uint8Array.of(0, 1, 1, 0, 255, 1) });
  state.upsertUserDefinedContinuousField({ key: 'pushed', values: Float32Array.of(1, 2, 3, 4, 5, Number.NaN), operation: { type: 'notebook-push' } });
  state.getRenameRegistry().setFieldRename('obs', 'score', 'Score');
  state.applyFieldOverlays();
  const shown = overlays.capture();
  const registry = state.getUserDefinedFieldsRegistry();
  const [annotationTemplate, pushedTemplate] = registry.getAllFields();
  const templateCodes = annotationTemplate.codes;
  const keys = () => state.obsData.fields.map(field => field.key);
  const keysBefore = keys();
  const renamesBefore = state.getRenameRegistry().toEntries();
  const deletionsBefore = state.getDeleteRegistry().toEntries();

  /** Each case changes something valid first (a rename, a deletion, the first field's name), then breaks the value. */
  const broken = [
    ['a code outside the categories', value => { value.userFields[0].codes.values[2] = 7; }, /outside the category inventory/],
    ['values that do not fit their cells', value => {
      value.userFields[1].values = { cells: Uint32Array.of(1, 3), values: Float32Array.of(1, 2, 3) };
    }, /one cell \(by original position\) per value/],
    ['a field listed twice', value => { value.userFields.push(structuredClone(value.userFields[0])); }, /listed twice/],
    ['an unknown kind', value => { value.userFields[1].kind = 'matrix'; }, /a category or a continuous field/],
    ['categories that are not a list', value => { value.userFields[0].categories = 'x,y'; }, /must list its categories/],
    ['a rename to an empty name', value => { value.renamedFields.push({ source: 'obs', key: 'cell_type', name: '' }); }, /non-empty/],
    ['a field deleted twice', value => { value.deletedFields.push({ ...value.deletedFields[0] }); }, /deleted twice/],
  ];
  for (const [what, breakIt, message] of broken) {
    const value = structuredClone(shown);
    value.renamedFields = [{ source: 'obs', key: 'cell_type', name: 'Types' }];
    value.deletedFields = [{ source: 'obs', key: 'score', purged: false }];
    value.userFields[0].key = 'annotation renamed';
    breakIt(value);
    await assert.rejects(overlays.restore(value), message, what);
    assert.ok(sameValue(overlays.capture(), shown), `${what}: the field changes are as they were`);
    assert.deepEqual(keys(), keysBefore, `${what}: the field list is as it was`);
    assert.deepEqual(state.getRenameRegistry().toEntries(), renamesBefore, `${what}: renames untouched`);
    assert.deepEqual(state.getDeleteRegistry().toEntries(), deletionsBefore, `${what}: deletions untouched`);
    assert.deepEqual(registry.getAllFields(), [annotationTemplate, pushedTemplate], `${what}: the registry holds the same templates`);
    assert.equal(annotationTemplate.key, 'annotation', `${what}: a template is not redefined`);
    assert.equal(annotationTemplate.codes, templateCodes, `${what}: its codes are the same array`);
  }

  // The same changes, valid, apply whole.
  const valid = structuredClone(shown);
  valid.renamedFields = [{ source: 'obs', key: 'cell_type', name: 'Types' }];
  valid.userFields[0].key = 'annotation renamed';
  await overlays.restore(valid);
  assert.ok(sameValue(overlays.capture(), valid));
  assert.equal(annotationTemplate.key, 'annotation renamed');
});

/** A page with no view-layout select, for the views domain outside a browser. */
async function withoutLayoutSelect(run) {
  const saved = { document: globalThis.document, HTMLSelectElement: globalThis.HTMLSelectElement };
  globalThis.document = { getElementById: () => null };
  globalThis.HTMLSelectElement = class {};
  try {
    await run();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
}

test('the views domain checks what it put back and names what did not come back', async () => {
  const flags = { points: false, labels: false };
  let locked = false;
  let honoursCentroids = true;
  let liveName = null;
  const viewer = {
    getSnapshotViews: () => [],
    getViewLayout: () => ({ mode: 'grid', activeId: 'live', liveViewHidden: false }),
    getCentroidFlags: () => ({ ...flags }),
    getViewName: () => liveName,
    setViewName: (id, name) => { liveName = name; },
    setShowCentroidPoints: on => { if (honoursCentroids) flags.points = on; },
    setShowCentroidLabels: on => { if (honoursCentroids) flags.labels = on; },
    getCamerasLocked: () => locked,
    setCamerasLocked: on => { locked = on; },
    setLiveViewHidden: () => {},
    setViewLayout: () => {},
  };
  const state = { getActiveViewId: () => 'live', setActiveView: () => {}, viewContexts: new Map(), dimensionManager: null };
  const views = createViewsDomain({ state, viewer, refreshUi: () => {} });
  const shown = views.capture();
  assert.deepEqual(shown, {
    layout: 'grid', focus: 0, liveHidden: false, camerasLinked: false,
    views: [{ embedding: null, followsDefault: true, centroids: { points: false, labels: false } }],
  });
  const wanted = structuredClone(shown);
  wanted.views[0].centroids.points = true;
  await withoutLayoutSelect(async () => {
    await views.restore(wanted);
    assert.deepEqual(views.capture(), wanted, 'what the viewer takes comes back');
    honoursCentroids = false;
    await assert.rejects(views.restore(shown), {
      message: 'The views could not be put back as they were. Not back: View 1: centroids hidden.',
    });
    // A value whose focus is not among its views is refused before anything changes.
    honoursCentroids = true;
    await assert.rejects(views.restore({ ...shown, focus: 3, camerasLinked: true }), /focused view to restore, 3, is not among the 1 view/);
    assert.equal(locked, false, 'the camera link is as it was');

    // A view's name (`view.rename`): only a named view's entry has the key,
    // so an unnamed value is the value it was before views had names.
    await views.restore(shown);
    assert.equal(Object.hasOwn(views.capture().views[0], 'name'), false, 'an unnamed view has no name key');
    const named = structuredClone(shown);
    named.views[0].name = 'Early';
    await views.restore(named);
    assert.equal(liveName, 'Early', 'the name is put back on its view');
    assert.deepEqual(views.capture(), named);
    assert.deepEqual(views.describe(shown, named), ['View 1 named "Early"']);
    assert.deepEqual(views.describe(named, shown), ['View 1 no longer named "Early"']);
    // Other lines name the view with its name at the later value.
    assert.deepEqual(views.describe(shown, { ...named, views: [{ ...named.views[0], centroids: { points: true, labels: false } }] }),
      ['View 1 "Early": centroids shown', 'View 1 named "Early"']);
    await views.restore(shown);
    assert.equal(liveName, null, 'Undo of the name takes it away');
    await assert.rejects(views.restore({ ...shown, views: [{ ...shown.views[0], name: ' two\nlines ' }] }), /a name, when it has one, as one line of text/);
    assert.equal(liveName, null, 'a bad name changes nothing');
  });
});

test('the camera domain checks every camera first and each pose it put back after', () => {
  const pose = theta => {
    const camera = { navigationMode: 'orbit', ...createDefaultCameraPose() };
    camera.orbit = { ...camera.orbit, theta, targetRadius: camera.orbit.radius };
    return camera;
  };
  const cameras = new Map([['live', pose(1)], ['snap_1', pose(1)]]);
  let refuses = null;
  const viewer = {
    getSnapshotViews: () => [{ id: 'snap_1' }],
    getLiveViewHidden: () => false,
    getFocusedViewId: () => 'live',
    getViewCameraState: id => structuredClone(cameras.get(id)),
    setViewCameraState: (id, camera) => { if (id !== refuses) cameras.set(id, structuredClone(camera)); },
    setNavigationMode: () => {},
    setCameraState: camera => { if (refuses !== 'live') cameras.set('live', structuredClone(camera)); },
  };
  const domain = createCameraDomain({ viewer, refreshUi: () => {} });
  domain.restore({ views: [pose(2), pose(3)] });
  assert.deepEqual(domain.capture(), { views: [pose(2), pose(3)] });
  refuses = 'snap_1';
  assert.throws(() => domain.restore({ views: [pose(2), pose(4)] }), {
    message: 'The camera of View 2 could not be put back where it was.',
  });
  // A camera that is not one is refused before any camera moves.
  refuses = null;
  assert.throws(() => domain.restore({ views: [pose(5), { navigationMode: 'orbit' }] }), /Camera to restore for View 2/);
  assert.deepEqual(domain.capture().views[0], pose(2), 'View 1 did not move');
});

test('every comparison line names a view as the Compare views list numbers it, the hidden live view by what it is', () => {
  const pose = { navigationMode: 'orbit', orbit: { radius: 3, targetRadius: 3, theta: 1, phi: 1, target: [0, 0, 0] }, freefly: { position: [0, 0, 3], yaw: 0, pitch: 0 } };
  const moved = { ...pose, orbit: { ...pose.orbit, theta: 2 } };
  const camera = createCameraDomain({ viewer: null, refreshUi: () => {} });
  assert.deepEqual(camera.describe({ views: [pose, pose, pose] }, { views: [moved, pose, moved] }), ['View 1: camera moved', 'View 3: camera moved']);
  assert.deepEqual(
    camera.describe({ views: [pose, pose, pose] }, { views: [moved, pose, moved] }, { liveHidden: true }),
    ['the hidden live view: camera moved', 'View 2: camera moved'],
  );
  const views = createViewsDomain({ state: null, viewer: null, refreshUi: () => {} });
  const entry = (key, followsDefault = true) => ({ embedding: { key, columns: [0, 1] }, followsDefault, centroids: { points: false, labels: false } });
  const three = { layout: 'grid', focus: 0, liveHidden: false, camerasLinked: false, views: [entry('X_umap'), entry('X_umap'), entry('X_umap')] };
  const hidden = { ...structuredClone(three), liveHidden: true, focus: 1, views: [entry('X_umap'), entry('X_pca', false), entry('X_umap')] };
  assert.deepEqual(views.describe(three, hidden), [
    'View 1 focused', 'The live view removed (the kept views numbered from View 1)', 'View 1 shows X_pca 2D', 'View 1 keeps its own embedding',
  ]);
  assert.deepEqual(views.describe(hidden, three), [
    'View 1 focused', 'The live view shown again as View 1', 'View 2 shows X_umap 2D', 'View 2 follows its dimension\'s default embedding',
  ]);
  const { state, viewer } = stateOfSixCells();
  const filters = createFiltersDomain({ state, viewer, refreshUi: () => {} });
  const field = { source: 'obs', key: 'cell_type' };
  const hid = [[], [{ field, hidden: ['B'] }]];
  assert.deepEqual(filters.describe({ views: [[], []] }, { views: hid }), ['View 2, cell_type: hid B']);
  assert.deepEqual(filters.describe({ views: [[], []] }, { views: hid }, { liveHidden: true }), ['View 1, cell_type: hid B']);
});

test('a loaded state\'s categories that no open cell holds are counted once per field over every view', () => {
  const { state } = stateOfSixCells();
  const [cellType] = state.obsData.fields;
  holdPendingCategoryState(cellType, {
    visibility: [{ categoryName: 'gamma', visible: false }, { categoryName: 'delta', visible: false }],
    colors: [{ categoryName: 'gamma', color: [1, 0, 0] }],
  });
  const kept = { obsData: { fields: [{ key: 'cell_type' }, { key: 'batch' }] }, varData: { fields: [] } };
  holdPendingCategoryState(kept.obsData.fields[0], { visibility: [{ categoryName: 'epsilon', visible: false }], colors: [] });
  holdPendingCategoryState(kept.obsData.fields[1], { visibility: [], colors: [{ categoryName: true, color: [0, 0, 1] }] });
  state.viewContexts.set('snap_1', kept);
  assert.deepEqual(heldCategoriesOf(state), [
    { source: 'obs', key: 'cell_type', labels: ['gamma', 'delta', 'epsilon'] },
    { source: 'obs', key: 'batch', labels: [true] },
  ]);
  assert.equal(heldCategoriesNotice('cell_type', 3, 'Session file'),
    '3 categories of "cell_type" in this session file aren\'t among the open cells; their settings apply when those cells open.');
  assert.equal(heldCategoriesNotice('batch', 1, 'Starting view'),
    '1 category of "batch" in this starting view isn\'t among the open cells; its settings apply when those cells open.');
});

test('fields loaded together are all read when it resolves: one released while another was read is read again', async () => {
  const fields = [
    { key: 'first', kind: 'continuous', loaded: false },
    { key: 'second', kind: 'continuous', loaded: false },
  ];
  const reads = [];
  let hideOnce = true;
  const state = {
    async ensureFieldLoaded(index) {
      reads.push(fields[index].key);
      await null;
      fields[index].loaded = true;
      // The page is hidden while the second is still read: the first is released (`field/residency.js`).
      if (index === 1 && hideOnce) {
        hideOnce = false;
        fields[0].loaded = false;
      }
    },
  };
  const refs = fields.map(field => ({ source: 'obs', key: field.key }));
  await loadFields(state, refs, fields.map((field, index) => ({ field, index })));
  assert.deepEqual(fields.map(field => field.loaded), [true, true]);
  assert.deepEqual(reads, ['first', 'second', 'first']);
});
