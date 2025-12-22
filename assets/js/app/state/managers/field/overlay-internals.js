/**
 * @fileoverview DataState field overlay internals.
 *
 * Internal helpers used by field operations:
 * - Apply rename/delete registries to field metadata
 * - Inject user-defined fields into obs/var field lists
 * - Keep highlight group labels and centroid labels consistent after edits
 *
 * Mixed into DataState via `state/managers/field-manager.js`.
 *
 * @module state/managers/field/overlay-internals
 */

import { FieldKind, FieldSource } from '../../../utils/field-constants.js';

export class FieldOverlayInternalMethods {
  _ensureActiveSelectionNotDeleted() {
    if (this.activeFieldSource === FieldSource.OBS && this.activeFieldIndex >= 0) {
      const field = this.obsData?.fields?.[this.activeFieldIndex];
      if (field?._isDeleted === true) {
        this.activeFieldIndex = -1;
        this.activeFieldSource = null;
      }
    }
    if (this.activeFieldSource === FieldSource.VAR && this.activeVarFieldIndex >= 0) {
      const field = this.varData?.fields?.[this.activeVarFieldIndex];
      if (field?._isDeleted === true) {
        this.activeVarFieldIndex = -1;
        this.activeFieldSource = null;
      }
    }
  }

  _applyOverlaysToFields(fields, source) {
    if (!fields || fields.length === 0) return;

    for (const field of fields) {
      if (!field) continue;
      if (field._isUserDefined === true && field._userDefinedId) {
        // User-defined fields are serialized with their current metadata.
        // Do not apply rename/delete/category overlays from registries.
        continue;
      }

      const originalKey = field._originalKey || field.key;
      if (!originalKey) continue;

      // Field rename overlay
      const displayKey = this._renameRegistry.getDisplayKey(source, originalKey);
      if (displayKey !== originalKey) {
        field._originalKey = originalKey;
        field.key = displayKey;
      } else if (field._originalKey) {
        // Registry says "no rename" -> restore original.
        field.key = originalKey;
        delete field._originalKey;
      }

      // Delete overlay
      if (this._deleteRegistry.isDeleted(source, originalKey)) {
        field._isDeleted = true;
      } else {
        delete field._isDeleted;
      }

      // Confirmed deletion (non-restorable)
      if (this._deleteRegistry.isPurged?.(source, originalKey)) {
        field._isPurged = true;
        field._isDeleted = true;
      } else {
        delete field._isPurged;
      }

      // Category rename overlay (only for categorical fields)
      if (field.kind === FieldKind.CATEGORY && Array.isArray(field.categories)) {
        // Reset categories back to originals if we have them.
        if (Array.isArray(field._originalCategories) && field._originalCategories.length === field.categories.length) {
          for (let i = 0; i < field.categories.length; i++) {
            field.categories[i] = field._originalCategories[i];
          }
        }

        // Apply registry renames.
        let hasAnyRename = false;
        for (let i = 0; i < field.categories.length; i++) {
          const originalLabel = field.categories[i];
          const displayLabel = this._renameRegistry.getDisplayCategory(source, originalKey, i, originalLabel);
          if (displayLabel !== originalLabel) {
            hasAnyRename = true;
          }
        }

        if (hasAnyRename && !Array.isArray(field._originalCategories)) {
          field._originalCategories = [...field.categories];
        }

        for (let i = 0; i < field.categories.length; i++) {
          const originalLabel = field._originalCategories?.[i] ?? field.categories[i];
          const displayLabel = this._renameRegistry.getDisplayCategory(source, originalKey, i, originalLabel);
          field.categories[i] = displayLabel;
          this._syncCentroidCategoryLabelAtIndex(field, i);
        }

        if (!hasAnyRename) {
          delete field._originalCategories;
        }
      }
    }
  }

  _injectUserDefinedFields() {
    this._injectUserDefinedFieldsForSource(FieldSource.OBS);
    this._injectUserDefinedFieldsForSource(FieldSource.VAR);
  }

  _injectUserDefinedFieldsForSource(source) {
    const src = source === FieldSource.VAR ? FieldSource.VAR : FieldSource.OBS;
    const fields = src === FieldSource.VAR ? this.varData?.fields : this.obsData?.fields;
    if (!fields) return;

    const existingIds = new Set();
    for (const field of fields) {
      if (field && field._isUserDefined && field._userDefinedId) {
        existingIds.add(field._userDefinedId);
      }
    }

    const templates = this._userDefinedFields.getAllFieldsForSource
      ? this._userDefinedFields.getAllFieldsForSource(src)
      : this._userDefinedFields.getAllFields();

    for (const template of templates) {
      if (!template || !template._userDefinedId) continue;
      if (existingIds.has(template._userDefinedId)) continue;

      // Clone the definition but keep heavy arrays shared (codes/centroidsByDim).
      const clone = { ...template };
      // Reset per-view UI/filter state so each view can diverge safely.
      delete clone._categoryColors;
      delete clone._categoryVisible;
      delete clone._continuousStats;
      delete clone._continuousFilter;
      delete clone._continuousColorRange;
      delete clone._categoryCounts;
      clone._loadingPromise = null;

      fields.push(clone);
    }
  }

  _syncCentroidCategoryLabelAtIndex(field, categoryIndex) {
    const nextLabel = field.categories?.[categoryIndex];
    if (!nextLabel) return;

    const byDim = field.centroidsByDim || {};
    for (const centroids of Object.values(byDim)) {
      if (!Array.isArray(centroids)) continue;
      const c = centroids[categoryIndex];
      if (c && typeof c === 'object') c.category = nextLabel;
    }
  }

  _refreshHighlightGroupsForField(source, fieldIndex) {
    for (const page of this.highlightPages || []) {
      for (const group of (page.highlightedGroups || [])) {
        if (!group) continue;
        if (group.fieldSource !== source) continue;
        if (group.fieldIndex !== fieldIndex) continue;

        const field = source === FieldSource.VAR
          ? this.varData?.fields?.[fieldIndex]
          : this.obsData?.fields?.[fieldIndex];
        if (!field) continue;

        group.fieldKey = field.key;

        if (group.type === 'category') {
          const label = field.categories?.[group.categoryIndex];
          if (label != null) group.categoryName = label;
          group.label = `${field.key}: ${group.categoryName}`;
        } else if (group.type === 'range') {
          const formatVal = (v) => {
            const num = Number(v);
            if (!Number.isFinite(num)) return String(v);
            if (Math.abs(num) >= 1000 || (Math.abs(num) > 0 && Math.abs(num) < 0.01)) return num.toExponential(2);
            return num.toFixed(2);
          };
          group.label = `${field.key}: ${formatVal(group.rangeMin)} – ${formatVal(group.rangeMax)}`;
        }
      }
    }

    this._notifyHighlightChange?.();
  }

  _ensureUserDefinedCentroidsForDim(field, dim) {
    if (!field || field._isUserDefined !== true || !field._userDefinedId) return;

    const dimKey = String(dim);
    const centroidsByDim = field.centroidsByDim || {};
    if (centroidsByDim[dimKey] || centroidsByDim[dim]) return;

    const rawPositions = this.dimensionManager?.positionCache?.get?.(dim);
    if (!rawPositions) return;

    this._userDefinedFields.recomputeCentroidsForDimension(field._userDefinedId, dim, rawPositions);

    // The new centroids are raw; make sure they are normalized exactly once when rendered.
    if (field._normalizedDims instanceof Set) {
      field._normalizedDims.delete(dimKey);
    }
  }
}

