/**
 * DeleteRegistry - tracks soft-deleted fields.
 *
 * Fields are not removed from the underlying dataset; instead they are marked as
 * hidden and excluded from UI selectors + filter application.
 */

import { makeFieldId } from '../utils/field-constants.js';
import { BaseRegistry } from './base-registry.js';

export class DeleteRegistry extends BaseRegistry {
  constructor() {
    super();
    this._deletedFields = new Set(); // 'source:originalKey'
    this._purgedFields = new Set(); // 'source:originalKey' (confirmed, non-restorable)
  }

  markDeleted(source, originalKey) {
    this._deletedFields.add(makeFieldId(source, originalKey));
  }

  markRestored(source, originalKey) {
    this._deletedFields.delete(makeFieldId(source, originalKey));
    this._purgedFields.delete(makeFieldId(source, originalKey));
  }

  markPurged(source, originalKey) {
    const id = makeFieldId(source, originalKey);
    this._deletedFields.add(id);
    this._purgedFields.add(id);
  }

  isDeleted(source, originalKey) {
    return this._deletedFields.has(makeFieldId(source, originalKey));
  }

  isPurged(source, originalKey) {
    return this._purgedFields.has(makeFieldId(source, originalKey));
  }

  getDeletedKeys(source) {
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
    this._deletedFields = BaseRegistry.arrayToSet(data?.deleted);
    this._purgedFields = BaseRegistry.arrayToSet(data?.purged);
  }

  clear() {
    this._deletedFields.clear();
    this._purgedFields.clear();
  }
}
