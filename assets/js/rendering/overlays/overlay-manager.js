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
    this._sorted = [];
    this._dirtyOrder = false;
  }

  /**
   * @param {import('./overlay-base.js').OverlayBase} overlay
   */
  register(overlay) {
    if (!overlay || !overlay.id) throw new Error('OverlayManager.register: overlay must have an id');
    const id = String(overlay.id);
    this._overlays.set(id, overlay);
    this._dirtyOrder = true;
  }

  /**
   * @param {string} id
   */
  get(id) {
    return this._overlays.get(String(id)) || null;
  }

  /**
   * @param {string} id
   */
  unregister(id) {
    const key = String(id);
    const overlay = this._overlays.get(key) || null;
    if (!overlay) return false;
    overlay.dispose?.();
    this._overlays.delete(key);
    this._dirtyOrder = true;
    return true;
  }

  initAll() {
    for (const overlay of this._overlays.values()) {
      overlay.init?.();
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
    const overlays = this._getSorted();
    for (const overlay of overlays) {
      overlay.update?.(dtSeconds, context);
    }
  }

  /**
   * @param {object} context
   */
  render(context) {
    const overlays = this._getSorted();
    for (const overlay of overlays) {
      overlay.render?.(context);
    }
  }

  dispose() {
    for (const overlay of this._overlays.values()) {
      overlay.dispose?.();
    }
    this._overlays.clear();
    this._sorted = [];
    this._dirtyOrder = false;
  }

  _getSorted() {
    if (!this._dirtyOrder) return this._sorted;
    this._sorted = Array.from(this._overlays.values()).sort((a, b) => (a.priority || 0) - (b.priority || 0));
    this._dirtyOrder = false;
    return this._sorted;
  }
}

