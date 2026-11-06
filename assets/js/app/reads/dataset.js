/**
 * @fileoverview The dataset reads (`app/actions/definitions/reads.js`): its
 * summary, its fields, a field's categories, gene search, values of named
 * cells, a field per category. A field a read needs is read first (as
 * colouring by it would); nothing a person sees changes.
 *
 * @module app/reads/dataset
 */

import { ActionRefused } from '../actions/dispatcher.js';
import { FieldKind } from '../utils/field-constants.js';
import { rankGeneMatches } from '../utils/gene-lookup.js';
import { missingCategoryCode } from '../../data/categorical-storage-contract.js';
import { defaultCategoryColor } from '../../data/palettes.js';
import { describeSubsampleMethod } from '../../data/subsample.js';
import { kindWord, resolveField } from '../actions/targets/fields.js';
import { viewNameOf } from '../actions/targets/views.js';
import { formatCountOf } from '../../utils/format-units.js';

const hex2 = value => Math.round(value).toString(16).padStart(2, '0');

/** A category's colour as `#rrggbb`, without making the field's colour state. */
function categoryHex(field, index) {
  const colors = field._categoryColors;
  if (colors !== undefined) return `#${hex2(colors[index * 3])}${hex2(colors[index * 3 + 1])}${hex2(colors[index * 3 + 2])}`;
  const [r, g, b] = defaultCategoryColor(field, index);
  return `#${hex2(r * 255)}${hex2(g * 255)}${hex2(b * 255)}`;
}

/** A value as JSON carries it: a finite number, or null. */
const finiteOrNull = value => (Number.isFinite(value) ? value : null);

/** The open cells' subsample spec, when the source publishes one. */
function subsampleSpecOf(dataSourceManager) {
  if (dataSourceManager === null) return null;
  const sourceType = dataSourceManager.getCurrentSourceType?.() ?? null;
  const datasetId = dataSourceManager.getCurrentDatasetId?.() ?? null;
  if (sourceType === null) return null;
  const annData = dataSourceManager.getSource?.(sourceType)?.getAnnDataSource?.(datasetId) ?? null;
  return typeof annData?.getCellSubset === 'function' ? annData.getCellSubset()?.spec ?? null : null;
}

/**
 * The open dataset as an analysis result's provenance names it
 * (`analysis/shared/result-provenance.js`): its id, and the subsample's
 * method and seed when the open cells are one.
 *
 * @param {object|null} dataSourceManager
 * @returns {{id: string|null, method: string|null, seed: number|null}}
 */
export function describeOpenDataset(dataSourceManager) {
  const spec = subsampleSpecOf(dataSourceManager);
  return {
    id: dataSourceManager?.getCurrentDatasetId?.() ?? null,
    method: typeof spec?.method === 'string' ? spec.method : null,
    seed: Number.isSafeInteger(spec?.seed) ? spec.seed : null,
  };
}

/**
 * Read a field's values for the open cells: an obs field's codes or values,
 * a gene's column (NaN where it was not read for a cell).
 */
async function loadedField(state, resolved, signal) {
  if (resolved.source === 'var') {
    return state.ensureVarFieldLoaded(resolved.index, { silent: true, signal });
  }
  return state.ensureFieldLoaded(resolved.index, { silent: true, signal });
}

/**
 * @param {{state: object, viewer: object, dataSourceManager: object|null}} owners
 */
export function createDatasetReads({ state, viewer, dataSourceManager }) {
  function requireCells() {
    const identity = state.cellIdentity ?? null;
    if (identity === null || !(state.pointCount > 0)) {
      throw new ActionRefused('No dataset is open yet.', { code: 'unavailable' });
    }
    return identity;
  }

  function summary() {
    const identity = requireCells();
    const meta = dataSourceManager?.getCurrentMetadata?.() ?? null;
    const spec = identity.isSubset ? subsampleSpecOf(dataSourceManager) : null;
    const obs = (state.obsData?.fields ?? []).filter(field => field && field._isDeleted !== true);
    const sample = state.getGeneSample?.() ?? null;
    const embeddings = [];
    for (const choice of state.getRepresentationChoices?.() ?? []) {
      if (choice.enabled) embeddings.push({ name: choice.name, dimension: choice.dimension });
    }
    return {
      name: meta?.name ?? null,
      id: dataSourceManager?.getCurrentDatasetId?.() ?? null,
      source: dataSourceManager?.getCurrentSourceType?.() ?? null,
      citation: meta?.source?.citation ?? null,
      cells: {
        total: identity.nOriginal,
        open: identity.n,
        share: identity.nOriginal === 0 ? 0 : identity.n / identity.nOriginal,
        subsample: identity.isSubset ? (spec === null ? 'a subsample' : describeSubsampleMethod(spec)) : null,
        digest: identity.digest,
      },
      genes: {
        count: state.getVarAxisGeneCount?.() ?? 0,
        read_for: sample === null ? null : { cells: sample.cells, of: sample.of },
      },
      embeddings,
      fields: {
        categorical: obs.filter(field => field.kind === FieldKind.CATEGORY).length,
        continuous: obs.filter(field => field.kind === FieldKind.CONTINUOUS).length,
        user_defined: obs.filter(field => field._isUserDefined === true).length,
      },
    };
  }

  function listFields({ kind, query }) {
    requireCells();
    const wanted = query?.toLowerCase() ?? null;
    const fields = [];
    for (const field of state.obsData?.fields ?? []) {
      if (!field || field._isDeleted === true) continue;
      const fieldKind = kindWord(field.kind);
      if (kind !== undefined && fieldKind !== kind) continue;
      if (wanted !== null && !field.key.toLowerCase().includes(wanted)) continue;
      const entry = { key: field.key, kind: fieldKind, user_defined: field._isUserDefined === true };
      if (fieldKind === 'categorical' && Array.isArray(field.categories)) entry.categories = field.categories.length;
      fields.push(entry);
    }
    return { fields };
  }

  async function categories({ field: ref }, { signal }) {
    requireCells();
    if (ref.source !== 'obs') {
      throw new ActionRefused(`${ref.key} is a gene; categories belong to a categorical obs field.`, { code: 'wrong-kind' });
    }
    const resolved = resolveField(state, ref, { kind: FieldKind.CATEGORY });
    const field = await loadedField(state, resolved, signal);
    const counts = state.computeCategoryCountsForField(field);
    const visible = field._categoryVisible;
    const viewId = state.getActiveViewId();
    return {
      field: field.key,
      view: viewNameOf(viewer, viewId),
      categories: field.categories.map((label, index) => ({
        label: String(label),
        cells: counts.total[index],
        visible: counts.visible[index],
        color: categoryHex(field, index),
        shown: visible === undefined ? true : visible[index] === 1,
      })),
      missing: counts.missing.total,
    };
  }

  function searchGenes({ query, limit }) {
    requireCells();
    const fields = (state.varData?.fields ?? []).filter(field => field && field._isDeleted !== true);
    const matches = rankGeneMatches(fields.map(field => field.key.toLowerCase()), query);
    return { genes: matches.slice(0, limit).map(index => fields[index].key), matches: matches.length, total: fields.length };
  }

  async function cellValues({ cells, fields: refs }, { signal }) {
    const identity = requireCells();
    const originals = Array.from(cells);
    const outside = originals.find(position => position >= identity.nOriginal);
    if (outside !== undefined) {
      throw new ActionRefused(`Cell ${outside} is not a cell of this dataset: it has ${formatCountOf(identity.nOriginal, 'cell')}, numbered from 0.`, {
        code: 'no-target',
      });
    }
    const positions = identity.openPositionsOf(Uint32Array.from(originals));
    const open = [];
    const openAt = [];
    const notOpen = [];
    for (let i = 0; i < originals.length; i++) {
      if (positions[i] < 0) notOpen.push(originals[i]);
      else { open.push(originals[i]); openAt.push(positions[i]); }
    }
    const columns = [];
    for (const ref of refs) {
      const resolved = resolveField(state, ref);
      const field = await loadedField(state, resolved, signal);
      let values;
      if (field.kind === FieldKind.CATEGORY) {
        const missing = missingCategoryCode(field.codes);
        values = openAt.map(i => (field.codes[i] === missing ? null : String(field.categories[field.codes[i]])));
      } else {
        values = openAt.map(i => finiteOrNull(field.values[i]));
      }
      columns.push({ field: { source: resolved.source, key: field.key, kind: kindWord(field.kind) }, values });
    }
    return { cells: open, columns, not_open: notOpen };
  }

  async function fieldSummary({ field: ref, by, top, visible_only: visibleOnly }, { signal }) {
    requireCells();
    if (by.source !== 'obs') throw new ActionRefused('Cells are grouped by a categorical obs field.', { code: 'wrong-kind' });
    const groupsResolved = resolveField(state, by, { kind: FieldKind.CATEGORY });
    const groupsField = await loadedField(state, groupsResolved, signal);
    const resolved = resolveField(state, ref);
    const field = await loadedField(state, resolved, signal);
    const n = state.pointCount;
    const alpha = visibleOnly ? state.categoryTransparency : null;
    const groupCodes = groupsField.codes;
    const groupMissing = missingCategoryCode(groupCodes);
    const groupCount = groupsField.categories.length;
    const members = Array.from({ length: groupCount }, () => []);
    for (let i = 0; i < n; i++) {
      const code = groupCodes[i];
      if (code === groupMissing || code >= groupCount) continue;
      if (alpha !== null && alpha[i] === 0) continue;
      members[code].push(i);
    }
    const sample = resolved.source === 'var' ? (state.getGeneSample?.() ?? null) : null;
    const groups = [];
    if (field.kind === FieldKind.CATEGORY) {
      const missing = missingCategoryCode(field.codes);
      for (let g = 0; g < groupCount; g++) {
        const tally = new Map();
        for (const i of members[g]) {
          const code = field.codes[i];
          if (code === missing) continue;
          tally.set(code, (tally.get(code) ?? 0) + 1);
        }
        const topCategories = [...tally].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, top)
          .map(([code, cells]) => ({ label: String(field.categories[code]), cells }));
        groups.push({ label: String(groupsField.categories[g]), cells: members[g].length, top: topCategories });
      }
    } else {
      for (let g = 0; g < groupCount; g++) {
        const values = [];
        for (const i of members[g]) {
          const value = field.values[i];
          if (Number.isFinite(value)) values.push(value);
        }
        values.sort((a, b) => a - b);
        let sum = 0;
        let above = 0;
        for (const value of values) { sum += value; if (value > 0) above++; }
        const m = values.length;
        groups.push({
          label: String(groupsField.categories[g]),
          cells: members[g].length,
          mean: m === 0 ? null : sum / m,
          median: m === 0 ? null : (m % 2 === 1 ? values[(m - 1) / 2] : (values[m / 2 - 1] + values[m / 2]) / 2),
          min: m === 0 ? null : values[0],
          max: m === 0 ? null : values[m - 1],
          above_zero: m === 0 ? null : above / m,
        });
      }
    }
    return {
      field: { source: resolved.source, key: field.key, kind: kindWord(field.kind) },
      by: groupsField.key,
      read_for: sample === null ? null : { cells: sample.cells, of: sample.of },
      groups,
    };
  }

  return { summary, listFields, categories, searchGenes, cellValues, fieldSummary };
}
