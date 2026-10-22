/**
 * @fileoverview One handle over every render probe, for scenario drivers.
 *
 * Installs, on the live viewer and its context:
 *
 * - the upload counter (draws, multi-draw ranges, vertices, instances,
 *   uploads, synchronous stalls), unless the caller hands one in;
 * - the pass profiler (per-pass draws, and GPU time when `timing` is on);
 * - the frame-cause sampler (frames drawn per cause, idle wake-ups);
 * - the long-task probe;
 * - the input-latency tracker.
 *
 * A *window* is the unit of measurement: everything opened together and
 * closed together, returned as one plain record. `measureInteraction` wraps a
 * window around one action and reports the time to the first frame that shows
 * it and to the scene going quiet again.
 *
 * Nothing here runs unless a driver installs it, and `dispose()` hands every
 * shadowed method back. It is test and benchmark tooling only.
 *
 * @module app/ui/modules/benchmark/render-probes
 */

import {
  BenchmarkCameraPath,
  createMutableCameraState,
  pathFrameForRegime
} from './camera-path.js';
import { createFrameCauseSampler } from './frame-cause-sampler.js';
import { instrumentGlUploads, uploadCounterFields } from './gl-upload-counter.js';
import { createInputLatencyTracker } from './input-latency.js';
import { createLongTaskProbe } from './long-task-probe.js';
import { createPassProfiler } from './pass-profiler.js';

const DEFAULT_TIMEOUT_MS = 60_000;

function cumulativeUploads(uploads) {
  const values = {};
  for (const field of uploadCounterFields()) {
    values[field] = uploads.total[field] + uploads.frame[field];
  }
  return values;
}

function subtractUploads(after, before) {
  const delta = {};
  for (const field of Object.keys(after)) delta[field] = after[field] - before[field];
  return delta;
}

function readMemory(viewer) {
  const memory = globalThis.performance?.memory;
  let gpuMemoryMB = null;
  try {
    const stats = typeof viewer.getRendererStats === 'function'
      ? viewer.getRendererStats('live')
      : null;
    if (stats && Number.isFinite(stats.gpuMemoryMB)) gpuMemoryMB = stats.gpuMemoryMB;
  } catch {
    gpuMemoryMB = null;
  }
  return {
    jsHeapUsedMB:
      memory && Number.isFinite(memory.usedJSHeapSize)
        ? memory.usedJSHeapSize / (1024 * 1024)
        : null,
    gpuMemoryMB
  };
}

function nextMacrotask() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Install every render probe.
 *
 * @param {Object} options
 * @param {Object} options.viewer - The live viewer.
 * @param {HTMLCanvasElement} options.canvas - The viewer's canvas.
 * @param {boolean} [options.timing=false] - Per-pass GPU timer queries.
 * @param {Object} [options.uploadCounters] - An installed upload counter to
 *   share (a benchmark harness's); otherwise one is installed and owned here.
 * @param {'auto'|'longtask'|'drift'} [options.longTaskSource='auto']
 * @returns {Object} Probe handle.
 */
export function installRenderProbes(options = {}) {
  const viewer = options.viewer;
  if (viewer === null || typeof viewer !== 'object') {
    throw new TypeError('Render probes require the live viewer.');
  }
  const canvas = options.canvas;
  const gl = canvas?.getContext?.('webgl2') ?? null;
  if (gl === null) {
    throw new Error('Render probes require the viewer canvas WebGL2 context.');
  }

  const ownsUploads = !options.uploadCounters;
  const uploads = options.uploadCounters ?? instrumentGlUploads(gl);
  const passes = createPassProfiler(gl, {
    uploadCounters: uploads,
    timing: options.timing === true
  });
  const sampler = createFrameCauseSampler({ viewer, passProfiler: passes });
  const longTasks = createLongTaskProbe({ source: options.longTaskSource ?? 'auto' });
  const inputs = createInputLatencyTracker({ sampler });

  sampler.start();
  longTasks.start();
  inputs.start();

  let disposed = false;

  function openWindow(label = 'window') {
    if (disposed) throw new Error('Render probes are disposed.');
    return {
      label,
      startedAt: performance.now(),
      uploadsBefore: cumulativeUploads(uploads),
      memoryBefore: readMemory(viewer),
      frames: sampler.openWindow(),
      passes: passes.openWindow(),
      longTasks: longTasks.openWindow(),
      inputs: inputs.openWindow()
    };
  }

  async function closeWindow(token) {
    const frames = sampler.closeWindow(token.frames);
    const uploadsDelta = subtractUploads(cumulativeUploads(uploads), token.uploadsBefore);
    await nextMacrotask();
    const longTaskSummary = longTasks.closeWindow(token.longTasks);
    const inputSummary = inputs.closeWindow(token.inputs);
    const passSummary = await passes.closeWindow(token.passes);
    const ticks = Math.max(1, frames.ticks);
    return {
      label: token.label,
      durationMs: frames.durationMs,
      frames,
      uploads: {
        ...uploadsDelta,
        uploadBytes:
          uploadsDelta.bufferStoreAllocationBytes +
          uploadsDelta.bufferSubUpdateBytes +
          uploadsDelta.textureUploadBytes,
        uploadBytesPerTick:
          (uploadsDelta.bufferStoreAllocationBytes +
            uploadsDelta.bufferSubUpdateBytes +
            uploadsDelta.textureUploadBytes) / ticks,
        drawCallsPerDrawnFrame:
          frames.drawnFrames > 0 ? uploadsDelta.drawCalls / frames.drawnFrames : 0
      },
      passes: passSummary,
      longTasks: longTaskSummary,
      inputs: inputSummary,
      memory: { before: token.memoryBefore, after: readMemory(viewer) }
    };
  }

  /**
   * Resolve once the viewer reports a settled schedule on `quietTicks`
   * consecutive ticks, or reject after `timeoutMs`.
   */
  function waitForSettled({ timeoutMs = DEFAULT_TIMEOUT_MS, quietTicks = 2 } = {}) {
    return new Promise((resolve, reject) => {
      let quiet = 0;
      const started = performance.now();
      const unsubscribe = sampler.subscribe(event => {
        quiet = event.settled && !event.drawn ? quiet + 1 : 0;
        if (quiet >= quietTicks) {
          unsubscribe();
          resolve(performance.now() - started);
        } else if (performance.now() - started > timeoutMs) {
          unsubscribe();
          reject(new Error(`The scene did not settle within ${timeoutMs} ms.`));
        }
      });
    });
  }

  /**
   * Time one action from its start to the first frame that shows it and to
   * the scene settling.
   *
   * @param {string} label
   * @param {() => (void|Promise<void>)} action
   * @param {Object} [measureOptions]
   * @param {() => boolean} [measureOptions.until] - The frame counts only once
   *   this holds (an asynchronous load has published).
   * @param {boolean} [measureOptions.settle=true] - Also wait for quiet.
   * @param {number} [measureOptions.frameTimeoutMs] - Give up on a frame
   *   after this long (an action that should draw nothing).
   * @param {number} [measureOptions.timeoutMs]
   * @returns {Promise<Object>} Latency record with the window inside.
   */
  async function measureInteraction(label, action, measureOptions = {}) {
    if (typeof action !== 'function') {
      throw new TypeError('measureInteraction requires an action function.');
    }
    const until = measureOptions.until ?? null;
    const settle = measureOptions.settle !== false;
    const timeoutMs = measureOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const frameTimeoutMs = measureOptions.frameTimeoutMs ?? timeoutMs;

    const token = openWindow(label);
    let firstFrameAt = null;
    let conditionMetAt = until === null ? -Infinity : null;
    let resolveFrame;
    const framePromise = new Promise(resolve => {
      resolveFrame = resolve;
    });
    const startedAt = performance.now();
    const unsubscribe = sampler.subscribe(event => {
      if (conditionMetAt === null) {
        let met = false;
        try {
          met = until() === true;
        } catch {
          met = false;
        }
        if (met) conditionMetAt = event.at;
      }
      if (firstFrameAt === null && event.drawn && conditionMetAt !== null) {
        firstFrameAt = event.at;
        resolveFrame(true);
      } else if (firstFrameAt === null && event.at - startedAt > frameTimeoutMs) {
        resolveFrame(false);
      }
    });

    let syncEnd;
    let actionEnd;
    let actionError = null;
    try {
      const result = action();
      syncEnd = performance.now();
      await result;
      actionEnd = performance.now();
    } catch (error) {
      actionError = error;
      syncEnd ??= performance.now();
      actionEnd = performance.now();
    }

    const framed = actionError === null ? await framePromise : false;
    unsubscribe();
    let settleMs = null;
    let settleTimedOut = false;
    if (settle && actionError === null) {
      try {
        await waitForSettled({ timeoutMs });
        settleMs = performance.now() - startedAt;
      } catch {
        settleTimedOut = true;
      }
    }
    const windowRecord = await closeWindow(token);
    if (actionError !== null) throw actionError;
    return {
      label,
      syncMs: syncEnd - startedAt,
      actionMs: actionEnd - startedAt,
      firstFrameMs: framed ? firstFrameAt - startedAt : null,
      conditionMetMs:
        conditionMetAt === null || conditionMetAt === -Infinity
          ? null
          : conditionMetAt - startedAt,
      settleMs,
      settleTimedOut,
      window: windowRecord
    };
  }

  /**
   * Count calls to named methods of `target` (state or viewer methods a
   * scenario wants to see repeated or not). Own properties shadow the
   * originals; `restore()` hands them back.
   */
  function countCalls(target, names) {
    const counts = {};
    const previous = new Map();
    for (const name of names) {
      const original = target?.[name];
      if (typeof original !== 'function') continue;
      counts[name] = 0;
      previous.set(name, Object.getOwnPropertyDescriptor(target, name) ?? null);
      Object.defineProperty(target, name, {
        value: function countedCall(...args) {
          counts[name]++;
          return original.apply(this, args);
        },
        writable: true,
        configurable: true,
        enumerable: false
      });
    }
    return {
      counts,
      restore() {
        for (const [name, descriptor] of previous) {
          if (descriptor === null) delete target[name];
          else Object.defineProperty(target, name, descriptor);
        }
        previous.clear();
      }
    };
  }

  /**
   * Drive the camera along the benchmark's scripted orbit for `frames`
   * animation frames, the path fitted to the current camera.
   *
   * @param {number} frames
   * @param {Object} [pathOptions] - Overrides for `BenchmarkCameraPath`.
   * @returns {Promise<void>}
   */
  async function orbit(frames, pathOptions = {}) {
    if (!Number.isSafeInteger(frames) || frames < 1) {
      throw new TypeError('orbit() needs a positive whole number of frames.');
    }
    const current = viewer.getCameraState();
    const path = new BenchmarkCameraPath({
      baseRadius: current.orbit.radius,
      center: [current.orbit.target[0], current.orbit.target[1], current.orbit.target[2]],
      ...pathOptions
    });
    const cameraState = createMutableCameraState();
    for (let index = 0; index < frames; index++) {
      path.sampleInto(cameraState, pathFrameForRegime('orbit', index));
      viewer.setCameraState(cameraState);
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
  }

  /**
   * Count canvas contexts created while installed, by type (`webgl2`, `2d`,
   * …), on both `HTMLCanvasElement` and `OffscreenCanvas`. A context the page
   * already holds is returned again by `getContext` and counted too, so read
   * the counts around the action under test only.
   */
  function countContextRequests() {
    const counts = {};
    const restores = [];
    for (const Canvas of [globalThis.HTMLCanvasElement, globalThis.OffscreenCanvas]) {
      const prototype = Canvas?.prototype;
      if (!prototype || typeof prototype.getContext !== 'function') continue;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'getContext');
      const original = prototype.getContext;
      Object.defineProperty(prototype, 'getContext', {
        ...descriptor,
        value: function countedGetContext(type, ...rest) {
          counts[type] = (counts[type] ?? 0) + 1;
          return original.call(this, type, ...rest);
        }
      });
      restores.push(() => Object.defineProperty(prototype, 'getContext', descriptor));
    }
    return {
      counts,
      restore() {
        while (restores.length > 0) restores.pop()();
      }
    };
  }

  return Object.freeze({
    uploads,
    passes,
    sampler,
    longTasks,
    inputs,
    openWindow,
    closeWindow,
    waitForSettled,
    measureInteraction,
    countCalls,
    countContextRequests,
    orbit,
    memory: () => readMemory(viewer),
    /** Remove every probe. Idempotent. */
    dispose() {
      if (disposed) return;
      disposed = true;
      inputs.stop();
      longTasks.stop();
      sampler.stop();
      passes.restore();
      if (ownsUploads) uploads.restore();
    }
  });
}
