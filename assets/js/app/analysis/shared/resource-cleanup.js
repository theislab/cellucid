/**
 * Analysis Resource Cleanup Utilities
 *
 * Centralizes exact cleanup logic used across analysis modes:
 * - prune analysis caches
 * - clear dataset-level caches exposed by the active source
 *
 * @module shared/resource-cleanup
 */

import { getDataSourceManager } from '../../../data/data-source-manager.js';

/**
 * @typedef {'none'|'expired'|'bulk'|'all'} DataLayerCleanupLevel
 */

/**
 * Release caches exposed by the active dataset source.
 *
 * Some sources (notably local h5ad / zarr) cache large buffers (e.g., dense X matrix).
 * Clearing those caches after gene-heavy analyses helps return memory to the browser.
 *
 * @returns {number} Number of source cache owners cleared
 */
export function clearActiveSourceCaches() {
  const manager = getDataSourceManager();
  const source = manager.activeSource;
  if (source === null) return 0;

  if (typeof source.clearCaches === 'function') {
    source.clearCaches();
    return 1;
  }

  const cacheOwners = [];
  if (typeof source.getH5adSource === 'function') {
    const h5adSource = source.getH5adSource();
    if (h5adSource !== null) cacheOwners.push(h5adSource);
  }
  if (typeof source.getZarrSource === 'function') {
    const zarrSource = source.getZarrSource();
    if (zarrSource !== null) cacheOwners.push(zarrSource);
  }
  for (const cacheOwner of cacheOwners) {
    if (typeof cacheOwner?.clearCaches !== 'function') {
      throw new TypeError(
        'Active dataset cache owner must implement clearCaches()'
      );
    }
    cacheOwner.clearCaches();
  }
  return cacheOwners.length;
}

/**
 * Run a standard post-analysis cleanup pass.
 *
 * @param {Object} params
 * @param {any} [params.dataLayer] - DataLayer-like object
 * @param {boolean} [params.clearSourceCaches=true]
 * @param {DataLayerCleanupLevel} [params.dataLayerCleanup='expired'] - How aggressively to clear DataLayer caches
 */
export function cleanupAnalysisResources(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new TypeError('Analysis cleanup parameters must be an object');
  }
  const allowedKeys = new Set([
    'dataLayer',
    'clearSourceCaches',
    'dataLayerCleanup'
  ]);
  for (const key of Object.keys(params)) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(`Analysis cleanup contains unknown key "${key}"`);
    }
  }
  const {
    dataLayer = null,
    clearSourceCaches: shouldClearSourceCaches = true,
    dataLayerCleanup = 'expired',
  } = params;
  if (typeof shouldClearSourceCaches !== 'boolean') {
    throw new TypeError('clearSourceCaches must be exactly boolean');
  }
  if (!['none', 'expired', 'bulk', 'all'].includes(dataLayerCleanup)) {
    throw new TypeError(
      `Unknown DataLayer cleanup level: ${String(dataLayerCleanup)}`
    );
  }

  const errors = [];
  const run = operation => {
    try {
      operation();
    } catch (error) {
      errors.push(error);
    }
  };

  if (dataLayerCleanup !== 'none') {
    if (dataLayer === null || typeof dataLayer !== 'object') {
      throw new TypeError(
        `DataLayer cleanup level "${dataLayerCleanup}" requires dataLayer`
      );
    }
    if (dataLayerCleanup === 'all') {
      if (typeof dataLayer.clearAllCaches !== 'function') {
        throw new TypeError('dataLayer must implement clearAllCaches()');
      }
      run(() => dataLayer.clearAllCaches());
    } else if (dataLayerCleanup === 'bulk') {
      if (
        typeof dataLayer.clearBulkGeneCache !== 'function' ||
        typeof dataLayer.performCacheCleanup !== 'function'
      ) {
        throw new TypeError(
          'bulk DataLayer cleanup requires clearBulkGeneCache() and performCacheCleanup()'
        );
      }
      run(() => dataLayer.clearBulkGeneCache());
      run(() => dataLayer.performCacheCleanup());
    } else {
      if (typeof dataLayer.performCacheCleanup !== 'function') {
        throw new TypeError('dataLayer must implement performCacheCleanup()');
      }
      run(() => dataLayer.performCacheCleanup());
    }
  }

  if (shouldClearSourceCaches) {
    run(() => clearActiveSourceCaches());
  }

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      `Analysis cleanup failed in ${errors.length} operations`
    );
  }
}

export default {
  clearActiveSourceCaches,
  cleanupAnalysisResources,
};
