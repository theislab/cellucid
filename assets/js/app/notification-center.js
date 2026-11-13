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
import { downloadTrackingMethods } from './notification-center/download-tracking.js';
import { benchmarkNotificationMethods } from './notification-center/benchmark-notifications.js';
import { escapeHtml } from './utils/dom-utils.js';
import { failureDetails, pointToDetails, sayFailure } from '../utils/errors.js';
import { keepAboveModals } from './ui/components/app-dialog.js';
import { isPlainRecord, requireKeys } from '../utils/exact-record.js';
import { formatBytes, formatDuration, formatPercent, countNoun } from '../utils/format-units.js';

/**
 * The one rule for work in progress: a loading or progress card appears only
 * once its work has run this long (about the longest wait that still feels
 * like the flow of using the app), and work that ends before then ends
 * without a card at all, the change on screen being its answer. A card the
 * person never saw is not followed by a success card either, unless its
 * publisher says the outcome is news the person asked for and cannot see
 * otherwise (`complete(id, message, { announce: true })`: a file saved, a
 * field created, a session file restored, a dataset opened over another). A
 * failure is always shown. Every
 * publisher of progress waits the same (`read-progress-notifications.js`,
 * `jobs/cancellable-job.js`).
 */
export const NOTICE_AFTER_MS = 1000;

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
 * produce the identical ERROR notification, so they give it the same time:
 * the longest, most actionable messages the app produces are the ones routed
 * through `fail()`, and need the longest time to be read.
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
  'action',
  'secondaryAction',
  'announce',
  'category',
  'details',
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
  requireKeys(options, [], NOTIFICATION_OPTION_KEYS, 'Notification options');
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
  for (const key of ['title', 'message', 'details']) {
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
  // A speed of null takes the shown speed away (a load that stopped reading bytes, `phaseDownload`).
  if (Object.hasOwn(options, 'speed') && options.speed !== null) {
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
  if (Object.hasOwn(options, 'announce') && typeof options.announce !== 'boolean') {
    throw new TypeError('Notification announce must be a boolean.');
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
    if (
      Object.hasOwn(options, 'action') &&
      ACTIVE_NOTIFICATION_TYPES.has(type)
    ) {
      throw new TypeError(
        'A notification action is only valid on a notification that is not in progress.'
      );
    }
  }
  for (const key of ['action', 'secondaryAction']) {
    if (!Object.hasOwn(options, key)) continue;
    const action = options[key];
    if (
      !isPlainRecord(action) ||
      Object.keys(action).sort().join(',') !== 'label,run' ||
      typeof action.label !== 'string' ||
      action.label.trim().length === 0 ||
      typeof action.run !== 'function'
    ) {
      throw new TypeError(
        'A notification action must be exactly { label, run } with a non-empty label.'
      );
    }
  }
  // The other choice beside an action ("Start fresh" beside "Continue"): never alone.
  if (Object.hasOwn(options, 'secondaryAction') && !Object.hasOwn(options, 'action')) {
    throw new TypeError('A notification secondary action stands beside an action.');
  }
}

/**
 * Options whose message says a broken invariant's sentence, given Details:
 * the sentence says its words are there (`utils/errors.js` `pointToDetails`).
 * A card without Details says the sentence alone.
 *
 * @param {object} options
 * @returns {object}
 */
function withDetailsPointer(options) {
  if (typeof options.message !== 'string' || typeof options.details !== 'string' || options.details === '') return options;
  const message = pointToDetails(options.message);
  return message === options.message ? options : { ...options, message };
}

/**
 * A notification's details: the technical text behind its message (the raw
 * error of a failure), folded so the message stays one short sentence.
 *
 * @param {string} details
 * @returns {string}
 */
function notificationDetailsHtml(details) {
  return '<details class="notification-details"><summary>Details</summary>'
    + `<div class="notification-details-text">${escapeHtml(details)}</div></details>`;
}

/**
 * What `show()` accepts for a notification it makes (not one it updates):
 * its options, and no `announce`, which names a completion
 * (`complete(id, message, { announce })`). A publisher's test doubles check
 * with it, so a notice the real center refuses is refused there too.
 *
 * @param {object} options
 */
export function assertNewNotificationOptions(options) {
  assertNotificationOptions(options, { partial: true });
  if (Object.hasOwn(options, 'announce')) {
    throw new TypeError('Notification announce names a completion: complete(id, message, { announce }).');
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

/**
 * Add `node` to a card's content above its buttons (its action, Cancel),
 * which stay last under what the card says.
 *
 * @param {HTMLElement} content - The card's `.notification-content`
 * @param {Node} node
 */
function appendAboveButtons(content, node) {
  content.insertBefore(node, content.querySelector(':scope > .notification-action, :scope > .notification-actions, :scope > [data-role="cancel"]'));
}

class NotificationCenter {
  constructor() {
    this.container = null;
    this.notifications = new Map();
    // Notifications dismissed (a person's ×, or their owner): a later update
    // or completion of one by the work that made it changes nothing, as the
    // person closed it; an id never made is still an error. A field read
    // completing its progress notice after it was dismissed must not fail, or
    // the dataset would open uncolored.
    this._dismissed = new Set();
    this.notificationId = 0;
    // Cards on screen at once: five, and two on a phone, where each covers
    // the foot of the plot (`init`). A card retired early to make room is kept
    // in `overflowMessages` and listed behind the "earlier messages" control,
    // so no message is lost to the cap.
    this.maxNotifications = 5;
    /** @type {Array<{ id: string, type: string, title: string|null, message: string|null, action: {label: string, run: () => void}|null, secondaryAction: {label: string, run: () => void}|null }>} */
    this.overflowMessages = [];
    this._overflowElement = null;
    this._overflowParts = null;
    this._overflowExpanded = false;
    this.initialized = false;
    this._releaseAboveModals = null;
    // The places of cards that have left, kept while the pointer is over the
    // stack (`_retire`), and whether it is (`_followPointer`).
    /** @type {Set<HTMLElement>} */
    this._keptPlaces = new Set();
    this._pointerOverStack = false;
    this._followingPointer = false;
    this._overflowWaiting = false;
    this._followPointer = this._followPointer.bind(this);

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
    this._publishStackBlockSize();
    this._holdStackUnderPointer();
    // The phone layout (layouts/_responsive.css: the sidebar a full-screen
    // sheet below 721 px) keeps two cards on screen.
    const phone = document.defaultView?.matchMedia?.('(max-width: 720px)') ?? null;
    if (phone !== null) {
      const fit = () => {
        this.maxNotifications = phone.matches ? 2 : 5;
        this._evictNonActiveUntil(this.maxNotifications);
      };
      fit();
      phone.addEventListener?.('change', fit);
    }
    try {
      // Over an open dialog the cards live inside it; outside it they would
      // be inert (`app-dialog.js`).
      this._releaseAboveModals = keepAboveModals(this.container);
      this.initialized = true;
    } catch (error) {
      this.container.remove();
      this.container = null;
      this._releaseAboveModals = null;
      throw error;
    }

    debug.log('[NotificationCenter] Initialized');
  }

  /**
   * Publish how far up from the bottom of the viewport the card stack reaches
   * as `--notification-stack-block-size` on the root. The phone menu pads its
   * scroll end by it, so its last controls can always be scrolled clear of
   * the cards (they let taps through, but a control under a card cannot be
   * seen). Padding only the scroll end moves nothing already on screen.
   *
   * The observer reports the first size itself, after the next layout. A
   * measurement here would force that layout inside startup; and
   * while the stack is empty it is 0 px, which the stylesheet's default
   * already is.
   */
  _publishStackBlockSize() {
    const View = document.defaultView;
    if (typeof View?.ResizeObserver !== 'function') return;
    const root = document.documentElement;
    const container = this.container;
    const publish = () => {
      const box = container.getBoundingClientRect();
      const covered = box.height > 0
        ? Math.max(0, View.innerHeight - box.top)
        : 0;
      root.style.setProperty(
        '--notification-stack-block-size',
        `${Math.ceil(covered)}px`
      );
    };
    new View.ResizeObserver(publish).observe(container);
  }

  /**
   * Keep the cards still on screen where they are while the pointer is over
   * the stack. The stack stands on the bottom edge, so a card leaving lets
   * every card above it fall by its height: a person aiming at a card's
   * Dismiss as another card left (an expiry, a dismissal, a card retired to
   * make room) would have the button move from under the pointer between
   * press and release, and the click would land on the plot behind it
   * (`empty-dataset-state.spec.mjs`). A card that has left keeps its place,
   * empty, until the pointer leaves the stack's area, gaps between cards
   * included; then the stack
   * closes up at once. A tap holds it until the next press elsewhere. The
   * earlier-messages control under the stack waits the same way
   * (`_evictNonActiveUntil`).
   */
  _holdStackUnderPointer() {
    this.container.addEventListener('pointerenter', () => {
      this._pointerOverStack = true;
      this._stopFollowingPointer();
    });
    // The stack lets the pointer through between its cards (pointer-events:
    // none), so leaving a card is not yet leaving the stack.
    this.container.addEventListener('pointerleave', event => {
      this._pointerOverStack = false;
      this._followPointer(event);
    });
  }

  /** Whether `event`'s point is in the stack's area; the kept places go once it is not. */
  _followPointer(event) {
    if (this._pointerOverStack) return;
    const box = this.container.getBoundingClientRect();
    const inside = event.type !== 'blur'
      && event.clientX >= box.left && event.clientX <= box.right
      && event.clientY >= box.top && event.clientY <= box.bottom;
    if (inside) {
      if (!this._followingPointer) {
        this._followingPointer = true;
        for (const type of ['pointermove', 'pointerdown']) {
          document.addEventListener(type, this._followPointer, { capture: true, passive: true });
        }
        document.defaultView?.addEventListener('blur', this._followPointer);
      }
      return;
    }
    this._stopFollowingPointer();
    for (const spacer of this._keptPlaces) spacer.remove();
    this._keptPlaces.clear();
    if (this._overflowWaiting) this._renderOverflow();
  }

  _stopFollowingPointer() {
    if (!this._followingPointer) return;
    this._followingPointer = false;
    for (const type of ['pointermove', 'pointerdown']) {
      document.removeEventListener(type, this._followPointer, { capture: true });
    }
    document.defaultView?.removeEventListener('blur', this._followPointer);
  }

  /**
   * Take a card that has finished leaving off the stack. While the pointer is
   * over the stack an empty spacer of the card's size takes its place
   * (`_holdStackUnderPointer`): its size too, since the stack is as wide as
   * its widest card and a narrower stack would reflow the others.
   */
  _retire(element) {
    if (element.parentNode === null) return;
    if (this._pointerOverStack || this._followingPointer) {
      const { width, height } = element.getBoundingClientRect();
      const spacer = document.createElement('div');
      spacer.className = 'notification-spacer';
      spacer.setAttribute('aria-hidden', 'true');
      spacer.style.inlineSize = `${width}px`;
      spacer.style.blockSize = `${height}px`;
      element.replaceWith(spacer);
      this._keptPlaces.add(spacer);
      return;
    }
    element.remove();
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
      onCancel = null,
      action = null,
      secondaryAction = null,
      details = ''
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

    // The technical text behind a short message, folded under it.
    if (details !== '') html += notificationDetailsHtml(details);

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
        html += `<div class="notification-progress-text">${formatPercent(progress)}</div>`;
      }
    }

    if (action !== null && secondaryAction !== null) {
      // Two choices side by side: the action, then the other one.
      html += '<div class="notification-actions">'
        + `<button type="button" class="btn btn-compact notification-action">${escapeHtml(action.label)}</button>`
        + `<button type="button" class="btn btn-compact notification-secondary-action">${escapeHtml(secondaryAction.label)}</button>`
        + '</div>';
    } else if (action !== null) {
      html += `<button type="button" class="btn btn-compact notification-action">${escapeHtml(action.label)}</button>`;
    }

    const cancelable =
      typeof onCancel === 'function' &&
      (type === NotificationType.LOADING || type === NotificationType.PROGRESS);

    // Work under way that can be stopped says so in words: its card and the
    // texts that point at it ("Cancel stops it") name the button Cancel.
    if (cancelable) {
      html += '<button type="button" class="btn btn-compact notification-cancel" data-role="cancel">Cancel</button>';
    }

    html += '</div>'; // Close notification-content

    // A settled card is dismissed (×); work under way never is.
    if (!cancelable && dismissible && type !== NotificationType.LOADING && type !== NotificationType.PROGRESS) {
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

    const cancelBtn = el.querySelector('[data-role="cancel"]');
    if (cancelBtn !== null) {
      cancelBtn.addEventListener('click', () => {
        void this._runCancelHandler(cancelBtn, onCancel);
      });
    }

    const dismissBtn = el.querySelector('.notification-dismiss[data-role="dismiss"]');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => this.dismiss(id));
    }

    // The action is the notification's one follow-up; taking it settles it.
    const actionBtn = el.querySelector('.notification-action');
    if (actionBtn !== null) {
      actionBtn.addEventListener('click', () => {
        this.dismiss(id);
        action.run();
      });
    }
    const secondaryBtn = el.querySelector('.notification-secondary-action');
    if (secondaryBtn !== null) {
      secondaryBtn.addEventListener('click', () => {
        this.dismiss(id);
        secondaryAction.run();
      });
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
      this.error(`Cancel failed: ${sayFailure(error)}`, {
        category: 'default',
        ...failureDetails(error),
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
    options = withDetailsPointer(options);
    if (!this.initialized) this.init();

    const id = options.id ?? this._generateId();
    const existingNotif = this.notifications.get(id);

    // Update existing notification
    if (existingNotif) {
      this._updateNotification(id, options);
      return id;
    }
    assertNewNotificationOptions(options);

    // Room is made when a card comes on screen (`_reveal`), not when it is
    // published: work in progress is held back (NOTICE_AFTER_MS) and most of
    // it ends unseen, so it must not retire a card the person is reading.

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
      dismissTimer: null,
      // Work in progress is held back until it has run NOTICE_AFTER_MS.
      revealTimer: null
    };
    this.notifications.set(id, notification);

    if (ACTIVE_NOTIFICATION_TYPES.has(storedOptions.type)) {
      el.hidden = true;
      notification.revealTimer = setTimeout(() => {
        notification.revealTimer = null;
        if (this.notifications.get(id) === notification) this._reveal(notification);
      }, NOTICE_AFTER_MS);
    } else {
      this._reveal(notification);
    }

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
   * Put a card on screen, with its enter animation, first making room for it
   * under the cap (`maxNotifications` cards on screen): the oldest settled
   * card on screen retires to the earlier messages; if every card on screen
   * is work in progress, the cap is exceeded for now rather than orphan the
   * work's id. Only cards on screen count: a held-back card of work in
   * progress (NOTICE_AFTER_MS) would take the place of the card a person was
   * reading, a best-guess notice with its Show, for a field read that ends
   * before it is seen.
   * @private
   */
  _reveal(notification) {
    if (notification.revealTimer !== null) {
      clearTimeout(notification.revealTimer);
      notification.revealTimer = null;
    }
    this._evictNonActiveUntil(this.maxNotifications - 1, notification);
    const el = notification.element;
    el.hidden = false;
    requestAnimationFrame(() => {
      if (this.notifications.get(el.id) === notification) {
        el.classList.add('notification-enter');
      }
    });
  }

  /**
   * Show a held-back card now: its publisher has already waited
   * NOTICE_AFTER_MS for its work (a job that publishes its card only then:
   * `jobs/cancellable-job.js`).
   *
   * @param {string} id
   */
  reveal(id) {
    requireNonEmptyString(id, 'Notification id');
    const notification = this.notifications.get(id);
    if (notification !== undefined && notification.element.hidden) this._reveal(notification);
  }

  /**
   * Whether the card is on screen: a card of work in progress is held back
   * until its work has run NOTICE_AFTER_MS.
   *
   * @param {string} id
   * @returns {boolean}
   */
  isShown(id) {
    requireNonEmptyString(id, 'Notification id');
    const notification = this.notifications.get(id);
    return notification !== undefined && !notification.element.hidden;
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
    options = withDetailsPointer(options);
    const notif = this.notifications.get(id);
    if (!notif) {
      if (this._dismissed.has(id)) return null;
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
    for (const key of ['action', 'secondaryAction', 'dismissible', 'onCancel']) {
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

    // Work that ends before its card was shown: success ends it without a
    // card (unless announced); anything else is shown now.
    if (element.hidden && typeChanged) {
      if (nextType === NotificationType.SUCCESS && options.announce !== true) {
        this.dismiss(id);
        return;
      }
      this._reveal(notif);
    }

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
        appendAboveButtons(content, msgEl);
      }
      msgEl.textContent = options.message;
    }

    if (options.details !== undefined) {
      element.querySelector('.notification-details')?.remove();
      if (options.details !== '') {
        const content = element.querySelector('.notification-content');
        if (content === null) {
          throw new Error(`Notification "${id}" has no content element.`);
        }
        const holder = document.createElement('div');
        holder.innerHTML = notificationDetailsHtml(options.details);
        const message = content.querySelector('.notification-message');
        if (message === null) appendAboveButtons(content, holder.firstElementChild);
        else message.after(holder.firstElementChild);
      }
    }

    // A title published with active work names that work in progress
    // ("Downloading", "Processing", "Generating data"). Once the work settles
    // the title is no longer true, so a terminal transition that names no title
    // of its own retires it instead of leaving a finished download announced as
    // still downloading.
    const retiresActiveTitle =
      typeChanged &&
      TERMINAL_NOTIFICATION_TYPES.has(nextType) &&
      options.title === undefined;
    if (retiresActiveTitle) {
      element.querySelector('.notification-title')?.remove();
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
          progressText.textContent = formatPercent(options.progress);
        } else {
          // Hide percentage text when progress is unknown
          progressText.textContent = '';
        }
      }
    }

    // Update speed (null: none shown, the work is not reading bytes now)
    if (options.speed === null) {
      element.querySelector('.notification-speed')?.remove();
    } else if (options.speed !== undefined) {
      let speedEl = element.querySelector('.notification-speed');
      if (!speedEl) {
        speedEl = document.createElement('div');
        speedEl.className = 'notification-speed';
        const content = element.querySelector('.notification-content');
        if (content === null) {
          throw new Error(`Notification "${id}" has no content element.`);
        }
        appendAboveButtons(content, speedEl);
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

        // Replace Cancel with a standard dismiss button.
        element.querySelector('[data-role="cancel"]')?.remove();

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
    delete nextOptions.announce;
    if (retiresActiveTitle) delete nextOptions.title;
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

  /**
   * Retire the oldest settled cards on screen, other than `except` (the card
   * coming on screen), until at most `maximumSize` others are on screen. A
   * held-back card is not on screen and takes no place.
   */
  _evictNonActiveUntil(maximumSize, except = null) {
    if (!Number.isSafeInteger(maximumSize) || maximumSize < 0) {
      throw new RangeError(
        'Notification capacity target must be a non-negative safe integer.'
      );
    }
    const onScreen = () => [...this.notifications.values()]
      .filter(notification => notification !== except && !notification.element.hidden);
    for (let shown = onScreen(); shown.length > maximumSize; shown = onScreen()) {
      let candidateId = null;
      for (const [id, notification] of this.notifications) {
        if (
          notification !== except &&
          !notification.element.hidden &&
          !ACTIVE_NOTIFICATION_TYPES.has(notification.options.type)
        ) {
          candidateId = id;
          break;
        }
      }
      if (candidateId === null) return;
      const { options } = this.notifications.get(candidateId);
      // What the card offered goes with it (its Show, its Retry): no follow-up
      // is lost to the cap. Its owner dismissing it later withdraws it
      // (`dismiss`), as it would the card.
      this.overflowMessages.push({
        id: candidateId,
        type: options.type,
        title: typeof options.title === 'string' ? options.title : null,
        message: typeof options.message === 'string' ? options.message : null,
        action: options.action ?? null,
        secondaryAction: options.secondaryAction ?? null,
      });
      this.dismiss(candidateId);
      // The control sits under the stack, so it appearing or its open list
      // growing lifts every card: it waits while the pointer is over the
      // stack (`_holdStackUnderPointer`).
      if (this._pointerOverStack || this._followingPointer) this._overflowWaiting = true;
      else this._renderOverflow();
    }
  }

  /**
   * The control under the card stack naming the messages retired early to
   * make room, and the list of every one of them it opens.
   */
  _renderOverflow() {
    if (!this.initialized || this.container === null) return;
    this._overflowWaiting = false;
    const count = this.overflowMessages.length;
    if (count === 0) {
      this._overflowElement?.remove();
      this._overflowElement = null;
      this._overflowParts = null;
      this._overflowExpanded = false;
      this._overflowListed = 0;
      return;
    }
    if (this._overflowElement === null) {
      const wrapper = document.createElement('div');
      wrapper.className = 'notification-overflow';
      const bar = document.createElement('div');
      bar.className = 'notification-overflow-bar';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'btn btn-compact notification-overflow-toggle';
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'btn btn-compact notification-overflow-clear';
      clear.textContent = 'Clear';
      const list = document.createElement('div');
      list.className = 'notification-overflow-list';
      list.setAttribute('role', 'list');
      bar.append(toggle, clear);
      wrapper.append(bar, list);
      toggle.addEventListener('click', () => {
        this._overflowExpanded = !this._overflowExpanded;
        this._renderOverflow();
      });
      clear.addEventListener('click', () => {
        this.overflowMessages = [];
        this._overflowListed = 0;
        this._renderOverflow();
      });
      // The stack is column-reversed: the first child sits at the bottom,
      // under the oldest card, where the retired messages came from.
      this.container.prepend(wrapper);
      this._overflowElement = wrapper;
      this._overflowParts = { toggle, list };
    }
    const { toggle, list } = this._overflowParts;
    toggle.textContent = `${this._overflowExpanded ? 'Hide' : 'Show'} ${count} earlier ${countNoun(count, 'message')}`;
    toggle.setAttribute('aria-expanded', this._overflowExpanded ? 'true' : 'false');
    list.hidden = !this._overflowExpanded;
    if (!this._overflowExpanded) {
      list.replaceChildren();
      this._overflowListed = 0;
      return;
    }
    // The open list is the log of a whole session: a message retired while
    // it is open adds its own row (newest first, at the top), instead of the
    // list being rebuilt from every message so far.
    const listed = this._overflowListed ?? 0;
    const fresh = listed > 0 && listed <= count && list.childElementCount === listed;
    const fragment = document.createDocumentFragment();
    // Newest first, like the cards above.
    for (let index = count - 1; index >= (fresh ? listed : 0); index--) {
      const record = this.overflowMessages[index];
      const item = document.createElement('div');
      item.className = `notification-overflow-item notification-${record.type}`;
      item.setAttribute('role', 'listitem');
      if (record.title) {
        const title = document.createElement('div');
        title.className = 'notification-title';
        title.textContent = record.title;
        item.append(title);
      }
      if (record.message) {
        const message = document.createElement('div');
        message.className = 'notification-message';
        message.textContent = record.message;
        item.append(message);
      }
      const followUps = this._overflowFollowUps(record);
      if (followUps !== null) item.append(followUps);
      fragment.append(item);
    }
    if (fresh) list.prepend(fragment);
    else list.replaceChildren(fragment);
    this._overflowListed = count;
  }

  /**
   * The buttons of a retired card's follow-ups in its row of the earlier
   * messages, or null when it offered none (or they were taken or
   * withdrawn). Taking one settles it, as on the card.
   */
  _overflowFollowUps(record) {
    record.followUps = null;
    if (record.action === null) return null;
    const actions = document.createElement('div');
    actions.className = 'notification-actions';
    for (const [follow, className] of [
      [record.action, 'notification-action'],
      [record.secondaryAction, 'notification-secondary-action'],
    ]) {
      if (follow === null) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `btn btn-compact ${className}`;
      button.textContent = follow.label;
      button.addEventListener('click', () => {
        this._withdrawOverflowFollowUps(record);
        follow.run();
      });
      actions.append(button);
    }
    record.followUps = actions;
    return actions;
  }

  /** A retired card's follow-ups go: taken, or its owner dismissed it. */
  _withdrawOverflowFollowUps(record) {
    record.action = null;
    record.secondaryAction = null;
    record.followUps?.remove();
    record.followUps = null;
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
    if (!notif) {
      // A card retired to the earlier messages: its owner's dismissal
      // withdraws what it offered (a Show for a dataset no longer open).
      for (const record of this.overflowMessages) {
        if (record.id === id && record.action !== null) this._withdrawOverflowFollowUps(record);
      }
      return false;
    }

    const { element } = notif;
    this.notifications.delete(id);
    this._dismissed.add(id);
    if (notif.dismissTimer !== null) {
      clearTimeout(notif.dismissTimer);
      notif.dismissTimer = null;
    }
    if (notif.revealTimer !== null) {
      clearTimeout(notif.revealTimer);
      notif.revealTimer = null;
    }
    // A card never shown leaves at once.
    if (element.hidden) {
      element.remove();
      return true;
    }

    // Trigger exit animation
    element.removeAttribute('id');
    element.classList.remove('notification-enter');
    element.classList.add('notification-exit');

    // Remove after animation
    setTimeout(() => this._retire(element), 300);
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
    // Work that finished before its card was shown ends without one
    // (NOTICE_AFTER_MS).
    const finalMessage = duration !== null
      ? `${message} (${formatDuration(duration)})`
      : message;
    this.complete(id, finalMessage);
  }

  /**
   * Fail a calculation: one sentence, the failure's own words under Details.
   * @param {string} id
   * @param {string} errorMessage
   * @param {{details?: string}} [options]
   */
  failCalculation(id, errorMessage, options = {}) {
    requireNonEmptyString(errorMessage, 'Calculation error message');
    this.fail(id, errorMessage, options);
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
export { NotificationType };

// Export class for testing
export { NotificationCenter };
