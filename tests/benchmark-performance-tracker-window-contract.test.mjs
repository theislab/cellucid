import assert from 'node:assert/strict';
import test from 'node:test';

import { PerformanceTracker } from '../assets/js/app/ui/modules/benchmark/performance-tracker.js';

function drive(tracker, frameTimes) {
  const originalNow = performance.now;
  let clock = 1000;
  performance.now = () => clock;
  try {
    tracker.start();
    let stats = null;
    for (const frameTime of frameTimes) {
      clock += frameTime;
      stats = tracker.recordFrame();
    }
    return stats;
  } finally {
    performance.now = originalNow;
  }
}

test('over-budget percentage covers the rolling sample window', () => {
  const tracker = new PerformanceTracker({ maxSamples: 120, warmupFrames: 0 });
  const stats = drive(tracker, new Array(500).fill(33.4));
  assert.equal(stats.samples, 120);
  assert.equal(stats.overBudgetFrames, 120);
  assert.equal(stats.overBudgetPercent, 100);
});

test('jank percentage covers the rolling sample window', () => {
  const tracker = new PerformanceTracker({ maxSamples: 120, warmupFrames: 0 });
  const frames = [];
  for (let index = 0; index < 1000; index++) {
    frames.push(index % 4 === 3 ? 40 : 10);
  }
  const stats = drive(tracker, frames);
  assert.equal(stats.samples, 120);
  assert.ok(stats.jankPercent <= 100, `jank ${stats.jankPercent}%`);
  // One frame in four is a 40 ms spike against a ~17.5 ms average.
  assert.equal(stats.jankFrames, 30);
  assert.equal(stats.jankPercent, 25);
});

test('a slow phase that has left the window no longer counts', () => {
  const tracker = new PerformanceTracker({ maxSamples: 10, warmupFrames: 0 });
  const stats = drive(tracker, [...new Array(10).fill(40), ...new Array(10).fill(5)]);
  assert.equal(stats.overBudgetFrames, 0);
  assert.equal(stats.overBudgetPercent, 0);
  assert.equal(stats.jankFrames, 0);
});
