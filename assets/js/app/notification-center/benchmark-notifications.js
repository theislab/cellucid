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

export const benchmarkNotificationMethods = {
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
