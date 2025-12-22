/**
 * @fileoverview Base class for app state managers.
 *
 * Managers are small, focused objects that operate on a shared `DataState`
 * coordinator. They may emit their own events, but should not own core data
 * structures that need to be serialized.
 *
 * @module state/core/base-manager
 */

import { EventEmitter } from '../../utils/event-emitter.js';

export class BaseManager extends EventEmitter {
  /**
   * @param {import('./data-state.js').DataState} coordinator
   */
  constructor(coordinator) {
    super();
    this._coordinator = coordinator;
    this._initialized = false;
  }

  /**
   * Initialize the manager (optional).
   * @param {Object} [options]
   */
  init(options = {}) {
    this._initialized = true;
  }

  /**
   * Cleanup the manager (optional).
   */
  destroy() {
    this.removeAllListeners();
    this._initialized = false;
  }

  get isInitialized() { return this._initialized; }
  get _viewer() { return this._coordinator?.viewer; }
  get _labelLayer() { return this._coordinator?.labelLayer; }
  get _pointCount() { return this._coordinator?.pointCount || 0; }
}

