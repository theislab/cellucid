/**
 * Progress Tracker Module
 *
 * Provides detailed progress tracking for long-running operations with:
 * - Accurate ETA calculations using rolling averages
 * - Phase tracking for multi-step operations
 * - Throughput metrics
 * - Cancellation support
 * - Integration with notification center
 *
 * @module shared/progress-tracker
 */

import { getNotificationCenter } from '../../notification-center.js';

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * Default configuration for progress tracking
 * @type {Object}
 */
const DEFAULTS = {
  /** Number of recent samples to use for ETA calculation */
  rollingWindowSize: 20,
  /** Minimum samples before showing ETA */
  minSamplesForETA: 3,
  /** Update notification every N items (0 = every item) */
  notificationUpdateInterval: 10,
  /** Minimum time between notification updates (ms) */
  minNotificationIntervalMs: 200
};

// =============================================================================
// PROGRESS TRACKER CLASS
// =============================================================================

/**
 * Detailed progress tracker for long-running operations
 *
 * Provides accurate ETA estimates using a rolling average of recent item
 * processing times, avoiding skew from initial warmup or outliers.
 *
 * @example
 * const tracker = new ProgressTracker({
 *   totalItems: 20000,
 *   phases: ['Loading', 'Computing', 'Finalizing'],
 *   title: 'Differential Expression',
 *   onUpdate: (progress) => console.log(progress)
 * });
 *
 * tracker.start();
 * for (const gene of genes) {
 *   await processGene(gene);
 *   tracker.itemComplete();
 * }
 * tracker.nextPhase();
 * tracker.complete('Analysis finished');
 */
export class ProgressTracker {
  /**
   * Create a new ProgressTracker
   *
   * @param {Object} options
   * @param {number} options.totalItems - Total number of items to process
   * @param {string[]} [options.phases=['Processing']] - Names of processing phases
   * @param {string} [options.title='Processing'] - Title for notifications
   * @param {string} [options.category='calculation'] - Notification category
   * @param {boolean} [options.showNotification=true] - Show notification center updates
   * @param {Function} [options.onUpdate] - Callback for progress updates
   * @param {Function} [options.onPhaseChange] - Callback for phase changes
   * @param {Function} [options.onComplete] - Callback when complete
   * @param {AbortSignal} [options.signal] - AbortSignal for cancellation
   */
  constructor(options) {
    const {
      totalItems,
      phases = ['Processing'],
      title = 'Processing',
      category = 'calculation',
      showNotification = true,
      onUpdate,
      onPhaseChange,
      onComplete,
      signal
    } = options;

    /** @type {number} Total items to process */
    this.totalItems = totalItems;

    /** @type {string[]} Phase names */
    this.phases = phases;

    /** @type {string} Title for notifications */
    this.title = title;

    /** @type {string} Notification category */
    this.category = category;

    /** @type {boolean} Whether to show notification */
    this.showNotification = showNotification;

    /** @type {Function|null} Update callback */
    this.onUpdate = onUpdate || null;

    /** @type {Function|null} Phase change callback */
    this.onPhaseChange = onPhaseChange || null;

    /** @type {Function|null} Completion callback */
    this.onComplete = onComplete || null;

    /** @type {AbortSignal|null} Abort signal */
    this.signal = signal || null;

    // Internal state
    /** @type {number|null} Start timestamp */
    this._startTime = null;

    /** @type {number} Current phase index */
    this._phaseIndex = 0;

    /** @type {number} Completed items count */
    this._completedItems = 0;

    /** @type {number[]} Rolling window of completion timestamps */
    this._completionTimes = [];

    /** @type {string|null} Notification ID */
    this._notificationId = null;

    /** @type {Object|null} Notification center reference */
    this._notifications = null;

    /** @type {number} Last notification update time */
    this._lastNotificationUpdate = 0;

    /** @type {boolean} Whether tracking has started */
    this._started = false;

    /** @type {boolean} Whether tracking is complete */
    this._completed = false;

    /** @type {boolean} Whether tracking was cancelled */
    this._cancelled = false;

    /** @type {Function|null} Abort handler reference for cleanup */
    this._abortHandler = null;

    // Configuration
    /** @type {number} Rolling window size for ETA */
    this._rollingWindowSize = DEFAULTS.rollingWindowSize;

    /** @type {number} Minimum samples for ETA */
    this._minSamplesForETA = DEFAULTS.minSamplesForETA;

    /** @type {number} Notification update interval */
    this._notificationUpdateInterval = DEFAULTS.notificationUpdateInterval;

    /** @type {number} Minimum notification interval (ms) */
    this._minNotificationIntervalMs = DEFAULTS.minNotificationIntervalMs;
  }

  // ===========================================================================
  // PUBLIC API
  // ===========================================================================

  /**
   * Start tracking progress
   * @returns {ProgressTracker} this (for chaining)
   */
  start() {
    if (this._started) return this;

    this._started = true;
    this._startTime = performance.now();

    // Set up abort signal listener
    if (this.signal) {
      this._abortHandler = () => this._handleAbort();
      this.signal.addEventListener('abort', this._abortHandler, { once: true });
    }

    // Show initial notification
    if (this.showNotification) {
      this._initNotification();
    }

    this._reportUpdate();
    return this;
  }

  /**
   * Mark an item as complete
   * @param {number} [count=1] - Number of items completed (for batch updates)
   * @returns {ProgressTracker} this (for chaining)
   */
  itemComplete(count = 1) {
    if (this._completed || this._cancelled) return this;

    const now = performance.now();

    // Update completion times for ETA calculation
    for (let i = 0; i < count; i++) {
      this._completionTimes.push(now);
      if (this._completionTimes.length > this._rollingWindowSize) {
        this._completionTimes.shift();
      }
    }

    this._completedItems += count;
    this._reportUpdate();

    return this;
  }

  /**
   * Set the absolute completed item count.
   * This is useful when progress is reported externally as (loaded/total).
   *
   * If the new value is lower than the current value, ETA is reset because the
   * rolling window no longer reflects monotonic progress.
   *
   * @param {number} completed
   * @returns {ProgressTracker} this
   */
  setCompletedItems(completed) {
    if (this._completed || this._cancelled) return this;

    const target = Math.max(0, Math.min(this.totalItems || 0, Math.floor(Number(completed) || 0)));
    const delta = target - this._completedItems;

    if (delta > 0) {
      return this.itemComplete(delta);
    }

    if (delta < 0) {
      this._completedItems = target;
      this._completionTimes = [];
      this._reportUpdate();
    }

    return this;
  }

  /**
   * Get the raw completed item count.
   * @returns {number}
   */
  getCompletedItems() {
    return this._completedItems;
  }

  /**
   * Advance to the next phase
   * @param {string} [customMessage] - Optional message override for this phase
   * @returns {ProgressTracker} this (for chaining)
   */
  nextPhase(customMessage) {
    if (this._completed || this._cancelled) return this;

    this._phaseIndex++;

    if (this.onPhaseChange) {
      this.onPhaseChange({
        phase: this.phases[this._phaseIndex] || 'Unknown',
        phaseIndex: this._phaseIndex,
        totalPhases: this.phases.length,
        customMessage
      });
    }

    this._reportUpdate(customMessage);
    return this;
  }

  /**
   * Set a custom message for the current phase
   * @param {string} message - Custom message
   * @returns {ProgressTracker} this (for chaining)
   */
  setMessage(message) {
    if (this._completed || this._cancelled) return this;
    this._reportUpdate(message);
    return this;
  }

  /**
   * Set the current phase by name.
   *
   * This is useful when progress is reported externally with explicit phase names
   * (e.g., controller emits { phase: 'Clustering', ... }) instead of calling
   * nextPhase() sequentially.
   *
   * If the provided phase name does not exist in `this.phases`, it is appended.
   *
   * @param {string} phaseName
   * @param {string} [customMessage]
   * @returns {ProgressTracker} this
   */
  setPhase(phaseName, customMessage) {
    if (this._completed || this._cancelled) return this;
    if (typeof phaseName !== 'string' || phaseName.trim().length === 0) return this;

    const name = phaseName.trim();
    let idx = this.phases.indexOf(name);
    if (idx < 0) {
      this.phases.push(name);
      idx = this.phases.length - 1;
    }

    if (idx !== this._phaseIndex) {
      this._phaseIndex = idx;
      if (this.onPhaseChange) {
        this.onPhaseChange({
          phase: this.phases[this._phaseIndex] || 'Unknown',
          phaseIndex: this._phaseIndex,
          totalPhases: this.phases.length,
          customMessage
        });
      }
    }

    this._reportUpdate(customMessage);
    return this;
  }

  /**
   * Update the total items count (if it changed during processing)
   * @param {number} newTotal - New total
   * @returns {ProgressTracker} this (for chaining)
   */
  setTotalItems(newTotal) {
    this.totalItems = newTotal;
    this._reportUpdate();
    return this;
  }

  /**
   * Mark tracking as complete
   * @param {string} [message] - Optional completion message
   * @returns {Object} Final statistics
   */
  complete(message) {
    if (this._completed) return this.getStats();

    this._completed = true;
    this._cleanupAbortListener();

    const stats = this.getStats();

    // Update notification
    if (this._notificationId && this._notifications) {
      this._notifications.complete(
        this._notificationId,
        message || `${this.title} complete (${this._formatDuration(stats.elapsedMs)})`
      );
    }

    if (this.onComplete) {
      this.onComplete(stats);
    }

    return stats;
  }

  /**
   * Mark tracking as failed
   * @param {string} errorMessage - Error message
   * @returns {Object} Final statistics
   */
  fail(errorMessage) {
    this._completed = true;
    this._cleanupAbortListener();

    const stats = this.getStats();
    stats.error = errorMessage;

    if (this._notificationId && this._notifications) {
      this._notifications.fail(this._notificationId, errorMessage);
    }

    return stats;
  }

  /**
   * Cancel tracking
   * @returns {Object} Final statistics
   */
  cancel() {
    if (this._completed || this._cancelled) return this.getStats();

    this._cancelled = true;
    this._cleanupAbortListener();

    if (this._notificationId && this._notifications) {
      this._notifications.dismiss(this._notificationId);
    }

    return this.getStats();
  }

  /**
   * Get current progress statistics
   * @returns {Object} Progress statistics
   */
  getStats() {
    const now = performance.now();
    const elapsedMs = this._startTime ? now - this._startTime : 0;
    const progress = this.totalItems > 0
      ? Math.round((this._completedItems / this.totalItems) * 100)
      : 0;

    // Calculate ETA from rolling window
    let etaMs = null;
    let throughputPerSecond = null;

    if (this._completionTimes.length >= this._minSamplesForETA) {
      const windowDuration = this._completionTimes[this._completionTimes.length - 1] -
        this._completionTimes[0];
      const windowItems = this._completionTimes.length - 1;

      if (windowDuration > 0 && windowItems > 0) {
        const msPerItem = windowDuration / windowItems;
        const remaining = this.totalItems - this._completedItems;
        etaMs = msPerItem * remaining;
        throughputPerSecond = Math.round((1000 / msPerItem) * 10) / 10;
      }
    }

    return {
      // Progress metrics
      phase: this.phases[this._phaseIndex] || 'Unknown',
      phaseIndex: this._phaseIndex,
      totalPhases: this.phases.length,
      progress,
      completed: this._completedItems,
      completedItems: this._completedItems,
      total: this.totalItems,
      remaining: this.totalItems - this._completedItems,

      // Time metrics
      elapsedMs,
      elapsedFormatted: this._formatDuration(elapsedMs),
      etaMs,
      etaFormatted: etaMs !== null ? this._formatDuration(etaMs) : null,

      // Throughput
      throughputPerSecond,
      throughputFormatted: throughputPerSecond !== null
        ? `${throughputPerSecond}/s`
        : null,

      // Status
      started: this._started,
      isComplete: this._completed,
      cancelled: this._cancelled,
      percentComplete: progress
    };
  }

  /**
   * Check if tracking is still active
   * @returns {boolean}
   */
  isActive() {
    return this._started && !this._completed && !this._cancelled;
  }

  // ===========================================================================
  // PRIVATE METHODS
  // ===========================================================================

  /**
   * Initialize notification
   * @private
   */
  _initNotification() {
    try {
      this._notifications = getNotificationCenter();
      this._notificationId = this._notifications.show({
        type: 'progress',
        category: this.category,
        title: this.title,
        message: `${this.phases[0]}...`,
        progress: 0
      });
    } catch (e) {
      console.warn('[ProgressTracker] Failed to initialize notification:', e);
      this._notifications = null;
    }
  }

  /**
   * Report progress update
   * @param {string} [customMessage] - Optional custom message
   * @private
   */
  _reportUpdate(customMessage) {
    const stats = this.getStats();
    const now = performance.now();

    // Callback update (always)
    if (this.onUpdate) {
      this.onUpdate(stats);
    }

    // Notification update (throttled)
    const shouldUpdateNotification =
      this._notificationId &&
      this._notifications &&
      (now - this._lastNotificationUpdate >= this._minNotificationIntervalMs) &&
      (this._completedItems === 0 ||
        this._completedItems % this._notificationUpdateInterval === 0 ||
        customMessage);

    if (shouldUpdateNotification) {
      this._lastNotificationUpdate = now;

      // Build message
      let message = customMessage || `${stats.phase}`;
      if (stats.completed > 0) {
        message = `${stats.completed.toLocaleString()}/${stats.total.toLocaleString()}`;
        if (stats.etaFormatted) {
          message += ` (ETA: ${stats.etaFormatted})`;
        }
      }

      this._notifications.updateProgress(this._notificationId, stats.progress, {
        message
      });
    }
  }

  /**
   * Handle abort signal
   * @private
   */
  _handleAbort() {
    if (this._completed || this._cancelled) return;

    this._cancelled = true;
    this._cleanupAbortListener();

    if (this._notificationId && this._notifications) {
      this._notifications.fail(this._notificationId, 'Operation cancelled');
    }
  }

  _cleanupAbortListener() {
    if (this.signal && this._abortHandler) {
      this.signal.removeEventListener('abort', this._abortHandler);
      this._abortHandler = null;
    }
  }

  /**
   * Format duration in human-readable form
   * @param {number} ms - Duration in milliseconds
   * @returns {string}
   * @private
   */
  _formatDuration(ms) {
    if (ms < 1000) return `${Math.round(ms)}ms`;

    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;

    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (minutes < 60) return `${minutes}m ${secs}s`;

    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
  }
}

// =============================================================================
// SIMPLE PROGRESS HELPER
// =============================================================================

/**
 * Create a simple progress tracker for common use cases
 *
 * @param {Object} options
 * @param {number} options.total - Total items
 * @param {string} [options.title='Processing'] - Title
 * @param {Function} [options.onProgress] - Progress callback (0-100)
 * @returns {Object} Simple progress API
 *
 * @example
 * const progress = createSimpleProgress({ total: 100, title: 'Loading' });
 * progress.start();
 * for (let i = 0; i < 100; i++) {
 *   await doWork();
 *   progress.increment();
 * }
 * progress.done('Loaded 100 items');
 */
export function createSimpleProgress(options) {
  const { total, title = 'Processing', onProgress } = options;

  const tracker = new ProgressTracker({
    totalItems: total,
    title,
    onUpdate: onProgress ? (stats) => onProgress(stats.progress) : null
  });

  return {
    start: () => tracker.start(),
    increment: (count = 1) => tracker.itemComplete(count),
    setProgress: (completed) => {
      tracker.setCompletedItems(completed);
    },
    done: (message) => tracker.complete(message),
    fail: (error) => tracker.fail(error),
    cancel: () => tracker.cancel(),
    getStats: () => tracker.getStats()
  };
}

// =============================================================================
// BATCH PROGRESS HELPER
// =============================================================================

/**
 * Create a progress tracker optimized for batch processing
 *
 * @param {Object} options
 * @param {number} options.totalItems - Total items
 * @param {number} options.batchSize - Items per batch
 * @param {string} [options.title='Batch Processing'] - Title
 * @param {Function} [options.onBatchComplete] - Callback after each batch
 * @returns {Object} Batch progress API
 */
export function createBatchProgress(options) {
  const { totalItems, batchSize, title = 'Batch Processing', onBatchComplete } = options;

  const totalBatches = Math.ceil(totalItems / batchSize);
  let currentBatch = 0;

  const tracker = new ProgressTracker({
    totalItems,
    title,
    phases: [`Batch 1/${totalBatches}`]
  });

  return {
    start: () => tracker.start(),

    batchComplete: (itemsInBatch = batchSize) => {
      tracker.itemComplete(itemsInBatch);
      currentBatch++;

      if (onBatchComplete) {
        onBatchComplete({
          batch: currentBatch,
          totalBatches,
          itemsProcessed: tracker._completedItems,
          totalItems
        });
      }

      // Update phase name for next batch
      if (currentBatch < totalBatches) {
        tracker.phases[0] = `Batch ${currentBatch + 1}/${totalBatches}`;
      }
    },

    done: (message) => tracker.complete(message),
    fail: (error) => tracker.fail(error),
    getStats: () => ({
      ...tracker.getStats(),
      currentBatch,
      totalBatches,
      batchSize
    })
  };
}

// =============================================================================
// EXPORTS
// =============================================================================

export default ProgressTracker;
