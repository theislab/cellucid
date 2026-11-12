/**
 * @fileoverview Filter Manager.
 *
 * Hosts visibility computation and filter summary logic.
 *
 * ⚡ PERFORMANCE CRITICAL: `computeGlobalVisibility()` runs on every filter change.
 *
 * @module state/managers/filter-manager
 */

import { categoryVisibilityText } from '../../utils/category-visibility-text.js';
import { rgbToCss, COLOR_PICKER_PALETTE } from '../../../data/palettes.js';
import { BaseManager } from '../core/base-manager.js';
import { requireCategoryCodesInInventory } from './category-codes.js';
import {
  cellVisibilityMaskWrites,
  isAllShownCellVisibilityMask,
  requireBinaryCellVisibilityMask,
  transparencyArrayWrites,
  transparencyEpoch,
  writableCellVisibilityMask,
  writableNeutralColors,
  writableTransparency,
} from './per-cell-array-ownership.js';
import { isCategoricalCodes, missingCategoryCode } from '../../../data/categorical-storage-contract.js';
import { requireOutlierQuantiles } from './color-outliers.js';
import { formatBound, formatPercent } from '../../../utils/format-units.js';
import { categoryRgbAt, hiddenCategoryCount, withCategoriesVisible, withCategoryChanges, withCategoryColor, withCategoryVisibility } from '../../utils/category-state.js';
import {
  categoryCellLimitsOf,
  cellSampleFilterOf,
  withCategoryCellLimit,
  withoutCategoryCellLimits,
} from './category-cell-sample.js';
import { setWorkingSet } from '../../../data/memory-budget.js';
import { geneValueLabel } from '../../../data/expression-transform.js';
import { categoryDisplayName } from '../../actions/targets/names.js';

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

function isContinuousFilterFullRange(filter, stats) {
  return (
    filter.min === stats.min
    && filter.max === stats.max
  );
}

/*
 * Every filter applies until it is removed, whatever a view is colored by
 * (owner decision 2026-10-28): a gene's range filter and a categorical
 * field's outlier filter hide cells exactly as an obs range or category
 * filter does, after the view is colored by another field. The Active
 * filters list shows each, the visibility pass applies each, and "Visible
 * cells" analyses read that visibility. These three predicates are the one
 * definition of "this field has a filter" every consumer reads.
 */

/**
 * Whether a continuous field (obs or gene) has a range filter that hides
 * cells when it is enabled: narrower than the field's range.
 *
 * @param {object} field
 * @returns {boolean}
 */
export function hasRangeFilter(field) {
  return Boolean(
    field
    && field._isDeleted !== true
    && field.kind === 'continuous'
    && field._continuousStats
    && field._continuousFilter
    && !isContinuousFilterFullRange(field._continuousFilter, field._continuousStats)
  );
}

/**
 * A categorical field's outlier threshold: 1 keeps every cell.
 *
 * @param {object} field
 * @returns {number}
 */
export function outlierThresholdOf(field) {
  return field?._outlierThreshold != null ? field._outlierThreshold : 1.0;
}

/**
 * Whether a categorical field has an outlier filter that hides cells when it
 * is enabled: its quantiles are got and its threshold is below 1.
 *
 * @param {object} field
 * @returns {boolean}
 */
/**
 * Whether a categorical field's filter narrows its cells, switched on or off:
 * a category hidden, the cells without a category hidden (`_missingVisible`),
 * or a category that keeps only some of its cells. All of them read its
 * codes, so its codes stay resident (`field/residency.js`). A field whose
 * every category is shown, however often it was colored, filters nothing.
 *
 * @param {object} field
 * @returns {boolean}
 */
export function hasCategoryFilter(field) {
  if (field._missingVisible === false || categoryCellLimitsOf(field).length > 0) return true;
  return field._categoryVisible !== undefined && hiddenCategoryCount(field._categoryVisible) > 0;
}

export function hasOutlierFilter(field) {
  return Boolean(
    field
    && field._isDeleted !== true
    && field.kind === 'category'
    && field.outlierQuantiles
    && field.outlierQuantiles.length > 0
    && outlierThresholdOf(field) < 0.9999
  );
}

/**
 * The fields of an inventory with a filter by `has`, with their indices.
 * Read on every filter-list render and visibility pass; a gene inventory is
 * walked once per call.
 *
 * @param {object|null} inventory - `obsData` or `varData`
 * @param {(field: object) => boolean} has
 * @returns {Array<{field: object, index: number}>}
 */
function fieldsWith(inventory, has) {
  const fields = inventory?.fields;
  const out = [];
  if (!Array.isArray(fields)) return out;
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (field && typeof field === 'object' && has(field)) out.push({ field, index });
  }
  return out;
}

/**
 * The genes whose range filter hides cells, with their indices in `varData`.
 *
 * @param {object|null} varData
 * @returns {Array<{field: object, index: number}>}
 */
export function rangeFilteredVarFields(varData) {
  return fieldsWith(varData, hasRangeFilter);
}

/** What the filter list and the legend call the cells of a categorical field without a category. */
export const MISSING_LABEL = 'Missing';

/**
 * Whether an open cell of a categorical field has no category: only then do
 * the legend's Missing row and the filter list name those cells (a field
 * hidden whole hides "Missing" too, whether or not any cell lacks one).
 */
function hasMissingCells(field) {
  const codes = field.codes;
  return isCategoricalCodes(codes) && codes.indexOf(missingCategoryCode(codes)) !== -1;
}

/**
 * A range filter's bounds as the filter list and figure provenance state
 * them: as every range bound is written (`formatBound`), so a bound typed or
 * set by a slider reads exactly as applied.
 */
function rangeText(filter) {
  return `${formatBound(filter.min)} – ${formatBound(filter.max)}`;
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
 * view's filters never depend on whether it happens to be focused, nor on
 * which field it is colored by: every range, category, gene and outlier
 * filter is listed until it is removed.
 *
 * @param {{obsData: object|null, varData: object|null}} view
 * @param {{geneSampled?: boolean, geneValues?: {normalize: boolean, log1p: boolean}|null}} [options] -
 *   `geneSampled`: genes are read for a sample of the open cells (`gene-sample.js`),
 *   whose others a gene's range keeps; `geneValues`: what the genes' values are
 *   in (Data mapping › Expression values, `getShownExpressionTransform`), so a
 *   gene's range names its units ("Ins1 · log1p(norm.): 1 – 2", `geneValueLabel`);
 *   a gene made in the app keeps its own values
 */
export function collectViewFilters(view, { geneSampled = false, geneValues = null } = {}) {
  if (!view.obsData || !view.obsData.fields) return [];
  const fields = view.obsData.fields;
  const filters = [];
  const disabled = enabled => (enabled ? '' : ' (disabled)');

  for (let fi = 0; fi < fields.length; fi++) {
    const field = fields[fi];
    if (!field) continue;
    if (field._isDeleted === true) continue;
    const key = field.key || `Field ${fi + 1}`;

    // Continuous field filter
    if (hasRangeFilter(field)) {
      const enabled = field._filterEnabled !== false; // default true
      filters.push({
        id: `obs-continuous-${fi}`,
        type: 'continuous',
        source: 'obs',
        fieldIndex: fi,
        fieldKey: key,
        enabled: enabled,
        text: `${key}: ${rangeText(field._continuousFilter)}${disabled(enabled)}`
      });
    }

    // Categorical field hidden categories
    if (field.kind === 'category') {
      const categories = field.categories || [];
      const visible = field._categoryVisible;
      const hiddenNames = [];
      const shownNames = [];
      // Only a field that hides some category, or its cells without one, is walked.
      const hidesCategory = visible !== undefined && hiddenCategoryCount(visible) > 0;
      const missingHidden = field._missingVisible === false;
      if (hidesCategory || missingHidden) {
        for (let i = 0; i < categories.length; i++) {
          (visible !== undefined && visible[i] === 0 ? hiddenNames : shownNames).push(categoryDisplayName(categories[i]));
        }
        // Cells without a category (the legend's Missing row), when there are any.
        if (hasMissingCells(field)) (missingHidden ? hiddenNames : shownNames).push(MISSING_LABEL);
      }
      // Categories shown that keep only some of their cells (the legend's count).
      const limits = categoryCellLimitsOf(field).filter(limit => visible === undefined || visible[limit.category] !== 0);
      if (hiddenNames.length > 0 || limits.length > 0) {
        const enabled = field._categoryFilterEnabled !== false; // default true
        const parts = [];
        if (hiddenNames.length > 0) parts.push(categoryVisibilityText(hiddenNames, shownNames));
        if (limits.length > 0) {
          const kept = limits.slice(0, 2).map(limit => `${limit.count} of ${categoryDisplayName(categories[limit.category])}`).join(', ');
          parts.push(`keeping ${kept}${limits.length > 2 ? ` +${limits.length - 2} more` : ''}`);
        }
        filters.push({
          id: `obs-category-${fi}`,
          type: 'category',
          source: 'obs',
          fieldIndex: fi,
          fieldKey: key,
          enabled: enabled,
          hiddenCount: hiddenNames.length,
          text: `${key}: ${parts.join('; ')}${disabled(enabled)}`
        });
      }

      // Outlier filter
      if (hasOutlierFilter(field)) {
        const enabled = field._outlierFilterEnabled !== false; // default true
        const pct = outlierThresholdOf(field) * 100;
        filters.push({
          id: `obs-outlier-${fi}`,
          type: 'outlier',
          source: 'obs',
          fieldIndex: fi,
          fieldKey: key,
          enabled: enabled,
          text: `${key}: outlier ≤ ${formatPercent(pct)}${disabled(enabled)}`
        });
      }
    }
  }

  // Gene (var field) range filters; a gene read for a sample of the open
  // cells (`geneSampled`) keeps the others (`publishFilteredVisibility`),
  // and says so.
  for (const { field, index } of rangeFilteredVarFields(view.varData)) {
    const enabled = field._filterEnabled !== false; // default true
    filters.push({
      id: `var-continuous-${index}`,
      type: 'continuous',
      source: 'var',
      fieldIndex: index,
      fieldKey: field.key,
      enabled: enabled,
      text: `${geneValueLabel(field.key, field._isUserDefined === true ? null : geneValues)}: ${rangeText(field._continuousFilter)}${geneSampled ? ', cells not read kept' : ''}${disabled(enabled)}`
    });
  }

  return filters;
}

/*
 * Per-cell visibility kernels of `computeGlobalVisibility`. Each writes every
 * cell's visibility (exactly 0 or 1) and returns how many cells it showed, in
 * one pass. Visibility lives in the transparency alone: the renderer draws it
 * from its R8 alpha texture, so the colors are never written for a filter.
 * They are separate functions so each is compiled for its own loop: inside
 * one large method, a loop that
 * had not run yet was optimized without type feedback and deoptimized on its
 * first real use (a 40 ms first outlier step at 562,000 cells).
 */

function publishMaskVisibility(mask, transparency, pointCount) {
  let shown = 0;
  for (let i = 0; i < pointCount; i++) {
    const visible = mask[i];
    transparency[i] = visible;
    shown += visible;
  }
  return shown;
}

function publishCategoryVisibility(mask, filter, transparency, pointCount) {
  const { codes, visibleByCode, missingCode, missingVisible, spansDtype } = filter;
  let shown = 0;
  if (spansDtype) {
    for (let i = 0; i < pointCount; i++) {
      const visible = mask[i] === 0 ? 0 : visibleByCode[codes[i]];
      transparency[i] = visible;
      shown += visible;
    }
    return shown;
  }
  for (let i = 0; i < pointCount; i++) {
    const code = codes[i];
    const visible = mask[i] === 0
      ? 0
      : code === missingCode ? missingVisible : visibleByCode[code];
    transparency[i] = visible;
    shown += visible;
  }
  return shown;
}

/**
 * `publishCategoryVisibility` for a mask known to show every cell
 * (`isAllShownCellVisibilityMask`): the mask is not read, so a cell's
 * visibility is its code's table entry.
 */
function publishCategoryVisibilityUnmasked(filter, transparency, pointCount) {
  const { codes, visibleByCode, missingCode, missingVisible, spansDtype } = filter;
  let shown = 0;
  if (spansDtype) {
    for (let i = 0; i < pointCount; i++) {
      const visible = visibleByCode[codes[i]];
      transparency[i] = visible;
      shown += visible;
    }
    return shown;
  }
  for (let i = 0; i < pointCount; i++) {
    const code = codes[i];
    const visible = code === missingCode ? missingVisible : visibleByCode[code];
    transparency[i] = visible;
    shown += visible;
  }
  return shown;
}

function publishOutlierVisibility(mask, outliers, threshold, transparency, pointCount) {
  let shown = 0;
  for (let i = 0; i < pointCount; i++) {
    const q = outliers[i];
    const visible = q >= 0 && q > threshold ? 0 : mask[i];
    transparency[i] = visible;
    shown += visible;
  }
  return shown;
}

function publishFilteredVisibility(
  mask,
  categoryFilters,
  sampleFilters,
  continuousFilters,
  outlierFilters,
  transparency,
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
        filter.spansDtype || code !== filter.missingCode
          ? filter.visibleByCode[code] === 0
          : filter.missingVisible === 0
      ) {
        visible = false;
      }
    }

    // Categories that keep only some of their cells: a cell of one is shown
    // when its bit is set (`category-cell-sample.js`).
    for (let sf = 0; visible && sf < sampleFilters.length; sf++) {
      const filter = sampleFilters[sf];
      const code = filter.codes[i];
      if (code < filter.limited.length && filter.limited[code] === 1 && (filter.bits[i >>> 3] & (1 << (i & 7))) === 0) {
        visible = false;
      }
    }

    // Obs and gene ranges alike. A gene read for a sample of the cells
    // (`readTo`, `gene-sample.js`) has no value past it: those cells are not
    // judged by it, and stay.
    for (let cf = 0; visible && cf < continuousFilters.length; cf++) {
      const filter = continuousFilters[cf];
      const v = filter.values[i];
      if (i < filter.readTo && (v !== v || v < filter.min || v > filter.max)) visible = false;
    }

    // Each categorical field's outlier filter.
    for (let of = 0; visible && of < outlierFilters.length; of++) {
      const filter = outlierFilters[of];
      const q = filter.quantiles[i];
      if (q >= 0 && q > filter.threshold) visible = false;
    }

    const value = visible ? 1 : 0;
    transparency[i] = value;
    shown += value;
  }
  return shown;
}

/*
 * Visibility results kept for reuse. A pass's result is a pure function of its
 * inputs: the cell mask (by identity and write count), each category filter's
 * codes (by identity) and per-code table (by value), each range filter's
 * values (by identity) and range (obs fields and genes), and each outlier
 * filter's quantiles (by identity) and threshold. Each transparency array a pass wrote
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
    || a.categoryFilters.length !== b.categoryFilters.length
    || a.sampleFilters.length !== b.sampleFilters.length
    || a.continuousFilters.length !== b.continuousFilters.length
    || a.outlierFilters.length !== b.outlierFilters.length
  ) {
    return false;
  }
  for (let f = 0; f < a.outlierFilters.length; f++) {
    const x = a.outlierFilters[f];
    const y = b.outlierFilters[f];
    if (x.quantiles !== y.quantiles || x.threshold !== y.threshold) return false;
  }
  for (let f = 0; f < a.categoryFilters.length; f++) {
    const x = a.categoryFilters[f];
    const y = b.categoryFilters[f];
    if (
      x.codes !== y.codes
      || x.missingVisible !== y.missingVisible
      || x.visibleByCode.length !== y.visibleByCode.length
    ) {
      return false;
    }
    for (let code = 0; code < x.visibleByCode.length; code++) {
      if (x.visibleByCode[code] !== y.visibleByCode[code]) return false;
    }
  }
  // A sample filter is immutable once made (`cellSampleFilterOf`): the same
  // object is the same cells.
  for (let f = 0; f < a.sampleFilters.length; f++) {
    if (a.sampleFilters[f] !== b.sampleFilters[f]) return false;
  }
  for (let f = 0; f < a.continuousFilters.length; f++) {
    const x = a.continuousFilters[f];
    const y = b.continuousFilters[f];
    if (x.values !== y.values || x.min !== y.min || x.max !== y.max || x.readTo !== y.readTo) return false;
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

/**
 * The inputs of the visibility `transparency` holds: those of the pass that
 * wrote it, while it has not been written since; otherwise null.
 *
 * @param {Uint8Array} transparency
 * @returns {object|null}
 */
export function visibilityResultInputs(transparency) {
  const entry = VISIBILITY_RESULTS.get(transparency);
  if (entry === undefined || entry.writes !== transparencyArrayWrites(transparency)) {
    return null;
  }
  return entry.inputs;
}

/**
 * Record that `transparency` holds the visibility of `mask` with no filter:
 * every cell the mask shows (a dataset's first generation, all 1s, which
 * `computeGlobalVisibility` would compute for it), so the first pass adopts
 * it instead of computing it again.
 *
 * @param {Uint8Array} transparency
 * @param {Uint8Array} mask - A mask showing every cell
 *   (`createShownCellVisibilityMask`); `transparency` holds only 1s.
 */
export function recordUnfilteredVisibility(transparency, mask) {
  if (!isAllShownCellVisibilityMask(mask) || transparency.length !== mask.length) {
    throw new TypeError('An unfiltered first visibility needs a mask showing every cell.');
  }
  recordVisibilityResult(transparency, {
    mask,
    maskWrites: cellVisibilityMaskWrites(mask),
    categoryFilters: [],
    sampleFilters: [],
    continuousFilters: [],
    outlierFilters: [],
  }, mask.length);
}

function recordVisibilityResult(transparency, inputs, shown) {
  VISIBILITY_RESULTS.set(transparency, {
    inputs,
    writes: transparencyArrayWrites(transparency),
    shown,
  });
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

    const categoryFilters = [];
    // Categories of a field that keep only some of their cells.
    const sampleFilters = [];
    const continuousFilters = [];
    // Every categorical field's outlier filter, whatever is colored.
    const outlierFilters = [];

    for (let f = 0; f < fields.length; f++) {
      const field = fields[f];
      if (!field || typeof field !== 'object' || Array.isArray(field)) {
        throw new TypeError(`Observation field ${f} must be an object.`);
      }
      if (field._isDeleted === true) continue;

      // A field released from memory (`loaded: false`: `field/residency.js`)
      // keeps what was set on it (its colors, every category shown, a full
      // range) and holds no array: it is read again when used, and its filter
      // needs its array only when it narrows, which keeps the array resident.
      // A narrowing filter on a field not read is refused below.
      if (field.kind === 'category' && field._categoryVisible !== undefined && (field.loaded !== false || hasCategoryFilter(field))) {
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
          const shown = field._categoryVisible;
          // One byte per code, so the per-cell test is a single typed load.
          // For uint8 and uint16 codes the table spans every code the dtype
          // can hold and the missing code reads whether cells without a
          // category are shown (`_missingVisible`, the legend's Missing
          // row). A uint32 table spans the inventory only (2^32 bytes would
          // not fit), and the missing code is tested by value. Every other
          // code is proven inside the inventory above.
          const missingCode = missingCategoryCode(field.codes);
          const spansDtype = missingCode <= 0xffff;
          const missingVisible = field._missingVisible === false ? 0 : 1;
          const visibleByCode = new Uint8Array(spansDtype ? missingCode + 1 : numCats);
          if (spansDtype) visibleByCode[missingCode] = missingVisible;
          const hasHidden = missingVisible === 0 || hiddenCategoryCount(shown) > 0;
          visibleByCode.set(shown);
          if (hasHidden) {
            categoryFilters.push({
              codes: field.codes,
              visibleByCode,
              missingCode,
              missingVisible,
              spansDtype
            });
          }
          const sample = cellSampleFilterOf(field, this.cellIdentity);
          if (sample !== null) sampleFilters.push(sample);
        }
      } else if (
        field.kind === 'continuous'
        && (
          field._continuousStats !== undefined
          || field._continuousFilter !== undefined
        )
        && (field.loaded !== false || hasRangeFilter(field))
      ) {
        const metadata = this.ensureContinuousMetadata(field);
        if (field._filterEnabled) {
          const stats = metadata.stats;
          const filter = metadata.filter;
          if (!isContinuousFilterFullRange(filter, stats)) {
            continuousFilters.push({
              values: field.values,
              min: filter.min,
              max: filter.max,
              readTo: pointCount
            });
          }
        }
      } else if (field.kind !== 'category' && field.kind !== 'continuous') {
        throw new TypeError(`Observation field ${f} has an unsupported kind.`);
      }

      if (hasOutlierFilter(field) && field._outlierFilterEnabled !== false) {
        // The field's own quantiles, proven -1 or within [0, 1] once per
        // decoded array.
        const threshold = outlierThresholdOf(field);
        if (!Number.isFinite(threshold) || threshold < 0) {
          throw new TypeError(`The outlier threshold of "${field.key}" must be from 0 through 1.`);
        }
        outlierFilters.push({
          quantiles: requireOutlierQuantiles(field.outlierQuantiles, pointCount),
          threshold
        });
      }
    }

    // Every gene's range filter, whatever is colored. A filtered gene's
    // values stay resident (`field/residency.js`). A gene read for a sample
    // of the open cells judges those cells only: the others keep showing.
    const geneReadTo = this.getGeneSample?.()?.cells ?? pointCount;
    for (const { field } of rangeFilteredVarFields(this.varData)) {
      const metadata = this.ensureContinuousMetadata(field);
      if (!field._filterEnabled) continue;
      if (!ArrayBuffer.isView(field.values) || field.values.length !== pointCount) {
        throw new TypeError(`The range filter of gene "${field.key}" needs its values of every open cell.`);
      }
      continuousFilters.push({
        values: field.values,
        min: metadata.filter.min,
        max: metadata.filter.max,
        readTo: geneReadTo
      });
    }

    // The kept cells' bits grow with the open cells: the working set's.
    setWorkingSet('category cell samples', sampleFilters.reduce((sum, filter) => sum + filter.bytes, 0));

    const hasAnyFilter =
      categoryFilters.length > 0 ||
      sampleFilters.length > 0 ||
      continuousFilters.length > 0 ||
      outlierFilters.length > 0;

    const cellVisibilityMask = this.cellVisibilityMask;
    const inputs = {
      mask: cellVisibilityMask,
      maskWrites: cellVisibilityMaskWrites(cellVisibilityMask),
      categoryFilters,
      sampleFilters,
      continuousFilters,
      outlierFilters,
    };
    let transparency;
    let shown;
    const reusable = findVisibilityResult(this, inputs);
    if (reusable !== null) {
      // A view already holds this exact visibility: it is adopted.
      if (reusable.transparency === this.categoryTransparency) {
        transparency = reusable.transparency;
      } else {
        transparency = writableTransparency(this);
        transparency.set(reusable.transparency);
        recordVisibilityResult(transparency, inputs, reusable.shown);
      }
      shown = reusable.shown;
    } else {
      // One pass writes each cell's visibility and the shown count; a mask
      // entry, filter table or value is read once a cell. Every array is
      // exactly `pointCount` long (checked above). Every branch below
      // rewrites every entry; a kept view still sharing the array keeps the
      // old one (per-cell-array-ownership.js).
      transparency = writableTransparency(this);
      if (!hasAnyFilter) {
        // Every mask entry is exactly 0 or 1, so with no filter active the
        // published visibility *is* the mask.
        shown = publishMaskVisibility(cellVisibilityMask, transparency, pointCount);
      } else if (
        categoryFilters.length === 1 &&
        sampleFilters.length === 0 &&
        continuousFilters.length === 0 &&
        outlierFilters.length === 0
      ) {
        // The commonest filter -- categories hidden on one field -- with the
        // per-code table read straight into the visibility: it holds exactly
        // the 0 or 1 the general loop writes, at half its cost.
        shown = isAllShownCellVisibilityMask(cellVisibilityMask)
          ? publishCategoryVisibilityUnmasked(categoryFilters[0], transparency, pointCount)
          : publishCategoryVisibility(
            cellVisibilityMask, categoryFilters[0], transparency, pointCount
          );
      } else if (
        categoryFilters.length === 0 &&
        sampleFilters.length === 0 &&
        continuousFilters.length === 0 &&
        outlierFilters.length === 1
      ) {
        // One outlier slider alone.
        shown = publishOutlierVisibility(
          cellVisibilityMask,
          outlierFilters[0].quantiles,
          outlierFilters[0].threshold,
          transparency,
          pointCount
        );
      } else {
        shown = publishFilteredVisibility(
          cellVisibilityMask,
          categoryFilters,
          sampleFilters,
          continuousFilters,
          outlierFilters,
          transparency,
          pointCount
        );
      }
      recordVisibilityResult(transparency, inputs, shown);
    }

    this.filteredCount = { shown, total: pointCount };
    // What `updateFilteredCount` would count from, so it can answer from here.
    this._filteredCountMemo = {
      transparency,
      epoch: transparencyEpoch(this),
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
    return collectViewFilters(this, { geneSampled: (this.getGeneSample?.() ?? null) !== null, geneValues: this.getShownExpressionTransform?.() ?? null });
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
      // With "rescale colors to filter" on, the color range tracks the
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
      withCategoriesVisible(field, true);
      withoutCategoryCellLimits(field);
      field._missingVisible = true;
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
   * The point colors belong to the active field alone. A filter on another
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
    const numCats = categories.length;
    if (
      (!Array.isArray(categories))
      || !isCategoricalCodes(codes)
      || codes.length !== n
      || !(catColors instanceof Uint8Array)
      || catColors.length !== numCats * 3
      || !(this.colorsArray instanceof Uint8Array)
      || this.colorsArray.length !== n * 4
      || !(this.categoryTransparency instanceof Uint8Array)
      || this.categoryTransparency.length !== n
    ) {
      throw new TypeError('Category color refresh requires complete typed field buffers.');
    }
    // Colors carry no visibility (their alpha byte is always 255): every
    // caller recomputes the transparency next (`reapplyCategoryColors`,
    // `removeFilter`, `endBatch`).
    this._writeCategoryColors(field);
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
    return categoryRgbAt(field._categoryColors, idx);
  }

  setColorForCategory(field, idx, color) {
    requireCategoryFieldAndIndex(field, idx);
    requireRgb(color);
    this.ensureCategoryMetadata(field);
    withCategoryColor(field, idx, color);
    if (this._batchMode) {
      this._batchDirty.colors = true;
      this._batchDirty.affectedFields.add(field);
    } else {
      this.reapplyCategoryColors(field);
    }
    this._notifyColorChange(field);
  }


  setVisibilityForCategory(field, idx, visible) {
    requireCategoryFieldAndIndex(field, idx);
    if (typeof visible !== 'boolean') {
      throw new TypeError('Category visibility must be exactly true or false.');
    }
    this.ensureCategoryMetadata(field);
    withCategoryVisibility(field, idx, visible);
    if (this._batchMode) {
      this._batchDirty.visibility = true;
      this._batchDirty.colors = true; // visibility changes affect color display
      this._batchDirty.affectedFields.add(field);
    } else {
      this.reapplyCategoryColors(field);
    }
  }

  /**
   * Several categories' visibility and colors at once (a restored
   * session's): each array copied once (`withCategoryChanges`), the field
   * drawn again once.
   *
   * @param {Object} field
   * @param {{visibility: Array<{index: number, visible: boolean}>, colors: Array<{index: number, rgb: number[]}>}} changes
   */
  setCategoryStates(field, changes) {
    if (field === null || typeof field !== 'object' || field.kind !== 'category') {
      throw new TypeError('Category filter operation requires a category field.');
    }
    for (const { rgb } of changes.colors) requireRgb(rgb);
    this.ensureCategoryMetadata(field);
    withCategoryChanges(field, changes);
    if (this._batchMode) {
      this._batchDirty.visibility = true;
      this._batchDirty.colors = true;
      this._batchDirty.affectedFields.add(field);
    } else {
      this.reapplyCategoryColors(field);
    }
    if (changes.colors.length > 0) this._notifyColorChange(field);
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

  /**
   * Show or hide the cells of a categorical field that have no category
   * (the legend's Missing row): a filter like a hidden category, kept in
   * sessions.
   *
   * @param {object} field
   * @param {boolean} visible
   */
  setMissingCategoryVisibility(field, visible) {
    if (field === null || typeof field !== 'object' || field.kind !== 'category') {
      throw new TypeError('Missing-value visibility belongs to a category field.');
    }
    if (typeof visible !== 'boolean') {
      throw new TypeError('Missing-value visibility must be exactly true or false.');
    }
    this.ensureCategoryMetadata(field);
    field._missingVisible = visible;
    if (this._batchMode) {
      this._batchDirty.visibility = true;
      this._batchDirty.affectedFields.add(field);
    } else {
      this.computeGlobalVisibility();
    }
  }

  /**
   * Keep only `limit.count` of the cells of one category shown, a sample
   * drawn with `limit.seed` (`category-cell-sample.js`); null shows all its
   * cells again. A filter like a hidden category: listed in Active filters,
   * turned off with the field's category filter, kept in sessions.
   *
   * @param {object} field - A categorical field
   * @param {number} categoryIndex
   * @param {{count: number, seed: number}|null} limit
   */
  setCategoryCellLimit(field, categoryIndex, limit) {
    requireCategoryFieldAndIndex(field, categoryIndex);
    this.ensureCategoryMetadata(field);
    withCategoryCellLimit(field, categoryIndex, limit);
    if (this._batchMode) {
      this._batchDirty.visibility = true;
      this._batchDirty.affectedFields.add(field);
    } else {
      this.computeGlobalVisibility();
    }
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
    withCategoriesVisible(field, true, available === null ? null : index => available[index] !== 0);
    // Every cell of every category: none keeps only some.
    withoutCategoryCellLimits(field);
    field._missingVisible = true;
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
    withCategoriesVisible(field, false, available === null ? null : index => available[index] !== 0);
    withoutCategoryCellLimits(field);
    field._missingVisible = false;
    this.reapplyCategoryColors(field);
  }

  rgbToCss(color) { return rgbToCss(color); }

  clearActiveField() {
    this.activeFieldIndex = -1;
    this.activeVarFieldIndex = -1;
    this.activeFieldSource = null;
    if (this.colorsArray) {
      // Neutral gray (left as it is when it already holds it); the
      // visibility is the transparency the pass below publishes.
      writableNeutralColors(this);
    }
    if (!this.categoryTransparency || this.categoryTransparency.length !== this.pointCount) {
      this.categoryTransparency = new Uint8Array(this.pointCount).fill(1);
    }
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
   * `colors` is the active view's array itself: the viewer and renderer keep
   * it by reference, the new view context adopts it, and from then on it is
   * never written again (`markSnapshotPublishedColors`), so whichever view
   * recolors first writes a copy and keeping a view copies nothing until the
   * views diverge. `transparency` is the active view's array, lent for one
   * synchronous publication (`publishSnapshotView`): the viewer copies it,
   * and the new context shares it with this view until either one writes.
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
      colors: this.colorsArray ?? null,
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
