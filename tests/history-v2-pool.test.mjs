/**
 * The pool keeps only values something refers to. A
 * camera gesture merged into one step keeps one value, not one per change;
 * an action that changed nothing, one that failed and was put back, and the
 * changes made while paused keep none once nothing shows them; a value a
 * reader holds the pool for stays readable until its hold ends.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { makePage, NONE } from './history-fake-page.mjs';
import { defineAction } from '../assets/js/app/actions/catalog.js';
import { referencedHashes } from '../assets/js/app/history/tree.js';
import { createValuePool } from '../assets/js/app/history/value-pool.js';

function loose(history) {
  const referenced = new Set([...Object.values(history.shownHashes()), ...Object.values(history.headHashes())]);
  for (const tracker of history.allTrackers()) referencedHashes(tracker, referenced);
  return history.pool.hashes().filter(hash => !referenced.has(hash));
}

test('a camera gesture of 200 changes merged into one step keeps one value', async () => {
  const { history, step } = await makePage();
  const before = history.pool.size;
  for (let v = 1; v <= 200; v++) await step('cam.set', { v });
  assert.equal(history.active.steps.size, 2);
  assert.equal(history.pool.size - before, 1);
  assert.deepEqual(loose(history), []);
});

test('an action that changed nothing, and one that failed and was put back, keep nothing', async () => {
  const failing = defineAction({ type: 'b.break', title: 'Break b', summary: 'Changes b, then fails.', group: 'T', params: NONE, touches: ['colors'], reads: [], effect: 'state', describe: () => 'break', code: () => 'brk()' });
  const { page, history, act, step } = await makePage({
    extra: [failing],
    provide: (dispatcher, fake) => dispatcher.provide('b.break', () => { fake.state.b = 99; throw new Error('It broke.'); }),
  });
  await step('a.set', { v: 1 });
  const size = history.pool.size;
  assert.equal(await step('a.set', { v: 1 }), null, 'nothing changed: no step');
  await assert.rejects(act('b.break'), /It broke/);
  assert.equal(page.state.b, 0, 'put back');
  assert.equal(history.pool.size, size);
  assert.deepEqual(loose(history), []);
});

test('changes made while paused keep only the values shown', async () => {
  const { history, act } = await makePage();
  await act('history.recording.pause');
  for (let v = 1; v <= 50; v++) await act('a.set', { v });
  assert.deepEqual(loose(history), []);
  await act('history.recording.resume');
  assert.deepEqual(loose(history), []);
});

test('a value released while a reader holds the pool stays readable until the hold ends', async () => {
  const pool = createValuePool();
  const { hash, added } = await pool.putNew({ v: 1 });
  assert.equal(added, true);
  const end = pool.hold();
  pool.release(hash);
  assert.deepEqual(pool.get(hash), { v: 1 });
  end();
  assert.equal(pool.has(hash), false);
  assert.throws(() => pool.get(hash), /no value/);
  // A value released and captured again before the hold ends counts as new again.
  const again = await pool.putNew({ v: 2 });
  const end2 = pool.hold();
  pool.release(again.hash);
  assert.equal((await pool.putNew({ v: 2 })).added, true);
  end2();
  assert.equal(pool.has(again.hash), true);
});
