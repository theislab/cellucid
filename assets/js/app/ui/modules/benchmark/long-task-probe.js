/**
 * @fileoverview Main-thread blocking: tasks of 50 ms or more.
 *
 * Chromium reports them through `PerformanceObserver` entries of type
 * `longtask`. Firefox and WebKit do not, so there the probe runs a 10 ms
 * interval timer and records every gap that exceeds the threshold plus one
 * period. The drift estimate is coarser (it cannot see a task shorter than the
 * threshold, nor split two back-to-back tasks), and the record says which
 * source produced it so the two are never compared as equals.
 *
 * @module app/ui/modules/benchmark/long-task-probe
 */

/** The Long Tasks API definition of a long task. */
export const LONG_TASK_THRESHOLD_MS = 50;

/** Interval of the drift timer used where `longtask` entries do not exist. */
export const DRIFT_PERIOD_MS = 10;

function supportsLongTaskEntries(scope) {
  const Observer = scope.PerformanceObserver;
  return (
    typeof Observer === 'function' &&
    Array.isArray(Observer.supportedEntryTypes) &&
    Observer.supportedEntryTypes.includes('longtask')
  );
}

function createWindowRecord(startedAt) {
  return { startedAt, count: 0, totalMs: 0, maxMs: 0, durations: [] };
}

/**
 * Create a long-task probe.
 *
 * @param {Object} [options]
 * @param {Object} [options.scope] - Global scope (window).
 * @param {'auto'|'longtask'|'drift'} [options.source='auto']
 * @param {() => number} [options.now]
 * @returns {Object} Probe handle.
 */
export function createLongTaskProbe(options = {}) {
  const scope = options.scope ?? globalThis;
  const now = options.now ?? (() => performance.now());
  const requested = options.source ?? 'auto';
  if (!['auto', 'longtask', 'drift'].includes(requested)) {
    throw new RangeError('Long-task probe source must be auto, longtask or drift.');
  }
  const source =
    requested === 'auto'
      ? (supportsLongTaskEntries(scope) ? 'longtask' : 'drift')
      : requested;
  if (source === 'longtask' && !supportsLongTaskEntries(scope)) {
    throw new Error('This engine does not report longtask entries.');
  }

  const windows = new Set();
  let observer = null;
  let intervalHandle = null;
  let lastTick = 0;

  function record(durationMs, endedAt) {
    for (const windowRecord of windows) {
      if (endedAt < windowRecord.startedAt) continue;
      windowRecord.count++;
      windowRecord.totalMs += durationMs;
      if (durationMs > windowRecord.maxMs) windowRecord.maxMs = durationMs;
      if (windowRecord.durations.length < 1000) windowRecord.durations.push(durationMs);
    }
  }

  function driftTick() {
    const at = now();
    const gap = at - lastTick;
    lastTick = at;
    if (gap >= LONG_TASK_THRESHOLD_MS + DRIFT_PERIOD_MS) {
      record(gap - DRIFT_PERIOD_MS, at);
    }
  }

  return Object.freeze({
    /** `'longtask'` or `'drift'`. */
    source,

    /** Start observing. Idempotent. */
    start() {
      if (observer !== null || intervalHandle !== null) return;
      if (source === 'longtask') {
        observer = new scope.PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            record(entry.duration, entry.startTime + entry.duration);
          }
        });
        observer.observe({ type: 'longtask', buffered: false });
      } else {
        lastTick = now();
        intervalHandle = scope.setInterval(driftTick, DRIFT_PERIOD_MS);
      }
    },

    /** Stop observing. Idempotent. */
    stop() {
      if (observer !== null) {
        observer.disconnect();
        observer = null;
      }
      if (intervalHandle !== null) {
        scope.clearInterval(intervalHandle);
        intervalHandle = null;
      }
      windows.clear();
    },

    /** Open a window. */
    openWindow() {
      const windowRecord = createWindowRecord(now());
      windows.add(windowRecord);
      return windowRecord;
    },

    /**
     * Close a window. Long-task entries are delivered asynchronously, so a
     * caller that needs the last task wait one macrotask first (the render
     * probes do).
     *
     * @param {Object} windowRecord
     * @returns {Object} Plain summary.
     */
    closeWindow(windowRecord) {
      if (!windows.delete(windowRecord)) {
        throw new Error('The long-task window is not open.');
      }
      return {
        source,
        count: windowRecord.count,
        totalMs: windowRecord.totalMs,
        maxMs: windowRecord.maxMs,
        durationsMs: windowRecord.durations.slice()
      };
    }
  });
}
