/**
 * @fileoverview Overlay registry + ordered dispatcher.
 *
 * Centralizing overlay dispatch keeps the viewer integration minimal: the
 * viewer only needs to call `overlayManager.update()` and `overlayManager.render()`
 * once per view, and overlays decide if/when they do work.
 *
 * @module rendering/overlays/overlay-manager
 */

export class OverlayManager {
  /**
   * @param {WebGL2RenderingContext} gl
   */
  constructor(gl) {
    this.gl = gl;
    this._overlays = new Map(); // id -> overlay
    this._pendingRetirements = new Set();
    this._sorted = [];
    this._dirtyOrder = false;
  }

  /**
   * @param {import('./overlay-base.js').OverlayBase} overlay
   */
  register(overlay) {
    if (!overlay || typeof overlay !== 'object') {
      throw new TypeError('OverlayManager.register requires an overlay object.');
    }
    if (typeof overlay.id !== 'string' || overlay.id.length === 0) {
      throw new TypeError('OverlayManager.register requires a non-empty string id.');
    }
    for (const method of ['init', 'update', 'render', 'dispose']) {
      if (typeof overlay[method] !== 'function') {
        throw new TypeError(
          'OverlayManager.register requires the complete init, update, render, and dispose lifecycle.'
        );
      }
    }
    if (!Number.isFinite(overlay.priority)) {
      throw new TypeError('OverlayManager.register requires a finite priority.');
    }
    if (typeof overlay.enabled !== 'boolean' || typeof overlay.visible !== 'boolean') {
      throw new TypeError(
        'OverlayManager.register requires boolean enabled and visible state.'
      );
    }
    if (this._pendingRetirements.has(overlay)) {
      throw new Error('OverlayManager cannot register an overlay pending retirement.');
    }
    const id = overlay.id;
    for (const pending of this._pendingRetirements) {
      if (pending.id === id) {
        throw new Error(
          `OverlayManager cannot register "${id}" while its prior owner is pending retirement.`
        );
      }
    }
    if (this._overlays.has(id)) {
      throw new Error(`OverlayManager already owns overlay "${id}".`);
    }
    this._overlays.set(id, overlay);
    this._dirtyOrder = true;
  }

  /**
   * @param {string} id
   */
  get(id) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('OverlayManager.get requires a non-empty string id.');
    }
    return this._overlays.get(id) ?? null;
  }

  /**
   * @param {string} id
   */
  unregister(id) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError('OverlayManager.unregister requires a non-empty string id.');
    }
    const overlay = this._overlays.get(id);
    if (!overlay) {
      throw new RangeError(`OverlayManager does not own overlay "${id}".`);
    }
    this._overlays.delete(id);
    this._dirtyOrder = true;
    this._pendingRetirements.add(overlay);
    overlay.dispose();
    this._pendingRetirements.delete(overlay);
  }

  /**
   * Retry a detached overlay generation without disturbing active overlays.
   * @param {string} id
   * @returns {boolean} Whether a pending owner matched the ID.
   */
  retryRetirement(id) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new TypeError(
        'OverlayManager.retryRetirement requires a non-empty string id.'
      );
    }
    const matching = Array.from(this._pendingRetirements).filter(
      overlay => overlay.id === id
    );
    const failures = [];
    for (const overlay of matching) {
      try {
        overlay.dispose();
        this._pendingRetirements.delete(overlay);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `OverlayManager could not finish retiring overlay "${id}".`
      );
    }
    return matching.length > 0;
  }

  initAll() {
    for (const overlay of this._overlays.values()) {
      overlay.init();
    }
  }

  hasEnabledOverlays() {
    for (const overlay of this._overlays.values()) {
      if (overlay?.enabled) return true;
    }
    return false;
  }

  /**
   * @param {number} dtSeconds
   * @param {object} context
   */
  update(dtSeconds, context) {
    if (!Number.isFinite(dtSeconds) || dtSeconds < 0) {
      throw new RangeError('OverlayManager.update requires a finite non-negative delta.');
    }
    const overlays = this._getSorted();
    for (const overlay of overlays) {
      overlay.update(dtSeconds, context);
    }
  }

  /**
   * @param {object} context
   */
  render(context) {
    const overlays = this._getSorted();
    for (const overlay of overlays) {
      overlay.render(context);
    }
  }

  dispose() {
    const retiring = new Set([
      ...this._pendingRetirements,
      ...this._overlays.values(),
    ]);
    this._pendingRetirements = retiring;
    this._overlays.clear();
    this._sorted = [];
    this._dirtyOrder = false;

    const failures = [];
    for (const overlay of retiring) {
      try {
        overlay.dispose();
        this._pendingRetirements.delete(overlay);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'OverlayManager failed to retire every overlay.');
    }
  }

  _getSorted() {
    if (!this._dirtyOrder) return this._sorted;
    this._sorted = Array.from(this._overlays.values()).sort(
      (a, b) => a.priority - b.priority
    );
    this._dirtyOrder = false;
    return this._sorted;
  }
}
