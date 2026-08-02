/**
 * RenameRegistry - tracks display renames for fields and category labels.
 *
 * The registry stores *original* identifiers as keys so it can be safely applied
 * after any reload/restore, regardless of current display names.
 *
 * A category's original identifier is its **label**, never its position in the
 * inventory. Position is not identity: a session's dataset fingerprint pins the
 * cells and their coordinates, not the obs schema, so the same dataset exported
 * again from the same embedding with one more cell type restores cleanly with
 * every category after the insertion point shifted by one. A registry keyed by
 * position would then move a rename onto its neighbour and colour, label, and
 * export those cells under a name that is not theirs — silently, because
 * nothing downstream can tell a deliberate rename from a displaced one.
 *
 * Both parts of a category key are attacker- and user-controlled strings that
 * may contain the ':' separator — field keys because ATAC feature names use it,
 * labels because a label is arbitrary text — so the key length-prefixes the
 * field key and tags the label's primitive type. That makes the composite
 * injective: ("a", "b:c") and ("a:b", "c") cannot collide, and the number 1
 * cannot collide with the string "1".
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

/** Primitive-type tags, so `1` and `'1'` are different category identities. */
const LABEL_TYPE_TAG = Object.freeze({
  string: 's',
  number: 'n',
  boolean: 'b'
});

/**
 * Build the injective key naming one category of one field.
 *
 * @param {string} source - 'obs' | 'var'
 * @param {string} originalFieldKey
 * @param {string|number|boolean} originalLabel
 * @returns {string}
 */
function makeCategoryId(source, originalFieldKey, originalLabel) {
  const tag = LABEL_TYPE_TAG[typeof originalLabel];
  if (tag === undefined) {
    throw new TypeError(
      'Category rename identity must be a string, finite number, or boolean'
    );
  }
  return (
    `${source}:${originalFieldKey.length}:${originalFieldKey}`
    + `:${tag}:${String(originalLabel)}`
  );
}

export class RenameRegistry extends BaseRegistry {
  constructor() {
    super();
    this._fieldRenames = new Map(); // 'source:originalKey' -> displayKey
    // 'source:<len>:originalFieldKey:<type>:originalLabel' -> displayLabel
    this._categoryRenames = new Map();
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

  /**
   * @param {string} source - 'obs' | 'var'
   * @param {string} originalFieldKey
   * @param {string|number|boolean} originalLabel - The category's own identity.
   * @param {string|number|boolean} displayLabel
   */
  setCategoryRename(source, originalFieldKey, originalLabel, displayLabel) {
    requireSource(source);
    StateValidator.validateFieldKey(originalFieldKey);
    StateValidator.validateCategoryLabel(originalLabel);
    StateValidator.validateCategoryLabel(displayLabel);
    const mapKey = makeCategoryId(source, originalFieldKey, originalLabel);
    if (displayLabel === originalLabel) {
      this._categoryRenames.delete(mapKey);
    } else {
      this._categoryRenames.set(mapKey, displayLabel);
    }
  }

  /**
   * @param {string} source - 'obs' | 'var'
   * @param {string} originalFieldKey
   * @param {string|number|boolean} originalLabel
   * @returns {string|number|boolean} The renamed label, or the original one.
   */
  getDisplayCategory(source, originalFieldKey, originalLabel) {
    requireSource(source);
    StateValidator.validateFieldKey(originalFieldKey);
    StateValidator.validateCategoryLabel(originalLabel);
    const mapKey = makeCategoryId(source, originalFieldKey, originalLabel);
    return this._categoryRenames.has(mapKey)
      ? this._categoryRenames.get(mapKey)
      : originalLabel;
  }

  /**
   * @param {string} source - 'obs' | 'var'
   * @param {string} originalFieldKey
   * @param {string|number|boolean} originalLabel
   */
  revertCategoryRename(source, originalFieldKey, originalLabel) {
    requireSource(source);
    StateValidator.validateFieldKey(originalFieldKey);
    StateValidator.validateCategoryLabel(originalLabel);
    this._categoryRenames.delete(
      makeCategoryId(source, originalFieldKey, originalLabel)
    );
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
