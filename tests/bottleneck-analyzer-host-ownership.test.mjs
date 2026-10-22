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
