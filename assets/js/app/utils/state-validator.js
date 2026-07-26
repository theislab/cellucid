/**
 * StateValidator - validation helpers for user-initiated mutations.
 *
 * This module is used by DataState methods for:
 * - Rename validation
 * - Delete / restore guardrails
 * - User-defined categorical creation validation
 */

import { Limits, FieldKind, OverlapStrategy } from './field-constants.js';

export class StateValidator {
  static validateFieldKey(key) {
    if (!key || typeof key !== 'string') {
      throw new Error('Field name must be a non-empty string');
    }
    if (key.trim() !== key) {
      throw new Error('Field name cannot have leading/trailing whitespace');
    }
    if (key.length > Limits.MAX_FIELD_KEY_LENGTH) {
      throw new Error(`Field name too long (max ${Limits.MAX_FIELD_KEY_LENGTH} characters)`);
    }
    if (key.includes(':')) {
      throw new Error('Field name cannot contain ":"');
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
    if (type === 'string' && label.length > Limits.MAX_CATEGORY_LABEL_LENGTH) {
      throw new Error(`Category label too long (max ${Limits.MAX_CATEGORY_LABEL_LENGTH} characters)`);
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
    if (
      options === null
      || typeof options !== 'object'
      || Array.isArray(options)
      || Object.getPrototypeOf(options) !== Object.prototype
      || Object.keys(options).sort().some(
        (optionKey, index) => optionKey !== optionKeys[index]
      )
      || Object.keys(options).length !== optionKeys.length
    ) {
      throw new TypeError(
        `User-defined field options must contain exactly: ${optionKeys.join(', ')}`
      );
    }
    const {
      key,
      pages,
      uncoveredLabel,
      overlapStrategy,
      overlapLabel,
      intersectionLabels
    } = options;

    this.validateFieldKey(key);

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
      if (pages.length > Limits.MAX_INTERSECTION_PAGES) {
        throw new Error(`Too many pages for intersections (max ${Limits.MAX_INTERSECTION_PAGES})`);
      }
      for (const [maskKey, label] of Object.entries(intersectionLabels)) {
        if (!/^[1-9][0-9]*$/.test(maskKey)) {
          throw new TypeError(
            `Intersection label key "${maskKey}" must be a canonical positive integer`
          );
        }
        const mask = Number(maskKey);
        if (
          !Number.isSafeInteger(mask)
          || mask >= 2 ** pages.length
          || (mask & (mask - 1)) === 0
        ) {
          throw new RangeError(
            `Intersection label key "${maskKey}" is not a current multi-page mask`
          );
        }
        if (
          typeof label !== 'string'
          || label.length === 0
          || label !== label.trim()
        ) {
          throw new TypeError(
            `Intersection label "${maskKey}" must be a non-empty trimmed string`
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

    if (categoryLabels.size > Limits.MAX_CATEGORIES_PER_FIELD) {
      throw new Error(
        `Too many categories (max ${Limits.MAX_CATEGORIES_PER_FIELD})`
      );
    }

    return true;
  }
}
