/**
 * @fileoverview The `filters` state domain: which cells each view's filters
 * show, per field, for every view.
 *
 * Value: `{views: [ViewFilters, …]}` (live first, then kept views:
 * `view-list.js`), each `ViewFilters` a list of the fields whose filter
 * differs from the field's opening state, in reference order:
 *
 *     {field: {source, key}|{source, user},   // fields.js
 *      off?: true,                 // the field's filter is switched off (Active filters)
 *      hidden?: [label, …],        // categories hidden, in category order, then the
 *                                  // labels held for cells not open yet (pending-categories.js)
 *      limits?: [{category: label, count, seed}, …],
 *                                  // categories that keep only some of their cells shown
 *                                  // (filter by cell count, category-cell-sample.js), in
 *                                  // category order
 *      missingHidden?: true,       // the cells without a category (the legend's Missing row)
 *      outlier?: number,           // outlier threshold below 1 (a categorical's latent outliers)
 *      outlierOff?: true,          // the outlier filter is switched off
 *      range?: {min, max}}         // a continuous field's range, when narrower than its data
 *
 * A key is present only when it differs from the field's opening state, so
 * opening a field (which fills in its defaults, `ensure*Metadata`) changes
 * nothing here, and a dataset with thousands of genes holds an empty list.
 * Colors are the `colors` domain's: a field's color range is measured
 * against its data, never against its filter, so narrowing a filter is one
 * domain's change.
 *
 * Restore changes only the fields whose entry differs, in each view whose
 * filters differ, through the methods the legend and the Active filters list
 * use (`setCategoryStates`, `setMissingCategoryVisibility`,
 * `setCategoryCellLimit`), in one batch per view; a field it names is loaded
 * first, as opening it would.
 *
 * @module app/state/domains/filters
 */

import { compareRefs, fieldName, fieldRef, categoryPlaces, loadFields, requireCategoriesOf, requireField, refId, whenGenesListed } from './fields.js';
import { differingViews, inEachView, requireViewsFit, viewIdsOf, viewOwner, viewReadPart } from './view-list.js';
import { viewNameInValue } from '../../actions/targets/views.js';
import { pendingCategoryState, holdPendingCategoryState } from '../managers/field/pending-categories.js';
import { categoryCellLimitAt, categoryCellLimitsOf } from '../managers/category-cell-sample.js';
import { formatBound, formatCountOf, formatPercent } from '../../../utils/format-units.js';
import { MISSING_LABEL } from '../managers/filter-manager.js';
import { categoryDisplayName } from '../../actions/targets/names.js';

/** A continuous range equal to its data's within this is the data's. */
const RANGE_EPSILON = 1e-6;
/** An outlier threshold at or above this filters nothing (`filter-manager.js` `hasOutlierFilter`). */
const NO_OUTLIER_THRESHOLD = 0.9999;

function differsFromStats(range, stats) {
  return Math.abs(range.min - stats.min) > RANGE_EPSILON || Math.abs(range.max - stats.max) > RANGE_EPSILON;
}

/**
 * One field's filter, or null when it is the field's opening state.
 *
 * @param {object} field
 * @param {'obs'|'var'} source
 */
export function captureFieldFilter(field, source) {
  const entry = {};
  if (field.kind === 'category') {
    if (field._categoryFilterEnabled === false) entry.off = true;
    const hidden = [];
    const visible = field._categoryVisible;
    if (visible instanceof Uint8Array && Array.isArray(field.categories)) {
      const count = Math.min(visible.length, field.categories.length);
      for (let i = 0; i < count; i++) if (visible[i] === 0) hidden.push(field.categories[i]);
    }
    for (const { categoryName, visible: shown } of pendingCategoryState(field).visibility) {
      if (shown === false) hidden.push(categoryName);
    }
    if (hidden.length > 0) entry.hidden = hidden;
    const limits = categoryCellLimitsOf(field);
    if (limits.length > 0 && Array.isArray(field.categories)) {
      entry.limits = limits.map(({ category, count, seed }) => ({ category: field.categories[category], count, seed }));
    }
    if (field._missingVisible === false) entry.missingHidden = true;
    const threshold = field._outlierThreshold;
    if (typeof threshold === 'number' && threshold < NO_OUTLIER_THRESHOLD) entry.outlier = threshold;
    if (field._outlierFilterEnabled === false) entry.outlierOff = true;
  } else if (field.kind === 'continuous') {
    if (field._filterEnabled === false) entry.off = true;
    const range = field._continuousFilter;
    const stats = field._continuousStats;
    if (range !== undefined && range !== null && stats !== undefined && differsFromStats(range, stats)) {
      entry.range = { min: range.min, max: range.max };
    }
  }
  return Object.keys(entry).length === 0 ? null : { field: fieldRef(field, source), ...entry };
}

const FILTER_PROPERTIES = [
  '_categoryFilterEnabled', '_categoryVisible', '_categoryCellLimits', '_missingVisible', '_outlierThreshold',
  '_outlierFilterEnabled', '_filterEnabled', '_continuousFilter',
];

function mayHoldFilter(field) {
  for (const property of FILTER_PROPERTIES) if (field[property] !== undefined) return true;
  return field.kind === 'category' && pendingCategoryState(field).visibility.length > 0;
}

/** One view's filters (`ViewFilters`). */
export function captureViewFilters(owner) {
  const entries = [];
  for (const [data, source] of [[owner.obsData, 'obs'], [owner.varData, 'var']]) {
    for (const field of data?.fields ?? []) {
      if (field === null || typeof field !== 'object' || !mayHoldFilter(field)) continue;
      const entry = captureFieldFilter(field, source);
      if (entry !== null) entries.push(entry);
    }
  }
  return entries.sort((a, b) => compareRefs(a.field, b.field));
}

/**
 * Put one field of the focused view to `entry` (null: its opening state);
 * `place` is a categorical field's `categoryPlaces`. The caller runs this
 * inside a batch and recomputes visibility after.
 */
function applyFieldFilter(state, field, entry, place) {
  if (field.kind === 'category') {
    state.ensureCategoryMetadata(field);
    const hidden = new Set(entry?.hidden ?? []);
    const visibility = [];
    for (const [label, i] of place) {
      const visible = !hidden.has(label);
      if ((field._categoryVisible[i] === 1) !== visible) visibility.push({ index: i, visible });
    }
    if (visibility.length > 0) state.setCategoryStates(field, { visibility, colors: [] });
    // Categories that keep only some of their cells, by label (checked: `requireCategoriesOf`).
    const wantedLimits = new Map((entry?.limits ?? []).map(limit => [place.get(limit.category), limit]));
    for (const i of place.values()) {
      const now = categoryCellLimitAt(field, i);
      const wanted = wantedLimits.get(i) ?? null;
      if (now === null && wanted === null) continue;
      if (now !== null && wanted !== null && now.count === wanted.count && now.seed === wanted.seed) continue;
      state.setCategoryCellLimit(field, i, wanted === null ? null : { count: wanted.count, seed: wanted.seed });
    }
    // Labels its open cells do not hold yet (a discovered column, checked
    // before: `requireCategoriesOf`) stay held, by label; the colors held
    // for them are the colors domain's and are kept.
    const pending = pendingCategoryState(field);
    holdPendingCategoryState(field, {
      visibility: (entry?.hidden ?? []).filter(label => !place.has(label)).map(categoryName => ({ categoryName, visible: false })),
      colors: pending.colors,
    });
    const missingVisible = entry?.missingHidden !== true;
    if ((field._missingVisible !== false) !== missingVisible) state.setMissingCategoryVisibility(field, missingVisible);
    field._categoryFilterEnabled = entry?.off !== true;
    if (entry?.outlierOff === true) field._outlierFilterEnabled = false;
    else delete field._outlierFilterEnabled;
    if (entry?.outlier !== undefined) field._outlierThreshold = entry.outlier;
    else delete field._outlierThreshold;
    return;
  }
  const { stats } = state.ensureContinuousMetadata(field);
  const range = entry?.range ?? stats;
  field._continuousFilter = { min: range.min, max: range.max };
  field._filterEnabled = entry?.off !== true;
}

/**
 * Put the focused view's filters to `target`, changing only what differs.
 *
 * @param {object} state
 * @param {Array} target - `ViewFilters`
 */
async function restoreFocusedFilters(state, target, signal) {
  const current = new Map(captureViewFilters(state).map(entry => [refId(entry.field), entry]));
  const wanted = new Map(target.map(entry => [refId(entry.field), entry]));
  const changed = [...new Set([...current.keys(), ...wanted.keys()])]
    .filter(id => JSON.stringify(current.get(id) ?? null) !== JSON.stringify(wanted.get(id) ?? null));
  if (changed.length === 0) return;
  const refs = changed.map(id => (wanted.get(id) ?? current.get(id)).field);
  if (refs.some(ref => ref.source === 'var')) await whenGenesListed(state, signal);
  const cache = {};
  const found = refs.map(ref => requireField(state, ref, cache, 'a filter'));
  // Every field a filter changes is read first, as opening it reads it.
  await loadFields(state, refs, found, signal);
  const lookups = {};
  const fields = refs.map(ref => requireField(state, ref, lookups, 'a filter').field);
  const places = fields.map(field => (field.kind === 'category' ? categoryPlaces(field) : null));
  fields.forEach((field, i) => {
    if (places[i] === null) return;
    const entry = wanted.get(changed[i]);
    requireCategoriesOf(field, places[i], entry?.hidden ?? [], 'A filter');
    // A category limit applies only to a category the field has, discovered or not.
    requireCategoriesOf({ ...field, discovered: false }, places[i], (entry?.limits ?? []).map(limit => limit.category), 'A filter');
  });
  state.beginBatch();
  try {
    fields.forEach((field, i) => applyFieldFilter(state, field, wanted.get(changed[i]) ?? null, places[i]));
  } finally {
    state.endBatch();
  }
  state.computeGlobalVisibility();
  // A threshold below 1 filters once the field's outlier quantiles are got
  // (read from the file or computed), as moving the slider gets them.
  for (let i = 0; i < refs.length; i++) {
    const entry = wanted.get(changed[i]);
    if (refs[i].source !== 'obs' || entry?.outlier === undefined || fields[i].outlierQuantiles instanceof Float32Array) continue;
    const index = requireField(state, refs[i], {}, 'a filter').index;
    try {
      const quantiles = await state.ensureOutlierQuantiles(index);
      if (quantiles !== null) state.computeGlobalVisibility();
    } catch {
      // Canceled or failed: the field's outlier status says why; the
      // threshold stays as the history holds it.
    }
  }
  state.updateFilterSummary();
  state._syncActiveContext();
}

function describeEntry(label, before, after) {
  const lines = [];
  const a = before ?? {};
  const b = after ?? {};
  const hiddenA = new Set(a.hidden ?? []);
  const hiddenB = new Set(b.hidden ?? []);
  const nowHidden = [...hiddenB].filter(x => !hiddenA.has(x));
  const nowShown = [...hiddenA].filter(x => !hiddenB.has(x));
  if (nowHidden.length > 0) lines.push(`${label}: hid ${listOf(nowHidden)}`);
  if (nowShown.length > 0) lines.push(`${label}: showed ${listOf(nowShown)}`);
  if ((a.missingHidden === true) !== (b.missingHidden === true)) lines.push(`${label}: ${b.missingHidden ? 'hid' : 'showed'} cells without a category`);
  const limitsA = new Map((a.limits ?? []).map(limit => [limit.category, limit]));
  for (const limit of b.limits ?? []) {
    const was = limitsA.get(limit.category);
    if (was === undefined || was.count !== limit.count || was.seed !== limit.seed) {
      lines.push(`${label}: ${formatCountOf(limit.count, 'cell')} of ${limit.category === null ? MISSING_LABEL : categoryDisplayName(limit.category)} kept`);
    }
  }
  for (const limit of a.limits ?? []) {
    if (!(b.limits ?? []).some(other => other.category === limit.category)) {
      lines.push(`${label}: every cell of ${limit.category === null ? MISSING_LABEL : categoryDisplayName(limit.category)} shown`);
    }
  }
  if (JSON.stringify(a.range ?? null) !== JSON.stringify(b.range ?? null)) {
    lines.push(b.range ? `${label}: range ${formatBound(b.range.min)} to ${formatBound(b.range.max)}` : `${label}: whole range`);
  }
  if ((a.outlier ?? 1) !== (b.outlier ?? 1)) lines.push(`${label}: outlier threshold ${formatPercent((b.outlier ?? 1) * 100)}`);
  if ((a.off === true) !== (b.off === true)) lines.push(`${label}: filter ${b.off ? 'off' : 'on'}`);
  if ((a.outlierOff === true) !== (b.outlierOff === true)) lines.push(`${label}: outlier filter ${b.outlierOff ? 'off' : 'on'}`);
  return lines;
}

function listOf(labels) {
  const shown = labels.slice(0, 3).map(label => (label === null ? MISSING_LABEL : categoryDisplayName(label)));
  return labels.length > 3 ? `${shown.join(', ')} and ${labels.length - 3} more` : shown.join(', ');
}

/**
 * Per-view lines for two per-view values whose entries are keyed by field.
 *
 * @param {object|null} state
 * @param {{views: Array<Array<{field: object}>>}} a
 * @param {{views: Array<Array<{field: object}>>}} b
 * @param {(label: string, before: object|null, after: object|null) => string[]} describe
 * @param {boolean} liveHidden - The live view is hidden at `b` (views are named as the list numbers them)
 * @param {Array<string|null>|null} [viewLabels] - The views' names at `b` (`viewLabelsInValue`)
 */
export function describePerViewFields(state, a, b, describe, liveHidden, viewLabels = null) {
  const lines = [];
  const count = Math.max(a.views.length, b.views.length);
  for (let v = 0; v < count; v++) {
    const before = new Map((a.views[v] ?? []).map(entry => [refId(entry.field), entry]));
    const after = new Map((b.views[v] ?? []).map(entry => [refId(entry.field), entry]));
    const prefix = count > 1 ? `${viewNameInValue(v, liveHidden, viewLabels)}, ` : '';
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const x = before.get(id) ?? null;
      const y = after.get(id) ?? null;
      if (JSON.stringify(x) === JSON.stringify(y)) continue;
      lines.push(...describe(`${prefix}${fieldName(state, (y ?? x).field)}`, x, y));
    }
  }
  return lines;
}

/**
 * @param {{state: object, viewer: object, refreshUi: () => void}} options
 */
export function createFiltersDomain({ state, viewer, refreshUi }) {
  return {
    // A step read the view it acted in: staleness compares that view's part alone (F156).
    readPart: viewReadPart,
    capture() {
      const views = viewIdsOf(viewer).map(id => captureViewFilters(viewOwner(state, id)));
      return { views };
    },
    async restore(value, { signal = null } = {}) {
      const ids = viewIdsOf(viewer);
      requireViewsFit(value, ids, 'filters');
      const current = ids.map(id => captureViewFilters(viewOwner(state, id)));
      const indices = differingViews(current, value.views);
      await inEachView(state, ids, indices, (_viewId, index) => restoreFocusedFilters(state, value.views[index], signal));
      if (indices.length > 0) refreshUi();
    },
    /** `context.liveHidden`: the live view is hidden at the later value (`views` domain), so the list numbers the kept views from 1; `context.viewLabels`: the views' names there (`viewLabelsInValue`). */
    describe(a, b, { liveHidden = false, viewLabels = null } = {}) {
      return describePerViewFields(state, a, b, describeEntry, liveHidden, viewLabels);
    },
  };
}

