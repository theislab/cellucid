/**
 * History v2 §3.4: staleness follows the result inputs (`reads`) of every
 * action, not only analyses, kept views and fields made from pages. A cell
 * set computed from the filters is stale once the filters change, naming the
 * step that changed them; a step whose name only resolves in a domain
 * (`context`: a field's name, the view in focus) is never stale when that
 * domain changes, and records nothing of it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createActionCatalog, defineAction } from '../assets/js/app/actions/catalog.js';
import { createActionDispatcher } from '../assets/js/app/actions/dispatcher.js';
import { createDomainRegistry } from '../assets/js/app/actions/domains.js';
import { historyActions } from '../assets/js/app/actions/definitions/history.js';
import { createHistory } from '../assets/js/app/history/history.js';
import { NONE, NUMBER } from './history-fake-page.mjs';

async function page() {
  const state = { filters: 0, names: 0, h: [], colors: 0 };
  const domains = createDomainRegistry();
  domains.provide('filters', { capture: () => state.filters, restore: value => { state.filters = value; } });
  domains.provide('field-overlays', { capture: () => state.names, restore: value => { state.names = value; } });
  domains.provide('highlights', { capture: () => [...state.h], restore: value => { state.h = [...value]; } });
  domains.provide('colors', { capture: () => state.colors, restore: value => { state.colors = value; } });
  for (const id of domains.missing()) domains.provide(id, { capture: () => null, restore: () => {} });
  const defs = [
    defineAction({ type: 'filter.set', title: 'f', summary: 'x', group: 'T', params: NUMBER, touches: ['filters'], reads: [], effect: 'state', describe: p => `filter ${p.v}`, code: () => 'f()' }),
    defineAction({ type: 'field.rename', title: 'r', summary: 'x', group: 'T', params: NUMBER, touches: ['field-overlays'], reads: [], effect: 'state', describe: p => `rename ${p.v}`, code: () => 'r()' }),
    // As highlight.range: the cells the filters leave are its result input.
    defineAction({ type: 'highlight.visible', title: 'h', summary: 'x', group: 'T', params: NONE, touches: ['highlights'], reads: ['filters'], effect: 'state', describe: () => 'highlight the visible cells', code: () => 'h()' }),
    // As color.category: the field it names resolves in the field overlays, its colour does not follow them.
    defineAction({ type: 'color.set', title: 'c', summary: 'x', group: 'T', params: NUMBER, touches: ['colors'], reads: [], context: ['field-overlays'], effect: 'view', describe: p => `colour ${p.v}`, code: () => 'c()' }),
  ];
  const dispatcher = createActionDispatcher({ catalog: createActionCatalog([...defs, ...historyActions]) });
  dispatcher.provide('filter.set', ({ v }) => { state.filters = v; });
  dispatcher.provide('field.rename', ({ v }) => { state.names = v; });
  dispatcher.provide('highlight.visible', () => { state.h = Array.from({ length: 10 - state.filters }, (_, i) => i); });
  dispatcher.provide('color.set', ({ v }) => { state.colors = v; });
  let n = 0;
  const history = createHistory({
    dispatcher, domains, dataset: { id: 'd', name: 'D', cellOrder: null },
    newTrackerId: () => `t-00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  });
  await history.startTracker();
  const step = async (type, params = {}) => (await dispatcher.dispatch(type, params)).step;
  const stale = async () => (await dispatcher.dispatch('history.stale', {})).outcome.stale;
  return { history, step, stale };
}

test('a cell set made from the filters is stale once they change, naming the step that changed them', async () => {
  const { step, stale } = await page();
  await step('filter.set', { v: 2 });
  const made = await step('highlight.visible');
  assert.deepEqual(await stale(), []);
  const cause = await step('filter.set', { v: 5 });
  const found = await stale();
  assert.equal(found.length, 1);
  assert.equal(found[0].step, made.id);
  assert.equal(found[0].cause.step, cause.id);
});

test('a step whose name resolves in a domain is not stale when it changes, and records nothing of it', async () => {
  const { history, step, stale } = await page();
  const coloured = await step('color.set', { v: 3 });
  assert.deepEqual(history.active.steps.get(coloured.id).reads, {}, 'the name context is not recorded');
  await step('field.rename', { v: 1 });
  assert.deepEqual(await stale(), []);
});
