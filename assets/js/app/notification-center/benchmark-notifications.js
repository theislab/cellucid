/**
 * @fileoverview Benchmark notifications mixin for NotificationCenter.
 *
 * These methods are specific to benchmark tooling and kept separate from the
 * core notification implementation.
 *
 * @module notification-center/benchmark-notifications
 */

import { NotificationType } from './constants.js';
import { formatDuration, formatCompactNumber } from './formatters.js';

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function requireFiniteNonNegative(value, name) {
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new TypeError(`${name} must be a finite non-negative number.`);
  }
  return value;
}

function requirePlainObject(value, name) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TypeError(`${name} must be a plain object.`);
  }
  return value;
}

export const benchmarkNotificationMethods = {
  /**
   * Start a benchmark run notification.
   * @param {string} name
   * @param {object} [options]
   * @returns {string} Notification ID
   */
  startBenchmark(name, options = {}) {
    requireNonEmptyString(name, 'Benchmark name');
    requirePlainObject(options, 'Benchmark notification options');
    if (
      Object.keys(options).some(key => key !== 'onCancel') ||
      (
        options.onCancel !== undefined &&
        options.onCancel !== null &&
        typeof options.onCancel !== 'function'
      )
    ) {
      throw new TypeError(
        'Benchmark notification options may contain only onCancel.'
      );
    }
    return this.show({
      ...options,
      type: NotificationType.LOADING,
      category: 'benchmark',
      title: 'Benchmark',
      message: name
    });
  },

  /**
   * Update benchmark progress.
   * @param {string} id
   * @param {number} progress
   * @param {string|null} [stage=null]
   */
  updateBenchmark(id, progress, stage = null) {
    requireNonEmptyString(id, 'Benchmark notification id');
    requireFiniteNonNegative(progress, 'Benchmark progress');
    if (progress > 100) {
      throw new RangeError('Benchmark progress cannot exceed 100.');
    }
    if (stage !== null) {
      requireNonEmptyString(stage, 'Benchmark stage');
    }
    const update = {
      type: NotificationType.PROGRESS,
      progress
    };
    if (stage !== null) {
      update.message = stage;
    }
    this._updateNotification(id, update);
  },

  /**
   * Complete a benchmark with results.
   * @param {string} id
   * @param {{fps?: number, points?: number, duration?: number}} results
   */
  completeBenchmark(id, results) {
    requireNonEmptyString(id, 'Benchmark notification id');
    requirePlainObject(results, 'Benchmark results');
    const keys = Object.keys(results);
    if (keys.some(key => !['duration', 'fps', 'points'].includes(key))) {
      throw new TypeError('Benchmark results contain an unknown field.');
    }
    const { fps, points, duration } = results;
    if (fps !== undefined) requireFiniteNonNegative(fps, 'Benchmark fps');
    if (points !== undefined) {
      requireFiniteNonNegative(points, 'Benchmark points');
      if (!Number.isSafeInteger(points)) {
        throw new TypeError('Benchmark points must be a safe integer.');
      }
    }
    if (duration !== undefined) {
      requireFiniteNonNegative(duration, 'Benchmark duration');
    }
    let message = '';
    if (fps !== undefined) {
      message = `${fps.toFixed(1)} FPS`;
      if (points !== undefined) {
        message += ` (${formatCompactNumber(points)} pts)`;
      }
      if (duration !== undefined) message += ` in ${formatDuration(duration)}`;
    } else if (duration !== undefined) {
      message = `Complete (${formatDuration(duration)})`;
    } else {
      message = 'Benchmark complete';
    }
    this.complete(id, message);
  },

  /**
   * Start data generation notification.
   * @param {string} pattern
   * @param {number} pointCount
   * @returns {string}
   */
  startDataGeneration(pattern, pointCount) {
    requireNonEmptyString(pattern, 'Data generation pattern');
    requireFiniteNonNegative(pointCount, 'Data generation point count');
    if (!Number.isSafeInteger(pointCount)) {
      throw new TypeError('Data generation point count must be a safe integer.');
    }
    const formattedCount = formatCompactNumber(pointCount);
    return this.show({
      type: NotificationType.LOADING,
      category: 'benchmark',
      title: 'Generating Data',
      message: `${formattedCount} points (${pattern})`
    });
  },

  /**
   * Complete data generation.
   * @param {string} id
   * @param {number} duration
   */
  completeDataGeneration(id, duration) {
    requireNonEmptyString(id, 'Data generation notification id');
    requireFiniteNonNegative(duration, 'Data generation duration');
    this.complete(id, `Data ready (${formatDuration(duration)})`);
  },

  /**
   * Start report generation notification.
   * @returns {string}
   */
  startReport() {
    return this.show({
      type: NotificationType.LOADING,
      category: 'benchmark',
      title: 'Generating Report',
      message: 'Collecting system information...'
    });
  },

  /**
   * Complete report generation notification.
   * @param {string} id
   * @param {boolean} [copiedToClipboard=false]
   */
  completeReport(id, copiedToClipboard = false) {
    requireNonEmptyString(id, 'Report notification id');
    if (typeof copiedToClipboard !== 'boolean') {
      throw new TypeError(
        'Report copiedToClipboard must be a boolean.'
      );
    }
    const message = copiedToClipboard ? 'Report copied to clipboard' : 'Report ready';
    this.complete(id, message);
  }
};
