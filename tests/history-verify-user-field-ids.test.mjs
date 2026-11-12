/**
 * Verify compares a replay with its branch but for generated ids, in every
 * domain (live pass 3, L12-12). A step that makes a user field ("Grouped
 * clusters … as stage") gives it a new generated id each time it runs, and
 * other domains name the field by that id (its colors, a filter of it, a
 * view colored by it). Only `field-overlays` renamed its ids for the
 * comparison, so every branch that made a field and colored or filtered it
 * was reported "not reproduced" ("user_cat_…: default color for Endocrine;
 * stage: recolored Endocrine"), and a delete applied such steps again for an
 * input that had not changed. A value now names each user field as the
 * `field-overlays` value of its state names it (`user_1`, …).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createActionCatalog, defineAction } from '../assets/js/app/actions/catalog.js';
import { createActionDispatcher } from '../assets/js/app/actions/dispatcher.js';
import { createDomainRegistry } from '../assets/js/app/actions/domains.js';
import { historyActions } from '../assets/js/app/actions/definitions/history.js';
import { createHistory, renamedIds } from '../assets/js/app/history/history.js';
import { trackerId } from './history-fake-page.mjs';

const NAME = Object.freeze({ type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' } } });

async function page() {
  const state = { overlays: { userFields: [] }, colors: {}, made: 0 };
  const domains = createDomainRegistry();
  domains.provide('field-overlays', {
    capture: () => structuredClone(state.overlays),
    restore: value => { state.overlays = structuredClone(value); },
    canonical: value => ({ ...value, userFields: value.userFields.map((item, index) => ({ ...item, id: `user_${index + 1}` })) }),
  });
  domains.provide('colors', {
    capture: () => structuredClone(state.colors),
    restore: value => { state.colors = structuredClone(value); },
    describe: (x, y) => [`${JSON.stringify(x)} → ${JSON.stringify(y)}`],
  });
  for (const id of domains.missing()) domains.provide(id, { capture: () => null, restore: () => {} });
  const definitions = [
    defineAction({
      type: 'field.make', title: 'Make a field', summary: 'A user field, colored.', group: 'T', params: NAME,
      touches: ['field-overlays', 'colors'], reads: [], effect: 'state', describe: p => `made ${p.name}`, code: p => `make(${JSON.stringify(p.name)})`,
    }),
    defineAction({
      type: 'field.recolor', title: 'Recolor', summary: 'Recolor the last user field.', group: 'T', params: NAME,
      touches: ['colors'], reads: ['field-overlays'], effect: 'view', describe: p => `recolored ${p.name}`, code: p => `recolor(${JSON.stringify(p.name)})`,
    }),
  ];
  const dispatcher = createActionDispatcher({ catalog: createActionCatalog([...definitions, ...historyActions]) });
  // Every run of the step makes the field under a new generated id, as the app's registry does.
  dispatcher.provide('field.make', ({ name }) => {
    const id = `user_cat_${1_700_000_000_000 + (state.made += 1)}_1`;
    state.overlays = { userFields: [...state.overlays.userFields, { id, key: name }] };
    state.colors = { ...state.colors, [id]: { Endocrine: '#ff0000' } };
  });
  dispatcher.provide('field.recolor', ({ name }) => {
    const id = state.overlays.userFields.at(-1).id;
    state.colors = { ...state.colors, [id]: { Endocrine: name } };
  });
  let t = 0;
  let n = 100;
  const history = createHistory({
    dispatcher, domains, dataset: { id: 'd1', name: 'Demo', cellOrder: null }, newTrackerId: () => trackerId(++n), now: () => ++t * 1000,
  });
  await history.startTracker();
  const act = async (type, params = {}) => (await dispatcher.dispatch(type, params, {})).outcome;
  return { history, act };
}

test('renamedIds renames ids as values and as keys, at any depth; typed arrays stay', () => {
  const names = new Map([['user_cat_9_1', 'user_1']]);
  const cells = new Uint32Array([1, 2]);
  assert.deepEqual(
    renamedIds({ views: [{ field: { source: 'obs', user: 'user_cat_9_1' }, colors: { user_cat_9_1: 'x' } }], cells }, names),
    { views: [{ field: { source: 'obs', user: 'user_1' }, colors: { user_1: 'x' } }], cells },
  );
});

test('a branch that makes a user field and colors it verifies as reproduced', async () => {
  const { act } = await page();
  await act('field.make', { name: 'stage' });
  await act('field.recolor', { name: '#00ff00' });
  const verdict = await act('history.verify', { branch: 'Main' });
  assert.equal(verdict.reproduced, true, JSON.stringify(verdict.domains));
  assert.deepEqual(verdict.domains, []);
});
