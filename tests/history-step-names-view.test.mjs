/**
 * With several views, a step that changed one of them says which: "Colored by
 * gene Sox9" and "Colored Beta of cell_type #1f4e9e" name the view, in the
 * history and in the methods text, so a reader can tell which panel a step
 * changed. The history names the views a step changed, found from what
 * changed in each per-view domain, as the Compare views list names them
 * (`viewNameInValue`, with a view's label); one view, every view, a label
 * that names a view already, and keeping or removing a view are left as
 * they are.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createActionCatalog, defineAction } from '../assets/js/app/actions/catalog.js';
import { createActionDispatcher } from '../assets/js/app/actions/dispatcher.js';
import { createDomainRegistry } from '../assets/js/app/actions/domains.js';
import { historyActions } from '../assets/js/app/actions/definitions/history.js';
import { createHistory } from '../assets/js/app/history/history.js';
import { methodsParagraph } from '../assets/js/app/history/exports/methods.js';
import { viewReadPart } from '../assets/js/app/state/domains/view-list.js';

const object = (required, properties) => ({ type: 'object', additionalProperties: false, required, properties });

async function page() {
  const state = {
    views: { layout: 'grid', focus: 0, liveHidden: false, views: [{ embedding: null }] },
    'active-field': { views: [null] },
  };
  const perView = id => ({ capture: () => structuredClone(state[id]), restore: value => { state[id] = structuredClone(value); }, readPart: viewReadPart });
  const domains = createDomainRegistry();
  domains.provide('views', perView('views'));
  domains.provide('active-field', perView('active-field'));
  for (const id of domains.missing()) domains.provide(id, { capture: () => null, restore: () => {} });
  const defs = [
    defineAction({ type: 'color.gene', title: 'c', summary: 'x', group: 'T', params: object(['gene'], { gene: { type: 'string' } }), touches: ['active-field'], reads: [], effect: 'view', describe: p => `Colored by gene ${p.gene}`, code: p => `color(${JSON.stringify(p.gene)})` }),
    defineAction({ type: 'color.all', title: 'a', summary: 'x', group: 'T', params: object([], {}), touches: ['active-field'], reads: [], effect: 'view', describe: () => 'Colored every view gray', code: () => 'gray()' }),
    defineAction({ type: 'view.keep', title: 'k', summary: 'x', group: 'T', params: object([], { name: { type: 'string' } }), touches: ['views', 'active-field'], reads: [], effect: 'view', describe: () => 'Kept a view', code: () => 'keep()' }),
    defineAction({ type: 'view.focus', title: 'f', summary: 'x', group: 'T', params: object(['v'], { v: { type: 'integer' } }), touches: ['views'], reads: [], effect: 'view', describe: p => `Focused View ${p.v + 1}`, code: () => 'f()' }),
    defineAction({ type: 'view.color', title: 'v', summary: 'x', group: 'T', params: object(['v'], { v: { type: 'integer' } }), touches: ['active-field'], reads: [], effect: 'view', describe: p => `Colored View ${p.v + 1} red`, code: () => 'v()' }),
  ];
  const dispatcher = createActionDispatcher({ catalog: createActionCatalog([...defs, ...historyActions]) });
  const colorView = (index, entry) => { state['active-field'] = { views: state['active-field'].views.map((ref, i) => (i === index ? entry : ref)) }; };
  dispatcher.provide('color.gene', ({ gene }) => colorView(state.views.focus, { source: 'var', key: gene }));
  dispatcher.provide('color.all', () => { state['active-field'] = { views: state['active-field'].views.map(() => ({ source: 'obs', key: 'gray' })) }; });
  dispatcher.provide('view.keep', ({ name }) => {
    state.views = { ...state.views, views: [...state.views.views, { embedding: null, ...(name === undefined ? {} : { name }) }] };
    state['active-field'] = { views: [...state['active-field'].views, structuredClone(state['active-field'].views[0])] };
  });
  dispatcher.provide('view.focus', ({ v }) => { state.views = { ...state.views, focus: v }; });
  dispatcher.provide('view.color', ({ v }) => colorView(v, { source: 'obs', key: 'red' }));
  let n = 0;
  const history = createHistory({
    dispatcher, domains, dataset: { id: 'd', name: 'D', cellOrder: null },
    newTrackerId: () => `t-00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  });
  await history.startTracker();
  const step = async (type, params = {}) => (await dispatcher.dispatch(type, params)).step;
  return { history, step };
}

test('with several views a step names the view it changed, with its label; with one view it does not', async () => {
  const { history, step } = await page();
  assert.equal((await step('color.gene', { gene: 'Pdx1' })).label, 'Colored by gene Pdx1', 'one view: nothing to tell apart');
  assert.equal((await step('view.keep', { name: 'Early' })).label, 'Kept a view', 'keeping a view names itself');
  await step('view.focus', { v: 1 });
  assert.equal((await step('color.gene', { gene: 'Sox9' })).label, 'Colored by gene Sox9 in View 2 "Early"');
  await step('view.focus', { v: 0 });
  assert.equal((await step('color.gene', { gene: 'Neurog3' })).label, 'Colored by gene Neurog3 in View 1');
  assert.equal((await step('color.all')).label, 'Colored every view gray', 'every view changed: none to name');
  assert.equal((await step('view.color', { v: 1 })).label, 'Colored View 2 red', 'a label that names its view already');
  // The methods text says it too: it is written from the steps' labels.
  const text = methodsParagraph({ tracker: history.trackerRecord(history.active.id), dataset: { name: 'Pancreas', cells: 10 } });
  assert.match(text, /Sox9 in View 2 "Early"/);
  assert.match(text, /Neurog3 in View 1/);
});
