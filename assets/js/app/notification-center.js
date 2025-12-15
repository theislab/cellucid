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

// Singleton instance
let instance = null;

// Notification types
const NotificationType = {
  INFO: 'info',
  SUCCESS: 'success',
  ERROR: 'error',
  WARNING: 'warning',
  LOADING: 'loading',
  PROGRESS: 'progress'
};

// Category icons (using unicode for simplicity, no external dependencies)
// Use registerCategory() to add new categories dynamically
const CategoryIcons = {
  download: '↓',
  upload: '↑',
  calculation: '◐',
  spatial: '⊞',
  render: '◉',
  session: '⚙',
  data: '◈',
  connectivity: '⤲',
  filter: '⧩',
  highlight: '★',
  selection: '◇',
  lasso: '⌒',
  benchmark: '⏱',
  knn: '⋈',
  view: '◫',
  dimension: '⊡',
  default: '●'
};

/**
 * Format bytes to human-readable size
 */
function formatBytes(bytes, decimals = 1) {
  // Handle edge cases: zero, negative, or fractional bytes
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1) return bytes.toFixed(decimals) + ' B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  // Clamp index to valid range to prevent undefined access
  const i = Math.min(
    sizes.length - 1,
    Math.max(0, Math.floor(Math.log(bytes) / Math.log(k)))
  );
  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
}

/**
 * Format duration in ms to human-readable
 */
function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

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

    console.log('[NotificationCenter] Initialized');
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
      duration = null,
      dismissible = true
    } = options;

    const el = document.createElement('div');
    el.className = `notification notification-${type}`;
    el.id = id;
    el.dataset.type = type;

    // Icon
    const icon = CategoryIcons[category] || CategoryIcons.default;

    // Build content
    let html = `
      <div class="notification-icon">${icon}</div>
      <div class="notification-content">
        ${title ? `<div class="notification-title">${title}</div>` : ''}
        ${message ? `<div class="notification-message">${message}</div>` : ''}
    `;

    // Progress bar for loading/progress types
    if (type === NotificationType.PROGRESS || type === NotificationType.LOADING) {
      const progressValue = progress !== null ? progress : 0;
      const isIndeterminate = type === NotificationType.LOADING || progress === null;

      html += `
        <div class="notification-progress-container">
          <div class="notification-progress-bar ${isIndeterminate ? 'indeterminate' : ''}"
               style="width: ${isIndeterminate ? '100%' : progressValue + '%'}">
          </div>
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

    // Dismiss button
    if (dismissible && type !== NotificationType.LOADING && type !== NotificationType.PROGRESS) {
      html += '<button class="notification-dismiss" aria-label="Dismiss">×</button>';
    }

    el.innerHTML = html;

    // Add dismiss handler
    const dismissBtn = el.querySelector('.notification-dismiss');
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
      options,
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

        // Add dismiss button if not present
        if (!element.querySelector('.notification-dismiss')) {
          const dismissBtn = document.createElement('button');
          dismissBtn.className = 'notification-dismiss';
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
    Object.assign(notif.options, options);
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
  // Download tracking with speed calculation
  // =========================================================================

  /**
   * Start tracking a download
   * @param {string} name - Download name for display
   * @param {number} totalBytes - Total size in bytes (optional)
   * @returns {string} Tracker ID
   */
  startDownload(name, totalBytes = null) {
    const id = this._generateId();

    const tracker = {
      name,
      totalBytes,
      loadedBytes: 0,
      startTime: performance.now(),
      lastTime: performance.now(),
      lastBytes: 0,
      speed: 0,
      notificationId: null
    };

    this.downloadTrackers.set(id, tracker);

    // Create notification
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
  }

  /**
   * Update download progress
   * @param {string} id - Tracker ID
   * @param {number} loadedBytes - Bytes loaded so far
   * @param {number} totalBytes - Total bytes (optional, for when size becomes known)
   */
  updateDownload(id, loadedBytes, totalBytes = null) {
    const tracker = this.downloadTrackers.get(id);
    if (!tracker) return;

    const now = performance.now();
    const timeDelta = now - tracker.lastTime;
    const bytesDelta = loadedBytes - tracker.lastBytes;

    // Calculate speed (smoothed)
    if (timeDelta > 100) { // Update speed every 100ms
      const instantSpeed = (bytesDelta / timeDelta) * 1000;
      tracker.speed = tracker.speed * 0.7 + instantSpeed * 0.3; // Exponential smoothing
      tracker.lastTime = now;
      tracker.lastBytes = loadedBytes;
    }

    tracker.loadedBytes = loadedBytes;
    if (totalBytes !== null) tracker.totalBytes = totalBytes;

    // Calculate progress
    const progress = tracker.totalBytes ? (loadedBytes / tracker.totalBytes) * 100 : null;

    // Update notification
    this._updateNotification(`download-${id}`, {
      type: progress !== null ? NotificationType.PROGRESS : NotificationType.LOADING,
      progress,
      speed: tracker.speed,
      message: tracker.totalBytes
        ? `${tracker.name} (${formatBytes(loadedBytes)} / ${formatBytes(tracker.totalBytes)})`
        : `${tracker.name} (${formatBytes(loadedBytes)})`
    });
  }

  /**
   * Complete a download
   */
  completeDownload(id, message = null) {
    const tracker = this.downloadTrackers.get(id);
    if (!tracker) return;

    const duration = performance.now() - tracker.startTime;
    const finalMessage = message || `${tracker.name} (${formatBytes(tracker.loadedBytes)} in ${formatDuration(duration)})`;

    this.complete(`download-${id}`, finalMessage);
    this.downloadTrackers.delete(id);
  }

  /**
   * Fail a download
   */
  failDownload(id, errorMessage) {
    const tracker = this.downloadTrackers.get(id);
    if (!tracker) return;

    this.fail(`download-${id}`, `${tracker.name}: ${errorMessage}`);
    this.downloadTrackers.delete(id);
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

  // =========================================================================
  // Benchmark-specific notifications
  // =========================================================================

  /**
   * Start a benchmark run notification
   * @param {string} name - Benchmark name (e.g., "1M points (clusters)")
   * @param {Object} options - Additional options
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
  }

  /**
   * Update benchmark progress
   * @param {string} id - Notification ID
   * @param {number} progress - Progress percentage (0-100)
   * @param {string} stage - Current stage description
   */
  updateBenchmark(id, progress, stage = null) {
    this._updateNotification(id, {
      type: NotificationType.PROGRESS,
      progress,
      message: stage
    });
  }

  /**
   * Complete a benchmark with results
   * @param {string} id - Notification ID
   * @param {Object} results - Benchmark results
   * @param {number} results.fps - Average FPS
   * @param {number} results.points - Number of points
   * @param {number} results.duration - Total duration in ms
   */
  completeBenchmark(id, results) {
    const { fps, points, duration } = results;
    let message = '';
    if (fps !== undefined) {
      message = `${fps.toFixed(1)} FPS`;
      if (points) message += ` (${formatNumber(points)} pts)`;
      if (duration) message += ` in ${formatDuration(duration)}`;
    } else if (duration) {
      message = `Complete (${formatDuration(duration)})`;
    } else {
      message = 'Benchmark complete';
    }
    this.complete(id, message);
  }

  /**
   * Start data generation notification
   * @param {string} pattern - Generation pattern (e.g., "clusters", "octopus")
   * @param {number} pointCount - Number of points
   * @returns {string} Notification ID
   */
  startDataGeneration(pattern, pointCount) {
    const formattedCount = typeof formatNumber === 'function'
      ? formatNumber(pointCount)
      : pointCount.toLocaleString();
    return this.show({
      type: NotificationType.LOADING,
      category: 'benchmark',
      title: 'Generating Data',
      message: `${formattedCount} points (${pattern})`
    });
  }

  /**
   * Complete data generation
   * @param {string} id - Notification ID
   * @param {number} duration - Generation time in ms
   */
  completeDataGeneration(id, duration) {
    this.complete(id, `Data ready (${formatDuration(duration)})`);
  }

  /**
   * Start report generation notification
   * @returns {string} Notification ID
   */
  startReport() {
    return this.show({
      type: NotificationType.LOADING,
      category: 'benchmark',
      title: 'Generating Report',
      message: 'Collecting system information...'
    });
  }

  /**
   * Complete report generation
   * @param {string} id - Notification ID
   * @param {boolean} copiedToClipboard - Whether copied to clipboard
   */
  completeReport(id, copiedToClipboard = false) {
    const message = copiedToClipboard
      ? 'Report copied to clipboard'
      : 'Report ready';
    this.complete(id, message);
  }
}

// Helper for formatting numbers (if not available from imports)
function formatNumber(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toString();
}

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
