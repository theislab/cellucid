/**
 * What the history would refuse of an agent is refused before the person is
 * asked. A squash of the person's Ins1 and Gcg colorings must not show the
 * card "asks to merge steps into one … It deletes something saved in this
 * browser", be allowed, and then be refused: "An agent squashes only its own
 * turn's steps". The history's estimate of a squash or a branch delete runs
 * the same checks as its implementation (`provideEstimate`; an estimate that
 * throws a refusal refuses the action there), so the person is never asked
 * about what will not happen; one that passes is asked, with what it does.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { makePage } from './history-fake-page.mjs';

const AGENT = { origin: 'agent', agent: 'Claude', turn: 'turn-1', turnLabel: 'Tidy up' };

async function asked() {
  const page = await makePage();
  const cards = [];
  page.dispatcher.setConfirmer(async ({ definition, estimate, confirm }) => {
    cards.push({ type: definition.type, confirm, what: estimate?.what ?? null });
    return true;
  });
  return { ...page, cards };
}

test('a squash of steps the agent did not take is refused before the person is asked', async () => {
  const { act, step, cards } = await asked();
  const s1 = await step('a.set', { v: 1 });
  const s2 = await step('b.inc');
  await assert.rejects(act('history.squash', { from: s1.id, to: s2.id }, AGENT), error => error.code === 'not-author');
  assert.deepEqual(cards, []);
});

test('a squash of the agent\'s own turn is asked about, saying what it merges', async () => {
  const { act, step, cards, history } = await asked();
  const s1 = await step('a.set', { v: 1 }, AGENT);
  const s2 = await step('b.inc', {}, AGENT);
  await act('history.squash', { from: s1.id, to: s2.id }, AGENT);
  assert.deepEqual(cards.filter(card => card.type === 'history.squash'), [{ type: 'history.squash', confirm: 'deletes-saved', what: 'merges 2 steps into one' }]);
  assert.equal(history.active.steps.get(s2.id).kind, 'squashed');
});

test('deleting a branch that is not there is refused before the person is asked', async () => {
  const { act, step, cards } = await asked();
  await step('a.set', { v: 1 });
  await assert.rejects(act('history.branch.delete', { branch: 'Nowhere' }, AGENT), error => error.code === 'no-target');
  assert.deepEqual(cards, []);
});

test('replaying a saved state is priced by the time its steps took when recorded, and asked about before it starts', async () => {
  const source = await makePage();
  await source.step('a.set', { v: 1 });
  await source.step('c.derive');
  const saved = source.history.snapshot();
  const values = new Map(source.history.pool.hashes().map(hash => [hash, source.history.pool.get(hash)]));
  const recorded = saved.trackers[0].steps.filter(step => step.parent !== null);
  const reads = { opened: 0, cancelled: 0 };
  const openSaved = async id => {
    if (id !== 'state-1') throw new RangeError(`There is no saved state "${id}"`);
    reads.opened++;
    return {
      readEager: async () => ({ history: structuredClone(saved), values }),
      readRest: async () => ({ values: new Map(), chats: [], journals: [], params: [] }),
      cancel: async () => { reads.cancelled++; },
    };
  };
  const page = await makePage({ openSaved });
  const cards = [];
  page.dispatcher.setConfirmer(async ({ definition, estimate }) => {
    cards.push({ type: definition.type, estimate, replayed: page.history.trackers().length > 1 });
    return true;
  });
  await page.act('history.replay', { saved: 'state-1' }, AGENT);
  const card = cards.find(each => each.type === 'history.replay');
  assert.deepEqual(card.estimate, { ms: recorded.reduce((sum, step) => sum + step.ms, 0), bytes: null, what: 'replays 2 steps' });
  assert.ok(card.estimate.ms > 0, 'the recorded steps took time');
  assert.equal(card.replayed, false, 'asked before anything is replayed');
  assert.equal(reads.cancelled >= 1, true, 'the estimate read only the steps and let the saved state go');
  // A saved state the replay would refuse has no estimate: the replay says why.
  cards.length = 0;
  await assert.rejects(page.act('history.replay', { saved: 'state-9' }, AGENT), /no saved state "state-9"/);
  assert.equal(cards.find(each => each.type === 'history.replay')?.estimate ?? null, null);
});
