/**
 * @fileoverview Filter Manager.
 *
 * Hosts visibility computation and filter summary logic.
 *
 * ⚡ PERFORMANCE CRITICAL: `computeGlobalVisibility()` runs on every filter change.
 *
 * @module state/managers/filter-manager
 */

import { rgbToCss, COLOR_PICKER_PALETTE, getCategoryColor } from '../../../data/palettes.js';
import { NEUTRAL_GRAY_UINT8 } from '../core/constants.js';
import { BaseManager } from '../core/base-manager.js';

const FULL_RANGE_EPSILON_FLOOR = 1e-9;
const FULL_RANGE_EPSILON_SCALE = 1e-6;

function getFullRangeEpsilon(stats) {
  const range = (stats?.max ?? 0) - (stats?.min ?? 0);
  if (!Number.isFinite(range) || range <= 0) return FULL_RANGE_EPSILON_FLOOR;
  const scaled = range * FULL_RANGE_EPSILON_SCALE;
  return scaled > FULL_RANGE_EPSILON_FLOOR ? scaled : FULL_RANGE_EPSILON_FLOOR;
}

function isContinuousFilterFullRange(filter, stats) {
  const epsilon = getFullRangeEpsilon(stats);
  return (
    filter.min <= stats.min + epsilon &&
    filter.max >= stats.max - epsilon
  );
}

export class DataStateFilterMethods {
  computeGlobalVisibility() {
    if (!this.obsData || !this.obsData.fields || !this.pointCount) return;
    const fields = this.obsData.fields;
    const pointCount = this.pointCount;
    const activeVarCandidate = (this.activeFieldSource === 'var' && this.activeVarFieldIndex >= 0)
      ? this.varData?.fields?.[this.activeVarFieldIndex]
      : null;
    const activeVarField = activeVarCandidate && activeVarCandidate._isDeleted !== true ? activeVarCandidate : null;
    const activeVarValues = activeVarField?.values || [];
    if (!this.categoryTransparency || this.categoryTransparency.length !== pointCount) {
      this.categoryTransparency = new Float32Array(pointCount);
    }

    const applyOutlierFilter = this.isOutlierFilterEnabledForActiveField();
    const outlierThreshold = applyOutlierFilter ? this.getCurrentOutlierThreshold() : 1.0;
    const outliers = applyOutlierFilter ? (this.outlierQuantilesArray || []) : [];

    const categoryFilters = [];
    const continuousFilters = [];

    for (let f = 0; f < fields.length; f++) {
      const field = fields[f];
      if (!field) continue;
      if (field._isDeleted === true) continue;

      if (field.kind === 'category' && field._categoryVisible && field._categoryFilterEnabled !== false) {
        const categories = field.categories || [];
        const numCats = categories.length;
        if (numCats > 0) {
          const visibleMap = field._categoryVisible;
          let hasHidden = false;
          for (let c = 0; c < numCats; c++) {
            if (visibleMap[c] === false) {
              hasHidden = true;
              break;
            }
          }
          if (hasHidden) {
            categoryFilters.push({ codes: field.codes || [], visibleMap, numCats });
          }
        }
      } else if (
        field.kind === 'continuous' &&
        field._continuousStats &&
        field._continuousFilter &&
        field._filterEnabled !== false
      ) {
        const stats = field._continuousStats;
        const filter = field._continuousFilter;
        if (!isContinuousFilterFullRange(filter, stats)) {
          continuousFilters.push({ values: field.values || [], min: filter.min, max: filter.max });
        }
      }
    }

    let activeVarFilterMin = null;
    let activeVarFilterMax = null;
    let activeVarFilterEnabled = false;
    if (
      activeVarField &&
      activeVarField.kind === 'continuous' &&
      activeVarField._continuousStats &&
      activeVarField._continuousFilter &&
      activeVarField._filterEnabled !== false
    ) {
      const stats = activeVarField._continuousStats;
      const filter = activeVarField._continuousFilter;
      if (!isContinuousFilterFullRange(filter, stats)) {
        activeVarFilterEnabled = true;
        activeVarFilterMin = filter.min;
        activeVarFilterMax = filter.max;
      }
    }

    const hasAnyFilter =
      categoryFilters.length > 0 ||
      continuousFilters.length > 0 ||
      activeVarFilterEnabled ||
      applyOutlierFilter;

    if (!hasAnyFilter) {
      this.categoryTransparency.fill(1.0, 0, pointCount);
    } else {
      for (let i = 0; i < pointCount; i++) {
        let visible = true;

        for (let cf = 0; cf < categoryFilters.length; cf++) {
          const filter = categoryFilters[cf];
          const code = filter.codes[i];
          if (code == null || code < 0 || code >= filter.numCats) continue;
          if (filter.visibleMap[code] === false) {
            visible = false;
            break;
          }
        }

        if (visible) {
          for (let cf = 0; cf < continuousFilters.length; cf++) {
            const filter = continuousFilters[cf];
            const v = filter.values[i];
            if (v === null || Number.isNaN(v) || v < filter.min || v > filter.max) {
              visible = false;
              break;
            }
          }
        }

        if (visible && activeVarFilterEnabled) {
          const v = activeVarValues[i];
          if (v === null || Number.isNaN(v) || v < activeVarFilterMin || v > activeVarFilterMax) {
            visible = false;
          }
        }

        // Apply outlier filter for the active field (only when supported).
        if (visible && applyOutlierFilter) {
          const q = (i < outliers.length) ? outliers[i] : -1;
          if (q >= 0 && q > outlierThreshold) visible = false;
        }

        this.categoryTransparency[i] = visible ? 1.0 : 0.0;
      }
    }

    this._syncColorsAlpha();
    const centroidsChanged = this._updateActiveCategoryCounts();
    this._pushTransparencyToViewer();
    if (centroidsChanged) this._pushCentroidsToViewer();
    this._syncActiveContext();
    this.updateFilteredCount();
    this.updateFilterSummary();
    this._notifyVisibilityChange();
  }

  updateFilterSummary() {
    const lines = this.getFilterSummaryLines();
    this.activeFilterLines = lines;
    this._pushActiveViewLabelToViewer(lines);
  }

  getFilterSummaryLines() {
    // Human-readable filter summaries (used for view labels + sidebar summary).
    const filters = this.getActiveFiltersStructured();
    if (filters.length === 0) return ['No filters active'];
    return filters.map(f => f.text);
  }

  getActiveFiltersStructured() {
    // Returns structured filter data with id, type, enabled state, and display text
    if (!this.obsData || !this.obsData.fields) return [];
    const fields = this.obsData.fields;
    const filters = [];

    for (let fi = 0; fi < fields.length; fi++) {
      const field = fields[fi];
      if (!field) continue;
      if (field._isDeleted === true) continue;
      const key = field.key || `Field ${fi + 1}`;

      // Continuous field filter
      if (field.kind === 'continuous' && field._continuousStats && field._continuousFilter) {
        const stats = field._continuousStats;
        const filter = field._continuousFilter;
        const fullRange = isContinuousFilterFullRange(filter, stats);
        if (!fullRange) {
          const enabled = field._filterEnabled !== false; // default true
          const disabledSuffix = enabled ? '' : ' (disabled)';
          filters.push({
            id: `obs-continuous-${fi}`,
            type: 'continuous',
            source: 'obs',
            fieldIndex: fi,
            fieldKey: key,
            enabled: enabled,
            text: `${key}: ${filter.min.toFixed(2)} – ${filter.max.toFixed(2)}${disabledSuffix}`
          });
        }
      }
      
      // Categorical field hidden categories
      if (field.kind === 'category') {
        const categories = field.categories || [];
        const visibleMap = field._categoryVisible || {};
        const hiddenNames = [];
        for (let i = 0; i < categories.length; i++) {
          const name = String(categories[i]);
          const isVisible = visibleMap[i] !== false;
          if (!isVisible) hiddenNames.push(name);
        }
        if (hiddenNames.length > 0) {
          const enabled = field._categoryFilterEnabled !== false; // default true
          const preview = hiddenNames.slice(0, 4).join(', ');
          const extra = hiddenNames.length > 4 ? ` +${hiddenNames.length - 4} more` : '';
          const disabledSuffix = enabled ? '' : ' (disabled)';
          filters.push({
            id: `obs-category-${fi}`,
            type: 'category',
            source: 'obs',
            fieldIndex: fi,
            fieldKey: key,
            enabled: enabled,
            hiddenCount: hiddenNames.length,
            text: `${key}: hiding ${preview}${extra}${disabledSuffix}`
          });
        }
        
        // Outlier filter
        if (field.outlierQuantiles && field.outlierQuantiles.length) {
          const threshold = field._outlierThreshold != null ? field._outlierThreshold : 1.0;
          if (threshold < 0.9999) {
            const enabled = field._outlierFilterEnabled !== false; // default true
            const pct = Math.round(threshold * 100);
            const disabledSuffix = enabled ? '' : ' (disabled)';
            filters.push({
              id: `obs-outlier-${fi}`,
              type: 'outlier',
              source: 'obs',
              fieldIndex: fi,
              fieldKey: key,
              enabled: enabled,
              text: `${key}: outlier ≤ ${pct}%${disabledSuffix}`
            });
          }
        }
      }
    }
    
    // Var field (gene expression) filter
    if (
      this.activeFieldSource === 'var' &&
      this.activeVarFieldIndex >= 0 &&
      this.varData &&
      this.varData.fields
    ) {
      const field = this.varData.fields[this.activeVarFieldIndex];
      if (field && field._isDeleted !== true && field.kind === 'continuous' && field._continuousStats && field._continuousFilter) {
        const stats = field._continuousStats;
        const filter = field._continuousFilter;
        const fullRange = isContinuousFilterFullRange(filter, stats);
        if (!fullRange) {
          const enabled = field._filterEnabled !== false; // default true
          const disabledSuffix = enabled ? '' : ' (disabled)';
          filters.push({
            id: `var-continuous-${this.activeVarFieldIndex}`,
            type: 'continuous',
            source: 'var',
            fieldIndex: this.activeVarFieldIndex,
            fieldKey: field.key,
            enabled: enabled,
            text: `${field.key}: ${filter.min.toFixed(2)} – ${filter.max.toFixed(2)}${disabledSuffix}`
          });
        }
      }
    }

    return filters;
  }

  toggleFilterEnabled(filterId, enabled) {
    // Toggle filter on/off without removing it
    const parts = filterId.split('-');
    const source = parts[0]; // 'obs' or 'var'
    const type = parts[1]; // 'continuous', 'category', or 'outlier'
    const fieldIndex = parseInt(parts[2], 10);
    
    let field = null;
    if (source === 'obs') {
      field = this.obsData?.fields?.[fieldIndex];
    } else if (source === 'var') {
      field = this.varData?.fields?.[fieldIndex];
    }
    if (!field) return;
    
    if (type === 'continuous') {
      field._filterEnabled = enabled;
    } else if (type === 'category') {
      field._categoryFilterEnabled = enabled;
    } else if (type === 'outlier') {
      field._outlierFilterEnabled = enabled;
      // Outlier filter affects the outlierQuantilesArray
      this.updateOutlierQuantiles();
    }
    
    this.computeGlobalVisibility();
    this.updateFilterSummary();
  }

  removeFilter(filterId) {
    // Remove filter completely (reset to full range or show all categories)
    const parts = filterId.split('-');
    const source = parts[0]; // 'obs' or 'var'
    const type = parts[1]; // 'continuous', 'category', or 'outlier'
    const fieldIndex = parseInt(parts[2], 10);
    
    let field = null;
    if (source === 'obs') {
      field = this.obsData?.fields?.[fieldIndex];
    } else if (source === 'var') {
      field = this.varData?.fields?.[fieldIndex];
    }
    if (!field) return;
    
    if (type === 'continuous') {
      // Reset to full range
      if (field._continuousStats && field._continuousFilter) {
        field._continuousFilter.min = field._continuousStats.min;
        field._continuousFilter.max = field._continuousStats.max;
      }
      field._filterEnabled = true;
    } else if (type === 'category') {
      // Show all categories
      const categories = field.categories || [];
      if (!field._categoryVisible) field._categoryVisible = {};
      for (let i = 0; i < categories.length; i++) {
        field._categoryVisible[i] = true;
      }
      field._categoryFilterEnabled = true;
      // Update colors to reflect all categories visible
      this.reapplyCategoryColors(field);
    } else if (type === 'outlier') {
      // Reset outlier threshold to 100%
      field._outlierThreshold = 1.0;
      field._outlierFilterEnabled = true;
      this.updateOutlierQuantiles();
    }
    
    this.computeGlobalVisibility();
    this.updateFilterSummary();
  }

  reapplyCategoryColors(field) {
    if (!field || field.kind !== 'category') return;
    this._reapplyCategoryColorsNoRecompute(field);
    // Let computeGlobalVisibility handle transparency/filtering
    this.computeGlobalVisibility();
  }

  /**
   * Update color array for a category field without triggering visibility recomputation.
   * Used by batch mode to defer the expensive computeGlobalVisibility() call.
   */
  _reapplyCategoryColorsNoRecompute(field) {
    if (!field || field.kind !== 'category') return;
    const n = this.pointCount;
    const categories = field.categories || [];
    const codes = field.codes || [];
    const catColors = field._categoryColors || [];
    const catVisible = field._categoryVisible || {};
    const numCats = categories.length;
    if (!this.categoryTransparency) this.categoryTransparency = new Float32Array(this.pointCount);

    for (let i = 0; i < n; i++) {
      const code = codes[i];
      let r, g, b;
      if (code == null || code < 0 || code >= numCats) {
        r = NEUTRAL_GRAY_UINT8; g = NEUTRAL_GRAY_UINT8; b = NEUTRAL_GRAY_UINT8;
      } else {
        const isVisible = catVisible[code] !== false;
        const c = catColors[code] || getCategoryColor(code) || [0.5, 0.5, 0.5];
        if (!isVisible) {
          // Gray out hidden categories (visual indicator), but don't set transparency here
          r = g = b = 128; // gray in uint8
        } else {
          // Convert from 0-1 float to 0-255 uint8
          r = Math.round(c[0] * 255);
          g = Math.round(c[1] * 255);
          b = Math.round(c[2] * 255);
        }
      }
      const j = i * 4;
      this.colorsArray[j] = r;
      this.colorsArray[j + 1] = g;
      this.colorsArray[j + 2] = b;
    }
    this._syncColorsAlpha();
    this._pushColorsToViewer();
  }

  getLegendModel(field) {
    return this.updateLegendState(field);
  }

  getFilterLines() {
    return this.activeFilterLines || [];
  }

  getColorPalette() {
    return COLOR_PICKER_PALETTE;
  }

  getColorForCategory(field, idx) {
    this.ensureCategoryMetadata(field);
    const numCats = field.categories?.length ?? 0;
    if (!Number.isFinite(idx) || idx < 0 || idx >= numCats) {
      return getCategoryColor(idx);
    }
    const color = field._categoryColors[idx];
    if (color && color.length === 3) return color;
    const fallback = getCategoryColor(idx);
    if (!field._categoryColors[idx]) field._categoryColors[idx] = fallback;
    return fallback;
  }

  setColorForCategory(field, idx, color) {
    this.ensureCategoryMetadata(field);
    const fallback = getCategoryColor(idx);
    field._categoryColors[idx] = color || fallback;
    if (this._batchMode) {
      this._batchDirty.colors = true;
      this._batchDirty.affectedFields.add(field);
    } else {
      this.reapplyCategoryColors(field);
    }
  }

  setVisibilityForCategory(field, idx, visible) {
    this.ensureCategoryMetadata(field);
    field._categoryVisible[idx] = visible;
    if (this._batchMode) {
      this._batchDirty.visibility = true;
      this._batchDirty.colors = true; // visibility changes affect color display
      this._batchDirty.affectedFields.add(field);
    } else {
      this.reapplyCategoryColors(field);
    }
  }

  showAllCategories(field, { onlyAvailable = false } = {}) {
    this.ensureCategoryMetadata(field);
    const categories = field.categories || [];
    const available = onlyAvailable && field._categoryCounts ? field._categoryCounts.available : null;
    for (let i = 0; i < categories.length; i++) {
      if (available && (available[i] || 0) <= 0) continue;
      field._categoryVisible[i] = true;
    }
    this.reapplyCategoryColors(field);
  }

  hideAllCategories(field, { onlyAvailable = false } = {}) {
    this.ensureCategoryMetadata(field);
    const categories = field.categories || [];
    const available = onlyAvailable && field._categoryCounts ? field._categoryCounts.available : null;
    for (let i = 0; i < categories.length; i++) {
      if (available && (available[i] || 0) <= 0) continue;
      field._categoryVisible[i] = false;
    }
    this.reapplyCategoryColors(field);
  }

  rgbToCss(color) { return rgbToCss(color); }

  clearActiveField() {
    this.activeFieldIndex = -1;
    this.activeVarFieldIndex = -1;
    this.activeFieldSource = null;
    if (this.colorsArray) {
      // Fill with neutral gray (RGB) and full alpha
      for (let i = 0; i < this.pointCount; i++) {
        const idx = i * 4;
        this.colorsArray[idx] = NEUTRAL_GRAY_UINT8;
        this.colorsArray[idx + 1] = NEUTRAL_GRAY_UINT8;
        this.colorsArray[idx + 2] = NEUTRAL_GRAY_UINT8;
        this.colorsArray[idx + 3] = 255;
      }
    }
    if (!this.categoryTransparency || this.categoryTransparency.length !== this.pointCount) {
      this.categoryTransparency = new Float32Array(this.pointCount);
    }
    this.categoryTransparency.fill(1.0);
    if (this.outlierQuantilesArray) {
      this.outlierQuantilesArray.fill(-1.0);
      this._pushOutliersToViewer();
    }
    this._pushColorsToViewer();
    this._pushTransparencyToViewer();
    this._pushOutlierThresholdToViewer(1.0);
    this.clearCentroids();
    this.computeGlobalVisibility();
    this.updateFilterSummary();
    this._syncActiveContext();
    this._activeCategoryCounts = null;
    return {
      field: null,
      pointCount: this.pointCount,
      centroidInfo: ''
    };
  }

  // Snapshot payload for small multiples (Keep view)
  getSnapshotPayload() {
    const {
      label,
      fieldKey,
      fieldKind,
      filtersText
    } = this._computeActiveViewLabel();

    return {
      pointCount: this.pointCount,
      label,
      fieldKey,
      fieldKind,
      colors: this.colorsArray ? new Uint8Array(this.colorsArray) : null,
      transparency: this.categoryTransparency
        ? new Float32Array(this.categoryTransparency)
        : null,
      outlierQuantiles: this.outlierQuantilesArray
        ? new Float32Array(this.outlierQuantilesArray)
        : null,
      centroidPositions: this.centroidPositions
        ? new Float32Array(this.centroidPositions)
        : null,
      centroidColors: this.centroidColors
        ? new Uint8Array(this.centroidColors) // RGBA uint8
        : null,
      centroidOutliers: this.centroidOutliers
        ? new Float32Array(this.centroidOutliers)
        : null,
      outlierThreshold: this.getCurrentOutlierThreshold(),
      filtersText,
      dimensionLevel: this.activeDimensionLevel // Include dimension level for Keep View
    };
  }
}

export class FilterManager extends BaseManager {
  constructor(coordinator) {
    super(coordinator);
  }
}
