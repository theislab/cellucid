/**
 * @fileoverview DataState field summaries and per-filter counts.
 *
 * Provides:
 * - View-specific active field and filter summary accessors
 * - Fast filtered count bookkeeping for large datasets
 * - Category and continuous filter cell count helpers used by UI
 *
 * Mixed into DataState via `state/managers/field-manager.js`.
 *
 * @module state/managers/field/summary
 */

export class FieldSummaryMethods {
  /**
   * Get the active field for a specific view (without switching to it).
   * Returns null if viewId is invalid or has no active field.
   */
  getFieldForView(viewId) {
    const key = String(viewId || 'live');
    if (key === String(this.activeViewId)) {
      return this.getActiveField();
    }
    const ctx = this.viewContexts.get(key);
    if (!ctx) return null;
    const source = ctx.activeFieldSource;
    if (source === 'var') {
      const varFields = ctx.varData?.fields || [];
      const idx = ctx.activeVarFieldIndex ?? -1;
      return idx >= 0 ? varFields[idx] : null;
    }
    const obsFields = ctx.obsData?.fields || [];
    const idx = ctx.activeFieldIndex ?? -1;
    return idx >= 0 ? obsFields[idx] : null;
  }

  /**
   * Get the filter summary for a specific view (without switching to it).
   */
  getFilterSummaryForView(viewId) {
    const key = String(viewId || 'live');
    if (key === String(this.activeViewId)) {
      return this.getFilterSummaryLines();
    }
    const ctx = this.viewContexts.get(key);
    if (!ctx || !ctx.obsData || !ctx.obsData.fields) return [];

    const filters = [];
    const fields = ctx.obsData.fields;

    for (let fi = 0; fi < fields.length; fi++) {
      const field = fields[fi];
      if (!field) continue;
      if (field._isDeleted === true) continue;
      const fieldKey = field.key || `Field ${fi + 1}`;

      // Check continuous filter
      if (field.kind === 'continuous' && field._continuousStats && field._continuousFilter) {
        const stats = field._continuousStats;
        const filter = field._continuousFilter;
        const fullRange = filter.min <= stats.min + 1e-6 && filter.max >= stats.max - 1e-6;
        if (!fullRange && field._filterEnabled !== false) {
          filters.push(`${fieldKey}: ${filter.min.toFixed(2)} – ${filter.max.toFixed(2)}`);
        }
      }

      // Check category filter
      if (field.kind === 'category') {
        const categories = field.categories || [];
        const visibleMap = field._categoryVisible || {};
        const hiddenNames = [];
        for (let i = 0; i < categories.length; i++) {
          if (visibleMap[i] === false) {
            hiddenNames.push(String(categories[i]));
          }
        }
        if (hiddenNames.length > 0 && field._categoryFilterEnabled !== false) {
          const preview = hiddenNames.slice(0, 2).join(', ');
          const extra = hiddenNames.length > 2 ? ` +${hiddenNames.length - 2}` : '';
          filters.push(`${fieldKey}: hiding ${preview}${extra}`);
        }
      }
    }

    return filters.length > 0 ? filters : ['No filters active'];
  }

  updateFilteredCount() {
    if (!this.pointCount) {
      this.filteredCount = { shown: 0, total: 0 };
      return;
    }
    const total = this.pointCount;
    const applyOutlierFilter = this.isOutlierFilterEnabledForActiveField();
    const threshold = applyOutlierFilter ? this.getCurrentOutlierThreshold() : 1.0;
    const outliers = applyOutlierFilter ? (this.outlierQuantilesArray || []) : [];
    const alpha = this.categoryTransparency || [];
    let shown = 0;
    for (let i = 0; i < total; i++) {
      const visible = (alpha[i] ?? 0) > 0.001;
      if (!visible) continue;
      // Only apply outlier filter when supported by the active field.
      if (applyOutlierFilter) {
        const q = outliers[i] ?? -1;
        if (q >= 0 && q > threshold) continue;
      }
      shown++;
    }
    this.filteredCount = { shown, total };
  }

  getFilteredCount() {
    return this.filteredCount || { shown: this.pointCount, total: this.pointCount };
  }

  computeCategoryCountsForField(field) {
    if (!field || field.kind !== 'category') return null;
    const categories = field.categories || [];
    const codes = field.codes || [];
    const total = new Array(categories.length).fill(0);
    const available = new Array(categories.length).fill(0); // respects other filters, ignores this field's category visibility
    const visible = new Array(categories.length).fill(0); // respects all filters including this field's category visibility
    const alpha = this.categoryTransparency || [];
    const applyOutlierFilter = this.isOutlierFilterEnabledForActiveField();
    const outliers = applyOutlierFilter ? (this.outlierQuantilesArray || []) : [];
    const threshold = applyOutlierFilter ? this.getCurrentOutlierThreshold() : 1.0;
    const n = Math.min(this.pointCount, codes.length);
    const fields = this.obsData?.fields || [];
    const targetIndex = fields.indexOf(field);
    const activeVarField =
      this.activeFieldSource === 'var' && this.activeVarFieldIndex >= 0
        ? this.varData?.fields?.[this.activeVarFieldIndex]
        : null;
    const activeVarValues = activeVarField?.values || [];

    for (let i = 0; i < n; i++) {
      const code = codes[i];
      if (code == null || code < 0 || code >= categories.length) continue;
      total[code]++;

      // Compute visibility from other filters (but ignoring this field's own category visibility)
      let baseVisible = true;
      for (let f = 0; f < fields.length; f++) {
        const fField = fields[f];
        if (!fField) continue;
        if (f === targetIndex) {
          // Ignore this field's category visibility for "available" counts
          continue;
        }
        if (fField.kind === 'category' && fField._categoryVisible) {
          const categoryFilterEnabled = fField._categoryFilterEnabled !== false;
          if (categoryFilterEnabled) {
            const codesOther = fField.codes || [];
            const catsOther = fField.categories || [];
            const numCatsOther = catsOther.length;
            const cCode = codesOther[i];
            if (cCode != null && cCode >= 0 && cCode < numCatsOther) {
              const isVis = fField._categoryVisible[cCode] !== false;
              if (!isVis) { baseVisible = false; break; }
            }
          }
        } else if (
          fField.kind === 'continuous' &&
          fField._continuousStats &&
          fField._continuousFilter
        ) {
          const filterEnabled = fField._filterEnabled !== false;
          if (filterEnabled) {
            const stats = fField._continuousStats;
            const filter = fField._continuousFilter;
            const values = fField.values || [];
            const fullRange =
              filter.min <= stats.min + 1e-6 &&
              filter.max >= stats.max - 1e-6;
            if (!fullRange) {
              const v = values[i];
              if (v === null || Number.isNaN(v) || v < filter.min || v > filter.max) {
                baseVisible = false;
                break;
              }
            }
          }
        }
      }
      if (baseVisible && activeVarField && activeVarField.kind === 'continuous') {
        const filterEnabled = activeVarField._filterEnabled !== false;
        if (filterEnabled && activeVarField._continuousStats && activeVarField._continuousFilter) {
          const stats = activeVarField._continuousStats;
          const filter = activeVarField._continuousFilter;
          const fullRange =
            filter.min <= stats.min + 1e-6 &&
            filter.max >= stats.max - 1e-6;
          if (!fullRange) {
            const v = activeVarValues[i];
            if (v === null || Number.isNaN(v) || v < filter.min || v > filter.max) {
              baseVisible = false;
            }
          }
        }
      }
      // Only apply outlier filter when supported by the active field.
      if (baseVisible && applyOutlierFilter) {
        const q = outliers[i] ?? -1;
        if (q >= 0 && q > threshold) {
          baseVisible = false;
        }
      }
      if (baseVisible) available[code]++;

      // Current visibility already encoded in alpha + outliers
      const isVisibleNow = (alpha[i] ?? 0) > 0.001;
      if (!isVisibleNow) continue;
      // Only apply outlier filter when supported by the active field.
      if (applyOutlierFilter) {
        const qNow = outliers[i] ?? -1;
        if (qNow >= 0 && qNow > threshold) continue;
      }
      visible[code]++;
    }
    const visibleTotal = visible.reduce((sum, v) => sum + v, 0);
    const availableTotal = available.reduce((sum, v) => sum + v, 0);
    return { total, available, availableTotal, visible, visibleTotal };
  }

  _computeCountsForContinuous(field, source, { ignoreSelfFilter = false } = {}) {
    if (!field || field.kind !== 'continuous') return null;
    const n = this.pointCount || 0;
    if (!n) return { available: 0, visible: 0 };
    const obsFields = this.obsData?.fields || [];
    const activeVarField =
      this.activeFieldSource === 'var' && this.activeVarFieldIndex >= 0
        ? this.varData?.fields?.[this.activeVarFieldIndex]
        : null;
    const activeVarValues = activeVarField?.values || [];
    const targetValues = field.values || [];
    const applyOutlierFilter = this.isOutlierFilterEnabledForActiveField();
    const outliers = applyOutlierFilter ? (this.outlierQuantilesArray || []) : [];
    const threshold = applyOutlierFilter ? this.getCurrentOutlierThreshold() : 1.0;
    let available = 0;
    let visible = 0;

    for (let i = 0; i < n; i++) {
      let passes = true;

      for (let f = 0; f < obsFields.length; f++) {
        const obsField = obsFields[f];
        if (!obsField) continue;
        if (obsField.kind === 'category' && obsField._categoryVisible) {
          const categoryFilterEnabled = obsField._categoryFilterEnabled !== false;
          if (categoryFilterEnabled) {
            const codes = obsField.codes || [];
            const categories = obsField.categories || [];
            const numCats = categories.length;
            const code = codes[i];
            if (code != null && code >= 0 && code < numCats) {
              const isVisible = obsField._categoryVisible[code] !== false;
              if (!isVisible) { passes = false; break; }
            }
          }
        } else if (obsField.kind === 'continuous' && obsField._continuousStats && obsField._continuousFilter) {
          const filterEnabled = obsField._filterEnabled !== false;
          const isSelf = source === 'obs' && obsField === field;
          if (filterEnabled && !(isSelf && ignoreSelfFilter)) {
            const stats = obsField._continuousStats;
            const filter = obsField._continuousFilter;
            const values = obsField.values || [];
            const fullRange =
              filter.min <= stats.min + 1e-6 &&
              filter.max >= stats.max - 1e-6;
            if (!fullRange) {
              const v = values[i];
              if (v === null || Number.isNaN(v) || v < filter.min || v > filter.max) {
                passes = false;
                break;
              }
            }
          }
        }
      }
      if (!passes) continue;

      if (activeVarField && activeVarField.kind === 'continuous' && activeVarField._continuousStats && activeVarField._continuousFilter) {
        const filterEnabled = activeVarField._filterEnabled !== false;
        const isSelfVar = source === 'var' && activeVarField === field;
        if (filterEnabled && !(isSelfVar && ignoreSelfFilter)) {
          const stats = activeVarField._continuousStats;
          const filter = activeVarField._continuousFilter;
          const fullRange =
            filter.min <= stats.min + 1e-6 &&
            filter.max >= stats.max - 1e-6;
          if (!fullRange) {
            const v = activeVarValues[i];
            if (v === null || Number.isNaN(v) || v < filter.min || v > filter.max) {
              passes = false;
            }
          }
        }
      }
      if (!passes) continue;

      // Outliers only apply if the outlier filter is enabled
      if (applyOutlierFilter) {
        const q = outliers[i] ?? -1;
        if (q >= 0 && q > threshold) continue;
      }

      available++;

      // Apply self filter if it was skipped in the pass phase
      if (ignoreSelfFilter) {
        if (field._filterEnabled === false || !field._continuousStats || !field._continuousFilter) {
          visible++;
          continue;
        }
        const stats = field._continuousStats;
        const filter = field._continuousFilter;
        const fullRange =
          filter.min <= stats.min + 1e-6 &&
          filter.max >= stats.max - 1e-6;
        if (!fullRange) {
          const v = targetValues[i];
          if (v === null || Number.isNaN(v) || v < filter.min || v > filter.max) {
            continue;
          }
        }
      }
      visible++;
    }
    return { available, visible };
  }

  getFilterCellCounts(filter) {
    if (!filter) return null;
    if (filter.type === 'category') {
      const field =
        filter.source === 'var'
          ? this.varData?.fields?.[filter.fieldIndex]
          : this.obsData?.fields?.[filter.fieldIndex];
      const counts = field?._categoryCounts;
      if (counts) {
        return {
          available: counts.availableTotal ?? counts.available?.reduce((s, v) => s + v, 0) ?? 0,
          visible: counts.visibleTotal ?? counts.visible?.reduce((s, v) => s + v, 0) ?? 0
        };
      }
      return null;
    }
    if (filter.type === 'continuous') {
      const field =
        filter.source === 'var'
          ? this.varData?.fields?.[filter.fieldIndex]
          : this.obsData?.fields?.[filter.fieldIndex];
      if (!field) return null;
      return this._computeCountsForContinuous(field, filter.source, { ignoreSelfFilter: true });
    }
    return null;
  }

  _applyCategoryCountsToCentroids(field, counts) {
    if (!field || field.kind !== 'category') return false;
    const centroids = this._getCentroidsForCurrentDim(field);
    if (centroids.length === 0 || !this.centroidColors) return false;
    const categories = field.categories || [];
    const visibleCounts = counts?.visible || [];
    const catIndexByName = new Map();
    categories.forEach((cat, idx) => catIndexByName.set(String(cat), idx));
    let changed = false;
    for (let i = 0; i < centroids.length; i++) {
      const c = centroids[i];
      const idx = catIndexByName.get(String(c.category));
      const count = idx != null ? (visibleCounts[idx] || 0) : 0;
      const alpha = count > 0 ? 255 : 0; // uint8 alpha
      const alphaIdx = i * 4 + 3; // alpha is 4th component in RGBA
      if (this.centroidColors[alphaIdx] !== alpha) {
        this.centroidColors[alphaIdx] = alpha;
        changed = true;
      }
      if (this.centroidLabels[i]) {
        this.centroidLabels[i].alpha = alpha / 255; // keep float for label logic
      }
      if (this.centroidLabels[i]?.el) {
        const shouldShow = alpha > 0;
        const prevShow = this.centroidLabels[i].el.style.display !== 'none';
        if (prevShow !== shouldShow) {
          this.centroidLabels[i].el.style.display = shouldShow ? 'block' : 'none';
          changed = true;
        }
      }
    }
    return changed;
  }
}

