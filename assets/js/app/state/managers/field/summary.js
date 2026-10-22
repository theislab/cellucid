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

import {
  collectViewFilters,
  isContinuousFilterFullRange,
} from '../filter-manager.js';
import {
  POINT_VISIBILITY_THRESHOLD,
} from '../../../../rendering/alpha-visibility.js';
import { transparencyEpoch } from '../per-cell-array-ownership.js';
import { isCategoricalCodes } from '../../../../data/categorical-storage-contract.js';

/**
 * Resolve the filters that can hide a cell once per count.
 *
 * The count loops used to walk every field for every cell and re-derive each
 * filter's state there — at 5,000,000 cells that was most of a categorical
 * field switch. A category filter that hides nothing and a continuous filter
 * spanning its whole range can never hide a cell, so they are left out.
 *
 * @param {Array<object>} obsFields
 * @param {(field: object, index: number) => boolean} skipObs
 * @param {object|null} varField Active gene, filtered like an obs field.
 * @returns {{categories: Array<{codes: ArrayLike<number>, hidden: Uint8Array}>,
 *   ranges: Array<{values: ArrayLike<number>, min: number, max: number}>}}
 */
function resolveCellFilters(obsFields, skipObs, varField) {
  const categories = [];
  const ranges = [];
  const addRange = field => {
    if (
      field._filterEnabled === false ||
      !field._continuousStats ||
      !field._continuousFilter ||
      isContinuousFilterFullRange(field._continuousFilter, field._continuousStats)
    ) {
      return;
    }
    ranges.push({
      values: field.values || [],
      min: field._continuousFilter.min,
      max: field._continuousFilter.max,
    });
  };
  for (let index = 0; index < obsFields.length; index++) {
    const field = obsFields[index];
    if (!field || field._isDeleted === true || skipObs(field, index)) continue;
    if (field.kind === 'category' && field._categoryVisible) {
      if (field._categoryFilterEnabled === false) continue;
      const count = (field.categories || []).length;
      const hidden = new Uint8Array(count);
      let hidesAny = false;
      for (let code = 0; code < count; code++) {
        if (field._categoryVisible[code] === false) {
          hidden[code] = 1;
          hidesAny = true;
        }
      }
      if (hidesAny) categories.push({ codes: field.codes || [], hidden });
    } else if (field.kind === 'continuous') {
      addRange(field);
    }
  }
  if (varField !== null && varField.kind === 'continuous') addRange(varField);
  return { categories, ranges };
}

/**
 * Whether one cell survives every resolved filter.
 *
 * `hidden[codes[cell]] === 1` is the whole category test: a missing value, a
 * code outside the inventory, a hole or a non-integer reads `undefined` from
 * the per-code table and is never hidden, exactly as the explicit range checks
 * it replaces decided.
 */
function cellPassesFilters(categories, ranges, cell) {
  for (let index = 0; index < categories.length; index++) {
    const filter = categories[index];
    if (filter.hidden[filter.codes[cell]] === 1) return false;
  }
  for (let index = 0; index < ranges.length; index++) {
    const filter = ranges[index];
    const value = filter.values[cell];
    if (value === null || value !== value || value < filter.min || value > filter.max) {
      return false;
    }
  }
  return true;
}

/**
 * Whether two resolved filter sets hide exactly the same cells: the same code
 * and value arrays (published field data is never written in place) with the
 * same hidden-code tables and range bounds.
 */
function sameResolvedFilters(left, right) {
  if (
    left.categories.length !== right.categories.length
    || left.ranges.length !== right.ranges.length
  ) {
    return false;
  }
  for (let index = 0; index < left.categories.length; index++) {
    const a = left.categories[index];
    const b = right.categories[index];
    if (a.codes !== b.codes || a.hidden.length !== b.hidden.length) return false;
    for (let code = 0; code < a.hidden.length; code++) {
      if (a.hidden[code] !== b.hidden[code]) return false;
    }
  }
  for (let index = 0; index < left.ranges.length; index++) {
    const a = left.ranges[index];
    const b = right.ranges[index];
    if (a.values !== b.values || a.min !== b.min || a.max !== b.max) return false;
  }
  return true;
}

/**
 * Per-category tallies with typed counters: a dataset-length count loop over
 * `new Array(n).fill(0)` pays a holey-elements store per cell. Published as
 * plain arrays, which is what every consumer reads.
 */
function toCountArray(counts) {
  return Array.from(counts);
}

function sumCounts(counts) {
  let sum = 0;
  for (let index = 0; index < counts.length; index++) sum += counts[index];
  return sum;
}

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
   * The restrictions in force in one view (without switching to it), as
   * figure-export provenance records them. Active and stored views go through
   * the same structured definition; a disabled filter hides nothing, so it is
   * not a restriction and is left out.
   */
  getFilterSummaryForView(viewId) {
    const key = String(viewId || 'live');
    const view = key === String(this.activeViewId)
      ? this
      : this.viewContexts.get(key);
    if (!view) return [];
    const lines = collectViewFilters(view)
      .filter((filter) => filter.enabled)
      .map((filter) => filter.text);
    return lines.length > 0 ? lines : ['No filters active'];
  }

  updateFilteredCount() {
    if (!this.pointCount) {
      this.filteredCount = { shown: 0, total: 0 };
      return;
    }
    const total = this.pointCount;
    const applyOutlierFilter = this.isOutlierFilterEnabledForActiveField();
    const threshold = applyOutlierFilter ? this.getCurrentOutlierThreshold() : 1.0;
    const outliers = applyOutlierFilter ? this.getActiveOutlierQuantiles() : null;
    const alpha = this.categoryTransparency || [];
    let shown = 0;
    if (!applyOutlierFilter) {
      for (let i = 0; i < total; i++) {
        if ((alpha[i] ?? 0) >= POINT_VISIBILITY_THRESHOLD) shown++;
      }
    } else {
      for (let i = 0; i < total; i++) {
        if (!((alpha[i] ?? 0) >= POINT_VISIBILITY_THRESHOLD)) continue;
        const q = outliers[i] ?? -1;
        if (q >= 0 && q > threshold) continue;
        shown++;
      }
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
    const categoryCount = categories.length;
    const alpha = this.categoryTransparency || [];
    const applyOutlierFilter = this.isOutlierFilterEnabledForActiveField();
    const outliers = applyOutlierFilter ? this.getActiveOutlierQuantiles() : null;
    const threshold = applyOutlierFilter ? this.getCurrentOutlierThreshold() : 1.0;
    const n = Math.min(this.pointCount, codes.length);
    const fields = this.obsData?.fields || [];
    const targetIndex = fields.indexOf(field);
    const activeVarField =
      this.activeFieldSource === 'var' && this.activeVarFieldIndex >= 0
        ? this.varData?.fields?.[this.activeVarFieldIndex] ?? null
        : null;
    // "Available" respects every other filter but ignores this field's own
    // category visibility.
    const resolved = resolveCellFilters(
      fields,
      (_, index) => index === targetIndex,
      activeVarField
    );
    const { categories: categoryFilters, ranges } = resolved;

    // One visibility change asks for the same counts more than once (the
    // centroid/legend refresh inside computeGlobalVisibility, then the Active
    // filters row of the same field). Each is a dataset-length pass, so an
    // unchanged question returns the counts it already answered. Every input
    // is compared exactly: the code and transparency arrays by identity plus
    // the transparency write epoch, the outlier quantiles and threshold, and
    // every resolved filter's arrays, tables and bounds.
    const epoch = transparencyEpoch(this);
    const memo = this._categoryCountsMemo;
    if (
      memo !== undefined
      && memo !== null
      && memo.field === field
      && memo.codes === codes
      && memo.categoryCount === categoryCount
      && memo.n === n
      && memo.alpha === alpha
      && memo.epoch === epoch
      && memo.outliers === outliers
      && memo.threshold === threshold
      && sameResolvedFilters(memo.filters, resolved)
    ) {
      return memo.counts;
    }

    const total = new Float64Array(categoryCount);
    const available = new Float64Array(categoryCount); // respects other filters, ignores this field's category visibility
    const visible = new Float64Array(categoryCount); // respects all filters including this field's category visibility

    if (
      categoryFilters.length === 0 &&
      ranges.length === 0 &&
      !applyOutlierFilter
    ) {
      // Nothing but this field's own visibility can hide a cell, so every
      // counted cell is available and one pass tallies total and visible.
      for (let i = 0; i < n; i++) {
        const code = codes[i];
        if (code == null || code < 0 || code >= categoryCount) continue;
        total[code]++;
        if ((alpha[i] ?? 0) >= POINT_VISIBILITY_THRESHOLD) visible[code]++;
      }
      available.set(total);
    } else {
      for (let i = 0; i < n; i++) {
        const code = codes[i];
        if (code == null || code < 0 || code >= categoryCount) continue;
        total[code]++;

        // Only apply outlier filter when supported by the active field.
        let outlierHidden = false;
        if (applyOutlierFilter) {
          const q = outliers[i] ?? -1;
          outlierHidden = q >= 0 && q > threshold;
        }
        if (!outlierHidden && cellPassesFilters(categoryFilters, ranges, i)) {
          available[code]++;
        }

        // Current visibility already encoded in alpha + outliers
        if (outlierHidden || !((alpha[i] ?? 0) >= POINT_VISIBILITY_THRESHOLD)) continue;
        visible[code]++;
      }
    }
    const counts = {
      total: toCountArray(total),
      available: toCountArray(available),
      availableTotal: sumCounts(available),
      visible: toCountArray(visible),
      visibleTotal: sumCounts(visible)
    };
    this._categoryCountsMemo = {
      field,
      codes,
      categoryCount,
      n,
      alpha,
      epoch,
      outliers,
      threshold,
      filters: resolved,
      counts,
    };
    return counts;
  }

  _computeCountsForContinuous(field, source, { ignoreSelfFilter = false } = {}) {
    if (!field || field.kind !== 'continuous') return null;
    const n = this.pointCount || 0;
    if (!n) return { available: 0, visible: 0 };
    const obsFields = this.obsData?.fields || [];
    const activeVarField =
      this.activeFieldSource === 'var' && this.activeVarFieldIndex >= 0
        ? this.varData?.fields?.[this.activeVarFieldIndex] ?? null
        : null;
    const targetValues = field.values || [];
    const applyOutlierFilter = this.isOutlierFilterEnabledForActiveField();
    const outliers = applyOutlierFilter ? this.getActiveOutlierQuantiles() : null;
    const threshold = applyOutlierFilter ? this.getCurrentOutlierThreshold() : 1.0;
    let available = 0;
    let visible = 0;
    // With `ignoreSelfFilter`, the field's own range is left out of
    // "available" and applied below for "visible".
    const filters = resolveCellFilters(
      obsFields,
      obsField => (
        ignoreSelfFilter &&
        source === 'obs' &&
        obsField === field &&
        obsField.kind === 'continuous'
      ),
      ignoreSelfFilter && source === 'var' && activeVarField === field
        ? null
        : activeVarField
    );

    // The self filter skipped above, applied for "visible" only.
    const selfFilter = (
      ignoreSelfFilter &&
      field._filterEnabled !== false &&
      field._continuousStats &&
      field._continuousFilter &&
      !isContinuousFilterFullRange(field._continuousFilter, field._continuousStats)
    )
      ? field._continuousFilter
      : null;

    const { categories: categoryFilters, ranges } = filters;
    for (let i = 0; i < n; i++) {
      if (!cellPassesFilters(categoryFilters, ranges, i)) continue;

      // Outliers only apply if the outlier filter is enabled
      if (applyOutlierFilter) {
        const q = outliers[i] ?? -1;
        if (q >= 0 && q > threshold) continue;
      }

      available++;

      if (selfFilter !== null) {
        const v = targetValues[i];
        if (v === null || Number.isNaN(v) || v < selfFilter.min || v > selfFilter.max) {
          continue;
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
      // Counted now, from the current filters: `_categoryCounts` is refreshed
      // only while its field is the active one, so a row for any other field
      // would otherwise report the counts from when it was last coloured.
      if (
        !field
        || !isCategoricalCodes(field.codes)
      ) {
        return null;
      }
      const counts = this.computeCategoryCountsForField(field);
      return { available: counts.availableTotal, visible: counts.visibleTotal };
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
    const centroids = this._getCentroidsForActiveLayout(field);
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
