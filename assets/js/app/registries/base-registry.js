/**
 * @fileoverview Base registry helpers.
 *
 * Registries persist user-driven state edits (renames, soft-deletes, derived fields).
 * They are data-only and serialization-friendly so snapshots can round-trip cleanly.
 *
 * @module registries/base-registry
 */

export class BaseRegistry {
  constructor() {
    /** @type {Map<string, any>} */
    this._data = new Map();
  }

  /**
   * Serialize registry data.
   * @returns {any}
   */
  toJSON() {
    return Object.fromEntries(this._data);
  }

  /**
   * Restore registry data from a previously serialized payload.
   * @param {any} data
   */
  fromJSON(data) {
    this._data = new Map(Object.entries(data || {}));
  }

  clear() {
    this._data.clear();
  }

  static mapToObject(map) {
    return Object.fromEntries(map || []);
  }

  static objectToMap(obj) {
    return new Map(Object.entries(obj || {}));
  }

  static setToArray(set) {
    return Array.from(set || []);
  }

  static arrayToSet(arr) {
    return new Set(arr || []);
  }
}

