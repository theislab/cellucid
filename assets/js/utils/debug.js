/**
 * @fileoverview Shared debug utilities with minimal production overhead.
 *
 * This module is intentionally dependency-free and safe to import from any
 * browser-side layer (data, rendering, app). When debug is disabled, most
 * methods become no-ops to avoid console overhead in production.
 *
 * Enable in the browser console:
 *   localStorage.setItem('CELLUCID_DEBUG', 'true'); location.reload();
 *
 * @module utils/debug
 */

function getDebugEnabled() {
  if (typeof window === 'undefined') return false;
  if (window.CELLUCID_DEBUG) return true;
  try {
    return localStorage.getItem('CELLUCID_DEBUG') === 'true';
  } catch {
    return false;
  }
}

const DEBUG = getDebugEnabled();

/**
 * Debug logging utilities. When debug is disabled, most methods are no-ops.
 */
export const debug = {
  log: DEBUG ? console.log.bind(console, '[Cellucid]') : () => {},
  warn: DEBUG ? console.warn.bind(console, '[Cellucid]') : () => {},
  error: console.error.bind(console, '[Cellucid]'),

  time: DEBUG ? console.time.bind(console) : () => {},
  timeEnd: DEBUG ? console.timeEnd.bind(console) : () => {},

  group: DEBUG ? console.group.bind(console) : () => {},
  groupEnd: DEBUG ? console.groupEnd.bind(console) : () => {},

  get isEnabled() { return DEBUG; }
};

/**
 * Performance timing helper.
 * @param {string} label
 * @returns {Function} Call to end timing and log the result
 */
export function startTiming(label) {
  if (!DEBUG) return () => {};
  const start = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  return () => {
    const end = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
    const elapsed = end - start;
    console.log(`[Cellucid] ${label}: ${elapsed.toFixed(2)}ms`);
  };
}

