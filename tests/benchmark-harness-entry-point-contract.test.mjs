/**
 * The configuration-matrix harness under `assets/js/app/ui/modules/benchmark/`
 * is the only thing in the tree that can sweep LOD, frustum culling and view
 * count while counting per-frame GPU uploads. It needs an entry point in the
 * running application: nothing else imports it, and the page is served under
 * `script-src 'self'` with one hashed inline block, so it cannot be
 * bootstrapped from the page either.
 *
 * This test pins the wiring to the module's real surface, so the entry point
 * cannot survive as a name that resolves to nothing.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import * as harness from '../assets/js/app/ui/modules/benchmark/index.js';
import {
  PerformanceTracker as LivePerformanceTracker,
} from '../assets/js/app/ui/modules/benchmark/performance-tracker.js';
import {
  PerformanceTracker as PublicPerformanceTracker,
} from '../assets/js/dev/benchmark.js';

test('the live tracker is the stable public PerformanceTracker', () => {
  assert.strictEqual(PublicPerformanceTracker, LivePerformanceTracker);
  const tracker = new LivePerformanceTracker({ warmupFrames: 0 });
  assert.equal(typeof tracker.recordFrame, 'function');
  assert.equal(typeof tracker.pause, 'function');
  assert.equal(typeof tracker.resume, 'function');
});

test('the published module is the one the harness is created from', () => {
  assert.equal(typeof harness.createBenchmarkHarness, 'function');
  // `createBenchmarkHarness({ viewer, canvas })` is the documented call; the
  // canvas argument is mandatory, which is what binds the harness to the live
  // context rather than to a detached one.
  assert.throws(
    () => harness.createBenchmarkHarness({ viewer: {}, canvas: null }),
    /requires the viewer canvas/
  );
  assert.throws(
    () => harness.createBenchmarkHarness(null),
    /must be one plain object/
  );

  for (const name of [
    'createBenchmarkMatrixRunner',
    'expandMatrix',
    'instrumentGlUploads',
    'readRendererIdentity',
    'FrameRecorder',
    'BenchmarkCameraPath'
  ]) {
    assert.equal(
      typeof harness[name],
      'function',
      `the harness entry point must re-export ${name}`
    );
  }
});
