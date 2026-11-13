/**
 * @fileoverview The expression transform of the open dataset (Session › Data
 * mapping › Expression values, `data/expression-transform.js`): the one
 * setting coloring, legends, filters, highlights by value, the cell card,
 * the agents' reads and every analysis that reads genes follow.
 *
 * - **What is asked** (`getExpressionTransform`): the `expression` state
 *   domain's value, `{normalize, log1p}`, off for a dataset just opened.
 * - **What is shown** (`getShownExpressionTransform`): what asked is to the
 *   mapped matrix — the transform when it holds counts and no `log1p` of its
 *   own, else its values as stored (`expressionTransformOffer` says why).
 * - **The gene loader** of the mapped matrix (`varFieldLoader`) is the
 *   matrix's own loader wrapped by the transform shown (`shownVarLoader`):
 *   a gene loaded (and its partial answers while its index is built), and
 *   its rows read for cells added (`readRows`), come transformed, so every
 *   loaded gene's values — what coloring, filters and reads take — are in
 *   it. Everything an analysis reads passes through raw (`readSparseColumn`,
 *   `readCellSubset`, the gene routes, the gene sample, `readPlan`,
 *   `log1p`, `highlyVariableGenes`): an analysis transforms what it reads
 *   by the run's values (`app/analysis/data/data-layer.js` `runValues`).
 *   The values as stored install the matrix's loader itself.
 * - **Cells' totals** (`data/library-sizes.js`) are kept with a lineage, one
 *   per matrix (modality and matrix) of the dataset open: the open cells
 *   grown or cut in place keep them (`resized`), a matrix mapped again finds
 *   its own again, and a new dataset or the open cells put in another order
 *   drop them all (`resetCellTotals`).
 * - **Summing them is heavy work, asked for by what needs it.** Every change
 *   that needs totals not kept yet (normalizing, `setExpressionTransform`; a
 *   mapping onto another counts matrix while normalized, `mapping-groups.js`
 *   `genes`; genes read for more cells, `prepareCellTotals`; a restore of
 *   any of these) reads them before anything shown changes, through
 *   `cellTotalsForChange`: priced first (`cellTotalsCostOf`, the link as
 *   measured) and asked as heavy work by the action's `heavy` (an agent's
 *   heavy-work permission, `actions/dispatcher.js` `ctx.heavy`); the person
 *   sees the same price before they act (Data mapping's lines). A gene read
 *   later finds them kept, so no read outside such a change sums the matrix.
 * - **A change** (`setExpressionTransform`) reads the cells' totals first
 *   when it normalizes (the heavy part, with its signal), then replaces the
 *   gene list with the same one under the new loader
 *   (`stageVarAxisReplacement`, `unitsChanged`): a view colored by a gene
 *   keeps it and reads it again; a color range or filter of it is dropped,
 *   being in the other units. `expression:changed` is emitted after.
 *
 * @module state/managers/expression-values
 */

import {
  RAW_VALUES, requireExpressionTransform, effectiveTransform, isRawValues, transformKey,
  transformColumn, transformRows, transformValue, cellFactors, valuesRecord,
} from '../../../data/expression-transform.js';
import { cellLibrarySizes, keptLibrarySizes, rowLibrarySizes } from '../../../data/library-sizes.js';
import { expressionMatrixName } from '../../../data/data-mapping.js';
import { columnFormOf, isColumnForm, noteColumnForm } from '../../../data/column-forms.js';
import { librarySizeFields } from '../../utils/field-roles.js';
import { formatCountOf } from '../../../utils/format-units.js';
import { PLACES, placePath } from '../../ui/place-names.js';

const SHOWN = Symbol('expression transform shown by a gene loader');

/**
 * The cells' totals pass as a progress line says it while it runs:
 * a load that finds it (a session file, a saved state, a replay) names it
 * on its own line, with its Cancel (`session-serializer.js`).
 */
export const CELL_TOTALS_DOING = 'Summing each cell\'s counts for normalized values…';

/** The key of a matrix's lineage of cells' totals: its modality and its name. */
function matrixKey(mapping) {
  return JSON.stringify([mapping?.modality ?? null, mapping?.expression ?? null]);
}

/**
 * What a gene loader shows: `{base, transform, lineage}` for one the
 * transform wraps, null for a matrix's own loader (its values as stored).
 *
 * @param {Function|null} loader
 * @returns {{base: Function, transform: import('../../../data/expression-transform.js').ExpressionTransform, lineage: Object}|null}
 */
export function shownLoaderParts(loader) {
  return loader?.[SHOWN] ?? null;
}

/** The matrix's own loader under a shown one (itself when not wrapped). */
export function baseVarLoader(loader) {
  return shownLoaderParts(loader)?.base ?? loader;
}

/** The transform a gene loader shows (the values as stored when not wrapped). */
export function shownTransformOf(loader) {
  return shownLoaderParts(loader)?.transform ?? RAW_VALUES;
}

/**
 * A column's values transformed, in the form it came in: a column form
 * (`data/column-forms.js`, a partial answer) as a form, a dense column as a
 * dense column with its form transformed beside it (so coloring still reads
 * the form, and only the form's entries are transformed).
 */
function shownColumn(column, factors, log1p) {
  if (isColumnForm(column)) return { ...column, values: transformColumn(column, factors, log1p).values };
  const form = columnFormOf(column);
  if (form === null) return transformColumn(column, factors, log1p);
  const out = new Float32Array(column.length);
  out.fill(NaN, form.readRows);
  const values = new Float32Array(form.values.length);
  for (let k = 0; k < values.length; k++) {
    const cell = form.indices[k];
    values[k] = transformValue(form.values[k], factors === null ? null : factors[cell], log1p);
    out[cell] = values[k];
  }
  noteColumnForm(out, { ...form, values });
  return out;
}

/** Rows of a gene transformed, their form beside them as `shownColumn`. */
function shownRows(rows, factors, log1p) {
  const out = transformRows(rows, 0, factors, log1p);
  const form = columnFormOf(rows);
  if (form !== null) {
    noteColumnForm(out, { ...form, values: Float32Array.from(form.indices, cell => out[cell]) });
  }
  return out;
}

export class DataStateExpressionMethods {
  /**
   * The expression transform asked (the `expression` state domain).
   * @this {import('../core/data-state.js').DataState}
   * @returns {import('../../../data/expression-transform.js').ExpressionTransform}
   */
  getExpressionTransform() {
    return this._expressionTransform ?? RAW_VALUES;
  }

  /**
   * The transform the mapped matrix's values are shown in now: what is
   * asked, when the matrix takes it, else the values as stored.
   * @this {import('../core/data-state.js').DataState}
   */
  getShownExpressionTransform() {
    return shownTransformOf(this.varFieldLoader);
  }

  /**
   * Whether the expression transform applies to the matrix `mapping` maps
   * (the current one by default), and why not: no matrix, a matrix whose
   * values are `log1p` already (Data mapping › Genes › Values), or one that
   * does not hold counts.
   *
   * @this {import('../core/data-state.js').DataState}
   * @param {Object|null} [mapping]
   * @returns {{offered: boolean, reason: string|null}}
   */
  expressionTransformOffer(mapping = this.dataMapping) {
    const expression = mapping?.expression ?? null;
    if (expression === null) return { offered: false, reason: 'This dataset has no expression matrix.' };
    const name = expressionMatrixName(expression);
    if (mapping.log1p?.[expression] !== undefined) {
      return { offered: false, reason: `${name} holds log1p values already (${placePath(PLACES.dataMapping)} › Genes › Values).` };
    }
    if (this.mappingMatrixHoldsCounts?.(mapping) !== true) {
      return { offered: false, reason: `${name} does not hold counts: its values are shown as stored.` };
    }
    return { offered: true, reason: null };
  }

  /**
   * The transform the matrix `mapping` maps is shown in: `asked` (the one
   * asked now by default) when the matrix takes it.
   *
   * @this {import('../core/data-state.js').DataState}
   * @param {Object|null} mapping
   * @param {import('../../../data/expression-transform.js').ExpressionTransform} [asked]
   */
  shownTransformFor(mapping, asked = this.getExpressionTransform()) {
    return effectiveTransform(asked, this.expressionTransformOffer(mapping).offered);
  }

  /**
   * The obs field the file names as the mapped matrix's cells' totals
   * (`uns['cellucid']['totalCounts']`, for the mapped modality), or null.
   *
   * @this {import('../core/data-state.js').DataState}
   * @returns {{field: string, over: 'all genes'|'source panel'|'stored genes'}|null}
   */
  storedCellTotals() {
    return this._storedTotalsOf(baseVarLoader(this.varFieldLoader), this.dataMapping?.modality ?? null);
  }

  /**
   * The obs field a matrix's own loader names as its cells' totals for `modality`, or null.
   * @this {import('../core/data-state.js').DataState}
   * @private
   */
  _storedTotalsOf(base, modality) {
    const records = base?.storedTotals?.() ?? null;
    if (records === null) return null;
    return records.get(modality ?? null) ?? null;
  }

  /**
   * Where the mapped matrix's cells' totals would come from, before they
   * are read (the section's source line, `dataset.summary`): the obs field
   * the file names, else one named like a total, else every gene summed.
   *
   * @this {import('../core/data-state.js').DataState}
   * @returns {{field: string|null, over: 'all genes'|'source panel'|'stored genes'|null, genes: number}}
   */
  cellTotalsPlan() {
    const loader = this.varFieldLoader ?? null;
    if (loader === null) return { field: null, over: null, genes: 0 };
    return this._cellTotalsPlanOf(baseVarLoader(loader), this._shownLineage(), this.dataMapping?.modality ?? null);
  }

  /**
   * `cellTotalsPlan` of a matrix: its own loader, its lineage, its modality.
   * @this {import('../core/data-state.js').DataState}
   * @private
   */
  _cellTotalsPlanOf(base, lineage, modality) {
    const sizes = keptLibrarySizes(lineage);
    if (sizes !== null) return { field: sizes.field, over: sizes.over, genes: sizes.genes };
    const obs = this._continuousObsKeys();
    const stored = this._storedTotalsOf(base, modality);
    if (stored !== null && obs.has(stored.field)) return { field: stored.field, over: stored.over, genes: 0 };
    const named = librarySizeFields([...obs.keys()].map(key => ({ key })))[0] ?? null;
    if (named !== null) return { field: named, over: null, genes: 0 };
    return { field: null, over: null, genes: lineage.genes.length };
  }

  /**
   * What a result keeps of the mapped matrix's values as shown
   * (`valuesRecord`): the transform and where the cells' totals came from;
   * null for the values as stored.
   *
   * @this {import('../core/data-state.js').DataState}
   * @returns {{normalize: boolean, log1p: boolean, totals: string|null}|null}
   */
  shownValuesRecord() {
    const shown = this.getShownExpressionTransform();
    if (isRawValues(shown)) return null;
    const sizes = shown.normalize ? keptLibrarySizes(shownLoaderParts(this.varFieldLoader).lineage) : null;
    return valuesRecord(shown, sizes ?? { source: 'the cells\' totals (not read yet)' });
  }

  /**
   * The continuous obs fields by the key the file gives them, to their position.
   * @this {import('../core/data-state.js').DataState}
   * @private
   */
  _continuousObsKeys() {
    const keys = new Map();
    (this.obsData?.fields ?? []).forEach((field, index) => {
      if (field?.kind === 'continuous' && field._isUserDefined !== true) keys.set(field._originalKey ?? field.key, index);
    });
    return keys;
  }

  /**
   * A lineage of cells' totals: the gene list (descriptors) of a matrix and
   * its name, the holder `data/library-sizes.js` keeps the totals with.
   * @this {import('../core/data-state.js').DataState}
   * @private
   */
  _cellTotalsLineage(genes, mapping) {
    return Object.freeze({
      genes: Object.freeze(genes.filter(field => field?._isUserDefined !== true)),
      matrixLabel: expressionMatrixName(mapping?.expression ?? 'X'),
      modality: mapping?.modality ?? null,
    });
  }

  /**
   * The lineage of cells' totals of the matrix `mapping` maps, in the
   * dataset open: one per matrix (its modality and name), so the totals of
   * a matrix mapped again, or shown as stored and then normalized, are read
   * once. `genes`: its gene list's descriptors, for a lineage made now.
   * @this {import('../core/data-state.js').DataState}
   */
  matrixLineage(mapping, genes) {
    this._cellTotalLineages ??= new Map();
    const key = matrixKey(mapping);
    let lineage = this._cellTotalLineages.get(key);
    if (lineage === undefined) {
      lineage = this._cellTotalsLineage(genes, mapping);
      this._cellTotalLineages.set(key, lineage);
    }
    return lineage;
  }

  /**
   * Drop every matrix's cells' totals: another dataset published, or the
   * open cells put in another order (totals by position no longer apply).
   * @this {import('../core/data-state.js').DataState}
   */
  resetCellTotals() {
    this._cellTotalLineages = new Map();
  }

  /**
   * The cells' totals of a lineage read through `base`, for open cells
   * `[0, readTo)` (`data/library-sizes.js` `cellLibrarySizes`).
   * @this {import('../core/data-state.js').DataState}
   * @private
   */
  _lineageLibrarySizes(base, lineage, { readTo, signal = null, owner = null }) {
    const obs = this._continuousObsKeys();
    const schedule = (start, readSignal) => this.scheduleLoaderRead({ priority: 'bulk', signal: readSignal, start });
    return cellLibrarySizes({
      holder: lineage,
      pointCount: this.pointCount,
      readTo,
      matrixLabel: lineage.matrixLabel,
      stored: this._storedTotalsOf(base, lineage.modality),
      candidates: librarySizeFields([...obs.keys()].map(key => ({ key }))),
      readObs: async (key, readSignal) => {
        const index = obs.get(key);
        if (index === undefined) return null;
        return (await this.ensureFieldLoaded(index, { silent: true, signal: readSignal }))?.values ?? null;
      },
      geneCount: lineage.genes.length,
      readGene: (gene, readSignal) => schedule(downloadSignal => base.readSparseColumn(lineage.genes[gene], { signal: downloadSignal, owner }), readSignal),
      readGenesInCells: typeof base.readCellSubset === 'function'
        ? (genes, cells, readSignal) => schedule(downloadSignal => base.readCellSubset(genes.map(gene => lineage.genes[gene]), cells, { signal: downloadSignal, owner }), readSignal)
        : null,
      signal,
    });
  }

  /**
   * The open cells genes of the mapped matrix are read for: `[0, readTo)` (of `open` cells, the open ones by default).
   * @this {import('../core/data-state.js').DataState}
   * @private
   */
  _geneReadTo(open = this.pointCount) {
    return Math.min(open, this.getGeneSample?.()?.cells ?? open);
  }

  /**
   * Each open cell's library size of the mapped matrix, for open cells
   * `[0, readTo)` (the cells genes are read for by default): what a run
   * normalizing its genes divides by. Kept with the matrix's lineage, so
   * the shown values and every run share one pass.
   *
   * @this {import('../core/data-state.js').DataState}
   * @param {{readTo?: number, signal?: AbortSignal|null, owner?: string|null}} [options]
   * @returns {Promise<import('../../../data/library-sizes.js').LibrarySizes>}
   */
  mappedLibrarySizes({ readTo = this._geneReadTo(), signal = null, owner = null } = {}) {
    const loader = this.varFieldLoader ?? null;
    if (loader === null) throw new Error('This dataset has no expression matrix to take the cells\' totals of');
    return this._lineageLibrarySizes(baseVarLoader(loader), this._shownLineage(), { readTo, signal, owner });
  }

  /**
   * The lineage of the mapped matrix: the shown loader's, else the matrix's
   * own (values shown as stored: a run normalizing its genes, or turning
   * normalization on later, shares its pass).
   * @this {import('../core/data-state.js').DataState}
   * @private
   */
  _shownLineage() {
    return shownLoaderParts(this.varFieldLoader)?.lineage ?? this.matrixLineage(this.dataMapping, this._varFieldDescriptors ?? []);
  }

  /**
   * The gene loader that shows `transform` over a matrix's own loader
   * `base` (`base` itself for the values as stored). `lineage`: the cells'
   * totals it shares (a resized loader's is its predecessor's); a new one of
   * `genes` (the gene list's descriptors) when null.
   *
   * @this {import('../core/data-state.js').DataState}
   * @param {Function|null} base
   * @param {import('../../../data/expression-transform.js').ExpressionTransform} transform
   * @param {{lineage: Object}} options - The cells' totals it shares (`matrixLineage`)
   * @returns {Function|null}
   */
  shownVarLoader(base, transform, { lineage }) {
    if (base === null) return null;
    if (shownLoaderParts(base) !== null) throw new TypeError('A gene loader is wrapped once, over the matrix\'s own loader.');
    if (isRawValues(transform)) return base;
    if (lineage === null || typeof lineage !== 'object' || !Array.isArray(lineage.genes)) {
      throw new TypeError('A gene loader that shows a transform shares a matrix\'s lineage of cells\' totals.');
    }
    const own = lineage;
    const { normalize, log1p } = transform;
    const state = this;
    // The cells' totals for `[0, readTo)`, and for rows past them.
    const totals = (readTo, signal) => state._lineageLibrarySizes(base, own, { readTo, signal });
    const factorsOfRows = async (from, to, signal) => {
      let sizes = keptLibrarySizes(own);
      // Rows that start or follow on from the totals kept: the totals taken
      // up to them, one pass however many genes ask for the same rows at once
      // (a growth fills every loaded gene's rows together; `cellLibrarySizes`
      // shares a pass by the cells it reaches).
      if (sizes === null || (from <= sizes.readTo && to > sizes.readTo)) sizes = await totals(to, signal);
      if (to <= sizes.readTo && to <= sizes.factors.length) return sizes.factors.subarray(from, to);
      const scheduleRead = (start, readSignal) => state.scheduleLoaderRead({ priority: 'bulk', signal: readSignal, start });
      const rows = await rowLibrarySizes({
        holder: own,
        sizes,
        from,
        to,
        readObsRows: async (field, rowFrom, rowTo, readSignal) => {
          const index = state._continuousObsKeys().get(field);
          const descriptor = index === undefined ? null : (state._obsFieldDescriptors?.[index] ?? state.obsData.fields[index]);
          if (descriptor === null) throw new Error(`obs['${field}'] is no longer a field of this dataset`);
          return (await state.fieldLoader.readRows(descriptor, [rowFrom, rowTo], { signal: readSignal })).values;
        },
        geneCount: own.genes.length,
        readGenesInCells: (genes, cells, readSignal) => scheduleRead(
          downloadSignal => base.readCellSubset(genes.map(gene => own.genes[gene]), cells, { signal: downloadSignal }), readSignal
        ),
        matrixLabel: own.matrixLabel,
        signal,
      });
      return cellFactors(rows);
    };
    const shown = async (field, options = {}) => {
      const signal = options.signal ?? null;
      let sizes = normalize ? await totals(state._geneReadTo(), signal) : null;
      const asked = options.onPartial ?? null;
      const onPartial = asked === null ? null : (column, cells) => asked(shownColumn(column, sizes?.factors ?? null, log1p), cells);
      const loaded = await base(field, { ...options, onPartial });
      if (loaded === null || typeof loaded !== 'object' || !ArrayBuffer.isView(loaded.values)) return loaded;
      // A gene read for more cells than the totals were taken for (the
      // cells genes are read for grew meanwhile): their totals first.
      const readTo = loaded.geneSample?.cells ?? loaded.values.length;
      if (normalize && sizes.readTo < readTo) sizes = await totals(readTo, signal);
      return { ...loaded, values: shownColumn(loaded.values, sizes?.factors ?? null, log1p) };
    };
    for (const key of Object.keys(base)) shown[key] = base[key];
    shown.readRows = async (field, rows, options = {}) => {
      const values = await base.readRows(field, rows, options);
      const factors = normalize ? await factorsOfRows(rows[0], rows[1], options.signal ?? null) : null;
      return shownRows(values, factors, log1p);
    };
    // The open cells grown or cut in place keep their positions: the same
    // totals, the cells added totaled on their own.
    shown.resized = n => state.shownVarLoader(base.resized(n), transform, { lineage: own });
    shown[SHOWN] = Object.freeze({ base, transform, lineage: own });
    return shown;
  }

  /**
   * The gene loader of the current one put back over new totals (the open
   * cells put in another order: totals by position no longer apply).
   * @this {import('../core/data-state.js').DataState}
   */
  renewShownVarLoader() {
    const parts = shownLoaderParts(this.varFieldLoader);
    this.resetCellTotals();
    if (parts === null) return;
    this.setVarFieldLoader(this.shownVarLoader(parts.base, parts.transform, {
      lineage: this.matrixLineage(this.dataMapping, parts.lineage.genes),
    }));
  }

  /**
   * What reading the cells' totals of a matrix for open cells `[0, readTo)`
   * would read now: null when nothing (an obs column of totals, or totals
   * kept that reach `readTo`); else `{ms, bytes, genes, cells, what}`, each
   * of `ms`/`bytes` null when not known, priced at the link as measured now
   * (the gene's read plan): the whole pass over every gene, or, totals kept
   * for fewer cells, every gene in the cells past them (`added`: cells not
   * open yet, priced the same way, the open cells grown). A share of cells is
   * priced as that share of the pass.
   *
   * @this {import('../core/data-state.js').DataState}
   * @param {{base: Function, lineage: Object, readTo?: number, added?: number}} matrix
   * @returns {Promise<{ms: number|null, bytes: number|null, genes: number, cells: number, what: string}|null>}
   */
  async cellTotalsCostOf({ base, lineage, readTo = this._geneReadTo(), added = 0 }) {
    const kept = keptLibrarySizes(lineage);
    const plan = this._cellTotalsPlanOf(base, lineage, lineage.modality);
    // From an obs column (kept or not): its rows, no gene read.
    if (plan.field !== null) return null;
    const known = kept === null ? 0 : Math.min(kept.readTo, readTo);
    const cells = Math.max(0, readTo - known) + Math.max(0, added);
    if (cells === 0) return null;
    const genes = lineage.genes.length;
    const descriptor = lineage.genes[0] ?? null;
    let readPlan = null;
    try {
      readPlan = descriptor === null ? null : (await base.readPlan?.(descriptor)) ?? null;
    } catch {
      readPlan = null;
    }
    // A matrix stored cell by cell reads itself once (its index), then every
    // gene from it; one stored gene by gene reads each gene's entries. Fewer
    // cells than the open ones read that share of it.
    const stored = readPlan?.scan != null
      ? (readPlan.scan.fetchBytes ?? readPlan.scan.storedBytes ?? null)
      : Number.isFinite(readPlan?.entries) ? readPlan.entries * 8 : null;
    const whole = known === 0 && added === 0;
    const share = whole ? 1 : cells / Math.max(1, this.pointCount);
    const bytes = stored === null ? null : Math.round(stored * share);
    const ms = bytes !== null && readPlan?.bytesPerSecond > 0 ? (bytes * 1000) / readPlan.bytesPerSecond : null;
    const what = whole
      ? `Sums all ${formatCountOf(genes, 'gene')} of ${lineage.matrixLabel} once for each cell's total (normalized values)`
      : known === 0
        ? `Sums all ${formatCountOf(genes, 'gene')} of ${lineage.matrixLabel} in ${formatCountOf(cells, 'cell')} for their totals (normalized values)`
        : `Sums all ${formatCountOf(genes, 'gene')} of ${lineage.matrixLabel} in ${formatCountOf(cells, 'cell')} more for their totals (normalized values)`;
    return { ms, bytes, genes, cells, what, doing: CELL_TOTALS_DOING };
  }

  /**
   * What changing the expression transform to `next` would read
   * (`cellTotalsCostOf` of the mapped matrix): null when it reads nothing
   * more (no normalization, an obs column of totals, totals already kept).
   *
   * @this {import('../core/data-state.js').DataState}
   * @param {{normalize: boolean, log1p: boolean}} next
   * @returns {Promise<{ms: number|null, bytes: number|null, genes: number, cells: number, what: string}|null>}
   */
  async expressionTransformCost(next) {
    const shown = effectiveTransform(requireExpressionTransform(next), this.expressionTransformOffer().offered);
    const loader = this.varFieldLoader ?? null;
    if (!shown.normalize || loader === null) return null;
    return this.cellTotalsCostOf({ base: baseVarLoader(loader), lineage: this._shownLineage() });
  }

  /**
   * What applying the data mapping `mapping` would read for the cells'
   * totals: null unless the expression values it shows are normalized and
   * its matrix's totals are to be summed (another matrix than now, or the
   * same one now taking the transform). Reads the other matrix's gene list
   * to price it (`mappingVarLoaderOf`).
   *
   * @this {import('../core/data-state.js').DataState}
   * @param {Object} mapping
   * @returns {Promise<{ms: number|null, bytes: number|null, genes: number, cells: number, what: string}|null>}
   */
  async mappingTotalsCost(mapping) {
    if (mapping?.expression == null || !this.shownTransformFor(mapping).normalize) return null;
    const sameMatrix = matrixKey(mapping) === matrixKey(this.dataMapping) && this.varFieldLoader != null;
    if (sameMatrix) return this.cellTotalsCostOf({ base: baseVarLoader(this.varFieldLoader), lineage: this._shownLineage() });
    const known = this._cellTotalLineages?.get(matrixKey(mapping)) ?? null;
    const { geneList, varFieldLoader } = await this.mappingVarLoaderOf(mapping);
    // A lineage made here for pricing only is not kept: the change makes its own.
    const lineage = known ?? this._cellTotalsLineage(geneList.fields, mapping);
    return this.cellTotalsCostOf({ base: varFieldLoader, lineage });
  }

  /**
   * The cells' totals a change needs, read now, before anything shown
   * changes: priced first and asked for as heavy work by `heavy` (the
   * action's `ctx.heavy`; null: the person acting, who saw the price), then
   * read (`signal` stops it). Every change that needs totals not kept yet
   * reads them here.
   *
   * @this {import('../core/data-state.js').DataState}
   * @param {{base: Function, lineage: Object, readTo?: number, signal?: AbortSignal|null,
   *   heavy?: ((estimate: Object) => Promise<void>)|null}} change
   * @returns {Promise<import('../../../data/library-sizes.js').LibrarySizes>}
   */
  async cellTotalsForChange({ base, lineage, readTo = this._geneReadTo(), signal = null, heavy = null }) {
    if (heavy !== null) {
      const cost = await this.cellTotalsCostOf({ base, lineage, readTo });
      if (cost !== null) await heavy({ ms: cost.ms, bytes: cost.bytes, what: cost.what, doing: cost.doing });
    }
    return this._lineageLibrarySizes(base, lineage, { readTo, signal });
  }

  /**
   * What the cells' totals of the values shown would read for genes read
   * for open cells `[0, readTo)` (the gene sample grown: `gene-sample.js`
   * `geneSampleCost` adds it), or for `cells` cells read again
   * (`reread`: `cells.open`, whose new reading sums them anew, or, grown in
   * place, for the cells added); null when the values shown are not
   * normalized or their totals come from an obs column.
   *
   * @this {import('../core/data-state.js').DataState}
   * @param {{readTo?: number, reread?: number|null}} [options]
   */
  async shownCellTotalsCost({ readTo = this._geneReadTo(), reread = null } = {}) {
    const parts = shownLoaderParts(this.varFieldLoader);
    if (parts === null || !parts.transform.normalize) return null;
    if (reread === null) return this.cellTotalsCostOf({ base: parts.base, lineage: parts.lineage, readTo });
    // A new reading drops every kept total: a lineage of its own, none kept.
    const fresh = this._cellTotalsLineage(parts.lineage.genes, this.dataMapping);
    return this.cellTotalsCostOf({ base: parts.base, lineage: fresh, readTo: 0, added: this._geneReadTo(reread) });
  }

  /**
   * The cells' totals the values shown need for the open cells genes are
   * read for (`readTo`, by default the gene sample's), read now when they
   * are summed over the matrix and do not reach them yet (genes read for
   * more cells, the open cells grown): what the change that adds the cells
   * reads, asked for by its `heavy`, so no later read sums the matrix.
   * Nothing when the values shown are not normalized.
   *
   * @this {import('../core/data-state.js').DataState}
   * @param {{readTo?: number, signal?: AbortSignal|null, heavy?: ((estimate: Object) => Promise<void>)|null}} [options]
   */
  async prepareCellTotals({ readTo = this._geneReadTo(), signal = null, heavy = null } = {}) {
    const parts = shownLoaderParts(this.varFieldLoader);
    if (parts === null || !parts.transform.normalize) return;
    const kept = keptLibrarySizes(parts.lineage);
    if (kept !== null && kept.readTo >= readTo) return;
    await this.cellTotalsForChange({ base: parts.base, lineage: parts.lineage, readTo, signal, heavy });
  }

  /**
   * Change the expression transform. Normalizing reads the cells' totals
   * first (an obs total, else every gene once); then the mapped matrix's
   * genes are shown in the new values: a view colored by a gene keeps it,
   * read again, its color range and filter dropped (they were in the other
   * units). Asked of a matrix that does not take it, the transform is kept
   * as asked and its values stay as stored (`offered` false), unless
   * `requireOffered`, which refuses. `heavy`: asks for the totals' pass as
   * heavy work (`cellTotalsForChange`).
   *
   * @this {import('../core/data-state.js').DataState}
   * @param {{normalize: boolean, log1p: boolean}} next
   * @param {{signal?: AbortSignal|null, requireOffered?: boolean, heavy?: ((estimate: Object) => Promise<void>)|null}} [options]
   * @returns {Promise<{changed: boolean, shown: Object, dropped: string[]}>}
   */
  async setExpressionTransform(next, { signal = null, requireOffered = false, heavy = null } = {}) {
    const asked = requireExpressionTransform(next);
    await this.whenGenesListed?.();
    const offer = this.expressionTransformOffer();
    if (requireOffered && !isRawValues(asked) && !offer.offered) throw new RangeError(offer.reason);
    const shown = effectiveTransform(asked, offer.offered);
    const before = this.getShownExpressionTransform();
    const sameAsked = transformKey(asked) === transformKey(this.getExpressionTransform());
    if (transformKey(shown) === transformKey(before)) {
      this._expressionTransform = asked;
      if (!sameAsked) this.emit('expression:changed', { asked, shown, dropped: [] });
      return { changed: !sameAsked, shown, dropped: [] };
    }
    const current = this.varFieldLoader ?? null;
    if (current === null || this._varGeneList == null) {
      this._expressionTransform = asked;
      this.emit('expression:changed', { asked, shown, dropped: [] });
      return { changed: true, shown, dropped: [] };
    }
    const base = baseVarLoader(current);
    const lineage = this._shownLineage();
    // The heavy part first, asked for and cancellable, before anything shown changes.
    if (shown.normalize) await this.cellTotalsForChange({ base, lineage, signal, heavy });
    const step = await this.stageVarAxisReplacement({
      geneList: this._varGeneList,
      varFieldLoader: base,
      sameAxis: true,
      sameMatrix: false,
      transform: shown,
      lineage,
      unitsChanged: true,
    });
    step.commit();
    this._expressionTransform = asked;
    this.emit('expression:changed', { asked, shown, dropped: step.dropped });
    return { changed: true, shown, dropped: step.dropped };
  }
}
