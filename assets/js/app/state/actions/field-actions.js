/**
 * @fileoverview The implementations of the field, label, colour, filter,
 * cell-visibility, gene-set and data-mapping actions that need nothing but
 * the state (`app/actions/definitions/{fields,coloring,filters,mapping}.js`):
 * each resolves the names its parameters give (`app/actions/targets/`) and calls the
 * `DataState` method the sidebar called before it dispatched.
 *
 * The actions whose implementation is an orchestration of a control live
 * with that control: colouring by a field or gene and duplicating a field
 * (`ui/modules/field-selector.js`), opening a share of the cells
 * (`subsample-control.js`), reading genes for more cells
 * (`gene-read-control.js`).
 *
 * Every handler returns a small outcome (names, counts) or null when
 * nothing changed, and refuses with one sentence (`ActionRefused`) when a
 * name does not resolve or the change cannot be made.
 *
 * @module state/actions/field-actions
 */

import { getActions } from '../../actions/index.js';
import { ActionRefused } from '../../actions/dispatcher.js';
import { mappingChangesOf } from '../../actions/definitions/mapping.js';
import { StateValidator } from '../../utils/state-validator.js';
import { FieldSource, OverlapStrategy } from '../../utils/field-constants.js';
import { categoricalStorageForCount } from '../../../data/categorical-storage-contract.js';
import { NOTEBOOK_PUSH_OPERATION } from '../../viewer-host/results.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { throwIfAborted, onAbort } from '../../../utils/abort.js';
import { categoryCellLimitAt } from '../managers/category-cell-sample.js';
import { consensusColumnOf } from '../../community-annotations/consensus-codes.js';
import { annotationCategories, annotationFieldKey } from '../../community-annotations/field-names.js';
import { categoryLabel, listNames, quoteName } from '../../actions/targets/names.js';
import {
  requireNewName, resolveCategory, resolveDeletedField, resolveField, resolveLoadedField, resolveShownField,
} from '../../actions/targets/fields.js';
import { resolvePage } from '../../actions/targets/pages.js';

/** `#rrggbb` as the state's RGB in [0, 1]. */
export function hexToRgb01(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

/** The state's RGB in [0, 1] as `#rrggbb`. */
export function rgb01ToHex(rgb) {
  return `#${rgb.map(channel => Math.round(channel * 255).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Refuse a column of another dataset by its cell count. The count cannot
 * tell two datasets of as many cells apart: a recorded step that names cells
 * by their positions is applied again only on the dataset it was recorded
 * on (`history/history.js` `replaySteps`, `history/replay.js` `namesCells`),
 * and a notebook pushes the values of the dataset it shows.
 */
function requireSameDataset(identity, { key, n_obs: nObs }) {
  if (nObs !== identity.nOriginal) {
    throw new ActionRefused(
      `The column ${quoteName(key)} has ${formatCountOf(nObs, 'cell')} and this dataset ` +
      `${formatCountOf(identity.nOriginal, 'cell')}: it belongs to another dataset.`,
      { code: 'other-dataset' },
    );
  }
}

/**
 * A categorical column's codes on the open cells (`{cells, values}` by
 * original position), in the narrowest storage its categories fit. A code
 * outside the categories (the binary frame's largest value) is no category.
 * Codes wider than the storage are read wide first, so none is cut into
 * another category's.
 */
function openCodesOf(identity, { key, categories, cells, values }) {
  const storage = categoricalStorageForCount(categories.length, `The column ${quoteName(key)}`);
  const Codes = storage.TypedArrayClass;
  const narrow = (values instanceof Uint8Array || values instanceof Uint16Array || values instanceof Uint32Array)
    && values.BYTES_PER_ELEMENT <= Codes.BYTES_PER_ELEMENT;
  const read = identity.openValues({ cells, values }, narrow ? Codes : Uint32Array, narrow ? storage.missingValue : 0xffffffff);
  const codes = narrow ? read : new Codes(read.length);
  const count = categories.length;
  for (let index = 0; index < codes.length; index++) {
    const code = read[index];
    codes[index] = code < count ? code : storage.missingValue;
  }
  return codes;
}

/** A label with something to read, and no space at either end. */
function isExactNonblank(text) {
  return /\S/.test(text) && !/^\s|\s$/.test(text);
}

function requireDataset(state) {
  if (!Array.isArray(state.getFields?.()) || state.pointCount === 0) {
    throw new ActionRefused('No dataset is open.', { code: 'no-dataset' });
  }
}

/**
 * Install every state-only field, colour, filter and mapping action.
 *
 * @param {{
 *   state: object,
 *   fieldLock?: (source: 'obs'|'var', field: object) => (string|null),
 *   actions?: ReturnType<typeof getActions>,
 * }} options - `fieldLock`: why a field's name and categories cannot be
 *   edited now (community annotation voting on it), or null; `actions`: the
 *   dispatcher they are provided on (the page's by default)
 * @returns {() => void} Removes them
 */
export function installFieldActions({ state, fieldLock = () => null, actions = getActions() }) {

  function requireUnlocked(target) {
    const reason = fieldLock(target.source, target.field);
    if (reason !== null) throw new ActionRefused(reason, { code: 'locked' });
  }

  /** The active field's index the continuous setters take (a gene's is ignored). */
  function continuousIndex(target) {
    return target.source === 'var' ? state.activeFieldIndex : target.index;
  }

  const handlers = {
    // ---- Fields ------------------------------------------------------------
    'field.rename': ({ field: ref, name }) => {
      const target = resolveField(state, ref);
      requireUnlocked(target);
      if (target.field.key === name) return null;
      requireNewName(state, target.source, name, target.index);
      state.renameField(target.source, target.index, name);
      return { name };
    },
    'field.revert-name': ({ field: ref }) => {
      const target = resolveField(state, ref);
      requireUnlocked(target);
      if (!Object.hasOwn(target.field, '_originalKey')) return null;
      const original = target.field._originalKey;
      requireNewName(state, target.source, original, target.index);
      state.revertFieldRename(target.source, target.index);
      return { name: original };
    },
    'field.delete': ({ field: ref }) => {
      const target = resolveField(state, ref);
      requireUnlocked(target);
      state.deleteField(target.source, target.index);
      return { name: ref.key };
    },
    'field.restore': ({ field: ref }) => {
      const target = resolveDeletedField(state, ref);
      if (StateValidator.isDuplicateKey(ref.key, target.source === FieldSource.VAR ? state.getVarFields() : state.getFields())) {
        throw new ActionRefused(
          `A field named ${quoteName(ref.key)} is shown already; rename it before restoring the deleted one.`,
          { code: 'name-taken' },
        );
      }
      const result = target.index >= 0
        ? state.restoreField(target.source, target.index)
        : state.restoreUserDefinedField(target.userDefinedId, target.source);
      return { name: result.key };
    },
    'field.purge': ({ field: ref }) => {
      const target = resolveDeletedField(state, ref);
      if (target.index >= 0) state.purgeDeletedField(target.source, target.index);
      else state.purgeUserDefinedField(target.userDefinedId, target.source);
      return { name: ref.key };
    },
    'field.create-from-pages': params => {
      requireDataset(state);
      requireNewName(state, FieldSource.OBS, params.key);
      const pages = params.pages.map(entry => ({ pageId: resolvePage(state, entry.page).id, label: entry.label }));
      const order = new Map(params.pages.map((entry, position) => [entry.page, position]));
      const intersectionLabels = {};
      if (params.overlap === OverlapStrategy.INTERSECTIONS) {
        for (const combination of params.intersection_labels) {
          let mask = 0;
          for (const name of combination.pages) {
            if (!order.has(name)) {
              throw new ActionRefused(
                `The combination ${quoteName(combination.label)} names the page ${quoteName(name)}, which is not among the pages given (${listNames([...order.keys()])}).`,
                { code: 'no-such-page' },
              );
            }
            mask |= 1 << order.get(name);
          }
          intersectionLabels[String(mask)] = combination.label;
        }
      } else if (params.intersection_labels.length > 0) {
        throw new ActionRefused('Intersection labels are given only with overlap "intersections".', { code: 'bad-params' });
      }
      let result;
      try {
        result = state.createCategoricalFromPages({
          key: params.key,
          pages,
          uncoveredLabel: params.uncovered_label,
          overlapStrategy: params.overlap,
          overlapLabel: params.overlap === OverlapStrategy.OVERLAP_LABEL ? params.overlap_label : '',
          intersectionLabels,
        });
      } catch (error) {
        throw new ActionRefused(`The field ${quoteName(params.key)} cannot be made: ${error.message}`, { code: 'refused' });
      }
      return {
        name: params.key,
        categories: result.field.categories.length,
        conflicts: result.conflicts,
        uncovered: result.uncoveredCount,
      };
    },
    'field.push': params => {
      requireDataset(state);
      const identity = state.cellIdentity;
      requireSameDataset(identity, params);
      if ((params.kind === 'categorical') !== Array.isArray(params.categories)) {
        throw new ActionRefused('A categorical column names its categories, and a continuous one none.', { code: 'bad-params' });
      }
      const operation = { type: NOTEBOOK_PUSH_OPERATION };
      const column = { cells: params.cells, values: params.values };
      if (params.kind === 'continuous') {
        const values = identity.openValues(column, Float32Array, NaN);
        const { fieldId } = state.upsertUserDefinedContinuousField({ key: params.key, values, operation });
        return { name: params.key, kind: 'continuous', id: fieldId };
      }
      const fields = state.getFields();
      const existing = fields.find(field => field?._isDeleted !== true && field?.key === params.key);
      if (existing !== undefined && existing._operation?.type !== NOTEBOOK_PUSH_OPERATION) {
        throw new ActionRefused(
          `A field named ${quoteName(params.key)} exists already; push the column under another name.`,
          { code: 'name-taken' },
        );
      }
      const { fieldIndex } = state.upsertUserDefinedCategoricalField({
        key: params.key,
        categories: [...params.categories],
        codes: openCodesOf(identity, params),
        meta: { _operation: operation },
      });
      return { name: params.key, kind: 'categorical', id: state.getFields()[fieldIndex]._userDefinedId };
    },
    'field.consensus': async ({ key, field: ref, mapping, settings, provenance }, { signal }) => {
      requireDataset(state);
      const source = await resolveLoadedField(state, ref, { kind: 'category', signal });
      const shown = source.field.categories;
      const outcomes = new Array(shown.length).fill(null);
      for (const entry of mapping) {
        if ((entry.status === 'consensus') !== (entry.label !== null)) {
          throw new ActionRefused(`The outcome of ${quoteName(entry.category)} names a label only when its status is consensus.`, { code: 'bad-params' });
        }
        if (entry.label !== null && !isExactNonblank(entry.label)) {
          throw new ActionRefused(`The label agreed for ${quoteName(entry.category)} is blank or starts or ends with a space.`, { code: 'bad-params' });
        }
        const index = resolveCategory(source.field, entry.category);
        if (outcomes[index] !== null) throw new ActionRefused(`${quoteName(entry.category)} is given two outcomes.`, { code: 'bad-params' });
        outcomes[index] = entry;
      }
      const column = consensusColumnOf({ outcomes, codes: source.field.codes });
      // Kept on the column in the dataset's names (`field-names.js`): the repository knows those, so
      // whether the consensus changed since is told whatever the column or its categories are called here.
      const fieldKey = annotationFieldKey(source.field);
      const originalCategories = annotationCategories(source.field);
      // Built again under its name, the consensus column is replaced in
      // place; a name another column holds gives a free name beside it.
      const result = state.upsertUserDefinedCategoricalField({
        key,
        categories: column.categories,
        codes: column.codes,
        meta: {
          // A category-for-category function of its source: newly opened cells are labelled from it.
          _sourceField: { kind: 'community-annotation', sourceKey: fieldKey, sourceIndex: source.index },
          _operation: {
            type: 'community-consensus',
            fieldKey,
            outcomes: originalCategories.map((category, index) => ({
              category: categoryLabel(category),
              status: outcomes[index]?.status ?? 'pending',
              label: outcomes[index]?.label ?? null,
            })),
            settings: { ...settings },
            provenance: { ...provenance },
          },
        },
      });
      return { name: result.key, of: source.field.key, replaced: result.updatedInPlace };
    },
    'category.rename': async ({ field: ref, category, name }, { signal }) => {
      const target = await resolveLoadedField(state, ref, { kind: 'category', signal });
      requireUnlocked(target);
      const index = resolveCategory(target.field, category);
      if (category === name) return null;
      if (target.field.categories.some((label, at) => at !== index && categoryLabel(label) === name)) {
        throw new ActionRefused(`${quoteName(ref.key)} has a category ${quoteName(name)} already; choose another label.`, { code: 'name-taken' });
      }
      state.renameCategory(FieldSource.OBS, target.index, index, name);
      return { name };
    },
    'category.merge': async ({ field: ref, category, into }, { signal }) => {
      const target = await resolveLoadedField(state, ref, { kind: 'category', signal });
      requireUnlocked(target);
      const from = resolveCategory(target.field, category);
      const to = resolveCategory(target.field, into);
      if (from === to) throw new ActionRefused(`${quoteName(category)} cannot be merged into itself.`, { code: 'bad-params' });
      const result = state.mergeCategoriesToNewField(target.index, from, to, {
        editInPlace: target.field._isUserDefined === true,
      });
      return { name: result.newKey, merged: result.mergedCategoryLabel, in_place: result.updatedInPlace };
    },
    'category.delete': async ({ field: ref, category, unassigned_label: unassignedLabel }, { signal }) => {
      const target = await resolveLoadedField(state, ref, { kind: 'category', signal });
      requireUnlocked(target);
      const index = resolveCategory(target.field, category);
      if (category === unassignedLabel) {
        throw new ActionRefused(`${quoteName(category)} is the unassigned category; its cells have nowhere else to go.`, { code: 'bad-params' });
      }
      const result = state.deleteCategoryToUnassigned(target.index, index, {
        unassignedLabel,
        editInPlace: target.field._isUserDefined === true,
      });
      return { name: result.newKey, in_place: result.updatedInPlace };
    },
    'gene-set.save': ({ name, description, genes }) => {
      requireDataset(state);
      const entry = state.getDerivedResults().upsertNotebookGeneSet({ name, description, genes });
      return { id: entry.id, name, genes: genes.length };
    },

    // ---- Colours -----------------------------------------------------------
    'color.category': async ({ field: ref, category, color }, { signal }) => {
      const target = await resolveLoadedField(state, ref, { kind: 'category', signal });
      const index = resolveCategory(target.field, category);
      const rgb = hexToRgb01(color);
      if (rgb01ToHex(state.getColorForCategory(target.field, index)) === color.toLowerCase()) return null;
      state.setColorForCategory(target.field, index, rgb);
      return { color: color.toLowerCase() };
    },
    'color.continuous.colormap': ({ field: ref, colormap }) => {
      const target = resolveShownField(state, ref, { kind: 'continuous' });
      state.setContinuousColormap(continuousIndex(target), colormap);
      return { colormap };
    },
    'color.continuous.log': ({ field: ref, enabled }) => {
      const target = resolveShownField(state, ref, { kind: 'continuous' });
      state.setContinuousLogScale(continuousIndex(target), enabled);
      return { enabled };
    },
    'color.continuous.zero-gray': ({ field: ref, enabled }) => {
      const target = resolveShownField(state, ref, { kind: 'continuous' });
      state.setContinuousZeroGray(continuousIndex(target), enabled);
      return { enabled };
    },
    'color.continuous.rescale': ({ field: ref, enabled }) => {
      const target = resolveShownField(state, ref, { kind: 'continuous' });
      const index = continuousIndex(target);
      state.setContinuousColorRescale(index, enabled);
      // Rescaled, the colours span the visible range from then on.
      if (enabled) {
        const filter = state.getLegendModel(target.field).filter;
        state.setContinuousColorRange(index, filter.min, filter.max);
      }
      return { enabled };
    },
    'color.continuous.range': ({ field: ref, min, max }) => {
      const target = resolveShownField(state, ref, { kind: 'continuous' });
      const range = clampedRange(target.field, min, max);
      state.setContinuousColorRange(continuousIndex(target), range.min, range.max);
      return range;
    },

    // ---- Filters -----------------------------------------------------------
    'filter.category.visibility': async ({ field: ref, categories, visible }, { signal }) => {
      const target = await resolveLoadedField(state, ref, { kind: 'category', signal });
      const indices = categories.map(label => resolveCategory(target.field, label));
      if (indices.length === 1) {
        state.setVisibilityForCategory(target.field, indices[0], visible);
      } else {
        state.setCategoryStates(target.field, { visibility: indices.map(index => ({ index, visible })), colors: [] });
      }
      return { categories: indices.length };
    },
    'filter.category.all': async ({ field: ref, visible }, { signal }) => {
      const target = await resolveLoadedField(state, ref, { kind: 'category', signal });
      const field = target.field;
      // As the legend does: the categories with open cells left after the
      // other filters, when they are counted.
      const available = field._categoryCounts?.available;
      const onlyAvailable = Array.isArray(available) && available.length === field.categories.length;
      if (visible) state.showAllCategories(field, { onlyAvailable });
      else state.hideAllCategories(field, { onlyAvailable });
      return { categories: field.categories.length };
    },
    'filter.category.missing': async ({ field: ref, visible }, { signal }) => {
      const target = await resolveLoadedField(state, ref, { kind: 'category', signal });
      if ((target.field._missingVisible !== false) === visible) return null;
      state.setMissingCategoryVisibility(target.field, visible);
      return { visible };
    },
    'filter.category.cell-count': async ({ field: ref, category, count, seed }, { signal }) => {
      const target = await resolveLoadedField(state, ref, { kind: 'category', signal });
      const index = resolveCategory(target.field, category);
      const current = categoryCellLimitAt(target.field, index);
      if (count === null ? current === null : (current?.count === count && current.seed === seed)) return null;
      state.setCategoryCellLimit(target.field, index, count === null ? null : { count, seed });
      return { count };
    },
    'filter.continuous.range': ({ field: ref, min, max }) => {
      const target = resolveShownField(state, ref, { kind: 'continuous' });
      const range = clampedRange(target.field, min, max);
      const index = continuousIndex(target);
      state.applyContinuousFilter(index, range.min, range.max);
      // Rescaled to the range, the colours follow it.
      if (target.field._useFilterColorRange === true) state.setContinuousColorRange(index, range.min, range.max);
      return range;
    },
    'filter.continuous.reset': ({ field: ref }) => {
      const target = resolveShownField(state, ref, { kind: 'continuous' });
      const index = continuousIndex(target);
      state.resetContinuousFilter(index);
      if (target.field._useFilterColorRange === true) {
        const stats = target.field._continuousStats;
        state.setContinuousColorRange(index, stats.min, stats.max);
      }
      return null;
    },
    'filter.outlier': async ({ field: ref, threshold }, { signal }) => {
      const target = resolveShownField(state, ref, { kind: 'category' });
      if (target.source !== FieldSource.OBS) throw new ActionRefused('Outlier filters belong to columns of the cells.', { code: 'wrong-kind' });
      const status = state.getOutlierFilterStatus(target.index);
      const refusal = {
        none: `${quoteName(ref.key)} has no outlier filter: it is not a column of the file.`,
        'no-latent': `${quoteName(ref.key)} has no outlier filter until a latent space is chosen (Data mapping).`,
        'too-small': `No category of ${quoteName(ref.key)} has enough cells for an outlier filter.`,
      }[status.state];
      if (refusal !== undefined) throw new ActionRefused(refusal, { code: 'unavailable' });
      // Stopping the action stops the quantiles it waits for.
      const remove = onAbort(signal, () => state.cancelOutlierQuantiles(target.index));
      try {
        await state.setOutlierThresholdForActive(threshold);
      } finally {
        remove();
      }
      throwIfAborted(signal);
      // Quantiles that could not be got leave the threshold at 1 (the status says why).
      return { threshold: target.field._outlierThreshold ?? 1 };
    },
    'filter.enable': ({ field: ref, kind, enabled }) => {
      const id = existingFilterId(ref, kind);
      state.toggleFilterEnabled(id, enabled);
      return { enabled };
    },
    'filter.remove': ({ field: ref, kind }) => {
      const id = existingFilterId(ref, kind);
      state.removeFilter(id);
      return null;
    },

    // ---- Data mapping ------------------------------------------------------
    'mapping.set': async (params, { meta }) => {
      const current = state.getDataMapping();
      if (current === null) throw new ActionRefused('No dataset is open, so it has no data mapping.', { code: 'no-dataset' });
      const changes = mappingChangesOf(params);
      if (Object.keys(changes).length === 0) return null;
      const next = { ...current, ...changes };
      if (JSON.stringify(next) === JSON.stringify(current)) return null;
      const origin = meta.origin === 'host' ? 'notebook' : meta.origin === 'session' ? 'session' : 'user';
      await state.applyDataMapping(next, { origin });
      return { groups: Object.keys(changes).length };
    },
  };

  /** A field's filter of `kind` by its id, refused when the field has none. */
  function existingFilterId(ref, kind) {
    const target = resolveField(state, ref);
    const id = `${target.source}-${kind}-${target.index}`;
    const filters = state.getActiveFiltersStructured();
    if (!filters.some(filter => filter.id === id)) {
      const own = filters.filter(filter => filter.fieldKey === target.field.key).map(filter => filter.type);
      throw new ActionRefused(
        own.length === 0
          ? `${quoteName(ref.key)} has no filter.`
          : `${quoteName(ref.key)} has no ${kind} filter; it has ${listNames(own)}.`,
        { code: 'no-such-filter' },
      );
    }
    return id;
  }

  const removers = Object.entries(handlers).map(([type, handler]) => actions.provide(type, handler));
  return () => {
    for (const remove of removers) remove();
  };
}

/** `[min, max]` within a continuous field's values; refused when min is above max. */
function clampedRange(field, min, max) {
  if (min > max) throw new ActionRefused(`The minimum ${min} is above the maximum ${max}.`, { code: 'bad-params' });
  const stats = field._continuousStats;
  if (!stats || !Number.isFinite(stats.min) || !Number.isFinite(stats.max)) {
    throw new ActionRefused(`${quoteName(field.key)} has no value among the open cells.`, { code: 'no-values' });
  }
  const low = Math.min(Math.max(min, stats.min), stats.max);
  const high = Math.max(Math.min(max, stats.max), low);
  return { min: low, max: high };
}
