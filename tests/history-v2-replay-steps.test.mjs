/**
 * Replaying steps of this dataset. A
 * replayed revert reverts the step the replay made of the one it names (a
 * step the replay did not make is flagged, with the reason); a squashed
 * step (paused, merged, cleared) and an outside change put their values
 * back on the dataset they were recorded on, so Verify of a branch holding
 * them reproduces; Verify never moves a domain switched off.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { historyProblem, makePage } from './history-fake-page.mjs';
import { replayPlanOf } from '../assets/js/app/history/replay.js';
import { defineAction } from '../assets/js/app/actions/catalog.js';
import { ActionRefused } from '../assets/js/app/actions/dispatcher.js';

test('a replayed revert reverts the replayed counterpart of the step it names', async () => {
  const { page, history, act, step } = await makePage();
  await step('a.set', { v: 5 });
  await history.undo();
  const s2 = await step('a.set', { v: 1 });
  await step('b.inc');
  await act('history.step.revert', { step: s2.id });
  assert.deepEqual([page.state.a, page.state.b], [0, 1]);
  const plan = replayPlanOf(history.snapshot(), { branch: history.active.activeBranch });
  await history.jump(history.active.rootId);
  const { report } = await history.replay({ ...plan, name: 'Again' });
  assert.deepEqual(report.map(entry => entry.outcome), ['applied', 'applied', 'applied']);
  assert.deepEqual([page.state.a, page.state.b], [0, 1]);
  const revert = history.active.steps.get(report[2].step);
  assert.equal(revert.params.step, report[0].step, 'it names the step the replay made');
});

test('a replayed revert of a step the replay left out is flagged, saying which', async () => {
  const { history, act, step } = await makePage();
  const s1 = await step('a.set', { v: 1 });
  await step('b.inc');
  await act('history.step.revert', { step: s1.id });
  // "Branch without" step 1: the revert names the step left out.
  const result = await act('history.branch.without', { step: s1.id });
  const flagged = result.report.find(entry => entry.label.startsWith('Reverted'));
  assert.equal(flagged.outcome, 'unmatched');
  assert.match(flagged.reason, /step 1\b.*not applied again/);
  assert.equal(historyProblem(history), null);
});

test('verify of a branch with paused, merged and cleared steps reproduces it', async () => {
  const { history, act, step } = await makePage();
  await step('a.set', { v: 1 });
  await act('history.recording.pause');
  await act('b.inc');
  await act('history.recording.resume');
  const s3 = await step('a.set', { v: 2 });
  const s4 = await step('c.derive');
  await act('history.squash', { from: s3.id, to: s4.id });
  await act('history.clear', { keep_state: true });
  await step('b.inc');
  const kinds = new Set([...history.active.steps.values()].map(each => each.squashed?.cause).filter(Boolean));
  assert.deepEqual([...kinds].sort(), ['clear', 'paused', 'steps']);
  for (const branch of history.active.branches.values()) {
    const verified = await act('history.verify', { branch: branch.id });
    assert.equal(verified.reproduced, true, `${branch.name}: ${JSON.stringify(verified.domains)}`);
  }
  assert.equal(historyProblem(history), null);
});

test('verify with the camera switched off never moves the camera', async () => {
  let cameraOff = false;
  const { page, act, step } = await makePage({ offDomains: () => (cameraOff ? ['camera'] : []) });
  await step('cam.set', { v: 3 });
  await step('a.set', { v: 1 });
  cameraOff = true;
  // The camera moved while its recording is off: no step, and the history never moves it back.
  assert.equal(await step('cam.set', { v: 42 }), null);
  const verified = await act('history.verify', { branch: 'Main' });
  assert.equal(verified.reproduced, true);
  assert.equal(page.state.cam, 42);
  const kept = await act('history.verify', { branch: 'Main', keep: true });
  assert.ok(kept.scratch !== null);
  assert.equal(page.state.cam, 42);
});

test('a replayed step whose name resolves to nothing here says which name, for "Use instead"', async () => {
  const hide = defineAction({
    type: 'category.hide', title: 'Hide a category', summary: 'x', group: 'T',
    params: { type: 'object', additionalProperties: false, required: ['label'], properties: { label: { type: 'string' } } },
    touches: ['filters'], reads: [], effect: 'state', describe: p => `Hid ${p.label}`, code: p => `hide(${JSON.stringify(p.label)})`,
  });
  let known = ['alpha'];
  const { history, step } = await makePage({
    extra: [hide],
    provide: (dispatcher, fake) => dispatcher.provide('category.hide', ({ label }) => {
      if (!known.includes(label)) {
        throw new ActionRefused(`There is no category "${label}" in leiden.`, { code: 'no-such-category', missing: { kind: 'category', name: label, field: 'leiden' } });
      }
      fake.state.a += 1;
    }),
  });
  await step('category.hide', { label: 'alpha' });
  await step('b.inc');
  const plan = replayPlanOf(history.snapshot());
  known = ['beta'];
  const { report } = await history.replay({ ...plan, name: 'Elsewhere' });
  assert.deepEqual(report.map(entry => [entry.outcome, entry.missing]), [
    ['unmatched', { kind: 'category', name: 'alpha', field: 'leiden' }],
    ['applied', null],
  ]);
  assert.equal(historyProblem(history), null, 'the report is kept in the replay tracker\'s start, valid');
});

test('the target resolvers name what they did not find', async () => {
  const { resolveCategory } = await import('../assets/js/app/actions/targets/fields.js');
  const refusal = (() => { try { resolveCategory({ key: 'leiden', categories: ['0', '1'] }, '7'); } catch (error) { return error; } return null; })();
  assert.equal(refusal.code, 'no-such-category');
  assert.deepEqual(refusal.missing, { kind: 'category', name: '7', field: 'leiden' });
});

test('verify whose first state cannot be shown gives no verdict, in a sentence, its cause kept', async () => {
  const { page, act, step } = await makePage();
  await step('a.set', { v: 1 });
  await step('a.set', { v: 2 });
  const filters = page.domains.owner('filters');
  const restore = filters.restore;
  const unreadable = Object.assign(new Error('The open file could not be read again.'), { code: 'NETWORK_ERROR' });
  filters.restore = value => { if (value === 0) throw unreadable; return restore(value); };
  await assert.rejects(act('history.verify', { branch: 'Main' }), error => {
    assert.equal(error.name, 'ActionRefused');
    assert.match(error.message, /^"Main" was not verified, because the state it starts from could not be shown: /);
    assert.equal(error.reason, unreadable, 'kept for Details, not chained into the sentence');
    assert.equal(error.message.match(/could not be read again/g)?.length ?? 0, 1);
    return true;
  });
  assert.equal(page.state.a, 2, 'what was shown stays');
});
