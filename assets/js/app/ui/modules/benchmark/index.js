/**
 * @fileoverview Benchmark harness entry point.
 *
 * Assembles the four pieces a render benchmark needs before its numbers mean
 * anything, and refuses to publish a baseline when any of them is missing:
 *
 * 1. A rasterizer identity, so a software-rasterized run is recorded as void
 *    rather than as a slow GPU.
 * 2. Per-frame upload and synchronous-stall counters, installed on the live
 *    context without touching the renderer.
 * 3. A deterministic camera path with a STATIC and an ORBIT regime, because
 *    the renderer's motion-dependent work does not run without motion.
 * 4. A full-window frame recorder whose percentiles are computed from every
 *    frame and withheld when the sample count cannot support them.
 *
 * Nothing here starts on import. The harness is created explicitly, against an
 * already-published viewer.
 *
 * @module app/ui/modules/benchmark
 */

import {
  BenchmarkCameraPath,
  CAMERA_REGIMES,
  createMutableCameraState,
  createSeededUnitStream,
  LOD_FAR_DISTANCE_RATIO,
  LOD_NEAR_DISTANCE_RATIO,
  pathFrameForRegime
} from './camera-path.js';
import {
  FrameRecorder,
  JANK_MEDIAN_MULTIPLE,
  MIN_TAIL_SAMPLES,
  percentileOfSorted,
  requiredSamplesForQuantile
} from './frame-recorder.js';
import { generateSyntheticDataOffThread } from './generation.js';
import {
  assertGenerationRequest,
  assertGenerationResponse,
  assertSyntheticCount,
  assertSyntheticPattern,
  FETCHED_PATTERNS,
  MAX_SYNTHETIC_COUNT,
  MIN_SYNTHETIC_COUNT,
  SYNTHETIC_PATTERNS
} from './generation-contract.js';
import {
  instrumentGlUploads,
  INSTRUMENTED_METHOD_NAMES,
  uploadCounterFields
} from './gl-upload-counter.js';
import {
  createBenchmarkMatrixRunner,
  expandMatrix,
  LIVE_VIEW_ID,
  MAX_BENCHMARK_VIEWS
} from './matrix-runner.js';
import {
  assertBaselineEligibleRasterizer,
  classifyRasterizer,
  readRendererIdentity,
  rendererBaselineKey,
  SOFTWARE_RASTERIZER_MARKERS
} from './renderer-identity.js';

export {
  assertBaselineEligibleRasterizer,
  assertGenerationRequest,
  assertGenerationResponse,
  assertSyntheticCount,
  assertSyntheticPattern,
  BenchmarkCameraPath,
  CAMERA_REGIMES,
  classifyRasterizer,
  createBenchmarkMatrixRunner,
  createMutableCameraState,
  createSeededUnitStream,
  expandMatrix,
  FETCHED_PATTERNS,
  FrameRecorder,
  generateSyntheticDataOffThread,
  instrumentGlUploads,
  INSTRUMENTED_METHOD_NAMES,
  JANK_MEDIAN_MULTIPLE,
  LIVE_VIEW_ID,
  LOD_FAR_DISTANCE_RATIO,
  LOD_NEAR_DISTANCE_RATIO,
  MAX_BENCHMARK_VIEWS,
  MAX_SYNTHETIC_COUNT,
  MIN_SYNTHETIC_COUNT,
  MIN_TAIL_SAMPLES,
  pathFrameForRegime,
  percentileOfSorted,
  readRendererIdentity,
  rendererBaselineKey,
  requiredSamplesForQuantile,
  SOFTWARE_RASTERIZER_MARKERS,
  SYNTHETIC_PATTERNS,
  uploadCounterFields
};

/**
 * Create a harness bound to one live viewer and canvas.
 *
 * @param {Object} options - Exact harness dependencies.
 * @param {Object} options.viewer - The published viewer.
 * @param {HTMLCanvasElement} options.canvas - The viewer's canvas.
 * @param {Document} [options.document] - Document owning the view controls.
 * @returns {Object} Harness handle; call `dispose()` to uninstall counters.
 */
export function createBenchmarkHarness(options = {}) {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options)
  ) {
    throw new TypeError('Benchmark harness options must be one plain object.');
  }
  const viewer = options.viewer;
  const canvas = options.canvas;
  if (canvas === null || typeof canvas?.getContext !== 'function') {
    throw new TypeError('Benchmark harness requires the viewer canvas.');
  }
  const gl = canvas.getContext('webgl2');
  if (gl === null) {
    throw new Error(
      'Benchmark harness requires the canvas WebGL2 context; the page ' +
      'published none.'
    );
  }

  const identity = readRendererIdentity(gl);
  const rasterizer = classifyRasterizer(identity);
  const uploadCounters = instrumentGlUploads(gl);
  const runner = createBenchmarkMatrixRunner({
    viewer,
    document: options.document ?? globalThis.document,
    uploadCounters
  });

  let disposed = false;

  return Object.freeze({
    /** Frozen rasterizer identity and canvas backing-store geometry. */
    identity,
    /** Frozen rasterizer classification, including baseline eligibility. */
    rasterizer,
    /** Live upload/stall counter handle. */
    uploadCounters,
    /** Configuration-matrix runner bound to the live viewer. */
    runner,
    /**
     * Throw unless this run may be recorded as a baseline.
     *
     * @returns {Object} The classification, when eligible.
     */
    assertBaselineEligible() {
      return assertBaselineEligibleRasterizer(identity);
    },
    /** @returns {string} Baseline key for this rasterizer. */
    baselineKey() {
      return rendererBaselineKey(identity);
    },
    /** Remove the context instrumentation. Idempotent. */
    dispose() {
      if (disposed) return;
      uploadCounters.restore();
      disposed = true;
    }
  });
}
