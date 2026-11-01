/**
 * Analysis Resource Cleanup Utilities
 *
 * Centralizes exact cleanup logic used across analysis modes: prune
 * analysis caches after a run. What memory pressure gives back is the memory
 * model's (`data/memory-budget.js`): every cache trims itself there.
 *
 * @module shared/resource-cleanup
 */

import { requireObjectKeys } from '../../../utils/exact-record.js';
import { formatCountOf } from '../../../utils/format-units.js';

/**
 * @typedef {'none'|'expired'|'all'} DataLayerCleanupLevel
 */

/**
 * Run a standard post-analysis cleanup pass.
 *
 * @param {Object} params
 * @param {any} [params.dataLayer] - DataLayer-like object
 * @param {DataLayerCleanupLevel} [params.dataLayerCleanup='expired'] - How aggressively to clear DataLayer caches
 */
export function cleanupAnalysisResources(params) {
  requireObjectKeys(
    params,
    [],
    ['dataLayer', 'dataLayerCleanup'],
    'Analysis cleanup parameters'
  );
  const {
    dataLayer = null,
    dataLayerCleanup = 'expired',
  } = params;
  if (!['none', 'expired', 'all'].includes(dataLayerCleanup)) {
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
    } else {
      if (typeof dataLayer.performCacheCleanup !== 'function') {
        throw new TypeError('dataLayer must implement performCacheCleanup()');
      }
      run(() => dataLayer.performCacheCleanup());
    }
  }

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      `Analysis cleanup failed in ${formatCountOf(errors.length, 'operation')}`
    );
  }
}
