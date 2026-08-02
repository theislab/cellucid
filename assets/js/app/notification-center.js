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
import {
  registerModalDocumentAuxiliary
} from './ui/components/modal-background-owner.js';

// Singleton instance
let instance = null;

const NOTIFICATION_TYPES = new Set(Object.values(NotificationType));
const ACTIVE_NOTIFICATION_TYPES = new Set([
  NotificationType.LOADING,
  NotificationType.PROGRESS
]);
const TERMINAL_NOTIFICATION_TYPES = new Set([
  NotificationType.SUCCESS,
  NotificationType.ERROR
]);
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * How long each type stays on screen when its publisher names no duration.
 *
 * The type decides, not the method that published it. `error()` and `fail()`
 * produce the identical ERROR notification, and used to give it 6000 ms and
 * 4000 ms purely because one wrote a literal and the other did not — so the
 * longest, most actionable messages the app produces, the ones routed through
 * `fail()`, got the shortest time to be read (CEL-0220).
 *
 * ERROR is 0: it stays until dismissed. An error names something the user has
 * to do about it, and a dismissed notification cannot be re-opened, so a timer
 * can only take the message away before it has been read. That is bounded, not
 * unbounded: an ERROR is not an active type, so `_evictNonActiveUntil` retires
 * the oldest one under capacity pressure exactly as it retires a success, and a
 * repeating failure can never publish more than `maxNotifications` at once.
 *
 * LOADING and PROGRESS are 0 because their work owns their lifecycle; `show()`
 * refuses to schedule a dismissal for them at all.
 */
const DEFAULT_DURATIONS_MS = Object.freeze({
  [NotificationType.INFO]: 4000,
  [NotificationType.SUCCESS]: 4000,
  [NotificationType.WARNING]: 5000,
  [NotificationType.ERROR]: 0,
  [NotificationType.LOADING]: 0,
  [NotificationType.PROGRESS]: 0
});

const NOTIFICATION_OPTION_KEYS = new Set([
  'category',
  'dismissible',
  'duration',
  'id',
  'message',
  'onCancel',
  'progress',
  'speed',
  'title',
  'type'
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function requireCategoryName(value, name) {
  requireNonEmptyString(value, name);
  if (!/^[a-z][a-z0-9-]*$/.test(value)) {
    throw new TypeError(
      `${name} must use lowercase letters, digits, and hyphens.`
    );
  }
  return value;
}

function requireFiniteRange(value, name, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(
      `${name} must be a finite number between ${minimum} and ${maximum}.`
    );
  }
  return value;
}

function assertNotificationOptions(options, { partial = false } = {}) {
  if (!isPlainObject(options)) {
    throw new TypeError('Notification options must be a plain object.');
  }
  for (const key of Object.keys(options)) {
    if (!NOTIFICATION_OPTION_KEYS.has(key)) {
      throw new TypeError(`Unknown notification option "${key}".`);
    }
  }
  if (Object.hasOwn(options, 'id')) {
    requireNonEmptyString(options.id, 'Notification id');
  }
  if (Object.hasOwn(options, 'type') && !NOTIFICATION_TYPES.has(options.type)) {
    throw new TypeError(`Unknown notification type "${options.type}".`);
  }
  if (Object.hasOwn(options, 'category')) {
    requireCategoryName(options.category, 'Notification category');
    if (!Object.hasOwn(CategoryIcons, options.category)) {
      throw new TypeError(
        `Unknown notification category "${options.category}". Register it before use.`
      );
    }
  }
  for (const key of ['title', 'message']) {
    if (Object.hasOwn(options, key) && typeof options[key] !== 'string') {
      throw new TypeError(`Notification ${key} must be a string.`);
    }
  }
  if (
    Object.hasOwn(options, 'progress') &&
    options.progress !== null
  ) {
    requireFiniteRange(options.progress, 'Notification progress', 0, 100);
  }
  if (Object.hasOwn(options, 'speed')) {
    requireFiniteRange(
      options.speed,
      'Notification speed',
      0,
      Number.MAX_SAFE_INTEGER
    );
  }
  if (
    Object.hasOwn(options, 'dismissible') &&
    typeof options.dismissible !== 'boolean'
  ) {
    throw new TypeError('Notification dismissible must be a boolean.');
  }
  if (
    Object.hasOwn(options, 'onCancel') &&
    options.onCancel !== null &&
    typeof options.onCancel !== 'function'
  ) {
    throw new TypeError('Notification onCancel must be a function or null.');
  }
  if (Object.hasOwn(options, 'duration')) {
    requireFiniteRange(
      options.duration,
      'Notification duration',
      0,
      MAX_TIMER_DELAY_MS
    );
  }

  if (!partial) {
    const type = options.type ?? NotificationType.INFO;
    if (
      (Object.hasOwn(options, 'progress') || Object.hasOwn(options, 'speed')) &&
      type !== NotificationType.LOADING &&
      type !== NotificationType.PROGRESS
    ) {
      throw new TypeError(
        'Notification progress and speed are only valid for loading or progress notifications.'
      );
    }
    if (
      options.onCancel !== undefined &&
      options.onCancel !== null &&
      type !== NotificationType.LOADING &&
      type !== NotificationType.PROGRESS
    ) {
      throw new TypeError(
        'Notification onCancel is only valid for loading or progress notifications.'
      );
    }
  }
}

function assertMethodOptions(options, methodName, reservedKeys) {
  assertNotificationOptions(options, { partial: true });
  for (const key of reservedKeys) {
    if (Object.hasOwn(options, key)) {
      throw new TypeError(
        `${methodName} options cannot replace the owned "${key}" field.`
      );
    }
  }
}

function describeThrownError(error) {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return 'the handler threw a non-Error value';
}

class NotificationCenter {
  constructor() {
    this.container = null;
    this.notifications = new Map();
    this.notificationId = 0;
    this.maxNotifications = 5;
    this.initialized = false;
    this._releaseModalAuxiliary = null;

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
    if (
      typeof document !== 'object' ||
      document === null ||
      typeof document.createElement !== 'function' ||
      document.body === null ||
      typeof document.body?.appendChild !== 'function'
    ) {
      throw new TypeError(
        'NotificationCenter requires a document with an appendable body.'
      );
    }

    // Create container
    this.container = document.createElement('div');
    this.container.id = 'notification-center';
    this.container.className = 'notification-center';
    this.container.setAttribute('role', 'log');
    this.container.setAttribute('aria-live', 'polite');
    this.container.setAttribute('aria-label', 'Notifications');

    document.body.appendChild(this.container);
    try {
      this._releaseModalAuxiliary =
        registerModalDocumentAuxiliary(this.container);
      this.initialized = true;
    } catch (error) {
      this.container.remove();
      this.container = null;
      this._releaseModalAuxiliary = null;
      throw error;
    }

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
    assertNotificationOptions(options);
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
    const icon = CategoryIcons[category];

    const safeTitle = title ? escapeHtml(title) : '';
    const safeMessage = message ? escapeHtml(message) : '';

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
      if (progressBar === null) {
        throw new Error('Notification progress bar was not created.');
      }
      progressBar.style.width = progressBarWidth;
    }

    const cancelBtn = el.querySelector('.notification-dismiss[data-role="cancel"]');
    if (cancelBtn !== null) {
      cancelBtn.addEventListener('click', () => {
        void this._runCancelHandler(cancelBtn, onCancel);
      });
    }

    const dismissBtn = el.querySelector('.notification-dismiss[data-role="dismiss"]');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => this.dismiss(id));
    }

    return el;
  }

  /**
   * Run a cancellation handler and publish its exact terminal outcome.
   * @param {HTMLButtonElement} cancelButton
   * @param {() => void|Promise<void>} onCancel
   * @returns {Promise<boolean>} true when cancellation was accepted
   */
  async _runCancelHandler(cancelButton, onCancel) {
    if (
      cancelButton === null ||
      typeof cancelButton !== 'object' ||
      typeof cancelButton.setAttribute !== 'function' ||
      typeof cancelButton.removeAttribute !== 'function'
    ) {
      throw new TypeError('Cancel button must support DOM attributes.');
    }
    if (typeof onCancel !== 'function') {
      throw new TypeError('Cancel handler must be a function.');
    }

    cancelButton.disabled = true;
    cancelButton.setAttribute('aria-disabled', 'true');

    try {
      await onCancel();
      return true;
    } catch (error) {
      cancelButton.disabled = false;
      cancelButton.removeAttribute('aria-disabled');
      this.error(`Cancel failed: ${describeThrownError(error)}`, {
        category: 'default',
        title: 'Cancellation Error'
      });
      return false;
    }
  }

  /**
   * Show a notification
   * @param {Object} options - Notification options
   * @returns {string} Notification ID for updates/dismissal
   */
  show(options) {
    assertNotificationOptions(options, { partial: true });
    if (!this.initialized) this.init();

    const id = options.id ?? this._generateId();
    const existingNotif = this.notifications.get(id);

    // Update existing notification
    if (existingNotif) {
      this._updateNotification(id, options);
      return id;
    }

    // Active loading/progress work owns its visible lifecycle. Make room by
    // retiring the oldest non-active item first; if every published item is
    // active, temporarily exceed the visual cap rather than orphan async IDs.
    this._evictNonActiveUntil(this.maxNotifications - 1);

    // Create new notification
    const el = this._createNotificationElement(id, options);
    this.container.appendChild(el);

    // Store reference
    const storedOptions = {
      ...options,
      type: options.type ?? NotificationType.INFO,
      category: options.category ?? 'default',
      dismissible: options.dismissible ?? true
    };
    const notification = {
      element: el,
      options: storedOptions,
      startTime: performance.now(),
      dismissTimer: null
    };
    this.notifications.set(id, notification);

    // Trigger enter animation
    requestAnimationFrame(() => {
      if (this.notifications.get(id) === notification) {
        el.classList.add('notification-enter');
      }
    });

    // Active work owns its own lifecycle; everything else gets the duration its
    // type declares unless the publisher named one. `_scheduleDismiss` treats 0
    // as "stays until dismissed", so the decision lives in exactly one place.
    if (!ACTIVE_NOTIFICATION_TYPES.has(storedOptions.type)) {
      this._scheduleDismiss(
        id,
        notification,
        options.duration ?? this._defaultDuration(storedOptions.type)
      );
    }

    return id;
  }

  /**
   * The published lifetime of one notification type.
   *
   * @param {string} type
   * @returns {number} milliseconds, or 0 for "stays until dismissed"
   */
  _defaultDuration(type) {
    const duration = DEFAULT_DURATIONS_MS[type];
    if (duration === undefined) {
      throw new TypeError(
        `Notification type "${type}" declares no default duration.`
      );
    }
    return duration;
  }

  /**
   * Update an existing notification
   */
  _updateNotification(id, options) {
    requireNonEmptyString(id, 'Notification id');
    assertNotificationOptions(options, { partial: true });
    const notif = this.notifications.get(id);
    if (!notif) {
      throw new RangeError(`Notification "${id}" does not exist.`);
    }
    if (Object.hasOwn(options, 'id') && options.id !== id) {
      throw new TypeError('Notification update id must equal its owner id.');
    }

    const currentType = notif.options.type;
    const nextType = options.type ?? currentType;
    const typeChanged = nextType !== currentType;
    if (
      typeChanged &&
      !(
        ACTIVE_NOTIFICATION_TYPES.has(currentType) &&
        (
          ACTIVE_NOTIFICATION_TYPES.has(nextType) ||
          TERMINAL_NOTIFICATION_TYPES.has(nextType)
        )
      )
    ) {
      throw new Error(
        `Notification type cannot transition from "${currentType}" to "${nextType}".`
      );
    }
    if (
      (
        Object.hasOwn(options, 'progress') ||
        Object.hasOwn(options, 'speed') ||
        (
          Object.hasOwn(options, 'onCancel') &&
          options.onCancel !== null
        )
      ) &&
      !ACTIVE_NOTIFICATION_TYPES.has(nextType)
    ) {
      throw new TypeError(
        'Notification progress, speed, and cancellation require an active notification type.'
      );
    }
    for (const key of ['dismissible', 'onCancel']) {
      if (
        Object.hasOwn(options, key) &&
        options[key] !== notif.options[key]
      ) {
        throw new TypeError(
          `Notification updates cannot replace the "${key}" owner.`
        );
      }
    }

    const { element } = notif;

    if (
      Object.hasOwn(options, 'category') &&
      options.category !== notif.options.category
    ) {
      const iconElement = element.querySelector('.notification-icon');
      if (iconElement === null) {
        throw new Error(`Notification "${id}" has no icon element.`);
      }
      iconElement.textContent = CategoryIcons[options.category];
    }

    // Update message
    if (options.message !== undefined) {
      let msgEl = element.querySelector('.notification-message');
      if (msgEl === null) {
        msgEl = document.createElement('div');
        msgEl.className = 'notification-message';
        const content = element.querySelector('.notification-content');
        if (content === null) {
          throw new Error(`Notification "${id}" has no content element.`);
        }
        content.appendChild(msgEl);
      }
      msgEl.textContent = options.message;
    }

    // Update title
    if (options.title !== undefined) {
      let titleEl = element.querySelector('.notification-title');
      if (titleEl === null) {
        titleEl = document.createElement('div');
        titleEl.className = 'notification-title';
        const content = element.querySelector('.notification-content');
        if (content === null) {
          throw new Error(`Notification "${id}" has no content element.`);
        }
        content.prepend(titleEl);
      }
      titleEl.textContent = options.title;
    }

    // Update progress - only update bar when progress is a valid number
    // When progress is null (unknown total size), keep the indeterminate state
    if (options.progress !== undefined) {
      const progressBar = element.querySelector('.notification-progress-bar');
      if (progressBar === null) {
        throw new Error(
          `Notification "${id}" cannot publish progress because it has no progress bar.`
        );
      }
      if (options.progress !== null) {
        // Known progress: show determinate bar with percentage width
        progressBar.classList.remove('indeterminate');
        progressBar.style.width = options.progress + '%';
      } else {
        // Unknown progress (null): ensure indeterminate mode
        progressBar.classList.add('indeterminate');
        progressBar.style.width = '100%';
      }
      const progressText = element.querySelector('.notification-progress-text');
      if (progressText) {
        if (options.progress !== null) {
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
        const content = element.querySelector('.notification-content');
        if (content === null) {
          throw new Error(`Notification "${id}" has no content element.`);
        }
        content.appendChild(speedEl);
      }
      speedEl.textContent = formatBytes(options.speed) + '/s';
    }

    // Update type (e.g., loading -> success)
    if (typeChanged) {
      element.className = `notification notification-${options.type} notification-enter`;
      element.dataset.type = options.type;

      // Remove progress bar if switching to success/error
      if (TERMINAL_NOTIFICATION_TYPES.has(options.type)) {
        const progressContainer = element.querySelector('.notification-progress-container');
        if (progressContainer) progressContainer.remove();
        const speedEl = element.querySelector('.notification-speed');
        if (speedEl) speedEl.remove();
        const progressText = element.querySelector('.notification-progress-text');
        if (progressText) progressText.remove();

        // Replace "cancel" with a standard dismiss button.
        const existingBtn = element.querySelector('.notification-dismiss');
        if (existingBtn?.dataset?.role === 'cancel') {
          existingBtn.remove();
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

        // Auto-dismiss on the same rule `show()` applies, so a failure reported
        // by completing a loading notification lives exactly as long as one
        // reported directly.
        this._scheduleDismiss(
          id,
          notif,
          options.duration ?? this._defaultDuration(nextType)
        );
      }
    } else if (
      TERMINAL_NOTIFICATION_TYPES.has(nextType) &&
      Object.hasOwn(options, 'duration')
    ) {
      this._scheduleDismiss(id, notif, options.duration);
    }

    // Update stored options
    const nextOptions = { ...notif.options, ...options };
    if (TERMINAL_NOTIFICATION_TYPES.has(nextType)) {
      delete nextOptions.progress;
      delete nextOptions.speed;
      delete nextOptions.onCancel;
      nextOptions.dismissible = true;
    }
    notif.options = nextOptions;
    if (TERMINAL_NOTIFICATION_TYPES.has(nextType)) {
      this._evictNonActiveUntil(this.maxNotifications);
    }
  }

  _evictNonActiveUntil(maximumSize) {
    if (!Number.isSafeInteger(maximumSize) || maximumSize < 0) {
      throw new RangeError(
        'Notification capacity target must be a non-negative safe integer.'
      );
    }
    while (this.notifications.size > maximumSize) {
      let candidateId = null;
      for (const [id, notification] of this.notifications) {
        if (!ACTIVE_NOTIFICATION_TYPES.has(notification.options.type)) {
          candidateId = id;
          break;
        }
      }
      if (candidateId === null) return;
      this.dismiss(candidateId);
    }
  }

  /**
   * Own the sole auto-dismiss timer for one notification generation.
   */
  _scheduleDismiss(id, notification, duration) {
    requireFiniteRange(
      duration,
      'Notification duration',
      0,
      MAX_TIMER_DELAY_MS
    );
    if (notification.dismissTimer !== null) {
      clearTimeout(notification.dismissTimer);
      notification.dismissTimer = null;
    }
    if (duration === 0) return;
    notification.dismissTimer = setTimeout(() => {
      notification.dismissTimer = null;
      if (this.notifications.get(id) === notification) {
        this.dismiss(id);
      }
    }, duration);
  }

  /**
   * Return whether this exact notification generation is still published.
   * Async producers use this instead of coupling to the internal Map because
   * capacity pressure and manual dismissal may retire progress IDs at any time.
   */
  hasNotification(id) {
    requireNonEmptyString(id, 'Notification id');
    return this.notifications.has(id);
  }

  /**
   * Dismiss a notification
   */
  dismiss(id) {
    requireNonEmptyString(id, 'Notification id');
    const notif = this.notifications.get(id);
    if (!notif) return false;

    const { element } = notif;
    this.notifications.delete(id);
    if (notif.dismissTimer !== null) {
      clearTimeout(notif.dismissTimer);
      notif.dismissTimer = null;
    }

    // Trigger exit animation
    element.removeAttribute('id');
    element.classList.remove('notification-enter');
    element.classList.add('notification-exit');

    // Remove after animation
    setTimeout(() => {
      if (element.parentNode) {
        element.parentNode.removeChild(element);
      }
    }, 300);
    return true;
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
    requireNonEmptyString(message, 'Info notification message');
    assertMethodOptions(options, 'info()', ['message', 'type']);
    return this.show({
      ...options,
      type: NotificationType.INFO,
      message
    });
  }

  /**
   * Show success notification
   */
  success(message, options = {}) {
    requireNonEmptyString(message, 'Success notification message');
    assertMethodOptions(options, 'success()', ['message', 'type']);
    return this.show({
      ...options,
      type: NotificationType.SUCCESS,
      message
    });
  }

  /**
   * Show error notification
   */
  error(message, options = {}) {
    requireNonEmptyString(message, 'Error notification message');
    assertMethodOptions(options, 'error()', ['message', 'type']);
    return this.show({
      ...options,
      type: NotificationType.ERROR,
      message
    });
  }

  /**
   * Show warning notification
   */
  warning(message, options = {}) {
    requireNonEmptyString(message, 'Warning notification message');
    assertMethodOptions(options, 'warning()', ['message', 'type']);
    return this.show({
      ...options,
      type: NotificationType.WARNING,
      message
    });
  }

  /**
   * Start a loading notification (indeterminate progress)
   */
  loading(message, options = {}) {
    requireNonEmptyString(message, 'Loading notification message');
    assertMethodOptions(options, 'loading()', ['message', 'type']);
    return this.show({
      ...options,
      type: NotificationType.LOADING,
      message
    });
  }

  /**
   * Start a progress notification
   */
  progress(message, progressValue = 0, options = {}) {
    requireNonEmptyString(message, 'Progress notification message');
    assertMethodOptions(
      options,
      'progress()',
      ['message', 'progress', 'type']
    );
    return this.show({
      ...options,
      type: NotificationType.PROGRESS,
      message,
      progress: progressValue
    });
  }

  /**
   * Update progress on an existing notification
   */
  updateProgress(id, progressValue, options = {}) {
    assertMethodOptions(
      options,
      'updateProgress()',
      ['id', 'progress', 'type']
    );
    this._updateNotification(id, {
      ...options,
      progress: progressValue
    });
  }

  /**
   * Complete a progress/loading notification with success
   */
  complete(id, message, options = {}) {
    requireNonEmptyString(message, 'Completion notification message');
    assertMethodOptions(
      options,
      'complete()',
      ['id', 'message', 'type']
    );
    this._updateNotification(id, {
      ...options,
      type: NotificationType.SUCCESS,
      message
    });
  }

  /**
   * Fail a progress/loading notification with error
   */
  fail(id, message, options = {}) {
    requireNonEmptyString(message, 'Failure notification message');
    assertMethodOptions(options, 'fail()', ['id', 'message', 'type']);
    this._updateNotification(id, {
      ...options,
      type: NotificationType.ERROR,
      message
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
    requireNonEmptyString(name, 'Calculation name');
    requireCategoryName(category, 'Calculation category');
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
    requireNonEmptyString(message, 'Calculation completion message');
    const finalMessage = duration !== null
      ? `${message} (${formatDuration(duration)})`
      : message;
    this.complete(id, finalMessage);
  }

  /**
   * Fail a calculation
   */
  failCalculation(id, errorMessage) {
    requireNonEmptyString(errorMessage, 'Calculation error message');
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
    requireCategoryName(category, 'Notification category');
    requireNonEmptyString(icon, 'Notification icon');
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
    if (!Array.isArray(items)) {
      throw new TypeError('Notification batch items must be an array.');
    }
    if (typeof operation !== 'function') {
      throw new TypeError('Notification batch operation must be a function.');
    }
    if (!isPlainObject(options)) {
      throw new TypeError('Notification batch options must be a plain object.');
    }
    for (const key of Object.keys(options)) {
      if (key !== 'category' && key !== 'parallel') {
        throw new TypeError(`Unknown notification batch option "${key}".`);
      }
    }
    const { category = 'data', parallel = true } = options;
    requireNonEmptyString(category, 'Notification batch category');
    if (!Object.hasOwn(CategoryIcons, category)) {
      throw new TypeError(
        `Unknown notification category "${category}". Register it before use.`
      );
    }
    if (typeof parallel !== 'boolean') {
      throw new TypeError('Notification batch parallel must be a boolean.');
    }
    for (const [index, item] of items.entries()) {
      if (!isPlainObject(item)) {
        throw new TypeError(`Notification batch item ${index} must be a plain object.`);
      }
      requireNonEmptyString(item.name, `Notification batch item ${index} name`);
    }
    const results = [];

    if (parallel) {
      const promises = items.map(async (item) => {
        const id = this.loading(`Processing ${item.name}...`, { category });
        try {
          const result = await operation(item);
          this.complete(id, `${item.name} complete`);
          return result;
        } catch (error) {
          this.fail(id, `${item.name}: ${describeThrownError(error)}`);
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
        this.fail(id, `${item.name}: ${describeThrownError(error)}`);
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
