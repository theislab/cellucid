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
    /**
     * Registered cleanup-handler generations.
     * @type {Map<string, {
     *   cleanupFn: Function,
     *   registered: boolean,
     *   tasks: Set<Promise<void>>,
     *   drainPromise: Promise<void>|null
     * }>}
     */
    this._cleanupHandlers = new Map();

    /**
     * Retiring generations retain their exact drain task until settlement so
     * repeated teardown calls cannot lose ownership of running work.
     * @type {Map<string, {
     *   cleanupFn: Function,
     *   registered: boolean,
     *   tasks: Set<Promise<void>>,
     *   drainPromise: Promise<void>|null
     * }>}
     */
    this._cleanupHandlerRetirements = new Map();

    /** @type {Map<unknown, Promise<Object>>} In-flight cleanups by reason */
    this._cleanupTasks = new Map();

    /** @type {Promise<void>} Serial owner for non-reentrant cleanup handlers */
    this._cleanupTail = Promise.resolve();

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
    if (typeof show !== 'boolean') {
      throw new TypeError('MemoryMonitor notification visibility must be boolean');
    }
    this._showNotifications = show;
  }

  /**
   * Get notification center (lazy init)
   * @returns {Object|null}
   * @private
   */
  _getNotifications() {
    if (!this._notifications) {
      this._notifications = getNotificationCenter();
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

    const checkInterval = options.checkInterval ?? INTERVALS.CHECK;
    const cleanupInterval = options.cleanupInterval ?? INTERVALS.CLEANUP;
    if (!Number.isFinite(checkInterval) || checkInterval <= 0) {
      throw new RangeError('MemoryMonitor checkInterval must be a positive finite number');
    }
    if (!Number.isFinite(cleanupInterval) || cleanupInterval <= 0) {
      throw new RangeError('MemoryMonitor cleanupInterval must be a positive finite number');
    }

    // Start periodic checks
    this._checkIntervalId = setInterval(() => {
      this._performCheck();
    }, checkInterval);

    // Start periodic cleanup
    this._cleanupIntervalId = setInterval(() => {
      this._performCleanupInBackground('periodic');
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
   * @param {(reason?: string) => void|Promise<void>} cleanupFn - Cleanup function to call
   */
  registerCleanupHandler(componentId, cleanupFn) {
    if (typeof componentId !== 'string' || componentId.length === 0) {
      throw new TypeError('MemoryMonitor componentId must be a non-empty string');
    }
    if (typeof cleanupFn !== 'function') {
      throw new TypeError('MemoryMonitor cleanup handler must be a function');
    }
    if (this._cleanupHandlers.has(componentId)) {
      throw new Error(`MemoryMonitor cleanup handler already registered: ${componentId}`);
    }
    const retiredOwner = this._cleanupHandlerRetirements.get(componentId);
    if (retiredOwner) {
      throw new Error(`MemoryMonitor cleanup handler is still retiring: ${componentId}`);
    }
    this._cleanupHandlers.set(componentId, {
      cleanupFn,
      registered: true,
      tasks: new Set(),
      drainPromise: null
    });
  }

  /**
   * Unregister a cleanup handler and drain work already running for its exact
   * generation. Cleanup generations that were queued but have not invoked the
   * handler skip it after retirement.
   * @param {string} componentId - Component identifier
   * @returns {Promise<void>} Stable drain task for the retired generation
   */
  unregisterCleanupHandler(componentId) {
    const existingRetirement = this._cleanupHandlerRetirements.get(componentId);
    if (existingRetirement) {
      return existingRetirement.drainPromise;
    }

    const owner = this._cleanupHandlers.get(componentId);
    if (!owner) {
      throw new Error(`MemoryMonitor cleanup handler is not registered: ${componentId}`);
    }
    this._cleanupHandlers.delete(componentId);
    owner.registered = false;

    owner.drainPromise = Promise.allSettled([...owner.tasks]).then(outcomes => {
      if (this._cleanupHandlerRetirements.get(componentId) === owner) {
        this._cleanupHandlerRetirements.delete(componentId);
      }
      const errors = [...new Set(
        outcomes
          .filter(outcome => outcome.status === 'rejected')
          .map(outcome => outcome.reason)
      )];
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          `Memory cleanup handler ${componentId} failed in ${errors.length} task(s)`
        );
      }
    });
    this._cleanupHandlerRetirements.set(componentId, owner);
    // Some synchronous handler owners do not need to await an already-settled
    // drain. Observe failures internally while preserving them for awaiters.
    void owner.drainPromise.catch(() => {});

    // If no components remain registered, stop background polling to avoid
    // unnecessary CPU/battery usage.
    if (this._cleanupHandlers.size === 0) {
      this.stop();
    }
    return owner.drainPromise;
  }

  /**
   * Return the number of registered cleanup handlers.
   * @returns {number}
   */
  getCleanupHandlerCount() {
    return this._cleanupHandlers.size;
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
        usedMB: heap.usedMB,
        totalMB: heap.totalMB,
        limitMB: heap.limitMB,
        percentUsed: heap.percentUsed,
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

    return {
      usedJSHeapSize: null,
      totalJSHeapSize: null,
      jsHeapSizeLimit: null,
      usedMB: null,
      totalMB: null,
      limitMB: null,
      percentUsed: null,
      available: false,
      note: 'The JS heap measurement API is unavailable',
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
    if (!usage || usage.available !== true) {
      throw new TypeError('Heap thresholds require an available heap measurement');
    }
    const limitBytes = usage.jsHeapSizeLimit;
    if (!Number.isFinite(limitBytes) || limitBytes <= 0) {
      throw new TypeError('Heap thresholds require a positive finite heap limit');
    }
    const warningPercent = PerformanceConfig.memory.warningThresholdPercent;
    const cleanupPercent = PerformanceConfig.memory.cleanupThresholdPercent;
    const criticalPercent = PerformanceConfig.memory.criticalThresholdPercent;
    if (
      !Number.isFinite(warningPercent) ||
      !Number.isFinite(cleanupPercent) ||
      !Number.isFinite(criticalPercent) ||
      warningPercent <= 0 ||
      warningPercent >= cleanupPercent ||
      cleanupPercent >= criticalPercent ||
      criticalPercent >= 100
    ) {
      throw new RangeError(
        'Memory thresholds must satisfy 0 < warning < cleanup < critical < 100'
      );
    }

    return {
      WARNING: limitBytes * (warningPercent / 100),
      CLEANUP: limitBytes * (cleanupPercent / 100),
      CRITICAL: limitBytes * (criticalPercent / 100)
    };
  }

  /**
   * Perform a memory check
   * @private
   */
  _performCheck() {
    // Non-blocking browser-capability sample; heap checks remain synchronous.
    this._maybeSampleUserAgentMemory();

    const usage = this.getMemoryUsage();
    this._stats.checksPerformed++;
    this._stats.lastCheck = Date.now();

    if (!usage.available) {
      this._notifyPressureChange('unknown', usage);
      return;
    }

    const usedBytes = usage.usedJSHeapSize;
    const usedMB = usage.usedMB;
    if (!Number.isFinite(usedBytes) || !Number.isFinite(usedMB)) {
      throw new TypeError('Available heap measurements must contain finite usage values');
    }
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

    const level = heapLevel;

    if (level === 'critical') {
      this._notifyPressureChange(level, usage);
      debugWarn('MemoryMonitor', `CRITICAL: Memory usage at ${usedMB}MB - triggering aggressive cleanup`);
      this._performCleanupInBackground('critical');
    } else if (level === 'cleanup') {
      this._notifyPressureChange(level, usage);
      debugWarn('MemoryMonitor', `HIGH: Memory usage at ${usedMB}MB - triggering cleanup`);
      this._performCleanupInBackground('threshold');
    } else if (level === 'warning') {
      this._notifyPressureChange(level, usage);
      debug('MemoryMonitor', `Warning: Memory usage at ${usedMB}MB`);
    } else {
      this._notifyPressureChange(level, usage);
    }
  }

  /**
   * Non-blocking sampling of the user-agent memory capability.
   * @private
   */
  _maybeSampleUserAgentMemory() {
    if (this._userAgentMemoryPromise) return;

    const lastTs = this._lastUserAgentMemory?.timestamp;
    const now = Date.now();
    if (lastTs && (now - lastTs) < this._userAgentMemoryIntervalMs) return;

    this._userAgentMemoryPromise = measureUserAgentSpecificMemory()
      .then((measurement) => {
        this._lastUserAgentMemory = measurement;
      })
      .finally(() => {
        this._userAgentMemoryPromise = null;
      });
  }

  /**
   * Start a cleanup from a timer/pressure callback and explicitly observe any
   * failure because those call sites have no awaiting caller.
   * @param {string} reason
   * @private
   */
  _performCleanupInBackground(reason) {
    let cleanupTask;
    try {
      cleanupTask = this.performCleanup(reason);
    } catch (error) {
      this._reportCleanupFailure(`${reason} cleanup failed:`, error);
      return;
    }

    void Promise.resolve(cleanupTask).catch(error => {
      this._reportCleanupFailure(`${reason} cleanup failed:`, error);
    });
  }

  /**
   * Report a cleanup failure without allowing optional diagnostics to replace
   * the exact owned failure.
   * @param {string} message
   * @param {unknown} error
   * @private
   */
  _reportCleanupFailure(message, error) {
    try {
      debugError('MemoryMonitor', message, error);
    } catch {
      // Cleanup ownership must not depend on optional debug infrastructure.
    }
  }

  /**
   * Perform cleanup across all registered handlers
   * @param {string} [reason='manual'] - Reason for cleanup
   * @returns {Promise<Object>} Cleanup results
   */
  performCleanup(reason = 'manual') {
    const existingTask = this._cleanupTasks.get(reason);
    if (existingTask) {
      return existingTask;
    }

    let rejectTask;
    let resolveTask;
    const cleanupTask = new Promise((resolve, reject) => {
      rejectTask = reject;
      resolveTask = resolve;
    });
    this._cleanupTasks.set(reason, cleanupTask);

    this._stats.cleanupsTriggered++;
    this._stats.lastCleanup = Date.now();

    // Snapshot ownership at request time. A handler registered after this call
    // belongs to the next cleanup generation.
    const cleanupHandlers = [...this._cleanupHandlers.entries()];

    const operation = async () => {
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

      // Start every owned handler without serializing independent components,
      // then settle them together. Promise.all preserves registration order.
      const handlerOutcomes = await Promise.all(
        cleanupHandlers.map(([componentId, owner]) => {
          if (
            !owner.registered ||
            this._cleanupHandlers.get(componentId) !== owner
          ) {
            return { status: 'skipped', componentId };
          }

          let rejectHandlerTask;
          let resolveHandlerTask;
          const handlerTask = new Promise((resolve, reject) => {
            rejectHandlerTask = reject;
            resolveHandlerTask = resolve;
          });
          owner.tasks.add(handlerTask);
          const clearHandlerTask = () => {
            owner.tasks.delete(handlerTask);
          };
          void handlerTask.then(clearHandlerTask, clearHandlerTask);

          let handlerResult;
          try {
            handlerResult = owner.cleanupFn(reason);
            results.handlersRun++;
          } catch (error) {
            rejectHandlerTask(error);
            return handlerTask.then(
              () => ({ status: 'fulfilled', componentId }),
              handlerError => ({
                status: 'rejected',
                componentId,
                error: handlerError
              })
            );
          }

          void Promise.resolve(handlerResult).then(
            () => resolveHandlerTask(),
            rejectHandlerTask
          );
          return handlerTask.then(
            () => ({ status: 'fulfilled', componentId }),
            error => ({ status: 'rejected', componentId, error })
          );
        })
      );

      for (const outcome of handlerOutcomes) {
        if (outcome.status !== 'rejected') continue;
        const { componentId, error } = outcome;
        this._reportCleanupFailure(`Cleanup error in ${componentId}:`, error);
        results.errors.push({ component: componentId, error });
      }

      // Measure only after every handler has settled so freed memory reflects
      // the complete cleanup generation.
      const afterUsage = this.getMemoryUsage();
      results.afterMB = afterUsage.usedMB;

      if (afterUsage.available && beforeUsage.available) {
        results.freedMB = beforeUsage.usedMB - afterUsage.usedMB;
      }

      debug('MemoryMonitor', `Cleanup complete: ${results.handlersRun} handlers, freed ~${results.freedMB}MB`);

      const errors = [...new Set(results.errors.map(entry => entry.error))];
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          `Memory cleanup failed in ${errors.length} handler(s)`
        );
      }
      return results;
    };

    const scheduledOperation = this._cleanupTail.then(
      operation,
      operation
    );
    this._cleanupTail = scheduledOperation.then(
      () => undefined,
      () => undefined
    );
    void scheduledOperation.then(resolveTask, rejectTask);

    const clearTask = () => {
      if (this._cleanupTasks.get(reason) === cleanupTask) {
        this._cleanupTasks.delete(reason);
      }
    };
    void cleanupTask.then(clearTask, clearTask);

    return cleanupTask;
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
      throw new TypeError('MemoryMonitor onMemoryPressure requires a function callback');
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
      callback(event);
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

    return heapLevel;
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

export { MemoryMonitor, INTERVALS };

export default MemoryMonitor;
