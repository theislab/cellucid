/**
 * @fileoverview The dataset reads (`app/actions/definitions/reads.js`): its
 * summary, its fields, a field's categories, gene search, values of named
 * cells, a field per category. A field a read needs is read first (as
 * coloring by it would); nothing a person sees changes.
 *
 * @module app/reads/dataset
 */

import { ActionRefused } from '../actions/dispatcher.js';
import { FieldKind } from '../utils/field-constants.js';
import { rankGeneMatches } from '../utils/gene-lookup.js';
import { missingCategoryCode } from '../../data/categorical-storage-contract.js';
import { defaultCategoryColor } from '../../data/palettes.js';
import { describeSubsampleMethod } from '../../data/subsample.js';
import { citationText } from '../../data/anndata-cellucid-metadata.js';
import { kindWord, resolveCategory, resolveField } from '../actions/targets/fields.js';
import { viewNameOf } from '../actions/targets/views.js';
import { categoryDisplayName, quoteName } from '../actions/targets/names.js';
import { formatCountOf } from '../../utils/format-units.js';
import { hexOfBytes, hexOfRgb01 } from '../../utils/hex-color.js';
import { describeValues, transformWords } from '../../data/expression-transform.js';
import { NO_DATASET_OPEN } from '../ui/no-dataset.js';

/** A category's color as `#rrggbb`, without making the field's color state. */
function categoryHex(field, index) {
  const colors = field._categoryColors;
  if (colors !== undefined) return hexOfBytes(colors[index * 3], colors[index * 3 + 1], colors[index * 3 + 2]);
  return hexOfRgb01(defaultCategoryColor(field, index));
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
      throw new ActionRefused(NO_DATASET_OPEN, { code: 'unavailable' });
    }
    return identity;
  }

  /**
   * The expression transform (Data mapping › Expression values): what is
   * asked, what the mapped matrix shows, why it is not offered, and where
   * the cells' totals come from (stored or summed over the genes).
   */
  function expressionValues() {
    if ((state.getVarAxisGeneCount?.() ?? 0) === 0 || typeof state.getExpressionTransform !== 'function') return null;
    const asked = state.getExpressionTransform();
    const offer = state.expressionTransformOffer();
    const plan = state.cellTotalsPlan();
    return {
      normalize: asked.normalize,
      log1p: asked.log1p,
      shown: transformWords(state.getShownExpressionTransform()),
      offered: offer.offered,
      reason: offer.reason,
      totals: plan.field === null
        ? { stored: false, field: null, over: null, genes_summed: plan.genes }
        : { stored: true, field: plan.field, over: plan.over, genes_summed: 0 },
    };
  }

  /** A gene's values in words, as a read names them (null for an obs field). */
  function geneValuesWords() {
    const record = state.shownValuesRecord?.() ?? null;
    return describeValues(record, { counts: state.expressionTransformOffer?.().offered === true });
  }

  /** The modality shown and every modality, for a dataset of several; nulls with one. */
  function modalitiesOf() {
    const choices = state.getMappingGroupChoices?.('modality') ?? null;
    if (choices === null || choices.length < 2) return { modality: null, modalities: null };
    return {
      modality: state.getDataMapping?.()?.modality ?? null,
      modalities: choices.map(choice => ({ name: choice.value, about: choice.label, usable: choice.usable, reason: choice.reason ?? null })),
    };
  }

  function summary() {
    const identity = requireCells();
    const meta = dataSourceManager?.getCurrentMetadata?.() ?? null;
    const spec = identity.isSubset ? subsampleSpecOf(dataSourceManager) : null;
    const obs = (state.obsData?.fields ?? []).filter(field => field && field._isDeleted !== true);
    const sample = state.getGeneSample?.() ?? null;
    // Every embedding the data mapping offers, on or off, by the obsm key and columns that
    // mapping_set and view_embedding_set take: an agent given the labels only guessed keys (L21-6).
    const embeddings = (state.getRepresentationChoices?.() ?? []).map(choice => ({
      name: choice.name,
      dimension: choice.dimension ?? null,
      key: choice.ref.key,
      columns: choice.ref.columns === null ? null : [...choice.ref.columns],
      width: choice.width ?? null,
      enabled: choice.enabled === true,
      usable: choice.usable !== false,
      reason: choice.reason ?? null,
    }));
    return {
      name: meta?.name ?? null,
      id: dataSourceManager?.getCurrentDatasetId?.() ?? null,
      source: dataSourceManager?.getCurrentSourceType?.() ?? null,
      // What the dataset says of itself (the card's paragraph): the tissue, the
      // organism, the protocol a researcher reads first.
      description: typeof meta?.description === 'string' && meta.description.trim() !== '' ? meta.description : null,
      citation: citationText(meta?.citation),
      cells: {
        total: identity.nOriginal,
        open: identity.n,
        share: identity.nOriginal === 0 ? 0 : identity.n / identity.nOriginal,
        subsample: identity.isSubset ? (spec === null ? 'a subsample' : describeSubsampleMethod(spec)) : null,
        digest: identity.digest,
      },
      genes: {
        count: state.getVarAxisGeneCount?.() ?? 0,
        // The modalities of a MuData, as Data mapping › Modality lists them: an
        // agent that could not see them said "I have no tool that lists the
        // modalities" of a CITE-seq file (L18-9).
        ...modalitiesOf(),
        read_for: sample === null ? null : { cells: sample.cells, of: sample.of },
        values: expressionValues(),
      },
      embeddings,
      // Per-cell vectors the vector field overlay draws (RNA velocity, drift): an agent
      // told of no such field said a scVelo sample had no velocity.
      vector_fields: (state.getAvailableVectorFields?.() ?? []).map(field => field.label),
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
        label: categoryDisplayName(label),
        cells: counts.total[index],
        visible: counts.visible[index],
        color: categoryHex(field, index),
        shown: visible === undefined ? true : visible[index] === 1,
      })),
      missing: counts.missing.total,
    };
  }

  /**
   * Genes matching `query`, ranked as the search box ranks them; or, for
   * `names`, which of them are genes (exact, any case), in the order asked:
   * an agent checking a marker panel against a dataset of a few thousand
   * genes made one search per gene (28 calls in one turn).
   */
  function searchGenes({ query, names, limit }) {
    requireCells();
    if ((query === undefined) === (names === undefined)) {
      throw new ActionRefused('Give either a query to search for, or names to look up.');
    }
    const fields = (state.varData?.fields ?? []).filter(field => field && field._isDeleted !== true);
    if (names !== undefined) {
      const byLowered = new Map();
      for (const field of fields) {
        const lowered = field.key.toLowerCase();
        // An exact name first; another case only when no gene is named exactly so.
        if (!byLowered.has(lowered)) byLowered.set(lowered, []);
        byLowered.get(lowered).push(field.key);
      }
      const genes = [];
      const lacks = [];
      for (const name of names) {
        const candidates = byLowered.get(name.toLowerCase()) ?? [];
        const gene = candidates.includes(name) ? name : candidates[0];
        // A name given twice (an agent's panel of two lists) is answered once.
        if (gene === undefined) {
          if (!lacks.includes(name)) lacks.push(name);
        } else if (!genes.includes(gene)) genes.push(gene);
      }
      return { genes, matches: genes.length, total: fields.length, lacks };
    }
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
        values = openAt.map(i => (field.codes[i] === missing ? null : categoryDisplayName(field.categories[field.codes[i]])));
      } else {
        values = openAt.map(i => finiteOrNull(field.values[i]));
      }
      columns.push({ field: { source: resolved.source, key: field.key, kind: kindWord(field.kind) }, values });
    }
    // The genes' values as shown (Data mapping › Expression values).
    const genes = refs.some(ref => ref.source === 'var');
    return { cells: open, columns, not_open: notOpen, gene_values: genes ? geneValuesWords() : null };
  }

  /**
   * A field per category of `by`: only the categories named (`categories`),
   * else every category with cells. A category with none (no open cell, or
   * none the view shows) is left out unless named, and counted (`empty`): a
   * view filtered to one lineage of a hundred-type field gave a hundred empty
   * groups, the bulk of the answer, on every later call of the turn.
   */
  async function fieldSummary({ field: ref, by, top, visible_only: visibleOnly, categories: named, within }, { signal }) {
    requireCells();
    if (by.source !== 'obs') throw new ActionRefused('Cells are grouped by a categorical obs field.', { code: 'wrong-kind' });
    const kept = within === undefined ? null : await withinCells(within, signal);
    const groupsResolved = resolveField(state, by, { kind: FieldKind.CATEGORY });
    const groupsField = await loadedField(state, groupsResolved, signal);
    const resolved = resolveField(state, ref);
    const field = await loadedField(state, resolved, signal);
    const n = state.pointCount;
    const alpha = visibleOnly ? state.categoryTransparency : null;
    const groupCodes = groupsField.codes;
    const groupMissing = missingCategoryCode(groupCodes);
    const groupCount = groupsField.categories.length;
    const chosen = named === undefined ? null : new Set(named.map(label => resolveCategory(groupsField, label)));
    const members = Array.from({ length: groupCount }, () => []);
    for (let i = 0; i < n; i++) {
      const code = groupCodes[i];
      if (code === groupMissing || code >= groupCount) continue;
      if (alpha !== null && alpha[i] === 0) continue;
      if (kept !== null && kept.mask[i] === 0) continue;
      members[code].push(i);
    }
    const sample = resolved.source === 'var' ? (state.getGeneSample?.() ?? null) : null;
    // A gene's values as shown (Data mapping › Expression values): those
    // its field holds, the coloring's and the analyses'.
    const geneValues = resolved.source === 'var' && field.kind !== FieldKind.CATEGORY ? geneValuesWords() : null;
    const valueOf = i => field.values[i];
    // The groups summarized, in the field's order: those named, else those with cells.
    const listed = [];
    let empty = 0;
    for (let g = 0; g < groupCount; g++) {
      if (chosen !== null) {
        if (chosen.has(g)) listed.push(g);
      } else if (members[g].length > 0) listed.push(g);
      else empty++;
    }
    const groups = [];
    if (field.kind === FieldKind.CATEGORY) {
      const missing = missingCategoryCode(field.codes);
      for (const g of listed) {
        const tally = new Map();
        for (const i of members[g]) {
          const code = field.codes[i];
          if (code === missing) continue;
          tally.set(code, (tally.get(code) ?? 0) + 1);
        }
        const topCategories = [...tally].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, top)
          .map(([code, cells]) => ({ label: categoryDisplayName(field.categories[code]), cells }));
        groups.push({ label: categoryDisplayName(groupsField.categories[g]), cells: members[g].length, top: topCategories });
      }
    } else {
      for (const g of listed) {
        const values = [];
        for (const i of members[g]) {
          const value = valueOf(i);
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
      within: kept === null ? null : { field: kept.field, cells: kept.cells },
      read_for: sample === null ? null : { cells: sample.cells, of: sample.of },
      values: geneValues,
      groups,
      empty,
    };
  }

  /**
   * The open cells `within` keeps (`field.summary`): those of some categories
   * of a categorical field, or with a value of a continuous field or gene in
   * [min, max]; the view is left as it is.
   */
  async function withinCells({ field: ref, categories: named, min, max }, signal) {
    const resolved = resolveField(state, ref);
    const field = await loadedField(state, resolved, signal);
    const n = state.pointCount;
    const mask = new Uint8Array(n);
    if (field.kind === FieldKind.CATEGORY) {
      if (named === undefined || min !== undefined || max !== undefined) {
        throw new ActionRefused(`${quoteName(field.key)} is categorical: name its categories in within.categories (no min or max).`, { code: 'bad-params' });
      }
      const chosen = new Set(named.map(label => resolveCategory(field, label)));
      for (let i = 0; i < n; i++) if (chosen.has(field.codes[i])) mask[i] = 1;
    } else {
      if (named !== undefined || (min === undefined && max === undefined)) {
        throw new ActionRefused(`${quoteName(field.key)} holds numbers: give within.min, within.max or both (no categories).`, { code: 'bad-params' });
      }
      if (min !== undefined && max !== undefined && min > max) {
        throw new ActionRefused(`within.min (${min}) is above within.max (${max}).`, { code: 'bad-params' });
      }
      for (let i = 0; i < n; i++) {
        const value = field.values[i];
        if (Number.isFinite(value) && (min === undefined || value >= min) && (max === undefined || value <= max)) mask[i] = 1;
      }
    }
    let cells = 0;
    for (let i = 0; i < n; i++) cells += mask[i];
    return { mask, cells, field: field.key };
  }

  return { summary, listFields, categories, searchGenes, cellValues, fieldSummary };
}
