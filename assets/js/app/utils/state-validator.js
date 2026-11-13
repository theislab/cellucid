/**
 * StateValidator - validation helpers for user-initiated mutations.
 *
 * This module is used by DataState methods for:
 * - Rename validation
 * - Delete / restore guardrails
 * - User-defined categorical creation validation
 */

import { FieldKind, OverlapStrategy } from './field-constants.js';
import { parseIntersectionKey } from './page-membership.js';
import {
  requireCategoricalCategoryCount
} from '../../data/categorical-storage-contract.js';

/**
 * Characters that occupy no glyph, so a key carrying one is stored as
 * something other than the key the reader sees.
 *
 * These two classes are the writers' rule, character for character:
 * cellucid-python's _CONTROL_CHARACTER_PATTERN / _INVISIBLE_CHARACTER_PATTERN
 * and cellucid-r's .control_character_pattern / .invisible_character_pattern.
 * U+200C and U+200D are deliberately absent from the second class: they join
 * Indic, Persian, and emoji sequences, so banning them would reject real text.
 */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const INVISIBLE_CHARACTER = /[\u200b\u2060\ufeff]/;

function describeCodePoint(character) {
  return `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
}

export class StateValidator {
  /**
   * A field key is an identity, not a path and not a rendered token.
   *
   * This is exactly the rule both writers apply to every written field
   * identity (cellucid-python's _require_field_identities(), cellucid-r's
   * .require_field_identities()): a non-empty string with no leading or
   * trailing whitespace and no character that has no glyph. Anything narrower
   * rejects a key a producer may legitimately publish, and the field list check
   * accepts it long before the overlay and rename paths reach this check, so
   * the field loads and then throws when the reader touches it.
   *
   * No narrower rule is applied, for that reason. ':' is
   * an ordinary drawable character that ATAC feature names use throughout
   * ('chr1:100-200'); nothing derived from a field key parses on it, because
   * the one ':'-delimited derived string -- DataLayer's cache key
   * `type:variableKey:pageIds[:v=...]` -- reads its page IDs from the tail. A
   * length cap likewise would reject a name the writers publish and the app must
   * render regardless; over-long names are a layout question, not a validity
   * one.
   */
  static validateFieldKey(key) {
    if (!key || typeof key !== 'string') {
      throw new Error('Field name must be a non-empty string');
    }
    if (key.trim() !== key) {
      throw new Error('Field name cannot have leading/trailing whitespace');
    }
    const control = CONTROL_CHARACTER.exec(key);
    if (control !== null) {
      throw new Error(
        `Field name cannot contain the control character ${describeCodePoint(control[0])}`
      );
    }
    const invisible = INVISIBLE_CHARACTER.exec(key);
    if (invisible !== null) {
      throw new Error(
        `Field name cannot contain the zero-width character ${describeCodePoint(invisible[0])}`
      );
    }
    return true;
  }

  /**
   * A category label someone gives now (a rename, a merge, a group, a page's
   * label in Create categorical): the field-name rule for text, so a label
   * made here is one line, with no space at its ends and no character that
   * has no glyph (a label with a line break would be drawn on two lines by
   * the legend, and the community annotation cannot key it). A
   * label a dataset brings is read as it is (`validateCategoryLabel`).
   */
  static validateNewCategoryLabel(label) {
    if (typeof label !== 'string' || label.length === 0) {
      throw new Error('a label is a non-empty text');
    }
    if (label.trim() !== label) {
      throw new Error('it starts or ends with a space; give it without');
    }
    const control = CONTROL_CHARACTER.exec(label);
    if (control !== null) {
      throw new Error(`it holds the control character ${describeCodePoint(control[0])} (a line break or tab, for example); a label is one line`);
    }
    const invisible = INVISIBLE_CHARACTER.exec(label);
    if (invisible !== null) {
      throw new Error(`it holds the zero-width character ${describeCodePoint(invisible[0])}`);
    }
    return true;
  }

  static validateCategoryLabel(label) {
    const type = typeof label;
    if (type !== 'string' && type !== 'number' && type !== 'boolean') {
      throw new TypeError('Category label must be a string, finite number, or boolean');
    }
    if (type === 'number' && !Number.isFinite(label)) {
      throw new TypeError('Numeric category labels must be finite');
    }
    return true;
  }

  static validateCellIndices(indices, pointCount) {
    if (!indices || typeof indices.length !== 'number') {
      throw new Error('Cell indices must be array-like');
    }
    const maxCheck = Math.min(indices.length, 100);
    for (let i = 0; i < maxCheck; i++) {
      const idx = indices[i];
      if (!Number.isInteger(idx) || idx < 0 || idx >= pointCount) {
        throw new Error(`Cell index ${idx} out of bounds [0, ${pointCount})`);
      }
    }
    return true;
  }

  static validateFieldIndex(index, fields) {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error('Field index must be a non-negative integer');
    }
    if (!fields || index >= fields.length) {
      throw new Error(`Field index ${index} out of bounds`);
    }
    return true;
  }

  static validateCategoryIndex(index, field) {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error('Category index must be a non-negative integer');
    }
    if (field?.kind !== FieldKind.CATEGORY) {
      throw new Error('Field is not categorical');
    }
    if (!field.categories || index >= field.categories.length) {
      throw new Error(`Category index ${index} out of bounds`);
    }
    return true;
  }

  static isDuplicateKey(key, fields, excludeIndex = -1) {
    return (fields || []).some((f, i) => (
      i !== excludeIndex && f && f.key === key && f._isDeleted !== true
    ));
  }

  static validateUserDefinedOptions(options) {
    const optionKeys = [
      'intersectionLabels',
      'key',
      'overlapLabel',
      'overlapStrategy',
      'pages',
      'uncoveredLabel'
    ];
    // `rest` (the field whose category the cells on no page keep) is given only when one is.
    const given = options !== null && typeof options === 'object' && Object.hasOwn(options, 'rest')
      ? [...optionKeys, 'rest'].sort() : optionKeys;
    if (
      options === null
      || typeof options !== 'object'
      || Array.isArray(options)
      || Object.getPrototypeOf(options) !== Object.prototype
      || Object.keys(options).sort().some(
        (optionKey, index) => optionKey !== given[index]
      )
      || Object.keys(options).length !== given.length
    ) {
      throw new TypeError(
        `User-defined field options must contain exactly: ${optionKeys.join(', ')} (and rest, when the cells on no page keep a field's categories)`
      );
    }
    const {
      key,
      pages,
      uncoveredLabel,
      overlapStrategy,
      overlapLabel,
      intersectionLabels,
      rest = null
    } = options;

    this.validateFieldKey(key);
    // The field whose category the cells on no page keep: its labels, each open cell's code, its missing code.
    if (rest !== null && (
      rest === undefined || typeof rest !== 'object' || Array.isArray(rest)
      || !Array.isArray(rest.categories) || rest.categories.some(label => typeof label !== 'string')
      || !ArrayBuffer.isView(rest.codes) || !Number.isSafeInteger(rest.missing)
    )) {
      throw new TypeError('rest must be null or the kept field\'s categories (labels), codes and missing code');
    }

    if (!Array.isArray(pages) || pages.length === 0) {
      throw new Error('At least one page is required');
    }

    const pageIds = new Set();
    const categoryLabels = new Set();
    pages.forEach((p, i) => {
      if (
        p === null
        || typeof p !== 'object'
        || Array.isArray(p)
        || Object.getPrototypeOf(p) !== Object.prototype
        || Object.keys(p).sort().join(',') !== 'label,pageId'
      ) {
        throw new TypeError(
          `Page ${i} must contain exactly pageId and label`
        );
      }
      if (
        typeof p.pageId !== 'string'
        || p.pageId.length === 0
        || p.pageId !== p.pageId.trim()
      ) {
        throw new Error(`Page ${i} requires a non-empty trimmed pageId`);
      }
      if (
        typeof p.label !== 'string'
        || p.label.length === 0
        || p.label !== p.label.trim()
      ) {
        throw new Error(`Page ${i} requires a non-empty trimmed label`);
      }
      this.validateCategoryLabel(p.label);
      if (pageIds.has(p.pageId)) {
        throw new Error(`Page ${i} duplicates pageId "${p.pageId}"`);
      }
      if (categoryLabels.has(p.label)) {
        throw new Error(`Page ${i} duplicates label "${p.label}"`);
      }
      pageIds.add(p.pageId);
      categoryLabels.add(p.label);
    });

    if (typeof uncoveredLabel !== 'string' || uncoveredLabel !== uncoveredLabel.trim()) {
      throw new Error('Uncovered label must be a trimmed string');
    }
    if (uncoveredLabel !== '') {
      this.validateCategoryLabel(uncoveredLabel);
      if (categoryLabels.has(uncoveredLabel)) {
        throw new Error(`Uncovered label "${uncoveredLabel}" duplicates a category label`);
      }
      categoryLabels.add(uncoveredLabel);
    }

    if (
      overlapStrategy !== OverlapStrategy.FIRST
      && overlapStrategy !== OverlapStrategy.LAST
      && overlapStrategy !== OverlapStrategy.OVERLAP_LABEL
      && overlapStrategy !== OverlapStrategy.INTERSECTIONS
    ) {
      throw new Error(`Invalid overlap strategy: ${overlapStrategy}`);
    }

    if (typeof overlapLabel !== 'string' || overlapLabel !== overlapLabel.trim()) {
      throw new Error('Overlap label must be a trimmed string');
    }
    if (overlapStrategy === OverlapStrategy.OVERLAP_LABEL) {
      if (!overlapLabel) throw new Error('Overlap label is required');
      this.validateCategoryLabel(overlapLabel);
      if (categoryLabels.has(overlapLabel)) {
        throw new Error(`Overlap label "${overlapLabel}" duplicates a category label`);
      }
      categoryLabels.add(overlapLabel);
    }

    if (
      intersectionLabels === null
      || typeof intersectionLabels !== 'object'
      || Array.isArray(intersectionLabels)
      || Object.getPrototypeOf(intersectionLabels) !== Object.prototype
    ) {
      throw new TypeError('intersectionLabels must be a plain object');
    }

    if (overlapStrategy === OverlapStrategy.INTERSECTIONS) {
      for (const [key, label] of Object.entries(intersectionLabels)) {
        parseIntersectionKey(key, pages.length);
        if (
          typeof label !== 'string'
          || label.length === 0
          || label !== label.trim()
        ) {
          throw new TypeError(
            `Intersection label "${key}" must be a non-empty trimmed string`
          );
        }
        this.validateCategoryLabel(label);
        if (categoryLabels.has(label)) {
          throw new Error(`Intersection label "${label}" duplicates a category label`);
        }
        categoryLabels.add(label);
      }
    } else if (Object.keys(intersectionLabels).length !== 0) {
      throw new Error(
        'intersectionLabels must be empty unless the intersections strategy is selected'
      );
    }

    requireCategoricalCategoryCount(
      categoryLabels.size,
      'A user-defined categorical'
    );

    return true;
  }
}
