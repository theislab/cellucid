/**
 * The Cellucid pages of one origin divide the device (`data/memory-census.js`):
 * a page hears of another on a `BroadcastChannel` (what it holds), counts
 * it while its Web Lock is held, and stops counting it the moment the
 * browser grants that lock to someone else (the page is gone) -- no timer.
 * Where Web Locks are missing, a page counts only itself.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { joinMemoryCensus } from '../assets/js/data/memory-census.js';
import { memoryAllowanceBytes, memoryReport, onMemoryChange, resetMemoryModel, setOpenCells } from '../assets/js/data/memory-budget.js';

/** Web Locks, as one browser profile shares them: a request waits while the name is held. */
function lockManager() {
  const held = new Map();
  return {
    async request(name, _options, callback) {
      while (held.has(name)) await held.get(name);
      let release;
      held.set(name, new Promise(resolve => { release = resolve; }));
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
        release();
      }
    },
  };
}

/**
 * The next count of the other pages this page takes (`setOtherInstances`).
 * Channel messages cross threads and arrive after no fixed time (later on
 * Windows), so each step waits for its own event, never for a pause.
 */
const othersCounted = () => new Promise(resolve => {
  const stop = onMemoryChange(reason => {
    if (reason !== 'other pages') return;
    stop();
    resolve();
  });
});

/** The next message `channel` hears that `matches`. */
const heard = (channel, matches) => new Promise(resolve => {
  const listener = event => {
    if (!matches(event.data)) return;
    channel.removeEventListener('message', listener);
    resolve(event.data);
  };
  channel.addEventListener('message', listener);
});

test.beforeEach(() => resetMemoryModel());
test.after(() => resetMemoryModel());

test('another page is counted while it lives, what it holds leaves this page less, and it stops counting once its lock is free', async t => {
  const locks = lockManager();
  const environment = { navigator: { locks }, BroadcastChannel };
  const allowance = memoryAllowanceBytes();
  const leave = joinMemoryCensus(environment);
  t.after(() => leave?.());
  assert.equal(typeof leave, 'function');

  // Another page: its own lock held for its life, its hello on the channel.
  let otherGone;
  void locks.request('cellucid-memory:other', { mode: 'exclusive' }, () => new Promise(resolve => { otherGone = resolve; }));
  const other = new BroadcastChannel('cellucid-memory');
  t.after(() => other.close());
  // The newcomer is told what this page holds.
  const told = heard(other, message => typeof message.held === 'number' && message.hello !== true);
  const met = othersCounted();
  other.postMessage({ id: 'other', hello: true, held: allowance * 0.75 });
  await met;
  assert.equal(memoryReport().instances, 2);
  assert.equal(memoryAllowanceBytes(), allowance / 2, 'at least an equal share of the device');
  assert.equal(typeof (await told).held, 'number', 'the newcomer is told what this page holds');

  // What this page holds is told whenever it changes.
  const toldAgain = heard(other, message => message.held >= 1000 * 77);
  setOpenCells(1000);
  await toldAgain;

  // The other page holds less: this one may use the rest.
  const lessHeld = othersCounted();
  other.postMessage({ id: 'other', held: allowance * 0.25 });
  await lessHeld;
  assert.equal(memoryAllowanceBytes(), Math.floor(allowance * 0.75));

  // It is gone (closed, crashed, discarded): its lock is granted to this page.
  const gone = othersCounted();
  otherGone();
  await gone;
  assert.equal(memoryReport().instances, 1);
  assert.equal(memoryAllowanceBytes(), allowance);
});

test('a page that says goodbye stops being counted at once; leaving tells the others', async t => {
  const locks = lockManager();
  const environment = { navigator: { locks }, BroadcastChannel };
  const leave = joinMemoryCensus(environment);
  const other = new BroadcastChannel('cellucid-memory');
  t.after(() => other.close());
  void locks.request('cellucid-memory:peer', { mode: 'exclusive' }, () => new Promise(() => {}));
  const met = othersCounted();
  other.postMessage({ id: 'peer', hello: true, held: 0 });
  await met;
  assert.equal(memoryReport().instances, 2);
  // The peer's lock stays held: only its goodbye can stop it being counted.
  const parted = othersCounted();
  other.postMessage({ id: 'peer', bye: true });
  await parted;
  assert.equal(memoryReport().instances, 1);
  const goodbye = heard(other, message => message.bye === true);
  leave();
  assert.equal((await goodbye).bye, true, 'leaving says goodbye');
});

test('without Web Locks a page counts only itself', () => {
  assert.equal(joinMemoryCensus({ navigator: {}, BroadcastChannel }), null);
  assert.equal(joinMemoryCensus({ navigator: { locks: lockManager() } }), null);
});
