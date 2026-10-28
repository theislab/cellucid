/**
 * @fileoverview The open cells grown or cut in place: a dataset whose cells
 * are its earlier cells and more (a larger subsample of the same method and
 * seed, a progressive opening's next step), or its earlier first cells only
 * (a smaller one), shown without reading it again
 * (`app/open-cells-resize.js` reads the added cells' rows and calls
 * `resizeOpenCells` once they are all in hand).
 *
 * Open cells `[0, shared)` are the same cells before and after, so every
 * per-cell array of the state keeps those rows as they are and either takes
 * the added rows after them or is cut to the first `shared`. What each one
 * becomes:
 *
 * | per-cell state | grown | cut |
 * | --- | --- | --- |
 * | positions (the dimension manager's, `resizeCells`) | the added rows read | first rows |
 * | a loaded obs or gene field's values / codes | the added rows read | first rows |
 * | a loaded field whose added rows were not read | released (read again when used) | first rows |
 * | a text or boolean column whose added rows hold a value it had not | released, its categories found again from every cell | first rows |
 * | outlier quantiles (measured over every cell of a category) | dropped; a filter in use gets them again (`resumeOutlierFilters`) | dropped, likewise |
 * | continuous statistics, a filter or colour range | measured again; a range at a bound follows it, a range inside it stays, a range outside it is reset (said) | likewise |
 * | category counts, centroids | counted again | counted again |
 * | a user-defined category made from a file's column (a copy, an edit, a consensus) | added cells labelled as its other cells of the same source category (`derivedCodes`) | first rows |
 * | any other user-defined category's codes (labels set by hand) | added cells missing | first rows |
 * | a user-defined value field's values | added cells NaN | first rows |
 * | a user-defined copy of a value field | the source's arrays | the source's arrays |
 * | the cell visibility mask (cells hidden by hand) | added cells shown | first rows |
 * | a category or range highlight group | takes the added cells in its category or range that are visible (`takeInNewlyOpenCells`) | cells past the end leave; a group left empty goes (said) |
 * | any other highlight group (made by hand) | unchanged (it names its cells) | likewise |
 * | an analysis's scores (`registries/derived-results.js`) | unchanged (they name their cells) | cells past the end leave |
 * | colours, visibility, highlight array | made again from the field shown and the filters | likewise |
 * | identity, priority | the new opening's | the new opening's |
 *
 * Growing equals opening the larger share for everything derived from the
 * file; what was made by hand stays as it was. A dataset read again with
 * other cells (`app/cell-subset-carry.js`) gives its newly open cells the
 * same treatment (`takeInNewlyOpenCells`).
 *
 * Kept views are not resized: their caller retires them first and makes them
 * again from their record (`app/open-cells-resize.js`). No field load is
 * under way (the caller waited for them, `data/open-cells-work.js`); the
 * dataset generation still moves, for anything that captured it.
 *
 * @module state/managers/open-cells
 */

import { createNeutralColors, createShownCellVisibilityMask, recordAlphaBytesMirror } from './per-cell-array-ownership.js';
import { recordUnfilteredVisibility } from './filter-manager.js';
import { categoricalStorageForCodes } from '../../../data/categorical-storage-contract.js';
import { requireCellPriority } from '../../../data/cell-priority.js';
import { getFieldRegistry } from '../../utils/field-registry.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { POINT_VISIBILITY_THRESHOLD } from '../../../rendering/alpha-visibility.js';

const FIELD_ARRAY_KEYS = Object.freeze(['values', 'codes', 'outlierQuantiles']);

/** The cache key a field's arrays are kept under (`field/loading.js`). */
function cacheKeyOf(field, index) {
  return field._originalKey || field.key || String(index);
}

/**
 * `array` (`width` values a cell, `from` cells) as `to` cells: its first
 * `min(from, to)` cells, then `added` (the cells after `from`), or `fill`
 * when nothing was read for them. A new array the caller owns.
 *
 * @template {ArrayLike<number> & {constructor: any}} T
 * @param {T} array
 * @param {number} from
 * @param {number} to
 * @param {{added?: ArrayLike<number>|null, fill?: number, width?: number}} [options]
 * @returns {T}
 */
export function resizedCellArray(array, from, to, { added = null, fill = 0, width = 1 } = {}) {
  if (!ArrayBuffer.isView(array) || array.length !== from * width) {
    throw new RangeError(`A per-cell array of ${formatCountOf(from, 'cell')} holds ${formatCountOf(from * width, 'value')}, not ${array?.length}.`);
  }
  const out = new array.constructor(to * width);
  const shared = Math.min(from, to);
  out.set(array.subarray(0, shared * width));
  if (to > from) {
    if (added !== null) {
      if (added.length !== (to - from) * width) {
        throw new RangeError(`The cells added hold ${formatCountOf(added.length, 'value')}, not ${(to - from) * width}.`);
      }
      out.set(added, from * width);
    } else if (fill !== 0) {
      out.fill(fill, from * width);
    }
  }
  return out;
}

/**
 * `array` (`width` values a cell) with its cells in another order: cell `j`
 * of the result is cell `order[j]` of `array`. A new array the caller owns.
 */
export function movedCellArray(array, order, width = 1) {
  if (!ArrayBuffer.isView(array) || array.length !== order.length * width) {
    throw new RangeError(`A per-cell array of ${formatCountOf(order.length, 'cell')} holds ${formatCountOf(order.length * width, 'value')}, not ${array?.length}.`);
  }
  const out = new array.constructor(array.length);
  for (let j = 0; j < order.length; j++) {
    const from = order[j] * width;
    for (let w = 0; w < width; w++) out[j * width + w] = array[from + w];
  }
  return out;
}

/** A cell list moved to the cells' new positions (`positionOf`), ascending. */
function movedCells(cells, positionOf) {
  const out = new Uint32Array(cells.length);
  for (let i = 0; i < cells.length; i++) out[i] = positionOf[cells[i]];
  return out.sort();
}

/** A cell list (`Uint32Array`) of the cells below `n`, in its order; the list itself when all are. */
function cellsBelow(cells, n) {
  let kept = 0;
  for (let i = 0; i < cells.length; i++) if (cells[i] < n) kept++;
  if (kept === cells.length) return cells;
  const out = new Uint32Array(kept);
  let at = 0;
  for (let i = 0; i < cells.length; i++) if (cells[i] < n) out[at++] = cells[i];
  return out;
}

/** Positions `[from, to)`. */
function cellRange(from, to) {
  const cells = new Uint32Array(to - from);
  for (let i = 0; i < cells.length; i++) cells[i] = from + i;
  return cells;
}

/** Two ascending cell lists with no cell in common, as one. */
function mergedCells(a, b) {
  if (b.length === 0) return a;
  if (a.length === 0 || a[a.length - 1] < b[0]) {
    const out = new Uint32Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
  }
  const out = new Uint32Array(a.length + b.length);
  let i = 0;
  let j = 0;
  let at = 0;
  while (i < a.length && j < b.length) out[at++] = a[i] < b[j] ? a[i++] : b[j++];
  while (i < a.length) out[at++] = a[i++];
  while (j < b.length) out[at++] = b[j++];
  return out;
}

/**
 * The codes of a user-defined category made from a file's column (`field`,
 * its `_sourceField` naming `source`) with `cells` (ascending positions)
 * labelled as the field labels its other cells of the same source category:
 * every copy, edit (a category deleted, two merged, renamed) and consensus
 * is a category-for-category function of its source, read off the cells it
 * labels. A source category none of those holds takes the field's category
 * of the same name, if it has one, else stays missing. A cell already
 * labelled keeps its label. Null when the field is not a function of its
 * source (labels set by hand on some cells) or nothing changes.
 *
 * @param {{key: string, categories: string[], codes: ArrayBufferView}} field
 * @param {{categories: string[], codes: ArrayBufferView}} source
 * @param {Uint32Array} cells
 * @returns {ArrayBufferView|null}
 */
export function derivedCodes(field, source, cells) {
  const n = field.codes.length;
  if (source.codes.length !== n || !Array.isArray(source.categories) || cells.length === 0) return null;
  const { missingValue: fieldMissing } = categoricalStorageForCodes(field.codes, `User-defined field "${field.key}"`);
  const { missingValue: sourceMissing } = categoricalStorageForCodes(source.codes, `Field "${field.key}"'s source`);
  const k = source.categories.length;
  const slotOf = code => (code === sourceMissing ? k : code);
  // Each source category's label in the field, read off its other cells.
  const map = new Int32Array(k + 1).fill(-1);
  let next = 0;
  for (let i = 0; i < n; i++) {
    if (next < cells.length && cells[next] === i) {
      next++;
      continue;
    }
    const slot = slotOf(source.codes[i]);
    if (slot > k) return null;
    const label = field.codes[i];
    if (map[slot] === -1) map[slot] = label;
    else if (map[slot] !== label) return null;
  }
  for (let slot = 0; slot <= k; slot++) {
    if (map[slot] !== -1) continue;
    const named = slot < k ? field.categories.indexOf(source.categories[slot]) : -1;
    map[slot] = named >= 0 ? named : fieldMissing;
  }
  let out = null;
  for (let c = 0; c < cells.length; c++) {
    const i = cells[c];
    if (field.codes[i] !== fieldMissing) continue;
    const slot = slotOf(source.codes[i]);
    if (slot > k) return null;
    const label = map[slot];
    if (label === fieldMissing) continue;
    out ??= field.codes.slice();
    out[i] = label;
  }
  return out;
}

/**
 * A continuous range kept across new statistics: a bound at the old
 * statistics' bound follows the new one, a bound inside stays, clamped to
 * the new statistics; null when nothing of it is within them.
 */
function carriedRange(range, oldStats, newStats) {
  if (range === undefined || range === null || oldStats === undefined || oldStats === null) return undefined;
  const min = range.min === oldStats.min ? newStats.min : Math.max(range.min, newStats.min);
  const max = range.max === oldStats.max ? newStats.max : Math.min(range.max, newStats.max);
  return min <= max ? { min, max } : null;
}

export class DataStateOpenCellsMethods {
  /**
   * Grow or cut the open cells in place (module doc). Synchronous: every
   * added row is read before it is called, and it publishes the new cells to
   * the viewer at once.
   *
   * @param {{
   *   n: number,
   *   identity: import('../../../data/cell-identity.js').CellIdentity,
   *   priority: {seed: number|null, originals: Uint32Array|null},
   *   positions: Float32Array,
   *   obs?: Map<string, {values?: Float32Array, codes?: ArrayBufferView}>,
   *   var?: Map<string, {values: Float32Array}>,
   *   changed?: Set<string>,
   * }} change
   *   `positions`: the shown layout's positions for the `n` cells (the
   *   dimension manager's, resized first); `obs` / `var`: the added rows of
   *   loaded fields by cache key (growing only); `changed`: text or boolean
   *   columns whose added rows hold a value outside their categories.
   * @returns {{from: number, to: number, released: string[], recoded: string[], droppedGroups: string[], resetRanges: string[], resumeActive: {source: 'obs'|'var', index: number}|null}}
   *   What could not stay as it was, for the caller to say (`recoded`: the
   *   fields whose added cells hold categories they had not shown, released
   *   to be read again with every category); `resumeActive`: the field
   *   shown, released, to load again and show.
   */
  resizeOpenCells(change) {
    const { n, identity, priority, positions } = change;
    const added = { obs: change.obs ?? new Map(), var: change.var ?? new Map() };
    const changed = change.changed ?? new Set();
    const from = this.pointCount;
    if (!Number.isSafeInteger(n) || n < 1 || n === from) {
      throw new RangeError(`Open cells are resized to another positive count than ${from}, not ${n}.`);
    }
    if (this.activeViewId !== 'live' || this.viewContexts.size !== 1) {
      throw new Error('Open cells are resized with the live view alone: kept views are retired first and made again after.');
    }
    if (identity?.n !== n) throw new TypeError(`A cell identity of the ${formatCountOf(n, 'open cell')} is required.`);
    const exactPriority = requireCellPriority(priority, n);
    if (!(positions instanceof Float32Array) || positions.length !== n * this.positionsDimension) {
      throw new TypeError(`The shown layout's positions hold ${formatCountOf(this.positionsDimension, 'value')} for each of the ${formatCountOf(n, 'open cell')}.`);
    }
    const grown = n > from;
    const outcome = { from, to: n, released: [], recoded: [], droppedGroups: [], resetRanges: [], resumeActive: null };

    // Loads under way read the earlier cells: they are superseded.
    this._datasetGeneration = (this._datasetGeneration ?? 0) + 1;
    this.retireOutlierJobs();
    this._filteredCountMemo = null;
    this._highlightMembershipScratch = null;

    // The new count first: every array below is made for it.
    this.pointCount = n;
    this.cellIdentity = identity;
    this.cellPriority = exactPriority;

    // Fields read from the file, in the state's inventories (the live view's).
    const active = { source: this.activeFieldSource, index: this.activeFieldSource === 'var' ? this.activeVarFieldIndex : this.activeFieldIndex };
    for (const [source, inventory, cache] of [['obs', this.obsData, this._fieldDataCache], ['var', this.varData, this._varFieldDataCache]]) {
      const fields = inventory?.fields ?? [];
      for (let index = 0; index < fields.length; index++) {
        const field = fields[index];
        if (field === null || typeof field !== 'object' || field._isUserDefined === true) continue;
        const key = cacheKeyOf(field, index);
        this._resizeFieldArrays(field, key, source, from, n, grown ? added[source].get(key) ?? null : null, changed.has(key), outcome);
        // The cache keeps every member it holds (the categories and palette
        // a text column's first load found, `field/loading.js`) with the
        // resized arrays.
        if (field.loaded === true) {
          const entry = { ...(cache.get(key) ?? {}) };
          for (const name of FIELD_ARRAY_KEYS) {
            if (ArrayBuffer.isView(field[name])) entry[name] = field[name];
            else delete entry[name];
          }
          cache.set(key, entry);
        } else {
          cache.delete(key);
        }
        if (field.loaded !== true && source === active.source && index === active.index) outcome.resumeActive = { source, index };
      }
    }

    // Positions before user-defined categories, whose centroids read them.
    this.positionsArray = positions;
    this._resizeUserDefinedFields(from, n, outcome);

    // Cells hidden by hand stay hidden; cells added are shown.
    this.cellVisibilityMask = resizedCellArray(this.cellVisibilityMask, from, n, { fill: 1 });
    // Colours and visibility are made again from the field shown and the
    // filters (`restoreActiveFieldColors` below).
    this.colorsArray = createNeutralColors(n);
    this.categoryTransparency = new Uint8Array(n).fill(1);
    if (this.cellVisibilityMask.every(value => value === 1)) {
      this.cellVisibilityMask = createShownCellVisibilityMask(n);
      recordUnfilteredVisibility(this.categoryTransparency, this.cellVisibilityMask);
    }
    recordAlphaBytesMirror(this.colorsArray, this.categoryTransparency);
    this.filteredCount = { shown: n, total: n };

    // Highlight groups and scores name their cells: those past the end leave.
    if (!grown) {
      this._derivedResults.keepCellsBelow(n);
      for (const page of this.highlightPages) {
        page.highlightedGroups = page.highlightedGroups.filter(group => {
          const cells = cellsBelow(group.cellIndices, n);
          if (cells.length === 0) {
            outcome.droppedGroups.push(group.label);
            return false;
          }
          group.cellIndices = cells;
          group.cellCount = cells.length;
          return true;
        });
      }
    }
    this.highlightArray = new Uint8Array(n);
    this._highlightedCellIndices = new Uint32Array(0);
    this._invalidateHighlightCountCache?.();
    this._cachedHighlightLodMembership = null;
    getFieldRegistry().invalidate();
    return outcome;
  }

  /**
   * The same open cells in another order (a subsample grown from few chunks
   * put in priority order, `app/open-cells-resize.js`): open cell `j` is
   * open cell `order[j]` before. Every per-cell array moves with its cells;
   * what was derived from every cell (statistics, counts, centroids) is made
   * again in the new order, as opening them in it makes it; highlight groups
   * and scores name the cells' new positions. Synchronous; the caller
   * publishes (`publishResizedCells`).
   *
   * @param {{identity: import('../../../data/cell-identity.js').CellIdentity,
   *   priority: {seed: number|null, originals: Uint32Array|null},
   *   positions: Float32Array, order: Uint32Array}} change - `positions`: the
   *   shown layout's, reordered first (`DimensionManager.reorderCells`)
   * @returns {{from: number, to: number, released: string[], recoded: string[], droppedGroups: string[], resetRanges: string[], resumeActive: null}}
   */
  reorderOpenCells({ identity, priority, positions, order }) {
    const n = this.pointCount;
    if (!(order instanceof Uint32Array) || order.length !== n) throw new TypeError(`An order of the ${formatCountOf(n, 'open cell')} names each once.`);
    if (this.activeViewId !== 'live' || this.viewContexts.size !== 1) {
      throw new Error('Open cells are reordered with the live view alone: kept views are retired first and made again after.');
    }
    if (identity?.n !== n) throw new TypeError(`A cell identity of the ${formatCountOf(n, 'open cell')} is required.`);
    const exactPriority = requireCellPriority(priority, n);
    if (!(positions instanceof Float32Array) || positions.length !== n * this.positionsDimension) {
      throw new TypeError(`The shown layout's positions hold ${formatCountOf(this.positionsDimension, 'value')} for each of the ${formatCountOf(n, 'open cell')}.`);
    }
    const positionOf = new Uint32Array(n);
    for (let j = 0; j < n; j++) positionOf[order[j]] = j;
    const outcome = { from: n, to: n, released: [], recoded: [], droppedGroups: [], resetRanges: [], resumeActive: null };

    this._datasetGeneration = (this._datasetGeneration ?? 0) + 1;
    this.retireOutlierJobs();
    this._filteredCountMemo = null;
    this._highlightMembershipScratch = null;
    this.cellIdentity = identity;
    this.cellPriority = exactPriority;

    for (const [inventory, cache] of [[this.obsData, this._fieldDataCache], [this.varData, this._varFieldDataCache]]) {
      const fields = inventory?.fields ?? [];
      for (let index = 0; index < fields.length; index++) {
        const field = fields[index];
        if (field === null || typeof field !== 'object' || field._isUserDefined === true) continue;
        const key = cacheKeyOf(field, index);
        if (field.centroidsByLayout instanceof Map) field.centroidsByLayout.clear();
        if (field._normalizedLayouts instanceof Set) field._normalizedLayouts.clear();
        delete field._categoryCounts;
        delete field.outlierQuantiles;
        field._loadingPromise = null;
        field._loadingSignal = null;
        if (field.loaded !== true) {
          cache.delete(key);
          continue;
        }
        if (ArrayBuffer.isView(field.codes)) field.codes = movedCellArray(field.codes, order);
        if (field.values instanceof Float32Array) {
          field.values = movedCellArray(field.values, order);
          this._carryContinuousRanges(field, n, outcome);
        }
        const entry = { ...(cache.get(key) ?? {}) };
        for (const name of FIELD_ARRAY_KEYS) {
          if (ArrayBuffer.isView(field[name])) entry[name] = field[name];
          else delete entry[name];
        }
        cache.set(key, entry);
      }
    }

    this.positionsArray = positions;
    const registry = this._userDefinedFields;
    for (const template of registry.getAllFields()) {
      if (template === null || typeof template !== 'object' || template._isPurged === true) continue;
      const source = template._fieldSource;
      let update;
      if (template.kind === 'category' && ArrayBuffer.isView(template.codes)) {
        const codes = movedCellArray(template.codes, order);
        const { centroidsByLayout, normalizedLayouts } = registry.computeCentroidsByLayout(codes, template.categories, this);
        update = { codes, centroidsByLayout, _normalizedLayouts: normalizedLayouts };
      } else if (template.kind === 'continuous' && template._sourceField === null && template.values instanceof Float32Array) {
        update = { values: movedCellArray(template.values, order) };
      } else if (template.kind === 'continuous' && template._sourceField?.sourceKey) {
        const sourceKey = template._sourceField.sourceKey;
        const sourceField = (source === 'var' ? this.varData : this.obsData)?.fields?.find(field => (field._originalKey || field.key) === sourceKey && field._isUserDefined !== true);
        update = sourceField?.loaded === true && sourceField.values instanceof Float32Array
          ? { values: sourceField.values, loaded: true }
          : { values: null, loaded: false };
      } else {
        continue;
      }
      for (const copy of this._userDefinedFieldCopies(template._userDefinedId, source)) {
        Object.assign(copy, update);
        delete copy._categoryCounts;
        delete copy.outlierQuantiles;
        if (copy.kind === 'continuous' && copy._continuousStats !== undefined && copy.loaded !== false) {
          this._carryContinuousRanges(copy, n, outcome);
        }
      }
    }

    this.cellVisibilityMask = movedCellArray(this.cellVisibilityMask, order);
    this.colorsArray = createNeutralColors(n);
    this.categoryTransparency = new Uint8Array(n).fill(1);
    if (this.cellVisibilityMask.every(value => value === 1)) {
      this.cellVisibilityMask = createShownCellVisibilityMask(n);
      recordUnfilteredVisibility(this.categoryTransparency, this.cellVisibilityMask);
    }
    recordAlphaBytesMirror(this.colorsArray, this.categoryTransparency);
    this.filteredCount = { shown: n, total: n };

    for (const page of this.highlightPages) {
      for (const group of page.highlightedGroups) group.cellIndices = movedCells(group.cellIndices, positionOf);
    }
    this._derivedResults.moveCells(positionOf);
    this.highlightArray = new Uint8Array(n);
    this._highlightedCellIndices = new Uint32Array(0);
    this._invalidateHighlightCountCache?.();
    this._cachedHighlightLodMembership = null;
    getFieldRegistry().invalidate();
    return outcome;
  }

  /**
   * Publish the resized cells (`resizeOpenCells`) to the viewer and make
   * everything drawn from them again: the live points (the camera stays),
   * the priority, the field shown with its filters, colours and centroids,
   * then the highlights (a category or range group takes the cells added in
   * it that are visible, `takeInNewlyOpenCells`). A field shown that was
   * released (`resumeActive`) waits for its caller to load it again; the
   * view is shown uncoloured meanwhile.
   *
   * @param {{layoutKey: string|null, from: number}} options - The layout
   *   the live view shows; the open cell count before the resize
   */
  publishResizedCells({ layoutKey, from }) {
    this.viewer.resizeLiveCells({
      positions: this.positionsArray,
      colors: this.colorsArray,
      transparency: this.categoryTransparency,
      dimensionLevel: this.positionsDimension,
      layoutKey,
    });
    this.viewer.setCellPriority(this.cellPriority);
    const field = this.getActiveField?.() ?? null;
    if (field !== null && field.loaded === true) {
      this.restoreActiveFieldColors();
    } else {
      this.clearActiveField();
    }
    // Visibility is made again: groups defined by a category or range take
    // the visible cells added in it.
    if (this.pointCount > from) this._takeInHighlightGroups(cellRange(from, this.pointCount), []);
    this._recomputeHighlightArray();
    this._syncActiveContext();
    this._notifyHighlightPageChange();
    this._notifyHighlightChange();
    this._notifyVisibilityChange();
    // Outlier filters in use get their quantiles over the new cells.
    this.resumeOutlierFilters?.();
  }

  /**
   * Cells newly open after the dataset was read again with other cells
   * (`app/cell-subset-carry.js`; `cells`: their ascending positions) given
   * what is derived from the file, as growing gives the cells added: a
   * user-defined category made from a file's column labels them as its
   * other cells of the same source category (`derivedCodes`), and a category
   * or range highlight group takes those of them in its category or range
   * that are visible. `rules`: the carried groups made again from their
   * cells, each with the rule it was made by (`{type: 'category', fieldKey,
   * fieldSource, categoryName}` or `{type: 'range', fieldKey, fieldSource,
   * rangeMin, rangeMax}`), bound again to the field of that name; a rule
   * whose field or category is gone leaves its group the cells it has.
   * The fields read must be loaded first.
   *
   * @param {Uint32Array} cells
   * @param {Array<{group: object, rule: object}>} [rules]
   * @returns {{fields: number, groups: number}} The fields and groups that took cells
   */
  takeInNewlyOpenCells(cells, rules = []) {
    let fields = 0;
    const registry = this._userDefinedFields;
    for (const template of registry.getAllFields()) {
      if (template === null || typeof template !== 'object' || template._isPurged === true) continue;
      if (template.kind !== 'category' || !ArrayBuffer.isView(template.codes)) continue;
      const codes = this._derivedUserDefinedCodes(template, cells);
      if (codes === null) continue;
      const { centroidsByLayout, normalizedLayouts } = registry.computeCentroidsByLayout(codes, template.categories, this);
      for (const copy of this._userDefinedFieldCopies(template._userDefinedId, template._fieldSource)) {
        Object.assign(copy, { codes, centroidsByLayout, _normalizedLayouts: normalizedLayouts });
        delete copy._categoryCounts;
      }
      fields++;
    }
    const groups = this._takeInHighlightGroups(cells, rules);
    if (fields > 0) {
      getFieldRegistry().invalidate();
      const active = this.getActiveField?.() ?? null;
      if (active !== null && active.loaded === true) this.restoreActiveFieldColors();
    }
    if (fields > 0 || groups > 0) {
      this._recomputeHighlightArray();
      this._syncActiveContext();
      this._notifyHighlightChange();
    }
    return { fields, groups };
  }

  /**
   * The codes `derivedCodes` gives a user-defined category made from a
   * file's loaded column, or null. @private
   */
  _derivedUserDefinedCodes(template, cells) {
    const sourceKey = template._sourceField?.sourceKey;
    if (typeof sourceKey !== 'string' || template._fieldSource === 'var') return null;
    const source = (this.obsData?.fields ?? []).find(field => (
      field?._isUserDefined !== true && (field._originalKey || field.key) === sourceKey
    ));
    if (source === undefined || source.kind !== 'category' || source.loaded !== true || !ArrayBuffer.isView(source.codes)) return null;
    return derivedCodes(template, source, cells);
  }

  /**
   * Category and range highlight groups (every page) take the cells of
   * `cells` in their category or range that are visible in the live view,
   * as clicking the category or brushing the range would; `rules` binds
   * carried groups to their rule first (`takeInNewlyOpenCells`). @private
   * @returns {number} The groups that took cells
   */
  _takeInHighlightGroups(cells, rules) {
    const n = this.pointCount;
    const transparency = this.categoryTransparency;
    // A group's field: the one at its index when it still has its name (a
    // field deleted from the list, kept to be restored, still is), else
    // the field of that name, one in the list first.
    const fieldOf = (source, key, at = -1) => {
      const fields = (source === 'var' ? this.varData : this.obsData)?.fields ?? [];
      if (fields[at]?.key === key) return { field: fields[at], index: at };
      let index = fields.findIndex(field => field?.key === key && field._isDeleted !== true);
      if (index < 0) index = fields.findIndex(field => field?.key === key);
      return index < 0 ? null : { field: fields[index], index };
    };
    for (const { group, rule } of rules) {
      const bound = fieldOf(rule.fieldSource, rule.fieldKey);
      if (bound === null) continue;
      if (rule.type === 'category') {
        const categoryIndex = Array.isArray(bound.field.categories) ? bound.field.categories.indexOf(rule.categoryName) : -1;
        if (bound.field.kind !== 'category' || categoryIndex < 0) continue;
        Object.assign(group, { type: 'category', fieldKey: rule.fieldKey, fieldIndex: bound.index, fieldSource: rule.fieldSource, categoryIndex, categoryName: rule.categoryName });
      } else if (rule.type === 'range' && bound.field.kind === 'continuous') {
        Object.assign(group, { type: 'range', fieldKey: rule.fieldKey, fieldIndex: bound.index, fieldSource: rule.fieldSource, rangeMin: rule.rangeMin, rangeMax: rule.rangeMax });
      }
    }
    let took = 0;
    for (const page of this.highlightPages) {
      for (const group of page.highlightedGroups) {
        if (group.type !== 'category' && group.type !== 'range') continue;
        const bound = fieldOf(group.fieldSource, group.fieldKey, group.fieldIndex);
        if (bound === null || bound.field.loaded !== true) continue;
        const { field } = bound;
        let matches;
        if (group.type === 'category') {
          if (!ArrayBuffer.isView(field.codes) || field.codes.length !== n || field.categories?.[group.categoryIndex] !== group.categoryName) continue;
          matches = i => field.codes[i] === group.categoryIndex;
        } else {
          if (!(field.values instanceof Float32Array) || field.values.length !== n) continue;
          matches = i => {
            const v = field.values[i];
            return v >= group.rangeMin && v <= group.rangeMax;
          };
        }
        let count = 0;
        for (let c = 0; c < cells.length; c++) {
          const i = cells[c];
          if (matches(i) && transparency[i] >= POINT_VISIBILITY_THRESHOLD) count++;
        }
        if (count === 0) continue;
        const added = new Uint32Array(count);
        let at = 0;
        for (let c = 0; c < cells.length; c++) {
          const i = cells[c];
          if (matches(i) && transparency[i] >= POINT_VISIBILITY_THRESHOLD) added[at++] = i;
        }
        group.cellIndices = mergedCells(group.cellIndices, added);
        group.cellCount = group.cellIndices.length;
        took++;
      }
    }
    if (took > 0) this._invalidateHighlightCountCache?.();
    return took;
  }

  /**
   * One field's arrays as `n` cells (`resizeOpenCells`), and what was
   * derived from them made again or dropped. @private
   */
  _resizeFieldArrays(field, key, source, from, n, addedRows, categoriesChanged, outcome) {
    // Derived from every cell: made again when used.
    if (field.centroidsByLayout instanceof Map) field.centroidsByLayout.clear();
    if (field._normalizedLayouts instanceof Set) field._normalizedLayouts.clear();
    delete field._categoryCounts;
    delete field.outlierQuantiles;
    field._loadingPromise = null;
    field._loadingSignal = null;
    if (field.loaded !== true) return;
    const release = () => {
      for (const name of FIELD_ARRAY_KEYS) delete field[name];
      field.loaded = false;
      outcome.released.push(`${source === 'var' ? 'gene' : 'field'} ${field.key}`);
      // Its statistics are measured again when it is loaded; a range set on
      // it is not kept (it is checked against them).
      if (field._continuousStats !== undefined) {
        const stats = field._continuousStats;
        for (const [name, label] of [['_continuousFilter', 'the filter'], ['_continuousColorRange', 'the colour range']]) {
          const range = field[name];
          if (range !== undefined && (range.min !== stats.min || range.max !== stats.max)) outcome.resetRanges.push(`${label} of ${field.key}`);
          delete field[name];
        }
        delete field._continuousStats;
        delete field._positiveStats;
      }
    };
    if (categoriesChanged) {
      // Its categories are found from every cell: they are found again,
      // and what was set per category starts over.
      release();
      outcome.recoded.push(field.key);
      field.categories = null;
      delete field._categoryColors;
      delete field._categoryVisible;
      return;
    }
    const grown = n > from;
    if (grown && addedRows === null) {
      release();
      return;
    }
    if (field.kind === 'category') {
      if (!ArrayBuffer.isView(field.codes)) {
        release();
        return;
      }
      field.codes = resizedCellArray(field.codes, from, n, { added: grown ? addedRows.codes : null });
      return;
    }
    if (!(field.values instanceof Float32Array)) {
      release();
      return;
    }
    field.values = resizedCellArray(field.values, from, n, { added: grown ? addedRows.values : null });
    this._carryContinuousRanges(field, n, outcome);
  }

  /**
   * A continuous field's statistics measured again over its resized values,
   * with its filter and colour ranges carried (`carriedRange`); a range
   * nothing of which lies within the new values is reset, and said. @private
   */
  _carryContinuousRanges(field, n, outcome) {
    if (field._continuousStats === undefined) return;
    const oldStats = field._continuousStats;
    const filter = field._continuousFilter;
    const colorRange = field._continuousColorRange;
    delete field._continuousStats;
    delete field._positiveStats;
    delete field._continuousFilter;
    delete field._continuousColorRange;
    // Measured over the resized values (the state's count is already `n`).
    const { stats } = this.ensureContinuousMetadata(field);
    for (const [name, range] of [['_continuousFilter', filter], ['_continuousColorRange', colorRange]]) {
      const carried = carriedRange(range, oldStats, stats);
      if (carried === null) {
        outcome.resetRanges.push(`${name === '_continuousFilter' ? 'the filter' : 'the colour range'} of ${field.key}`);
      } else if (carried !== undefined) {
        field[name] = carried;
      }
    }
    // The carried ranges are checked against the statistics as set ones are.
    this.ensureContinuousMetadata(field);
  }

  /**
   * User-defined fields' own arrays as `n` cells, in every copy
   * (`_userDefinedFieldCopies`): a category's codes (added cells labelled
   * from its source column when it was made from one, else missing),
   * a value field's values (added cells NaN); a copy of a field takes its
   * source's arrays. Centroids are counted again. @private
   */
  _resizeUserDefinedFields(from, n, outcome) {
    const registry = this._userDefinedFields;
    for (const template of registry.getAllFields()) {
      if (template === null || typeof template !== 'object' || template._isPurged === true) continue;
      const id = template._userDefinedId;
      const source = template._fieldSource;
      const copies = this._userDefinedFieldCopies(id, source);
      let update;
      if (template.kind === 'category' && ArrayBuffer.isView(template.codes)) {
        const { missingValue } = categoricalStorageForCodes(template.codes, `User-defined field "${template.key}"`);
        const resized = resizedCellArray(template.codes, from, n, { fill: missingValue });
        // Cells added to a category made from a file's column are labelled
        // from it (its source is resized above), as opening them would.
        const codes = n > from ? this._derivedUserDefinedCodes({ ...template, codes: resized }, cellRange(from, n)) ?? resized : resized;
        const { centroidsByLayout, normalizedLayouts } = registry.computeCentroidsByLayout(codes, template.categories, this);
        update = { codes, centroidsByLayout, _normalizedLayouts: normalizedLayouts };
      } else if (template.kind === 'continuous' && template._sourceField === null && template.values instanceof Float32Array) {
        update = { values: resizedCellArray(template.values, from, n, { fill: Number.NaN }) };
      } else if (template.kind === 'continuous' && template._sourceField?.sourceKey) {
        // A copy shares its source's values: the source's resized ones, or
        // none until it is loaded again.
        const sourceKey = template._sourceField.sourceKey;
        const sourceField = (source === 'var' ? this.varData : this.obsData)?.fields?.find(field => (field._originalKey || field.key) === sourceKey && field._isUserDefined !== true);
        update = sourceField?.loaded === true && sourceField.values instanceof Float32Array
          ? { values: sourceField.values, loaded: true }
          : { values: null, loaded: false };
      } else {
        continue;
      }
      for (const copy of copies) {
        Object.assign(copy, update);
        delete copy._categoryCounts;
        delete copy.outlierQuantiles;
        if (copy.kind === 'continuous' && copy._continuousStats !== undefined && copy.loaded !== false) {
          this._carryContinuousRanges(copy, n, outcome);
        }
      }
    }
  }
}
