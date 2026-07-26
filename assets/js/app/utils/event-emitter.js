/**
 * @fileoverview Lightweight Event Emitter for app-layer modules.
 *
 * Provides a consistent event-driven communication pattern for the app state
 * and UI layers. This is intentionally minimal and dependency-free.
 *
 * @module utils/event-emitter
 */

function assertEventName(event) {
  if (
    typeof event !== 'string'
    || event.length === 0
    || event.trim() !== event
  ) {
    throw new TypeError(
      'Event name must be one non-empty, exactly trimmed string.'
    );
  }
  return event;
}

function assertCallback(callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('Event callback must be a function.');
  }
  return callback;
}

export class EventEmitter {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /**
   * Register an event listener.
   * @param {string} event
   * @param {Function} callback
  * @returns {Function} Unsubscribe function
  */
  on(event, callback) {
    const exactEvent = assertEventName(event);
    const exactCallback = assertCallback(callback);
    if (!this._listeners.has(exactEvent)) {
      this._listeners.set(exactEvent, new Set());
    }
    this._listeners.get(exactEvent).add(exactCallback);
    return () => this.off(exactEvent, exactCallback);
  }

  /**
   * Register a one-time event listener.
   * @param {string} event
   * @param {Function} callback
  * @returns {Function} Unsubscribe function
  */
  once(event, callback) {
    const exactEvent = assertEventName(event);
    const exactCallback = assertCallback(callback);
    const wrapper = (data) => {
      this.off(exactEvent, wrapper);
      exactCallback(data);
    };
    return this.on(exactEvent, wrapper);
  }

  /**
  * Remove a listener.
  * @param {string} event
  * @param {Function} callback
   * @returns {boolean} Whether the listener was registered
  */
  off(event, callback) {
    const exactEvent = assertEventName(event);
    const exactCallback = assertCallback(callback);
    const listeners = this._listeners.get(exactEvent);
    if (listeners === undefined) return false;
    const removed = listeners.delete(exactCallback);
    if (listeners.size === 0) {
      this._listeners.delete(exactEvent);
    }
    return removed;
  }

  /**
   * Emit an event to all listeners.
   * @param {string} event
  * @param {*} [data]
  */
  emit(event, data) {
    const exactEvent = assertEventName(event);
    const listeners = this._listeners.get(exactEvent);
    if (listeners === undefined) return;

    for (const callback of [...listeners]) {
      callback(data);
    }
  }

  /**
   * Remove all listeners for a specific event (or all events).
  * @param {string} [event]
  */
  removeAllListeners(event) {
    if (event !== undefined) {
      this._listeners.delete(assertEventName(event));
      return;
    }
    this._listeners.clear();
  }

  /**
   * Get listener count for an event.
   * @param {string} event
  * @returns {number}
  */
  listenerCount(event) {
    const listeners = this._listeners.get(assertEventName(event));
    return listeners === undefined ? 0 : listeners.size;
  }
}
