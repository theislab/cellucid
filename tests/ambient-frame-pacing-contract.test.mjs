/**
 * The ambient frame pacer (`rendering/ambient-frame-pacing.js`): its rule on
 * a fake clock, then the viewer's loop on a simulated event loop with frames
 * that each hold the main thread 450 ms, as a software renderer's do on the
 * Linux CI runners.
 *
 * The simulation is a browser's main thread: one task or one rendering
 * update at a time, timers that queue a task when they fire, and animation
 * frames at display intervals. It runs in two orders, because engines
 * differ: tasks queued during a frame run before the next animation frame
 * (Chromium on an idle page), or the next animation frame runs first
 * (Firefox once a display interval has passed, every engine once rendering
 * has waited behind tasks). A pacer that decided an ambient frame from the
 * frame before the last one drew pulse frames back to back in the second
 * order (Firefox: 450 ms frames in pairs, the page held 900 ms at a time).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createAmbientFramePacer } from '../assets/js/rendering/ambient-frame-pacing.js';

/** A pacer on a fake clock, with the after-frame tasks and timers in hand. */
function harness() {
  let clock = 0;
  const afterFrame = [];
  const timers = new Map();
  let nextTimer = 1;
  const pacer = createAmbientFramePacer({
    now: () => clock,
    afterFrame: callback => afterFrame.push(callback),
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
    frameTasksRun() {
      for (const callback of afterFrame.splice(0)) callback();
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

test('before any frame is drawn an ambient frame is due', () => {
  const { pacer } = harness();
  assert.equal(pacer.isDue(0), true);
  assert.deepEqual({ ...pacer.snapshot() }, { lastFrameCostMs: 0, measuring: false, msUntilDue: 0, wakePending: false });
});

test('nothing is due while a drawn frame is being measured', () => {
  const h = harness();
  h.pacer.frameDrawn(0);
  // However long it has been: the measurement has not answered.
  assert.equal(h.pacer.isDue(10_000), false);
  assert.equal(h.pacer.snapshot().measuring, true);
  assert.equal(h.pacer.snapshot().msUntilDue, null);
});

test('a cheap frame leaves the next display frame due', () => {
  const h = harness();
  h.pacer.frameDrawn(h.now);
  h.advance(2);
  h.frameTasksRun();
  assert.equal(h.pacer.isDue(16.7), true);
  assert.equal(h.pacer.snapshot().lastFrameCostMs, 2);
});

test('an expensive frame is matched by as much free time before the next ambient frame', () => {
  const h = harness();
  h.pacer.frameDrawn(h.now);
  h.advance(450);
  h.frameTasksRun();
  assert.equal(h.pacer.isDue(h.now + 16), false);
  assert.equal(h.pacer.isDue(h.now + 449), false);
  assert.equal(h.pacer.isDue(h.now + 450), true);
  assert.equal(h.pacer.snapshot().msUntilDue, 450);
});

test('frames drawn before their task runs are measured together, from the first', () => {
  const h = harness();
  h.pacer.frameDrawn(0);
  h.advance(30);
  h.pacer.frameDrawn(30);
  h.advance(20);
  // The first frame's task runs after the second frame: it settles nothing,
  // the latest frame's does, and the span is both frames.
  h.frameTasksRun();
  assert.equal(h.pacer.snapshot().measuring, false);
  assert.equal(h.pacer.snapshot().lastFrameCostMs, 50);
  assert.equal(h.pacer.isDue(99), false);
  assert.equal(h.pacer.isDue(100), true);
});

test('the wake is armed once the measurement answers, comes when due, once', () => {
  const h = harness();
  h.pacer.frameDrawn(h.now);
  let wakes = 0;
  h.pacer.wakeWhenDue(() => { wakes += 1; });
  // Still measuring: no timer yet, but the wake is kept.
  assert.equal(h.timers.size, 0);
  assert.equal(h.pacer.snapshot().wakePending, true);
  h.advance(100);
  h.frameTasksRun();
  assert.equal(h.timers.size, 1);
  h.pacer.wakeWhenDue(() => { wakes += 1; });
  assert.equal(h.timers.size, 1);
  h.advance(99);
  h.fireTimers();
  assert.equal(wakes, 0);
  h.advance(1);
  h.fireTimers();
  assert.equal(wakes, 1);
  assert.equal(h.pacer.snapshot().wakePending, false);
  assert.equal(h.timers.size, 0);
});

test('a drawn frame drops the wake asked for before it; cancelWake and dispose drop it too', () => {
  const h = harness();
  h.pacer.frameDrawn(0);
  h.advance(100);
  h.frameTasksRun();
  let wakes = 0;
  h.pacer.wakeWhenDue(() => { wakes += 1; });
  assert.equal(h.timers.size, 1);
  // A change is drawn at once: the loop it armed asks again if it must.
  h.pacer.frameDrawn(h.now);
  assert.equal(h.timers.size, 0);
  assert.equal(h.pacer.snapshot().wakePending, false);
  h.advance(10);
  h.frameTasksRun();
  assert.equal(h.timers.size, 0);

  h.pacer.wakeWhenDue(() => { wakes += 1; });
  assert.equal(h.timers.size, 1);
  h.pacer.cancelWake();
  assert.equal(h.timers.size, 0);
  assert.equal(h.pacer.snapshot().wakePending, false);

  h.pacer.wakeWhenDue(() => { wakes += 1; });
  h.pacer.dispose();
  assert.equal(h.timers.size, 0);
  h.advance(1000);
  h.fireTimers();
  h.pacer.frameDrawn(h.now);
  h.frameTasksRun();
  assert.equal(wakes, 0);
});

test('the pacer refuses clocks, timers and wakes that are not functions', () => {
  assert.throws(() => createAmbientFramePacer({ now: 0 }), TypeError);
  assert.throws(() => createAmbientFramePacer({ setTimer: null }), TypeError);
  assert.throws(() => createAmbientFramePacer({ afterFrame: 'soon' }), TypeError);
  assert.throws(() => createAmbientFramePacer().wakeWhenDue(null), TypeError);
});

/**
 * A browser main thread on a virtual clock, running the viewer's frame
 * decision (`render()` in `rendering/viewer.js`) for a scene whose only
 * cause is the pulse.
 *
 * @param {object} options
 * @param {number} options.frameMs - What a drawn frame holds the main thread
 * @param {boolean} options.renderFirst - Whether a due animation frame runs
 *   before queued tasks
 * @param {number} options.untilMs - How long to run
 * @param {Array<{at: number, ms: number}>} [options.tasks] - Other work:
 *   a task queued at `at` that holds the main thread `ms`
 * @param {Array<number>} [options.invalidations] - Times a change asks for
 *   a frame (drawn at once, whatever the pulse)
 * @param {number} [options.pulseEndsAt] - When the highlight is cleared
 */
function simulate({ frameMs, renderFirst, untilMs, tasks = [], invalidations = [], pulseEndsAt = Infinity }) {
  const VSYNC_MS = 1000 / 60;
  let clock = 0;
  const queue = [];
  const timers = [];
  let rafs = [];
  const frames = [];
  const busy = [];
  const done = [];
  const external = [...tasks].sort((a, b) => a.at - b.at);
  const changes = [...invalidations].sort((a, b) => a - b);

  const pacer = createAmbientFramePacer({
    now: () => clock,
    afterFrame: callback => queue.push({ run: callback }),
    setTimer: (callback, ms) => {
      const timer = { at: clock + ms, callback };
      timers.push(timer);
      return timer;
    },
    clearTimer: timer => {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
  });

  // The viewer: armed at most once; a frame re-arms before it draws.
  let armed = false;
  let invalidated = false;
  const arm = () => {
    if (armed) return;
    armed = true;
    rafs.push(render);
  };
  function render() {
    armed = false;
    const pulsing = clock < pulseEndsAt;
    const cause = invalidated ? 'invalidated' : pulsing ? 'highlight' : null;
    if (cause === 'highlight' && !pacer.isDue(clock)) {
      pacer.wakeWhenDue(arm);
      return;
    }
    if (cause === null) {
      pacer.cancelWake();
      return;
    }
    invalidated = false;
    arm();
    pacer.frameDrawn(clock);
    frames.push({ start: clock, end: clock + frameMs, cause });
    hold(frameMs, cause);
  }
  function hold(ms, what) {
    if (ms > 0) busy.push({ start: clock, end: clock + ms, what });
    clock += ms;
  }

  arm();
  let nextVsync = 0;
  while (clock < untilMs) {
    // Work that arrives from outside (worker replies, input) joins the queue.
    while (external.length > 0 && external[0].at <= clock) {
      const task = external.shift();
      queue.push({ run: () => { hold(task.ms, 'task'); done.push({ at: task.at, end: clock }); } });
    }
    while (changes.length > 0 && changes[0] <= clock) {
      changes.shift();
      queue.push({ run: () => { invalidated = true; arm(); } });
    }
    for (const timer of [...timers]) {
      if (timer.at <= clock) {
        timers.splice(timers.indexOf(timer), 1);
        queue.push({ run: timer.callback });
      }
    }
    const frameDue = rafs.length > 0 && clock >= nextVsync;
    if (frameDue && (renderFirst || queue.length === 0)) {
      const callbacks = rafs;
      rafs = [];
      for (const callback of callbacks) callback();
      nextVsync = Math.max(nextVsync + VSYNC_MS, clock);
      continue;
    }
    if (queue.length > 0) {
      queue.shift().run();
      continue;
    }
    // Idle until the next thing that can happen.
    const next = Math.min(
      rafs.length > 0 ? Math.max(nextVsync, clock) : Infinity,
      ...timers.map(timer => timer.at),
      external.length > 0 ? external[0].at : Infinity,
      changes.length > 0 ? changes[0] : Infinity,
      untilMs,
    );
    if (rafs.length > 0 && clock >= nextVsync) nextVsync = clock;
    clock = Math.max(clock, next);
  }
  return { frames, busy, done, pacer, armed: () => armed, timers };
}

const FRAME_MS = 450;
const VSYNC_SLACK_MS = 2 * (1000 / 60);

for (const renderFirst of [false, true]) {
  const order = renderFirst ? 'animation frames before tasks' : 'tasks before animation frames';

  test(`450 ms pulse frames, ${order}: never back to back, never starved`, () => {
    const { frames } = simulate({ frameMs: FRAME_MS, renderFirst, untilMs: 20_000 });
    assert.ok(frames.length >= 18, `pulse frames drawn in 20 s: ${frames.length}`);
    for (let index = 1; index < frames.length; index++) {
      const free = frames[index].start - frames[index - 1].end;
      // The main thread is free at least as long as the frame held it ...
      assert.ok(free >= FRAME_MS, `free before pulse frame ${index}: ${free} ms`);
      // ... and the next pulse frame comes within that and two display frames.
      assert.ok(free <= FRAME_MS + VSYNC_SLACK_MS, `wait before pulse frame ${index}: ${free} ms`);
    }
  });

  test(`450 ms pulse frames under a queue of worker replies, ${order}: the replies run, the pulse goes on`, () => {
    // An analysis: a reply every 20 ms for 10 s, each 5 ms of main-thread work.
    const tasks = Array.from({ length: 500 }, (_, index) => ({ at: 1000 + index * 20, ms: 5 }));
    const { frames, done } = simulate({ frameMs: FRAME_MS, renderFirst, untilMs: 12_000, tasks });
    assert.equal(done.length, tasks.length, 'every reply ran');
    // A reply waits for at most the one frame in its way and the replies queued before it.
    const longestWait = Math.max(...done.map(task => task.end - task.at));
    assert.ok(longestWait <= FRAME_MS + VSYNC_SLACK_MS + 5 * 30, `longest reply wait: ${longestWait} ms`);
    for (let index = 1; index < frames.length; index++) {
      const free = frames[index].start - frames[index - 1].end;
      assert.ok(free >= FRAME_MS, `free before pulse frame ${index}: ${free} ms`);
      // The measurement waits behind the replies queued before it: a few at most.
      assert.ok(free <= FRAME_MS + VSYNC_SLACK_MS + 5 * 30, `wait before pulse frame ${index}: ${free} ms`);
    }
    const during = frames.filter(frame => frame.start >= 1000 && frame.start < 11_000);
    assert.ok(during.length >= 9, `pulse frames during the analysis: ${during.length}`);
  });

  test(`a change is drawn at once while a pulse frame waits, ${order}, and the pulse waits for it too`, () => {
    const { frames } = simulate({
      frameMs: FRAME_MS,
      renderFirst,
      untilMs: 6000,
      invalidations: [700, 2300, 2310],
    });
    for (const at of [700, 2300]) {
      const drawn = frames.find(frame => frame.cause === 'invalidated' && frame.start >= at);
      assert.ok(drawn !== undefined, `the change at ${at} ms was drawn`);
      // Drawn as soon as the frame in progress (if any) and the next display frame allow.
      assert.ok(drawn.start - at <= FRAME_MS + VSYNC_SLACK_MS, `change at ${at} ms drawn after ${drawn.start - at} ms`);
    }
    for (let index = 1; index < frames.length; index++) {
      if (frames[index].cause !== 'highlight') continue;
      const free = frames[index].start - frames[index - 1].end;
      assert.ok(free >= FRAME_MS, `free before pulse frame ${index}: ${free} ms`);
    }
  });

  test(`a pulse that ends leaves nothing owed, ${order}: the loop stops and no wake remains`, () => {
    const result = simulate({ frameMs: FRAME_MS, renderFirst, untilMs: 8000, pulseEndsAt: 3000 });
    const last = result.frames.at(-1);
    assert.ok(last.start < 3000, `no pulse frame after the pulse ended: ${last.start}`);
    assert.equal(result.armed(), false);
    assert.equal(result.timers.length, 0);
    assert.equal(result.pacer.snapshot().wakePending, false);
    assert.equal(result.pacer.snapshot().measuring, false);
  });
}

test('a cheap frame paces nothing: the pulse draws every display frame', () => {
  const { frames } = simulate({ frameMs: 2, renderFirst: false, untilMs: 1000 });
  assert.ok(frames.length >= 55, `pulse frames in 1 s: ${frames.length}`);
});
