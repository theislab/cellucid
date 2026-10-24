import assert from 'node:assert/strict';
import test from 'node:test';

import { createAmbientFramePacer } from '../assets/js/rendering/ambient-frame-pacing.js';

/** A pacer on a fake clock, with the after-frame task and timers in hand. */
function harness() {
  let clock = 0;
  const afterFrame = [];
  const timers = new Map();
  let nextTimer = 1;
  const pacer = createAmbientFramePacer({
    now: () => clock,
    afterFrame: () => new Promise(resolve => afterFrame.push(resolve)),
    setTimer: (callback, ms) => {
      const handle = nextTimer++;
      timers.set(handle, { callback, at: clock + ms });
      return handle;
    },
    clearTimer: handle => timers.delete(handle),
  });
  return {
    pacer,
    timers,
    advance(ms) {
      clock += ms;
    },
    get now() {
      return clock;
    },
    /** Run the first task after the drawn frames, at the current time. */
    async frameTasksRun() {
      for (const resolve of afterFrame.splice(0)) resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    fireTimers() {
      for (const [handle, timer] of [...timers]) {
        if (timer.at <= clock) {
          timers.delete(handle);
          timer.callback();
        }
      }
    },
  };
}

test('before any frame is measured an ambient frame is due', () => {
  const { pacer } = harness();
  assert.equal(pacer.isDue(0), true);
});

test('a cheap frame leaves the next display frame due', async () => {
  const h = harness();
  h.pacer.frameDrawn(h.now);
  h.advance(2);
  await h.frameTasksRun();
  // The next display frame comes 16.7 ms after the last; the frame cost 2 ms.
  assert.equal(h.pacer.isDue(16.7), true);
  assert.equal(h.pacer.snapshot().lastFrameCostMs, 2);
});

test('an expensive frame is matched by as much free time before the next ambient frame', async () => {
  const h = harness();
  h.pacer.frameDrawn(h.now);
  h.advance(400);
  await h.frameTasksRun();
  assert.equal(h.pacer.isDue(h.now + 16), false);
  assert.equal(h.pacer.isDue(h.now + 399), false);
  assert.equal(h.pacer.isDue(h.now + 400), true);
  assert.equal(h.pacer.snapshot().msUntilDue, 400);
});

test('two frames before their tasks run: the latest frame sets the wait', async () => {
  const h = harness();
  h.pacer.frameDrawn(0);
  h.advance(30);
  h.pacer.frameDrawn(30);
  h.advance(20);
  await h.frameTasksRun();
  // Both tasks ran at 50; the second frame started at 30, so the next
  // ambient frame waits its 20 ms from 50.
  assert.equal(h.pacer.snapshot().lastFrameCostMs, 20);
  assert.equal(h.pacer.isDue(70), true);
  assert.equal(h.pacer.isDue(69), false);
});

test('the wake comes when the frame is due, once, and not after dispose', async () => {
  const h = harness();
  h.pacer.frameDrawn(h.now);
  h.advance(100);
  await h.frameTasksRun();
  let wakes = 0;
  h.pacer.wakeWhenDue(() => { wakes += 1; });
  h.pacer.wakeWhenDue(() => { wakes += 1; });
  assert.equal(h.timers.size, 1);
  h.advance(99);
  h.fireTimers();
  assert.equal(wakes, 0);
  h.advance(1);
  h.fireTimers();
  assert.equal(wakes, 1);

  h.pacer.wakeWhenDue(() => { wakes += 1; });
  h.pacer.dispose();
  assert.equal(h.timers.size, 0);
  h.advance(1000);
  h.fireTimers();
  assert.equal(wakes, 1);
});

test('the pacer refuses clocks and timers that are not functions', () => {
  assert.throws(() => createAmbientFramePacer({ now: 0 }), TypeError);
  assert.throws(() => createAmbientFramePacer({ setTimer: null }), TypeError);
});
