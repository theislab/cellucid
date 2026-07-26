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

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function requireByteCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
}

function requireTracker(owner, id) {
  requireNonEmptyString(id, 'Download tracker id');
  const tracker = owner.downloadTrackers.get(id);
  if (tracker === undefined) {
    throw new RangeError(`Download tracker "${id}" does not exist.`);
  }
  return tracker;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export const downloadTrackingMethods = {
  /**
   * Start tracking a download.
   * @param {string} name - Download name for display.
   * @param {number|null} [totalBytes=null] - Total size in bytes (optional).
   * @param {{ onCancel?: (() => void) | null }} [options]
   * @returns {string} Tracker ID
   */
  startDownload(name, totalBytes = null, options = {}) {
    requireNonEmptyString(name, 'Download name');
    if (totalBytes !== null) {
      requireByteCount(totalBytes, 'Download totalBytes');
    }
    if (
      !isPlainObject(options) ||
      Object.keys(options).some(key => key !== 'onCancel')
    ) {
      throw new TypeError(
        'Download options must be a plain object containing only onCancel.'
      );
    }
    if (
      options.onCancel !== undefined &&
      options.onCancel !== null &&
      typeof options.onCancel !== 'function'
    ) {
      throw new TypeError('Download onCancel must be a function or null.');
    }
    const id = this._generateId();
    const onCancel = options.onCancel ?? null;

    const now = performance.now();
    const tracker = {
      name,
      totalBytes,
      loadedBytes: 0,
      startTime: now,
      lastTime: now,
      lastBytes: 0,
      speed: 0
    };

    const initialProgress = totalBytes === null
      ? null
      : totalBytes === 0
        ? 100
        : 0;
    this.show({
      id: `download-${id}`,
      type: totalBytes !== null
        ? NotificationType.PROGRESS
        : NotificationType.LOADING,
      category: 'download',
      title: 'Downloading',
      message: name,
      progress: initialProgress,
      speed: 0,
      onCancel
    });
    this.downloadTrackers.set(id, tracker);

    return id;
  },

  /**
   * Update download progress.
   * @param {string} id - Tracker ID
   * @param {number} loadedBytes - Bytes loaded so far
   * @param {number|null} [totalBytes=null] - Total bytes (optional)
   */
  updateDownload(id, loadedBytes, totalBytes = null) {
    const tracker = requireTracker(this, id);
    requireByteCount(loadedBytes, 'Download loadedBytes');
    if (loadedBytes < tracker.loadedBytes) {
      throw new RangeError(
        `Download loadedBytes cannot decrease from ${tracker.loadedBytes} to ${loadedBytes}.`
      );
    }
    if (totalBytes !== null) {
      requireByteCount(totalBytes, 'Download totalBytes');
      if (totalBytes < loadedBytes) {
        throw new RangeError(
          `Download loadedBytes ${loadedBytes} exceeds totalBytes ${totalBytes}.`
        );
      }
      if (tracker.totalBytes !== null && totalBytes !== tracker.totalBytes) {
        throw new RangeError(
          `Download totalBytes cannot change from ${tracker.totalBytes} to ${totalBytes}.`
        );
      }
    }
    const effectiveTotal = totalBytes ?? tracker.totalBytes;
    if (effectiveTotal !== null && loadedBytes > effectiveTotal) {
      throw new RangeError(
        `Download loadedBytes ${loadedBytes} exceeds totalBytes ${effectiveTotal}.`
      );
    }

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

    const progress = tracker.totalBytes === null
      ? null
      : tracker.totalBytes === 0
        ? 100
        : (loadedBytes / tracker.totalBytes) * 100;

    this._updateNotification(`download-${id}`, {
      type: progress !== null ? NotificationType.PROGRESS : NotificationType.LOADING,
      progress,
      speed: tracker.speed,
      message: tracker.totalBytes !== null
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
    const tracker = requireTracker(this, id);
    if (message !== null) {
      requireNonEmptyString(message, 'Download completion message');
    }

    const duration = performance.now() - tracker.startTime;
    const finalMessage = message ??
      `${tracker.name} (${formatBytes(tracker.loadedBytes)} in ${formatDuration(duration)})`;

    this.complete(`download-${id}`, finalMessage);
    this.downloadTrackers.delete(id);
  },

  /**
   * Fail a download.
   * @param {string} id
   * @param {string} errorMessage
   */
  failDownload(id, errorMessage) {
    const tracker = requireTracker(this, id);
    requireNonEmptyString(errorMessage, 'Download error message');

    this.fail(`download-${id}`, `${tracker.name}: ${errorMessage}`);
    this.downloadTrackers.delete(id);
  },

  /**
   * Remove an in-flight download without publishing a success or failure.
   * Used when a newer transaction supersedes the work represented by `id`.
   * @param {string} id
   */
  dismissDownload(id) {
    requireTracker(this, id);
    const dismissed = this.dismiss(`download-${id}`);
    if (!dismissed) {
      throw new Error(
        `Download tracker "${id}" has no owned notification.`
      );
    }
    this.downloadTrackers.delete(id);
    return true;
  }
};
