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
  cellVisibilityMaskWrites,
  requireBinaryCellVisibilityMask,
  transparencyArrayWrites,
  transparencyEpoch,
  writableCellVisibilityMask,
  writableColorAlphaBytes,
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

/*
 * Per-cell visibility kernels of `computeGlobalVisibility`. Each writes every
 * cell's visibility (exactly 0 or 1), the alpha byte of its packed color, and
 * returns how many cells it showed, in one pass. They are separate functions
 * so each is compiled for its own loop: inside one large method, a loop that
 * had not run yet was optimized without type feedback and deoptimized on its
 * first real use (a 40 ms first outlier step at 562,000 cells).
 */

function publishMaskVisibility(mask, transparency, colors, pointCount) {
  let shown = 0;
  for (let i = 0, j = 3; i < pointCount; i++, j += 4) {
    const visible = mask[i];
    transparency[i] = visible;
    colors[j] = visible * 255;
    shown += visible;
  }
  return shown;
}

function publishCategoryVisibility(mask, filter, transparency, colors, pointCount) {
  const { codes, visibleByCode, missingCode, spansDtype } = filter;
  let shown = 0;
  if (spansDtype) {
    for (let i = 0, j = 3; i < pointCount; i++, j += 4) {
      const visible = mask[i] === 0 ? 0 : visibleByCode[codes[i]];
      transparency[i] = visible;
      colors[j] = visible * 255;
      shown += visible;
    }
    return shown;
  }
  for (let i = 0, j = 3; i < pointCount; i++, j += 4) {
    const code = codes[i];
    const visible = mask[i] === 0
      ? 0
      : code === missingCode ? 1 : visibleByCode[code];
    transparency[i] = visible;
    colors[j] = visible * 255;
    shown += visible;
  }
  return shown;
}

function publishOutlierVisibility(mask, outliers, threshold, transparency, colors, pointCount) {
  let shown = 0;
  for (let i = 0, j = 3; i < pointCount; i++, j += 4) {
    const q = outliers[i];
    const visible = q >= 0 && q > threshold ? 0 : mask[i];
    transparency[i] = visible;
    colors[j] = visible * 255;
    shown += visible;
  }
  return shown;
}

function publishFilteredVisibility(
  mask,
  categoryFilters,
  continuousFilters,
  varValues,
  varMin,
  varMax,
  outliers,
  outlierThreshold,
  transparency,
  colors,
  pointCount
) {
  let shown = 0;
  for (let i = 0; i < pointCount; i++) {
    // The mask is tested first. No filter can make a cell the mask already
    // hides visible again, so its predicates are never evaluated.
    let visible = mask[i] === 1;

    for (let cf = 0; visible && cf < categoryFilters.length; cf++) {
      const filter = categoryFilters[cf];
      const code = filter.codes[i];
      if (
        (filter.spansDtype || code !== filter.missingCode)
        && filter.visibleByCode[code] === 0
      ) {
        visible = false;
      }
    }

    for (let cf = 0; visible && cf < continuousFilters.length; cf++) {
      const filter = continuousFilters[cf];
      const v = filter.values[i];
      if (v !== v || v < filter.min || v > filter.max) visible = false;
    }

    if (visible && varValues !== null) {
      const v = varValues[i];
      if (v !== v || v < varMin || v > varMax) visible = false;
    }

    // The outlier filter of the active field (only when it applies).
    if (visible && outliers !== null) {
      const q = outliers[i];
      if (q >= 0 && q > outlierThreshold) visible = false;
    }

    const value = visible ? 1 : 0;
    transparency[i] = value;
    colors[i * 4 + 3] = value * 255;
    shown += value;
  }
  return shown;
}

/*
 * Visibility results kept for reuse. A pass's result is a pure function of its
 * inputs: the cell mask (by identity and write count), each category filter's
 * codes (by identity) and per-code table (by value), each continuous filter's
 * values (by identity) and range, the active gene's filter, and the active
 * field's outlier quantiles and threshold. Each transparency array a pass wrote
 * carries those inputs and its write count; while the count stands the array
 * still holds that result, whichever view holds it now (a kept view never
 * writes an array it shares). Views with identical filters -- the kept views of
 * a session restore, a switch between kept views -- then cost one copy instead
 * of a pass over every cell. Keyed weakly by the array, an entry lives exactly
 * as long as a view holds its result.
 */
const VISIBILITY_RESULTS = new WeakMap();

function sameVisibilityInputs(a, b) {
  if (
    a.mask !== b.mask
    || a.maskWrites !== b.maskWrites
    || a.varValues !== b.varValues
    || a.varMin !== b.varMin
    || a.varMax !== b.varMax
    || a.outliers !== b.outliers
    || a.outlierThreshold !== b.outlierThreshold
    || a.categoryFilters.length !== b.categoryFilters.length
    || a.continuousFilters.length !== b.continuousFilters.length
  ) {
    return false;
  }
  for (let f = 0; f < a.categoryFilters.length; f++) {
    const x = a.categoryFilters[f];
    const y = b.categoryFilters[f];
    if (x.codes !== y.codes || x.visibleByCode.length !== y.visibleByCode.length) {
      return false;
    }
    for (let code = 0; code < x.visibleByCode.length; code++) {
      if (x.visibleByCode[code] !== y.visibleByCode[code]) return false;
    }
  }
  for (let f = 0; f < a.continuousFilters.length; f++) {
    const x = a.continuousFilters[f];
    const y = b.continuousFilters[f];
    if (x.values !== y.values || x.min !== y.min || x.max !== y.max) return false;
  }
  return true;
}

/**
 * A transparency array some view holds that still carries the result of
 * exactly these inputs, or null.
 *
 * @returns {{transparency: Uint8Array, shown: number}|null}
 */
function findVisibilityResult(state, inputs) {
  const candidates = [state.categoryTransparency];
  if (state.viewContexts instanceof Map) {
    for (const ctx of state.viewContexts.values()) {
      const held = ctx?.categoryTransparency;
      if (held instanceof Uint8Array && !candidates.includes(held)) candidates.push(held);
    }
  }
  for (const transparency of candidates) {
    const entry = VISIBILITY_RESULTS.get(transparency);
    if (
      entry !== undefined
      && transparency.length === state.pointCount
      && entry.writes === transparencyArrayWrites(transparency)
      && sameVisibilityInputs(entry.inputs, inputs)
    ) {
      return { transparency, shown: entry.shown };
    }
  }
  return null;
}

function recordVisibilityResult(transparency, inputs, shown) {
  VISIBILITY_RESULTS.set(transparency, {
    inputs,
    writes: transparencyArrayWrites(transparency),
    shown,
  });
}

/** Each cell's alpha byte from its visibility (exactly 0 or 1). */
function publishAlphaBytes(transparency, colors, pointCount) {
  for (let i = 0, j = 3; i < pointCount; i++, j += 4) {
    colors[j] = transparency[i] * 255;
  }
}

export class DataStateFilterMethods {
  computeGlobalVisibility() {
    // Inside a batch (a filter restore, a session view's filters and active
    // field) the pass runs once, at `endBatch`, from the final state.
    if (this._batchMode === true) {
      this._batchDirty.visibility = true;
      return;
    }
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
    requireBinaryCellVisibilityMask(this.cellVisibilityMask);

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
    // Numbers even when unused: the per-cell loop below is compiled with
    // these as doubles, and a null would deoptimize it on every later call.
    let outlierThreshold = 1;
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

    let activeVarFilterMin = 0;
    let activeVarFilterMax = 0;
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

    const cellVisibilityMask = this.cellVisibilityMask;
    const inputs = {
      mask: cellVisibilityMask,
      maskWrites: cellVisibilityMaskWrites(cellVisibilityMask),
      categoryFilters,
      continuousFilters,
      varValues: activeVarFilterEnabled ? activeVarValues : null,
      varMin: activeVarFilterMin,
      varMax: activeVarFilterMax,
      outliers: applyOutlierFilter ? outliers : null,
      outlierThreshold,
    };
    const publishedColors = this.colorsArray;
    let transparency;
    let colors;
    let shown;
    const reusable = findVisibilityResult(this, inputs);
    if (reusable !== null) {
      // A view already holds this exact visibility: it is adopted, and only
      // the alpha bytes of this view's colors are published from it.
      if (reusable.transparency === this.categoryTransparency) {
        transparency = reusable.transparency;
      } else {
        transparency = writableTransparency(this);
        transparency.set(reusable.transparency);
        recordVisibilityResult(transparency, inputs, reusable.shown);
      }
      colors = writableColorAlphaBytes(this);
      publishAlphaBytes(transparency, colors, pointCount);
      shown = reusable.shown;
    } else {
      // One pass writes each cell's visibility, the alpha byte of its packed
      // color and the shown count; a mask entry, filter table or value is read
      // once a cell. Every array is exactly `pointCount` long (checked above).
      // Every branch below rewrites every entry; a kept view still sharing an
      // array keeps the old one (per-cell-array-ownership.js).
      transparency = writableTransparency(this);
      colors = writableColorAlphaBytes(this);
      if (!hasAnyFilter) {
        // Every mask entry is exactly 0 or 1, so with no filter active the
        // published visibility *is* the mask.
        shown = publishMaskVisibility(cellVisibilityMask, transparency, colors, pointCount);
      } else if (
        categoryFilters.length === 1 &&
        continuousFilters.length === 0 &&
        !activeVarFilterEnabled &&
        !applyOutlierFilter
      ) {
        // The commonest filter -- categories hidden on one field -- with the
        // per-code table read straight into the visibility: it holds exactly
        // the 0 or 1 the general loop writes, at half its cost.
        shown = publishCategoryVisibility(
          cellVisibilityMask, categoryFilters[0], transparency, colors, pointCount
        );
      } else if (
        categoryFilters.length === 0 &&
        continuousFilters.length === 0 &&
        !activeVarFilterEnabled
      ) {
        // The outlier slider alone.
        shown = publishOutlierVisibility(
          cellVisibilityMask, outliers, outlierThreshold, transparency, colors, pointCount
        );
      } else {
        shown = publishFilteredVisibility(
          cellVisibilityMask,
          categoryFilters,
          continuousFilters,
          activeVarFilterEnabled ? activeVarValues : null,
          activeVarFilterMin,
          activeVarFilterMax,
          applyOutlierFilter ? outliers : null,
          outlierThreshold,
          transparency,
          colors,
          pointCount
        );
      }
      recordVisibilityResult(transparency, inputs, shown);
    }

    if (colors !== publishedColors && String(this.activeViewId) === 'live') {
      // The live viewer and renderer hold the state's colors by reference; a
      // copy-on-write moved the state to a new array, so it is republished.
      this._pushColorsToViewer();
    }
    this.filteredCount = { shown, total: pointCount };
    // What `updateFilteredCount` would count from, so it can answer from here.
    this._filteredCountMemo = {
      transparency,
      epoch: transparencyEpoch(this),
      outliers,
      threshold: outlierThreshold,
      shown,
    };
    const centroidsChanged = this._updateActiveCategoryCounts();
    this._pushTransparencyToViewer();
    if (centroidsChanged) this._pushCentroidsToViewer();
    this._syncActiveContext();
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
