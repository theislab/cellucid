/**
 * Memory Tracker (debug-only)
 *
 * Structured memory notes around expensive operations, from the memory
 * model's own count (`data/memory-budget.js` `memoryReport`): what every
 * cache keeps, in every thread, and the working set, at the start and at
 * the end of a scope. The JavaScript heap is not read: it counts no
 * `ArrayBuffer`, where every per-cell array lives.
 *
 * @module shared/memory-tracker
 */

import { debug, isDebugMode } from './debug-utils.js';
import { memoryReport } from '../../../data/memory-budget.js';

const MiB = 1024 * 1024;

function formatMB(bytes) {
  return `${(bytes / MiB).toFixed(1)}MB`;
}

function formatDelta(before, after) {
  const delta = (after - before) / MiB;
  return `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}MB`;
}

/**
 * Start a debug-only memory tracking scope.
 *
 * @param {string} category - Debug category
 * @param {string} label - Scope label
 * @returns {{ end: (extra?: any) => void }}
 */
export function startMemoryTracking(category, label) {
  if (!isDebugMode()) return { end: () => {} };
  const start = memoryReport();
  const startedAt = performance.now();
  return {
    end(extra) {
      const now = memoryReport();
      debug(category, `Memory scope: ${label}`, {
        heldStart: formatMB(start.heldBytes),
        heldEnd: formatMB(now.heldBytes),
        heldDelta: formatDelta(start.heldBytes, now.heldBytes),
        workingSet: formatMB(now.workingSetBytes),
        allowance: formatMB(now.allowanceBytes),
        elapsedMs: Math.round(performance.now() - startedAt),
        ...extra,
      });
    },
  };
}
