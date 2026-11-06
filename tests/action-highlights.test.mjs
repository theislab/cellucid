/**
 * The highlight actions (`app/actions/definitions/highlights.js`) on a real
 * DataState opened on a subsample: pages and groups named by their names,
 * cells by original position, a page of the colour a highlight asks for (no
 * page is ever recoloured by a highlight), unique names, and a sentence for
 * every name that does not resolve. Implementations:
 * `app/ui/modules/highlight/highlight-actions.js`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createDataState } from '../assets/js/app/state/core/data-state.js';
import { createDimensionManager } from '../assets/js/data/dimension-manager.js';
import { createCellIdentity } from '../assets/js/data/cell-identity.js';
import { OPEN_ORDER_PRIORITY } from '../assets/js/data/cell-priority.js';
import { createActionDispatcher, ActionRefused } from '../assets/js/app/actions/dispatcher.js';
import { getActionCatalog } from '../assets/js/app/actions/index.js';
import { catalogDocument } from '../assets/js/app/actions/catalog.js';
import { highlightActions } from '../assets/js/app/actions/definitions/highlights.js';
import { provideHighlightActions } from '../assets/js/app/ui/modules/highlight/highlight-actions.js';

/** 40 cells; the subsample holds the even ones (original 2i is open cell i). */
const N_OBS = 40;
const KEPT = Uint32Array.from({ length: N_OBS / 2 }, (_, i) => 2 * i);
const N = KEPT.length;
const CLUSTER = Uint8Array.from({ length: N }, (_, i) => i % 4);
const SCORE = Float32Array.from({ length: N }, (_, i) => i / 2);
const GENE = Float32Array.from({ length: N }, (_, i) => (i % 5 === 0 ? 0 : i));

function quietViewer() {
  return new Proxy({
    isDisposed: () => false,
    hasVectorFieldForLayout: () => false,
    hasSnapshots: () => false,
    getViewLayout: () => ({ mode: 'grid', activeId: 'live', liveViewHidden: false }),
  }, {
    get(target, property) {
      return Object.hasOwn(target, property) ? target[property] : () => {};
    },
  });
}

async function scene() {
  const manager = createDimensionManager({
    embeddingsMetadata: {
      default_dimension: 2,
      defaults: { '2d': 'X_umap' },
      items: { X_umap: { label: 'X_umap', dimension: 2, path: 'obsm/0/0-1', source: { key: 'X_umap', columns: [0, 1] } } },
    },
  });
  manager.loadLayout = async () => {
    manager.loadedTransformCache.set('X_umap', { center: [0, 0, 0], scale: 1 });
    return Float32Array.from({ length: N * 2 }, (_, i) => (i % 7) / 7);
  };
  manager.publishCellCount(N);
  await manager.getPositions('X_umap');
  const state = createDataState({ viewer: quietViewer(), labelLayer: null });
  state.setDimensionManager(manager);
  state.initVarData({ fields: [{ key: 'GENE1', kind: 'continuous', path: 'var/0', values: GENE.slice() }] });
  manager.setViewLayout('live', 'X_umap');
  state.initScene(manager.getResidentPositions('X_umap'), {
    fields: [
      { key: 'cluster', kind: 'category', categories: ['a', 'b', 'c', 'd'], codes: CLUSTER.slice() },
      { key: 'score', kind: 'continuous', values: SCORE.slice() },
    ],
  });
  state.setCellIdentity(createCellIdentity({ nObs: N_OBS, kept: KEPT }));
  state.setCellPriority(OPEN_ORDER_PRIORITY);
  await state.ensureFieldLoaded(0);
  await state.ensureFieldLoaded(1);
  await state.ensureVarFieldLoaded(0);
  state.ensureHighlightPage();
  const actions = createActionDispatcher({ catalog: getActionCatalog() });
  const dispatched = [];
  actions.subscribe(event => {
    if (event.kind === 'done') dispatched.push({ type: event.type, params: event.params, outcome: event.outcome });
  });
  provideHighlightActions({ state, actions });
  const act = async (type, params) => (await actions.dispatch(type, params)).outcome;
  return { state, actions, act, dispatched };
}

const pages = state => state.getHighlightPages().map(page => page.name);
const shown = state => state.getActivePage().name;
const groupsOf = (state, name) => state.getHighlightPages().find(page => page.name === name).highlightedGroups;
/** The original positions of a group's cells. */
const originals = (state, group) => [...state.cellIdentity.toOriginal(group.cellIndices)].sort((a, b) => a - b);

test('definitions: every highlight action is in the catalogue with a sentence and a line of pseudocode', () => {
  const doc = catalogDocument(getActionCatalog());
  for (const definition of highlightActions) {
    const entry = doc.actions.find(action => action.type === definition.type);
    assert.ok(entry, definition.type);
    assert.deepEqual(entry.touches, ['highlights']);
    assert.equal(entry.effect, 'state');
    assert.equal(entry.confirm, null, 'the history undoes every highlight change');
    assert.equal(typeof definition.describe(entry.example, null), 'string');
    assert.match(definition.code(entry.example), /^[a-z_]+\(.*\)$/);
  }
  assert.equal(
    highlightActions.find(d => d.type === 'highlight.cells').describe({ cells: [1, 2] }, { cells: 2, group: 'T', page: 'Page 1' }),
    'Highlighted 2 cells as "T" on page "Page 1"'
  );
  assert.equal(
    highlightActions.find(d => d.type === 'highlight.page.recolor').coalesce({ page: 'P', color: '#000000' }),
    'P',
    'a colour drag is one step per page'
  );
});

test('pages: made with unique names, shown, renamed, recoloured, deleted; refusals name the pages', async () => {
  const { state, act } = await scene();
  assert.deepEqual(pages(state), ['Page 1']);
  assert.deepEqual(await act('highlight.page.create', {}), { page: 'Page 2' });
  assert.equal(shown(state), 'Page 2');
  await act('highlight.page.create', { name: 'T cells', color: '#00aa00' });
  assert.deepEqual(state.getHighlightPages().map(p => [p.name, p.color]).at(-1), ['T cells', '#00aa00']);
  await act('highlight.page.delete', { page: 'Page 2' });
  // "Page 3" is free again? No: three pages are counted from 3, and "Page 3" is free.
  assert.deepEqual(await act('highlight.page.create', {}), { page: 'Page 3' });
  assert.deepEqual(await act('highlight.page.create', {}), { page: 'Page 4' });

  await assert.rejects(act('highlight.page.create', { name: 'T cells' }), /is called "T cells" already/);
  await assert.rejects(act('highlight.page.rename', { page: 'Page 3', name: 'T cells' }), /is called "T cells" already/);
  await assert.rejects(act('highlight.page.switch', { page: 'B cells' }), /There is no highlight page "B cells"; the pages are "Page 1", "T cells", "Page 3" and "Page 4"\.$/);

  await act('highlight.page.switch', { page: 'Page 1' });
  assert.equal(shown(state), 'Page 1');
  await act('highlight.page.rename', { page: 'Page 3', name: 'Monocytes' });
  assert.deepEqual(pages(state), ['Page 1', 'T cells', 'Monocytes', 'Page 4']);
  assert.equal(await act('highlight.page.rename', { page: 'Monocytes', name: 'Monocytes' }), null, 'no change, no step');
  await act('highlight.page.recolor', { page: 'Monocytes', color: '#123456' });
  assert.equal(state.getHighlightPages()[2].color, '#123456');

  for (const name of ['T cells', 'Monocytes', 'Page 4']) await act('highlight.page.delete', { page: name });
  await assert.rejects(act('highlight.page.delete', { page: 'Page 1' }), /only highlight page and cannot be deleted; clear it instead/);
});

test('cells: original positions in, exactly the open ones highlighted, by identity; the step keeps the original positions', async () => {
  const { state, act, dispatched } = await scene();
  // Original 4, 2, 7 (not open), 2 again, 38: open cells 2, 1, 19.
  const outcome = await act('highlight.cells', { cells: [4, 2, 7, 2, 38], label: 'Picked', tool: 'lasso' });
  assert.deepEqual(outcome, { page: 'Page 1', group: 'Picked', cells: 3, notOpen: 1 });
  const [group] = groupsOf(state, 'Page 1');
  assert.equal(group.type, 'lasso');
  assert.deepEqual([...group.cellIndices], [1, 2, 19]);
  assert.deepEqual(originals(state, group), [2, 4, 38]);
  assert.deepEqual(dispatched.at(-1).params.cells, [4, 2, 7, 2, 38], 'the step names what was asked, by original position');
  assert.deepEqual(state._highlightedCellIndices.length, 3);

  // A Uint32Array (a binary frame) is the same.
  const again = await act('highlight.cells', { cells: Uint32Array.of(2, 4, 38), label: 'Picked' });
  assert.equal(again.group, 'Picked (2)', 'a label on the page already gets a number');
  assert.equal(again.cells, 3);
  assert.equal(groupsOf(state, 'Page 1')[1].type, 'annotation', 'the default tool');

  await assert.rejects(act('highlight.cells', { cells: [1, 3, 5] }), /None of the 3 cells to highlight is open/);
  await assert.rejects(act('highlight.cells', { cells: [40] }), /outside the 40 cells of the dataset\. Name cells by their 0-based row of obs\./);
  await assert.rejects(act('highlight.cells', { cells: [] }), /needs at least 1 item/);
  assert.equal(groupsOf(state, 'Page 1').length, 2, 'a refusal changes nothing');
});

test('a highlight colour picks a page of that colour and never recolours one', async () => {
  const { state, act } = await scene();
  const firstColor = state.getActivePage().color;
  await act('highlight.cells', { cells: [0, 2], color: '#ff0000' });
  assert.deepEqual(state.getHighlightPages().map(p => [p.name, p.color]), [['Page 1', firstColor], ['Page 2', '#ff0000']]);
  assert.equal(shown(state), 'Page 2');
  await act('highlight.page.switch', { page: 'Page 1' });
  // The same colour again: the page that has it, shown.
  await act('highlight.cells', { cells: [4], color: '#FF0000' });
  assert.equal(shown(state), 'Page 2');
  assert.equal(groupsOf(state, 'Page 2').length, 2);
  // A named page: made with the colour, or refused when it has another.
  await act('highlight.cells', { cells: [6], page: 'Notebook', color: '#0000ff' });
  assert.deepEqual(state.getHighlightPages().at(-1), { ...state.getHighlightPages().at(-1), name: 'Notebook', color: '#0000ff' });
  await assert.rejects(
    act('highlight.cells', { cells: [8], page: 'Notebook', color: '#00ff00' }),
    /Highlight page "Notebook" is #0000ff, not #00ff00; name another page, or leave the colour out/
  );
  assert.deepEqual(state.getHighlightPages().map(p => p.color), [firstColor, '#ff0000', '#0000ff']);
});

test('category and range: cells of the selected view, named by field and label', async () => {
  const { state, act } = await scene();
  const outcome = await act('highlight.category', { field: { source: 'obs', key: 'cluster' }, category: 'b' });
  assert.deepEqual(outcome, { page: 'Page 1', group: 'cluster: b', cells: 5 });
  const [category] = groupsOf(state, 'Page 1');
  assert.deepEqual([...category.cellIndices], [1, 5, 9, 13, 17]);
  assert.equal(
    await act('highlight.category', { field: { source: 'obs', key: 'cluster' }, category: 'b' }),
    null,
    'asked again with the same cells shown, nothing changes'
  );
  await assert.rejects(
    act('highlight.category', { field: { source: 'obs', key: 'cluster' }, category: 'z' }),
    /There is no category "z" in "cluster"; the categories are "a", "b", "c" and "d"\.$/
  );
  await assert.rejects(
    act('highlight.category', { field: { source: 'obs', key: 'leiden' }, category: 'b' }),
    /There is no field "leiden"; the fields are "cluster" and "score"\./
  );
  await assert.rejects(
    act('highlight.category', { field: { source: 'obs', key: 'score' }, category: 'b' }),
    /score is not categorical; highlight a range of its values instead/
  );
  await assert.rejects(
    act('highlight.category', { field: { source: 'var', key: 'GENE1' }, category: 'b' }),
    /A gene has no categories/
  );

  const range = await act('highlight.range', { field: { source: 'obs', key: 'score' }, min: 2, max: 4 });
  assert.equal(range.cells, 5);
  assert.deepEqual([...groupsOf(state, 'Page 1')[1].cellIndices], [4, 5, 6, 7, 8]);
  const gene = await act('highlight.range', { field: { source: 'var', key: 'GENE1' }, min: 18, max: 19 });
  assert.deepEqual([...groupsOf(state, 'Page 1')[2].cellIndices], [18, 19]);
  assert.equal(gene.cells, 2);
  await assert.rejects(act('highlight.range', { field: { source: 'obs', key: 'score' }, min: 4, max: 2 }), /from its smaller value to its larger/);
  await assert.rejects(act('highlight.range', { field: { source: 'obs', key: 'score' }, min: 100, max: 200 }), /No cell visible in the selected view has score from 100 to 200/);
  await assert.rejects(act('highlight.range', { field: { source: 'var', key: 'NOPE' }, min: 0, max: 1 }), /"NOPE" is not a gene in this dataset\. genes\.search finds a gene by part of its name\./);
});

test('asked again (Run again of a stale step): a category or range group takes the cells the view shows now, in its place', async () => {
  const { state, act } = await scene();
  await act('highlight.category', { field: { source: 'obs', key: 'cluster' }, category: 'b' });
  await act('highlight.range', { field: { source: 'obs', key: 'score' }, min: 2, max: 4 });
  const [category, range] = groupsOf(state, 'Page 1');
  // The selected view hides cells 5 and 6 (a filter, as the view shows them).
  state.categoryTransparency[5] = 0;
  state.categoryTransparency[6] = 0;

  assert.deepEqual(
    await act('highlight.category', { field: { source: 'obs', key: 'cluster' }, category: 'b' }),
    { page: 'Page 1', group: 'cluster: b', cells: 4, updated: true }
  );
  assert.deepEqual(
    await act('highlight.range', { field: { source: 'obs', key: 'score' }, min: 2, max: 4 }),
    { page: 'Page 1', group: range.label, cells: 3, updated: true }
  );
  const [nextCategory, nextRange] = groupsOf(state, 'Page 1');
  assert.equal(groupsOf(state, 'Page 1').length, 2, 'no second group');
  assert.deepEqual([nextCategory.id, nextRange.id], [category.id, range.id], 'each in its place, with its id');
  assert.deepEqual([...nextCategory.cellIndices], [1, 9, 13, 17]);
  assert.deepEqual([...nextRange.cellIndices], [4, 7, 8]);
  assert.deepEqual([...category.cellIndices], [1, 5, 9, 13, 17], 'a value captured before keeps its cells');
  assert.equal(
    highlightActions.find(d => d.type === 'highlight.category').describe({ field: { source: 'obs', key: 'cluster' }, category: 'b' }, { cells: 4, updated: true }),
    'Updated the cells of "b" of cluster (4 cells)'
  );

  // No cell of the group visible now: refused, the group keeps its cells.
  for (const i of [1, 9, 13, 17]) state.categoryTransparency[i] = 0;
  await assert.rejects(
    act('highlight.category', { field: { source: 'obs', key: 'cluster' }, category: 'b' }),
    /No cell of "cluster: b" is visible in the selected view; "cluster: b" on page "Page 1" keeps its 4 cells\./
  );
  assert.deepEqual([...groupsOf(state, 'Page 1')[0].cellIndices], [1, 9, 13, 17]);
});

test('groups: shown or hidden, removed, on the page shown or a page named; clear a page, clear every page', async () => {
  const { state, act } = await scene();
  await act('highlight.cells', { cells: [0, 2], label: 'A' });
  await act('highlight.page.create', { name: 'Other' });
  await act('highlight.cells', { cells: [4], label: 'B' });
  await act('highlight.cells', { cells: [6], label: 'C' });
  assert.equal(shown(state), 'Other');

  // A group of a page not shown: changed in place, the page shown stays.
  await act('highlight.group.toggle', { group: 'A', enabled: false, page: 'Page 1' });
  assert.equal(groupsOf(state, 'Page 1')[0].enabled, false);
  assert.equal(shown(state), 'Other');
  assert.equal(state.getHighlightedCellCountForPage(state.getHighlightPages()[0].id), 0);
  assert.equal(await act('highlight.group.toggle', { group: 'A', enabled: false, page: 'Page 1' }), null, 'no change, no step');

  await act('highlight.group.toggle', { group: 'B', enabled: false });
  assert.deepEqual([...state._highlightedCellIndices], [3], 'the page shown paints its enabled groups only');
  await act('highlight.group.remove', { group: 'C' });
  assert.deepEqual(groupsOf(state, 'Other').map(g => g.label), ['B']);
  await assert.rejects(act('highlight.group.remove', { group: 'C' }), /Page "Other" has no highlight "C"; its highlights are "B"/);

  assert.deepEqual(await act('highlight.page.clear', { page: 'Page 1' }), { page: 'Page 1', groups: 1 });
  assert.equal(groupsOf(state, 'Page 1').length, 0);
  assert.equal(await act('highlight.page.clear', { page: 'Page 1' }), null, 'nothing to clear, no step');
  await act('highlight.cells', { cells: [8], label: 'D', page: 'Page 1' });
  assert.deepEqual(await act('highlight.clear-all', {}), { groups: 2 });
  assert.deepEqual(state.getHighlightPages().map(p => p.highlightedGroups.length), [0, 0]);
  assert.deepEqual(pages(state), ['Page 1', 'Other'], 'the pages stay');
});

test('combine: a page of the cells in both or either, shown, with a unique name', async () => {
  const { state, act } = await scene();
  await act('highlight.page.rename', { page: 'Page 1', name: 'A' });
  await act('highlight.cells', { cells: [0, 2, 4] });
  await act('highlight.page.create', { name: 'B' });
  await act('highlight.cells', { cells: [4, 6] });
  assert.deepEqual(await act('highlight.page.combine', { pages: ['A', 'B'], operation: 'intersection' }), { page: 'A ∩ B', cells: 1 });
  assert.equal(shown(state), 'A ∩ B');
  assert.deepEqual(originals(state, groupsOf(state, 'A ∩ B')[0]), [4]);
  assert.deepEqual(await act('highlight.page.combine', { pages: ['A', 'B'], operation: 'intersection' }), { page: 'A ∩ B (2)', cells: 1 });
  assert.deepEqual(await act('highlight.page.combine', { pages: ['A', 'B'], operation: 'union', name: 'Both' }), { page: 'Both', cells: 4 });
  assert.deepEqual(originals(state, groupsOf(state, 'Both')[0]), [0, 2, 4, 6]);
  await assert.rejects(act('highlight.page.combine', { pages: ['A', 'B'], operation: 'union', name: 'Both' }), /is called "Both" already/);
  await assert.rejects(act('highlight.page.combine', { pages: ['A', 'A'], operation: 'union' }), /must not repeat an item/);
});

test('every refusal is an ActionRefused sentence, never a TypeError from inside', async () => {
  const { act } = await scene();
  for (const [type, params] of [
    ['highlight.page.switch', { page: 'X' }],
    ['highlight.page.rename', { page: 'X', name: 'Y' }],
    ['highlight.page.recolor', { page: 'X', color: '#000000' }],
    ['highlight.page.delete', { page: 'X' }],
    ['highlight.page.clear', { page: 'X' }],
    ['highlight.group.toggle', { group: 'X', enabled: true }],
    ['highlight.group.remove', { group: 'X' }],
  ]) {
    await assert.rejects(act(type, params), error => error instanceof ActionRefused && /\.$/.test(error.message), type);
  }
});
