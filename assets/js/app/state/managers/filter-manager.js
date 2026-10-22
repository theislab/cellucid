/**
 * @fileoverview Filter Manager.
 *
 * Hosts visibility computation and filter summary logic.
 *
 * ⚡ PERFORMANCE CRITICAL: `computeGlobalVisibility()` runs on every filter change.
 *
 * @module state/managers/filter-manager
 */

import { rgbToCss, COLOR_PICKER_PALETTE } from '../../../data/palettes.js';
import { fillNeutralGray } from '../core/constants.js';
import { BaseManager } from '../core/base-manager.js';
import { requireCategoryCodesInInventory } from './category-codes.js';
import {
  writableCellVisibilityMask,
  writableColors,
  writableTransparency,
} from './per-cell-array-ownership.js';
import { isCategoricalCodes, missingCategoryCode } from '../../../data/categorical-storage-contract.js';

function requireCategoryFieldAndIndex(field, index) {
  if (
    field === null
    || typeof field !== 'object'
    || Array.isArray(field)
    || field.kind !== 'category'
    || !Array.isArray(field.categories)
  ) {
    throw new TypeError('Category filter operation requires a category field.');
  }
  if (
    !Number.isSafeInteger(index)
    || index < 0
    || index >= field.categories.length
  ) {
    throw new RangeError('Category filter index is outside the category inventory.');
  }
}

function requireRgb(color) {
  if (!Array.isArray(color) || color.length !== 3) {
    throw new TypeError('Category color must be an RGB triplet.');
  }
  for (let channel = 0; channel < color.length; channel++) {
    if (
      !Number.isFinite(color[channel])
      || color[channel] < 0
      || color[channel] > 1
    ) {
      throw new RangeError('Category color channels must be finite values from 0 through 1.');
    }
  }
}

export function isContinuousFilterFullRange(filter, stats) {
  return (
    filter.min === stats.min
    && filter.max === stats.max
  );
}

function parseExactFilterId(filterId) {
  if (typeof filterId !== 'string') {
    throw new TypeError('Filter id must be a string.');
  }
  const match = /^(obs|var)-(continuous|category|outlier)-(0|[1-9][0-9]*)$/.exec(filterId);
  if (!match) {
    throw new TypeError('Filter id does not match the current exact filter-id contract.');
  }
  const source = match[1];
  const type = match[2];
  if (
    (source === 'var' && type !== 'continuous')
    || (source === 'obs' && type !== 'continuous' && type !== 'category' && type !== 'outlier')
  ) {
    throw new TypeError('Filter id contains an unsupported source/type combination.');
  }
  const fieldIndex = Number(match[3]);
  if (!Number.isSafeInteger(fieldIndex)) {
    throw new RangeError('Filter field index exceeds the safe integer range.');
  }
  return { source, type, fieldIndex };
}

/**
 * Structured filter rows of one view: the active view (DataState itself) or
 * a stored view context. Every consumer - the Active filters list, the view
 * label, figure-export provenance - derives from this one definition, so a
 * view's filters never depend on whether it happens to be focused.
 *
 * @param {{obsData: object|null, varData: object|null, activeFieldSource: string|null,
 *   activeFieldIndex: number, activeVarFieldIndex: number}} view
 */
export function collectViewFilters(view) {
  if (!view.obsData || !view.obsData.fields) return [];
  const fields = view.obsData.fields;
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
      if (
        view.activeFieldSource === 'obs'
        && view.activeFieldIndex === fi
        && field.outlierQuantiles
        && field.outlierQuantiles.length
      ) {
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
    view.activeFieldSource === 'var' &&
    view.activeVarFieldIndex >= 0 &&
    view.varData &&
    view.varData.fields
  ) {
    const field = view.varData.fields[view.activeVarFieldIndex];
    if (field && field._isDeleted !== true && field.kind === 'continuous' && field._continuousStats && field._continuousFilter) {
      const stats = field._continuousStats;
      const filter = field._continuousFilter;
      const fullRange = isContinuousFilterFullRange(filter, stats);
      if (!fullRange) {
        const enabled = field._filterEnabled !== false; // default true
        const disabledSuffix = enabled ? '' : ' (disabled)';
        filters.push({
          id: `var-continuous-${view.activeVarFieldIndex}`,
          type: 'continuous',
          source: 'var',
          fieldIndex: view.activeVarFieldIndex,
          fieldKey: field.key,
          enabled: enabled,
          text: `${field.key}: ${filter.min.toFixed(2)} – ${filter.max.toFixed(2)}${disabledSuffix}`
        });
      }
    }
  }

  return filters;
}

export class DataStateFilterMethods {
  computeGlobalVisibility() {
    if (this.pointCount === 0 && this.obsData === null) return;
    if (this.pointCount === 0) {
      if (
        this.obsData === null ||
        typeof this.obsData !== 'object' ||
        Array.isArray(this.obsData) ||
        this.obsData.count !== 0 ||
        !Array.isArray(this.obsData.fields) ||
        this.obsData.fields.length !== 0 ||
        !(this.categoryTransparency instanceof Uint8Array) ||
        this.categoryTransparency.length !== 0 ||
        !(this.cellVisibilityMask instanceof Uint8Array) ||
        this.cellVisibilityMask.length !== 0 ||
        !(this.colorsArray instanceof Uint8Array) ||
        this.colorsArray.length !== 0
      ) {
        throw new TypeError(
          'Zero-cell visibility requires one exact empty observation generation.'
        );
      }
      return;
    }
    if (
      !Number.isSafeInteger(this.pointCount)
      || this.pointCount < 1
      || !this.obsData
      || !Array.isArray(this.obsData.fields)
    ) {
      throw new TypeError('Visibility computation requires exact current observation data.');
    }
    const fields = this.obsData.fields;
    const pointCount = this.pointCount;
    if (
      !(this.categoryTransparency instanceof Uint8Array)
      || this.categoryTransparency.length !== pointCount
      || !(this.cellVisibilityMask instanceof Uint8Array)
      || this.cellVisibilityMask.length !== pointCount
      || !(this.colorsArray instanceof Uint8Array)
      || this.colorsArray.length !== pointCount * 4
    ) {
      throw new TypeError(
        'Visibility computation requires complete color, transparency, and cell-mask buffers.'
      );
    }
    {
      const mask = this.cellVisibilityMask;
      for (let index = 0; index < pointCount; index++) {
        if (mask[index] > 1) {
          throw new TypeError(`Cell visibility mask entry ${index} must be exactly 0 or 1.`);
        }
      }
    }

    if (
      this.activeFieldSource !== null
      && this.activeFieldSource !== 'obs'
      && this.activeFieldSource !== 'var'
    ) {
      throw new TypeError('Active field source must be exactly obs, var, or null.');
    }
    let activeVarField = null;
    if (this.activeFieldSource === 'var') {
      if (
        !this.varData
        || !Array.isArray(this.varData.fields)
        || !Number.isSafeInteger(this.activeVarFieldIndex)
        || this.activeVarFieldIndex < 0
        || this.activeVarFieldIndex >= this.varData.fields.length
      ) {
        throw new TypeError('Active variable filter requires an exact current variable field.');
      }
      const candidate = this.varData.fields[this.activeVarFieldIndex];
      if (!candidate || typeof candidate !== 'object' || candidate._isDeleted === true) {
        throw new TypeError('Active variable filter field must be a visible field object.');
      }
      activeVarField = candidate;
    }

    const applyOutlierFilter = this.isOutlierFilterEnabledForActiveField();
    if (typeof applyOutlierFilter !== 'boolean') {
      throw new TypeError('Outlier filter state must be exactly true or false.');
    }
    let outlierThreshold = null;
    let outliers = null;
    if (applyOutlierFilter) {
      outlierThreshold = this.getCurrentOutlierThreshold();
      if (
        !Number.isFinite(outlierThreshold)
        || outlierThreshold < 0
        || outlierThreshold > 1
      ) {
        throw new TypeError('Active outlier filtering requires an exact threshold.');
      }
      // The active field's own quantiles, proven -1 or within [0, 1] once
      // per decoded array.
      outliers = this.getActiveOutlierQuantiles();
    }

    const categoryFilters = [];
    const continuousFilters = [];

    for (let f = 0; f < fields.length; f++) {
      const field = fields[f];
      if (!field || typeof field !== 'object' || Array.isArray(field)) {
        throw new TypeError(`Observation field ${f} must be an object.`);
      }
      if (field._isDeleted === true) continue;

      if (field.kind === 'category' && field._categoryVisible !== undefined) {
        this.ensureCategoryMetadata(field);
        if (
          !isCategoricalCodes(field.codes)
          || field.codes.length !== pointCount
        ) {
          throw new TypeError(`Observation category field ${f} requires exact dataset-length codes.`);
        }
        const categories = field.categories;
        const numCats = categories.length;
        requireCategoryCodesInInventory(
          field.codes,
          numCats,
          index => `Category filter code ${index} is outside the category inventory.`
        );
        if (field._categoryFilterEnabled) {
          const visibleMap = field._categoryVisible;
          // One byte per code, so the per-cell test is a single typed load.
          // For uint8 and uint16 codes the table spans every code the dtype
          // can hold and the missing code reads 1 (never hidden). A uint32
          // table spans the inventory only (2^32 bytes would not fit), and
          // the missing code is tested by value. Every other code is proven
          // inside the inventory above.
          const missingCode = missingCategoryCode(field.codes);
          const spansDtype = missingCode <= 0xffff;
          const visibleByCode = new Uint8Array(spansDtype ? missingCode + 1 : numCats);
          if (spansDtype) visibleByCode[missingCode] = 1;
          let hasHidden = false;
          for (let c = 0; c < numCats; c++) {
            if (visibleMap[c]) {
              visibleByCode[c] = 1;
            } else {
              hasHidden = true;
            }
          }
          if (hasHidden) {
            categoryFilters.push({
              codes: field.codes,
              visibleByCode,
              missingCode,
              spansDtype
            });
          }
        }
      } else if (
        field.kind === 'continuous'
        && (
          field._continuousStats !== undefined
          || field._continuousFilter !== undefined
        )
      ) {
        const metadata = this.ensureContinuousMetadata(field);
        if (field._filterEnabled) {
          const stats = metadata.stats;
          const filter = metadata.filter;
          if (!isContinuousFilterFullRange(filter, stats)) {
            continuousFilters.push({
              values: field.values,
              min: filter.min,
              max: filter.max
            });
          }
        }
      } else if (field.kind !== 'category' && field.kind !== 'continuous') {
        throw new TypeError(`Observation field ${f} has an unsupported kind.`);
      }
    }

    let activeVarFilterMin = null;
    let activeVarFilterMax = null;
    let activeVarFilterEnabled = false;
    let activeVarValues = null;
    if (activeVarField !== null) {
      if (activeVarField.kind !== 'continuous') {
        throw new TypeError('Active variable filtering requires a continuous field.');
      }
      const metadata = this.ensureContinuousMetadata(activeVarField);
      if (activeVarField._filterEnabled) {
        const stats = metadata.stats;
        const filter = metadata.filter;
        if (!isContinuousFilterFullRange(filter, stats)) {
          activeVarFilterEnabled = true;
          activeVarFilterMin = filter.min;
          activeVarFilterMax = filter.max;
          activeVarValues = activeVarField.values;
        }
      }
    }

    const hasAnyFilter =
      categoryFilters.length > 0 ||
      continuousFilters.length > 0 ||
      activeVarFilterEnabled ||
      applyOutlierFilter;

    // Both arrays are exactly `pointCount` long (checked above). Hoisting them
    // out of the loop removes one property load per point per pass.
    const cellVisibilityMask = this.cellVisibilityMask;
    // Every branch below rewrites every entry; a kept view still sharing the
    // array keeps the old one (per-cell-array-ownership.js).
    const transparency = writableTransparency(this);

    if (!hasAnyFilter) {
      // Every mask entry is exactly 0 or 1, so with no filter active the
      // published alpha *is* the mask. One typed-array copy replaces a
      // dataset-length fill followed by a second dataset-length pass.
      transparency.set(cellVisibilityMask);
    } else if (
      categoryFilters.length === 1 &&
      continuousFilters.length === 0 &&
      !activeVarFilterEnabled &&
      !applyOutlierFilter
    ) {
      // The commonest filter -- categories hidden on one field -- with the
      // per-code table read straight into the alpha: it holds exactly the 0
      // or 1 the general loop below writes, at half its cost at 10,000,000
      // cells.
      const { codes, visibleByCode, missingCode, spansDtype } = categoryFilters[0];
      if (spansDtype) {
        for (let i = 0; i < pointCount; i++) {
          transparency[i] = cellVisibilityMask[i] === 0
            ? 0
            : visibleByCode[codes[i]];
        }
      } else {
        for (let i = 0; i < pointCount; i++) {
          const code = codes[i];
          transparency[i] = cellVisibilityMask[i] === 0
            ? 0
            : code === missingCode ? 1 : visibleByCode[code];
        }
      }
    } else {
      for (let i = 0; i < pointCount; i++) {
        // The mask is tested first. No filter can make a cell the mask already
        // hides visible again, so its predicates are never evaluated — that is
        // also what keeps this one pass equal to the two it replaces.
        if (cellVisibilityMask[i] === 0) {
          transparency[i] = 0;
          continue;
        }
        let visible = true;

        for (let cf = 0; cf < categoryFilters.length; cf++) {
          const filter = categoryFilters[cf];
          const code = filter.codes[i];
          if (
            (filter.spansDtype || code !== filter.missingCode)
            && filter.visibleByCode[code] === 0
          ) {
            visible = false;
            break;
          }
        }

        if (visible) {
          for (let cf = 0; cf < continuousFilters.length; cf++) {
            const filter = continuousFilters[cf];
            const v = filter.values[i];
            if (v !== v || v < filter.min || v > filter.max) {
              visible = false;
              break;
            }
          }
        }

        if (visible && activeVarFilterEnabled) {
          const v = activeVarValues[i];
          if (v !== v || v < activeVarFilterMin || v > activeVarFilterMax) {
            visible = false;
          }
        }

        // Apply outlier filter for the active field (only when supported).
        if (visible && applyOutlierFilter) {
          const q = outliers[i];
          if (q >= 0 && q > outlierThreshold) visible = false;
        }

        transparency[i] = visible ? 1 : 0;
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
    return collectViewFilters(this);
  }

  toggleFilterEnabled(filterId, enabled) {
    if (typeof enabled !== 'boolean') {
      throw new TypeError('Filter enabled state must be exactly true or false.');
    }
    const { source, type, fieldIndex } = parseExactFilterId(filterId);
    const fields = source === 'obs' ? this.obsData?.fields : this.varData?.fields;
    if (!Array.isArray(fields) || !fields[fieldIndex]) {
      throw new RangeError('Filter id references an unavailable field.');
    }
    const field = fields[fieldIndex];

    if (type === 'continuous') {
      this.ensureContinuousMetadata(field);
      field._filterEnabled = enabled;
    } else if (type === 'category') {
      this.ensureCategoryMetadata(field);
      field._categoryFilterEnabled = enabled;
    } else {
      if (field.kind !== 'category') {
        throw new TypeError('Outlier filters require a categorical observation field.');
      }
      field._outlierFilterEnabled = enabled;
    }

    this.computeGlobalVisibility();
  }

  removeFilter(filterId) {
    const { source, type, fieldIndex } = parseExactFilterId(filterId);
    const fields = source === 'obs' ? this.obsData?.fields : this.varData?.fields;
    if (!Array.isArray(fields) || !fields[fieldIndex]) {
      throw new RangeError('Filter id references an unavailable field.');
    }
    const field = fields[fieldIndex];

    if (type === 'continuous') {
      const metadata = this.ensureContinuousMetadata(field);
      field._continuousFilter.min = metadata.stats.min;
      field._continuousFilter.max = metadata.stats.max;
      field._filterEnabled = true;
      // With "rescale colors to filter" on, the colour range tracks the
      // range sliders, which this removal returns to the full data range.
      if (field._useFilterColorRange === true) {
        field._continuousColorRange = {
          min: metadata.stats.min,
          max: metadata.stats.max
        };
        if (field === this.getActiveField()) {
          this.updateColorsContinuous(field);
          this._pushColorsToViewer();
        }
      }
    } else if (type === 'category') {
      this.ensureCategoryMetadata(field);
      const categories = field.categories;
      for (let i = 0; i < categories.length; i++) {
        field._categoryVisible[i] = true;
      }
      field._categoryFilterEnabled = true;
      this._reapplyCategoryColorsNoRecompute(field);
    } else {
      if (field.kind !== 'category') {
        throw new TypeError('Outlier filters require a categorical observation field.');
      }
      field._outlierThreshold = 1.0;
      field._outlierFilterEnabled = true;
    }

    this.computeGlobalVisibility();
  }

  reapplyCategoryColors(field) {
    if (!field || field.kind !== 'category') {
      throw new TypeError('Category color refresh requires a category field.');
    }
    this.ensureCategoryMetadata(field);
    this._reapplyCategoryColorsNoRecompute(field);
    // Let computeGlobalVisibility handle transparency/filtering
    this.computeGlobalVisibility();
  }

  /**
   * Update color array for a category field without triggering visibility recomputation.
   * Used by batch mode to defer the expensive computeGlobalVisibility() call.
   *
   * The point colours belong to the active field alone. A filter on another
   * field (listed in Active filters, edited in batch, restored from a session)
   * changes only visibility, so its palette must never reach the canvas.
   */
  _reapplyCategoryColorsNoRecompute(field) {
    if (!field || field.kind !== 'category') {
      throw new TypeError('Category color refresh requires a category field.');
    }
    if (field !== this.getActiveField()) return;
    const n = this.pointCount;
    const categories = field.categories;
    const codes = field.codes;
    const catColors = field._categoryColors;
    const catVisible = field._categoryVisible;
    const numCats = categories.length;
    if (
      (!Array.isArray(categories))
      || !isCategoricalCodes(codes)
      || codes.length !== n
      || !Array.isArray(catColors)
      || catColors.length !== numCats
      || !(this.colorsArray instanceof Uint8Array)
      || this.colorsArray.length !== n * 4
      || !(this.categoryTransparency instanceof Uint8Array)
      || this.categoryTransparency.length !== n
    ) {
      throw new TypeError('Category color refresh requires complete typed field buffers.');
    }
    // The alpha bytes are left as the table wrote them: every caller recomputes
    // visibility next (`reapplyCategoryColors`, `removeFilter`, `endBatch`),
    // and `computeGlobalVisibility` publishes the alpha bytes from the new
    // transparency. Syncing them here first was a dataset-length pass whose
    // result was overwritten before anything read it; the GPU color stream's
    // alpha byte is not read while the alpha texture carries visibility.
    this._writeCategoryColors(field, false);
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
    requireCategoryFieldAndIndex(field, idx);
    this.ensureCategoryMetadata(field);
    const color = field._categoryColors[idx];
    requireRgb(color);
    return [...color];
  }

  setColorForCategory(field, idx, color) {
    requireCategoryFieldAndIndex(field, idx);
    requireRgb(color);
    this.ensureCategoryMetadata(field);
    field._categoryColors[idx] = [...color];
    if (this._batchMode) {
      this._batchDirty.colors = true;
      this._batchDirty.affectedFields.add(field);
    } else {
      this.reapplyCategoryColors(field);
    }
  }

  setVisibilityForCategory(field, idx, visible) {
    requireCategoryFieldAndIndex(field, idx);
    if (typeof visible !== 'boolean') {
      throw new TypeError('Category visibility must be exactly true or false.');
    }
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

  setCellVisibility(cellIndices, visible) {
    if (typeof visible !== 'boolean') {
      throw new TypeError(
        'Cell visibility must be exactly true or false.'
      );
    }
    if (
      !(this.cellVisibilityMask instanceof Uint8Array) ||
      this.cellVisibilityMask.length !== this.pointCount
    ) {
      throw new TypeError(
        'Cell visibility requires a complete current dataset mask.'
      );
    }

    let selectedBits = null;
    if (cellIndices !== null) {
      // Cell indices arrive naturally as Uint32Array/Int32Array. A DataView is
      // also an ArrayBuffer view but carries no indexed elements, and
      // BYTES_PER_ELEMENT separates the two across realms, unlike instanceof.
      const isTypedIndices =
        ArrayBuffer.isView(cellIndices)
        && typeof cellIndices.BYTES_PER_ELEMENT === 'number';
      if (!isTypedIndices && !Array.isArray(cellIndices)) {
        throw new TypeError(
          'Cell visibility indices must be an array, a typed array, or null.'
        );
      }
      const pointCount = this.pointCount;
      const length = cellIndices.length;
      // One presence bit per cell: exact duplicate detection in O(1) per index
      // from a single allocation, replacing a Set (which hashes every index and
      // hard-fails above 2**24 entries) plus a second full-size index copy.
      selectedBits = new Uint8Array(Math.ceil(pointCount / 8));
      for (let index = 0; index < length; index++) {
        const cellIndex = cellIndices[index];
        if (
          // Typed arrays have no holes and never inherit indexed values, so the
          // own-property guarantee holds there by construction.
          (!isTypedIndices && !Object.hasOwn(cellIndices, index)) ||
          !Number.isInteger(cellIndex) ||
          cellIndex < 0
        ) {
          throw new TypeError(
            `Cell visibility index ${index} must be a non-negative integer.`
          );
        }
        if (cellIndex >= pointCount) {
          throw new RangeError(
            `Cell visibility index ${cellIndex} is outside the current point count.`
          );
        }
        const bucket = cellIndex >>> 3;
        const bit = 1 << (cellIndex & 7);
        if ((selectedBits[bucket] & bit) !== 0) {
          throw new TypeError(
            'Cell visibility indices must not contain duplicates.'
          );
        }
        selectedBits[bucket] |= bit;
      }
    }

    const nextValue = visible ? 1 : 0;
    if (selectedBits === null) {
      writableCellVisibilityMask(this).fill(nextValue);
    } else {
      // Driving the write from the validated bits reads every input element
      // exactly once, so no value can differ between validation and write. The
      // loop bound is the buffer length so V8 keeps the elided-bounds-check
      // fast path; a narrower "touched range" bound measured 4x slower here.
      const mask = writableCellVisibilityMask(this);
      for (let bucket = 0; bucket < selectedBits.length; bucket++) {
        const bits = selectedBits[bucket];
        if (bits === 0) continue;
        const base = bucket * 8;
        for (let bit = 0; bit < 8; bit++) {
          if ((bits & (1 << bit)) !== 0) {
            mask[base + bit] = nextValue;
          }
        }
      }
    }
    this.computeGlobalVisibility();
  }

  showAllCategories(field, { onlyAvailable = false } = {}) {
    if (typeof onlyAvailable !== 'boolean') {
      throw new TypeError('onlyAvailable must be exactly true or false.');
    }
    this.ensureCategoryMetadata(field);
    const categories = field.categories;
    if (onlyAvailable && !field._categoryCounts) {
      throw new Error('Available category counts must be computed before scoped visibility changes.');
    }
    const available = onlyAvailable ? field._categoryCounts.available : null;
    if (
      available !== null
      && (
        !Array.isArray(available)
        || available.length !== categories.length
        || available.some((count) => !Number.isSafeInteger(count) || count < 0)
      )
    ) {
      throw new TypeError('Available category counts must exactly match the category inventory.');
    }
    for (let i = 0; i < categories.length; i++) {
      if (available !== null && available[i] === 0) continue;
      field._categoryVisible[i] = true;
    }
    this.reapplyCategoryColors(field);
  }

  hideAllCategories(field, { onlyAvailable = false } = {}) {
    if (typeof onlyAvailable !== 'boolean') {
      throw new TypeError('onlyAvailable must be exactly true or false.');
    }
    this.ensureCategoryMetadata(field);
    const categories = field.categories;
    if (onlyAvailable && !field._categoryCounts) {
      throw new Error('Available category counts must be computed before scoped visibility changes.');
    }
    const available = onlyAvailable ? field._categoryCounts.available : null;
    if (
      available !== null
      && (
        !Array.isArray(available)
        || available.length !== categories.length
        || available.some((count) => !Number.isSafeInteger(count) || count < 0)
      )
    ) {
      throw new TypeError('Available category counts must exactly match the category inventory.');
    }
    for (let i = 0; i < categories.length; i++) {
      if (available !== null && available[i] === 0) continue;
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
      // Neutral gray (RGB) and full alpha.
      fillNeutralGray(writableColors(this).subarray(0, this.pointCount * 4));
    }
    if (!this.categoryTransparency || this.categoryTransparency.length !== this.pointCount) {
      this.categoryTransparency = new Uint8Array(this.pointCount);
    }
    writableTransparency(this).fill(1);
    this._pushColorsToViewer();
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

  /**
   * Snapshot payload for small multiples (Keep view).
   *
   * `colors` is the kept view's own copy: the viewer and renderer keep it by
   * reference and the new view context adopts it (it is never written again;
   * a recolor of that view publishes a new array). `transparency` is the
   * active view's array, lent for one synchronous publication
   * (`publishSnapshotView`): the viewer copies it, and the new context shares
   * it with this view until either one writes.
   */
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
      transparency: this.categoryTransparency ?? null,
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
      // Stride of the kept view's positions: the source view's representation.
      dimensionLevel: this.getDimensionLevel()
    };
  }
}

export class FilterManager extends BaseManager {
  constructor(coordinator) {
    super(coordinator);
  }
}
