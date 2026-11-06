/**
 * @fileoverview The `colors` state domain: how each view colours each field.
 *
 * Value: `{views: [ViewColors, …]}` (live first, then kept views:
 * `view-list.js`), each `ViewColors` a list of the fields whose colours
 * differ from the field's opening state, in reference order:
 *
 *     {field: {source, key}|{source, user},   // fields.js
 *      colors?: [{category: label, color: '#rrggbb'}, …],
 *                              // categories recoloured (the bytes drawn), in category
 *                              // order, then labels held for cells not open yet
 *      colormap?: id,          // a colour map other than the field's default
 *      range?: {min, max},     // a continuous colour range other than the data's
 *      log?: true,             // log colour scale
 *      rescale?: false,        // the colour scale spans the data, not the colour range
 *      zeroGray?: true}        // zeros drawn grey
 *
 * A category's colour is recorded only when it differs from the colour its
 * position opens with (the file's palette, else Cellucid's), by label. A
 * colour range is measured against the field's data, never its filter, so a
 * filter change is the `filters` domain's alone.
 *
 * Restore changes only the fields whose entry differs, in each view whose
 * colours differ, through the methods the legend uses (`setCategoryStates`),
 * and draws the field a view is coloured by again.
 *
 * @module app/state/domains/colors
 */

import { compareRefs, fieldRef, categoryPlaces, loadFields, requireCategoriesOf, requireField, refId, whenGenesListed } from './fields.js';
import { differingViews, inEachView, requireViewsFit, viewIdsOf, viewOwner } from './view-list.js';
import { describePerViewFields } from './filters.js';
import { pendingCategoryState, holdPendingCategoryState } from '../managers/field/pending-categories.js';
import { defaultCategoryColors } from '../../utils/category-state.js';
import { DEFAULT_COLORMAP_ID } from '../../../data/palettes.js';

const RANGE_EPSILON = 1e-6;

function hexOfBytes(r, g, b) {
  return `#${[r, g, b].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function hexOfChannels(rgb) {
  return hexOfBytes(...rgb.map(channel => Math.round(channel * 255)));
}

function channelsOfHex(hex) {
  return [1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
}

/**
 * The default colour bytes of a field's categories (a function of position
 * and the file's palette), made once per category list and count.
 */
const DEFAULTS = new WeakMap();
function defaultsOf(field) {
  let entry = DEFAULTS.get(field.categories);
  if (entry === undefined || entry.palette !== (field.palette ?? null) || entry.count !== field.categories.length) {
    entry = { palette: field.palette ?? null, count: field.categories.length, colors: defaultCategoryColors(field) };
    DEFAULTS.set(field.categories, entry);
  }
  return entry.colors;
}

/**
 * One field's colours, or null when they are the field's opening colours.
 *
 * @param {object} field
 * @param {'obs'|'var'} source
 */
export function captureFieldColors(field, source) {
  const entry = {};
  if (field.kind === 'category') {
    const colors = [];
    const own = field._categoryColors;
    if (own instanceof Uint8Array && Array.isArray(field.categories) && own.length === field.categories.length * 3) {
      const defaults = defaultsOf(field);
      for (let i = 0; i < field.categories.length; i++) {
        const at = i * 3;
        if (own[at] !== defaults[at] || own[at + 1] !== defaults[at + 1] || own[at + 2] !== defaults[at + 2]) {
          colors.push({ category: field.categories[i], color: hexOfBytes(own[at], own[at + 1], own[at + 2]) });
        }
      }
    }
    for (const { categoryName, color } of pendingCategoryState(field).colors) {
      colors.push({ category: categoryName, color: hexOfChannels(color) });
    }
    if (colors.length > 0) entry.colors = colors;
    if (typeof field._colormapId === 'string') entry.colormap = field._colormapId;
  } else if (field.kind === 'continuous') {
    const range = field._continuousColorRange;
    const stats = field._continuousStats;
    if (range != null && stats !== undefined
      && (Math.abs(range.min - stats.min) > RANGE_EPSILON || Math.abs(range.max - stats.max) > RANGE_EPSILON)) {
      entry.range = { min: range.min, max: range.max };
    }
    if (field._useLogScale === true) entry.log = true;
    if (field._useFilterColorRange === false) entry.rescale = false;
    if (field._zeroGray === true) entry.zeroGray = true;
    if (typeof field._colormapId === 'string' && field._colormapId !== DEFAULT_COLORMAP_ID) entry.colormap = field._colormapId;
  }
  return Object.keys(entry).length === 0 ? null : { field: fieldRef(field, source), ...entry };
}

const COLOR_PROPERTIES = ['_categoryColors', '_colormapId', '_continuousColorRange', '_useLogScale', '_useFilterColorRange', '_zeroGray'];

function mayHoldColors(field) {
  for (const property of COLOR_PROPERTIES) if (field[property] !== undefined) return true;
  return field.kind === 'category' && pendingCategoryState(field).colors.length > 0;
}

/** One view's colours (`ViewColors`). */
export function captureViewColors(owner) {
  const entries = [];
  for (const [data, source] of [[owner.obsData, 'obs'], [owner.varData, 'var']]) {
    for (const field of data?.fields ?? []) {
      if (field === null || typeof field !== 'object' || !mayHoldColors(field)) continue;
      const entry = captureFieldColors(field, source);
      if (entry !== null) entries.push(entry);
    }
  }
  return entries.sort((a, b) => compareRefs(a.field, b.field));
}

/** Put one field of the focused view to `entry` (null: its opening colours), inside a batch. */
function applyFieldColors(state, field, entry, place) {
  if (field.kind === 'category') {
    state.ensureCategoryMetadata(field);
    const wanted = defaultsOf(field).slice();
    const held = [];
    for (const { category, color } of entry?.colors ?? []) {
      const index = place.get(category);
      if (index === undefined) {
        held.push({ categoryName: category, color: channelsOfHex(color) });
        continue;
      }
      const at = index * 3;
      wanted[at] = Number.parseInt(color.slice(1, 3), 16);
      wanted[at + 1] = Number.parseInt(color.slice(3, 5), 16);
      wanted[at + 2] = Number.parseInt(color.slice(5, 7), 16);
    }
    const own = field._categoryColors;
    const colors = [];
    for (let i = 0; i < field.categories.length; i++) {
      const at = i * 3;
      if (own[at] !== wanted[at] || own[at + 1] !== wanted[at + 1] || own[at + 2] !== wanted[at + 2]) {
        colors.push({ index: i, rgb: [wanted[at] / 255, wanted[at + 1] / 255, wanted[at + 2] / 255] });
      }
    }
    if (colors.length > 0) state.setCategoryStates(field, { visibility: [], colors });
    holdPendingCategoryState(field, { visibility: pendingCategoryState(field).visibility, colors: held });
    if (entry?.colormap !== undefined) field._colormapId = entry.colormap;
    else delete field._colormapId;
    return;
  }
  const { stats } = state.ensureContinuousMetadata(field);
  const range = entry?.range ?? stats;
  field._continuousColorRange = { min: range.min, max: range.max };
  field._useLogScale = entry?.log === true;
  field._useFilterColorRange = entry?.rescale !== false;
  field._zeroGray = entry?.zeroGray === true;
  field._colormapId = entry?.colormap ?? DEFAULT_COLORMAP_ID;
}

async function restoreFocusedColors(state, target, signal) {
  const current = new Map(captureViewColors(state).map(entry => [refId(entry.field), entry]));
  const wanted = new Map(target.map(entry => [refId(entry.field), entry]));
  const changed = [...new Set([...current.keys(), ...wanted.keys()])]
    .filter(id => JSON.stringify(current.get(id) ?? null) !== JSON.stringify(wanted.get(id) ?? null));
  if (changed.length === 0) return;
  const refs = changed.map(id => (wanted.get(id) ?? current.get(id)).field);
  if (refs.some(ref => ref.source === 'var')) await whenGenesListed(state, signal);
  const found = refs.map(ref => requireField(state, ref, {}, 'the colours'));
  await loadFields(state, refs, found, signal);
  const lookups = {};
  const fields = refs.map(ref => requireField(state, ref, lookups, 'the colours').field);
  const places = fields.map(field => (field.kind === 'category' ? categoryPlaces(field) : null));
  fields.forEach((field, i) => {
    if (places[i] === null) return;
    requireCategoriesOf(field, places[i], (wanted.get(changed[i])?.colors ?? []).map(({ category }) => category), 'A colour');
  });
  state.beginBatch();
  try {
    fields.forEach((field, i) => applyFieldColors(state, field, wanted.get(changed[i]) ?? null, places[i]));
  } finally {
    state.endBatch();
  }
  // The field the view is coloured by is drawn in its colours again
  // (categories are drawn by the batch's end, `endBatch`).
  const active = state.getActiveField();
  if (active !== null && fields.includes(active) && active.kind === 'continuous' && active.loaded === true) {
    state.updateColorsContinuous(active);
    state._pushColorsToViewer();
  }
  state._syncActiveContext();
}

function describeEntry(label, before, after) {
  const lines = [];
  const a = before ?? {};
  const b = after ?? {};
  const colorsA = new Map((a.colors ?? []).map(({ category, color }) => [category, color]));
  const recoloured = (b.colors ?? []).filter(({ category, color }) => colorsA.get(category) !== color).map(({ category }) => String(category));
  const reset = [...colorsA.keys()].filter(category => !(b.colors ?? []).some(entry => entry.category === category)).map(String);
  if (recoloured.length > 0) lines.push(`${label}: recoloured ${recoloured.slice(0, 3).join(', ')}${recoloured.length > 3 ? ` and ${recoloured.length - 3} more` : ''}`);
  if (reset.length > 0) lines.push(`${label}: default colour for ${reset.slice(0, 3).join(', ')}${reset.length > 3 ? ` and ${reset.length - 3} more` : ''}`);
  if ((a.colormap ?? null) !== (b.colormap ?? null)) lines.push(`${label}: colour map ${b.colormap ?? 'default'}`);
  if (JSON.stringify(a.range ?? null) !== JSON.stringify(b.range ?? null)) {
    lines.push(b.range ? `${label}: colour range ${b.range.min} to ${b.range.max}` : `${label}: colour range of the data`);
  }
  if ((a.log === true) !== (b.log === true)) lines.push(`${label}: ${b.log ? 'log' : 'linear'} colour scale`);
  if ((a.rescale !== false) !== (b.rescale !== false)) lines.push(`${label}: colours ${b.rescale === false ? 'span the data' : 'span the range'}`);
  if ((a.zeroGray === true) !== (b.zeroGray === true)) lines.push(`${label}: zeros ${b.zeroGray ? 'grey' : 'coloured'}`);
  return lines;
}

/**
 * @param {{state: object, viewer: object, refreshUi: () => void}} options
 */
export function createColorsDomain({ state, viewer, refreshUi }) {
  return {
    capture() {
      return { views: viewIdsOf(viewer).map(id => captureViewColors(viewOwner(state, id))) };
    },
    async restore(value, { signal = null } = {}) {
      const ids = viewIdsOf(viewer);
      requireViewsFit(value, ids, 'colours');
      const current = ids.map(id => captureViewColors(viewOwner(state, id)));
      const indices = differingViews(current, value.views);
      await inEachView(state, ids, indices, (_viewId, index) => restoreFocusedColors(state, value.views[index], signal));
      if (indices.length > 0) refreshUi();
    },
    /** `context.liveHidden`: the live view is hidden at the later value (`views` domain), so the list numbers the kept views from 1. */
    describe(a, b, { liveHidden = false } = {}) {
      return describePerViewFields(state, a, b, describeEntry, liveHidden);
    },
  };
}
