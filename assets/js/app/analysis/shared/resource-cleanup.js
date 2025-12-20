/**
 * Analysis Resource Cleanup Utilities
 *
 * Centralizes best-effort cleanup logic used across analysis modes to keep code DRY:
 * - recycle idle workers (frees worker heaps / transferred ArrayBuffers)
 * - prune analysis caches
 * - clear dataset-level caches when the active source supports it (e.g., h5ad dense X cache)
 *
 * NOTE: All functions in this module must be safe to call in any state; they should never throw.
 *
 * @module shared/resource-cleanup
 */

import { getDataSourceManager } from '../../../data/data-source-manager.js';

/**
 * @typedef {'none'|'expired'|'bulk'|'all'} DataLayerCleanupLevel
 */

/**
 * Best-effort cache release on the active dataset source.
 *
 * Some sources (notably local h5ad / zarr) cache large buffers (e.g., dense X matrix).
 * Clearing those caches after gene-heavy analyses helps return memory to the browser.
 */
export function clearActiveSourceCaches() {
  try {
    const manager = getDataSourceManager?.();
    const source = manager?.activeSource || null;

    // Direct hook on the source (if implemented).
    if (typeof source?.clearCaches === 'function') {
      source.clearCaches();
      return;
    }

    // local-user exposes underlying sources (h5ad/zarr) via getters.
    const h5ad = source?.getH5adSource?.();
    if (typeof h5ad?.clearCaches === 'function') {
      h5ad.clearCaches();
    }

    const zarr = source?.getZarrSource?.();
    if (typeof zarr?.clearCaches === 'function') {
      zarr.clearCaches();
    }
  } catch (_err) {
    // Ignore cleanup errors
  }
}

/**
 * Run a standard post-analysis cleanup pass.
 *
 * @param {Object} params
 * @param {any} [params.computeManager] - ComputeManager-like object
 * @param {any} [params.dataLayer] - DataLayer-like object
 * @param {boolean} [params.clearSourceCaches=true]
 * @param {number} [params.keepAtLeastIdleWorkers=0]
 * @param {DataLayerCleanupLevel} [params.dataLayerCleanup='expired'] - How aggressively to clear DataLayer caches
 */
export function bestEffortCleanupAnalysisResources({
  computeManager,
  dataLayer,
  clearSourceCaches: shouldClearSourceCaches = true,
  keepAtLeastIdleWorkers = 0,
  dataLayerCleanup = 'expired'
} = {}) {
  // Compute backend cleanup (worker/GPU)
  try {
    computeManager?.cleanupIdleResources?.({ keepAtLeastIdleWorkers });
  } catch (_err) {
    // Ignore cleanup errors
  }

  // DataLayer cache pruning
  try {
    if (dataLayerCleanup === 'all') {
      dataLayer?.clearAllCaches?.();
    } else if (dataLayerCleanup === 'bulk') {
      dataLayer?.clearBulkGeneCache?.();
      dataLayer?.performCacheCleanup?.();
    } else if (dataLayerCleanup === 'expired') {
      dataLayer?.performCacheCleanup?.();
    }
  } catch (_err) {
    // Ignore cleanup errors
  }

  if (shouldClearSourceCaches) {
    clearActiveSourceCaches();
  }
}

export default {
  clearActiveSourceCaches,
  bestEffortCleanupAnalysisResources
};
