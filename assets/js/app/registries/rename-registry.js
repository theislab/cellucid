/**
 * RenameRegistry - tracks display renames for fields and category labels.
 *
 * The registry stores *original* identifiers as keys so it can be safely applied
 * after any reload/restore, regardless of current display names.
 */

import { makeFieldId } from '../utils/field-constants.js';
import { BaseRegistry } from './base-registry.js';

export class RenameRegistry extends BaseRegistry {
  constructor() {
    super();
    this._fieldRenames = new Map(); // 'source:originalKey' -> displayKey
    this._categoryRenames = new Map(); // 'source:originalFieldKey:catIdx' -> label
    // Alias the canonical map so common BaseRegistry helpers apply.
    this._data = this._fieldRenames;
  }

  // ---------------------------------------------------------------------------
  // Field renames
  // ---------------------------------------------------------------------------

  setFieldRename(source, originalKey, displayKey) {
    const mapKey = makeFieldId(source, originalKey);
    if (displayKey === originalKey) {
      this._fieldRenames.delete(mapKey);
    } else {
      this._fieldRenames.set(mapKey, displayKey);
    }
  }

  getDisplayKey(source, originalKey) {
    const mapKey = makeFieldId(source, originalKey);
    return this._fieldRenames.get(mapKey) || originalKey;
  }

  isFieldRenamed(source, originalKey) {
    const mapKey = makeFieldId(source, originalKey);
    return this._fieldRenames.has(mapKey);
  }

  revertFieldRename(source, originalKey) {
    const mapKey = makeFieldId(source, originalKey);
    this._fieldRenames.delete(mapKey);
  }

  // ---------------------------------------------------------------------------
  // Category renames
  // ---------------------------------------------------------------------------

  setCategoryRename(source, originalFieldKey, categoryIndex, displayLabel) {
    const mapKey = `${source}:${originalFieldKey}:${categoryIndex}`;
    this._categoryRenames.set(mapKey, displayLabel);
  }

  getDisplayCategory(source, originalFieldKey, categoryIndex, originalLabel) {
    const mapKey = `${source}:${originalFieldKey}:${categoryIndex}`;
    return this._categoryRenames.get(mapKey) || originalLabel;
  }

  revertCategoryRename(source, originalFieldKey, categoryIndex) {
    const mapKey = `${source}:${originalFieldKey}:${categoryIndex}`;
    this._categoryRenames.delete(mapKey);
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------

  toJSON() {
    return {
      fields: BaseRegistry.mapToObject(this._fieldRenames),
      categories: BaseRegistry.mapToObject(this._categoryRenames)
    };
  }

  fromJSON(data) {
    this._fieldRenames = BaseRegistry.objectToMap(data?.fields);
    this._categoryRenames = BaseRegistry.objectToMap(data?.categories);
    this._data = this._fieldRenames;
  }

  clear() {
    this._fieldRenames.clear();
    this._categoryRenames.clear();
  }

  getCounts() {
    return { fields: this._fieldRenames.size, categories: this._categoryRenames.size };
  }
}
