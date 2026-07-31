import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FrameRecorder,
  JANK_MEDIAN_MULTIPLE,
  MIN_TAIL_SAMPLES,
  percentileOfSorted,
  requiredSamplesForQuantile
} from '../assets/js/app/ui/modules/benchmark/frame-recorder.js';

function fill(recorder, frameTimes, options = {}) {
  const {
    uploadCalls = 0,
    uploadBytes = 0,
    elementUploadCalls = 0,
    syncStallCalls = 0,
    lodLevel = 5
  } = options;
  for (const frameTime of frameTimes) {
    recorder.record(
      frameTime,
      uploadCalls,
      uploadBytes,
      elementUploadCalls,
      syncStallCalls,
      lodLevel
    );
  }
}

test('a percentile needs enough samples beyond it to be reported', () => {
  // Twenty frames must sit beyond the quantile before it is a measurement
  // rather than a restatement of the worst frame in a short window.
  assert.equal(requiredSamplesForQuantile(0.5), MIN_TAIL_SAMPLES * 2);
  assert.equal(requiredSamplesForQuantile(0.95), 400);
  assert.equal(requiredSamplesForQuantile(0.99), 2000);
  assert.throws(() => requiredSamplesForQuantile(1), /strictly between/);
  assert.throws(() => requiredSamplesForQuantile(0), /strictly between/);
});

test('an under-powered window withholds the percentile it cannot support', () => {
  // The rolling 120-sample window this recorder replaces reported a "p99"
  // that was the second-worst frame of a two-second window. Withholding it is
  // the honest outcome, and the required count is stated so it can be fixed.
  const recorder = new FrameRecorder({ capacity: 120 });
  fill(recorder, Array.from({ length: 120 }, (_unused, i) => 16 + i * 0.01));
  const summary = recorder.summarize();

  assert.equal(summary.samples, 120);
  assert.equal(summary.windowFilled, true);
  assert.equal(summary.frameTimeMs.median !== null, true);
  assert.equal(summary.percentileSupport.median.reported, true);
  assert.equal(summary.frameTimeMs.p95, null);
  assert.equal(summary.percentileSupport.p95.reported, false);
  assert.equal(summary.percentileSupport.p95.requiredSamples, 400);
  assert.equal(summary.frameTimeMs.p99, null);
  assert.equal(summary.percentileSupport.p99.reported, false);
  assert.equal(summary.percentileSupport.p99.requiredSamples, 2000);
});

test('a full window reports every percentile from every recorded frame', () => {
  const capacity = 2400;
  const recorder = new FrameRecorder({ capacity });
  const frameTimes = Array.from(
    { length: capacity },
    (_unused, index) => 10 + index / 100
  );
  fill(recorder, frameTimes);
  const summary = recorder.summarize();

  assert.equal(summary.samples, capacity);
  assert.equal(summary.percentileSupport.p95.reported, true);
  assert.equal(summary.percentileSupport.p99.reported, true);

  const sorted = [...frameTimes].sort((a, b) => a - b);
  for (const quantile of [0.5, 0.95, 0.99]) {
    const expected = percentileOfSorted(sorted, capacity, quantile);
    const key = quantile === 0.5 ? 'median' : quantile === 0.95 ? 'p95' : 'p99';
    assert.ok(
      Math.abs(summary.frameTimeMs[key] - expected) < 1e-9,
      `${key} must come from the whole window`
    );
  }
  assert.equal(summary.frameTimeMs.min, sorted[0]);
  assert.equal(summary.frameTimeMs.max, sorted[capacity - 1]);
  assert.ok(Math.abs(summary.frameTimeMs.mean - 21.995) < 1e-6);
});

test('the window is bounded and never grows under the measurement', () => {
  const recorder = new FrameRecorder({ capacity: 4 });
  assert.equal(recorder.record(1, 0, 0, 0, 0, 0), true);
  assert.equal(recorder.record(2, 0, 0, 0, 0, 0), true);
  assert.equal(recorder.record(3, 0, 0, 0, 0, 0), true);
  assert.equal(recorder.record(4, 0, 0, 0, 0, 0), true);
  assert.equal(recorder.isFull(), true);
  assert.equal(recorder.record(5, 0, 0, 0, 0, 0), false);
  assert.equal(recorder.summarize().samples, 4);
  assert.equal(recorder.frameTimes.length, 4);

  recorder.reset();
  assert.equal(recorder.count, 0);
  assert.equal(recorder.isFull(), false);
});

test('an empty window reports nothing rather than zero', () => {
  const summary = new FrameRecorder({ capacity: 8 }).summarize();
  assert.equal(summary.samples, 0);
  assert.equal(summary.frameTimeMs.median, null);
  assert.equal(summary.frameTimeMs.p95, null);
  assert.equal(summary.frameTimeMs.p99, null);
  assert.equal(summary.jank.percent, null);
  assert.equal(summary.uploads.meanBytesPerFrame, null);
});

test('jank is measured against the median, not the self-inflated mean', () => {
  const recorder = new FrameRecorder({ capacity: 100 });
  const frameTimes = Array.from(
    { length: 100 },
    (_unused, index) => (index < 90 ? 10 : 100)
  );
  fill(recorder, frameTimes);
  const summary = recorder.summarize();
  assert.equal(summary.jank.thresholdMs, 10 * JANK_MEDIAN_MULTIPLE);
  assert.equal(summary.jank.frames, 10);
  assert.equal(summary.jank.percent, 10);
});

test('upload channels are reduced without losing the per-frame extremes', () => {
  const recorder = new FrameRecorder({ capacity: 4 });
  recorder.record(16, 0, 0, 0, 0, 3);
  recorder.record(16, 2, 1024, 1, 4, 3);
  recorder.record(16, 0, 0, 0, 2, 4);
  recorder.record(16, 5, 80 * 1024 * 1024, 3, 4, 5);
  const summary = recorder.summarize();

  assert.equal(summary.uploads.totalCalls, 7);
  assert.equal(summary.uploads.totalBytes, 1024 + 80 * 1024 * 1024);
  assert.equal(summary.uploads.totalElementCalls, 4);
  assert.equal(summary.uploads.totalSyncStallCalls, 10);
  assert.equal(summary.uploads.framesWithUpload, 2);
  assert.equal(summary.uploads.framesWithUploadPercent, 50);
  assert.equal(summary.uploads.maxCallsInOneFrame, 5);
  assert.equal(summary.uploads.maxBytesInOneFrame, 80 * 1024 * 1024);
});

test('LOD transitions are counted so a sweep can be proved, not assumed', () => {
  const recorder = new FrameRecorder({ capacity: 6 });
  for (const level of [3, 3, 4, 4, 5, 3]) {
    recorder.record(16, 0, 0, 0, 0, level);
  }
  const summary = recorder.summarize();
  assert.equal(summary.lod.minLevel, 3);
  assert.equal(summary.lod.maxLevel, 5);
  assert.equal(summary.lod.transitions, 3);
  assert.equal(summary.lod.distinctLevels, 3);
});

test('a single-level window reports no transition', () => {
  const recorder = new FrameRecorder({ capacity: 3 });
  for (let i = 0; i < 3; i++) recorder.record(16, 0, 0, 0, 0, 7);
  const summary = recorder.summarize();
  assert.equal(summary.lod.transitions, 0);
  assert.equal(summary.lod.distinctLevels, 1);
  assert.equal(summary.lod.minLevel, 7);
  assert.equal(summary.lod.maxLevel, 7);
});

test('the recorder rejects a window it cannot allocate exactly', () => {
  assert.throws(
    () => new FrameRecorder({ capacity: 0 }),
    /positive safe integer/
  );
  assert.throws(
    () => new FrameRecorder({ capacity: 1.5 }),
    /positive safe integer/
  );
  assert.throws(() => new FrameRecorder(null), /plain object/);
});

test('percentile interpolation uses one estimator everywhere', () => {
  const sorted = [1, 2, 3, 4];
  assert.equal(percentileOfSorted(sorted, 4, 0.5), 2.5);
  assert.equal(percentileOfSorted(sorted, 4, 0), 1);
  assert.equal(percentileOfSorted(sorted, 4, 1), 4);
  assert.equal(percentileOfSorted([9], 1, 0.99), 9);
  assert.equal(
    new FrameRecorder({ capacity: 1 }).summarize().percentileEstimator,
    'linear-interpolation-on-sorted-samples'
  );
});
