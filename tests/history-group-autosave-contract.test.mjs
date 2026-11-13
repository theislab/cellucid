/**
 * A group edit reaches the history kept in this browser. A group made,
 * extended, removed or restored changes its steps' group in place, and the
 * journal records the runs, never the member steps; the history's `edited`
 * event names only the steps an edit kept, so the autosave must write the
 * grouped steps again. A step made later would rewrite its parent with the
 * group and leave the steps before it without one, and Continue after a
 * reload would refuse the whole history ("a group cuts the run of turn …
 * between steps s5 and s6": an agent's two branch steps grouped as
 * "Hormone-only comparison" on Pancreas).
 *
 * Driven through the real history controller (`history-fake-page.mjs`) and the
 * real autosave over the in-memory database; the history read back must be
 * the live one and must validate (what Continue loads).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createHistoryStore } from '../assets/js/app/history/autosave-store.js';
import { createAutosave, openSavedState } from '../assets/js/app/history/autosave.js';
import { validateHistory } from '../assets/js/app/history/model.js';
import { makePage } from './history-fake-page.mjs';
import { HEADER } from './helpers/history-records.mjs';
import { manualSchedule, memoryDatabase, sharedLocks } from './helpers/memory-history-database.mjs';

async function kept() {
  const { history, act, step } = await makePage();
  const store = createHistoryStore(memoryDatabase());
  const writes = manualSchedule();
  let t = 1_700_000_000_000;
  const autosave = createAutosave({
    history, dataset: { id: 'd1', name: 'Demo' }, store, enabled: () => true, onQuotaExceeded: () => {},
    header: async () => HEADER, schedule: writes.schedule, now: () => (t += 1000), locks: sharedLocks(),
  });
  await writes.run();
  /** What Continue would load now: valid, and the live history exactly. */
  const continued = async () => {
    await writes.run();
    const source = await openSavedState(autosave.entryId, store);
    const { history: loaded } = await source.readEager();
    validateHistory(loaded);
    assert.deepEqual(loaded, history.snapshot());
  };
  return { history, act, step, continued };
}

const agent = turn => ({ origin: 'agent', agent: 'Claude', turn, turnLabel: 'Branch comparison' });

test('a group made over a turn\'s steps is kept with them, before and after a later step', async () => {
  const { history, act, step, continued } = await kept();
  await step('a.set', { v: 1 });
  const s2 = await step('b.inc', {}, agent('turn-1'));
  const s3 = await step('c.derive', {}, agent('turn-1'));
  await continued();
  const made = await act('history.group.create', { from: s2.id, to: s3.id, name: 'Hormone-only comparison' });
  await continued();
  await step('a.set', { v: 2 });
  await continued();
  assert.equal(history.active.steps.get(s2.id).group, made.group.id);
});

test('extending, removing and restoring a group keep every member step', async () => {
  const { history, act, step, continued } = await kept();
  const s1 = await step('a.set', { v: 1 });
  const s2 = await step('b.inc');
  const s3 = await step('c.derive');
  const made = await act('history.group.create', { from: s1.id, to: s2.id, name: 'QC' });
  await act('history.group.extend', { group: 'QC', to: s3.id });
  await continued();
  await act('history.group.remove', { group: made.group.id });
  await continued();
  const removal = history.active.journal.at(-1);
  await act('history.journal.undo', { entry: removal.id });
  await continued();
  assert.equal(history.active.steps.get(s1.id).group, made.group.id);
});
