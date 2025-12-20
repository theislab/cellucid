/**
 * Memory Utilities (best-effort, browser-safe)
 *
 * Centralizes memory measurement in one place so we can:
 * - keep monitoring logic DRY across analysis modules
 * - improve type safety via JSDoc typedefs
 * - progressively enhance with newer browser APIs
 *
 * Notes:
 * - `performance.memory` is Chrome-only and reports JS heap, not total process memory.
 * - `performance.measureUserAgentSpecificMemory()` (Chromium) can include more, but
 *   is async and may be unavailable depending on browser/security context.
 *
 * @module shared/memory-utils
 */

/**
 * @typedef {Object} HeapMemoryUsage
 * @property {boolean} available
 * @property {number|null} usedBytes
 * @property {number|null} totalBytes
 * @property {number|null} limitBytes
 * @property {number|null} usedMB
 * @property {number|null} totalMB
 * @property {number|null} limitMB
 * @property {number|null} percentUsed
 */

/**
 * @typedef {Object} UserAgentMemoryUsage
 * @property {boolean} available
 * @property {number|null} bytes
 * @property {number|null} megabytes
 * @property {any} [breakdown]
 * @property {string} [error]
 * @property {number} [timestamp]
 */

/**
 * Convert bytes -> megabytes.
 * @param {number} bytes
 * @returns {number}
 */
export function bytesToMB(bytes) {
  return bytes / (1024 * 1024);
}

/**
 * Get JS heap memory usage (Chrome only).
 * @returns {HeapMemoryUsage}
 */
export function getHeapMemoryUsage() {
  const mem = typeof performance !== 'undefined' ? performance.memory : null;
  if (!mem) {
    return {
      available: false,
      usedBytes: null,
      totalBytes: null,
      limitBytes: null,
      usedMB: null,
      totalMB: null,
      limitMB: null,
      percentUsed: null
    };
  }

  const usedBytes = Number.isFinite(mem.usedJSHeapSize) ? mem.usedJSHeapSize : null;
  const totalBytes = Number.isFinite(mem.totalJSHeapSize) ? mem.totalJSHeapSize : null;
  const limitBytes = Number.isFinite(mem.jsHeapSizeLimit) ? mem.jsHeapSizeLimit : null;

  const usedMB = usedBytes != null ? bytesToMB(usedBytes) : null;
  const totalMB = totalBytes != null ? bytesToMB(totalBytes) : null;
  const limitMB = limitBytes != null ? bytesToMB(limitBytes) : null;

  const percentUsed = usedBytes != null && limitBytes != null && limitBytes > 0
    ? (usedBytes / limitBytes) * 100
    : null;

  return {
    available: true,
    usedBytes,
    totalBytes,
    limitBytes,
    usedMB,
    totalMB,
    limitMB,
    percentUsed
  };
}

/**
 * Best-effort user-agent specific memory measurement (Chromium, async).
 * @returns {Promise<UserAgentMemoryUsage>}
 */
export async function measureUserAgentSpecificMemory() {
  const measure = typeof performance !== 'undefined'
    ? performance.measureUserAgentSpecificMemory
    : null;

  if (typeof measure !== 'function') {
    return { available: false, bytes: null, megabytes: null, timestamp: Date.now() };
  }

  try {
    // Spec shape: { bytes: number, breakdown: Array<...> }
    const measurement = await measure.call(performance);
    const bytes = Number.isFinite(measurement?.bytes) ? measurement.bytes : null;
    return {
      available: bytes != null,
      bytes,
      megabytes: bytes != null ? bytesToMB(bytes) : null,
      breakdown: measurement?.breakdown,
      timestamp: Date.now()
    };
  } catch (err) {
    return {
      available: false,
      bytes: null,
      megabytes: null,
      error: err?.message || String(err),
      timestamp: Date.now()
    };
  }
}

export default {
  bytesToMB,
  getHeapMemoryUsage,
  measureUserAgentSpecificMemory
};
