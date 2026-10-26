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
    // Every edit that changes how one field is shown, in order, so a field
    // inventory that showed this registry at one revision applies only the
    // fields edited since (field/overlay-internals.js). A replacement of the
    // whole registry (clear, a restored payload) starts the record over.
    this._revision = 0;
    this._resetRevision = 0;
    /** @type {{revision: number, source: string, originalKey: string}[]} */
    this._edits = [];
  }

  /** The registry's revision: it moves on every edit. */
  getRevision() {
    return this._revision;
  }

  /**
   * The fields edited after `revision` (each with its source and original
   * key, in edit order), or null when the whole registry was replaced since
   * and every field has to be read again.
   *
   * @param {number} revision
   * @returns {{source: string, originalKey: string}[]|null}
   */
  editsSince(revision) {
    if (!Number.isSafeInteger(revision) || revision < this._resetRevision) {
      return null;
    }
    const edits = [];
    for (let index = this._edits.length - 1; index >= 0; index--) {
      const edit = this._edits[index];
      if (edit.revision <= revision) break;
      edits.push(edit);
    }
    return edits.reverse();
  }

  /** @protected */
  _recordEdit(source, originalKey) {
    this._revision += 1;
    this._edits.push({ revision: this._revision, source, originalKey });
  }

  /** @protected */
  _recordReplacement() {
    this._revision += 1;
    this._resetRevision = this._revision;
    this._edits = [];
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
    this._recordReplacement();
  }

  clear() {
    this._data.clear();
    this._recordReplacement();
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

