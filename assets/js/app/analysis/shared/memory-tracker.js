/**
 * Memory Tracker (debug-only)
 *
 * Provides cheap, structured memory snapshots around expensive operations.
 * Intended to help diagnose regressions without adding production overhead.
 *
 * @module shared/memory-tracker
 */

import { debug, isDebugMode } from './debug-utils.js';
import { getHeapMemoryUsage, measureUserAgentSpecificMemory } from './memory-utils.js';

/**
 * @typedef {Object} MemorySnapshot
 * @property {import('./memory-utils.js').HeapMemoryUsage|null} heap
 * @property {import('./memory-utils.js').UserAgentMemoryUsage|null} userAgent
 * @property {number|null} timestamp
 */

function formatMB(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}MB` : 'N/A';
}

function formatDelta(before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after)) return 'N/A';
  const delta = after - before;
  const sign = delta >= 0 ? '+' : '';
  return `${sign}${delta.toFixed(1)}MB`;
}

/**
 * Start a debug-only memory tracking scope.
 *
 * @param {string} category - Debug category
 * @param {string} label - Scope label
 * @param {Object} [options]
 * @param {boolean} [options.includeUserAgent=false] - Also sample `measureUserAgentSpecificMemory()` (async; Chromium-only)
 * @returns {{ end: (extra?: any) => void, snapshot: () => MemorySnapshot }}
 */
export function startMemoryTracking(category, label, options = {}) {
  const { includeUserAgent = false } = options;
  const enabled = isDebugMode();

  /** @type {MemorySnapshot} */
  const start = {
    heap: enabled ? getHeapMemoryUsage() : null,
    userAgent: null,
    timestamp: enabled && typeof performance !== 'undefined' && performance.now ? performance.now() : null
  };

  if (enabled && includeUserAgent) {
    void measureUserAgentSpecificMemory().then((ua) => {
      start.userAgent = ua;
    });
  }

  const snapshot = () => ({ ...start });

  const end = (extra) => {
    if (!enabled) return;

    const endHeap = getHeapMemoryUsage();
    const endTime = typeof performance !== 'undefined' && performance.now ? performance.now() : null;

    const heapDelta = (start.heap?.usedMB != null && endHeap.usedMB != null)
      ? formatDelta(start.heap.usedMB, endHeap.usedMB)
      : 'N/A';

    const base = {
      heapStart: formatMB(start.heap?.usedMB),
      heapEnd: formatMB(endHeap.usedMB),
      heapDelta,
      heapPercentEnd: endHeap.percentUsed != null ? `${endHeap.percentUsed.toFixed(1)}%` : 'N/A',
      elapsedMs: (start.timestamp != null && endTime != null) ? Math.round(endTime - start.timestamp) : null
    };

    // UA memory is async; sample once more if requested and available.
    if (!includeUserAgent) {
      debug(category, `Memory scope: ${label}`, { ...base, ...extra });
      return;
    }

    void measureUserAgentSpecificMemory().then((uaEnd) => {
      const uaStartMB = start.userAgent?.megabytes;
      const uaEndMB = uaEnd?.megabytes;
      debug(category, `Memory scope: ${label}`, {
        ...base,
        uaStart: formatMB(uaStartMB),
        uaEnd: formatMB(uaEndMB),
        uaDelta: formatDelta(uaStartMB, uaEndMB),
        uaError: uaEnd?.error || start.userAgent?.error || null,
        ...extra
      });
    });
  };

  return { end, snapshot };
}

export default {
  startMemoryTracking
};

