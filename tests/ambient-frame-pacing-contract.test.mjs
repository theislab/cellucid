/**
 * The ambient frame pacer (`rendering/ambient-frame-pacing.js`): its rules on
 * a fake clock, then the viewer's loop on a simulated browser.
 *
 * The simulation is a browser's main thread and its GPU: one task or one
 * rendering update at a time, timers that queue a task when they fire,
 * animation frames at display intervals, and a GPU that runs each drawn
 * frame's commands after the one before. The browser starts a frame only
 * while fewer than `pipeline` drawn frames are still on the GPU (as
 * Chromium's GPU process holds the page's next frame back), so a GPU slower
 * than the display makes the page's frames late, and the first frames of a
 * burst hide their cost in the pipeline, as SwiftShader's do.
 *
 * It runs in two orders, because engines differ: tasks queued during a
 * frame run before the next animation frame (Chromium on an idle page), or
 * the next animation frame runs first (Firefox once a display interval has
 * passed, every engine once rendering has waited behind tasks). A pacer
 * that decided an ambient frame from the frame before the last one drew
 * pulse frames back to back in the second order (Firefox: 450 ms frames in
 * pairs, the page held 900 ms at a time).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createAmbientFramePacer } from '../assets/js/rendering/ambient-frame-pacing.js';

const VSYNC_MS = 1000 / 60;

/** A pacer on a fake clock, with the after-frame tasks, timers and GPU in hand. */
function harness() {
  let clock = 0;
  const afterFrame = [];
  const timers = new Map();
  let nextTimer = 1;
  let busy = false;
  const pacer = createAmbientFramePacer({
    now: () => clock,
    afterFrame: callback => afterFrame.push(callback),
    gpuBusy: () => busy,
    setTimer: (callback, ms) => {
      const handle = nextTimer++;
      timers.set(handle, { callback, at: clock + ms });
      return handle;
    },
    clearTimer: handle => timers.delete(handle),
  });
  const h = {
    pacer,
    timers,
    advance(ms) {
      clock += ms;
    },
    get now() {
      return clock;
    },
    set gpuBusy(value) {
      busy = value;
    },
    /** Run the first task after the drawn frames, at the current time. */
    frameTasksRun() {
      for (const callback of afterFrame.splice(0)) callback();
    },
    fireTimers() {
      for (const [handle, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= clock && timers.has(handle)) {
          timers.delete(handle);
          timer.callback();
        }
      }
    },
    /** An animation frame starts now, armed by the one before (or not). */
    frame(consecutive = true) {
      pacer.frameStarted(clock, consecutive);
    },
    /** Advance to the next animation frame, firing the timers due on the way. */
    nextFrame(ms = VSYNC_MS, consecutive = true) {
      clock += ms;
      h.fireTimers();
      h.frame(consecutive);
    },
    /** Measure the display interval at `ms`: the GPU idle, nine idle frames. */
    measureInterval(ms = VSYNC_MS) {
      assert.equal(pacer.isDue(clock), false);
      h.fireTimers();
      h.frame(false);
      for (let index = 0; index < 8; index++) h.nextFrame(ms);
      assert.ok(Math.abs(pacer.snapshot().displayIntervalMs - ms) < 1e-9);
    },
  };
  return h;
}

test('before the display interval is measured no ambient frame is due: it is measured first, on an idle GPU', () => {
  const h = harness();
  assert.deepEqual({ ...h.pacer.snapshot() }, {
    lastFrameCostMs: 0,
    measuring: false,
    msUntilDue: 0,
    wakePending: false,
    displayIntervalMs: null,
    measuringInterval: false,
    lastLateMs: 0,
    msUntilGpuKeepsUp: 0,
  });
  h.gpuBusy = true;
  assert.equal(h.pacer.isDue(0), false);
  assert.equal(h.pacer.watchesNextFrame(0), true);
  assert.equal(h.pacer.snapshot().measuringInterval, true);
  // Frames while the GPU still runs the last drawn frame are not the display's.
  h.frame(false);
  for (let index = 0; index < 10; index++) h.nextFrame(40);
  assert.equal(h.pacer.snapshot().displayIntervalMs, null);
  h.gpuBusy = false;
  h.nextFrame(16);
  for (let index = 0; index < 7; index++) h.nextFrame(VSYNC_MS);
  assert.equal(h.pacer.snapshot().displayIntervalMs, null);
  h.nextFrame(VSYNC_MS);
  // The mean of eight periods from the first frame once the GPU was idle.
  assert.ok(Math.abs(h.pacer.snapshot().displayIntervalMs - VSYNC_MS) < 1e-9);
  assert.equal(h.pacer.snapshot().measuringInterval, false);
  assert.equal(h.pacer.isDue(h.now), true);
});

test('a frame drawn while the interval is measured starts it again after that frame', () => {
  const h = harness();
  assert.equal(h.pacer.isDue(0), false);
  h.fireTimers();
  h.frame(false);
  for (let index = 0; index < 5; index++) h.nextFrame();
  h.pacer.frameDrawn(h.now, false);
  assert.equal(h.pacer.snapshot().measuringInterval, false);
  h.advance(2);
  h.frameTasksRun();
  h.nextFrame();
  assert.equal(h.pacer.isDue(h.now), false);
  h.fireTimers();
  for (let index = 0; index < 8; index++) h.nextFrame();
  assert.equal(h.pacer.snapshot().measuringInterval, true);
  h.nextFrame();
  assert.ok(Math.abs(h.pacer.snapshot().displayIntervalMs - VSYNC_MS) < 1e-9);
});

test('nothing is due while a drawn frame is being measured', () => {
  const h = harness();
  h.measureInterval();
  h.pacer.frameDrawn(h.now, true);
  // However long it has been: the measurement has not answered.
  assert.equal(h.pacer.isDue(h.now + 10_000), false);
  assert.equal(h.pacer.watchesNextFrame(h.now + 10_000), false);
  assert.equal(h.pacer.snapshot().measuring, true);
  assert.equal(h.pacer.snapshot().msUntilDue, null);
});

test('a cheap frame leaves the next display frame due', () => {
  const h = harness();
  h.measureInterval();
  h.pacer.frameDrawn(h.now, true);
  h.advance(2);
  h.frameTasksRun();
  assert.equal(h.pacer.isDue(h.now + 14.7), true);
  assert.equal(h.pacer.snapshot().lastFrameCostMs, 2);
});

test('an expensive frame is matched by as much free time before the next ambient frame', () => {
  const h = harness();
  h.measureInterval();
  h.pacer.frameDrawn(h.now, true);
  h.advance(450);
  h.frameTasksRun();
  assert.equal(h.pacer.isDue(h.now + 16), false);
  assert.equal(h.pacer.isDue(h.now + 449), false);
  assert.equal(h.pacer.isDue(h.now + 450), true);
  assert.ok(Math.abs(h.pacer.snapshot().msUntilDue - 450) < 1e-9);
});

test('frames drawn before their task runs are measured together, from the first', () => {
  const h = harness();
  h.measureInterval();
  const start = h.now;
  h.pacer.frameDrawn(start, true);
  h.advance(30);
  h.pacer.frameDrawn(start + 30, true);
  h.advance(20);
  // The first frame's task runs after the second frame: it settles nothing,
  // the latest frame's does, and the span is both frames.
  h.frameTasksRun();
  assert.equal(h.pacer.snapshot().measuring, false);
  assert.equal(h.pacer.snapshot().lastFrameCostMs, 50);
  assert.equal(h.pacer.isDue(start + 99), false);
  assert.equal(h.pacer.isDue(start + 100), true);
});

test('the wake is armed once the measurement answers, comes when due, once', () => {
  const h = harness();
  h.measureInterval();
  h.pacer.frameDrawn(h.now, true);
  let wakes = 0;
  h.pacer.wakeWhenDue(() => { wakes += 1; });
  // Still measuring: no wake timer yet, but the wake is kept.
  assert.equal(h.pacer.snapshot().wakePending, true);
  const timersBefore = h.timers.size;
  h.advance(100);
  h.frameTasksRun();
  assert.equal(h.timers.size, timersBefore + 1);
  h.pacer.wakeWhenDue(() => { wakes += 1; });
  assert.equal(h.timers.size, timersBefore + 1);
  h.advance(99);
  h.fireTimers();
  assert.equal(wakes, 0);
  h.advance(1);
  h.fireTimers();
  assert.equal(wakes, 1);
  assert.equal(h.pacer.snapshot().wakePending, false);
});

test('a drawn frame drops the wake asked for before it; cancelWake and dispose drop it too', () => {
  const h = harness();
  h.measureInterval();
  h.pacer.frameDrawn(h.now, true);
  h.advance(100);
  h.frameTasksRun();
  let wakes = 0;
  h.pacer.wakeWhenDue(() => { wakes += 1; });
  assert.equal(h.pacer.snapshot().wakePending, true);
  // A change is drawn at once: the loop it armed asks again if it must.
  h.pacer.frameDrawn(h.now, false);
  assert.equal(h.pacer.snapshot().wakePending, false);
  h.advance(10);
  h.frameTasksRun();
  h.advance(1000);
  h.fireTimers();
  assert.equal(wakes, 0);

  h.pacer.wakeWhenDue(() => { wakes += 1; });
  h.pacer.cancelWake();
  assert.equal(h.pacer.snapshot().wakePending, false);
  // The loop stops: nothing of the pacer's is left to fire.
  assert.equal(h.timers.size, 0);

  h.pacer.wakeWhenDue(() => { wakes += 1; });
  h.pacer.dispose();
  assert.equal(h.timers.size, 0);
  h.advance(1000);
  h.fireTimers();
  h.pacer.frameDrawn(h.now, true);
  h.frameTasksRun();
  assert.equal(wakes, 0);
});

test('a frame late behind the GPU holds ambient frames as long as it ran late; on time again, none', () => {
  const h = harness();
  h.measureInterval();
  // An ambient frame, then the next frame three display frames late while
  // the GPU still runs it when the next was due.
  h.pacer.frameDrawn(h.now, true);
  h.frameTasksRun();
  h.gpuBusy = true;
  h.nextFrame(4 * VSYNC_MS);
  h.gpuBusy = false;
  assert.ok(Math.abs(h.pacer.snapshot().lastLateMs - 3 * VSYNC_MS) < 1e-9);
  assert.equal(h.pacer.isDue(h.now), false);
  // Only the GPU rule holds it: the next frames are run, undrawn, and timed.
  assert.equal(h.pacer.watchesNextFrame(h.now), true);
  h.nextFrame();
  h.nextFrame();
  assert.equal(h.pacer.isDue(h.now), false);
  h.nextFrame();
  assert.equal(h.pacer.isDue(h.now), true);
  assert.equal(h.pacer.watchesNextFrame(h.now), false);
  // Frames on time behind ambient frames hold nothing.
  for (let index = 0; index < 20; index++) {
    h.pacer.frameDrawn(h.now, true);
    h.frameTasksRun();
    h.nextFrame();
    assert.equal(h.pacer.isDue(h.now), true, `frame ${index}`);
  }
});

test('a frame late behind the GPU while the next is held lengthens the wait', () => {
  const h = harness();
  h.measureInterval();
  h.pacer.frameDrawn(h.now, true);
  h.frameTasksRun();
  h.gpuBusy = true;
  h.nextFrame(2 * VSYNC_MS);
  // Held one display frame; the undrawn frame comes two late, the GPU still busy.
  h.nextFrame(3 * VSYNC_MS);
  h.gpuBusy = false;
  assert.equal(h.pacer.isDue(h.now + VSYNC_MS), false);
  assert.equal(h.pacer.isDue(h.now + 2 * VSYNC_MS), true);
});

test('a frame late with the GPU idle is not the GPU\'s: a stopped page, a long task', () => {
  const h = harness();
  h.measureInterval();
  h.pacer.frameDrawn(h.now, true);
  h.frameTasksRun();
  // The page was hidden (or held by a task) for 10 s after an ambient frame
  // that the GPU had finished at once: the next frame is not counted.
  h.nextFrame(10_000);
  assert.equal(h.pacer.snapshot().lastLateMs, 0);
  assert.equal(h.pacer.isDue(h.now), true);
});

test('a page stopped while the GPU still ran a frame is late only as long as the GPU was seen to run it', () => {
  // A slow GPU (a phone's), its tab switched away from right after an
  // ambient frame, or a long task: the read when the next frame was due saw
  // the GPU busy, and the next frame came 10 s later. The GPU had finished
  // long before: a pacer that counted the whole 10 s held the ambient
  // animation 10 s once the page ran again.
  for (const gpuMsAfterDue of [0, 2 * VSYNC_MS]) {
    const h = harness();
    h.measureInterval();
    h.pacer.frameDrawn(h.now, true);
    h.frameTasksRun();
    h.gpuBusy = true;
    h.advance(1.5 * VSYNC_MS);
    h.fireTimers();
    // Read every half display interval while it runs (the page still runs).
    for (let ms = 0; ms < gpuMsAfterDue; ms += VSYNC_MS / 2) {
      h.advance(VSYNC_MS / 2);
      h.fireTimers();
    }
    h.gpuBusy = false;
    // The page stopped: the next read, and the next frame, 10 s on.
    h.advance(10_000);
    h.fireTimers();
    h.frame();
    const late = h.pacer.snapshot().lastLateMs;
    assert.ok(late <= 1.5 * VSYNC_MS + gpuMsAfterDue + VSYNC_MS + 1e-9, `${gpuMsAfterDue} ms busy after due: held ${late} ms`);
    assert.ok(h.pacer.snapshot().msUntilGpuKeepsUp <= late + 1e-9);
  }
  // The GPU still runs it as the late frame starts: late by all of it.
  const h = harness();
  h.measureInterval();
  h.pacer.frameDrawn(h.now, true);
  h.frameTasksRun();
  h.gpuBusy = true;
  h.advance(1.5 * VSYNC_MS);
  h.fireTimers();
  h.advance(10 * VSYNC_MS - 1.5 * VSYNC_MS);
  h.frame();
  assert.ok(Math.abs(h.pacer.snapshot().lastLateMs - 9 * VSYNC_MS) < 1e-9);
});

test('only frames after an ambient frame or after no frame count; frames not armed by the one before are not timed', () => {
  const h = harness();
  h.measureInterval();
  // A frame some change asked for: its cost is the page's.
  h.pacer.frameDrawn(h.now, false);
  h.frameTasksRun();
  h.gpuBusy = true;
  h.nextFrame(5 * VSYNC_MS);
  assert.equal(h.pacer.snapshot().lastLateMs, 0);
  // A frame armed by a wake, not by the frame before.
  h.pacer.frameDrawn(h.now, true);
  h.frameTasksRun();
  h.nextFrame(5 * VSYNC_MS, false);
  assert.equal(h.pacer.snapshot().lastLateMs, 0);
  // Two callbacks at one timestamp are one frame.
  h.nextFrame(0);
  assert.equal(h.pacer.snapshot().lastLateMs, 0);
});

test('jitter within half a display interval is not late', () => {
  const h = harness();
  h.measureInterval();
  h.gpuBusy = true;
  for (const ms of [12, 22, 14, 24, 9]) {
    h.pacer.frameDrawn(h.now, true);
    h.frameTasksRun();
    h.nextFrame(ms);
    assert.equal(h.pacer.isDue(h.now), true, `${ms} ms`);
  }
  assert.equal(h.pacer.snapshot().lastLateMs, 0);
});

test('a late frame measures the display interval again, so a display that slowed is learnt', () => {
  const h = harness();
  h.measureInterval();
  // The display now runs at 30 Hz, and the GPU is slow too.
  const slow = 2 * VSYNC_MS;
  h.pacer.frameDrawn(h.now, true);
  h.frameTasksRun();
  h.gpuBusy = true;
  h.nextFrame(slow);
  assert.equal(h.pacer.snapshot().measuringInterval, true);
  h.gpuBusy = false;
  h.fireTimers();
  for (let index = 0; index < 9; index++) h.nextFrame(slow);
  assert.ok(Math.abs(h.pacer.snapshot().displayIntervalMs - slow) < 1e-9);
  assert.equal(h.pacer.isDue(h.now), true);
});

test('the pacer refuses clocks, timers and wakes that are not functions', () => {
  assert.throws(() => createAmbientFramePacer({ now: 0 }), TypeError);
  assert.throws(() => createAmbientFramePacer({ setTimer: null }), TypeError);
  assert.throws(() => createAmbientFramePacer({ afterFrame: 'soon' }), TypeError);
  assert.throws(() => createAmbientFramePacer({ gpuBusy: true }), TypeError);
  assert.throws(() => createAmbientFramePacer().wakeWhenDue(null), TypeError);
});

/**
 * A browser on a virtual clock, running the viewer's frame decision
 * (`render()` in `rendering/viewer.js`) for a scene whose only cause is an
 * ambient animation.
 *
 * @param {object} options
 * @param {number} [options.frameMs] - What a drawn frame holds the main thread
 * @param {number|((at: number) => number)} [options.gpuMs] - What a drawn
 *   frame takes the GPU (at a time)
 * @param {number} [options.pipeline] - Drawn frames the GPU may still run
 *   while the browser starts the next frame
 * @param {(at: number) => number} [options.vsyncMs] - The display interval
 * @param {boolean} options.renderFirst - Whether a due animation frame runs
 *   before queued tasks
 * @param {number} options.untilMs - How long to run
 * @param {Array<{at: number, ms: number}>} [options.tasks] - Other work:
 *   a task queued at `at` that holds the main thread `ms`
 * @param {Array<number>} [options.invalidations] - Times a change asks for
 *   a frame (drawn at once, whatever the pacing)
 * @param {number} [options.pulseEndsAt] - When the animation ends
 * @param {{from: number, until: number}} [options.hidden] - When the browser
 *   runs no animation frames (a hidden page)
 */
function simulate({
  frameMs = 0,
  gpuMs = 0,
  pipeline = 2,
  vsyncMs = () => VSYNC_MS,
  renderFirst,
  untilMs,
  tasks = [],
  invalidations = [],
  pulseEndsAt = Infinity,
  hidden = null,
}) {
  const gpuMsAt = typeof gpuMs === 'function' ? gpuMs : () => gpuMs;
  let clock = 0;
  const queue = [];
  const timers = [];
  let rafs = [];
  const frames = [];
  const pageFrames = [];
  const busy = [];
  const done = [];
  const external = [...tasks].sort((a, b) => a.at - b.at);
  const changes = [...invalidations].sort((a, b) => a - b);
  // When each drawn frame's GPU work is done, in order.
  const gpu = [];
  let gpuFreeAt = 0;
  const onGpu = () => gpu.filter(doneAt => doneAt > clock).length;
  const isHidden = at => hidden !== null && at >= hidden.from && at < hidden.until;

  const pacer = createAmbientFramePacer({
    now: () => clock,
    afterFrame: callback => queue.push({ run: callback }),
    gpuBusy: () => gpu.length > 0 && gpu.at(-1) > clock,
    // A browser runs a timer no sooner than a millisecond on (nested ones
    // later still), so a poll at 0 ms lets time pass.
    setTimer: (callback, ms) => {
      const timer = { at: clock + Math.max(1, ms), callback };
      timers.push(timer);
      return timer;
    },
    clearTimer: timer => {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
  });

  // The viewer: armed at most once; a frame re-arms before it draws, and
  // only the frame it armed is timed from it.
  let armed = null;
  let nextHandle = 1;
  let armedByLastFrame = null;
  let invalidated = false;
  const arm = () => {
    if (armed !== null) return;
    armed = nextHandle++;
    rafs.push(render);
  };
  function render(timestamp) {
    const timed = armed !== null && armed === armedByLastFrame;
    armedByLastFrame = null;
    armed = null;
    pacer.frameStarted(timestamp, timed);
    const animating = clock < pulseEndsAt;
    const cause = invalidated ? 'invalidated' : animating ? 'ambient' : null;
    if (cause === 'ambient' && !pacer.isDue(clock)) {
      if (pacer.watchesNextFrame(clock)) {
        arm();
        armedByLastFrame = armed;
      } else {
        pacer.wakeWhenDue(arm);
      }
      return;
    }
    if (cause === null) {
      pacer.cancelWake();
      return;
    }
    invalidated = false;
    arm();
    armedByLastFrame = armed;
    pacer.frameDrawn(clock, cause === 'ambient');
    frames.push({ start: clock, end: clock + frameMs, cause });
    hold(frameMs, cause);
    gpuFreeAt = Math.max(gpuFreeAt, clock) + gpuMsAt(clock);
    gpu.push(gpuFreeAt);
  }
  function hold(ms, what) {
    if (ms > 0) busy.push({ start: clock, end: clock + ms, what });
    clock += ms;
  }
  /** The first display frame after `at`. */
  const vsyncAfter = at => (Math.floor(at / vsyncMs(at) + 1e-9) + 1) * vsyncMs(at);

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
    for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
      if (timer.at <= clock) {
        timers.splice(timers.indexOf(timer), 1);
        queue.push({ run: timer.callback });
      }
    }
    if (clock >= nextVsync && (isHidden(clock) || onGpu() >= pipeline)) {
      // No frame at this display frame: the page is hidden, or the GPU has
      // no room for one; the next display frame after it frees, or shows.
      const freeAt = isHidden(clock) ? hidden.until : gpu.find(doneAt => doneAt > clock);
      nextVsync = vsyncAfter(Math.max(clock, freeAt) - 1e-6);
    }
    const frameDue = clock >= nextVsync;
    if (frameDue && (renderFirst || queue.length === 0)) {
      // A frame of the page, whether or not the viewer draws in it.
      pageFrames.push(clock);
      const callbacks = rafs;
      rafs = [];
      const timestamp = clock;
      for (const callback of callbacks) callback(timestamp);
      nextVsync = vsyncAfter(timestamp);
      continue;
    }
    if (queue.length > 0) {
      queue.shift().run();
      continue;
    }
    // Idle until the next thing that can happen.
    const next = Math.min(
      nextVsync,
      ...timers.map(timer => timer.at),
      external.length > 0 ? external[0].at : Infinity,
      changes.length > 0 ? changes[0] : Infinity,
      untilMs,
    );
    clock = Math.max(clock, next);
  }
  return { frames, pageFrames, busy, done, pacer, armed: () => armed !== null, timers };
}

/** How long the page's frames ran late, against the display interval. */
function lateness(pageFrames, from, until, intervalMs = VSYNC_MS) {
  let late = 0;
  for (let index = 1; index < pageFrames.length; index++) {
    if (pageFrames[index] < from || pageFrames[index] > until) continue;
    late += Math.max(0, pageFrames[index] - pageFrames[index - 1] - intervalMs);
  }
  return late / (until - from);
}

const FRAME_MS = 450;
const VSYNC_SLACK_MS = 2 * VSYNC_MS;
// The first ambient frame waits for the display interval: the GPU idle, and
// nine animation frames timed.
const INTERVAL_MEASURED_MS = 10 * VSYNC_MS;

for (const renderFirst of [false, true]) {
  const order = renderFirst ? 'animation frames before tasks' : 'tasks before animation frames';

  test(`450 ms ambient frames, ${order}: never back to back, never starved`, () => {
    const { frames } = simulate({ frameMs: FRAME_MS, renderFirst, untilMs: 20_000 });
    assert.ok(frames.length >= 18, `ambient frames drawn in 20 s: ${frames.length}`);
    for (let index = 1; index < frames.length; index++) {
      const free = frames[index].start - frames[index - 1].end;
      // The main thread is free at least as long as the frame held it ...
      assert.ok(free >= FRAME_MS - 1e-6, `free before ambient frame ${index}: ${free} ms`);
      // ... and the next ambient frame comes within that and two display frames.
      assert.ok(free <= FRAME_MS + VSYNC_SLACK_MS, `wait before ambient frame ${index}: ${free} ms`);
    }
  });

  test(`450 ms ambient frames under a queue of worker replies, ${order}: the replies run, the animation goes on`, () => {
    // An analysis: a reply every 20 ms for 10 s, each 5 ms of main-thread work.
    const tasks = Array.from({ length: 500 }, (_, index) => ({ at: 1000 + index * 20, ms: 5 }));
    const { frames, done } = simulate({ frameMs: FRAME_MS, renderFirst, untilMs: 12_000, tasks });
    assert.equal(done.length, tasks.length, 'every reply ran');
    // A reply waits for at most the one frame in its way and the replies queued before it.
    const longestWait = Math.max(...done.map(task => task.end - task.at));
    assert.ok(longestWait <= FRAME_MS + VSYNC_SLACK_MS + 5 * 30, `longest reply wait: ${longestWait} ms`);
    for (let index = 1; index < frames.length; index++) {
      const free = frames[index].start - frames[index - 1].end;
      assert.ok(free >= FRAME_MS - 1e-6, `free before ambient frame ${index}: ${free} ms`);
      // The measurement waits behind the replies queued before it: a few at most.
      assert.ok(free <= FRAME_MS + VSYNC_SLACK_MS + 5 * 30, `wait before ambient frame ${index}: ${free} ms`);
    }
    const during = frames.filter(frame => frame.start >= 1000 && frame.start < 11_000);
    assert.ok(during.length >= 9, `ambient frames during the analysis: ${during.length}`);
  });

  test(`a change is drawn at once while an ambient frame waits, ${order}, and the animation waits for it too`, () => {
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
      if (frames[index].cause !== 'ambient') continue;
      const free = frames[index].start - frames[index - 1].end;
      assert.ok(free >= FRAME_MS - 1e-6, `free before ambient frame ${index}: ${free} ms`);
    }
  });

  test(`an animation that ends leaves nothing owed, ${order}: the loop stops and nothing of the pacer's remains`, () => {
    const result = simulate({ frameMs: FRAME_MS, renderFirst, untilMs: 8000, pulseEndsAt: 3000 });
    const last = result.frames.at(-1);
    assert.ok(last.start < 3000, `no ambient frame after the animation ended: ${last.start}`);
    assert.equal(result.armed(), false);
    assert.equal(result.timers.length, 0);
    assert.equal(result.pacer.snapshot().wakePending, false);
    assert.equal(result.pacer.snapshot().measuring, false);
  });

  test(`a GPU that keeps up is never held back, ${order}: an ambient frame every display frame`, () => {
    // 10 ms of GPU work a frame, 2 ms of main thread.
    const { frames, pageFrames } = simulate({ frameMs: 2, gpuMs: 10, renderFirst, untilMs: 5000 });
    const expected = Math.floor((5000 - INTERVAL_MEASURED_MS) / VSYNC_MS);
    assert.ok(frames.length >= expected - 1, `ambient frames in 5 s: ${frames.length} of ${expected}`);
    assert.ok(lateness(pageFrames, 0, 5000) < 1e-9);
  });

  test(`a GPU that does not keep up leaves the page's frames on time at least half the time, ${order}, and the animation goes on`, () => {
    // 55 ms of GPU work a frame (SwiftShader under the velocity overlay).
    const unpaced = simulate({ gpuMs: 55, renderFirst, untilMs: 10_000, invalidations: [] });
    const { frames, pageFrames } = unpaced;
    const late = lateness(pageFrames, 1000, 10_000);
    assert.ok(late <= 0.5, `the page's frames ran late ${(late * 100).toFixed(0)}% of the time`);
    const ambient = frames.filter(frame => frame.cause === 'ambient' && frame.start >= 1000);
    // At least one ambient frame for each two of the GPU's frame time.
    assert.ok(ambient.length >= 9000 / (2 * 55) / 2, `ambient frames in 9 s: ${ambient.length}`);
  });

  test(`a GPU that catches up gets every display frame again, ${order}`, () => {
    const { frames } = simulate({ gpuMs: at => (at < 3000 ? 55 : 10), renderFirst, untilMs: 6000 });
    const after = frames.filter(frame => frame.cause === 'ambient' && frame.start >= 3500);
    const expected = Math.floor(2500 / VSYNC_MS);
    assert.ok(after.length >= expected - 2, `ambient frames once the GPU kept up: ${after.length} of ${expected}`);
  });

  test(`a display that slows (power saving) keeps an ambient frame every display frame, ${order}`, () => {
    const slow = 2 * VSYNC_MS;
    const { frames } = simulate({
      gpuMs: 10,
      vsyncMs: at => (at < 2000 ? VSYNC_MS : slow),
      renderFirst,
      untilMs: 5000,
    });
    const after = frames.filter(frame => frame.start >= 2500);
    const expected = Math.floor(2500 / slow);
    assert.ok(after.length >= expected - 1, `ambient frames at 30 Hz: ${after.length} of ${expected}`);
  });

  for (const [what, stop] of [
    ['a page hidden for 10 s', { hidden: { from: 2000, until: 12_000 } }],
    ['a 10 s task', { tasks: [{ at: 2000, ms: 10_000 }] }],
  ]) {
    test(`${what} while a slow GPU runs a frame is not taken for the GPU's lateness, ${order}`, () => {
      // 55 ms of GPU work a frame: the read when the next frame is due sees
      // the GPU still running the last one, every frame.
      const { frames } = simulate({ gpuMs: 55, renderFirst, untilMs: 14_000, ...stop });
      const before = frames.filter(frame => frame.start >= 1000 && frame.start < 2000);
      const gaps = before.slice(1).map((frame, index) => frame.start - before[index].start);
      const first = frames.find(frame => frame.start >= 12_000);
      assert.ok(first !== undefined, 'an ambient frame after the page ran again');
      // It comes within the longest wait between ambient frames before the stop.
      assert.ok(first.start - 12_000 <= Math.max(...gaps) + VSYNC_SLACK_MS, `first ambient frame after the stop: ${first.start - 12_000} ms on (before it, at most ${Math.max(...gaps)} ms apart)`);
    });
  }

  test(`a page hidden for 10 s is not taken for a late GPU, ${order}`, () => {
    const { frames } = simulate({ gpuMs: 10, renderFirst, untilMs: 14_000, hidden: { from: 2000, until: 12_000 } });
    const first = frames.find(frame => frame.start >= 12_000);
    assert.ok(first !== undefined && first.start - 12_000 <= VSYNC_SLACK_MS, `first ambient frame after showing: ${first?.start}`);
    const after = frames.filter(frame => frame.start >= 12_000);
    assert.ok(after.length >= Math.floor(2000 / VSYNC_MS) - 2, `ambient frames after showing: ${after.length}`);
  });
}

test('without the GPU rule a slow GPU keeps the page late most of the time (what the rule is measured against)', () => {
  // The simulated browser itself: every frame drawn, 55 ms of GPU each.
  let at = 0;
  const pageFrames = [];
  let gpuFreeAt = 0;
  const gpu = [];
  while (at < 10_000) {
    pageFrames.push(at);
    gpuFreeAt = Math.max(gpuFreeAt, at) + 55;
    gpu.push(gpuFreeAt);
    let next = (Math.floor(at / VSYNC_MS + 1e-9) + 1) * VSYNC_MS;
    const onGpu = doneAt => doneAt > next;
    while (gpu.filter(onGpu).length >= 2) {
      next = (Math.floor(gpu.find(onGpu) / VSYNC_MS - 1e-6 + 1e-9) + 1) * VSYNC_MS;
    }
    at = next;
  }
  assert.ok(lateness(pageFrames, 1000, 10_000) > 0.6);
});
