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

/**
 * Cells per category of one codes array. Published codes are never written in
 * place, so the tally is a property of the array (and the counted prefix).
 */
const CATEGORY_TOTALS = new WeakMap();

function categoryTotals(codes, categoryCount, n) {
  const cached = CATEGORY_TOTALS.get(codes);
  if (cached !== undefined && cached.categoryCount === categoryCount && cached.n === n) {
    return cached.total;
  }
  const total = tallyVisibleByCode(codes, null, categoryCount, n);
  CATEGORY_TOTALS.set(codes, { categoryCount, n, total });
  return total;
}

/**
 * Per-category sum of `weights` (0 or 1 a cell), or of 1 when `weights` is
 * null, over the first `n` cells. Uint8 and Uint16 codes index a slot table
 * spanning their whole dtype, so the loop has no branch; Uint32 codes test the
 * inventory bound per cell.
 */
function tallyVisibleByCode(codes, weights, categoryCount, n) {
  const counts = new Float64Array(categoryCount);
  if (codes instanceof Uint32Array) {
    for (let i = 0; i < n; i++) {
      const code = codes[i];
      if (code < categoryCount) counts[code] += weights === null ? 1 : weights[i];
    }
    return counts;
  }
  const slots = new Uint32Array(codes instanceof Uint8Array ? 256 : 65536);
  if (weights === null) {
    for (let i = 0; i < n; i++) slots[codes[i]]++;
  } else {
    for (let i = 0; i < n; i++) slots[codes[i]] += weights[i];
  }
  for (let code = 0; code < categoryCount; code++) counts[code] = slots[code];
  return counts;
}

/**
 * Per-category count of cells shown and not hidden by the active outlier
 * filter (the outlier test is repeated so the count never trusts a
 * transparency written for another threshold).
 */
function tallyShownByCode(codes, alpha, outliers, threshold, categoryCount, n) {
  const counts = new Float64Array(categoryCount);
  for (let i = 0; i < n; i++) {
    const code = codes[i];
    if (code >= categoryCount || alpha[i] !== 1) continue;
    const q = outliers[i];
    if (q >= 0 && q > threshold) continue;
    counts[code]++;
  }
  return counts;
}

/**
 * Per-category counts while the active outlier filter is the only other
 * filter: cells it keeps ("available") and those of them shown ("visible").
 */
function tallyOutlierCounts(codes, alpha, outliers, threshold, categoryCount, n) {
  const available = new Float64Array(categoryCount);
  const visible = new Float64Array(categoryCount);
  for (let i = 0; i < n; i++) {
    const code = codes[i];
    if (code >= categoryCount) continue;
    const q = outliers[i];
    if (q >= 0 && q > threshold) continue;
    available[code]++;
    visible[code] += alpha[i];
  }
  return { available, visible };
}

/**
 * Per-category count of cells that pass every filter but the field's own
 * category visibility, kept per field while its inputs are unchanged.
 */
function availableByCode(owner, field, codes, categoryCount, n, resolved, outliers, threshold) {
  if (!(owner._availableCountsMemos instanceof WeakMap)) {
    owner._availableCountsMemos = new WeakMap();
  }
  const memo = owner._availableCountsMemos.get(field);
  if (
    memo !== undefined
    && memo.codes === codes
    && memo.categoryCount === categoryCount
    && memo.n === n
    && memo.outliers === outliers
    && memo.threshold === threshold
    && sameResolvedFilters(memo.filters, resolved)
  ) {
    return memo.available;
  }
  const { categories, ranges } = resolved;
  const available = new Float64Array(categoryCount);
  for (let i = 0; i < n; i++) {
    const code = codes[i];
    if (code >= categoryCount) continue;
    if (outliers !== null) {
      const q = outliers[i];
      if (q >= 0 && q > threshold) continue;
    }
    if (cellPassesFilters(categories, ranges, i)) available[code]++;
  }
  owner._availableCountsMemos.set(field, {
    codes, categoryCount, n, outliers, threshold, filters: resolved, available,
  });
  return available;
}

const COUNT_MEMO_OWNERS = Object.freeze([
  '_categoryCountsMemos',
  '_availableCountsMemos',
  '_continuousCountsMemos',
]);

/**
 * Give a copy of a field the count answers its original holds. A memo names
 * every array and table it was counted from, so it stays exact for the copy
 * for as long as those are the copy's inputs too (a kept view starts out
 * sharing its source view's transparency).
 *
 * @param {object} owner - DataState.
 * @param {object} from - The original field.
 * @param {object} to - Its copy.
 */
export function carryFieldCountMemos(owner, from, to) {
  for (const key of COUNT_MEMO_OWNERS) {
    const memos = owner[key];
    if (!(memos instanceof WeakMap)) continue;
    const memo = memos.get(from);
    if (memo !== undefined) memos.set(to, memo);
  }
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
    const alpha = this.categoryTransparency;
    if (!(alpha instanceof Uint8Array) || alpha.length !== total) {
      throw new TypeError('Filtered count requires the exact point transparency.');
    }
    // `computeGlobalVisibility` counts the cells it shows in its own pass and
    // records what it counted from; the same question is answered from that.
    const memo = this._filteredCountMemo;
    if (
      memo !== undefined
      && memo !== null
      && memo.transparency === alpha
      && memo.epoch === transparencyEpoch(this)
      && memo.outliers === outliers
      && memo.threshold === threshold
    ) {
      this.filteredCount = { shown: memo.shown, total };
      return;
    }
    // Transparency holds exactly 0 or 1 a cell (rendering/alpha-visibility.js).
    let shown = 0;
    if (!applyOutlierFilter) {
      for (let i = 0; i < total; i++) shown += alpha[i];
    } else {
      for (let i = 0; i < total; i++) {
        if (alpha[i] === 0) continue;
        const q = outliers[i];
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
    // filters row of each field). Each is a dataset-length pass, so an
    // unchanged question returns the counts it already answered, per field.
    // Every input is compared exactly: the code and transparency arrays by
    // identity plus the transparency write epoch, the outlier quantiles and
    // threshold, and every resolved filter's arrays, tables and bounds.
    const epoch = transparencyEpoch(this);
    if (!(this._categoryCountsMemos instanceof WeakMap)) {
      this._categoryCountsMemos = new WeakMap();
    }
    const memo = this._categoryCountsMemos.get(field);
    if (
      memo !== undefined
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

    let total;
    let available;
    let visible;
    if (n === 0) {
      total = new Float64Array(categoryCount);
      available = total;
      visible = total;
    } else {
      if (!isCategoricalCodes(codes) || !(alpha instanceof Uint8Array) || alpha.length < n) {
        throw new TypeError(
          'Category counts require typed category codes and the exact point transparency.'
        );
      }
      // The totals are a property of the codes. "Available" depends on every
      // filter but this field's own categories, so it is reused while those
      // stay as they are (a legend click on this field changes only
      // "visible"). "Visible" is each cell's 0-or-1 visibility added to its
      // code's slot, one branch-free pass.
      total = categoryTotals(codes, categoryCount, n);
      const otherFilters = categoryFilters.length > 0 || ranges.length > 0;
      if (!otherFilters && !applyOutlierFilter) {
        available = total;
        visible = tallyVisibleByCode(codes, alpha, categoryCount, n);
      } else if (!otherFilters) {
        // The outlier slider alone: both tallies in one pass.
        ({ available, visible } = tallyOutlierCounts(
          codes, alpha, outliers, threshold, categoryCount, n
        ));
      } else {
        available = availableByCode(
          this, field, codes, categoryCount, n, resolved, outliers, threshold
        );
        visible = applyOutlierFilter
          ? tallyShownByCode(codes, alpha, outliers, threshold, categoryCount, n)
          : tallyVisibleByCode(codes, alpha, categoryCount, n);
      }
    }
    const counts = {
      total: toCountArray(total),
      available: toCountArray(available),
      availableTotal: sumCounts(available),
      visible: toCountArray(visible),
      visibleTotal: sumCounts(visible)
    };
    this._categoryCountsMemos.set(field, {
      codes,
      categoryCount,
      n,
      alpha,
      epoch,
      outliers,
      threshold,
      filters: resolved,
      counts,
    });
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

    // The Active filters list asks for every row's counts on each render; an
    // unchanged question (same filters, values, outliers and self range) is
    // answered from the previous pass for that field.
    if (!(this._continuousCountsMemos instanceof WeakMap)) {
      this._continuousCountsMemos = new WeakMap();
    }
    const memo = this._continuousCountsMemos.get(field);
    if (
      memo !== undefined
      && memo.source === source
      && memo.ignoreSelfFilter === ignoreSelfFilter
      && memo.n === n
      && memo.targetValues === targetValues
      && memo.selfMin === (selfFilter === null ? null : selfFilter.min)
      && memo.selfMax === (selfFilter === null ? null : selfFilter.max)
      && memo.outliers === outliers
      && memo.threshold === threshold
      && sameResolvedFilters(memo.filters, filters)
    ) {
      return { ...memo.counts };
    }

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
    const counts = { available, visible };
    this._continuousCountsMemos.set(field, {
      source,
      ignoreSelfFilter,
      n,
      targetValues,
      selfMin: selfFilter === null ? null : selfFilter.min,
      selfMax: selfFilter === null ? null : selfFilter.max,
      outliers,
      threshold,
      filters,
      counts,
    });
    return { ...counts };
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
