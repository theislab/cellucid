/**
 * Levels of detail and culling turn on when the GPU's share of a frame of
 * every cell is proven over the interactive budget, and stay on only where
 * their frames are proven faster (rendering/full-detail-frame-cost.js): each
 * sample's shares as bounds (a fence polled in tasks, or the GPU timer,
 * exact), the cheapest of a few frames, and a verdict from what the bounds
 * prove.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  answerOf,
  createFullDetailFrameCost,
  fenceSampleOf,
  GPU_TIMER_EXTENSION,
  INTERACTIVE_FRAME_BUDGET_MS,
  isTooSlow,
  sampleOf,
  verdictOf,
} from '../assets/js/rendering/full-detail-frame-cost.js';

const exact = (gpu, cpu = 0) => sampleOf(cpu, { lo: gpu, hi: gpu });
const answer = (...samples) => answerOf(samples);

/**
 * A context whose fences signal when the test says the GPU finished, and
 * (with `timer`) a GPU timer whose queries report what the test says.
 */
function fakeGl({ timer = false } = {}) {
  const fences = [];
  const queries = [];
  const extension = Object.freeze({ TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb });
  return {
    SYNC_GPU_COMMANDS_COMPLETE: 1,
    SYNC_FLUSH_COMMANDS_BIT: 1,
    ALREADY_SIGNALED: 3,
    TIMEOUT_EXPIRED: 4,
    QUERY_RESULT: 0x8866,
    QUERY_RESULT_AVAILABLE: 0x8867,
    CURRENT_QUERY: 0x8865,
    fences,
    queries,
    lost: false,
    disjoint: false,
    flushes: 0,
    deleted: 0,
    deletedQueries: 0,
    active: null,
    getExtension(name) {
      assert.equal(name, GPU_TIMER_EXTENSION);
      return timer ? extension : null;
    },
    createQuery() {
      const query = { ended: false, available: false, nanoseconds: 0 };
      queries.push(query);
      return query;
    },
    beginQuery(target, query) {
      assert.equal(target, extension.TIME_ELAPSED_EXT);
      assert.equal(this.active, null, 'one timer query at a time');
      this.active = query;
    },
    endQuery(target) {
      assert.equal(target, extension.TIME_ELAPSED_EXT);
      assert.notEqual(this.active, null, 'a query ends only once begun');
      this.active.ended = true;
      this.active = null;
    },
    getQueryParameter(query, pname) {
      if (pname === this.QUERY_RESULT_AVAILABLE) return query.available;
      assert.equal(pname, this.QUERY_RESULT);
      return query.nanoseconds;
    },
    getQuery(target, pname) {
      assert.equal(target, extension.TIME_ELAPSED_EXT);
      assert.equal(pname, this.CURRENT_QUERY);
      return this.active;
    },
    getParameter(pname) {
      assert.equal(pname, extension.GPU_DISJOINT_EXT);
      return this.disjoint;
    },
    deleteQuery() {
      this.deletedQueries += 1;
    },
    fenceSync() {
      const fence = { signaled: false };
      fences.push(fence);
      return fence;
    },
    flush() {
      this.flushes += 1;
    },
    clientWaitSync(fence, flags, timeout) {
      assert.equal(flags, this.SYNC_FLUSH_COMMANDS_BIT, 'every poll flushes (gl-utils.js fenceHasPassed)');
      assert.equal(timeout, 0, 'a poll never waits');
      return fence.signaled ? this.ALREADY_SIGNALED : this.TIMEOUT_EXPIRED;
    },
    deleteSync() {
      this.deleted += 1;
    },
    isContextLost() {
      return this.lost;
    },
  };
}

function harness(options) {
  const gl = fakeGl(options);
  let clock = 0;
  const tasks = [];
  const reports = [];
  const verified = [];
  const requested = [];
  const cost = createFullDetailFrameCost({
    gl,
    onTooSlow: report => reports.push(report),
    onVerified: result => verified.push(result),
    requestFrame: () => requested.push(clock),
    now: () => clock,
    schedule: callback => tasks.push(callback),
  });
  // The tasks queued so far, once each (a poll that finds the fence
  // unsignaled queues the next, run by the next call).
  const runTasks = () => {
    for (const task of tasks.splice(0, tasks.length)) task();
  };
  /**
   * One frame: begun at the clock, its last command issued `cpuMs` later,
   * the GPU done `gpuMs` after the start; its fence polled every `pollMs`
   * (the tasks the browser runs between), or its timer query read once.
   */
  const frame = (gpuMs, { eligible = true, pollMs = 1, cpuMs = 0 } = {}) => {
    const startedAt = clock;
    if (cost.isArmed()) cost.frameStarted(startedAt);
    const query = gl.queries.at(-1);
    clock = startedAt + cpuMs;
    if (cost.isArmed()) cost.frameEnded(eligible);
    runTasks();
    while (clock + pollMs < startedAt + gpuMs) {
      clock += pollMs;
      runTasks();
    }
    clock = Math.max(clock, startedAt + gpuMs);
    for (const fence of gl.fences) fence.signaled = true;
    if (query !== undefined && query.ended && !query.available) {
      query.available = true;
      query.nanoseconds = gpuMs * 1e6;
    }
    runTasks();
    clock += 1;
  };
  return { gl, cost, frame, reports, verified, tasks, requested, runTasks };
}

test('the budget is the 30-frames-a-second UX target', () => {
  assert.equal(INTERACTIVE_FRAME_BUDGET_MS, 1000 / 30);
});

test('a frame lasts the longer of the page\'s and the GPU\'s shares; a fence bounds the GPU\'s', () => {
  assert.deepEqual(exact(60, 5), { cpu: 5, gpu: { lo: 60, hi: 60 }, frame: { lo: 60, hi: 60 } });
  assert.deepEqual(exact(1, 50).frame, { lo: 50, hi: 50 }, 'a page-bound frame');
  // Begun at 0, issued at 4, last seen unfinished at 70, seen done at 78:
  // the GPU took at most 78 ms and, the page having taken 4 of them, at
  // least 66.
  assert.deepEqual(fenceSampleOf({ startedAt: 0, issuedAt: 4, unsignaledAt: 70, signaledAt: 78 }),
    { cpu: 4, gpu: { lo: 66, hi: 78 }, frame: { lo: 66, hi: 78 } });
  // Found done at the first poll: the GPU may have finished at once.
  assert.deepEqual(fenceSampleOf({ startedAt: 0, issuedAt: 4, unsignaledAt: 4, signaledAt: 9 }).gpu, { lo: 0, hi: 9 });
});

test('an answer bounds the cheapest frame, and its spread is only what the samples prove', () => {
  // The first frame (stores uploaded, programs linked) costs nothing.
  assert.deepEqual(answer(exact(400), exact(120), exact(130)),
    { gpu: { lo: 120, hi: 120 }, frame: { lo: 120, hi: 120 }, spread: 10 });
  // Overlapping bounds prove no spread: the instrument's resolution is not
  // counted as frame-to-frame variation.
  const coarse = (lo, hi) => sampleOf(0, { lo, hi });
  assert.deepEqual(answer(coarse(170, 324), coarse(180, 330), coarse(300, 400)),
    { gpu: { lo: 170, hi: 324 }, frame: { lo: 170, hi: 324 }, spread: 0 });
  assert.throws(() => answerOf([exact(1)]), RangeError);
});

test('the verdict is what the bounds prove: faster, no faster, or closer than the instrument times', () => {
  const coarse = (lo, hi) => sampleOf(0, { lo, hi });
  const of = (lo, hi) => answer(coarse(lo, hi), coarse(lo, hi), coarse(lo, hi));
  // A 150 ms poll (a loaded runner): 174 against 324 ms. The poll's 150 ms is
  // not added to the faster frame's upper bound, which would say "no faster
  // here"; the bounds say the frames cannot be told apart.
  assert.equal(verdictOf(of(174, 324), of(150, 174)), 'unresolved');
  // Resolved by a finer instrument, the same frames are faster.
  assert.equal(verdictOf(of(320, 324), of(170, 174)), 'faster');
  // Exact frames are never unresolved: 210 against 60 is faster, 60
  // against 60 is not.
  assert.equal(verdictOf(answer(exact(210), exact(210), exact(211)), answer(exact(60), exact(60), exact(60))), 'faster');
  assert.equal(verdictOf(answer(exact(60), exact(60), exact(60)), answer(exact(60), exact(60), exact(60))), 'not-faster');
  // A gain within the proven spread is no gain.
  assert.equal(verdictOf(answer(exact(438), exact(441), exact(445)), answer(exact(436), exact(437), exact(439))), 'not-faster');
  // Polls 8 ms apart: 68 against 65 ms within one interval is not faster
  // (culling would be kept for 120 cells), and frames proven the same are no faster.
  assert.equal(verdictOf(of(60, 68), of(57, 65)), 'unresolved');
  assert.equal(verdictOf(of(66, 68), of(66, 68)), 'unresolved', 'alike within one interval: either may be the faster');
});

test('too slow is the GPU\'s share proven over the budget, not a slow page', () => {
  assert.equal(isTooSlow(answer(exact(120), exact(120), exact(121))), true);
  // A page-bound frame (50 ms of script, 1 ms of GPU): drawing fewer cells
  // cannot make it faster.
  assert.equal(isTooSlow(answer(exact(1, 50), exact(1, 50), exact(1, 50))), false);
  // A GPU share that may lie under the budget is not proven over it.
  const coarse = (lo, hi) => sampleOf(0, { lo, hi });
  assert.equal(isTooSlow(answer(coarse(20, 45), coarse(20, 45), coarse(20, 45))), false);
});

test('a slow frame of every cell is reported once, with the cheapest of three frames', () => {
  const { cost, frame, reports, gl, requested } = harness();
  cost.arm();
  frame(400); // the first frame: stores uploaded, programs linked
  frame(120);
  frame(130);
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0].gpu, { lo: 119, hi: 120 }, 'last seen unfinished at 119 ms, done at 120');
  assert.equal(requested.length, 2, 'each sample but the last asks for the next frame');
  assert.equal(cost.isArmed(), false, 'answered: not measured again until armed');
  frame(500);
  assert.equal(reports.length, 1);
  assert.equal(gl.deleted, 3, 'every fence is deleted');
});

test('a fast frame is not reported: small datasets keep every cell', () => {
  const { cost, frame, reports } = harness();
  cost.arm();
  for (let index = 0; index < 3; index++) frame(4);
  assert.deepEqual(reports, []);
  // One slow frame among fast ones (a stall) does not count.
  cost.arm();
  frame(200);
  frame(5);
  frame(6);
  assert.deepEqual(reports, []);
});

test('only frames that draw every cell of every pane are sampled, and nothing before arming', () => {
  const { cost, frame, reports, gl } = harness();
  frame(200);
  assert.equal(gl.fences.length, 0, 'not armed: no fence');
  cost.arm();
  frame(200, { eligible: false });
  frame(200, { eligible: false });
  assert.equal(gl.fences.length, 0, 'a reduced level is not a frame of every cell');
  frame(200);
  frame(200);
  frame(200);
  assert.equal(reports.length, 1);
});

test('one sample at a time; a lost context drops it without a GL call', () => {
  const { cost, gl, tasks, reports } = harness();
  cost.arm();
  cost.frameStarted(0);
  cost.frameEnded(true);
  cost.frameStarted(1);
  cost.frameEnded(true);
  assert.equal(gl.fences.length, 1);
  gl.lost = true;
  cost.handleContextLost();
  for (const task of tasks.splice(0, tasks.length)) task();
  assert.equal(gl.deleted, 0);
  assert.deepEqual(reports, []);
  // Re-armed on the restored context, it measures again.
  gl.lost = false;
  cost.arm();
  assert.equal(cost.isArmed(), true);
});

test('turning levels of detail on ends the opening\'s measurement until the next arms it', () => {
  const { cost, frame, reports, gl } = harness();
  cost.arm();
  frame(200);
  cost.disarm();
  frame(200);
  frame(200);
  assert.deepEqual(reports, []);
  assert.equal(cost.isArmed(), false);
  cost.arm();
  for (let index = 0; index < 3; index++) frame(200);
  assert.equal(reports.length, 1);
  assert.equal(gl.deleted, 4, 'the fence pending when it was turned on is deleted too');
});

test('the automatic choice is verified against the frames of every cell', () => {
  const { cost, frame, reports, verified } = harness();
  cost.arm();
  frame(440); frame(438); frame(445);
  assert.deepEqual(reports[0].frame, { lo: 437, hi: 438 });
  // Turning levels of detail on ends the opening's first measurement…
  cost.disarm();
  // …and the controls ask for its frames to be verified.
  cost.verify();
  assert.equal(cost.phase(), 'verify');
  frame(721); frame(730); frame(725);
  assert.equal(verified.at(-1).verdict, 'not-faster');
  assert.deepEqual(verified.at(-1).answer.frame, { lo: 720, hi: 721 });
  assert.deepEqual(verified.at(-1).full.frame, { lo: 437, hi: 438 });
  assert.equal(cost.isArmed(), false);
  // A gain of 1 to 3 ms, polled every millisecond, against a proven spread
  // of 1 ms: closer than the polls can tell apart.
  cost.verify();
  frame(436); frame(439); frame(437);
  assert.equal(verified.at(-1).verdict, 'unresolved');
  // A dear sample (a stall, uploads) is no spread: 67 ms against 438 is faster.
  cost.verify();
  frame(400); frame(67); frame(69);
  assert.equal(verified.at(-1).verdict, 'faster');
  cost.verify();
  frame(213); frame(215); frame(214);
  assert.equal(verified.at(-1).verdict, 'faster');
});

test('a late poll leaves the verdict unresolved, never "no faster" for a frame proven faster by less than the poll', () => {
  const { cost, frame, verified } = harness();
  // Polled every 150 ms (a loaded runner): the frames of every cell were
  // last seen unfinished at 150 or 300 ms and done by 324.
  cost.arm();
  frame(324, { pollMs: 150 }); frame(324, { pollMs: 150 }); frame(324, { pollMs: 150 });
  cost.disarm();
  cost.verify();
  frame(174, { pollMs: 150 }); frame(174, { pollMs: 150 }); frame(174, { pollMs: 150 });
  assert.equal(verified.at(-1).verdict, 'faster', 'done by 174 ms against unfinished at 300 ms');
  cost.verify();
  frame(310, { pollMs: 150 }); frame(310, { pollMs: 150 }); frame(310, { pollMs: 150 });
  assert.equal(verified.at(-1).verdict, 'unresolved', 'done by 310 ms against unfinished at 300: the bounds overlap');
});

test('nothing is verified without an answer of the frames of every cell', () => {
  const { cost, frame, verified } = harness();
  cost.verify();
  assert.equal(cost.isArmed(), false);
  frame(100); frame(100); frame(100);
  assert.deepEqual(verified, []);
});

test('the GPU timer measures each frame exactly, around its commands, wherever it is read', () => {
  const { cost, frame, reports, verified, gl } = harness({ timer: true });
  cost.arm();
  // Read 150 ms late: the timer's answer is still exact.
  frame(210, { pollMs: 150, cpuMs: 4 }); frame(211, { pollMs: 150, cpuMs: 4 }); frame(212, { pollMs: 150, cpuMs: 4 });
  assert.equal(gl.fences.length, 0, 'no fence where the GPU is timed');
  assert.deepEqual(reports[0].gpu, { lo: 210, hi: 210 });
  assert.equal(reports[0].spread, 1);
  cost.disarm();
  cost.verify();
  frame(60, { pollMs: 150, cpuMs: 4 }); frame(60, { pollMs: 150, cpuMs: 4 }); frame(60, { pollMs: 150, cpuMs: 4 });
  assert.equal(verified.at(-1).verdict, 'faster');
  // A page-bound frame: the GPU's 1 ms is not a frame time of 1 ms.
  cost.arm();
  frame(1, { cpuMs: 50 }); frame(1, { cpuMs: 50 }); frame(1, { cpuMs: 50 });
  assert.equal(reports.length, 1, 'not too slow for the GPU');
  assert.equal(gl.deletedQueries, 9, 'every query is given back');
  assert.equal(gl.active, null);
});

test('a disjoint timer reading is no sample, and another frame is asked for', () => {
  const { cost, frame, reports, gl, requested } = harness({ timer: true });
  cost.arm();
  gl.disjoint = true;
  frame(200);
  assert.equal(requested.length, 1);
  gl.disjoint = false;
  frame(200); frame(200);
  assert.deepEqual(reports, []);
  frame(200);
  assert.equal(reports.length, 1);
});

test('a frame opened for the timer and not drawn, or no longer measured, ends its query', () => {
  const { cost, gl } = harness({ timer: true });
  cost.arm();
  cost.frameStarted(0);
  assert.notEqual(gl.active, null);
  cost.frameEnded(false);
  assert.equal(gl.active, null, 'a frame that failed is no sample, and its query is closed');
  cost.frameStarted(1);
  cost.disarm();
  assert.equal(gl.active, null, 'disarmed mid-frame: closed');
  cost.arm();
  cost.frameStarted(2);
  cost.arm();
  assert.equal(gl.active, null, 'armed afresh mid-frame: closed');
  cost.frameStarted(3);
  cost.frameStarted(4);
  assert.equal(gl.queries.filter(query => !query.ended).length, 1, 'one open frame at a time');
});

test('a frame begun while another owner\'s timer query is open is measured by its fence', () => {
  const { cost, frame, reports, gl } = harness({ timer: true });
  // The benchmark's pass profiler times a pass that runs on into the frame
  // (`app/ui/modules/benchmark/pass-profiler.js`): queries cannot nest.
  const other = gl.createQuery();
  gl.beginQuery(0x88bf, other);
  cost.arm();
  frame(200); frame(200); frame(200);
  assert.equal(gl.active, other, 'the other query is left open');
  assert.equal(gl.fences.length, 3);
  assert.equal(reports.length, 1);
});

test('the viewer arms a measurement only once what it measures is committed, and asks for its frame', async () => {
  const { readFile } = await import('node:fs/promises');
  const viewer = await readFile(new URL('../assets/js/rendering/viewer.js', import.meta.url), 'utf8');
  const body = (start, end) => viewer.slice(viewer.indexOf(start), viewer.indexOf(end, viewer.indexOf(start)));
  // A publication of cells: the last thing it does, once everything else
  // is published (a publication that failed changed nothing).
  const publication = body('  function publishLiveData(', '\n  }\n');
  assert.match(publication, /publishSmokeSourceChange\(\);\n(\s*\/\/.*\n)*\s*armFullDetailFrameCost\(\);\s*$/);
  assert.equal(publication.match(/armFullDetailFrameCost\(\)/g).length, 1);
  // Another representation: after the renderer took it and it is published.
  const positions = body('    updatePositions(positions, dimensionLevel) {', '\n    },\n');
  assert.ok(positions.indexOf('armFullDetailFrameCost()') > positions.indexOf('rendererPublished = true'));
  assert.match(positions, /publishSmokeSourceChange\(\);\n(\s*\/\/.*\n)*\s*armFullDetailFrameCost\(\);\s*$/);
  // A restored context: once the viewer accepts changes again.
  const restored = body("    'webglcontextrestored',", '\n  );\n');
  assert.ok(restored.indexOf('armFullDetailFrameCost()') > restored.indexOf('webglContextLost = false'));
  // Arming asks for a frame: it is measured now, not at whatever draws next.
  const arm = body('  function armFullDetailFrameCost() {', '\n  }\n');
  assert.match(arm, /fullDetailFrameCost\.arm\(\);\n(\s*\/\/.*\n)*\s*if \(!disposed && !webglContextLost\) invalidateFrame\(\);/);
  // And the scene is not settled while it owes frames.
  assert.match(viewer, /settled: nextFrameCause\(size\) === null && settleWindowElapsed\(\)\n\s*&& !frameCostOwesFrames\(\),/);
});
