/**
 * Staleness follows the inputs that actually changed, each named with its own
 * cause: a test must not read "stale since step 4 ("Showed
 * UMAP · 2D in View 1"): Filters changed … Hidden cells changed … Views
 * changed" when step 4 only kept a view (every reason citing the first change
 * of any input: keeping a view changes the per-view domains' values
 * (`filters`, `visibility`, `views` gain an entry) though no cell the test
 * used changed). A per-view input is compared at the view the step acted
 * in (its owner's `readPart`), and each reason names its own input's step.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createActionCatalog, defineAction } from '../assets/js/app/actions/catalog.js';
import { createActionDispatcher } from '../assets/js/app/actions/dispatcher.js';
import { createDomainRegistry } from '../assets/js/app/actions/domains.js';
import { historyActions } from '../assets/js/app/actions/definitions/history.js';
import { createHistory } from '../assets/js/app/history/history.js';
import { staleReasons } from '../assets/js/app/history/provenance.js';
import { viewReadPart } from '../assets/js/app/state/domains/view-list.js';
import { createFiltersDomain } from '../assets/js/app/state/domains/filters.js';
import { createVisibilityDomain } from '../assets/js/app/state/domains/visibility.js';
import { createActiveFieldDomain } from '../assets/js/app/state/domains/active-field.js';
import { createViewsDomain } from '../assets/js/app/state/domains/views.js';
import { createColorsDomain } from '../assets/js/app/state/domains/colors.js';
import { createCameraDomain } from '../assets/js/app/state/domains/camera.js';

const object = (required, properties) => ({ type: 'object', additionalProperties: false, required, properties });
const INT = object(['v'], { v: { type: 'integer' } });
const VIEW = object(['view', 'v'], { view: { type: 'integer' }, v: { type: 'integer' } });

async function page() {
  // Per-view values shaped as the real ones: one entry per view, live first.
  const state = {
    views: { layout: 'grid', focus: 0, views: [{ embedding: { key: 'X_umap', columns: [0, 1] } }] },
    filters: { views: [[]] },
    visibility: { views: [Uint32Array.of()] },
    highlights: 0,
    test: 0,
  };
  const perView = id => ({
    capture: () => structuredClone(state[id]),
    restore: value => { state[id] = structuredClone(value); },
    readPart: viewReadPart,
  });
  const domains = createDomainRegistry();
  domains.provide('views', perView('views'));
  domains.provide('filters', perView('filters'));
  domains.provide('visibility', perView('visibility'));
  domains.provide('highlights', { capture: () => state.highlights, restore: value => { state.highlights = value; } });
  domains.provide('analysis', { capture: () => state.test, restore: value => { state.test = value; } });
  for (const id of domains.missing()) domains.provide(id, { capture: () => null, restore: () => {} });
  const defs = [
    // As a differential test: it reads the cells the view in focus shows and the highlights.
    defineAction({ type: 'test.run', title: 't', summary: 'x', group: 'T', params: object([], {}), touches: ['analysis'], reads: ['filters', 'visibility', 'views', 'highlights'], effect: 'state', describe: () => 'Ran the test', code: () => 't()' }),
    defineAction({ type: 'view.keep', title: 'k', summary: 'x', group: 'T', params: object([], {}), touches: ['views', 'filters', 'visibility'], reads: [], effect: 'view', describe: () => 'Kept a view', code: () => 'k()' }),
    defineAction({ type: 'view.focus', title: 'f', summary: 'x', group: 'T', params: INT, touches: ['views'], reads: [], effect: 'view', describe: p => `Focused view ${p.v}`, code: () => 'f()' }),
    defineAction({ type: 'filter.hide', title: 'h', summary: 'x', group: 'T', params: VIEW, touches: ['filters'], reads: [], effect: 'state', describe: p => `Hid ${p.v}`, code: () => 'h()' }),
    defineAction({ type: 'cells.hide', title: 'c', summary: 'x', group: 'T', params: VIEW, touches: ['visibility'], reads: [], effect: 'state', describe: p => `Hid cell ${p.v}`, code: () => 'c()' }),
    defineAction({ type: 'page.set', title: 'p', summary: 'x', group: 'T', params: INT, touches: ['highlights'], reads: [], effect: 'state', describe: p => `Highlighted ${p.v}`, code: () => 'p()' }),
  ];
  const dispatcher = createActionDispatcher({ catalog: createActionCatalog([...defs, ...historyActions]) });
  dispatcher.provide('test.run', () => { state.test += 1; });
  dispatcher.provide('view.keep', () => {
    // Keep view: a new view copies the live one's state, and every per-view value gains its entry.
    state.views = { ...state.views, views: [...state.views.views, { ...state.views.views[0] }] };
    state.filters = { views: [...state.filters.views, structuredClone(state.filters.views[0])] };
    state.visibility = { views: [...state.visibility.views, Uint32Array.from(state.visibility.views[0])] };
  });
  dispatcher.provide('view.focus', ({ v }) => { state.views = { ...state.views, focus: v }; });
  dispatcher.provide('filter.hide', ({ view, v }) => {
    state.filters = { views: state.filters.views.map((list, i) => (i === view ? [...list, { field: { source: 'obs', key: 'cell_type' }, hidden: [String(v)] }] : list)) };
  });
  dispatcher.provide('cells.hide', ({ view, v }) => {
    state.visibility = { views: state.visibility.views.map((cells, i) => (i === view ? Uint32Array.from([...cells, v]) : cells)) };
  });
  dispatcher.provide('page.set', ({ v }) => { state.highlights = v; });
  let n = 0;
  const history = createHistory({
    dispatcher, domains, dataset: { id: 'd', name: 'D', cellOrder: null },
    newTrackerId: () => `t-00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  });
  await history.startTracker();
  const step = async (type, params = {}) => (await dispatcher.dispatch(type, params)).step;
  const stale = async () => (await dispatcher.dispatch('history.stale', {})).outcome.stale;
  return { history, step, stale, dispatcher };
}

test('keeping a view, or changing another view, makes no result stale: no cell it used changed', async () => {
  const { step, stale } = await page();
  await step('test.run');
  await step('view.keep');
  assert.deepEqual(await stale(), [], 'a view kept');
  await step('filter.hide', { view: 1, v: 3 });
  await step('cells.hide', { view: 1, v: 7 });
  assert.deepEqual(await stale(), [], 'another view\'s filters and hidden cells');
  await step('view.focus', { v: 1 });
  assert.deepEqual(await stale(), [], 'the focus is the name context, never an input');
});

test('a result is stale when the view it ran in changes, each input with the step that changed it', async () => {
  const { step, stale } = await page();
  const ran = await step('test.run');
  await step('view.keep');
  const hid = await step('filter.hide', { view: 0, v: 2 });
  const page2 = await step('page.set', { v: 5 });
  const cell = await step('cells.hide', { view: 0, v: 9 });
  const found = await stale();
  assert.equal(found.length, 1);
  assert.equal(found[0].step, ran.id);
  assert.equal(found[0].cause.step, hid.id, 'stale since the first of them');
  assert.deepEqual(found[0].reasons, [
    // Two views open: each step names the view it changed.
    `Filters changed at step ${hid.id.slice(1)} ("Hid 2 in View 1").`,
    `Hidden cells changed at step ${cell.id.slice(1)} ("Hid cell 9 in View 1").`,
    `Highlights changed at step ${page2.id.slice(1)} ("Highlighted 5").`,
  ].sort((a, b) => ['Filters', 'Hidden', 'Highlights'].indexOf(a.split(' ')[0]) - ['Filters', 'Hidden', 'Highlights'].indexOf(b.split(' ')[0])));
});

test('a result run in a kept view follows that view, not the live one', async () => {
  const { step, stale } = await page();
  await step('view.keep');
  await step('view.focus', { v: 1 });
  const ran = await step('test.run');
  await step('view.focus', { v: 0 });
  await step('filter.hide', { view: 0, v: 4 });
  assert.deepEqual(await stale(), [], 'the live view changed, not the one it ran in');
  await step('filter.hide', { view: 1, v: 4 });
  assert.deepEqual((await stale()).map(entry => entry.step), [ran.id]);
});

test('every reason names its own cause; a deleted cause is said as such', () => {
  const entry = {
    inputs: ['filters', 'history', 'highlights'],
    causes: { filters: { id: 's4', label: 'Hid Alpha' }, history: null, highlights: null },
  };
  assert.deepEqual(staleReasons(entry), [
    'Filters changed at step 4 ("Hid Alpha").',
    'The branch it shows has changed since.',
    'Highlights changed since (the step that changed it is no longer in the history).',
  ]);
});

test('the real per-view owners compare the view a step acted in (readPart)', () => {
  const stub = new Proxy({}, { get: () => () => null });
  const owners = {
    filters: createFiltersDomain({ state: stub, refreshUi: () => {} }),
    visibility: createVisibilityDomain({ state: stub, refreshUi: () => {} }),
    'active-field': createActiveFieldDomain({ state: stub, refreshUi: () => {} }),
    views: createViewsDomain({ state: stub, viewer: stub, refreshUi: () => {} }),
    colors: createColorsDomain({ state: stub, refreshUi: () => {} }),
    camera: createCameraDomain({ state: stub, viewer: stub, refreshUi: () => {} }),
  };
  for (const [id, owner] of Object.entries(owners)) {
    assert.equal(owner.readPart, viewReadPart, `${id} gives the view's part`);
  }
  assert.deepEqual(viewReadPart({ views: ['a', 'b'] }, { focus: 1 }), 'b');
  assert.equal(viewReadPart({ views: ['a'] }, { focus: 1 }), undefined);
  assert.equal(viewReadPart(null, { focus: 0 }), undefined);
});
