/**
 * DeleteRegistry - tracks soft-deleted fields.
 *
 * Fields are not removed from the underlying dataset; instead they are marked as
 * hidden and excluded from UI selectors + filter application.
 */

import { makeFieldId } from '../utils/field-constants.js';
import { BaseRegistry } from './base-registry.js';
import { FieldSource } from '../utils/field-constants.js';
import { StateValidator } from '../utils/state-validator.js';

function requireSourceAndKey(source, originalKey) {
  if (source !== FieldSource.OBS && source !== FieldSource.VAR) {
    throw new TypeError('Delete source must be exactly obs or var');
  }
  StateValidator.validateFieldKey(originalKey);
}

function requireExactStringArray(value, label) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  const seen = new Set();
  for (const item of value) {
    if (
      typeof item !== 'string'
      || item.length === 0
      || item !== item.trim()
      || (!item.startsWith('obs:') && !item.startsWith('var:'))
    ) {
      throw new TypeError(
        `${label} entries must be exact obs/var field identifiers`
      );
    }
    if (seen.has(item)) {
      throw new TypeError(`${label} contains a duplicate identifier`);
    }
    seen.add(item);
  }
  return value;
}

export class DeleteRegistry extends BaseRegistry {
  constructor() {
    super();
    this._deletedFields = new Set(); // 'source:originalKey'
    this._purgedFields = new Set(); // 'source:originalKey' (confirmed, non-restorable)
  }

  markDeleted(source, originalKey) {
    requireSourceAndKey(source, originalKey);
    this._deletedFields.add(makeFieldId(source, originalKey));
  }

  markRestored(source, originalKey) {
    requireSourceAndKey(source, originalKey);
    this._deletedFields.delete(makeFieldId(source, originalKey));
    this._purgedFields.delete(makeFieldId(source, originalKey));
  }

  markPurged(source, originalKey) {
    requireSourceAndKey(source, originalKey);
    const id = makeFieldId(source, originalKey);
    this._deletedFields.add(id);
    this._purgedFields.add(id);
  }

  isDeleted(source, originalKey) {
    requireSourceAndKey(source, originalKey);
    return this._deletedFields.has(makeFieldId(source, originalKey));
  }

  isPurged(source, originalKey) {
    requireSourceAndKey(source, originalKey);
    return this._purgedFields.has(makeFieldId(source, originalKey));
  }

  getDeletedKeys(source) {
    if (source !== FieldSource.OBS && source !== FieldSource.VAR) {
      throw new TypeError('Delete source must be exactly obs or var');
    }
    const prefix = `${source}:`;
    return [...this._deletedFields]
      .filter((id) => id.startsWith(prefix))
      .filter((id) => !this._purgedFields.has(id))
      .map((id) => id.slice(prefix.length));
  }

  getCounts() {
    let obs = 0;
    let var_ = 0;
    for (const id of this._deletedFields) {
      if (this._purgedFields.has(id)) continue;
      if (id.startsWith('obs:')) obs++;
      else if (id.startsWith('var:')) var_++;
    }
    return { obs, var: var_ };
  }

  toJSON() {
    return {
      deleted: BaseRegistry.setToArray(this._deletedFields),
      purged: BaseRegistry.setToArray(this._purgedFields)
    };
  }

  fromJSON(data) {
    if (
      data === null
      || typeof data !== 'object'
      || Array.isArray(data)
      || Object.getPrototypeOf(data) !== Object.prototype
      || Object.keys(data).length !== 2
      || !Object.hasOwn(data, 'deleted')
      || !Object.hasOwn(data, 'purged')
    ) {
      throw new TypeError(
        'Delete registry payload requires exact deleted and purged arrays'
      );
    }
    const deleted = requireExactStringArray(
      data.deleted,
      'Deleted field identifiers'
    );
    const purged = requireExactStringArray(
      data.purged,
      'Purged field identifiers'
    );
    const deletedSet = new Set(deleted);
    for (const id of purged) {
      if (!deletedSet.has(id)) {
        throw new TypeError(
          'Every purged field identifier must also be deleted'
        );
      }
    }
    this._deletedFields = deletedSet;
    this._purgedFields = new Set(purged);
  }

  clear() {
    this._deletedFields.clear();
    this._purgedFields.clear();
  }
}
