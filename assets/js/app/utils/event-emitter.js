/**
 * @fileoverview Lightweight Event Emitter for app-layer modules.
 *
 * Provides a consistent event-driven communication pattern for the app state
 * and UI layers. Each event's listeners are one listener set
 * (`utils/listener-set.js`): a listener that throws is reported and the
 * others still hear the event.
 *
 * @module utils/event-emitter
 */

import { createListenerSet } from '../../utils/listener-set.js';

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
    /** @type {Map<string, import('../../utils/listener-set.js').ListenerSet<[unknown]>>} */
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
    let listeners = this._listeners.get(exactEvent);
    if (listeners === undefined) {
      listeners = createListenerSet(`${this.constructor.name} "${exactEvent}"`);
      this._listeners.set(exactEvent, listeners);
    }
    const unsubscribe = listeners.add(exactCallback);
    return () => {
      unsubscribe();
      if (listeners.size === 0 && this._listeners.get(exactEvent) === listeners) {
        this._listeners.delete(exactEvent);
      }
    };
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
   * Emit an event to all listeners (one that throws is reported; the others
   * still hear it).
   * @param {string} event
   * @param {*} [data]
   */
  emit(event, data) {
    this._listeners.get(assertEventName(event))?.notify(data);
  }

  /**
   * Emit an event while `isCurrent()` holds after each listener: one that
   * makes it stale (it changed what the event tells, and the newer event was
   * emitted) stops the rest hearing the older. Returns `isCurrent()`.
   * @param {string} event
   * @param {*} data
   * @param {() => boolean} isCurrent
   * @returns {boolean}
   */
  emitWhile(event, data, isCurrent) {
    const listeners = this._listeners.get(assertEventName(event));
    if (listeners === undefined) return isCurrent();
    return listeners.notifyWhile(isCurrent, data);
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
