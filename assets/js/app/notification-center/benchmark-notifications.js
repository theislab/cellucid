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

export const benchmarkNotificationMethods = {
  /**
   * Start a benchmark run notification.
   * @param {string} name
   * @param {object} [options]
   * @returns {string} Notification ID
   */
  startBenchmark(name, options = {}) {
    return this.show({
      type: NotificationType.LOADING,
      category: 'benchmark',
      title: 'Benchmark',
      message: name,
      ...options
    });
  },

  /**
   * Update benchmark progress.
   * @param {string} id
   * @param {number} progress
   * @param {string|null} [stage=null]
   */
  updateBenchmark(id, progress, stage = null) {
    this._updateNotification(id, {
      type: NotificationType.PROGRESS,
      progress,
      message: stage
    });
  },

  /**
   * Complete a benchmark with results.
   * @param {string} id
   * @param {{fps?: number, points?: number, duration?: number}} results
   */
  completeBenchmark(id, results) {
    const { fps, points, duration } = results || {};
    let message = '';
    if (fps !== undefined) {
      message = `${fps.toFixed(1)} FPS`;
      if (points) message += ` (${formatCompactNumber(points)} pts)`;
      if (duration) message += ` in ${formatDuration(duration)}`;
    } else if (duration) {
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
    const formattedCount = formatCompactNumber(pointCount) || String(pointCount || '');
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
    const message = copiedToClipboard ? 'Report copied to clipboard' : 'Report ready';
    this.complete(id, message);
  }
};

