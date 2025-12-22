/**
 * @fileoverview Lightweight Event Emitter for app-layer modules.
 *
 * Provides a consistent event-driven communication pattern for the app state
 * and UI layers. This is intentionally minimal and dependency-free.
 *
 * @module utils/event-emitter
 */

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
    if (!event || typeof callback !== 'function') return () => {};
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(callback);
    return () => this.off(event, callback);
  }

  /**
   * Register a one-time event listener.
   * @param {string} event
   * @param {Function} callback
   * @returns {Function} Unsubscribe function
   */
  once(event, callback) {
    if (!event || typeof callback !== 'function') return () => {};
    const wrapper = (data) => {
      this.off(event, wrapper);
      callback(data);
    };
    return this.on(event, wrapper);
  }

  /**
   * Remove a listener.
   * @param {string} event
   * @param {Function} callback
   */
  off(event, callback) {
    const listeners = this._listeners.get(event);
    if (!listeners) return;
    listeners.delete(callback);
    if (listeners.size === 0) {
      this._listeners.delete(event);
    }
  }

  /**
   * Emit an event to all listeners.
   * @param {string} event
   * @param {*} [data]
   */
  emit(event, data) {
    const listeners = this._listeners.get(event);
    if (!listeners) return;

    for (const callback of listeners) {
      try {
        callback(data);
      } catch (err) {
        console.error(`[EventEmitter] Error in '${event}':`, err);
      }
    }
  }

  /**
   * Remove all listeners for a specific event (or all events).
   * @param {string} [event]
   */
  removeAllListeners(event) {
    if (event) {
      this._listeners.delete(event);
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
    return this._listeners.get(event)?.size ?? 0;
  }
}

