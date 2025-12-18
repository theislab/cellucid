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
 *
 * @module shared/memory-monitor
 */

import { getNotificationCenter } from '../../notification-center.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Memory thresholds in bytes
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
    console.log('[MemoryMonitor] Started monitoring');
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
    console.log('[MemoryMonitor] Stopped monitoring');
  }

  /**
   * Register a cleanup handler for a component
   * @param {string} componentId - Unique component identifier
   * @param {Function} cleanupFn - Cleanup function to call
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
    // Use Performance.memory if available (Chrome only)
    if (performance?.memory) {
      const memory = performance.memory;
      return {
        usedJSHeapSize: memory.usedJSHeapSize,
        totalJSHeapSize: memory.totalJSHeapSize,
        jsHeapSizeLimit: memory.jsHeapSizeLimit,
        usedMB: (memory.usedJSHeapSize / (1024 * 1024)).toFixed(2),
        totalMB: (memory.totalJSHeapSize / (1024 * 1024)).toFixed(2),
        limitMB: (memory.jsHeapSizeLimit / (1024 * 1024)).toFixed(2),
        percentUsed: ((memory.usedJSHeapSize / memory.jsHeapSizeLimit) * 100).toFixed(1),
        available: true
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
      note: 'Performance.memory not available (non-Chrome browser)'
    };
  }

  /**
   * Perform a memory check
   * @private
   */
  _performCheck() {
    const usage = this.getMemoryUsage();
    this._stats.checksPerformed++;
    this._stats.lastCheck = Date.now();

    if (!usage.available) {
      return;
    }

    const usedBytes = usage.usedJSHeapSize;
    const usedMB = parseFloat(usage.usedMB);

    // Track peak
    if (usedMB > this._stats.peakMemoryMB) {
      this._stats.peakMemoryMB = usedMB;
    }

    // Check thresholds
    if (usedBytes >= THRESHOLDS.CRITICAL) {
      console.warn(`[MemoryMonitor] CRITICAL: Memory usage at ${usedMB}MB - triggering aggressive cleanup`);
      this.performCleanup('critical');
    } else if (usedBytes >= THRESHOLDS.CLEANUP) {
      console.warn(`[MemoryMonitor] HIGH: Memory usage at ${usedMB}MB - triggering cleanup`);
      this.performCleanup('threshold');
    } else if (usedBytes >= THRESHOLDS.WARNING) {
      console.debug(`[MemoryMonitor] Warning: Memory usage at ${usedMB}MB`);
    }
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
        cleanupFn();
        results.handlersRun++;
      } catch (error) {
        console.error(`[MemoryMonitor] Cleanup error in ${componentId}:`, error);
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

    console.log(`[MemoryMonitor] Cleanup complete: ${results.handlersRun} handlers, freed ~${results.freedMB}MB`);

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
