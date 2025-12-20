/**
 * Memory Monitor for Analysis Module
 *
 * Provides memory usage monitoring and automatic cleanup utilities
 * to prevent memory degradation during extended analysis sessions.
 *
 * Features:
 * - Tracks memory usage across components
 * - Triggers cleanup when memory pressure is high
 * - Provides manual cleanup API
 * - Logs memory statistics for debugging
 * - User notifications for cleanup events
 * - Batch feasibility checking for large operations
 * - Memory pressure event subscription
 *
 * @module shared/memory-monitor
 */

import { getNotificationCenter } from '../../notification-center.js';
import { debug, debugWarn, debugError } from './debug-utils.js';
import { getHeapMemoryUsage, measureUserAgentSpecificMemory } from './memory-utils.js';
import { PerformanceConfig } from './performance-config.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Default heap thresholds in bytes (fallback when heap limits are unknown).
 *
 * NOTE: When `performance.memory.jsHeapSizeLimit` is available, we compute dynamic
 * thresholds from `PerformanceConfig.memory.{warningThresholdPercent,cleanupThresholdPercent}`.
 */
const THRESHOLDS = {
  WARNING: 100 * 1024 * 1024,  // 100 MB - log warning
  CLEANUP: 200 * 1024 * 1024,  // 200 MB - trigger cleanup
  CRITICAL: 500 * 1024 * 1024  // 500 MB - aggressive cleanup
};

/**
 * Cleanup intervals
 */
const INTERVALS = {
  CHECK: 60000,      // Check every 60 seconds
  CLEANUP: 300000    // Force cleanup every 5 minutes
};

// =============================================================================
// MEMORY MONITOR CLASS
// =============================================================================

/**
 * Memory Monitor class
 * Tracks memory usage and coordinates cleanup across components
 */
class MemoryMonitor {
  constructor() {
    /** @type {Map<string, Function>} Registered cleanup handlers */
    this._cleanupHandlers = new Map();

    /** @type {number|null} Check interval ID */
    this._checkIntervalId = null;

    /** @type {number|null} Cleanup interval ID */
    this._cleanupIntervalId = null;

    /** @type {boolean} Whether monitoring is active */
    this._active = false;

    /** @type {Object} Statistics */
    this._stats = {
      checksPerformed: 0,
      cleanupsTriggered: 0,
      lastCheck: null,
      lastCleanup: null,
      peakMemoryMB: 0
    };

    /** @type {Object|null} Notification center reference */
    this._notifications = null;

    /** @type {boolean} Whether to show user notifications */
    this._showNotifications = true;

    /** @type {Set<Function>} Memory pressure callbacks */
    this._pressureCallbacks = new Set();

    /** @type {string|null} Current pressure level */
    this._currentPressureLevel = null;

    /** @type {import('./memory-utils.js').UserAgentMemoryUsage|null} */
    this._lastUserAgentMemory = null;

    /** @type {Promise<void>|null} */
    this._userAgentMemoryPromise = null;

    /** @type {number} Minimum interval between UA memory samples */
    this._userAgentMemoryIntervalMs = 120000; // 2 minutes (avoid overhead)
  }

  /**
   * Set whether to show user notifications for cleanup events
   * @param {boolean} show - Whether to show notifications
   */
  setShowNotifications(show) {
    this._showNotifications = show;
  }

  /**
   * Get notification center (lazy init)
   * @returns {Object|null}
   * @private
   */
  _getNotifications() {
    if (!this._notifications) {
      try {
        this._notifications = getNotificationCenter();
      } catch (e) {
        // Notification center may not be available in all contexts
        this._notifications = null;
      }
    }
    return this._notifications;
  }

  /**
   * Start memory monitoring
   * @param {Object} [options] - Configuration options
   * @param {number} [options.checkInterval] - Check interval in ms
   * @param {number} [options.cleanupInterval] - Auto cleanup interval in ms
   */
  start(options = {}) {
    if (this._active) return;

    const checkInterval = options.checkInterval || INTERVALS.CHECK;
    const cleanupInterval = options.cleanupInterval || INTERVALS.CLEANUP;

    // Start periodic checks
    this._checkIntervalId = setInterval(() => {
      this._performCheck();
    }, checkInterval);

    // Start periodic cleanup
    this._cleanupIntervalId = setInterval(() => {
      this.performCleanup('periodic');
    }, cleanupInterval);

    this._active = true;
    debug('MemoryMonitor', 'Started monitoring');
  }

  /**
   * Stop memory monitoring
   */
  stop() {
    if (!this._active) return;

    if (this._checkIntervalId) {
      clearInterval(this._checkIntervalId);
      this._checkIntervalId = null;
    }

    if (this._cleanupIntervalId) {
      clearInterval(this._cleanupIntervalId);
      this._cleanupIntervalId = null;
    }

    this._active = false;
    debug('MemoryMonitor', 'Stopped monitoring');
  }

  /**
   * Register a cleanup handler for a component
   * @param {string} componentId - Unique component identifier
   * @param {(reason?: string) => void} cleanupFn - Cleanup function to call
   */
  registerCleanupHandler(componentId, cleanupFn) {
    this._cleanupHandlers.set(componentId, cleanupFn);
  }

  /**
   * Unregister a cleanup handler
   * @param {string} componentId - Component identifier
   */
  unregisterCleanupHandler(componentId) {
    this._cleanupHandlers.delete(componentId);
  }

  /**
   * Get current memory usage estimate
   * @returns {Object} Memory usage info
   */
  getMemoryUsage() {
    const heap = getHeapMemoryUsage();
    if (heap.available) {
      return {
        usedJSHeapSize: heap.usedBytes,
        totalJSHeapSize: heap.totalBytes,
        jsHeapSizeLimit: heap.limitBytes,
        usedMB: heap.usedMB != null ? heap.usedMB.toFixed(2) : 'N/A',
        totalMB: heap.totalMB != null ? heap.totalMB.toFixed(2) : 'N/A',
        limitMB: heap.limitMB != null ? heap.limitMB.toFixed(2) : 'N/A',
        percentUsed: heap.percentUsed != null ? heap.percentUsed.toFixed(1) : 'N/A',
        available: true,
        // Supplemental measurement (async; may be null if never sampled)
        userAgentBytes: this._lastUserAgentMemory?.bytes ?? null,
        userAgentMB: this._lastUserAgentMemory?.megabytes != null
          ? this._lastUserAgentMemory.megabytes.toFixed(2)
          : null,
        userAgentTimestamp: this._lastUserAgentMemory?.timestamp ?? null,
        userAgentError: this._lastUserAgentMemory?.error ?? null
      };
    }

    // Fallback: estimate based on registered handlers
    return {
      usedJSHeapSize: 0,
      totalJSHeapSize: 0,
      jsHeapSizeLimit: 0,
      usedMB: 'N/A',
      totalMB: 'N/A',
      limitMB: 'N/A',
      percentUsed: 'N/A',
      available: false,
      note: 'Heap memory stats unavailable (non-Chrome browser)',
      userAgentBytes: this._lastUserAgentMemory?.bytes ?? null,
      userAgentMB: this._lastUserAgentMemory?.megabytes != null
        ? this._lastUserAgentMemory.megabytes.toFixed(2)
        : null,
      userAgentTimestamp: this._lastUserAgentMemory?.timestamp ?? null,
      userAgentError: this._lastUserAgentMemory?.error ?? null
    };
  }

  /**
   * Compute heap thresholds based on heap limit when available.
   * @param {ReturnType<MemoryMonitor['getMemoryUsage']>} usage
   * @returns {{WARNING:number,CLEANUP:number,CRITICAL:number}}
   * @private
   */
  _getHeapThresholds(usage) {
    const clampPercent = (value, fallback) => {
      const v = Number(value);
      if (!Number.isFinite(v)) return fallback;
      return Math.max(1, Math.min(v, 99));
    };

    const limitBytes = Number.isFinite(usage?.jsHeapSizeLimit) ? usage.jsHeapSizeLimit : null;
    if (!Number.isFinite(limitBytes) || limitBytes <= 0) {
      return THRESHOLDS;
    }

    const warningPct = clampPercent(PerformanceConfig.memory.warningThresholdPercent, 75) / 100;
    const cleanupPct = clampPercent(PerformanceConfig.memory.cleanupThresholdPercent, 85) / 100;
    const criticalPct = Math.min(0.98, Math.max(0.95, cleanupPct + 0.05));

    return {
      WARNING: limitBytes * warningPct,
      CLEANUP: limitBytes * cleanupPct,
      CRITICAL: limitBytes * criticalPct
    };
  }

  /**
   * Derive a pressure level from UA-specific memory measurements (when available).
   *
   * Rationale: `performance.memory` is JS-heap only; large analyses often allocate
   * significant non-heap memory (ArrayBuffers, worker heaps, WebAssembly, WebGL).
   *
   * We intentionally use conservative ratio-based thresholds to avoid thrashing:
   * only escalate when UA memory far exceeds the JS heap limit.
   *
   * @param {ReturnType<MemoryMonitor['getMemoryUsage']>} usage
   * @returns {'normal'|'warning'|'cleanup'|'critical'}
   * @private
   */
  _getUserAgentPressureLevel(usage) {
    const uaBytes = Number.isFinite(usage?.userAgentBytes) ? usage.userAgentBytes : null;
    const heapLimitBytes = Number.isFinite(usage?.jsHeapSizeLimit) ? usage.jsHeapSizeLimit : null;

    if (!Number.isFinite(uaBytes) || uaBytes <= 0) return 'normal';
    if (!Number.isFinite(heapLimitBytes) || heapLimitBytes <= 0) return 'normal';

    const ratio = uaBytes / heapLimitBytes;
    if (ratio >= 2.5) return 'critical';
    if (ratio >= 2.0) return 'cleanup';
    if (ratio >= 1.5) return 'warning';
    return 'normal';
  }

  /**
   * Choose the more severe of two pressure levels.
   * @param {'normal'|'warning'|'cleanup'|'critical'} a
   * @param {'normal'|'warning'|'cleanup'|'critical'} b
   * @returns {'normal'|'warning'|'cleanup'|'critical'}
   * @private
   */
  _maxPressureLevel(a, b) {
    const rank = { normal: 0, warning: 1, cleanup: 2, critical: 3 };
    return (rank[b] > rank[a]) ? b : a;
  }

  /**
   * Perform a memory check
   * @private
   */
  _performCheck() {
    // Best-effort background sample (does not block checks).
    this._maybeSampleUserAgentMemory();

    const usage = this.getMemoryUsage();
    this._stats.checksPerformed++;
    this._stats.lastCheck = Date.now();

    if (!usage.available) {
      // Still notify subscribers so they can degrade gracefully.
      this._notifyPressureChange('unknown', usage);
      return;
    }

    const usedBytes = usage.usedJSHeapSize;
    const usedMB = parseFloat(usage.usedMB);
    const thresholds = this._getHeapThresholds(usage);

    // Track peak
    if (usedMB > this._stats.peakMemoryMB) {
      this._stats.peakMemoryMB = usedMB;
    }

    // Check thresholds
    const heapLevel = usedBytes >= thresholds.CRITICAL
      ? 'critical'
      : usedBytes >= thresholds.CLEANUP
        ? 'cleanup'
        : usedBytes >= thresholds.WARNING
          ? 'warning'
          : 'normal';

    const uaLevel = this._getUserAgentPressureLevel(usage);
    const level = this._maxPressureLevel(heapLevel, uaLevel);

    if (level === 'critical') {
      this._notifyPressureChange(level, usage);
      debugWarn('MemoryMonitor', `CRITICAL: Memory usage at ${usedMB}MB - triggering aggressive cleanup`);
      this.performCleanup('critical');
    } else if (level === 'cleanup') {
      this._notifyPressureChange(level, usage);
      debugWarn('MemoryMonitor', `HIGH: Memory usage at ${usedMB}MB - triggering cleanup`);
      this.performCleanup('threshold');
    } else if (level === 'warning') {
      this._notifyPressureChange(level, usage);
      debug('MemoryMonitor', `Warning: Memory usage at ${usedMB}MB`);
    } else {
      this._notifyPressureChange(level, usage);
    }
  }

  /**
   * Best-effort async sampling of user-agent memory measurement.
   * @private
   */
  _maybeSampleUserAgentMemory() {
    if (this._userAgentMemoryPromise) return;

    const lastTs = this._lastUserAgentMemory?.timestamp;
    const now = Date.now();
    if (lastTs && (now - lastTs) < this._userAgentMemoryIntervalMs) return;

    this._userAgentMemoryPromise = measureUserAgentSpecificMemory()
      .then((measurement) => {
        // Keep the latest result (even when unavailable) to preserve error context.
        this._lastUserAgentMemory = measurement;
      })
      .catch((err) => {
        this._lastUserAgentMemory = {
          available: false,
          bytes: null,
          megabytes: null,
          error: err?.message || String(err),
          timestamp: Date.now()
        };
      })
      .finally(() => {
        this._userAgentMemoryPromise = null;
      });
  }

  /**
   * Perform cleanup across all registered handlers
   * @param {string} [reason='manual'] - Reason for cleanup
   * @returns {Object} Cleanup results
   */
  performCleanup(reason = 'manual') {
    this._stats.cleanupsTriggered++;
    this._stats.lastCleanup = Date.now();

    const beforeUsage = this.getMemoryUsage();
    const results = {
      reason,
      handlersRun: 0,
      errors: [],
      beforeMB: beforeUsage.usedMB,
      afterMB: null,
      freedMB: null
    };

    // Show user notification for non-periodic cleanups
    const notifications = this._getNotifications();
    const shouldNotify = this._showNotifications && notifications && reason !== 'periodic';

    if (shouldNotify) {
      const reasonText = reason === 'critical'
        ? 'High memory usage detected'
        : reason === 'threshold'
          ? 'Memory optimization in progress'
          : 'Clearing analysis cache';

      notifications.show({
        type: 'warning',
        category: 'data',
        message: `${reasonText}. Some cached data may need to be reloaded.`,
        duration: 5000
      });
    }

    // Run all cleanup handlers
    for (const [componentId, cleanupFn] of this._cleanupHandlers) {
      try {
        cleanupFn(reason);
        results.handlersRun++;
      } catch (error) {
        debugError('MemoryMonitor', `Cleanup error in ${componentId}:`, error);
        results.errors.push({ component: componentId, error: error.message });
      }
    }

    // Suggest garbage collection (browser may or may not honor this)
    if (typeof window !== 'undefined' && window.gc) {
      try {
        window.gc();
      } catch (e) {
        // gc() not available
      }
    }

    // Check memory after cleanup
    const afterUsage = this.getMemoryUsage();
    results.afterMB = afterUsage.usedMB;

    if (afterUsage.available && beforeUsage.available) {
      const freed = parseFloat(beforeUsage.usedMB) - parseFloat(afterUsage.usedMB);
      results.freedMB = freed.toFixed(2);
    }

    debug('MemoryMonitor', `Cleanup complete: ${results.handlersRun} handlers, freed ~${results.freedMB}MB`);

    return results;
  }

  /**
   * Get monitoring statistics
   * @returns {Object} Statistics
   */
  getStats() {
    return {
      ...this._stats,
      active: this._active,
      registeredHandlers: this._cleanupHandlers.size,
      currentMemory: this.getMemoryUsage()
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this._stats = {
      checksPerformed: 0,
      cleanupsTriggered: 0,
      lastCheck: null,
      lastCleanup: null,
      peakMemoryMB: 0
    };
  }

  // ===========================================================================
  // BATCH FEASIBILITY CHECKING
  // ===========================================================================

  /**
   * Check if we have enough memory for a batch operation
   *
   * Analyzes current memory usage and estimates whether a batch operation
   * of the given size can safely proceed without exceeding browser limits.
   *
   * @param {number} estimatedMB - Estimated memory needed for the operation (MB)
   * @param {Object} [options] - Additional options
   * @param {number} [options.safetyMargin=0.7] - Safety margin (0-1)
   * @param {boolean} [options.includeCurrentUsage=true] - Factor in current usage
   * @returns {BatchFeasibilityResult} Feasibility assessment
   *
   * @typedef {Object} BatchFeasibilityResult
   * @property {boolean} canProceed - Whether operation can safely proceed
   * @property {number|null} availableMB - Available memory (MB, null if unknown)
   * @property {number|null} currentUsedMB - Currently used memory (MB)
   * @property {number|null} limitMB - Heap limit (MB)
   * @property {number} requestedMB - Requested memory for operation
   * @property {string} recommendation - Human-readable recommendation
   * @property {'ok'|'warning'|'critical'|'unknown'} level - Severity level
   *
   * @example
   * const check = memoryMonitor.checkBatchFeasibility(256);
   * if (!check.canProceed) {
   *   console.warn(check.recommendation);
   *   // Reduce batch size...
   * }
   */
  checkBatchFeasibility(estimatedMB, options = {}) {
    const { safetyMargin = 0.7, includeCurrentUsage = true } = options;
    const usage = this.getMemoryUsage();

    // Fallback when Performance.memory not available
    if (!usage.available) {
      // Be conservative - allow operations under 256MB without measurement
      const canProceed = estimatedMB < 256;
      return {
        canProceed,
        availableMB: null,
        currentUsedMB: null,
        limitMB: null,
        requestedMB: estimatedMB,
        recommendation: canProceed
          ? 'Memory stats unavailable. Proceeding with conservative estimate.'
          : 'Memory stats unavailable. Reduce batch size to under 256MB for safety.',
        level: canProceed ? 'unknown' : 'warning'
      };
    }

    const usedMB = includeCurrentUsage ? parseFloat(usage.usedMB) : 0;
    const limitMB = parseFloat(usage.limitMB);
    const percentUsed = includeCurrentUsage ? parseFloat(usage.percentUsed) : 0;

    // Calculate available memory with safety margin
    const theoreticalAvailable = limitMB - usedMB;
    const safeAvailableMB = theoreticalAvailable * safetyMargin;

    // Check if we're already under memory pressure (heap-based).
    const thresholds = this._getHeapThresholds(usage);
    const alreadyUnderPressure = includeCurrentUsage && usage.usedJSHeapSize >= thresholds.WARNING;

    // Determine if operation can proceed
    const canProceed = estimatedMB <= safeAvailableMB && !alreadyUnderPressure;

    // Generate recommendation
    let recommendation;
    let level;

    if (canProceed) {
      recommendation = `Memory available: ${Math.round(safeAvailableMB)}MB safe, requesting ${estimatedMB}MB.`;
      level = 'ok';
    } else if (alreadyUnderPressure) {
      recommendation =
        `Memory pressure detected (${percentUsed}% used). ` +
        `Consider clearing cache before starting. ` +
        `Requested: ${estimatedMB}MB, Available: ${Math.round(safeAvailableMB)}MB.`;
      level = 'warning';
    } else if (estimatedMB > theoreticalAvailable) {
      recommendation =
        `Insufficient memory. Requested: ${estimatedMB}MB, ` +
        `Available: ${Math.round(theoreticalAvailable)}MB (${Math.round(safeAvailableMB)}MB safe). ` +
        `Reduce batch size to ${Math.floor(safeAvailableMB * 0.8)}MB or less.`;
      level = 'critical';
    } else {
      recommendation =
        `Operation may cause memory pressure. ` +
        `Requested: ${estimatedMB}MB, Safe available: ${Math.round(safeAvailableMB)}MB. ` +
        `Consider reducing to ${Math.floor(safeAvailableMB * 0.8)}MB.`;
      level = 'warning';
    }

    return {
      canProceed,
      availableMB: Math.round(safeAvailableMB),
      currentUsedMB: Math.round(usedMB),
      limitMB: Math.round(limitMB),
      requestedMB: estimatedMB,
      recommendation,
      level
    };
  }

  /**
   * Suggest optimal batch size based on current memory state
   *
   * @param {number} bytesPerItem - Memory per item in bytes
   * @param {number} overheadFactor - Memory overhead multiplier (e.g., 5 for Wilcoxon)
   * @param {Object} [options] - Options
   * @param {number} [options.targetUtilization=0.5] - Target memory utilization (0-1)
   * @param {number} [options.minItems=10] - Minimum items per batch
   * @param {number} [options.maxItems=500] - Maximum items per batch
   * @returns {Object} Suggested batch configuration
   */
  suggestBatchSize(bytesPerItem, overheadFactor = 1, options = {}) {
    const {
      targetUtilization = 0.5,
      minItems = 10,
      maxItems = 500
    } = options;

    const usage = this.getMemoryUsage();

    // Fallback when memory API unavailable
    if (!usage.available) {
      // Conservative default: 50MB budget
      const defaultBudgetBytes = 50 * 1024 * 1024;
      const memoryPerItem = bytesPerItem * overheadFactor;
      const suggestedItems = Math.floor(defaultBudgetBytes / memoryPerItem);

      return {
        suggestedBatchSize: Math.max(minItems, Math.min(suggestedItems, maxItems)),
        budgetMB: 50,
        memoryPerItemMB: memoryPerItem / (1024 * 1024),
        confidence: 'low',
        note: 'Using conservative defaults (memory API unavailable)'
      };
    }

    const limitMB = parseFloat(usage.limitMB);
    const usedMB = parseFloat(usage.usedMB);
    const availableMB = limitMB - usedMB;

    // Target budget based on available memory and utilization
    const budgetMB = availableMB * targetUtilization;
    const budgetBytes = budgetMB * 1024 * 1024;

    // Calculate items that fit in budget
    const memoryPerItem = bytesPerItem * overheadFactor;
    const suggestedItems = Math.floor(budgetBytes / memoryPerItem);

    return {
      suggestedBatchSize: Math.max(minItems, Math.min(suggestedItems, maxItems)),
      budgetMB: Math.round(budgetMB),
      memoryPerItemMB: Math.round((memoryPerItem / (1024 * 1024)) * 100) / 100,
      availableMB: Math.round(availableMB),
      confidence: 'high',
      note: `Based on ${Math.round(targetUtilization * 100)}% of available ${Math.round(availableMB)}MB`
    };
  }

  // ===========================================================================
  // MEMORY PRESSURE EVENTS
  // ===========================================================================

  /**
   * Subscribe to memory pressure events
   *
   * Callback is invoked when memory usage crosses threshold levels.
   *
   * @param {Function} callback - Function called on pressure change
   * @returns {Function} Unsubscribe function
   *
   * @example
   * const unsubscribe = memoryMonitor.onMemoryPressure((event) => {
   *   if (event.level === 'critical') {
   *     // Pause loading, reduce batch size, etc.
   *   }
   * });
   */
  onMemoryPressure(callback) {
    if (typeof callback !== 'function') {
      debugWarn('MemoryMonitor', 'onMemoryPressure requires a function callback');
      return () => {};
    }

    this._pressureCallbacks.add(callback);

    // Return unsubscribe function
    return () => {
      this._pressureCallbacks.delete(callback);
    };
  }

  /**
   * Notify subscribers of memory pressure change
   * @param {string} level - Pressure level ('normal', 'warning', 'cleanup', 'critical')
   * @param {Object} usage - Current memory usage
   * @private
   */
  _notifyPressureChange(level, usage) {
    if (level === this._currentPressureLevel) return;

    const previousLevel = this._currentPressureLevel;
    this._currentPressureLevel = level;

    const event = {
      level,
      previousLevel,
      timestamp: Date.now(),
      usage
    };

    for (const callback of this._pressureCallbacks) {
      try {
        callback(event);
      } catch (err) {
        debugError('MemoryMonitor', 'Pressure callback error:', err);
      }
    }
  }

  /**
   * Get current memory pressure level
   * @returns {'normal'|'warning'|'cleanup'|'critical'|'unknown'}
   */
  getPressureLevel() {
    const usage = this.getMemoryUsage();

    if (!usage.available) return 'unknown';

    const usedBytes = usage.usedJSHeapSize;
    const thresholds = this._getHeapThresholds(usage);
    const heapLevel = usedBytes >= thresholds.CRITICAL
      ? 'critical'
      : usedBytes >= thresholds.CLEANUP
        ? 'cleanup'
        : usedBytes >= thresholds.WARNING
          ? 'warning'
          : 'normal';

    const uaLevel = this._getUserAgentPressureLevel(usage);
    return this._maxPressureLevel(heapLevel, uaLevel);
  }

  /**
   * Check if memory is under pressure
   * @returns {boolean}
   */
  isUnderPressure() {
    const level = this.getPressureLevel();
    return level === 'warning' || level === 'cleanup' || level === 'critical';
  }
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

let memoryMonitorInstance = null;

/**
 * Get the singleton MemoryMonitor instance
 * @returns {MemoryMonitor}
 */
export function getMemoryMonitor() {
  if (!memoryMonitorInstance) {
    memoryMonitorInstance = new MemoryMonitor();
  }
  return memoryMonitorInstance;
}

/**
 * Create a new MemoryMonitor instance (for testing)
 * @returns {MemoryMonitor}
 */
export function createMemoryMonitor() {
  return new MemoryMonitor();
}

// =============================================================================
// CONVENIENCE EXPORTS
// =============================================================================

export { MemoryMonitor, THRESHOLDS, INTERVALS };

export default MemoryMonitor;
