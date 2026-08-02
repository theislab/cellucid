/**
 * @fileoverview Configuration-matrix runner for the render benchmark.
 *
 * Sweeps the render configuration against the application's live viewer and
 * records one frame-time distribution per cell. It toggles the three axes that
 * decide which code path the renderer takes — adaptive LOD, frustum culling and
 * view count — and runs every cell under both camera regimes, because the
 * STATIC/ORBIT difference is the direct measure of the avoidable per-frame CPU
 * work the axes gate.
 *
 * Measuring the viewer the user actually runs is the point: a matrix swept
 * against a renderer built for the benchmark would report LOD and culling
 * behaviour for a configuration nobody ever sees.
 *
 * The view-count axis respects the viewer's own mechanics rather than fighting
 * them. Setting the layout to `grid` alone changes nothing: the viewer stays on
 * its single-viewport path until at least two views are published, and a view
 * beyond the live one exists only once a snapshot is created. Snapshots are
 * capped at three, so four views is the ceiling of this axis, not a choice.
 * Snapshots are published through the application's own keep-view control so
 * the renderer, the data state and the dimension owner stay in agreement.
 *
 * The measured window allocates nothing: the camera state, the counters and the
 * per-frame channels are all created before the window opens.
 *
 * @module app/ui/modules/benchmark/matrix-runner
 */

import {
  BenchmarkCameraPath,
  CAMERA_REGIMES,
  createMutableCameraState,
  pathFrameForRegime
} from './camera-path.js';
import { FrameRecorder } from './frame-recorder.js';

/**
 * Views this harness can drive: the live view plus the viewer's three-snapshot
 * ceiling. Mirrors `MAX_SNAPSHOTS` in the viewer; raising it there without
 * raising it here understates the axis rather than breaking.
 */
export const MAX_BENCHMARK_VIEWS = 4;

/** The live view's exact identifier. */
export const LIVE_VIEW_ID = 'live';

const DEFAULT_WARMUP_FRAMES = 120;
const DEFAULT_MEASURE_FRAMES = 2400;
const DEFAULT_SETTLE_FRAMES = 12;

const REQUIRED_VIEWER_METHODS = Object.freeze([
  'getCameraState',
  'getCurrentLODLevel',
  'getSnapshotViews',
  'getViewLayout',
  'setAdaptiveLOD',
  'setCameraState',
  'setForceLOD',
  'setFrustumCulling',
  'setCamerasLocked'
]);

function requireViewer(viewer) {
  if (viewer === null || typeof viewer !== 'object') {
    throw new TypeError('Benchmark matrix runner requires one viewer.');
  }
  for (const methodName of REQUIRED_VIEWER_METHODS) {
    if (typeof viewer[methodName] !== 'function') {
      throw new TypeError(
        `Benchmark matrix runner requires viewer.${methodName}().`
      );
    }
  }
  return viewer;
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${label} must be an exact boolean.`);
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be one positive safe integer.`);
  }
  return value;
}

function requireElement(root, id, label) {
  const element = root.getElementById(id);
  if (element === null) {
    throw new Error(
      `Benchmark matrix runner requires the ${label} element #${id}.`
    );
  }
  return element;
}

/**
 * Expand the axes into the exact ordered list of configurations to run.
 *
 * Order is chosen so the expensive axis changes least often: view count is the
 * slowest to apply because it publishes and retires renderer resources.
 *
 * @param {Object} axes - Axis value lists.
 * @param {boolean[]} axes.lod - Adaptive-LOD states to sweep.
 * @param {boolean[]} axes.frustumCulling - Culling states to sweep.
 * @param {number[]} axes.viewCount - View counts to sweep, each 1..4.
 * @param {number[]} [axes.forceLodLevel] - Forced levels; -1 means automatic.
 * @param {string[]} [axes.regime] - Camera regimes; both by default.
 * @returns {Object[]} Frozen configuration records.
 */
export function expandMatrix(axes) {
  if (axes === null || typeof axes !== 'object' || Array.isArray(axes)) {
    throw new TypeError('Benchmark matrix axes must be one plain object.');
  }
  const lodValues = axes.lod ?? [false, true];
  const cullingValues = axes.frustumCulling ?? [false, true];
  const viewCounts = axes.viewCount ?? [1];
  const forceLodLevels = axes.forceLodLevel ?? [-1];
  const regimes = axes.regime ?? CAMERA_REGIMES;

  for (const [label, values] of [
    ['lod', lodValues],
    ['frustumCulling', cullingValues],
    ['viewCount', viewCounts],
    ['forceLodLevel', forceLodLevels],
    ['regime', regimes]
  ]) {
    if (!Array.isArray(values) || values.length === 0) {
      throw new TypeError(
        `Benchmark matrix axis "${label}" must be one non-empty array.`
      );
    }
  }
  for (const value of lodValues) requireBoolean(value, 'Matrix lod value');
  for (const value of cullingValues) {
    requireBoolean(value, 'Matrix frustumCulling value');
  }
  for (const value of viewCounts) {
    requirePositiveInteger(value, 'Matrix viewCount value');
    if (value > MAX_BENCHMARK_VIEWS) {
      throw new RangeError(
        `Matrix viewCount value ${value} exceeds the viewer ceiling of ` +
        `${MAX_BENCHMARK_VIEWS} views.`
      );
    }
  }
  for (const value of forceLodLevels) {
    if (!Number.isInteger(value) || value < -1) {
      throw new TypeError(
        'Matrix forceLodLevel value must be an integer of -1 or greater.'
      );
    }
  }
  for (const value of regimes) {
    if (!CAMERA_REGIMES.includes(value)) {
      throw new RangeError(
        `Matrix regime value must be one of ${CAMERA_REGIMES.join(', ')}.`
      );
    }
  }

  const configurations = [];
  for (const viewCount of viewCounts) {
    for (const lod of lodValues) {
      for (const frustumCulling of cullingValues) {
        for (const forceLodLevel of forceLodLevels) {
          if (forceLodLevel !== -1 && !lod) continue;
          for (const regime of regimes) {
            configurations.push(
              Object.freeze({
                viewCount,
                lod,
                frustumCulling,
                forceLodLevel,
                regime
              })
            );
          }
        }
      }
    }
  }
  return configurations;
}

/**
 * Build a runner bound to one live viewer and document.
 *
 * @param {Object} options - Exact runner dependencies.
 * @param {Object} options.viewer - The live viewer.
 * @param {Document} options.document - Document owning the view controls.
 * @param {Object} [options.uploadCounters] - Handle from `instrumentGlUploads`.
 * @param {(callback: FrameRequestCallback) => number} [options.requestFrame]
 * @param {(handle: number) => void} [options.cancelFrame]
 * @returns {Object} Runner with `runConfiguration()` and `runMatrix()`.
 */
export function createBenchmarkMatrixRunner(options = {}) {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options)
  ) {
    throw new TypeError('Benchmark matrix runner options must be an object.');
  }
  const viewer = requireViewer(options.viewer);
  const ownerDocument = options.document ?? globalThis.document ?? null;
  if (ownerDocument === null || typeof ownerDocument.getElementById !== 'function') {
    throw new TypeError('Benchmark matrix runner requires one document.');
  }
  const uploadCounters = options.uploadCounters ?? null;
  if (
    uploadCounters !== null &&
    (typeof uploadCounters !== 'object' ||
      typeof uploadCounters.closeFrame !== 'function' ||
      uploadCounters.frame === null ||
      typeof uploadCounters.frame !== 'object')
  ) {
    throw new TypeError(
      'Benchmark upload counters must be a handle from instrumentGlUploads().'
    );
  }
  const requestFrame =
    options.requestFrame ?? globalThis.requestAnimationFrame?.bind(globalThis);
  const cancelFrame =
    options.cancelFrame ?? globalThis.cancelAnimationFrame?.bind(globalThis);
  if (typeof requestFrame !== 'function' || typeof cancelFrame !== 'function') {
    throw new TypeError(
      'Benchmark matrix runner requires animation-frame scheduling.'
    );
  }

  // One camera state, reused for the life of the runner. The viewer's camera
  // contract validates it on every publication, which allocates inside the
  // viewer; that cost is identical in both regimes and therefore cancels in
  // the STATIC/ORBIT difference the matrix is built to report.
  const cameraState = createMutableCameraState();

  /**
   * Bring the published view count to exactly `target` using the application's
   * own controls, then assert the viewer agrees.
   *
   * @param {number} target - Desired view count, 1..MAX_BENCHMARK_VIEWS.
   * @returns {Promise<Object>} Achieved layout description.
   */
  async function ensureViewCount(target) {
    requirePositiveInteger(target, 'Benchmark view count');
    if (target > MAX_BENCHMARK_VIEWS) {
      throw new RangeError(
        `Benchmark view count ${target} exceeds the viewer ceiling of ` +
        `${MAX_BENCHMARK_VIEWS}.`
      );
    }
    const keepViewButton = requireElement(
      ownerDocument,
      'split-keep-view-btn',
      'keep-view'
    );
    const clearButton = requireElement(
      ownerDocument,
      'split-clear-btn',
      'clear-views'
    );
    const layoutSelect = requireElement(
      ownerDocument,
      'view-layout-mode',
      'layout-mode'
    );

    const desiredSnapshots = target - 1;
    if (viewer.getSnapshotViews().length > desiredSnapshots) {
      clearButton.click();
      await waitUntil(
        () => viewer.getSnapshotViews().length === 0,
        'every kept view to be retired'
      );
    }
    while (viewer.getSnapshotViews().length < desiredSnapshots) {
      if (keepViewButton.disabled) {
        throw new Error(
          'The keep-view control is disabled, so the view-count axis cannot ' +
          'be driven; publish a dataset first.'
        );
      }
      const before = viewer.getSnapshotViews().length;
      keepViewButton.click();
      await waitUntil(
        () => viewer.getSnapshotViews().length > before,
        `snapshot ${before + 1} to be published`
      );
    }

    const desiredMode = target > 1 ? 'grid' : 'single';
    if (layoutSelect.value !== desiredMode) {
      layoutSelect.value = desiredMode;
      layoutSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await waitUntil(
        () => viewer.getViewLayout().mode === desiredMode,
        `the viewer to adopt the "${desiredMode}" layout`
      );
    }
    await waitForFrames(DEFAULT_SETTLE_FRAMES);

    const achieved = viewer.getSnapshotViews().length + 1;
    if (achieved !== target) {
      throw new Error(
        `Benchmark requested ${target} views and the viewer published ` +
        `${achieved}.`
      );
    }
    const layout = viewer.getViewLayout();
    if (target > 1 && layout.mode !== 'grid') {
      throw new Error(
        `Benchmark requested a grid layout for ${target} views and the ` +
        `viewer reports "${layout.mode}"; the renderer would take its ` +
        'single-viewport path and the view-count axis would be a fiction.'
      );
    }
    return Object.freeze({ viewCount: achieved, layoutMode: layout.mode });
  }

  function waitForFrames(frames) {
    requirePositiveInteger(frames, 'Benchmark settle frames');
    return new Promise(resolve => {
      let remaining = frames;
      const step = () => {
        remaining--;
        if (remaining <= 0) {
          resolve();
          return;
        }
        requestFrame(step);
      };
      requestFrame(step);
    });
  }

  /**
   * Poll a predicate once per animation frame until it holds.
   *
   * Used only between windows, never inside one: a transition that silently
   * failed must surface as a stated error, not as a measured configuration
   * that is not the configuration the caller asked for.
   *
   * @param {() => boolean} predicate - Condition to reach.
   * @param {string} description - What is being waited for.
   * @param {number} [maxFrames] - Frame budget before failing.
   * @returns {Promise<void>} Resolves once the predicate holds.
   */
  function waitUntil(predicate, description, maxFrames = 240) {
    requirePositiveInteger(maxFrames, 'Benchmark wait budget');
    return new Promise((resolve, reject) => {
      let remaining = maxFrames;
      const step = () => {
        let satisfied;
        try {
          satisfied = predicate() === true;
        } catch (error) {
          reject(error);
          return;
        }
        if (satisfied) {
          resolve();
          return;
        }
        remaining--;
        if (remaining <= 0) {
          reject(
            new Error(
              `Benchmark waited ${maxFrames} frames for ${description} and ` +
              'the viewer never reported it.'
            )
          );
          return;
        }
        requestFrame(step);
      };
      requestFrame(step);
    });
  }

  /**
   * Build a camera path fitted to the viewer's current camera.
   *
   * @param {Object} [pathOptions] - Overrides for `BenchmarkCameraPath`.
   * @returns {BenchmarkCameraPath} Path anchored on the current camera.
   */
  function createPathFromCurrentCamera(pathOptions = {}) {
    const current = viewer.getCameraState();
    return new BenchmarkCameraPath({
      baseRadius: current.orbit.radius,
      center: [
        current.orbit.target[0],
        current.orbit.target[1],
        current.orbit.target[2]
      ],
      ...pathOptions
    });
  }

  /**
   * Run one measurement window.
   *
   * @param {Object} windowOptions - Window description.
   * @param {string} windowOptions.regime - `'static'` or `'orbit'`.
   * @param {BenchmarkCameraPath} windowOptions.path - Scripted path.
   * @param {number} [windowOptions.warmupFrames] - Discarded leading frames.
   * @param {number} [windowOptions.measureFrames] - Recorded frames.
   * @param {string} [windowOptions.viewId] - View to read LOD level from.
   * @returns {Promise<Object>} Window summary from `FrameRecorder`.
   */
  function runWindow(windowOptions) {
    const regime = windowOptions.regime;
    if (!CAMERA_REGIMES.includes(regime)) {
      throw new RangeError(
        `Benchmark camera regime must be one of ${CAMERA_REGIMES.join(', ')}.`
      );
    }
    const path = windowOptions.path;
    if (!(path instanceof BenchmarkCameraPath)) {
      throw new TypeError(
        'Benchmark window requires one BenchmarkCameraPath.'
      );
    }
    const warmupFrames = requirePositiveInteger(
      windowOptions.warmupFrames ?? DEFAULT_WARMUP_FRAMES,
      'Benchmark warmup frames'
    );
    const measureFrames = requirePositiveInteger(
      windowOptions.measureFrames ?? DEFAULT_MEASURE_FRAMES,
      'Benchmark measure frames'
    );
    const viewId = windowOptions.viewId ?? LIVE_VIEW_ID;

    const recorder = new FrameRecorder({ capacity: measureFrames });
    const counters = uploadCounters;
    let frameIndex = 0;
    let previousTimestamp = 0;
    let started = false;

    return new Promise((resolve, reject) => {
      const step = () => {
        // Re-arm before doing any work so this callback keeps a stable
        // position behind the viewer's own render callback every frame.
        const handle = requestFrame(step);
        try {
          const now = performance.now();
          if (!started) {
            started = true;
            previousTimestamp = now;
            if (counters !== null) counters.closeFrame();
            publishCamera(frameIndex);
            frameIndex++;
            return;
          }
          const frameTime = now - previousTimestamp;
          previousTimestamp = now;

          if (frameIndex > warmupFrames) {
            const frameCounters = counters === null ? null : counters.frame;
            recorder.record(
              frameTime,
              frameCounters === null
                ? 0
                : frameCounters.bufferStoreAllocations +
                  frameCounters.bufferSubUpdates +
                  frameCounters.textureUploads,
              frameCounters === null
                ? 0
                : frameCounters.bufferStoreAllocationBytes +
                  frameCounters.bufferSubUpdateBytes +
                  frameCounters.textureUploadBytes,
              frameCounters === null
                ? 0
                : frameCounters.elementBufferStoreAllocations +
                  frameCounters.elementBufferSubUpdates,
              frameCounters === null ? 0 : frameCounters.syncStalls,
              viewer.getCurrentLODLevel(viewId)
            );
          }
          if (counters !== null) counters.closeFrame();

          if (recorder.isFull()) {
            cancelFrame(handle);
            resolve(recorder.summarize());
            return;
          }
          publishCamera(frameIndex);
          frameIndex++;
        } catch (error) {
          cancelFrame(handle);
          reject(error);
        }
      };

      const publishCamera = index => {
        path.sampleInto(cameraState, pathFrameForRegime(regime, index));
        viewer.setCameraState(cameraState);
      };

      requestFrame(step);
    });
  }

  /**
   * Apply one configuration's renderer axes.
   *
   * @param {Object} configuration - Record from `expandMatrix()`.
   * @returns {Promise<Object>} Achieved layout description.
   */
  async function applyConfiguration(configuration) {
    const layout = await ensureViewCount(configuration.viewCount);
    viewer.setAdaptiveLOD(configuration.lod);
    viewer.setFrustumCulling(configuration.frustumCulling);
    viewer.setForceLOD(configuration.forceLodLevel);
    await waitForFrames(DEFAULT_SETTLE_FRAMES);
    return layout;
  }

  /**
   * Run one configuration end to end.
   *
   * @param {Object} configuration - Record from `expandMatrix()`.
   * @param {Object} [runOptions] - Window overrides.
   * @returns {Promise<Object>} Frozen result cell.
   */
  async function runConfiguration(configuration, runOptions = {}) {
    const layout = await applyConfiguration(configuration);
    const path =
      runOptions.path ?? createPathFromCurrentCamera(runOptions.pathOptions);
    const summary = await runWindow({
      regime: configuration.regime,
      path,
      warmupFrames: runOptions.warmupFrames,
      measureFrames: runOptions.measureFrames,
      viewId: runOptions.viewId
    });
    return Object.freeze({
      configuration,
      layout,
      cameraPath: Object.freeze({
        seed: path.seed,
        periodFrames: path.periodFrames,
        baseRadius: path.baseRadius,
        distanceBounds: Object.freeze(path.getDistanceBounds())
      }),
      summary
    });
  }

  /**
   * Run every configuration the axes expand to.
   *
   * @param {Object} matrixOptions - Axes plus window overrides.
   * @returns {Promise<Object[]>} One frozen cell per configuration.
   */
  async function runMatrix(matrixOptions = {}) {
    const configurations = expandMatrix(matrixOptions.axes ?? {});
    const results = [];
    for (const configuration of configurations) {
      if (typeof matrixOptions.onProgress === 'function') {
        matrixOptions.onProgress({
          completed: results.length,
          total: configurations.length,
          configuration
        });
      }
      results.push(await runConfiguration(configuration, matrixOptions));
    }
    return results;
  }

  return Object.freeze({
    applyConfiguration,
    createPathFromCurrentCamera,
    ensureViewCount,
    runConfiguration,
    runMatrix,
    runWindow,
    waitForFrames
  });
}
