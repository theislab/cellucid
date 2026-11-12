import assert from 'node:assert/strict';
import test from 'node:test';

import { BottleneckAnalyzer } from '../assets/js/dev/benchmark.js';

function createAnalyzer({ hostPaused = false, failPhase = null } = {}) {
  const events = [];
  let paused = hostPaused;
  const host = {
    pause() { events.push('pause'); paused = true; },
    resume() { events.push('resume'); paused = false; },
    isPaused() { return paused; },
  };
  const renderer = {
    clearViewState(viewId) { events.push(`clear:${viewId}`); },
  };
  const analyzer = new BottleneckAnalyzer(null, renderer, host);
  const phase = (name, value) => async () => {
    events.push(`${name}:${paused ? 'paused' : 'running'}`);
    if (failPhase === name) throw new Error(`synthetic ${name} failure`);
    return value;
  };
  Object.assign(analyzer, {
    _runBaselineMeasurement: phase('baseline', { rawFrameTimes: [] }),
    _runCPUPhaseAnalysis: phase('cpu', {}),
    _runGPUAnalysis: phase('gpu', {}),
    _runBoundAnalysis: phase('bound', {}),
    _analyzeMemory: () => ({}),
    _analyzeThermal: () => ({}),
    _analyzeJank: () => ({}),
    _analyzeJSPressure: () => ({}),
    _determineBottleneckType: () => ({}),
    _generateRecommendations: () => [],
    _generateSummary: () => ({}),
  });
  return { analyzer, events, host };
}

test('analysis runs with the viewer paused and resumes it after releasing the benchmark view', async () => {
  const { analyzer, events, host } = createAnalyzer();
  await analyzer.runAnalysis({ warmupFrames: 1, testFrames: 1 });
  assert.deepEqual(events, [
    'pause',
    'baseline:paused',
    'cpu:paused',
    'gpu:paused',
    'bound:paused',
    'clear:benchmark',
    'resume',
  ]);
  assert.equal(host.isPaused(), false);
});

test('a viewer that was already paused stays paused', async () => {
  const { analyzer, events, host } = createAnalyzer({ hostPaused: true });
  await analyzer.runAnalysis({ warmupFrames: 1, testFrames: 1 });
  assert.equal(events.includes('pause'), false);
  assert.equal(events.includes('resume'), false);
  assert.equal(events.at(-1), 'clear:benchmark');
  assert.equal(host.isPaused(), true);
});

test('a failed phase still releases the benchmark view and resumes the viewer', async () => {
  const { analyzer, events, host } = createAnalyzer({ failPhase: 'gpu' });
  await assert.rejects(
    analyzer.runAnalysis({ warmupFrames: 1, testFrames: 1 }),
    /synthetic gpu failure/,
  );
  assert.deepEqual(events.slice(-2), ['clear:benchmark', 'resume']);
  assert.equal(host.isPaused(), false);
});

// The analyzer draws through the renderer's public `render()` with parameters
// it builds itself, so the renderer's contract is checked against them here:
// a parameter the contract adds and the analyzer lacks fails this test, not
// the person's Analyze performance (round 9, R9P-2: `pointSizeMax` was
// added to the contract and the analysis hung).
function createGl() {
  return {
    ALIASED_POINT_SIZE_RANGE: 0x846d,
    canvas: { width: 1280, height: 720 },
    // No GPU timer: the analysis measures with the clock alone.
    getExtension: () => null,
    getParameter(name) {
      if (name === 0x846d) return new Float32Array([1, 511]);
      throw new Error(`unexpected getParameter(${name})`);
    },
  };
}

test('the parameters the analyzer draws with satisfy the renderer contract', async () => {
  const { requireRenderContract } = await import('../assets/js/rendering/high-perf/renderer-contracts.js');
  const { pointSpriteCap } = await import('../assets/js/rendering/point-sprite.js');
  const gl = createGl();
  const renderer = { activeQuality: 'full', getViewPositionDimension: () => 3 };
  // As the panel builds it (app/main.js).
  const analyzer = new BottleneckAnalyzer(gl, renderer, null, { pointSizeMax: pointSpriteCap(gl) });
  const params = analyzer._getDefaultRenderParams();
  assert.doesNotThrow(() => requireRenderContract(params));
  assert.equal(params.pointSizeMax, 160);
});

test('a frame that throws ends the analysis with its error and resumes the viewer', async () => {
  const previous = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 0);
  try {
    for (const phase of ['baseline', 'gpu']) {
      const events = [];
      let paused = false;
      const host = {
        pause() { paused = true; },
        resume() { events.push('resume'); paused = false; },
        isPaused() { return paused; },
      };
      const renderer = {
        activeQuality: 'full',
        getViewPositionDimension: () => 3,
        render() { throw new TypeError(`render refused in ${phase}`); },
        getStats: () => ({}),
        clearViewState() { events.push('clear'); },
      };
      const analyzer = new BottleneckAnalyzer(createGl(), renderer, host, { pointSizeMax: 160 });
      if (phase === 'gpu') {
        const timer = { begin: () => ({}), end() {}, poll: () => [], reset() {}, getStats: () => ({}) };
        analyzer._runBaselineMeasurement = async () => ({ rawFrameTimes: [] });
        analyzer._runCPUPhaseAnalysis = async () => ({});
        analyzer.gpuTimer = timer;
      }
      await assert.rejects(
        analyzer.runAnalysis({ warmupFrames: 1, testFrames: 2 }),
        new RegExp(`render refused in ${phase}`),
      );
      assert.deepEqual(events, ['clear', 'resume']);
      assert.equal(host.isPaused(), false);
    }
  } finally {
    globalThis.requestAnimationFrame = previous;
  }
});

// R9P-3: the LOD sweep ordered its levels by index (level 0 is the smallest
// sample), so a frame that does not follow the point count scored ~10,000
// and was named "Vertex Processing" on every run, smooth or not.
test('the LOD sweep scores how frame time follows the points drawn', () => {
  const analyzer = new BottleneckAnalyzer(null, {}, null);
  const flat = analyzer._calculateLODScaling({
    0: { avg: 16.7, visiblePoints: 1_000 },
    8: { avg: 16.7, visiblePoints: 152_000 },
    16: { avg: 16.7, visiblePoints: 2_300_000 },
    32: { avg: 16.8, visiblePoints: 10_000_000 },
  });
  assert.ok(Math.abs(flat.scalingFactor - 1) < 0.01, `flat frames scored ${flat.scalingFactor}`);
  assert.equal(flat.mostPoints, 10_000_000);
  assert.equal(flat.fewestPoints, 1_000);
  const followed = analyzer._calculateLODScaling({
    0: { avg: 16.7, visiblePoints: 1_000 },
    32: { avg: 60, visiblePoints: 10_000_000 },
  });
  assert.ok(followed.scalingFactor > 3, `frames that follow the points scored ${followed.scalingFactor}`);
});

test('frames at the refresh name no bound and no frame-time advice', () => {
  const analyzer = new BottleneckAnalyzer(null, {}, null);
  const sizeTests = { 1: { avg: 16.7 }, 16: { avg: 16.8 } };
  const lodTests = { 0: { avg: 16.7, visiblePoints: 1_000 }, 32: { avg: 16.7, visiblePoints: 10_000_000 } };
  const pointSizeScaling = analyzer._calculateScaling(sizeTests);
  const lodScaling = analyzer._calculateLODScaling(lodTests);
  assert.ok(pointSizeScaling.scalingFactor < 1.5 && lodScaling.scalingFactor < 1.5);
  const recs = analyzer._generateRecommendations(
    { fps: 60, avgFrameTime: 16.7 },
    { lodOverhead: { overhead: 0.1 }, frustumCullingOverhead: { overhead: 0 } },
    { available: true, boundBy: 'GPU', gpuUtilization: 90 },
    { boundType: 'balanced', pointSizeScaling, lodScaling, analysis: {} },
    { memoryPressure: { level: 'low' } },
    { hasJank: false },
    { health: 'good', issues: [] },
  );
  const titles = (recs.recommendations ?? recs).map(r => r.title);
  assert.ok(!titles.includes('Reduce GPU workload'), `advised at 60 FPS: ${titles}`);
});
