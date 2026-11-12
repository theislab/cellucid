/**
 * A saved state that does not hold a domain (a file written before the
 * domain existed, or by hand) restored onto an open dataset (F153): the
 * domain's owner says what its absence stands for (`absent()`), and the
 * restore puts that back, as part of the restore itself; an owner without
 * one keeps the value shown. The Expression values say "as stored" (plan
 * §3: a record without the field means off), so the same file restores
 * the same values whatever was shown before; Load, a session file and an
 * agent's `history.saved.open` all read a saved state through
 * `history.load` / `importTrackers`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createActionCatalog, defineAction } from '../assets/js/app/actions/catalog.js';
import { createActionDispatcher } from '../assets/js/app/actions/dispatcher.js';
import { createDomainRegistry } from '../assets/js/app/actions/domains.js';
import { historyActions } from '../assets/js/app/actions/definitions/history.js';
import { createHistory } from '../assets/js/app/history/history.js';
import { validateHistory } from '../assets/js/app/history/model.js';
import { createExpressionDomain } from '../assets/js/app/state/domains/expression.js';
import { RAW_VALUES, requireExpressionTransform } from '../assets/js/data/expression-transform.js';

const object = (required, properties) => ({ type: 'object', additionalProperties: false, required, properties });
const definitions = [
  defineAction({
    type: 'a.set', title: 'Set a', summary: 'Set a.', group: 'T', params: object(['v'], { v: { type: 'integer' } }),
    touches: ['filters'], reads: [], effect: 'state', describe: p => `a = ${p.v}`, code: p => `a(${p.v})`,
  }),
  defineAction({
    type: 'expression.set', title: 'Expression values', summary: 'Set them.', group: 'T',
    params: object(['normalize', 'log1p'], { normalize: { type: 'boolean' }, log1p: { type: 'boolean' } }),
    touches: ['expression'], reads: [], effect: 'state', describe: () => 'values', code: () => 'values()',
  }),
];

let trackers = 0;

/** A page whose `expression` domain is the real owner over a state that keeps the transform asked. */
async function makePage() {
  const page = { a: 0, layout: 'light', restored: [] };
  const state = {
    transform: RAW_VALUES,
    getExpressionTransform() { return this.transform; },
    async setExpressionTransform(next) {
      page.restored.push(next);
      this.transform = requireExpressionTransform(next);
      return { changed: true, shown: this.transform, dropped: [] };
    },
  };
  const domains = createDomainRegistry();
  domains.provide('filters', { capture: () => page.a, restore: value => { page.a = value; } });
  // A domain whose owner says nothing about its absence: a record without it keeps what is shown.
  domains.provide('layout', { capture: () => page.layout, restore: value => { page.layout = value; } });
  domains.provide('expression', createExpressionDomain({ state, refreshUi: () => {} }));
  for (const id of domains.missing()) domains.provide(id, { capture: () => null, restore: () => {} });
  const dispatcher = createActionDispatcher({ catalog: createActionCatalog([...definitions, ...historyActions]) });
  dispatcher.provide('a.set', ({ v }) => { page.a = v; });
  dispatcher.provide('expression.set', params => state.setExpressionTransform(params));
  let t = 0;
  const history = createHistory({
    dispatcher, domains, dataset: { id: 'd1', name: 'Demo', cellOrder: null },
    newTrackerId: () => `t-00000000-0000-4000-8000-${String(++trackers).padStart(12, '0')}`, now: () => ++t * 1000,
  });
  await history.startTracker();
  return { page, state, dispatcher, history };
}

/** A page's saved history with `ids` left out of every step (as a file from before those domains). */
function savedWithout(source, ids) {
  const whole = source.history.snapshot();
  const values = new Map(source.history.pool.hashes().map(hash => [hash, source.history.pool.get(hash)]));
  const strip = record => Object.fromEntries(Object.entries(record).filter(([id]) => !ids.includes(id)));
  const saved = {
    ...whole,
    trackers: whole.trackers.map(tracker => ({
      ...tracker,
      steps: tracker.steps.map(step => ({ ...step, touches: step.touches.filter(id => !ids.includes(id)), before: strip(step.before), after: strip(step.after) })),
    })),
  };
  return { saved, values };
}

test('a saved state without the Expression values restores them as stored, whatever was shown (load and load beside)', async () => {
  for (const how of ['load', 'importTrackers']) {
    const source = await makePage();
    await source.dispatcher.dispatch('a.set', { v: 7 });
    const { saved, values } = savedWithout(source, ['expression', 'layout']);
    const target = await makePage();
    await target.dispatcher.dispatch('expression.set', { normalize: true, log1p: true });
    target.page.layout = 'dark';
    target.page.restored.length = 0;
    await target.history[how](saved, { values, ...(how === 'importTrackers' ? { file: 'old.cellucid-session' } : {}) });
    assert.equal(target.page.a, 7, `${how}: the saved values are shown`);
    assert.deepEqual(target.state.getExpressionTransform(), RAW_VALUES, `${how}: a record without the Expression values means as stored`);
    assert.deepEqual(target.page.restored, [RAW_VALUES], `${how}: put back once, by the restore`);
    // An owner that says nothing about its absence keeps what is shown.
    assert.equal(target.page.layout, 'dark', `${how}: a domain without absent() keeps the value shown`);
    // The loaded tracker's root holds the value the restore put back, so moving in it keeps the values as stored.
    const loaded = target.history.active;
    const root = loaded.steps.get(loaded.rootId);
    assert.deepEqual(target.history.pool.get(root.after.expression), { normalize: false, log1p: false }, `${how}: the root holds "as stored"`);
    validateHistory(target.history.snapshot());
  }
});

test('a saved state that holds the Expression values restores them onto the open dataset, as part of the restore', async () => {
  const source = await makePage();
  await source.dispatcher.dispatch('expression.set', { normalize: true, log1p: false });
  const whole = source.history.snapshot();
  const values = new Map(source.history.pool.hashes().map(hash => [hash, source.history.pool.get(hash)]));
  const target = await makePage();
  await target.dispatcher.dispatch('expression.set', { normalize: false, log1p: true });
  const stepsBefore = target.history.active.steps.size;
  await target.history.load(whole, { values });
  assert.deepEqual(target.state.getExpressionTransform(), { normalize: true, log1p: false });
  // No step of its own: the load shows the saved head, as for every other domain.
  assert.equal(target.history.active.steps.size, whole.trackers[0].steps.length);
  assert.ok(stepsBefore >= 1);
  validateHistory(target.history.snapshot());
});

test('an owner\'s absent() is a function of no value, checked when the owner is given', () => {
  const domains = createDomainRegistry();
  assert.throws(
    () => domains.provide('expression', { capture: () => null, restore: () => {}, absent: { normalize: false, log1p: false } }),
    /absent/,
  );
  const expression = createExpressionDomain({ state: { getExpressionTransform: () => RAW_VALUES, setExpressionTransform: async () => ({}) }, refreshUi: () => {} });
  assert.deepEqual(expression.absent(), { normalize: false, log1p: false });
});
