/**
 * @fileoverview DataState field loading + activation.
 *
 * Responsibilities:
 * - Materialize obs/var field arrays via loader functions (with LRU caching)
 * - Support user-defined continuous aliases by copying from stable source keys
 * - Activate a field as the current coloring/filter driver
 *
 * Mixed into DataState via `state/managers/field-manager.js`.
 *
 * @module state/managers/field/loading
 */

import { getNotificationCenter } from '../../../notification-center.js';
import { FieldKind, FieldSource } from '../../../utils/field-constants.js';
import { getFieldRegistry } from '../../../utils/field-registry.js';

export class FieldLoadingMethods {
  setFieldLoader(loaderFn) {
    this.fieldLoader = loaderFn;
  }

  setVarFieldLoader(loaderFn) {
    this.varFieldLoader = loaderFn;
  }

  initVarData(varManifest) {
    if (!varManifest) return;
    const normalizedFields = (varManifest?.fields || []).map((field) => ({
      ...field,
      loaded: Boolean(field?.values),
      _loadingPromise: null
    }));
    this.varData = { ...varManifest, fields: normalizedFields };
  }

  /**
   * Ensure a field is loaded before use.
   * @param {number} fieldIndex - Index of the field in obsData.fields
   * @param {Object} [options] - Options
   * @param {boolean} [options.silent=false] - If true, suppress notifications (for batch operations)
   * @returns {Promise<Object>} The loaded field object
   */
  async ensureFieldLoaded(fieldIndex, options = {}) {
    const { silent = false } = options;
    const field = this.obsData?.fields?.[fieldIndex];
    if (!field) throw new Error(`Obs field ${fieldIndex} is not available.`);
    const cacheKey = field._originalKey || field.key || String(fieldIndex);

    // User-defined continuous aliases are materialized by copying from their source field.
    if (
      field.loaded !== true &&
      field._isUserDefined === true &&
      field._userDefinedId &&
      field.kind === FieldKind.CONTINUOUS &&
      field._sourceField?.sourceKey
    ) {
      const sourceKey = String(field._sourceField.sourceKey || '').trim();
      const sourceIndex = sourceKey ? getFieldRegistry().getIndexByKey(FieldSource.OBS, sourceKey) : -1;
      if (sourceIndex < 0) {
        throw new Error(`Source field not found for "${field.key}" (sourceKey="${sourceKey}")`);
      }

      const sourceField = await this.ensureFieldLoaded(sourceIndex, options);
      const values = sourceField?.values;
      if (!values || typeof values.length !== 'number') {
        throw new Error(`Source field "${sourceKey}" has no values to copy`);
      }

      // IMPORTANT (large datasets): do not copy value arrays for aliases.
      // User-defined continuous "copies" are read-only aliases, so sharing the
      // underlying typed array avoids O(n) allocation and ~2× memory overhead.
      field.values = values;
      if (sourceField?.outlierQuantiles) field.outlierQuantiles = sourceField.outlierQuantiles;
      field.loaded = true;
      field._loadingPromise = null;
      this._fieldDataCache.set(cacheKey, { values: field.values, outlierQuantiles: field.outlierQuantiles });
      return field;
    }

    if (field.loaded) {
      if (!this._fieldDataCache.has(cacheKey)) {
        this._fieldDataCache.set(cacheKey, {
          values: field.values,
          codes: field.codes,
          outlierQuantiles: field.outlierQuantiles
        });
      }
      return field;
    }
    if (field._loadingPromise) return field._loadingPromise;
    if (!this.fieldLoader) throw new Error(`No loader configured for field "${field.key}".`);

    const cached = this._fieldDataCache.get(cacheKey);
    if (cached) {
      if (cached.values) field.values = cached.values;
      if (cached.codes) field.codes = cached.codes;
      if (cached.outlierQuantiles) field.outlierQuantiles = cached.outlierQuantiles;
      field.loaded = true;
      return field;
    }

    // Show loading notification (unless silent mode for batch operations)
    const notifications = getNotificationCenter();
    const notifId = silent ? null : notifications.loading(`Loading field: ${field.key}`, { category: 'data' });

    // If the field has been renamed, keep network/data lookups stable by loading using the original key.
    const loaderField = field._originalKey ? { ...field, key: field._originalKey } : field;

    field._loadingPromise = this.fieldLoader(loaderField)
      .then((loadedData) => {
        if (loadedData?.values) field.values = loadedData.values;
        if (loadedData?.codes) field.codes = loadedData.codes;
        if (loadedData?.outlierQuantiles) field.outlierQuantiles = loadedData.outlierQuantiles;
        if (field.values && field.values.length !== this.pointCount) {
          throw new Error(`Field "${field.key}" values length mismatch (${field.values.length} vs ${this.pointCount}).`);
        }
        if (field.codes && field.codes.length !== this.pointCount) {
          throw new Error(`Field "${field.key}" codes length mismatch (${field.codes.length} vs ${this.pointCount}).`);
        }
        if (field.outlierQuantiles && field.outlierQuantiles.length !== this.pointCount) {
          throw new Error(`Field "${field.key}" outlier length mismatch (${field.outlierQuantiles.length} vs ${this.pointCount}).`);
        }
        field.loaded = true;
        field._loadingPromise = null;
        this._fieldDataCache.set(cacheKey, {
          values: field.values,
          codes: field.codes,
          outlierQuantiles: field.outlierQuantiles
        });
        if (notifId) notifications.complete(notifId, `Loaded field: ${field.key}`);
        return field;
      })
      .catch((err) => {
        field._loadingPromise = null;
        if (notifId) notifications.fail(notifId, `Failed to load field: ${field.key}`);
        throw err;
      });

    return field._loadingPromise;
  }

  /**
   * Ensure a var field (gene) is loaded before use.
   * @param {number} fieldIndex - Index of the field in varData.fields
   * @param {Object} [options] - Options
   * @param {boolean} [options.silent=false] - If true, suppress notifications (for batch operations)
   * @returns {Promise<Object>} The loaded field object
   */
  async ensureVarFieldLoaded(fieldIndex, options = {}) {
    const { silent = false } = options;
    const field = this.varData?.fields?.[fieldIndex];
    if (!field) throw new Error(`Var field ${fieldIndex} is not available.`);
    const cacheKey = field._originalKey || field.key || String(fieldIndex);

    // User-defined continuous aliases (gene copies) are materialized by copying from their source gene.
    if (
      field.loaded !== true &&
      field._isUserDefined === true &&
      field._userDefinedId &&
      field.kind === FieldKind.CONTINUOUS &&
      field._sourceField?.sourceKey
    ) {
      const sourceKey = String(field._sourceField.sourceKey || '').trim();
      const sourceIndex = sourceKey ? getFieldRegistry().getIndexByKey(FieldSource.VAR, sourceKey) : -1;
      if (sourceIndex < 0) {
        throw new Error(`Source gene not found for "${field.key}" (sourceKey="${sourceKey}")`);
      }

      const sourceField = await this.ensureVarFieldLoaded(sourceIndex, options);
      const values = sourceField?.values;
      if (!values || typeof values.length !== 'number') {
        throw new Error(`Source gene "${sourceKey}" has no values to copy`);
      }

      // See note above: aliases share the underlying values array to avoid
      // duplicating large Float32Array gene-expression buffers.
      field.values = values;
      field.loaded = true;
      field._loadingPromise = null;
      this._varFieldDataCache.set(cacheKey, { values: field.values });
      return field;
    }

    if (field.loaded) {
      if (!this._varFieldDataCache.has(cacheKey)) {
        this._varFieldDataCache.set(cacheKey, { values: field.values });
      }
      return field;
    }
    if (field._loadingPromise) return field._loadingPromise;
    if (!this.varFieldLoader) throw new Error(`No loader configured for var field "${field.key}".`);

    const cached = this._varFieldDataCache.get(cacheKey);
    if (cached) {
      if (cached.values) field.values = cached.values;
      field.loaded = true;
      return field;
    }

    // Show loading notification for gene expression (unless silent mode for batch operations)
    const notifications = getNotificationCenter();
    const notifId = silent ? null : notifications.loading(`Loading gene: ${field.key}`, { category: 'data' });

    // If the gene has been renamed, load using the original key for stable lookups.
    const loaderField = field._originalKey ? { ...field, key: field._originalKey } : field;

    field._loadingPromise = this.varFieldLoader(loaderField)
      .then((loadedData) => {
        if (loadedData?.values) field.values = loadedData.values;
        if (field.values && field.values.length !== this.pointCount) {
          throw new Error(`Var field "${field.key}" values length mismatch (${field.values.length} vs ${this.pointCount}).`);
        }
        field.loaded = true;
        field._loadingPromise = null;
        this._varFieldDataCache.set(cacheKey, { values: field.values });
        if (notifId) notifications.complete(notifId, `Loaded gene: ${field.key}`);
        return field;
      })
      .catch((err) => {
        field._loadingPromise = null;
        if (notifId) notifications.fail(notifId, `Failed to load gene: ${field.key}`);
        throw err;
      });

    return field._loadingPromise;
  }

  /**
   * Unload a var field (gene) to free memory.
   *
   * Note: Genes loaded for bulk analyses (e.g., differential expression) can otherwise
   * accumulate in memory because loaded arrays are referenced from `varData.fields`.
   *
   * @param {number} fieldIndex - Index of the field in varData.fields
   * @param {Object} [options]
   * @param {boolean} [options.preserveActive=true] - If true, do not unload an active gene field
   * @returns {boolean} True if unloaded
   */
  unloadVarField(fieldIndex, options = {}) {
    const { preserveActive = true } = options;

    if (!Number.isInteger(fieldIndex) || fieldIndex < 0) return false;

    const isActiveInCurrent =
      this.activeFieldSource === 'var' && this.activeVarFieldIndex === fieldIndex;

    if (preserveActive && isActiveInCurrent) {
      return false;
    }

    // If this field is active in any saved view context, optionally preserve it too.
    if (preserveActive) {
      for (const ctx of this.viewContexts.values()) {
        if (!ctx) continue;
        if (ctx.activeFieldSource === 'var' && ctx.activeVarFieldIndex === fieldIndex) {
          return false;
        }
      }
    }

    const field = this.varData?.fields?.[fieldIndex];
    if (!field) return false;

    const cacheKey = field._originalKey || field.key || String(fieldIndex);

    // Clear LRU reference first so it doesn't keep the ArrayBuffer alive.
    this._varFieldDataCache?.delete?.(cacheKey);

    const clearFieldState = (f) => {
      if (!f) return;
      f.values = null;
      f.loaded = false;
      f._loadingPromise = null;
    };

    // Clear from current varData
    clearFieldState(field);

    // Clear from all stored view contexts (they clone field objects but may share values refs)
    for (const ctx of this.viewContexts.values()) {
      const ctxField = ctx?.varData?.fields?.[fieldIndex];
      if (!ctxField) continue;
      if ((ctxField.key || String(fieldIndex)) === cacheKey) {
        clearFieldState(ctxField);
      }
    }

    // If the gene was active and we were asked to unload anyway, reset active state.
    if (isActiveInCurrent && !preserveActive && typeof this.clearActiveField === 'function') {
      try {
        this.clearActiveField();
      } catch (err) {
        console.warn('[DataState] Failed to clear active field after unload:', err);
      }
    }

    return true;
  }

  setActiveField(fieldIndex) {
    const nextField = this.obsData?.fields?.[fieldIndex];
    if (!nextField || nextField._isDeleted === true) return null;
    this.activeFieldIndex = fieldIndex;
    this.activeVarFieldIndex = -1;
    this.activeFieldSource = 'obs';
    const field = nextField;
    if (!field.loaded) {
      throw new Error(`Field "${field.key}" not loaded yet.`);
    }

    if (field.kind === 'continuous') {
      this.updateColorsContinuous(field, { resetTransparency: true });
      this.clearCentroids();
    } else {
      this.updateColorsCategorical(field);
      this.buildCentroidsForField(field);
    }

    if (field.outlierQuantiles && field.outlierQuantiles.length > 0) {
      if (field._outlierThreshold == null) field._outlierThreshold = 1.0;
    }

    this.updateOutlierQuantiles();
    this._pushColorsToViewer();
    this._pushTransparencyToViewer();
    this._pushCentroidsToViewer();
    this._pushOutlierThresholdToViewer(this.getCurrentOutlierThreshold());
    this.computeGlobalVisibility();
    this._syncActiveContext();
    this._pushActiveViewLabelToViewer();

    const currentCentroids = this._getCentroidsForCurrentDim(field);
    const centroidInfo =
      field.kind === 'category' && currentCentroids.length > 0 ? ` • Centroids: ${currentCentroids.length}` : '';
    return {
      field,
      pointCount: this.pointCount,
      centroidInfo
    };
  }

  setActiveVarField(fieldIndex) {
    const nextField = this.varData?.fields?.[fieldIndex];
    if (!nextField || nextField._isDeleted === true) return null;
    this.activeVarFieldIndex = fieldIndex;
    this.activeFieldIndex = -1;
    this.activeFieldSource = 'var';
    const field = nextField;
    if (!field.loaded) {
      throw new Error(`Var field "${field.key}" not loaded yet.`);
    }

    // Gene expression is always continuous
    this.updateColorsContinuous(field, { resetTransparency: true });
    this.clearCentroids();

    this.updateOutlierQuantiles();
    this._pushColorsToViewer();
    this._pushTransparencyToViewer();
    this._pushCentroidsToViewer();
    this._pushOutlierThresholdToViewer(1.0);
    this.computeGlobalVisibility();
    this._syncActiveContext();
    this._pushActiveViewLabelToViewer();

    return {
      field,
      pointCount: this.pointCount,
      centroidInfo: ''
    };
  }

  getContinuousFieldRef(fieldIndex) {
    if (this.activeFieldSource === 'var' && this.activeVarFieldIndex >= 0) {
      const field = this.varData?.fields?.[this.activeVarFieldIndex];
      return { field, source: 'var', index: this.activeVarFieldIndex };
    }
    const idx = fieldIndex != null ? fieldIndex : this.activeFieldIndex;
    if (idx == null || idx < 0) return { field: null, source: null, index: -1 };
    const field = this.obsData?.fields?.[idx];
    return { field, source: 'obs', index: idx };
  }

  updateOutlierQuantiles() {
    if (!this.pointCount || !this.obsData || !this.obsData.fields) return;

    if (!this.outlierQuantilesArray || this.outlierQuantilesArray.length !== this.pointCount) {
      this.outlierQuantilesArray = new Float32Array(this.pointCount);
    }
    this.outlierQuantilesArray.fill(-1.0);

    const fields = this.obsData.fields;
    for (let f = 0; f < fields.length; f++) {
      const field = fields[f];
      if (field?._isDeleted === true) continue;
      if (!field || !field.outlierQuantiles || !field.outlierQuantiles.length) continue;
      
      // Check if outlier filter is enabled
      const outlierFilterEnabled = field._outlierFilterEnabled !== false;
      if (!outlierFilterEnabled) continue;
      
      const rawThreshold = field._outlierThreshold != null ? field._outlierThreshold : 1.0;
      if (rawThreshold >= 0.9999) continue;

      const threshold = Math.max(rawThreshold, 0.001);
      const qList = field.outlierQuantiles;
      for (let i = 0; i < this.pointCount; i++) {
        const q = qList[i];
        if (q === null || q === undefined || Number.isNaN(q)) continue;
        if (q > rawThreshold) {
          const ratio = q / threshold;
          if (this.outlierQuantilesArray[i] < 0 || ratio > this.outlierQuantilesArray[i]) {
            this.outlierQuantilesArray[i] = ratio;
          }
        }
      }
    }

    this._pushOutliersToViewer();
    this._syncActiveContext();
    this.updateFilteredCount();
    this.updateFilterSummary();
    this._notifyVisibilityChange();
  }
}
