/**
 * @fileoverview Frames drawn per cause, sampled from the viewer's own schedule.
 *
 * `viewer.getFrameScheduleState()` says why the loop would draw: the last
 * cause, how long ago it started (`msSinceCause`) and how many frames have
 * been drawn since (`framesDrawnSinceCause`). The viewer resets that count to
 * one on every frame a cause starts, and increments it on every frame drawn in
 * the settle window after it. Sampled once per animation frame, after the
 * viewer's callback, that is enough to tell for every tick whether a frame was
 * drawn and why:
 *
 * - the cause's start time moved: a frame was drawn for `lastCause`;
 * - otherwise the count grew: a settle frame was drawn (`'settle'`);
 * - otherwise nothing was drawn.
 *
 * The sampler's callback keeps a stable position behind the viewer's: both
 * re-arm at the top of their callbacks, and the viewer's loop was armed first.
 *
 * It also counts `requestAnimationFrame` requests made by anything other than
 * itself, which is how an idle loop that keeps waking the main thread shows
 * up even when it draws nothing.
 *
 * Reading the schedule allocates one small frozen record per tick. That is
 * diagnostics-only cost, outside every product path.
 *
 * @module app/ui/modules/benchmark/frame-cause-sampler
 */

/** Label of a frame drawn inside the settle window of an earlier cause. */
export const SETTLE_CAUSE = 'settle';

/** Two derived cause times closer than this are the same cause start. */
const CAUSE_TIME_TOLERANCE_MS = 0.5;

function requireViewer(viewer) {
  if (
    viewer === null ||
    typeof viewer !== 'object' ||
    typeof viewer.getFrameScheduleState !== 'function'
  ) {
    throw new TypeError(
      'The frame-cause sampler requires a viewer with getFrameScheduleState().'
    );
  }
  return viewer;
}

/**
 * Classify one sample against the previous one.
 *
 * @param {Object|null} previous - `{causeTime, framesDrawnSinceCause}` or null.
 * @param {Object} schedule - The viewer's schedule state.
 * @param {number} sampledAt - `performance.now()` at the read.
 * @returns {{drawn: boolean, cause: string|null, causeTime: number}}
 */
export function classifyScheduleSample(previous, schedule, sampledAt) {
  const causeTime = sampledAt - schedule.msSinceCause;
  if (previous === null) {
    return { drawn: false, cause: null, causeTime };
  }
  const newCause =
    Number.isFinite(causeTime) &&
    Math.abs(causeTime - previous.causeTime) > CAUSE_TIME_TOLERANCE_MS &&
    schedule.lastCause !== null;
  if (newCause) {
    return { drawn: true, cause: schedule.lastCause, causeTime };
  }
  if (schedule.framesDrawnSinceCause > previous.framesDrawnSinceCause) {
    return { drawn: true, cause: SETTLE_CAUSE, causeTime };
  }
  return { drawn: false, cause: null, causeTime };
}

function createWindowRecord(startedAt) {
  return {
    startedAt,
    ticks: 0,
    drawnFrames: 0,
    causes: new Map(),
    otherFrameRequests: 0,
    lastDrawnAt: null,
    firstDrawnAt: null
  };
}

/**
 * Create a sampler bound to one viewer.
 *
 * @param {Object} options
 * @param {Object} options.viewer - The live viewer.
 * @param {Object} [options.passProfiler] - Closed once per tick when given.
 * @param {Window} [options.window] - Owner of `requestAnimationFrame`.
 * @param {() => number} [options.now] - Clock (`performance.now`).
 * @returns {Object} Sampler handle.
 */
export function createFrameCauseSampler(options = {}) {
  const viewer = requireViewer(options.viewer);
  const passProfiler = options.passProfiler ?? null;
  const owner = options.window ?? globalThis;
  const now = options.now ?? (() => performance.now());
  const originalRequestFrame = owner.requestAnimationFrame;
  const originalCancelFrame = owner.cancelAnimationFrame;
  if (typeof originalRequestFrame !== 'function' || typeof originalCancelFrame !== 'function') {
    throw new TypeError('The frame-cause sampler requires animation-frame scheduling.');
  }

  const windows = new Set();
  const listeners = new Set();
  let previous = null;
  let handle = null;
  let running = false;
  let requestWrapperInstalled = false;
  let previousRequestDescriptor = null;
  let otherRequestsSinceTick = 0;
  let drawnFrameCount = 0;
  let tickCount = 0;
  let lastDrawnAt = null;

  function requestFrame(callback) {
    return originalRequestFrame.call(owner, callback);
  }

  function installRequestCounter() {
    previousRequestDescriptor =
      Object.getOwnPropertyDescriptor(owner, 'requestAnimationFrame') ?? null;
    const counted = function requestAnimationFrame(callback) {
      otherRequestsSinceTick++;
      return originalRequestFrame.call(owner, callback);
    };
    Object.defineProperty(owner, 'requestAnimationFrame', {
      value: counted,
      writable: true,
      configurable: true,
      enumerable: true
    });
    requestWrapperInstalled = true;
  }

  function removeRequestCounter() {
    if (!requestWrapperInstalled) return;
    if (previousRequestDescriptor === null) {
      delete owner.requestAnimationFrame;
    } else {
      Object.defineProperty(owner, 'requestAnimationFrame', previousRequestDescriptor);
    }
    requestWrapperInstalled = false;
  }

  function tick() {
    handle = requestFrame(tick);
    const before = now();
    const schedule = viewer.getFrameScheduleState();
    const after = now();
    const sampledAt = (before + after) / 2;
    const sample = classifyScheduleSample(previous, schedule, sampledAt);
    previous = {
      causeTime: sample.causeTime,
      framesDrawnSinceCause: schedule.framesDrawnSinceCause
    };
    if (passProfiler !== null) passProfiler.endFrame();
    tickCount++;
    if (sample.drawn) {
      drawnFrameCount++;
      lastDrawnAt = after;
    }
    const otherRequests = otherRequestsSinceTick;
    otherRequestsSinceTick = 0;
    for (const record of windows) {
      record.ticks++;
      record.otherFrameRequests += otherRequests;
      if (sample.drawn) {
        record.drawnFrames++;
        record.causes.set(sample.cause, (record.causes.get(sample.cause) ?? 0) + 1);
        record.lastDrawnAt = after;
        if (record.firstDrawnAt === null) record.firstDrawnAt = after;
      }
    }
    if (listeners.size > 0) {
      const event = Object.freeze({
        drawn: sample.drawn,
        cause: sample.cause,
        at: after,
        settled: schedule.settled === true,
        schedule
      });
      for (const listener of [...listeners]) listener(event);
    }
  }

  return Object.freeze({
    /** Start sampling. Idempotent. */
    start({ countFrameRequests = true } = {}) {
      if (running) return;
      running = true;
      previous = null;
      if (countFrameRequests) installRequestCounter();
      handle = requestFrame(tick);
    },

    /** Stop sampling and give `requestAnimationFrame` back. Idempotent. */
    stop() {
      if (!running) return;
      running = false;
      if (handle !== null) originalCancelFrame.call(owner, handle);
      handle = null;
      removeRequestCounter();
      windows.clear();
      listeners.clear();
    },

    /** @returns {boolean} */
    get running() {
      return running;
    },

    /** Frames drawn since `start()`. */
    get drawnFrameCount() {
      return drawnFrameCount;
    },

    /** Animation frames sampled since `start()`. */
    get tickCount() {
      return tickCount;
    },

    /** `now()` of the last drawn frame, or null. */
    get lastDrawnAt() {
      return lastDrawnAt;
    },

    /**
     * Call `listener(event)` once per sampled tick until it returns.
     *
     * @param {(event: Object) => void} listener
     * @returns {() => void} Unsubscribe.
     */
    subscribe(listener) {
      if (typeof listener !== 'function') {
        throw new TypeError('A frame-cause listener must be a function.');
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Open a window that counts ticks, drawn frames and causes. */
    openWindow() {
      if (!running) throw new Error('Start the frame-cause sampler first.');
      const record = createWindowRecord(now());
      windows.add(record);
      return record;
    },

    /**
     * Close a window.
     *
     * @param {Object} record - Token from `openWindow`.
     * @returns {Object} Plain summary.
     */
    closeWindow(record) {
      if (!windows.delete(record)) {
        throw new Error('The frame-cause window is not open.');
      }
      const durationMs = now() - record.startedAt;
      const seconds = durationMs / 1000;
      const causes = {};
      for (const [cause, count] of record.causes) causes[cause] = count;
      return {
        durationMs,
        ticks: record.ticks,
        drawnFrames: record.drawnFrames,
        drawnPerSecond: seconds > 0 ? record.drawnFrames / seconds : 0,
        otherFrameRequests: record.otherFrameRequests,
        otherFrameRequestsPerSecond:
          seconds > 0 ? record.otherFrameRequests / seconds : 0,
        causes,
        firstDrawnAtMs:
          record.firstDrawnAt === null ? null : record.firstDrawnAt - record.startedAt,
        lastDrawnAtMs:
          record.lastDrawnAt === null ? null : record.lastDrawnAt - record.startedAt
      };
    }
  });
}
