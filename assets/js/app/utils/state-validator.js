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
    if (label === null || label === undefined) {
      throw new Error('Category label cannot be null or undefined');
    }
    const value = String(label).trim();
    if (value.length > Limits.MAX_CATEGORY_LABEL_LENGTH) {
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
    const { key, pages, uncoveredLabel, overlapStrategy, overlapLabel, intersectionLabels } = options || {};

    this.validateFieldKey(key);

    if (!pages || !Array.isArray(pages) || pages.length === 0) {
      throw new Error('At least one page is required');
    }

    pages.forEach((p, i) => {
      if (!p || !p.pageId) {
        throw new Error(`Page ${i} missing pageId`);
      }
      if (p.label !== undefined) {
        this.validateCategoryLabel(p.label);
      }
    });

    if (uncoveredLabel !== undefined && uncoveredLabel !== '') {
      this.validateCategoryLabel(uncoveredLabel);
    }

    const strategy = overlapStrategy || OverlapStrategy.FIRST;
    if (!Object.values(OverlapStrategy).includes(strategy)) {
      throw new Error(`Invalid overlap strategy: ${strategy}`);
    }

    if (strategy === OverlapStrategy.OVERLAP_LABEL) {
      const label = String(overlapLabel ?? '').trim();
      if (!label) throw new Error('Overlap label is required');
      this.validateCategoryLabel(label);
    }

    if (strategy === OverlapStrategy.INTERSECTIONS) {
      if ((pages || []).length > Limits.MAX_INTERSECTION_PAGES) {
        throw new Error(`Too many pages for intersections (max ${Limits.MAX_INTERSECTION_PAGES})`);
      }
      if (intersectionLabels != null) {
        if (typeof intersectionLabels !== 'object' || Array.isArray(intersectionLabels)) {
          throw new Error('intersectionLabels must be an object');
        }
        for (const label of Object.values(intersectionLabels)) {
          this.validateCategoryLabel(label);
        }
      }
    }

    return true;
  }
}
