/**
 * History v2 §3.13 and §3.3.4 with generated ids: a domain whose values carry
 * ids from a counter that is never lowered (highlight pages and groups, user
 * fields) or creation times gives a canonical form. Verify compares canonical
 * forms, so the same steps applied again reproduce; a delete applies again a
 * step whose input differs only by such ids no more than one whose input did
 * not change. The real owners' canonical forms rename in order and drop times.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createActionCatalog, defineAction } from '../assets/js/app/actions/catalog.js';
import { createActionDispatcher } from '../assets/js/app/actions/dispatcher.js';
import { createDomainRegistry } from '../assets/js/app/actions/domains.js';
import { historyActions } from '../assets/js/app/actions/definitions/history.js';
import { createHistory } from '../assets/js/app/history/history.js';
import { canonicalHighlights } from '../assets/js/app/state/domains/highlights.js';
import { canonicalFieldOverlays } from '../assets/js/app/state/domains/field-overlays.js';
import { NONE } from './history-fake-page.mjs';

/** Highlights whose group ids come from a counter a restore never lowers, as the real domain's. */
async function highlightPage() {
  const state = { groups: [], counter: 0, a: 0, c: 0 };
  const domains = createDomainRegistry();
  domains.provide('highlights', {
    capture: () => state.groups.map(group => ({ ...group })),
    restore: value => { state.groups = value.map(group => ({ ...group })); },
    canonical: value => value.map((group, index) => ({ ...group, id: `highlight_${index + 1}` })),
    describe: () => ['highlights differ'],
  });
  domains.provide('filters', { capture: () => state.a, restore: value => { state.a = value; } });
  domains.provide('analysis', { capture: () => state.c, restore: value => { state.c = value; } });
  for (const id of domains.missing()) domains.provide(id, { capture: () => null, restore: () => {} });
  const defs = [
    defineAction({ type: 'a.inc', title: 'a', summary: 'x', group: 'T', params: NONE, touches: ['filters'], reads: [], effect: 'state', describe: () => 'a + 1', code: () => 'a()' }),
    // A highlight of the cells the filters leave (it reads them); its id is the next of the counter.
    defineAction({ type: 'h.add', title: 'Highlight', summary: 'x', group: 'T', params: NONE, touches: ['highlights'], reads: ['filters'], effect: 'state', describe: () => 'highlight', code: () => 'h()' }),
    defineAction({ type: 'c.count', title: 'count', summary: 'x', group: 'T', params: NONE, touches: ['analysis'], reads: ['highlights'], effect: 'state', describe: () => 'count', code: () => 'c()' }),
  ];
  const dispatcher = createActionDispatcher({ catalog: createActionCatalog([...defs, ...historyActions]) });
  let counts = 0;
  dispatcher.provide('a.inc', () => { state.a += 1; });
  dispatcher.provide('h.add', () => { state.groups = [...state.groups, { id: `highlight_${++state.counter}`, cells: [1, 2] }]; });
  dispatcher.provide('c.count', () => { counts++; state.c = state.groups.length; });
  let n = 0;
  const history = createHistory({
    dispatcher, domains, dataset: { id: 'd', name: 'D', cellOrder: null },
    newTrackerId: () => `t-00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  });
  await history.startTracker();
  return { state, history, dispatcher, counts: () => counts };
}

test('verify of a branch whose steps make generated ids reproduces it', async () => {
  const { history, dispatcher } = await highlightPage();
  await dispatcher.dispatch('a.inc', {});
  await dispatcher.dispatch('h.add', {});
  await dispatcher.dispatch('c.count', {});
  const verified = (await dispatcher.dispatch('history.verify', { branch: history.active.activeBranch })).outcome;
  assert.equal(verified.reproduced, true, JSON.stringify(verified.domains));
});

test('a delete applies again a step reading a value that differs only by a generated id no more', async () => {
  const { history, dispatcher, counts } = await highlightPage();
  const s1 = (await dispatcher.dispatch('a.inc', {})).step;
  await dispatcher.dispatch('h.add', {});
  await dispatcher.dispatch('c.count', {});
  const before = counts();
  const deleted = await history.deleteStep(s1.id);
  // The highlight reads the filters: applied again, under a new id. The count reads only the highlights,
  // whose canonical form is the same: not applied again.
  assert.equal(deleted.reapplied.length, 1);
  assert.equal(history.active.steps.get(deleted.reapplied[0]).label, 'highlight');
  assert.equal(counts(), before);
});

test('the highlights owner renames pages and groups in order, and the active page with them', () => {
  const cells = new Uint32Array([1, 2]);
  const value = {
    active: 'page_7',
    pages: [
      { id: 'page_4', name: 'A', color: '#000000', groups: [{ id: 'highlight_9', type: 'lasso', label: 'x', enabled: true, cells }] },
      { id: 'page_7', name: 'B', color: '#ffffff', groups: [{ id: 'highlight_12', type: 'lasso', label: 'y', enabled: true, cells }, { id: 'highlight_3', type: 'knn', label: 'z', enabled: false, cells }] },
    ],
  };
  const canonical = canonicalHighlights(value);
  assert.equal(canonical.active, 'page_2');
  assert.deepEqual(canonical.pages.map(page => page.id), ['page_1', 'page_2']);
  assert.deepEqual(canonical.pages.flatMap(page => page.groups.map(group => group.id)), ['highlight_1', 'highlight_2', 'highlight_3']);
  assert.equal(canonical.pages[1].groups[0].cells, cells);
  assert.equal(value.pages[0].id, 'page_4', 'the value itself is left as it is');
});

test('the field overlays owner renames user fields in order and drops their creation times', () => {
  const value = {
    renamedFields: [], renamedCategories: [], deletedFields: [],
    userFields: [{ id: 'user_cat_x81', createdAt: 1730000000000, key: 'Mine' }, { id: 'user_obs_value_q2', createdAt: 1730000000500, key: 'Other' }],
  };
  const canonical = canonicalFieldOverlays(value);
  assert.deepEqual(canonical.userFields.map(item => [item.id, item.createdAt, item.key]), [['user_1', null, 'Mine'], ['user_2', null, 'Other']]);
  assert.equal(value.userFields[0].id, 'user_cat_x81');
});
