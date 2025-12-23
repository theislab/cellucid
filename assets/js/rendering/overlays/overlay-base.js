/**
 * @fileoverview Overlay base class for renderer add-on passes.
 *
 * Overlays are opt-in render passes that draw on top of the main scatter plot,
 * without mutating the renderer's core state. This keeps the rendering pipeline
 * extensible (future animated overlays) while preserving performance.
 *
 * Design goals:
 * - GPU-first: no per-frame CPU work in hot paths
 * - Minimal coupling: overlays only consume a read-only context
 * - Deterministic lifecycle: init → update → render → dispose
 *
 * @module rendering/overlays/overlay-base
 */

export class OverlayBase {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {{ id?: string; priority?: number }} [options]
   */
  constructor(gl, options = {}) {
    this.gl = gl;
    this.id = options.id ? String(options.id) : 'overlay';
    this.priority = Number.isFinite(options.priority) ? options.priority : 0;

    this.enabled = false;
    this.visible = true;

    this._initialized = false;
    this._disposed = false;
  }

  init() {
    if (this._disposed) return;
    if (this._initialized) return;
    this._doInit();
    this._initialized = true;
  }

  /**
   * @param {number} dtSeconds
   * @param {object} context
   */
  update(dtSeconds, context) {
    if (!this.enabled || !this._initialized || this._disposed) return;
    this._doUpdate(dtSeconds, context);
  }

  /**
   * @param {object} context
   */
  render(context) {
    if (!this.enabled || !this.visible || !this._initialized || this._disposed) return;
    this._doRender(context);
  }

  dispose() {
    if (this._disposed) return;
    try {
      this._doDispose();
    } finally {
      this._disposed = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Subclass hooks
  // ---------------------------------------------------------------------------

  _doInit() {
    throw new Error(`${this.constructor.name}: _doInit() not implemented`);
  }

  _doUpdate(_dtSeconds, _context) {
    throw new Error(`${this.constructor.name}: _doUpdate() not implemented`);
  }

  _doRender(_context) {
    throw new Error(`${this.constructor.name}: _doRender() not implemented`);
  }

  _doDispose() {
    // Optional for subclasses.
  }
}

