/**
 * A saved history is restored part by part: a history kept before the rename
 * of the Expression values (`expression` held `{normalise, log1p}`) that the
 * Expression values' owner refuses must not roll the whole restore back and
 * lose the views, the steps and the conversation with the one part this
 * version cannot read. Each domain
 * put back is one part: a part that cannot be put back keeps what is shown
 * and is named (`unrestored`), the others are restored, the history and its
 * conversations are loaded, and the gap is the tracker's own step, so what
 * is shown and the history agree. A tracker whose records this version
 * cannot read is one part too: left out and named, and when it is the one
 * shown, what it showed is kept as a new tracker with its conversations.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createActionCatalog, defineAction } from '../assets/js/app/actions/catalog.js';
import { createActionDispatcher } from '../assets/js/app/actions/dispatcher.js';
import { createDomainRegistry } from '../assets/js/app/actions/domains.js';
import { historyActions } from '../assets/js/app/actions/definitions/history.js';
import { createHistory } from '../assets/js/app/history/history.js';
import { validateHistory } from '../assets/js/app/history/model.js';
import { hashValue } from '../assets/js/app/history/value-pool.js';
import { createExpressionDomain } from '../assets/js/app/state/domains/expression.js';
import { RAW_VALUES, requireExpressionTransform } from '../assets/js/data/expression-transform.js';

const object = (required, properties) => ({ type: 'object', additionalProperties: false, required, properties });
const definitions = [
  defineAction({
    type: 'a.set', title: 'Set a', summary: 'Set a.', group: 'T', params: object(['v'], { v: { type: 'integer' } }),
    touches: ['filters'], reads: [], effect: 'state', describe: p => `a = ${p.v}`, code: p => `a(${p.v})`,
  }),
  defineAction({
    type: 'views.set', title: 'Set views', summary: 'Set views.', group: 'T', params: object(['n'], { n: { type: 'integer' } }),
    touches: ['views'], reads: [], effect: 'state', describe: p => `${p.n} views`, code: p => `views(${p.n})`,
  }),
  defineAction({
    type: 'expression.set', title: 'Expression values', summary: 'Set them.', group: 'T',
    params: object(['normalize', 'log1p'], { normalize: { type: 'boolean' }, log1p: { type: 'boolean' } }),
    touches: ['expression'], reads: [], effect: 'state', describe: () => 'values', code: () => 'values()',
  }),
];

let trackers = 0;

async function makePage() {
  const page = { a: 0, views: 1 };
  const state = {
    transform: RAW_VALUES,
    getExpressionTransform() { return this.transform; },
    async setExpressionTransform(next) {
      this.transform = requireExpressionTransform(next);
      return { changed: true, shown: this.transform, dropped: [] };
    },
  };
  const domains = createDomainRegistry();
  domains.provide('filters', { capture: () => page.a, restore: value => { page.a = value; } });
  domains.provide('views', { capture: () => page.views, restore: value => { page.views = value; } });
  domains.provide('expression', createExpressionDomain({ state, refreshUi: () => {} }));
  for (const id of domains.missing()) domains.provide(id, { capture: () => null, restore: () => {} });
  const dispatcher = createActionDispatcher({ catalog: createActionCatalog([...definitions, ...historyActions]) });
  dispatcher.provide('a.set', ({ v }) => { page.a = v; });
  dispatcher.provide('views.set', ({ n }) => { page.views = n; });
  dispatcher.provide('expression.set', params => state.setExpressionTransform(params));
  let t = 0;
  const history = createHistory({
    dispatcher, domains, dataset: { id: 'd1', name: 'Demo', cellOrder: null },
    newTrackerId: () => `t-00000000-0000-4000-8000-${String(++trackers).padStart(12, '0')}`, now: () => ++t * 1000,
  });
  await history.startTracker();
  return { page, state, dispatcher, history };
}

const CONVERSATION = { schema: 'cellucid-agent-transcript', updatedAt: 5, messages: [{ role: 'user', text: 'markers of beta cells' }] };

/**
 * A history kept before the rename of the Expression values: the Expression values as
 * `{normalise, log1p}` (re-hashed, every step naming them re-pointed), with
 * a conversation kept with its tracker.
 */
async function savedBeforeRename() {
  const source = await makePage();
  await source.dispatcher.dispatch('expression.set', { normalize: true, log1p: true });
  await source.dispatcher.dispatch('a.set', { v: 7 });
  await source.dispatcher.dispatch('views.set', { n: 3 });
  source.history.setChat(source.history.active.id, 'c-1', CONVERSATION);
  const whole = source.history.snapshot();
  const values = new Map(source.history.pool.hashes().map(hash => [hash, source.history.pool.get(hash)]));
  const renamed = new Map();
  for (const [hash, value] of [...values]) {
    if (value === null || typeof value !== 'object' || !('normalize' in value)) continue;
    const old = { normalise: value.normalize, log1p: value.log1p };
    const oldHash = await hashValue(old);
    values.delete(hash);
    values.set(oldHash, old);
    renamed.set(hash, oldHash);
  }
  const repoint = record => Object.fromEntries(Object.entries(record).map(([id, hash]) => [id, renamed.get(hash) ?? hash]));
  const saved = {
    ...whole,
    trackers: whole.trackers.map(tracker => ({
      ...tracker,
      steps: tracker.steps.map(step => ({ ...step, before: repoint(step.before), after: repoint(step.after) })),
    })),
  };
  return { saved, values };
}

test('a history kept before the rename restores every part it can, names the one it cannot, and keeps its steps and conversation (load and load beside)', async () => {
  for (const how of ['load', 'importTrackers']) {
    const { saved, values } = await savedBeforeRename();
    const target = await makePage();
    const result = await target.history[how](saved, { values, ...(how === 'importTrackers' ? { file: 'kept.cellucid-session' } : {}) });
    assert.equal(target.page.a, 7, `${how}: the filters are restored`);
    assert.equal(target.page.views, 3, `${how}: the views are restored`);
    assert.deepEqual(target.state.getExpressionTransform(), RAW_VALUES, `${how}: the part not read keeps what is shown`);
    assert.deepEqual(result.unrestored.map(part => [part.part, part.domain]), [['domain', 'expression']], `${how}: the one part named`);
    assert.match(String(result.unrestored[0].error.message), /exactly \{normalize: boolean, log1p: boolean\}/, `${how}: its own words kept for Details`);
    const active = target.history.active;
    // The conversation kept with the tracker comes with it.
    assert.deepEqual(target.history.chatsOf(active.id), [['c-1', CONVERSATION]], `${how}: the conversation is kept`);
    // Every saved step is there, and one more: what is shown differs from the saved head in the part not restored.
    const savedSteps = saved.trackers[0].steps.length;
    assert.equal(active.steps.size, savedSteps + 1, `${how}: the saved steps and the gap's own step`);
    const gap = active.steps.get(active.headId);
    assert.deepEqual(gap.touches, ['expression'], `${how}: the gap step touches the part not restored`);
    assert.match(gap.label, /Expression values/, `${how}: the gap step names the part`);
    assert.match(gap.label, /not restored|could not be put back/i, `${how}: the gap step says what happened`);
    assert.deepEqual(target.history.pool.get(gap.after.expression), { normalize: false, log1p: false }, `${how}: the step ends on what is shown`);
    validateHistory(target.history.snapshot());
    // Undoing the gap would put back the value this version cannot read: refused whole, what is shown stays.
    await assert.rejects(target.dispatcher.dispatch('history.undo', {}));
    assert.equal(target.page.a, 7, `${how}: a refused undo leaves what is shown`);
    assert.equal(target.history.active.headId, gap.id, `${how}: and the head`);
  }
});

test('a load that puts back every part says nothing is unrestored and adds no step', async () => {
  const source = await makePage();
  await source.dispatcher.dispatch('a.set', { v: 4 });
  const whole = source.history.snapshot();
  const values = new Map(source.history.pool.hashes().map(hash => [hash, source.history.pool.get(hash)]));
  const target = await makePage();
  const result = await target.history.load(whole, { values });
  assert.deepEqual(result.unrestored, []);
  assert.equal(target.history.active.steps.size, whole.trackers[0].steps.length);
});

test('a tracker this version cannot read is one part: left out and named; the one shown keeps what it showed, as a new tracker with its conversations', async () => {
  const { saved, values } = await savedBeforeRename();
  const source = await makePage();
  await source.dispatcher.dispatch('a.set', { v: 2 });
  // A second tracker, readable, beside the one from before the rename.
  const other = await makePage();
  await other.dispatcher.dispatch('a.set', { v: 9 });
  const second = other.history.snapshot().trackers[0];
  for (const hash of other.history.pool.hashes()) values.set(hash, other.history.pool.get(hash));
  const named = { ...second, name: 'Second' };
  // A record field this version does not have (as a record from another model version).
  const shown = { ...saved.trackers[0], name: 'Kept', laterField: true };
  for (const [which, history] of [['the one shown', { ...saved, trackers: [shown, named] }], ['another', { ...saved, activeTracker: named.id, trackers: [{ ...saved.trackers[0], name: 'Kept', laterField: true }, named] }]]) {
    const target = await makePage();
    const result = await target.history.load(history, { values });
    const trackerParts = result.unrestored.filter(part => part.part === 'tracker');
    assert.deepEqual(trackerParts.map(part => part.tracker.name), ['Kept'], `${which}: the tracker not read is named`);
    assert.equal(trackerParts[0].active, which === 'the one shown');
    assert.match(String(trackerParts[0].error.message), /laterField/, `${which}: its own words kept for Details`);
    const names = target.history.trackers().map(tracker => tracker.name).sort();
    if (which === 'the one shown') {
      // What it showed is restored (the filters and views of its head), kept as a new tracker with its conversation.
      assert.equal(target.page.a, 7);
      assert.equal(target.page.views, 3);
      assert.deepEqual(names, ['Kept', 'Second']);
      const kept = target.history.active;
      assert.equal(kept.name, 'Kept');
      assert.equal(kept.steps.size, 1, 'the new tracker starts at what is shown');
      assert.deepEqual(target.history.chatsOf(kept.id), [['c-1', CONVERSATION]]);
    } else {
      assert.equal(target.page.a, 9);
      assert.deepEqual(names, ['Second']);
    }
    validateHistory(target.history.snapshot());
  }
});

test('a state part this version does not have is left out of every step and named; the rest is restored (load, load beside, journal)', async () => {
  for (const how of ['load', 'importTrackers']) {
    const source = await makePage();
    await source.dispatcher.dispatch('a.set', { v: 5 });
    await source.dispatcher.dispatch('views.set', { n: 2 });
    const whole = source.history.snapshot();
    const values = new Map(source.history.pool.hashes().map(hash => [hash, source.history.pool.get(hash)]));
    const holograms = await hashValue({ shown: true });
    const none = await hashValue({ shown: false });
    values.set(holograms, { shown: true });
    values.set(none, { shown: false });
    // Written by a version with a "holograms" domain: in the root, in a step beside "filters", in a step of its own, and read.
    const [tracker] = whole.trackers;
    const steps = tracker.steps.map(step => (step.parent === null
      ? { ...step, after: { ...step.after, holograms: none } }
      : step.label === 'a = 5'
        ? { ...step, touches: [...step.touches, 'holograms'], before: { ...step.before, holograms: none }, after: { ...step.after, holograms: holograms }, reads: { holograms } }
        : step));
    const saved = { ...whole, trackers: [{ ...tracker, steps }] };
    const target = await makePage();
    const result = await target.history[how](saved, { values, ...(how === 'importTrackers' ? { file: 'newer.cellucid-session' } : {}) });
    assert.deepEqual(result.unrestored, [{ part: 'unknown-domain', domain: 'holograms' }], `${how}: the part is named`);
    assert.equal(target.page.a, 5, `${how}: the rest is restored`);
    assert.equal(target.page.views, 2, `${how}: the rest is restored`);
    const active = target.history.active;
    assert.equal(active.steps.size, tracker.steps.length, `${how}: every step kept, no gap step for a part this version does not have`);
    for (const step of active.steps.values()) {
      assert.ok(!step.touches.includes('holograms') && !('holograms' in step.after) && !('holograms' in step.reads), `${how}: ${step.id} holds no such part`);
    }
    validateHistory(target.history.snapshot());
    // Undo and redo move through the steps as they are here.
    await target.dispatcher.dispatch('history.undo', {});
    assert.equal(target.page.views, 1);
    await target.dispatcher.dispatch('history.undo', {});
    assert.equal(target.page.a, 0);
  }
});

test('a conversation kept with a history that this version cannot show is said, never dropped silently', async () => {
  const { unreadConversationNotice, TRANSCRIPT_SCHEMA } = await import('../assets/js/app/agent/chat/conversation.js');
  assert.equal(unreadConversationNotice([]), null);
  assert.equal(unreadConversationNotice([['c-1', { schema: TRANSCRIPT_SCHEMA, messages: [] }]]), null, 'a readable one says nothing');
  const earlier = unreadConversationNotice([['c-1', { schema: TRANSCRIPT_SCHEMA - 1, messages: [] }]]);
  assert.match(earlier.message, /^The conversation kept with this history could not be shown: it was saved by an earlier version of Cellucid, which this version cannot read\. It stays with the history as kept\.$/);
  assert.match(earlier.details, /transcript schema/);
  const newer = unreadConversationNotice([['c-1', { schema: TRANSCRIPT_SCHEMA + 1 }], ['c-2', { schema: TRANSCRIPT_SCHEMA }]]);
  assert.match(newer.message, /^2 conversations kept with this history could not be shown: 1 of them was saved by a newer version/);
  const failed = unreadConversationNotice([['c-1', { schema: TRANSCRIPT_SCHEMA }]], new TypeError('A saved conversation has an id and messages'));
  assert.match(failed.message, /could not be shown: a problem inside Cellucid stopped it\. It stays with the history as kept\./);
  assert.match(failed.details, /has an id and messages/);
});

test('a part its owner refused half way is put back to what it showed: "left as it was shown" is true', async () => {
  // As the settings of h5ad-ui-smoke: the slider is set to the saved 100, then its renderer refuses,
  // and the notice must not say the settings were left as shown while the slider shows 100.
  const panel = { slider: 15, scale: 0.35 };
  const domains = createDomainRegistry();
  domains.provide('settings', {
    capture: () => ({ ...panel }),
    restore: value => {
      panel.slider = value.slider;
      if (value.slider === 100) throw new Error('synthetic owner failure');
      panel.scale = value.scale;
    },
  });
  const page = { a: 0 };
  domains.provide('filters', { capture: () => page.a, restore: value => { page.a = value; } });
  for (const id of domains.missing()) domains.provide(id, { capture: () => null, restore: () => {} });
  const dispatcher = createActionDispatcher({ catalog: createActionCatalog([...definitions, ...historyActions]) });
  dispatcher.provide('a.set', ({ v }) => { page.a = v; });
  let t = 0;
  const history = createHistory({
    dispatcher, domains, dataset: { id: 'd1', name: 'Demo', cellOrder: null },
    newTrackerId: () => `t-00000000-0000-4000-8000-${String(++trackers).padStart(12, '0')}`, now: () => ++t * 1000,
  });
  await history.startTracker();
  // A saved head: the slider at 100, a filter of 7.
  const saved = history.snapshot();
  const values = new Map(history.pool.hashes().map(hash => [hash, history.pool.get(hash)]));
  const hundred = await hashValue({ slider: 100, scale: 1 });
  const seven = await hashValue(7);
  values.set(hundred, { slider: 100, scale: 1 });
  values.set(seven, 7);
  const root = saved.trackers[0].steps[0];
  const steps = [{ ...root, after: { ...root.after, settings: hundred, filters: seven } }];
  const result = await history.load({ ...saved, trackers: [{ ...saved.trackers[0], steps }] }, { values });
  assert.deepEqual(result.unrestored.map(part => [part.part, part.domain]), [['domain', 'settings']]);
  assert.equal(page.a, 7, 'the rest is restored');
  assert.deepEqual(panel, { slider: 15, scale: 0.35 }, 'the refused part shows what it showed before, whole');
});
