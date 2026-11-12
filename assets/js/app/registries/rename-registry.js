/**
 * RenameRegistry - tracks display renames for fields and category labels.
 *
 * The registry stores *original* identifiers as keys so it can be safely applied
 * after any reload/restore, regardless of current display names.
 *
 * A category's original identifier is its **label**, never its position in the
 * inventory. Position is not identity: a session's dataset fingerprint pins the
 * cells and their coordinates, not the obs schema, so the same dataset written
 * again from the same embedding with one more cell type restores cleanly with
 * every category after the insertion point shifted by one. A registry keyed by
 * position would then move a rename onto its neighbor and color, label, and
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
import { requirePlainRecord } from '../../utils/exact-record.js';

function requireSource(source) {
  if (source !== FieldSource.OBS && source !== FieldSource.VAR) {
    throw new TypeError('Rename source must be exactly obs or var');
  }
  return source;
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

/**
 * The parts of a `makeCategoryId` key: its source, field and label, the label
 * of its own type again (the tag says which).
 *
 * @param {string} id
 * @returns {{source: string, field: string, category: string|number|boolean}}
 */
function parseCategoryId(id) {
  const sourceEnd = id.indexOf(':');
  const lengthEnd = id.indexOf(':', sourceEnd + 1);
  const length = Number(id.slice(sourceEnd + 1, lengthEnd));
  const fieldStart = lengthEnd + 1;
  const field = id.slice(fieldStart, fieldStart + length);
  const tag = id.slice(fieldStart + length + 1, fieldStart + length + 2);
  const text = id.slice(fieldStart + length + 3);
  const category = tag === 'n' ? Number(text) : tag === 'b' ? text === 'true' : text;
  if (sourceEnd < 1 || !Number.isSafeInteger(length) || makeCategoryId(id.slice(0, sourceEnd), field, category) !== id) {
    throw new TypeError(`Category rename key "${id}" is malformed`);
  }
  return { source: id.slice(0, sourceEnd), field, category };
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
    this._recordEdit(source, originalKey);
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
    this._recordEdit(source, originalKey);
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
    this._recordEdit(source, originalFieldKey);
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
    this._recordEdit(source, originalFieldKey);
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
    requirePlainRecord(data, 'Rename registry payload');
    if (
      Object.keys(data).length !== 2
      || !Object.hasOwn(data, 'fields')
      || !Object.hasOwn(data, 'categories')
    ) {
      throw new TypeError(
        'Rename registry payload requires exact fields and categories'
      );
    }
    requirePlainRecord(data.fields, 'Rename registry fields');
    requirePlainRecord(data.categories, 'Rename registry categories');
    this._fieldRenames = new Map(Object.entries(data.fields));
    this._categoryRenames = new Map(Object.entries(data.categories));
    this._data = this._fieldRenames;
    this._recordReplacement();
  }

  clear() {
    this._fieldRenames.clear();
    this._categoryRenames.clear();
    this._recordReplacement();
  }

  /**
   * Every rename by name, in the order made: a field by its source and
   * original key, a category by its field's original key and its original
   * label (of its own type), each with the name it is shown under.
   *
   * @returns {{fields: Array<{source: string, key: string, name: string}>,
   *   categories: Array<{source: string, field: string, category: string|number|boolean, name: string|number|boolean}>}}
   */
  toEntries() {
    return {
      fields: [...this._fieldRenames].map(([id, name]) => {
        const at = id.indexOf(':');
        return { source: id.slice(0, at), key: id.slice(at + 1), name };
      }),
      categories: [...this._categoryRenames].map(([id, name]) => ({ ...parseCategoryId(id), name })),
    };
  }

  /**
   * Replace every rename with `entries` (`toEntries`'s shape), checked whole
   * before anything changes.
   *
   * @param {ReturnType<RenameRegistry['toEntries']>} entries
   */
  fromEntries(entries) {
    requirePlainRecord(entries, 'Rename entries');
    const fields = new Map();
    for (const { source, key, name } of entries.fields) {
      requireSource(source);
      StateValidator.validateFieldKey(key);
      StateValidator.validateFieldKey(name);
      fields.set(makeFieldId(source, key), name);
    }
    const categories = new Map();
    for (const { source, field, category, name } of entries.categories) {
      requireSource(source);
      StateValidator.validateFieldKey(field);
      StateValidator.validateCategoryLabel(category);
      StateValidator.validateCategoryLabel(name);
      categories.set(makeCategoryId(source, field, category), name);
    }
    this._fieldRenames = fields;
    this._categoryRenames = categories;
    this._data = this._fieldRenames;
    this._recordReplacement();
  }

  getCounts() {
    return { fields: this._fieldRenames.size, categories: this._categoryRenames.size };
  }

  /**
   * Whether any field or category of `source` is renamed.
   * @param {string} source - 'obs' | 'var'
   * @returns {boolean}
   */
  hasEntriesFor(source) {
    requireSource(source);
    const prefix = `${source}:`;
    for (const key of this._fieldRenames.keys()) if (key.startsWith(prefix)) return true;
    for (const key of this._categoryRenames.keys()) if (key.startsWith(prefix)) return true;
    return false;
  }
}
