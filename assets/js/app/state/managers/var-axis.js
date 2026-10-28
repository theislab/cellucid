/**
 * @fileoverview Replacing the var axis of a loaded dataset: the gene list a
 * data mapping names (`geneNames`, `expression`; `mapping-groups.js`).
 *
 * The obs axis, highlights, selections, obs filters and colours belong to
 * cells and are untouched. Per view, only what is tied to genes changes:
 * - a view coloured by a gene keeps that gene, with its colour range, log
 *   scale and filter. On the same var axis (other gene names, or `X` and a
 *   layer) a gene is the same column, so it is found by position and keeps
 *   its place whatever it is now called; on another axis (to or from `raw`)
 *   it is found by name. Its values are read before anything changes (from
 *   the new matrix, or carried over when the matrix is the same);
 * - a view whose gene is not on the new list loses that colouring (and so
 *   that gene's filter, which applies only to the gene a view is coloured
 *   by), and the gene is reported as dropped;
 * - every other gene is unloaded: the new list loads on demand.
 *
 * `varAxisGeneration` counts replacements; anything computed from gene values
 * belongs to the generation it was computed in.
 *
 * A dataset is published before its gene list (`beginGeneListing`): the first
 * view never waits for gene names. Its gene list is pending until
 * `listPublishedGenes` -- run right after the first view -- has guessed the
 * shown axis's gene names (`BaseAnnDataAdapter.guessGeneNames`), read the
 * list and installed it, with the mapping's `geneNames` (null until then)
 * and the catalog's gene-name default. Everything that lists or names genes
 * shows that they are loading (`areGenesPending`) and updates on
 * `genes:listed`; everything that needs them (a session, an export, a
 * mapping change, a matrix opened for an analysis) waits
 * (`whenGenesListed`). Nothing uses the var index in place of the pending
 * names.
 *
 * @module state/managers/var-axis
 */

import { getFieldRegistry } from '../../utils/field-registry.js';
import { loadGeneList, loadMappingCandidates } from '../../../data/data-loaders.js';
import { MAPPING_CANDIDATES_ROUTE } from '../../../data/dataset-mapping.js';
import { cellsSteady, trackCellWork } from '../../../data/open-cells-work.js';
import { createDatasetFieldLoadSupersededError } from './field/loading.js';
import { formatCountOf } from '../../../utils/format-units.js';

/** The per-gene state a person chose, carried over by name. */
const GENE_INTENT_KEYS = Object.freeze([
  '_continuousFilter',
  '_filterEnabled',
  '_continuousColorRange',
  '_useFilterColorRange',
  '_useLogScale',
]);

/** The finite min and max of one gene's values, or null when it has none. */
function valueRange(values) {
  let min = Infinity;
  let max = -Infinity;
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return min <= max ? { min, max } : null;
}

/**
 * Carry a person's choices for one gene to its field on the new list. A
 * filter or colour range is a threshold on values, so it is kept where it
 * still lies within the new values' range and clamped into it otherwise; a
 * range left empty by the clamp is dropped.
 */
function copyIntent(from, to) {
  const range = to.values instanceof Float32Array ? valueRange(to.values) : null;
  for (const key of GENE_INTENT_KEYS) {
    if (from[key] === undefined) continue;
    const value = from[key];
    if (key === '_continuousFilter' || key === '_continuousColorRange') {
      if (range === null) continue;
      const min = Math.max(value.min, range.min);
      const max = Math.min(value.max, range.max);
      if (min <= max) to[key] = { min, max };
      continue;
    }
    to[key] = value !== null && typeof value === 'object' ? { ...value } : value;
  }
}

function requireLoader(loader) {
  if (typeof loader !== 'function') {
    throw new TypeError('A var axis requires its field loader.');
  }
  return loader;
}

export class DataStateVarAxisMethods {
  /**
   * Begin the gene list of a dataset just published (`hasGenes`), or say a
   * published dataset (or none) has no gene list to wait for. Called where
   * the dataset is published, with an empty var inventory: a listing of an
   * earlier dataset still under way is superseded (its waiters reject), and
   * the new one is pending until `listPublishedGenes` installs it.
   *
   * @param {boolean} hasGenes
   */
  beginGeneListing(hasGenes) {
    const previous = this._geneListing ?? null;
    if (previous !== null && previous.state === 'pending') {
      previous.state = 'superseded';
      previous.reject(createDatasetFieldLoadSupersededError());
    }
    if (hasGenes !== true) {
      this._geneListing = null;
      return;
    }
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // A failure is reported where it happens; waiting is optional.
    promise.catch(() => {});
    this._geneListing = { promise, resolve, reject, state: 'pending', failure: null, started: false };
  }

  /**
   * Whether the published dataset's gene names are still being read: its
   * gene list is empty until they are (`listPublishedGenes`).
   * @returns {boolean}
   */
  areGenesPending() {
    return this._geneListing?.state === 'pending';
  }

  /**
   * Why the published dataset's gene list could not be read, or null.
   * @returns {Error|null}
   */
  getGeneListFailure() {
    return this._geneListing?.failure ?? null;
  }

  /**
   * Resolves once the published dataset's gene list is installed (at once
   * when it is, or when the dataset has none); rejects with its failure, or
   * when the dataset is replaced first.
   * @returns {Promise<void>}
   */
  whenGenesListed() {
    const listing = this._geneListing ?? null;
    if (listing === null || listing.state === 'listed') return Promise.resolve();
    return listing.promise;
  }

  /**
   * Read and install the gene list of the published dataset, once: its shown
   * axis's gene names are guessed (`BaseAnnDataAdapter.guessGeneNames`,
   * through the gene list route itself), the list read and checked against
   * the gene count the identity published, and then the list, the mapping's
   * gene names and the catalog's default are installed together, and
   * `mapping:changed` (`cause: 'genes-listed'`) and `genes:listed` are
   * emitted (`genes:listed` with `{failure}` when it fails). It is work on the open cells
   * (`data/open-cells-work.js`): a change of the open cells waits for it,
   * and it waits for one under way. Resolves when installed (or superseded
   * by another dataset); rejects with the failure, which stays readable
   * (`getGeneListFailure`).
   *
   * @returns {Promise<void>}
   */
  async listPublishedGenes() {
    const listing = this._geneListing ?? null;
    if (listing === null || listing.state !== 'pending' || listing.started) return this.whenGenesListed();
    listing.started = true;
    const current = () => this._geneListing === listing && listing.state === 'pending';
    const steady = cellsSteady();
    if (steady !== null) await steady;
    if (!current()) return undefined;
    const runtime = this._requireMappingRuntime();
    const expected = this.describeMappingVarCount({ ...this.dataMapping });
    const work = (async () => {
      const base = runtime.getBaseUrl();
      const geneList = await loadGeneList(`${base}var`, {});
      const candidates = await loadMappingCandidates(`${base}${MAPPING_CANDIDATES_ROUTE}`, {});
      return { geneList, candidates };
    })();
    trackCellWork(work);
    let read;
    try {
      read = await work;
      if (!current()) return undefined;
      const { geneList, candidates } = read;
      if (geneList.n_points !== this.pointCount || geneList.fields.length !== expected) {
        throw new Error(
          `The gene list read has ${formatCountOf(geneList.fields.length, 'gene')} of ` +
          `${formatCountOf(geneList.n_points, 'cell')}; the dataset opened with ` +
          `${formatCountOf(expected, 'gene')} of ${formatCountOf(this.pointCount, 'cell')}.`
        );
      }
      if (candidates.defaults.geneNames === null) {
        throw new Error('The gene names of the shown expression matrix were read but not guessed.');
      }
      this._installListedGenes(geneList, candidates);
    } catch (error) {
      if (!current()) return undefined;
      listing.state = 'failed';
      listing.failure = error instanceof Error ? error : new Error(String(error));
      listing.reject(listing.failure);
      this.emit('genes:listed', { failure: listing.failure });
      throw listing.failure;
    }
    listing.state = 'listed';
    listing.resolve();
    this.emit('mapping:changed', { mapping: this.dataMapping, cause: 'genes-listed', origin: this._mappingOrigin });
    this.emit('genes:listed', { failure: null });
    return undefined;
  }

  /**
   * Install the read gene list of the published dataset: its genes, the
   * catalog with the shown axis guessed, and the mapping's gene names (its
   * default, as the dataset opens with it). Nothing was coloured by a gene,
   * renamed or restored while they were pending: no view changes.
   * @private
   */
  _installListedGenes(geneList, candidates) {
    this._mappingCandidates = candidates;
    if (this.dataMapping !== null && this.dataMapping.geneNames === null) {
      this.dataMapping = Object.freeze({ ...this.dataMapping, geneNames: candidates.defaults.geneNames });
    }
    this.initVarData(geneList);
    this.applyFieldOverlays();
    for (const viewId of this.viewContexts.keys()) {
      if (viewId === this.activeViewId) continue;
      this.viewContexts.get(viewId).varData = this._cloneVarData(this.varData);
    }
    getFieldRegistry().invalidate();
  }

  /**
   * How many times the var axis was replaced since the dataset was published.
   * @returns {number}
   */
  getVarAxisGeneration() {
    return this._varAxisGeneration ?? 0;
  }

  /**
   * The number of genes on the gene list in use (user-defined copies are not
   * counted).
   * @returns {number}
   */
  getVarAxisGeneCount() {
    // The same count a session fingerprint's varCount records.
    return (this.varData?.fields ?? []).filter(field => field?._isUserDefined !== true).length;
  }

  /**
   * The gene each view is coloured by: its view id, the field and the name.
   * @private
   */
  _viewsColouredByGenes() {
    const views = [];
    const focused = this.activeViewId;
    for (const viewId of this.viewContexts.keys()) {
      const view = viewId === focused ? this : this.viewContexts.get(viewId);
      if (view.activeFieldSource !== 'var') continue;
      const field = view.varData?.fields?.[view.activeVarFieldIndex] ?? null;
      if (field === null) continue;
      views.push({
        viewId,
        field,
        key: field._originalKey ?? field.key,
        position: view.activeVarFieldIndex,
      });
    }
    return views;
  }

  /**
   * Read everything a new var axis needs before it replaces the current one,
   * and return the steps that publish it and restore the current one.
   *
   * @param {{
   *   geneList: Object,
   *   varFieldLoader: Function|null,
   *   sameAxis: boolean,
   *   sameMatrix: boolean
   * }} axis - The checked new gene list (`loadGeneList`) and its loader;
   *   whether it is the same var axis (gene `i` is the same column), and
   *   whether its values are those of the current matrix.
   * @returns {Promise<{dropped: string[], commit: () => void, rollback: () => void}>}
   */
  async stageVarAxisReplacement({ geneList, varFieldLoader, sameAxis, sameMatrix }) {
    if (!Array.isArray(geneList?.fields)) {
      throw new TypeError('A var axis requires its gene list.');
    }
    // An empty gene list (no expression matrix) has nothing to load.
    const loader = geneList.fields.length === 0 && varFieldLoader === null
      ? null
      : requireLoader(varFieldLoader);
    if (sameMatrix && !sameAxis) {
      throw new TypeError('One matrix has one var axis.');
    }
    const newIndexByKey = new Map(geneList.fields.map((field, index) => [field.key, index]));
    const geneCount = this.getVarAxisGeneCount();
    // Where each coloured view's gene is on the new list, or undefined.
    const resolve = view => {
      if (sameAxis && view.position < geneCount && view.field._isUserDefined !== true) {
        return view.position < geneList.fields.length ? view.position : undefined;
      }
      return newIndexByKey.get(view.key);
    };
    const coloured = this._viewsColouredByGenes();
    const dropped = [...new Set(
      coloured.filter(view => resolve(view) === undefined).map(view => view.key)
    )];

    // The values of every gene a view stays coloured by, read now. With the
    // same matrix, the view's own field already holds them.
    const staged = new Map();
    for (const view of coloured) {
      const { key } = view;
      const index = resolve(view);
      if (index === undefined || staged.has(index)) continue;
      const carried = sameMatrix ? view.field : null;
      if (carried?.loaded === true && carried.values instanceof Float32Array) {
        staged.set(index, carried.values);
        continue;
      }
      const loaded = await loader(geneList.fields[index], { signal: null });
      const values = loaded?.values;
      if (!(values instanceof Float32Array) || values.length !== this.pointCount) {
        throw new Error(`Gene "${key}" did not load one value per cell.`);
      }
      staged.set(index, values);
    }

    const previous = {
      varData: this.varData,
      descriptors: this._varFieldDescriptors,
      loader: this.varFieldLoader,
      cache: new Map(this._varFieldDataCache),
      generation: this.getVarAxisGeneration(),
      listing: this._geneListing ?? null,
      views: new Map([...this.viewContexts.keys()].map(viewId => {
        const view = viewId === this.activeViewId ? this : this.viewContexts.get(viewId);
        return [viewId, {
          varData: view.varData,
          activeFieldSource: view.activeFieldSource,
          activeFieldIndex: view.activeFieldIndex,
          activeVarFieldIndex: view.activeVarFieldIndex,
        }];
      })),
    };

    return {
      dropped,
      commit: () => {
        this._publishVarAxis({
          geneList,
          loader,
          staged,
          resolveView: (viewId) => {
            const entry = coloured.find(view => view.viewId === viewId);
            if (entry === undefined) return { mode: 'keep' };
            const index = resolve(entry);
            return index === undefined
              ? { mode: 'clear' }
              : { mode: 'gene', index, intentFrom: entry.field };
          },
        });
        this._varAxisGeneration = previous.generation + 1;
        // A gene list that could not be read is replaced by this one.
        if (previous.listing?.state === 'failed') this._geneListing = null;
        this.emit('var-axis:changed', {
          generation: this._varAxisGeneration,
          dropped: [...dropped],
        });
      },
      rollback: () => {
        this.setVarFieldLoader(previous.loader);
        this._varFieldDescriptors = previous.descriptors;
        this.varData = previous.varData;
        this._varFieldDataCache.clear();
        for (const [key, value] of previous.cache) this._varFieldDataCache.set(key, value);
        this._restoreViewsVarState(previous.views);
        this._varAxisGeneration = previous.generation;
        this._geneListing = previous.listing;
        this.emit('var-axis:changed', { generation: previous.generation, dropped: [] });
      },
    };
  }

  /**
   * Publish a staged var axis to the state and every view.
   * @private
   */
  _publishVarAxis({ geneList, loader, staged, resolveView }) {
    this.setVarFieldLoader(loader);
    this.initVarData(geneList);
    for (const [index, values] of staged) {
      const field = this.varData.fields[index];
      field.values = values;
      field.loaded = true;
      this._varFieldDataCache.set(field._originalKey || field.key, { values });
    }
    const plan = new Map([...this.viewContexts.keys()].map(viewId => [viewId, resolveView(viewId)]));
    // The focused view's selection points into the new list before anything
    // reads it.
    const focusedStep = plan.get(this.activeViewId);
    if (focusedStep.mode === 'gene') {
      this.activeVarFieldIndex = focusedStep.index;
    } else {
      if (focusedStep.mode === 'clear') this.activeFieldSource = null;
      this.activeVarFieldIndex = -1;
    }
    // Renames, deletions and user-defined genes are keyed by name; they are
    // applied to the new list exactly as to a published one.
    this.applyFieldOverlays();
    this._applyVarAxisToViews(plan);
  }

  /**
   * Give every view the new list, then recolour each view coloured by a gene.
   * The focused view is recoloured in place; any other view is focused in
   * turn (the same switch a person makes), and focus returns at the end.
   * @private
   */
  _applyVarAxisToViews(plan) {
    const focused = this.activeViewId;
    for (const [viewId, step] of plan) {
      if (viewId === focused) continue;
      const context = this.viewContexts.get(viewId);
      context.varData = this._cloneVarData(this.varData);
      if (step.mode === 'gene') {
        copyIntent(step.intentFrom, context.varData.fields[step.index]);
        context.activeVarFieldIndex = step.index;
      } else {
        // Its gene is gone (it is recoloured below) or it is not coloured by
        // a gene: no position on the new list is its own.
        if (step.mode === 'clear') context.activeFieldSource = null;
        context.activeVarFieldIndex = -1;
      }
    }
    const focusedStep = plan.get(focused);
    if (focusedStep.mode === 'gene') {
      copyIntent(focusedStep.intentFrom, this.varData.fields[focusedStep.index]);
      this.setActiveVarField(focusedStep.index);
    } else if (focusedStep.mode === 'clear') {
      this.clearActiveField();
    } else {
      this.activeVarFieldIndex = -1;
      this._syncActiveContext();
    }
    for (const [viewId, step] of plan) {
      if (viewId === focused || step.mode === 'keep') continue;
      this.setActiveView(viewId);
      if (step.mode === 'gene') this.setActiveVarField(step.index);
      else this.clearActiveField();
    }
    if (this.activeViewId !== focused) this.setActiveView(focused);
    getFieldRegistry().invalidate();
  }

  /**
   * Put back every view's var state as it was before a replacement, and
   * recolour the views that were coloured by a gene.
   * @private
   */
  _restoreViewsVarState(views) {
    const focused = this.activeViewId;
    for (const [viewId, saved] of views) {
      if (viewId === focused) continue;
      const context = this.viewContexts.get(viewId);
      context.varData = saved.varData;
      context.activeFieldSource = saved.activeFieldSource;
      context.activeFieldIndex = saved.activeFieldIndex;
      context.activeVarFieldIndex = saved.activeVarFieldIndex;
    }
    const recolour = () => {
      if (this.activeFieldSource === 'var' && this.activeVarFieldIndex >= 0) {
        this.setActiveVarField(this.activeVarFieldIndex);
      } else if (this.activeFieldSource === 'obs' && this.activeFieldIndex >= 0) {
        this.setActiveField(this.activeFieldIndex);
      } else {
        this.clearActiveField();
      }
    };
    const own = views.get(focused);
    this.varData = own.varData;
    this.activeFieldSource = own.activeFieldSource;
    this.activeFieldIndex = own.activeFieldIndex;
    this.activeVarFieldIndex = own.activeVarFieldIndex;
    recolour();
    for (const viewId of views.keys()) {
      if (viewId === focused) continue;
      this.setActiveView(viewId);
      recolour();
    }
    if (this.activeViewId !== focused) this.setActiveView(focused);
    getFieldRegistry().invalidate();
  }
}
