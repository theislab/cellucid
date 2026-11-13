/**
 * Restoring from Recently deleted. An exact restore is
 * tried on the records, checked whole and kept only when valid (else the
 * entry is restored as new); a step added below one since and a move since
 * leave it exact. Undoing a rename whose old name was taken since is
 * refused with the name to use instead. A restore as new applies
 * every removed step again (a squash's run in full, from its before-patch),
 * hangs a sub-branch on its restored parent, says the branch it made and
 * the report, and is itself journaled, so it can be undone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { beforeInvariantBreaks, historyProblem, makePage } from './history-fake-page.mjs';
import { branchSteps, valuesAt } from '../assets/js/app/history/tree.js';

for (const kind of ['branch', 'group', 'bookmark', 'tracker']) {
  test(`undoing a ${kind} rename whose old name another ${kind} took since is refused with the name to use instead`, async () => {
    const { history, act, step } = await makePage();
    const s1 = await step('a.set', { v: 1 });
    const s2 = await step('a.set', { v: 2 });
    await history.jump(s1.id);
    const s3 = await step('b.inc');
    let entry;
    let taken;
    if (kind === 'branch') {
      const other = history.active.steps.get(s3.id).branch;
      entry = (await act('history.branch.rename', { branch: 'b0', name: 'Renamed' })).journal;
      await act('history.branch.rename', { branch: other, name: 'Main' });
      taken = 'Main';
    } else if (kind === 'group') {
      await act('history.group.create', { from: s1.id, to: s1.id, name: 'QC' });
      await act('history.group.create', { from: s3.id, to: s3.id, name: 'Other' });
      entry = (await act('history.group.rename', { group: 'QC', name: 'Renamed' })).journal;
      await act('history.group.rename', { group: 'Other', name: 'QC' });
      taken = 'QC';
    } else if (kind === 'bookmark') {
      await act('history.bookmark.set', { step: s1.id, name: 'Mark' });
      entry = (await act('history.bookmark.set', { step: s1.id, name: null })).journal;
      await act('history.bookmark.set', { step: s2.id, name: 'Mark' });
      taken = 'Mark';
    } else {
      const first = history.active.id;
      await act('history.tracker.start', { start: 'shown', name: 'Two' });
      entry = (await act('history.tracker.rename', { tracker: first, name: 'Renamed' })).journal;
      await act('history.tracker.rename', { tracker: 'Two', name: 'Tracker 1' });
      await act('history.tracker.use', { tracker: first });
      taken = 'Tracker 1';
    }
    const before = JSON.stringify(history.snapshot());
    const refusal = await act('history.journal.undo', { entry }).catch(error => error);
    assert.equal(refusal.code, 'name-taken');
    assert.match(refusal.message, new RegExp(`already called "${taken}".*Rename to "${taken} \\(restored\\)"`));
    assert.deepEqual(refusal.suggestion, { name: `${taken} (restored)` });
    assert.equal(JSON.stringify(history.snapshot()), before, 'a refused restore changes nothing');
    assert.equal(historyProblem(history), null);
  });
}

test('an older entry whose exact restore would not be a valid history is restored as new, never half done', async () => {
  // The group entry's run names a step a later delete took out: putting the run back cannot hold.
  const { history, act, step } = await makePage();
  await step('a.set', { v: 1 });
  const s2 = await step('b.inc');
  await step('b.inc');
  const grouped = await act('history.group.create', { from: s2.id, to: s2.id, name: 'G' });
  const removed = await act('history.group.remove', { group: 'G' });
  await act('history.step.delete', { step: s2.id });
  const result = await act('history.journal.undo', { entry: removed.journal });
  assert.equal(result.restored, 'as-new');
  assert.equal(historyProblem(history), null);
  assert.ok(grouped.journal);
});

test('a deleted branch is restored exactly after a move elsewhere, and after a step added below its fork', async () => {
  const { history, act, step } = await makePage();
  const s1 = await step('a.set', { v: 1 });
  await step('a.set', { v: 2 });
  await history.jump(s1.id);
  const x = await step('b.inc');
  const branch = history.active.steps.get(x.id).branch;
  const deleted = await act('history.branch.delete', { branch });
  await history.undo();
  await history.jump(s1.id);
  // Another branch from the same fork step: the fork's children changed, nothing the delete made did.
  await step('cam.set', { v: 3 });
  const head = history.active.headId;
  const result = await act('history.journal.undo', { entry: deleted.journal });
  assert.equal(result.restored, 'exact');
  const tracker = history.active;
  assert.equal(tracker.headId, head, 'the head a move took elsewhere stays');
  assert.ok(tracker.steps.has(x.id));
  assert.ok(tracker.steps.get(s1.id).children.includes(x.id) && tracker.steps.get(s1.id).children.includes(head));
  assert.equal(historyProblem(history), null);
});

test('a squash restored as new brings every squashed step back, ending where the run ended', async () => {
  const { history, act, step } = await makePage();
  const s1 = await step('a.set', { v: 1 });
  await step('a.set', { v: 2 });
  const s3 = await step('b.inc');
  const squash = await act('history.squash', { from: s1.id, to: s3.id });
  // A note on the squashed step changes what the squash made: the restore cannot be exact.
  await act('history.note.add', { target: { step: squash.step }, text: 'kept' });
  const result = await act('history.journal.undo', { entry: squash.journal });
  const tracker = history.active;
  assert.equal(result.restored, 'as-new');
  assert.ok(result.branch !== null);
  assert.deepEqual(branchSteps(tracker, result.branch.id).map(each => each.label), ['a = 1', 'a = 2', 'b + 1']);
  assert.deepEqual(result.report.map(entry => entry.outcome), ['applied', 'applied', 'applied']);
  assert.deepEqual(valuesAt(tracker, tracker.branches.get(result.branch.id).tip), valuesAt(tracker, squash.step));
  assert.equal(historyProblem(history), null);
  assert.deepEqual(beforeInvariantBreaks(tracker), []);
});

test('a deleted branch with a sub-branch restored as new: the sub-branch lands on its restored parent', async () => {
  const { history, act, step } = await makePage();
  const s1 = await step('a.set', { v: 1 });
  await step('a.set', { v: 2 });
  await history.jump(s1.id);
  const x1 = await step('b.inc');
  const x2 = await step('b.inc');
  await step('a.set', { v: 7 });
  await history.jump(x2.id);
  const y1 = await step('c.derive');
  const expected = history.pool.get(valuesAt(history.active, y1.id).analysis);
  const xBranch = history.active.steps.get(x1.id).branch;
  await history.jump('s2');
  const deleted = await act('history.branch.delete', { branch: xBranch, with_sub_branches: true });
  // A note on the fork step changes a record the delete made: the restore is made as new.
  await act('history.note.add', { target: { step: s1.id }, text: 'changed' });
  const result = await act('history.journal.undo', { entry: deleted.journal });
  const tracker = history.active;
  assert.equal(result.restored, 'as-new');
  const derive = [...tracker.steps.values()].filter(each => each.label === 'c = 10a + b');
  assert.equal(derive.length, 1);
  assert.equal(history.pool.get(valuesAt(tracker, derive[0].id).analysis), expected, 'computed on its restored parent\'s values');
  const parent = tracker.steps.get(derive[0].parent);
  assert.equal(parent.label, 'b + 1');
  assert.ok(idNumber(parent.id) > idNumber(y1.id), 'its parent is the restored step, not an old one');
  assert.equal(historyProblem(history), null);
});

test('a restore as new is journaled with what it made, so it can be undone exactly', async () => {
  const { history, act, step } = await makePage();
  const s1 = await step('a.set', { v: 1 });
  await step('b.inc');
  const deleted = await act('history.step.delete', { step: s1.id });
  await act('history.note.add', { target: { step: history.active.rootId }, text: 'changed' });
  const before = history.snapshot();
  const restored = await act('history.journal.undo', { entry: deleted.journal });
  assert.equal(restored.restored, 'as-new');
  assert.ok(history.active.steps.size > before.trackers[0].steps.length);
  const undone = await act('history.journal.undo', { entry: restored.journal });
  assert.equal(undone.restored, 'exact');
  const now = history.snapshot();
  assert.deepEqual(now.trackers[0].steps, before.trackers[0].steps, 'the steps it made are gone again');
  assert.equal(historyProblem(history), null);
});

function idNumber(id) {
  return Number(id.slice(1));
}
