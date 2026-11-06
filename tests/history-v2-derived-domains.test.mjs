/**
 * History v2: a domain that follows another (`DERIVED_DOMAINS`: the analyses'
 * page selections follow the highlight pages) is captured with it, after an
 * action and after a restore. A page made joins the step that made it, its
 * undo puts the selection back with it, and nothing is ever recorded as a
 * change made outside the history.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createActionCatalog, defineAction } from '../assets/js/app/actions/catalog.js';
import { createActionDispatcher } from '../assets/js/app/actions/dispatcher.js';
import { createDomainRegistry, DERIVED_DOMAINS, DOMAIN_IDS, withDerivedDomains } from '../assets/js/app/actions/domains.js';
import { historyActions } from '../assets/js/app/actions/definitions/history.js';
import { createHistory } from '../assets/js/app/history/history.js';
import { NONE } from './history-fake-page.mjs';

test('the derived domains name known domains, and a domain followed brings its followers', () => {
  for (const [derived, follows] of Object.entries(DERIVED_DOMAINS)) {
    assert.ok(DOMAIN_IDS.includes(derived));
    for (const id of follows) assert.ok(DOMAIN_IDS.includes(id) && id !== derived);
  }
  assert.deepEqual(withDerivedDomains(['highlights']), ['highlights', 'analysis']);
  assert.deepEqual(withDerivedDomains(['filters']), ['filters']);
});

test('a page made and undone carries the analysis selection that follows it, with no outside step', async () => {
  const state = { pages: ['p1'], selected: ['p1'] };
  let known = ['p1'];
  // As comparison-module.js onPagesChanged: a selection that held every page takes a new one; a page gone leaves it.
  const pagesChanged = () => {
    const hadAll = known.every(page => state.selected.includes(page));
    const added = state.pages.filter(page => !known.includes(page));
    state.selected = state.selected.filter(page => state.pages.includes(page));
    if (hadAll) state.selected.push(...added);
    known = [...state.pages];
  };
  const domains = createDomainRegistry();
  domains.provide('highlights', { capture: () => [...state.pages], restore: value => { state.pages = [...value]; pagesChanged(); } });
  domains.provide('analysis', { capture: () => [...state.selected], restore: value => { state.selected = [...value]; } });
  for (const id of domains.missing()) domains.provide(id, { capture: () => null, restore: () => {} });
  const create = defineAction({ type: 'page.create', title: 'Page', summary: 'x', group: 'T', params: NONE, touches: ['highlights'], reads: [], effect: 'state', describe: () => 'page', code: () => 'p()' });
  const dispatcher = createActionDispatcher({ catalog: createActionCatalog([create, ...historyActions]) });
  dispatcher.provide('page.create', () => { state.pages = [...state.pages, `p${state.pages.length + 1}`]; pagesChanged(); });
  let n = 0;
  const history = createHistory({
    dispatcher, domains, dataset: { id: 'd', name: 'D', cellOrder: null },
    newTrackerId: () => `t-00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  });
  await history.startTracker();
  const made = (await dispatcher.dispatch('page.create', {})).step;
  assert.deepEqual(made.touches, ['highlights', 'analysis'], 'the selection that followed is part of the step');
  await history.reconcile();
  await history.undo();
  await history.reconcile();
  assert.deepEqual(state, { pages: ['p1'], selected: ['p1'] });
  await history.redo();
  await history.reconcile();
  assert.deepEqual(state, { pages: ['p1', 'p2'], selected: ['p1', 'p2'] });
  assert.deepEqual([...history.active.steps.values()].filter(step => step.kind === 'outside'), []);
});
