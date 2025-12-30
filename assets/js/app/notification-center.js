/**
 * NotificationCenter - Centralized notification and status system for Cellucid
 *
 * Provides a professional, non-intrusive interface for:
 * - Data loading progress with download speed
 * - Calculation status (LOD, spatial index, smoke density)
 * - Success/error messages
 * - Session status updates
 *
 * Design principles:
 * - GPU-accelerated animations (transform, opacity only)
 * - Non-blocking - never slows down the main application
 * - Follows the newspaper-inspired design of the website
 * - Auto-dismissing with configurable duration
 */

import { debug } from '../utils/debug.js';
import { NotificationType, CategoryIcons } from './notification-center/constants.js';
import { formatBytes, formatDuration } from './notification-center/formatters.js';
import { downloadTrackingMethods } from './notification-center/download-tracking.js';
import { benchmarkNotificationMethods } from './notification-center/benchmark-notifications.js';
import { escapeHtml } from './utils/dom-utils.js';

// Singleton instance
let instance = null;

class NotificationCenter {
  constructor() {
    this.container = null;
    this.notifications = new Map();
    this.notificationId = 0;
    this.maxNotifications = 5;
    this.defaultDuration = 4000;
    this.initialized = false;

    // Track active downloads for speed calculation
    this.downloadTrackers = new Map();

    // Bind methods
    this.init = this.init.bind(this);
    this.show = this.show.bind(this);
    this.dismiss = this.dismiss.bind(this);
  }

  /**
   * Initialize the notification center
   * Creates the DOM container if it doesn't exist
   */
  init() {
    if (this.initialized) return;

    // Create container
    this.container = document.createElement('div');
    this.container.id = 'notification-center';
    this.container.className = 'notification-center';
    this.container.setAttribute('role', 'log');
    this.container.setAttribute('aria-live', 'polite');
    this.container.setAttribute('aria-label', 'Notifications');

    document.body.appendChild(this.container);
    this.initialized = true;

    debug.log('[NotificationCenter] Initialized');
  }

  /**
   * Generate unique notification ID
   */
  _generateId() {
    return `notif-${++this.notificationId}`;
  }

  /**
   * Create notification element
   */
  _createNotificationElement(id, options) {
    const {
      type = NotificationType.INFO,
      category = 'default',
      title,
      message,
      progress = null,
      speed = null,
      dismissible = true,
      onCancel = null
    } = options;

    const el = document.createElement('div');
    el.className = `notification notification-${type}`;
    el.id = id;
    el.dataset.type = type;

    // Icon
    const icon = CategoryIcons[category] || CategoryIcons.default;

    const safeTitle = title ? escapeHtml(String(title)) : '';
    const safeMessage = message ? escapeHtml(String(message)) : '';

    // Build content
    let html = `
      <div class="notification-icon">${icon}</div>
      <div class="notification-content">
        ${safeTitle ? `<div class="notification-title">${safeTitle}</div>` : ''}
        ${safeMessage ? `<div class="notification-message">${safeMessage}</div>` : ''}
    `;

    let progressBarWidth = '';

    // Progress bar for loading/progress types
    if (type === NotificationType.PROGRESS || type === NotificationType.LOADING) {
      const progressValue = progress !== null ? progress : 0;
      const isIndeterminate = type === NotificationType.LOADING || progress === null;
      progressBarWidth = isIndeterminate ? '' : `${progressValue}%`;

      html += `
        <div class="notification-progress-container">
          <div class="notification-progress-bar ${isIndeterminate ? 'indeterminate' : ''}"></div>
        </div>
      `;

      // Speed info for downloads
      if (speed !== null) {
        html += `<div class="notification-speed">${formatBytes(speed)}/s</div>`;
      } else if (progress !== null && !isIndeterminate) {
        html += `<div class="notification-progress-text">${Math.round(progress)}%</div>`;
      }
    }

    html += '</div>'; // Close notification-content

    const cancelable =
      typeof onCancel === 'function' &&
      (type === NotificationType.LOADING || type === NotificationType.PROGRESS);

    // Cancel (for progress/loading only) or dismiss (for others).
    if (cancelable) {
      html += '<button class="notification-dismiss" data-role="cancel" aria-label="Cancel" title="Cancel">×</button>';
    } else if (dismissible && type !== NotificationType.LOADING && type !== NotificationType.PROGRESS) {
      html += '<button class="notification-dismiss" data-role="dismiss" aria-label="Dismiss">×</button>';
    }

    el.innerHTML = html;

    if (progressBarWidth) {
      const progressBar = el.querySelector('.notification-progress-bar');
      if (progressBar) progressBar.style.width = progressBarWidth;
    }

    const cancelBtn = el.querySelector('.notification-dismiss[data-role="cancel"]');
    if (cancelBtn && typeof onCancel === 'function') {
      cancelBtn.addEventListener('click', () => {
        try {
          cancelBtn.disabled = true;
          cancelBtn.setAttribute('aria-disabled', 'true');
        } catch { /* ignore */ }
        try { onCancel(); } catch (err) {
          console.warn('[NotificationCenter] Cancel handler failed:', err);
        }
      });
    }

    const dismissBtn = el.querySelector('.notification-dismiss[data-role="dismiss"]');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => this.dismiss(id));
    }

    return el;
  }

  /**
   * Show a notification
   * @param {Object} options - Notification options
   * @returns {string} Notification ID for updates/dismissal
   */
  show(options) {
    if (!this.initialized) this.init();

    const id = options.id || this._generateId();
    const existingNotif = this.notifications.get(id);

    // Update existing notification
    if (existingNotif) {
      this._updateNotification(id, options);
      return id;
    }

    // Remove oldest if at max
    if (this.notifications.size >= this.maxNotifications) {
      const oldest = this.notifications.keys().next().value;
      this.dismiss(oldest);
    }

    // Create new notification
    const el = this._createNotificationElement(id, options);
    this.container.appendChild(el);

    // Store reference
    this.notifications.set(id, {
      element: el,
      options: { ...options },
      startTime: performance.now()
    });

    // Trigger enter animation
    requestAnimationFrame(() => {
      el.classList.add('notification-enter');
    });

    // Auto-dismiss for non-persistent types
    const duration = options.duration !== undefined ? options.duration : this.defaultDuration;
    if (duration && options.type !== NotificationType.LOADING && options.type !== NotificationType.PROGRESS) {
      setTimeout(() => this.dismiss(id), duration);
    }

    return id;
  }

  /**
   * Update an existing notification
   */
  _updateNotification(id, options) {
    const notif = this.notifications.get(id);
    if (!notif) return;

    const { element } = notif;

    // Update message
    if (options.message !== undefined) {
      const msgEl = element.querySelector('.notification-message');
      if (msgEl) msgEl.textContent = options.message;
    }

    // Update title
    if (options.title !== undefined) {
      const titleEl = element.querySelector('.notification-title');
      if (titleEl) titleEl.textContent = options.title;
    }

    // Update progress - only update bar when progress is a valid number
    // When progress is null (unknown total size), keep the indeterminate state
    if (options.progress !== undefined) {
      const progressBar = element.querySelector('.notification-progress-bar');
      if (progressBar) {
        if (options.progress !== null && typeof options.progress === 'number') {
          // Known progress: show determinate bar with percentage width
          progressBar.classList.remove('indeterminate');
          progressBar.style.width = options.progress + '%';
        } else {
          // Unknown progress (null): ensure indeterminate mode
          progressBar.classList.add('indeterminate');
          progressBar.style.width = '100%';
        }
      }
      const progressText = element.querySelector('.notification-progress-text');
      if (progressText) {
        if (options.progress !== null && typeof options.progress === 'number') {
          progressText.textContent = Math.round(options.progress) + '%';
        } else {
          // Hide percentage text when progress is unknown
          progressText.textContent = '';
        }
      }
    }

    // Update speed
    if (options.speed !== undefined) {
      let speedEl = element.querySelector('.notification-speed');
      if (!speedEl) {
        speedEl = document.createElement('div');
        speedEl.className = 'notification-speed';
        element.querySelector('.notification-content').appendChild(speedEl);
      }
      speedEl.textContent = formatBytes(options.speed) + '/s';
    }

    // Update type (e.g., loading -> success)
    if (options.type !== undefined && options.type !== notif.options.type) {
      element.className = `notification notification-${options.type} notification-enter`;
      element.dataset.type = options.type;
      notif.options.type = options.type;

      // Remove progress bar if switching to success/error
      if (options.type === NotificationType.SUCCESS || options.type === NotificationType.ERROR) {
        const progressContainer = element.querySelector('.notification-progress-container');
        if (progressContainer) progressContainer.remove();
        const speedEl = element.querySelector('.notification-speed');
        if (speedEl) speedEl.remove();
        const progressText = element.querySelector('.notification-progress-text');
        if (progressText) progressText.remove();

        // Replace "cancel" with a standard dismiss button.
        const existingBtn = element.querySelector('.notification-dismiss');
        if (existingBtn?.dataset?.role === 'cancel') {
          try { existingBtn.remove(); } catch { /* ignore */ }
        }

        // Add dismiss button if not present (completion/failure is always dismissible).
        if (!element.querySelector('.notification-dismiss')) {
          const dismissBtn = document.createElement('button');
          dismissBtn.className = 'notification-dismiss';
          dismissBtn.dataset.role = 'dismiss';
          dismissBtn.setAttribute('aria-label', 'Dismiss');
          dismissBtn.textContent = '×';
          dismissBtn.addEventListener('click', () => this.dismiss(id));
          element.appendChild(dismissBtn);
        }

        // Auto-dismiss
        const duration = options.duration || this.defaultDuration;
        setTimeout(() => this.dismiss(id), duration);
      }
    }

    // Update stored options
    notif.options = { ...notif.options, ...options };
  }

  /**
   * Dismiss a notification
   */
  dismiss(id) {
    const notif = this.notifications.get(id);
    if (!notif) return;

    const { element } = notif;

    // Trigger exit animation
    element.classList.remove('notification-enter');
    element.classList.add('notification-exit');

    // Remove after animation
    setTimeout(() => {
      if (element.parentNode) {
        element.parentNode.removeChild(element);
      }
      this.notifications.delete(id);
    }, 300);
  }

  /**
   * Dismiss all notifications
   */
  dismissAll() {
    for (const id of this.notifications.keys()) {
      this.dismiss(id);
    }
  }

  // =========================================================================
  // Convenience methods for common notification types
  // =========================================================================

  /**
   * Show info notification
   */
  info(message, options = {}) {
    return this.show({
      type: NotificationType.INFO,
      message,
      ...options
    });
  }

  /**
   * Show success notification
   */
  success(message, options = {}) {
    return this.show({
      type: NotificationType.SUCCESS,
      message,
      ...options
    });
  }

  /**
   * Show error notification
   */
  error(message, options = {}) {
    return this.show({
      type: NotificationType.ERROR,
      message,
      duration: 6000, // Errors stay longer
      ...options
    });
  }

  /**
   * Show warning notification
   */
  warning(message, options = {}) {
    return this.show({
      type: NotificationType.WARNING,
      message,
      duration: 5000,
      ...options
    });
  }

  /**
   * Start a loading notification (indeterminate progress)
   */
  loading(message, options = {}) {
    return this.show({
      type: NotificationType.LOADING,
      message,
      ...options
    });
  }

  /**
   * Start a progress notification
   */
  progress(message, progressValue = 0, options = {}) {
    return this.show({
      type: NotificationType.PROGRESS,
      message,
      progress: progressValue,
      ...options
    });
  }

  /**
   * Update progress on an existing notification
   */
  updateProgress(id, progressValue, options = {}) {
    this._updateNotification(id, {
      progress: progressValue,
      ...options
    });
  }

  /**
   * Complete a progress/loading notification with success
   */
  complete(id, message, options = {}) {
    this._updateNotification(id, {
      type: NotificationType.SUCCESS,
      message,
      ...options
    });
  }

  /**
   * Fail a progress/loading notification with error
   */
  fail(id, message, options = {}) {
    this._updateNotification(id, {
      type: NotificationType.ERROR,
      message,
      ...options
    });
  }

  // =========================================================================
  // Calculation tracking
  // =========================================================================

  /**
   * Start a calculation notification
   * @param {string} name - Calculation name
   * @param {string} category - Category for icon
   * @returns {string} Notification ID
   */
  startCalculation(name, category = 'calculation') {
    return this.show({
      type: NotificationType.LOADING,
      category,
      title: 'Processing',
      message: name
    });
  }

  /**
   * Complete a calculation
   */
  completeCalculation(id, message, duration = null) {
    const finalMessage = duration ? `${message} (${formatDuration(duration)})` : message;
    this.complete(id, finalMessage);
  }

  /**
   * Fail a calculation
   */
  failCalculation(id, errorMessage) {
    this.fail(id, errorMessage);
  }

  // =========================================================================
  // Extensibility
  // =========================================================================

  /**
   * Register a new category for notifications
   * Allows easy extension without modifying the core code
   * @param {string} category - Category name
   * @param {string} icon - Unicode icon character
   */
  registerCategory(category, icon) {
    CategoryIcons[category] = icon;
  }

  /**
   * Get all registered categories
   * @returns {Object} Map of category -> icon
   */
  getCategories() {
    return { ...CategoryIcons };
  }

  /**
   * Batch notification: show multiple related notifications efficiently
   * Useful when loading multiple files or performing parallel operations
   * @param {Array<Object>} items - Array of {name, operation} objects
   * @param {Function} operation - Async operation to perform for each item
   * @param {Object} options - Shared options
   * @returns {Promise<Array>} Results from all operations
   */
  async batch(items, operation, options = {}) {
    const { category = 'data', parallel = true } = options;
    const results = [];

    if (parallel) {
      const promises = items.map(async (item) => {
        const id = this.loading(`Processing ${item.name}...`, { category });
        try {
          const result = await operation(item);
          this.complete(id, `${item.name} complete`);
          return result;
        } catch (error) {
          this.fail(id, `${item.name}: ${error.message}`);
          throw error;
        }
      });
      return Promise.all(promises);
    }

    for (const item of items) {
      const id = this.loading(`Processing ${item.name}...`, { category });
      try {
        const result = await operation(item);
        this.complete(id, `${item.name} complete`);
        results.push(result);
      } catch (error) {
        this.fail(id, `${item.name}: ${error.message}`);
        throw error;
      }
    }

    return results;
  }
}

Object.assign(NotificationCenter.prototype, downloadTrackingMethods, benchmarkNotificationMethods);

// =========================================================================
// Singleton accessor
// =========================================================================

/**
 * Get the singleton NotificationCenter instance
 * @returns {NotificationCenter}
 */
export function getNotificationCenter() {
  if (!instance) {
    instance = new NotificationCenter();
  }
  return instance;
}

// Export types for external use
export { NotificationType, CategoryIcons };

// Export class for testing
export { NotificationCenter };
