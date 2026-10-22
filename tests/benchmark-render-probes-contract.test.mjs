/**
 * Contracts for the render probes the scenario driver (`scripts/
 * render-scenarios.mjs`) measures with: multi-draw counting, pass attribution
 * and its program classification, frames per cause, input latency and long
 * tasks. Each runs here against a fake context, clock or scheduler, so the
 * numbers a browser run reports rest on logic proven without one.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyScheduleSample,
  createFrameCauseSampler,
  SETTLE_CAUSE
} from '../assets/js/app/ui/modules/benchmark/frame-cause-sampler.js';
import {
  instrumentGlUploads,
  INSTRUMENTED_MULTI_DRAW_METHOD_NAMES
} from '../assets/js/app/ui/modules/benchmark/gl-upload-counter.js';
import { createInputLatencyTracker } from '../assets/js/app/ui/modules/benchmark/input-latency.js';
import {
  createLongTaskProbe,
  DRIFT_PERIOD_MS
} from '../assets/js/app/ui/modules/benchmark/long-task-probe.js';
import {
  classifyProgramUniforms,
  createPassProfiler,
  OTHER_PASS
} from '../assets/js/app/ui/modules/benchmark/pass-profiler.js';
import * as harness from '../assets/js/app/ui/modules/benchmark/index.js';
import * as pointShaders from '../assets/js/rendering/shaders/high-perf-shaders.js';
import * as edgeGridShaders from '../assets/js/rendering/shaders/edge-grid-shaders.js';
import * as studioShaders from '../assets/js/rendering/shaders/studio-shaders.js';
import * as centroidShaders from '../assets/js/rendering/shaders/centroid-shaders.js';
import * as anchorShaders from '../assets/js/rendering/shaders/orbit-anchor-shaders.js';
import * as velocityShaders from '../assets/js/rendering/overlays/velocity/velocity-shaders.js';
import * as smokeShaders from '../assets/js/rendering/shaders/smoke-shaders.js';
import * as densityShaders from '../assets/js/rendering/shaders/density-shaders.js';
import * as noiseShaders from '../assets/js/rendering/shaders/noise-shaders.js';

const ENUMS = Object.freeze({
  ARRAY_BUFFER: 0x8892,
  ELEMENT_ARRAY_BUFFER: 0x8893,
  POINTS: 0x0000,
  TRIANGLES: 0x0004,
  TRIANGLE_STRIP: 0x0005,
  UNSIGNED_INT: 0x1405,
  ACTIVE_UNIFORMS: 0x8b86,
  QUERY_RESULT: 0x8866,
  QUERY_RESULT_AVAILABLE: 0x8867,
  COLOR_BUFFER_BIT: 0x4000
});

class FakeMultiDraw {
  constructor(calls) {
    this.calls = calls;
  }
  multiDrawArraysWEBGL(...args) {
    this.calls.push(['multiDrawArraysWEBGL', args.length]);
  }
  multiDrawElementsWEBGL(...args) {
    this.calls.push(['multiDrawElementsWEBGL', args.length]);
  }
  multiDrawArraysInstancedWEBGL(...args) {
    this.calls.push(['multiDrawArraysInstancedWEBGL', args.length]);
  }
  multiDrawElementsInstancedWEBGL(...args) {
    this.calls.push(['multiDrawElementsInstancedWEBGL', args.length]);
  }
}

class FakeTimerQuery {
  constructor() {
    this.TIME_ELAPSED_EXT = 0x88bf;
    this.GPU_DISJOINT_EXT = 0x8fbb;
  }
}

/** A WebGL2-shaped fake: methods on the prototype, as on a real context. */
class FakeContext {
  constructor({ uniformsByProgram = new Map(), timing = false } = {}) {
    Object.assign(this, ENUMS);
    this.calls = [];
    this.multiDraw = new FakeMultiDraw(this.calls);
    this.timer = timing ? new FakeTimerQuery() : null;
    this.uniformsByProgram = uniformsByProgram;
    this.queries = [];
    this.activeQuery = null;
    this.deletedQueries = 0;
  }
  getExtension(name) {
    if (name === 'WEBGL_multi_draw') return this.multiDraw;
    if (name === 'EXT_disjoint_timer_query_webgl2') return this.timer;
    return null;
  }
  bufferData() {}
  bufferSubData() {}
  texImage2D() {}
  texSubImage2D() {}
  drawArrays(...args) {
    this.calls.push(['drawArrays', args.length]);
  }
  drawElements() {}
  drawArraysInstanced(...args) {
    this.calls.push(['drawArraysInstanced', args.length]);
  }
  drawElementsInstanced() {}
  getError() {
    return 0;
  }
  finish() {}
  flush() {}
  readPixels() {}
  getBufferSubData() {}
  useProgram(program) {
    this.calls.push(['useProgram', program]);
  }
  blitFramebuffer(...args) {
    this.calls.push(['blitFramebuffer', args.length]);
  }
  clear(mask) {
    this.calls.push(['clear', mask]);
  }
  getProgramParameter(program, parameter) {
    assert.equal(parameter, ENUMS.ACTIVE_UNIFORMS);
    return this.uniformsByProgram.get(program).length;
  }
  getActiveUniform(program, index) {
    return { name: this.uniformsByProgram.get(program)[index] };
  }
  getParameter() {
    return false;
  }
  createQuery() {
    const query = { id: this.queries.length, ended: false };
    this.queries.push(query);
    return query;
  }
  beginQuery(target, query) {
    assert.equal(this.activeQuery, null, 'queries must never nest');
    this.activeQuery = query;
  }
  endQuery() {
    assert.notEqual(this.activeQuery, null);
    this.activeQuery.ended = true;
    this.activeQuery = null;
  }
  getQueryParameter(query, parameter) {
    if (parameter === ENUMS.QUERY_RESULT_AVAILABLE) return query.ended;
    return 2_000_000; // 2 ms per query
  }
  deleteQuery() {
    this.deletedQueries++;
  }
}

/** Uniform names a shader pair declares (active uniforms are a subset). */
function declaredUniforms(...sources) {
  const names = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(
      /uniform\s+(?:(?:highp|mediump|lowp)\s+)?\w+\s+(\w+)/g
    )) {
      names.add(match[1]);
    }
  }
  return [...names];
}

test('the harness entry point publishes every render probe', () => {
  for (const name of [
    'installRenderProbes',
    'createPassProfiler',
    'createFrameCauseSampler',
    'createInputLatencyTracker',
    'createLongTaskProbe',
    'classifyProgramUniforms',
    'INSTRUMENTED_MULTI_DRAW_METHOD_NAMES'
  ]) {
    assert.ok(name in harness, `${name} must be exported by the harness`);
  }
});

test('multi-draw entry points count draws, ranges, vertices and instances', () => {
  const gl = new FakeContext();
  const handle = instrumentGlUploads(gl);
  assert.equal(handle.multiDrawInstrumented, true);
  for (const name of INSTRUMENTED_MULTI_DRAW_METHOD_NAMES) {
    assert.equal(Object.hasOwn(gl.multiDraw, name), true, `${name} is shadowed`);
  }
  const firsts = new Int32Array([0, 100, 400]);
  const counts = new Int32Array([10, 20, 30]);
  gl.multiDraw.multiDrawArraysWEBGL(gl.POINTS, firsts, 0, counts, 0, 3);
  gl.multiDraw.multiDrawArraysWEBGL(gl.POINTS, firsts, 1, counts, 1, 2);
  gl.multiDraw.multiDrawArraysInstancedWEBGL(
    gl.TRIANGLE_STRIP, firsts, 0, new Int32Array([4, 4]), 0, new Int32Array([5, 7]), 0, 2
  );
  gl.drawArrays(gl.POINTS, 0, 1000);
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 250);

  assert.equal(handle.frame.drawCalls, 5);
  assert.equal(handle.frame.multiDrawCalls, 3);
  assert.equal(handle.frame.multiDrawRanges, 7);
  assert.equal(handle.frame.verticesSubmitted, 60 + 50 + 48 + 1000 + 1000);
  assert.equal(handle.frame.instancesSubmitted, 12 + 250);
  assert.deepEqual(
    gl.calls.filter(([name]) => name.startsWith('multiDraw')),
    [
      ['multiDrawArraysWEBGL', 6],
      ['multiDrawArraysWEBGL', 6],
      ['multiDrawArraysInstancedWEBGL', 8]
    ],
    'the wrappers forward the exact arity'
  );

  handle.restore();
  for (const name of INSTRUMENTED_MULTI_DRAW_METHOD_NAMES) {
    assert.equal(Object.hasOwn(gl.multiDraw, name), false, `${name} is restored`);
  }
});

test('a context without the multi-draw extension is still instrumented', () => {
  const gl = new FakeContext();
  gl.multiDraw = null;
  const handle = instrumentGlUploads(gl);
  assert.equal(handle.multiDrawInstrumented, false);
  handle.restore();
});

test('every program the application links classifies to its own pass', () => {
  const cases = [
    ['points', pointShaders.HP_VS_FULL, pointShaders.HP_FS_FULL],
    ['points', pointShaders.HP_VS_FULL, pointShaders.HP_FS_SCULPTED_NO_DEPTH],
    ['points', pointShaders.HP_VS_LIGHT, pointShaders.HP_FS_ULTRALIGHT],
    ['highlight', pointShaders.HP_VS_HIGHLIGHT, pointShaders.HP_FS_HIGHLIGHT],
    ['edges', edgeGridShaders.LINE_INSTANCED_VS_SOURCE, edgeGridShaders.LINE_INSTANCED_FS_SOURCE],
    ['grid', edgeGridShaders.GRID_VS_SOURCE, edgeGridShaders.GRID_FS_SOURCE],
    ['studio', studioShaders.STUDIO_VS_SOURCE, studioShaders.STUDIO_FS_SOURCE],
    ['centroids', centroidShaders.CENTROID_VS, centroidShaders.CENTROID_FS],
    ['orbit-anchor', anchorShaders.ORBIT_ANCHOR_VS, anchorShaders.ORBIT_ANCHOR_FS],
    ['velocity-sim', velocityShaders.PARTICLE_UPDATE_VS, velocityShaders.PARTICLE_UPDATE_FS],
    ['velocity-particles', velocityShaders.PARTICLE_RENDER_VS, velocityShaders.PARTICLE_RENDER_FS],
    ['velocity-post', velocityShaders.FULLSCREEN_VS, velocityShaders.TRAIL_FADE_FS],
    ['velocity-post', velocityShaders.FULLSCREEN_VS, velocityShaders.THRESHOLD_FS],
    ['velocity-post', velocityShaders.FULLSCREEN_VS, velocityShaders.BLUR_FS],
    ['velocity-post', velocityShaders.FULLSCREEN_VS, velocityShaders.ANAMORPHIC_BLUR_FS],
    ['velocity-post', velocityShaders.FULLSCREEN_VS, velocityShaders.COMPOSITE_FS],
    ['smoke-march', smokeShaders.SMOKE_VS_SOURCE, smokeShaders.SMOKE_FS_SOURCE],
    ['smoke-composite', smokeShaders.SMOKE_COMPOSITE_VS, smokeShaders.SMOKE_COMPOSITE_FS],
    ['smoke-build', densityShaders.SPLAT_VS, densityShaders.SPLAT_FS],
    ['smoke-build', densityShaders.SPLAT_COLOR_VS, densityShaders.SPLAT_COLOR_FS],
    ['smoke-build', densityShaders.NORMALIZE_VS, densityShaders.REDUCE_MAX_FS],
    ['smoke-build', densityShaders.NORMALIZE_VS, densityShaders.NORMALIZE_FS],
    ['smoke-build', densityShaders.NORMALIZE_VS, densityShaders.LIGHT_VOLUME_FS],
    ['smoke-build', densityShaders.NORMALIZE_VS, densityShaders.OCCUPANCY_FS],
    ['smoke-noise', noiseShaders.NOISE_VS, noiseShaders.SHAPE_NOISE_FS],
    ['smoke-noise', noiseShaders.NOISE_VS, noiseShaders.DETAIL_NOISE_FS]
  ];
  for (const [expected, vs, fs] of cases) {
    assert.equal(
      classifyProgramUniforms(declaredUniforms(vs, fs)),
      expected,
      `a program declaring ${declaredUniforms(vs, fs).join(', ')} is ${expected}`
    );
  }
  assert.equal(classifyProgramUniforms(['u_arrayValue[0]', 'u_unknown']), OTHER_PASS);
  assert.equal(classifyProgramUniforms(['u_highlightScale[0]']), 'highlight');
});

test('draws are attributed to the pass whose program issued them', async () => {
  const pointsProgram = { name: 'points' };
  const highlightProgram = { name: 'highlight' };
  const gl = new FakeContext({
    uniformsByProgram: new Map([
      [pointsProgram, ['u_pointScale', 'u_alphaTex']],
      [highlightProgram, ['u_highlightScale', 'u_pointScale']]
    ])
  });
  const uploads = instrumentGlUploads(gl);
  const profiler = createPassProfiler(gl, { uploadCounters: uploads });
  const windowToken = profiler.openWindow();

  for (let frame = 0; frame < 2; frame++) {
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(pointsProgram);
    gl.drawArrays(gl.POINTS, 0, 1000);
    gl.useProgram(pointsProgram);
    gl.drawArrays(gl.POINTS, 0, 500);
    gl.useProgram(highlightProgram);
    gl.drawArrays(gl.POINTS, 0, 7);
    gl.blitFramebuffer(0, 0, 1, 1, 0, 0, 1, 1, gl.COLOR_BUFFER_BIT, 0);
    profiler.endFrame();
    uploads.closeFrame();
  }

  const summary = await profiler.closeWindow(windowToken);
  assert.equal(summary.frames, 2);
  assert.equal(summary.timing, false);
  assert.equal(summary.passes.points.drawCalls, 4);
  assert.equal(summary.passes.points.verticesSubmitted, 3000);
  assert.equal(summary.passes.points.entries, 2, 'one run of points per frame');
  assert.equal(summary.passes.highlight.drawCalls, 2);
  assert.equal(summary.passes.highlight.verticesSubmitted, 14);
  assert.equal(summary.passes.resolve.entries, 2);
  assert.equal(summary.passes.clear.entries, 2);
  assert.equal(summary.passes.points.drawCallsPerFrame, 2);
  assert.equal(summary.passes.points.gpuMsPerFrame, null);

  profiler.restore();
  uploads.restore();
  for (const name of ['useProgram', 'blitFramebuffer', 'clear']) {
    assert.equal(Object.hasOwn(gl, name), false, `${name} is handed back`);
  }
});

test('timed passes use one query per run, never nested, and report GPU time', async () => {
  const pointsProgram = {};
  const edgesProgram = {};
  const gl = new FakeContext({
    timing: true,
    uniformsByProgram: new Map([
      [pointsProgram, ['u_lodIndexTex']],
      [edgesProgram, ['u_lineWidth', 'u_viewportSize']]
    ])
  });
  const uploads = instrumentGlUploads(gl);
  const profiler = createPassProfiler(gl, {
    uploadCounters: uploads,
    timing: true,
    requestFrame: callback => setTimeout(callback, 0)
  });
  assert.equal(profiler.timing, true);
  const token = profiler.openWindow();
  gl.useProgram(pointsProgram);
  gl.drawArrays(gl.POINTS, 0, 10);
  gl.useProgram(edgesProgram);
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 100);
  profiler.endFrame();
  const summary = await profiler.closeWindow(token);
  assert.equal(summary.passes.points.gpuQueries, 1);
  assert.equal(summary.passes.edges.gpuQueries, 1);
  assert.equal(summary.passes.points.gpuMs, 2);
  assert.equal(summary.passes.edges.instancesSubmitted, 100);
  assert.equal(gl.activeQuery, null);
  profiler.restore();
  uploads.restore();
});

test('a schedule sample tells a cause frame from a settle frame and from no frame', () => {
  const first = classifyScheduleSample(
    null,
    { msSinceCause: 5, framesDrawnSinceCause: 1, lastCause: 'invalidated' },
    100
  );
  assert.equal(first.drawn, false, 'the first sample has nothing to compare with');

  const previous = { causeTime: 95, framesDrawnSinceCause: 1 };
  const newCause = classifyScheduleSample(
    previous,
    { msSinceCause: 1, framesDrawnSinceCause: 1, lastCause: 'highlight' },
    112
  );
  assert.deepEqual(
    { drawn: newCause.drawn, cause: newCause.cause },
    { drawn: true, cause: 'highlight' }
  );

  const settle = classifyScheduleSample(
    previous,
    { msSinceCause: 17, framesDrawnSinceCause: 2, lastCause: 'invalidated' },
    112
  );
  assert.deepEqual(
    { drawn: settle.drawn, cause: settle.cause },
    { drawn: true, cause: SETTLE_CAUSE }
  );

  const idle = classifyScheduleSample(
    previous,
    { msSinceCause: 34, framesDrawnSinceCause: 1, lastCause: 'invalidated' },
    129
  );
  assert.equal(idle.drawn, false);
});

function createFakeScheduler() {
  let clock = 0;
  const queue = [];
  const owner = {
    requestAnimationFrame(callback) {
      queue.push(callback);
      return queue.length;
    },
    cancelAnimationFrame() {
      queue.length = 0;
    }
  };
  return {
    owner,
    now: () => clock,
    /** Run one frame: every queued callback, in order. */
    frame(advanceMs = 16) {
      clock += advanceMs;
      const callbacks = queue.splice(0);
      for (const callback of callbacks) callback(clock);
    }
  };
}

test('the sampler counts frames per cause and wake-ups from other code', () => {
  const scheduler = createFakeScheduler();
  let schedule = { msSinceCause: 0, framesDrawnSinceCause: 0, lastCause: null, settled: true };
  let causeTime = 0;
  const viewer = { getFrameScheduleState: () => ({ ...schedule, msSinceCause: scheduler.now() - causeTime }) };
  const sampler = createFrameCauseSampler({
    viewer,
    window: scheduler.owner,
    now: scheduler.now
  });
  const originalRequest = scheduler.owner.requestAnimationFrame;
  sampler.start();
  assert.notEqual(scheduler.owner.requestAnimationFrame, originalRequest);
  scheduler.frame(); // the first sample establishes the baseline

  // Each frame the viewer draws before the sampler's callback runs, so the
  // schedule a frame publishes is set before that frame is run.
  const token = sampler.openWindow();
  for (let frame = 0; frame < 3; frame++) {
    causeTime = scheduler.now() + 16;
    schedule = { ...schedule, framesDrawnSinceCause: 1, lastCause: 'highlight', settled: false };
    scheduler.frame();
  }
  // One settle frame, then quiet.
  schedule = { ...schedule, framesDrawnSinceCause: 2 };
  scheduler.frame();
  schedule = { ...schedule, settled: true };
  scheduler.frame();
  scheduler.frame();
  // Something else keeps asking for frames while idle.
  scheduler.owner.requestAnimationFrame(() => {});
  scheduler.owner.requestAnimationFrame(() => {});
  scheduler.frame();

  const summary = sampler.closeWindow(token);
  assert.equal(summary.ticks, 7);
  assert.equal(summary.drawnFrames, 4);
  assert.deepEqual(summary.causes, { highlight: 3, [SETTLE_CAUSE]: 1 });
  assert.equal(summary.otherFrameRequests, 2);

  sampler.stop();
  assert.equal(scheduler.owner.requestAnimationFrame, originalRequest);
});

test('input latency is the time from each input to the next drawn frame', () => {
  const listeners = new Set();
  const sampler = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
  const handlers = new Map();
  const target = {
    addEventListener(type, handler) {
      handlers.set(type, handler);
    },
    removeEventListener(type) {
      handlers.delete(type);
    }
  };
  const tracker = createInputLatencyTracker({ sampler, target });
  tracker.start();
  const token = tracker.openWindow();
  const emit = (type, timeStamp) => handlers.get(type)({ type, timeStamp });
  const tick = (at, drawn) => {
    for (const listener of listeners) listener({ at, drawn });
  };

  emit('pointermove', 100);
  emit('pointermove', 104); // superseded before any frame
  tick(110, false);
  tick(120, true); // answers the 104 move: 16 ms
  emit('pointermove', 130);
  tick(140, true); // 10 ms
  emit('pointermove', 150); // never answered

  const summary = tracker.closeWindow(token);
  assert.deepEqual(summary.pointermove, {
    inputs: 4,
    answered: 2,
    unanswered: 2,
    p50Ms: 13,
    p95Ms: 15.7,
    maxMs: 16
  });
  tracker.stop();
  assert.equal(handlers.size, 0);
});

test('the drift probe reports gaps over the long-task threshold', () => {
  let clock = 0;
  let intervalCallback = null;
  const scope = {
    setInterval(callback, period) {
      assert.equal(period, DRIFT_PERIOD_MS);
      intervalCallback = callback;
      return 1;
    },
    clearInterval() {
      intervalCallback = null;
    }
  };
  const probe = createLongTaskProbe({ scope, source: 'drift', now: () => clock });
  probe.start();
  const token = probe.openWindow();
  const advance = ms => {
    clock += ms;
    intervalCallback();
  };
  advance(10);
  advance(10);
  advance(130); // a 120 ms task
  advance(10);
  advance(70); // a 60 ms task
  const summary = probe.closeWindow(token);
  assert.equal(summary.source, 'drift');
  assert.equal(summary.count, 2);
  assert.equal(summary.maxMs, 120);
  assert.equal(summary.totalMs, 180);
  probe.stop();
  assert.equal(intervalCallback, null);
});
