/**
 * @fileoverview Download tracking mixin for NotificationCenter.
 *
 * Split out of the main NotificationCenter module to keep the core rendering
 * and lifecycle methods small and easy to maintain.
 *
 * @module notification-center/download-tracking
 */

import { NotificationType } from './constants.js';
import { formatBytes, formatDuration } from './formatters.js';

export const downloadTrackingMethods = {
  /**
   * Start tracking a download.
   * @param {string} name - Download name for display.
   * @param {number|null} [totalBytes=null] - Total size in bytes (optional).
   * @returns {string} Tracker ID
   */
  startDownload(name, totalBytes = null) {
    const id = this._generateId();

    const now = performance.now();
    const tracker = {
      name,
      totalBytes,
      loadedBytes: 0,
      startTime: now,
      lastTime: now,
      lastBytes: 0,
      speed: 0,
      notificationId: null
    };

    this.downloadTrackers.set(id, tracker);

    tracker.notificationId = this.show({
      id: `download-${id}`,
      type: totalBytes ? NotificationType.PROGRESS : NotificationType.LOADING,
      category: 'download',
      title: 'Downloading',
      message: name,
      progress: 0,
      speed: 0
    });

    return id;
  },

  /**
   * Update download progress.
   * @param {string} id - Tracker ID
   * @param {number} loadedBytes - Bytes loaded so far
   * @param {number|null} [totalBytes=null] - Total bytes (optional)
   */
  updateDownload(id, loadedBytes, totalBytes = null) {
    const tracker = this.downloadTrackers.get(id);
    if (!tracker) return;

    const now = performance.now();
    const timeDelta = now - tracker.lastTime;
    const bytesDelta = loadedBytes - tracker.lastBytes;

    // Calculate speed (smoothed). Update every ~100ms to avoid excessive DOM work.
    if (timeDelta > 100) {
      const instantSpeed = (bytesDelta / timeDelta) * 1000;
      tracker.speed = tracker.speed * 0.7 + instantSpeed * 0.3;
      tracker.lastTime = now;
      tracker.lastBytes = loadedBytes;
    }

    tracker.loadedBytes = loadedBytes;
    if (totalBytes !== null) tracker.totalBytes = totalBytes;

    const progress = tracker.totalBytes ? (loadedBytes / tracker.totalBytes) * 100 : null;

    this._updateNotification(`download-${id}`, {
      type: progress !== null ? NotificationType.PROGRESS : NotificationType.LOADING,
      progress,
      speed: tracker.speed,
      message: tracker.totalBytes
        ? `${tracker.name} (${formatBytes(loadedBytes)} / ${formatBytes(tracker.totalBytes)})`
        : `${tracker.name} (${formatBytes(loadedBytes)})`
    });
  },

  /**
   * Complete a download.
   * @param {string} id
   * @param {string|null} [message=null]
   */
  completeDownload(id, message = null) {
    const tracker = this.downloadTrackers.get(id);
    if (!tracker) return;

    const duration = performance.now() - tracker.startTime;
    const finalMessage = message || `${tracker.name} (${formatBytes(tracker.loadedBytes)} in ${formatDuration(duration)})`;

    this.complete(`download-${id}`, finalMessage);
    this.downloadTrackers.delete(id);
  },

  /**
   * Fail a download.
   * @param {string} id
   * @param {string} errorMessage
   */
  failDownload(id, errorMessage) {
    const tracker = this.downloadTrackers.get(id);
    if (!tracker) return;

    this.fail(`download-${id}`, `${tracker.name}: ${errorMessage}`);
    this.downloadTrackers.delete(id);
  }
};

