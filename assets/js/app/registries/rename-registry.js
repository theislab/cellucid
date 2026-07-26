/**
 * RenameRegistry - tracks display renames for fields and category labels.
 *
 * The registry stores *original* identifiers as keys so it can be safely applied
 * after any reload/restore, regardless of current display names.
 */

import { makeFieldId } from '../utils/field-constants.js';
import { BaseRegistry } from './base-registry.js';
import { FieldSource } from '../utils/field-constants.js';
import { StateValidator } from '../utils/state-validator.js';

function requireSource(source) {
  if (source !== FieldSource.OBS && source !== FieldSource.VAR) {
    throw new TypeError('Rename source must be exactly obs or var');
  }
  return source;
}

function requireRecord(value, label) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

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
    requireSource(source);
    StateValidator.validateFieldKey(originalKey);
    StateValidator.validateFieldKey(displayKey);
    const mapKey = makeFieldId(source, originalKey);
    if (displayKey === originalKey) {
      this._fieldRenames.delete(mapKey);
    } else {
      this._fieldRenames.set(mapKey, displayKey);
    }
  }

  getDisplayKey(source, originalKey) {
    requireSource(source);
    StateValidator.validateFieldKey(originalKey);
    const mapKey = makeFieldId(source, originalKey);
    return this._fieldRenames.has(mapKey)
      ? this._fieldRenames.get(mapKey)
      : originalKey;
  }

  isFieldRenamed(source, originalKey) {
    requireSource(source);
    StateValidator.validateFieldKey(originalKey);
    const mapKey = makeFieldId(source, originalKey);
    return this._fieldRenames.has(mapKey);
  }

  revertFieldRename(source, originalKey) {
    requireSource(source);
    StateValidator.validateFieldKey(originalKey);
    const mapKey = makeFieldId(source, originalKey);
    this._fieldRenames.delete(mapKey);
  }

  // ---------------------------------------------------------------------------
  // Category renames
  // ---------------------------------------------------------------------------

  setCategoryRename(source, originalFieldKey, categoryIndex, displayLabel) {
    requireSource(source);
    StateValidator.validateFieldKey(originalFieldKey);
    if (!Number.isSafeInteger(categoryIndex) || categoryIndex < 0) {
      throw new TypeError(
        'Category rename index must be a non-negative safe integer'
      );
    }
    StateValidator.validateCategoryLabel(displayLabel);
    const mapKey = `${source}:${originalFieldKey}:${categoryIndex}`;
    this._categoryRenames.set(mapKey, displayLabel);
  }

  getDisplayCategory(source, originalFieldKey, categoryIndex, originalLabel) {
    requireSource(source);
    StateValidator.validateFieldKey(originalFieldKey);
    if (!Number.isSafeInteger(categoryIndex) || categoryIndex < 0) {
      throw new TypeError(
        'Category rename index must be a non-negative safe integer'
      );
    }
    StateValidator.validateCategoryLabel(originalLabel);
    const mapKey = `${source}:${originalFieldKey}:${categoryIndex}`;
    return this._categoryRenames.has(mapKey)
      ? this._categoryRenames.get(mapKey)
      : originalLabel;
  }

  revertCategoryRename(source, originalFieldKey, categoryIndex) {
    requireSource(source);
    StateValidator.validateFieldKey(originalFieldKey);
    if (!Number.isSafeInteger(categoryIndex) || categoryIndex < 0) {
      throw new TypeError(
        'Category rename index must be a non-negative safe integer'
      );
    }
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
    requireRecord(data, 'Rename registry payload');
    if (
      Object.keys(data).length !== 2
      || !Object.hasOwn(data, 'fields')
      || !Object.hasOwn(data, 'categories')
    ) {
      throw new TypeError(
        'Rename registry payload requires exact fields and categories'
      );
    }
    requireRecord(data.fields, 'Rename registry fields');
    requireRecord(data.categories, 'Rename registry categories');
    this._fieldRenames = new Map(Object.entries(data.fields));
    this._categoryRenames = new Map(Object.entries(data.categories));
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
