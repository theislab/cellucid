/**
 * @fileoverview DataState field loading + activation.
 *
 * Responsibilities:
 * - Materialize obs/var field arrays via loader functions (byte-bounded
 *   residency: see ./residency.js)
 * - Support user-defined continuous aliases by copying from stable source keys
 * - Activate a field as the current coloring/filter driver
 *
 * Mixed into DataState via `state/managers/field-manager.js`.
 *
 * @module state/managers/field/loading
 */

import { getNotificationCenter } from '../../../notification-center.js';
import { isChangedOnHost, isExplainedFailure } from '../../../../data/data-source.js';
import { getReadActivityLog } from '../../../../data/read-activity-log.js';
import { factsText, geneReadPlanFacts } from '../../../../data/gene-read-plan.js';
import { formatCount, formatCountOf, formatRemaining } from '../../../../utils/format-units.js';
import { abortReason, awaitWithSignal, cancel, cancelled, cancellationKind, isCancellation, onAbort } from '../../../../utils/abort.js';
import { cellsSteady, trackCellWork } from '../../../../data/open-cells-work.js';
import { isColumnForm, requireColumnForm, unreadTailOf } from '../../../../data/column-forms.js';
import { FieldKind, FieldSource } from '../../../utils/field-constants.js';
import { getFieldRegistry } from '../../../utils/field-registry.js';
import { adoptScientificFieldDescriptors } from './descriptor-ownership.js';
import { growFieldCategories } from './category-growth.js';
import { requireOutlierQuantiles } from '../color-outliers.js';
import {
  FetchScheduler,
  requirePriority
} from '../../../../data/fetch-scheduler.js';
import {
  compactedColumn,
  releaseInactiveFieldsOverBudget,
  touchFieldResidency,
} from './residency.js';
import { markReported } from '../../../../utils/errors.js';

/**
 * Say that a field or gene could not be read: why, in one sentence (a
 * failure written for the person is said as it is; any other is named, its
 * raw text under Details), and Try again, which reads it again and shows it
 * (the load that failed was the person's to see it). A store that changed on
 * its host offers none: this session keeps its validators, so reading again
 * can only meet the same answer, and the sentence says to open it again.
 *
 * @param {Object} notifications
 * @param {string} what - `field cell_type`, `gene CD3E`
 * @param {unknown} error
 * @param {() => void} again
 */
function announceLoadFailure(notifications, what, error, again) {
  // Said here, once: a caller that would say it again skips it (`isReported`).
  markReported(error);
  const raw = error instanceof Error ? error.message : String(error);
  notifications.error(
    isExplainedFailure(error) ? `Cellucid could not read ${what}: ${raw}` : `Cellucid could not read ${what}.`,
    {
      category: 'data',
      ...(isExplainedFailure(error) ? {} : { details: raw }),
      ...(isChangedOnHost(error) ? {} : { action: { label: 'Try again', run: again } })
    }
  );
}

const sharedLoadOwners = new WeakMap();

/** @type {WeakMap<object, {generation: number, scheduler: FetchScheduler}>} */
const fetchSchedulers = new WeakMap();

/**
 * The download scheduler of the state's current dataset generation. A new
 * generation (a dataset replaced) closes the previous scheduler, which aborts
 * and rejects every download it still held, and starts an empty one: no key,
 * slot or in-flight count of one dataset reaches the next.
 */
function fetchSchedulerOf(state) {
  const generation = readDatasetGeneration(state);
  let entry = fetchSchedulers.get(state);
  if (entry?.generation !== generation) {
    entry?.scheduler.close(cancelled('superseded', 'Field loading was superseded by a replacement dataset generation.'));
    entry = { generation, scheduler: new FetchScheduler() };
    fetchSchedulers.set(state, entry);
  }
  return entry.scheduler;
}

/** An `openExpressionMatrix` handle of the state's current dataset generation. */
function requireOpenMatrix(state, matrix) {
  if (
    matrix === null || typeof matrix !== 'object' ||
    !Array.isArray(matrix.fields) || typeof matrix.loader?.readSparseColumn !== 'function'
  ) {
    throw new TypeError('An expression matrix is read through its openExpressionMatrix() handle.');
  }
  if (matrix.generation !== readDatasetGeneration(state)) throw cancelled('superseded', 'Field loading was superseded by a replacement dataset generation.');
  return matrix;
}

/** The descriptors of genes of an `openExpressionMatrix` handle, by position. */
function matrixDescriptors(matrix, genes) {
  return genes.map(gene => {
    const descriptor = matrix.fields[gene];
    if (descriptor === undefined) throw new RangeError(`${matrix.expression} has no gene ${gene}.`);
    return descriptor;
  });
}

function readDatasetGeneration(state) {
  const generation = state._datasetGeneration ?? 0;
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new TypeError(
      'DataState dataset generation must be a non-negative safe integer.'
    );
  }
  return generation;
}

function requireAbortSignal(signal) {
  if (signal === null || signal === undefined) return null;
  if (!(signal instanceof AbortSignal)) {
    throw new TypeError('Field loading signal must be an AbortSignal or null.');
  }
  return signal;
}

/** Each shared load's key: its reads carry it, so a job joining the load adopts them. */
let nextSharedLoadKey = 1;

function createSharedLoadOwner() {
  return {
    controller: new AbortController(),
    settled: false,
    task: null,
    waiters: new Set(),
    // Who hears a gene on more cells as they are read (`onPartial`).
    partials: new Set(),
    readKey: `field-load-${nextSharedLoadKey++}`
  };
}

function subscribeToSharedLoad(owner, signal) {
  if (
    owner === null
    || typeof owner !== 'object'
    || !(owner.controller instanceof AbortController)
    || owner.task === null
  ) {
    throw new TypeError('Shared field load owner is invalid.');
  }
  const lease = {};
  let released = false;
  let stopListening = () => {};
  const release = () => {
    if (released) return;
    released = true;
    stopListening();
    owner.waiters.delete(lease);
    if (
      owner.settled === false
      && owner.waiters.size === 0
      && owner.controller.signal.aborted === false
    ) {
      // The person's Cancel (the last to leave) says the load was stopped by
      // them; any other way of leaving -- a supersession, a failure the
      // waiter's own signal carried -- is the load no longer wanted, never a
      // failure of the load itself.
      owner.controller.abort(
        signal?.aborted === true && isCancellation(signal.reason)
          ? signal.reason
          : cancelled('superseded', 'Field loading has no remaining consumers.')
      );
    }
  };
  owner.waiters.add(lease);
  stopListening = onAbort(signal, release);
  return awaitWithSignal(owner.task, signal).finally(release);
}

function observeSharedLoad(field, owner) {
  const settle = () => {
    owner.settled = true;
    if (sharedLoadOwners.get(field) === owner) {
      sharedLoadOwners.delete(field);
    }
  };
  owner.task.then(settle, settle);
}

function requireCurrentSharedLoad(field, task) {
  if (field._loadingPromise !== task) {
    throw cancelled('superseded', 'Field loading was superseded by a replacement dataset generation.');
  }
}

function abortSharedLoad(field, message) {
  const owner = sharedLoadOwners.get(field);
  if (
    owner?.task === field?._loadingPromise
    && owner.settled === false
    && owner.controller.signal.aborted === false
  ) {
    owner.controller.abort(cancelled('closed', message));
  }
}

function captureLoadOwner(
  state,
  {
    descriptor,
    field,
    fieldIndex,
    loader,
    source
  }
) {
  return Object.freeze({
    datasetGeneration: readDatasetGeneration(state),
    descriptor,
    field,
    fieldIndex,
    loader,
    pointCount: state.pointCount,
    source
  });
}

function isCurrentLoadOwner(state, owner) {
  const isObservation = owner.source === FieldSource.OBS;
  const fields = isObservation
    ? state.obsData?.fields
    : state.varData?.fields;
  const descriptors = isObservation
    ? state._obsFieldDescriptors
    : state._varFieldDescriptors;
  const loader = isObservation
    ? state.fieldLoader
    : state.varFieldLoader;
  return (
    readDatasetGeneration(state) === owner.datasetGeneration
    && state.pointCount === owner.pointCount
    && fields?.[owner.fieldIndex] === owner.field
    && (
      owner.descriptor === null
      || descriptors?.[owner.fieldIndex] === owner.descriptor
    )
    && (
      owner.loader === null
      || loader === owner.loader
    )
  );
}

function assertCurrentLoadOwner(state, owner) {
  if (!isCurrentLoadOwner(state, owner)) {
    throw cancelled('superseded', 'Field loading was superseded by a replacement dataset generation.');
  }
}

function validateLoadedLength(values, pointCount, message) {
  if (
    values !== null
    && values !== undefined
    && values.length !== pointCount
  ) {
    throw new Error(`${message} (${values.length} vs ${pointCount}).`);
  }
}

/**
 * Give a categorical field the categories its first load found (an AnnData
 * column publishes none until it is read: a string or boolean column's are
 * its labels among the open cells, a categorical's its stored dictionary,
 * or, when that has more categories than there are open cells, the ones its
 * open cells hold, `storedCategoryCount` of them stored), with their colours
 * (the file's for a categorical, the ones its labels name for a text
 * column), shown under their display names. A field whose categories are
 * known keeps them: the dataset codes a column one way for its whole life,
 * a text column's (and a categorical coded by the categories its open cells
 * hold) growing by label when cells opened since hold labels it had not
 * shown (`category-growth.js`).
 */
function adoptFoundCategories(state, field, categories, palette = null, storedCategoryCount = undefined) {
  if (categories === undefined) return;
  if (!Array.isArray(categories)) {
    throw new TypeError(`Field "${field.key}" found categories must be an array.`);
  }
  if (storedCategoryCount !== undefined) {
    // More categories stored than cells open: its categories are the ones
    // its open cells hold (a saved category it lacks is held until cells
    // holding it open, `pending-categories.js`), of `storedCategoryCount`.
    field.discovered = true;
    field.storedCategoryCount = storedCategoryCount;
  }
  const owner = { source: FieldSource.OBS, originalKey: field._originalKey || field.key, label: `obs field "${field.key}"` };
  if (field.categories !== null) {
    const shown = Object.hasOwn(field, '_originalCategories') ? field._originalCategories : field.categories;
    if (categories.length > shown.length) growFieldCategories(state, field, { categories, palette }, owner);
    return;
  }
  if (Array.isArray(palette) && palette.length === categories.length) field.palette = palette;
  field.categories = [...categories];
  state._applyCategoryOverlay(field, owner.source, owner.originalKey, owner.label);
}

export class FieldLoadingMethods {
  setFieldLoader(loaderFn) {
    this.fieldLoader = loaderFn;
  }

  setVarFieldLoader(loaderFn) {
    this.varFieldLoader = loaderFn;
    // The open cells its genes are read for (`gene-sample.js`).
    void this.refreshGeneSample();
  }

  getDatasetGeneration() {
    return readDatasetGeneration(this);
  }

  initVarData(geneList) {
    if (!geneList) return;
    const geneFields = geneList?.fields || [];
    this._varFieldDescriptors = adoptScientificFieldDescriptors(geneFields);
    const normalizedFields = geneFields.map((field) => ({
      ...field,
      loaded: Boolean(field?.values),
      _loadingPromise: null,
      _loadingSignal: null
    }));
    this.varData = { ...geneList, fields: normalizedFields };
    this._varFieldDataCache.clear();
    // The genes listed: the open cells they are read for (`gene-sample.js`).
    void this.refreshGeneSample();
  }

  /**
   * Ensure a field is loaded before use.
   * @param {number} fieldIndex - Index of the field in obsData.fields
   * @param {Object} [options] - Options
   * @param {boolean} [options.silent=false] - If true, suppress notifications (for batch operations)
   * @returns {Promise<Object>} The loaded field object
   */
  async ensureFieldLoaded(fieldIndex, options = {}) {
    const {
      signal: rawSignal = null,
      silent = false
    } = options;
    const signal = requireAbortSignal(rawSignal);
    if (signal?.aborted) throw abortReason(signal);
    // The open cells being changed in place: loaded on the cells after it
    // (`data/open-cells-work.js`).
    const steady = cellsSteady();
    if (steady !== null) await awaitWithSignal(steady, signal);
    const field = this.obsData?.fields?.[fieldIndex];
    if (!field) throw new Error(`Obs field ${fieldIndex} is not available.`);
    const cacheKey = field._originalKey || field.key || String(fieldIndex);

    // A field that holds its own values (a pushed column) has nothing to
    // read: its values come with it, or with its session chunk.
    if (
      field.loaded !== true &&
      field._isUserDefined === true &&
      field.kind === FieldKind.CONTINUOUS &&
      field._sourceField === null
    ) {
      throw new Error(`The values of "${field.key}" were not restored with the session.`);
    }

    // User-defined continuous aliases are materialized by copying from their source field.
    if (
      field.loaded !== true &&
      field._isUserDefined === true &&
      field._userDefinedId &&
      field.kind === FieldKind.CONTINUOUS &&
      field._sourceField?.sourceKey
    ) {
      const sourceKey = String(field._sourceField.sourceKey || '').trim();
      const sourceIndex = sourceKey ? getFieldRegistry().getIndexByKey(FieldSource.OBS, sourceKey) : -1;
      if (sourceIndex < 0) {
        throw new Error(`Source field not found for "${field.key}" (sourceKey="${sourceKey}")`);
      }

      const aliasOwner = captureLoadOwner(this, {
        descriptor: null,
        field,
        fieldIndex,
        loader: null,
        source: FieldSource.OBS
      });
      const sourceField = await this.ensureFieldLoaded(sourceIndex, options);
      if (signal?.aborted) throw abortReason(signal);
      assertCurrentLoadOwner(this, aliasOwner);
      if (this.obsData?.fields?.[sourceIndex] !== sourceField) {
        throw cancelled('superseded', 'Field loading was superseded by a replacement dataset generation.');
      }
      const values = sourceField?.values;
      if (!values || typeof values.length !== 'number') {
        throw new Error(`Source field "${sourceKey}" has no values to copy`);
      }

      // IMPORTANT (large datasets): do not copy value arrays for aliases.
      // User-defined continuous "copies" are read-only aliases, so sharing the
      // underlying typed array avoids O(n) allocation and ~2× memory overhead.
      field.values = values;
      if (sourceField?.outlierQuantiles) field.outlierQuantiles = sourceField.outlierQuantiles;
      field.loaded = true;
      field._loadingPromise = null;
      this._fieldDataCache.set(cacheKey, { values: field.values, outlierQuantiles: field.outlierQuantiles });
      touchFieldResidency(this, FieldSource.OBS, cacheKey);
      return field;
    }

    if (field.loaded) {
      if (!this._fieldDataCache.has(cacheKey)) {
        this._fieldDataCache.set(cacheKey, {
          values: field.values,
          codes: field.codes,
          outlierQuantiles: field.outlierQuantiles
        });
      }
      touchFieldResidency(this, FieldSource.OBS, cacheKey);
      return field;
    }
    if (field._loadingPromise) {
      const activeOwner = sharedLoadOwners.get(field);
      if (
        activeOwner?.task === field._loadingPromise
        && activeOwner.controller.signal.aborted === false
      ) {
        return subscribeToSharedLoad(activeOwner, signal);
      }
      if (activeOwner?.task !== field._loadingPromise) {
        return awaitWithSignal(field._loadingPromise, signal);
      }
    }
    if (!this.fieldLoader) throw new Error(`No loader configured for field "${field.key}".`);

    const cached = this._fieldDataCache.get(cacheKey);
    if (cached) {
      if (cached.values) field.values = cached.values;
      if (cached.codes) field.codes = cached.codes;
      if (cached.outlierQuantiles) field.outlierQuantiles = cached.outlierQuantiles;
      adoptFoundCategories(this, field, cached.categories, cached.palette, cached.storedCategoryCount);
      field.loaded = true;
      touchFieldResidency(this, FieldSource.OBS, cacheKey);
      return field;
    }

    const loaderField = this._obsFieldDescriptors?.[fieldIndex];
    if (!loaderField) {
      throw new Error(
        `No immutable scientific descriptor is available for obs field "${field.key}".`
      );
    }
    const loader = this.fieldLoader;
    const owner = captureLoadOwner(this, {
      descriptor: loaderField,
      field,
      fieldIndex,
      loader,
      source: FieldSource.OBS
    });

    const sharedOwner = createSharedLoadOwner();
    const sharedSignal = sharedOwner.controller.signal;
    // Its notification (unless silent, batch operations) can stop it, as a
    // gene's can: at 10M cells a field is a long read too.
    const notifications = getNotificationCenter();
    const notifId = silent ? null : notifications.loading(`Loading field: ${field.key}`, {
      category: 'data',
      onCancel: () => cancel(sharedOwner.controller, 'user', `Loading "${field.key}" was cancelled.`)
    });
    let task;
    task = Promise.resolve()
      .then(() => {
        if (sharedSignal.aborted) throw abortReason(sharedSignal);
        // An observation field is what a view is about to show: it goes
        // through the download scheduler as a foreground load, so a long
        // analysis run's gene downloads wait while it arrives
        // (data/fetch-scheduler.js).
        return awaitWithSignal(
          fetchSchedulerOf(this).run({
            key: sharedOwner,
            priority: 'normal',
            signal: sharedSignal,
            start: downloadSignal => loader(loaderField, { signal: downloadSignal })
          }),
          sharedSignal
        );
      })
      .then((loadedData) => {
        if (sharedSignal.aborted) throw abortReason(sharedSignal);
        requireCurrentSharedLoad(field, task);
        assertCurrentLoadOwner(this, owner);
        const nextValues = loadedData?.values ?? field.values;
        const nextCodes = loadedData?.codes ?? field.codes;
        const nextOutlierQuantiles =
          loadedData?.outlierQuantiles ?? field.outlierQuantiles;
        validateLoadedLength(
          nextValues,
          owner.pointCount,
          `Field "${field.key}" values length mismatch`
        );
        validateLoadedLength(
          nextCodes,
          owner.pointCount,
          `Field "${field.key}" codes length mismatch`
        );
        validateLoadedLength(
          nextOutlierQuantiles,
          owner.pointCount,
          `Field "${field.key}" outlier length mismatch`
        );
        if (sharedSignal.aborted) throw abortReason(sharedSignal);
        requireCurrentSharedLoad(field, task);
        assertCurrentLoadOwner(this, owner);
        // The categories a column has are found by its first load when its
        // field list could not state them (data-loaders.js).
        const foundCategories = loadedData?.categories;
        adoptFoundCategories(this, field, foundCategories, loadedData?.palette ?? null, loadedData?.storedCategoryCount);
        if (nextValues !== undefined) field.values = nextValues;
        if (nextCodes !== undefined) field.codes = nextCodes;
        if (nextOutlierQuantiles !== undefined) {
          field.outlierQuantiles = nextOutlierQuantiles;
        }
        field.loaded = true;
        if (field._loadingPromise === task) {
          field._loadingPromise = null;
          field._loadingSignal = null;
        }
        this._fieldDataCache.set(cacheKey, {
          values: field.values,
          codes: field.codes,
          outlierQuantiles: field.outlierQuantiles,
          ...(foundCategories === undefined
            ? {}
            : { categories: foundCategories, palette: loadedData?.palette ?? null, storedCategoryCount: loadedData?.storedCategoryCount })
        });
        touchFieldResidency(this, FieldSource.OBS, cacheKey);
        if (notifId) notifications.complete(notifId, `Loaded field: ${field.key}`);
        return field;
      })
      .catch((err) => {
        if (field._loadingPromise === task) {
          field._loadingPromise = null;
          field._loadingSignal = null;
        }
        if (notifId) {
          if (cancellationKind(sharedSignal.reason) === 'user' || cancellationKind(err) === 'user') {
            notifications.complete(notifId, `Stopped loading field: ${field.key}`);
          } else if (sharedSignal.aborted || isCancellation(err)) {
            // Superseded, or its dataset's caches released under it: never a failure.
            notifications.dismiss(notifId);
          } else {
            notifications.dismiss(notifId);
            announceLoadFailure(notifications, `field ${field.key}`, err, () => {
              void this.ensureFieldLoaded(fieldIndex)
                .then(() => this.setActiveField(fieldIndex))
                .catch(() => {});
            });
          }
        }
        throw err;
      });

    sharedOwner.task = task;
    sharedLoadOwners.set(field, sharedOwner);
    observeSharedLoad(field, sharedOwner);
    field._loadingPromise = trackCellWork(task);
    field._loadingSignal = sharedSignal;
    return subscribeToSharedLoad(sharedOwner, signal);
  }

  /**
   * Ensure a var field (gene) is loaded before use.
   * @param {number} fieldIndex - Index of the field in varData.fields
   * @param {Object} [options] - Options
   * @param {boolean} [options.silent=false] - If true, suppress notifications (for batch operations)
   * @param {'high'|'normal'|'bulk'|'low'} [options.priority='normal'] - How
   *   urgently the gene is needed (data/fetch-scheduler.js): `high` for a gene
   *   the user chose and waits to see, `bulk` for one of a long run's genes,
   *   `low` for a prefetch. A caller joining a load already under way raises
   *   its priority.
   * @param {string|null} [options.owner=null] - The job (an analysis's) a
   *   load it starts is read for, whose notification shows it; a job joining
   *   a load already under way adopts its reads
   *   (`data/read-activity-log.js`, `adopt`)
   * @param {((column: Float32Array|import('../../../../data/column-forms.js').ColumnForm, cells: number) => void)|null} [options.onPartial=null] -
   *   While the gene index of a matrix indexed in segments is built (a
   *   subsample's: `anndata/prefix-column-index.js`), the gene on the first
   *   `cells` open cells (a sample of them), the rest not read, each time it
   *   has more: its sparse form when smaller (`data/column-forms.js`), else
   *   one value an open cell, NaN on the rest; the field itself loads only
   *   whole (`showPartialVarField`)
   * @returns {Promise<Object>} The loaded field object
   */
  async ensureVarFieldLoaded(fieldIndex, options = {}) {
    const {
      signal: rawSignal = null,
      silent = false,
      priority = 'normal',
      owner: readOwner = null,
      onPartial = null
    } = options;
    requirePriority(priority);
    const signal = requireAbortSignal(rawSignal);
    if (signal?.aborted) throw abortReason(signal);
    const steady = cellsSteady();
    if (steady !== null) await awaitWithSignal(steady, signal);
    const field = this.varData?.fields?.[fieldIndex];
    if (!field) throw new Error(`Var field ${fieldIndex} is not available.`);
    const cacheKey = field._originalKey || field.key || String(fieldIndex);

    // User-defined continuous aliases (gene copies) are materialized by copying from their source gene.
    if (
      field.loaded !== true &&
      field._isUserDefined === true &&
      field._userDefinedId &&
      field.kind === FieldKind.CONTINUOUS &&
      field._sourceField?.sourceKey
    ) {
      const sourceKey = String(field._sourceField.sourceKey || '').trim();
      const sourceIndex = sourceKey ? getFieldRegistry().getIndexByKey(FieldSource.VAR, sourceKey) : -1;
      if (sourceIndex < 0) {
        throw new Error(`Source gene not found for "${field.key}" (sourceKey="${sourceKey}")`);
      }

      const aliasOwner = captureLoadOwner(this, {
        descriptor: null,
        field,
        fieldIndex,
        loader: null,
        source: FieldSource.VAR
      });
      const sourceField = await this.ensureVarFieldLoaded(sourceIndex, options);
      if (signal?.aborted) throw abortReason(signal);
      assertCurrentLoadOwner(this, aliasOwner);
      if (this.varData?.fields?.[sourceIndex] !== sourceField) {
        throw cancelled('superseded', 'Field loading was superseded by a replacement dataset generation.');
      }
      const values = sourceField?.values;
      if (!values || typeof values.length !== 'number') {
        throw new Error(`Source gene "${sourceKey}" has no values to copy`);
      }

      // See note above: aliases share the underlying values array to avoid
      // duplicating large Float32Array gene-expression buffers.
      field.values = values;
      field.loaded = true;
      field._loadingPromise = null;
      this._varFieldDataCache.set(cacheKey, { values: field.values });
      touchFieldResidency(this, FieldSource.VAR, cacheKey);
      return field;
    }

    if (field.loaded) {
      if (!this._varFieldDataCache.has(cacheKey)) {
        this._varFieldDataCache.set(cacheKey, { values: field.values });
      }
      touchFieldResidency(this, FieldSource.VAR, cacheKey);
      return field;
    }
    if (field._loadingPromise) {
      const activeOwner = sharedLoadOwners.get(field);
      if (
        activeOwner?.task === field._loadingPromise
        && activeOwner.controller.signal.aborted === false
      ) {
        // A gene prefetched, or queued by a long run, that the user now
        // waits for goes first.
        fetchSchedulerOf(this).raise(activeOwner, priority);
        // A job joining a load a view started takes its reads as its own:
        // one notification for the run, the job's.
        if (readOwner !== null) getReadActivityLog().adopt(activeOwner.readKey, readOwner);
        if (typeof onPartial === 'function') activeOwner.partials.add(onPartial);
        return subscribeToSharedLoad(activeOwner, signal);
      }
      if (activeOwner?.task !== field._loadingPromise) {
        return awaitWithSignal(field._loadingPromise, signal);
      }
    }
    if (!this.varFieldLoader) throw new Error(`No loader configured for var field "${field.key}".`);

    const cached = this._varFieldDataCache.get(cacheKey);
    if (cached) {
      if (cached.values) {
        field.values = cached.values;
      } else if (cached.form) {
        // Kept as its sparse form while inactive (`field/residency.js`): its
        // column made again from it, no read.
        field.values = compactedColumn(cached);
        this._varFieldDataCache.set(cacheKey, { values: field.values });
      }
      field.loaded = true;
      touchFieldResidency(this, FieldSource.VAR, cacheKey);
      return field;
    }

    const loaderField = this._varFieldDescriptors?.[fieldIndex];
    if (!loaderField) {
      throw new Error(
        `No immutable scientific descriptor is available for var field "${field.key}".`
      );
    }
    const loader = this.varFieldLoader;
    const owner = captureLoadOwner(this, {
      descriptor: loaderField,
      field,
      fieldIndex,
      loader,
      source: FieldSource.VAR
    });

    const sharedOwner = createSharedLoadOwner();
    // When the read started: a gene sample's first gene times the link
    // (`topUpGeneSample`).
    const startedAt = performance.now();
    // Genes read for more cells in the gene time wait while this one is read.
    const resumeTopUp = this.yieldGeneSampleTopUp?.() ?? (() => {});
    // The caller that starts the load hears its partial answers too, as one
    // that joins it does (above).
    if (typeof onPartial === 'function') sharedOwner.partials.add(onPartial);
    const sharedSignal = sharedOwner.controller.signal;
    // Show loading notification for gene expression (unless silent mode for
    // batch operations), with Cancel: a gene of a matrix stored cell by cell
    // may read the whole matrix, and the person who waits decides.
    const notifications = getNotificationCenter();
    const notifId = silent ? null : notifications.loading(`Loading gene: ${field.key}`, {
      category: 'data',
      onCancel: () => sharedOwner.controller.abort(cancelled('user', `Loading \"${field.key}\" was cancelled.`))
    });
    // What the read costs is said before it runs, when it is the whole matrix.
    if (notifId !== null && typeof loader.readPlan === 'function') {
      Promise.resolve()
        .then(() => loader.readPlan(loaderField))
        .then((plan) => {
          // One short line; why (from the file's layout) and what follows in its details.
          const facts = geneReadPlanFacts(plan);
          if (facts === null || sharedOwner.settled || !notifications.hasNotification(notifId)) return;
          notifications.loading(`Reading gene ${field.key}: ${facts.summary}`, { id: notifId, category: 'data', details: factsText(facts.rows) });
        })
        .catch((error) => {
          // The read itself reports what failed; the plan only describes it.
          console.warn(`Could not tell what loading gene "${field.key}" costs:`, error);
        });
    }
    // A wait its host named (a served store laying the matrix out, a host's
    // request budget, `formats/io/byte-source.js`): said on the notification,
    // in the host's own words, until the gene's bytes come. Not a failure.
    let saidWaiting = false;
    const stopWaitingNotice = notifId === null ? () => {} : getReadActivityLog().subscribe((activity) => {
      if (sharedOwner.settled || !activity.keys?.includes(sharedOwner.readKey) || !notifications.hasNotification(notifId)) return;
      if (activity.waiting) {
        saidWaiting = true;
        notifications.loading(`Reading gene ${field.key}: ${activity.waiting.text}`, { id: notifId, category: 'data' });
      } else if (saidWaiting) {
        saidWaiting = false;
        notifications.loading(`Loading gene: ${field.key}`, { id: notifId, category: 'data' });
      }
    });
    // The first partial answer (`onPartial`): when, and on how many cells.
    let partialsSeen = null;
    let task;
    task = Promise.resolve()
      .then(() => {
        if (sharedSignal.aborted) throw abortReason(sharedSignal);
        // One download scheduler for every gene load (data/fetch-scheduler.js):
        // a gene the user waits for starts at once and holds back new
        // downloads of long runs and prefetches until it has arrived.
        return awaitWithSignal(
          fetchSchedulerOf(this).run({
            key: sharedOwner,
            priority,
            signal: sharedSignal,
            start: (downloadSignal, startPriority) => loader(loaderField, {
              signal: downloadSignal,
              priority: startPriority,
              owner: readOwner,
              key: sharedOwner.readKey,
              // The gene on more cells as they are read: said on its
              // notification, and handed to whoever asked to see it.
              onPartial: (column, cells) => {
                if (sharedOwner.settled || sharedSignal.aborted || column.length !== owner.pointCount) return;
                if (notifId !== null && notifications.hasNotification(notifId)) {
                  // The whole gene's time left, from the cells coloured since
                  // the first colours (every open cell's rows are read: the
                  // time goes with the cells, `geneLayoutReason`). A gene read
                  // for a sample of the open cells (`gene-sample.js`) is read
                  // for those only: they are its whole.
                  const readFor = Math.min(owner.pointCount, this.getGeneSample?.()?.cells ?? owner.pointCount);
                  const now = performance.now();
                  partialsSeen ??= { at: now, cells };
                  const rate = cells > partialsSeen.cells ? (cells - partialsSeen.cells) / (now - partialsSeen.at) : null;
                  const left = rate === null ? '' : ` · ${formatRemaining(Math.max(0, readFor - cells) / rate)} left`;
                  // A sample of the cells; the others show as missing until read (said in the details).
                  notifications.loading(
                    `Reading gene ${field.key}: ${formatCount(cells)} of ${formatCountOf(readFor, 'cell')} coloured${left}`,
                    { id: notifId, category: 'data' }
                  );
                }
                for (const listener of sharedOwner.partials) listener(column, cells);
              }
            })
          }),
          sharedSignal
        );
      })
      .then((loadedData) => {
        if (sharedSignal.aborted) throw abortReason(sharedSignal);
        requireCurrentSharedLoad(field, task);
        assertCurrentLoadOwner(this, owner);
        const nextValues = loadedData?.values ?? field.values;
        validateLoadedLength(
          nextValues,
          owner.pointCount,
          `Var field "${field.key}" values length mismatch`
        );
        if (sharedSignal.aborted) throw abortReason(sharedSignal);
        requireCurrentSharedLoad(field, task);
        assertCurrentLoadOwner(this, owner);
        if (nextValues !== undefined) field.values = nextValues;
        field.loaded = true;
        // The open cells its values were read for (`gene-sample.js`).
        if (loadedData !== null && typeof loadedData === 'object' && Object.hasOwn(loadedData, 'geneSample')) {
          this.noteGeneSample(loadedData.geneSample);
          // The sample's first gene read its rows: the rest of the gene time
          // reads genes for more cells (once per sample; later genes read
          // the index).
          if (loadedData.geneSample !== null) void this.topUpGeneSample?.(performance.now() - startedAt);
        }
        if (field._loadingPromise === task) {
          field._loadingPromise = null;
          field._loadingSignal = null;
        }
        this._varFieldDataCache.set(cacheKey, { values: field.values });
        touchFieldResidency(this, FieldSource.VAR, cacheKey);
        if (notifId) notifications.complete(notifId, `Loaded gene: ${field.key}`);
        return field;
      })
      .catch((err) => {
        if (field._loadingPromise === task) {
          field._loadingPromise = null;
          field._loadingSignal = null;
        }
        // Cancelled by the person: every waiter learns it was, whatever the
        // read stopped with.
        const personsReason = sharedSignal.aborted && cancellationKind(sharedSignal.reason) === 'user'
          ? sharedSignal.reason
          : null;
        const stoppedByPerson = personsReason !== null || cancellationKind(err) === 'user';
        if (notifId && notifications.hasNotification(notifId)) {
          if (stoppedByPerson) {
            notifications.complete(notifId, `Stopped loading gene: ${field.key}`);
          } else if (
            sharedSignal.aborted
            // Superseded, or its dataset's caches released under it: never a failure.
            || isCancellation(err)
          ) {
            notifications.dismiss(notifId);
          } else {
            notifications.dismiss(notifId);
            announceLoadFailure(notifications, `gene ${field.key}`, err, () => {
              void this.ensureVarFieldLoaded(fieldIndex)
                .then(() => this.setActiveVarField(fieldIndex))
                .catch(() => {});
            });
          }
        }
        throw personsReason ?? err;
      });

    sharedOwner.task = task;
    sharedLoadOwners.set(field, sharedOwner);
    observeSharedLoad(field, sharedOwner);
    task.then(stopWaitingNotice, stopWaitingNotice);
    task.then(resumeTopUp, resumeTopUp);
    field._loadingPromise = trackCellWork(task);
    field._loadingSignal = sharedSignal;
    return subscribeToSharedLoad(sharedOwner, signal);
  }

  /**
   * One gene's non-zero entries (`{length, indices, values}`), read from the
   * source without installing anything in field state: what an analysis
   * computes from. The caller owns the arrays. Null when the source cannot
   * (no AnnData loader) or the field is a user-defined copy (its values are
   * already loaded). Scheduled at `priority` (data/fetch-scheduler.js);
   * `owner` is the job the read is for (`app/jobs/cancellable-job.js`).
   *
   * @param {number} fieldIndex
   * @param {{signal?: AbortSignal|null, priority?: string, owner?: string|null}} [options]
   * @returns {Promise<{length: number, indices: Uint32Array, values: Float32Array}|null>}
   */
  async readVarSparseColumn(fieldIndex, options = {}) {
    const signal = requireAbortSignal(options.signal ?? null);
    if (signal?.aborted) throw abortReason(signal);
    const loader = this.varFieldLoader;
    const descriptor = this._varFieldDescriptors?.[fieldIndex];
    if (
      typeof loader?.readSparseColumn !== 'function' ||
      !descriptor ||
      this.varData?.fields?.[fieldIndex]?._isUserDefined === true
    ) {
      return null;
    }
    return fetchSchedulerOf(this).run({
      key: {},
      priority: options.priority ?? 'normal',
      signal,
      start: downloadSignal => loader.readSparseColumn(descriptor, {
        signal: downloadSignal,
        owner: options.owner ?? null
      })
    });
  }

  /**
   * One gene's non-zero entries from an expression matrix other than the
   * mapped one (`openExpressionMatrix`), scheduled as `readVarSparseColumn`.
   * The caller owns the arrays.
   *
   * @param {{generation: number, fields: ReadonlyArray<Object>, loader: Function}} matrix
   * @param {number} gene - The gene's position in `matrix.fields`
   * @param {{signal?: AbortSignal|null, priority?: string, owner?: string|null}} [options]
   * @returns {Promise<{length: number, indices: Uint32Array, values: Float32Array}>}
   */
  async readMatrixSparseColumn(matrix, gene, options = {}) {
    const signal = requireAbortSignal(options.signal ?? null);
    if (signal?.aborted) throw abortReason(signal);
    const descriptor = requireOpenMatrix(this, matrix).fields[gene];
    if (descriptor === undefined) throw new RangeError(`${matrix.expression} has no gene ${gene}.`);
    return fetchSchedulerOf(this).run({
      key: {},
      priority: options.priority ?? 'normal',
      signal,
      start: downloadSignal => matrix.loader.readSparseColumn(descriptor, {
        signal: downloadSignal,
        owner: options.owner ?? null
      })
    });
  }

  /**
   * Some genes of an expression matrix other than the mapped one
   * (`openExpressionMatrix`) in some cells, as `readVarCellSubset` reads them.
   *
   * @param {{generation: number, fields: ReadonlyArray<Object>, loader: Function}} matrix
   * @param {number[]} genes - Distinct positions in `matrix.fields`
   * @param {ArrayLike<number>} cells - Distinct cell positions
   * @param {{signal?: AbortSignal|null, owner?: string|null, runGenes?: number|null}} [options]
   * @returns {Promise<{pointers: Float64Array, cellIndex: Int32Array, values: Float32Array}>}
   */
  async readMatrixCellSubset(matrix, genes, cells, options = {}) {
    const signal = requireAbortSignal(options.signal ?? null);
    if (signal?.aborted) throw abortReason(signal);
    const { fields } = requireOpenMatrix(this, matrix);
    const descriptors = genes.map(gene => {
      const descriptor = fields[gene];
      if (descriptor === undefined) throw new RangeError(`${matrix.expression} has no gene ${gene}.`);
      return descriptor;
    });
    return fetchSchedulerOf(this).run({
      key: {},
      priority: 'bulk',
      signal,
      start: downloadSignal => matrix.loader.readCellSubset(descriptors, cells, {
        signal: downloadSignal,
        owner: options.owner ?? null,
        runGenes: options.runGenes ?? null
      })
    });
  }

  /**
   * Some genes' values in some cells, as a gene-major block (`pointers`,
   * `cellIndex` into `cells`, `values`), read by cell or by gene, whichever
   * costs less (an AnnData source). Null when the source cannot, or when a
   * field is a user-defined copy (which has no payload of its own). One of a
   * long run's reads: the user's own loads go first (data/fetch-scheduler.js).
   *
   * @param {number[]} fieldIndices - Distinct var field positions
   * @param {ArrayLike<number>} cells - Distinct cell positions
   * @param {{signal?: AbortSignal|null, owner?: string|null, runGenes?: number|null}} [options] -
   *   `owner`: the job the read is for
   * @returns {Promise<{pointers: Float64Array, cellIndex: Int32Array, values: Float32Array}|null>}
   */
  async readVarCellSubset(fieldIndices, cells, options = {}) {
    const signal = requireAbortSignal(options.signal ?? null);
    if (signal?.aborted) throw abortReason(signal);
    const loader = this.varFieldLoader;
    if (typeof loader?.readCellSubset !== 'function') return null;
    const descriptors = fieldIndices.map(index => this._varFieldDescriptors?.[index]);
    if (
      descriptors.some(descriptor => !descriptor) ||
      fieldIndices.some(index => this.varData?.fields?.[index]?._isUserDefined === true)
    ) {
      return null;
    }
    return fetchSchedulerOf(this).run({
      key: {},
      priority: 'bulk',
      signal,
      start: downloadSignal => loader.readCellSubset(descriptors, cells, {
        signal: downloadSignal,
        owner: options.owner ?? null,
        runGenes: options.runGenes ?? null
      })
    });
  }

  /**
   * Whether this dataset's genes can be delivered to analysis workers over a
   * gene route (`data/gene-delivery.js`): its reader runs in a worker. The
   * genes an analysis computes in its workers then never cross this thread.
   *
   * @returns {boolean}
   */
  deliversGenes() {
    const loader = this.varFieldLoader;
    return typeof loader?.deliverSparseColumns === 'function' && loader.deliversGenes() === true;
  }

  /**
   * Whether var field `fieldIndex` is read from the source, and so can be
   * delivered: a user-defined copy has no payload of its own.
   *
   * @param {number} fieldIndex
   * @returns {boolean}
   */
  isVarFieldDeliverable(fieldIndex) {
    return Boolean(this._varFieldDescriptors?.[fieldIndex]) &&
      this.varData?.fields?.[fieldIndex]?._isUserDefined !== true;
  }

  /**
   * Open gene route `id` in this dataset's reader: `ports`, one per
   * analysis worker, are the reader's ends of its channels.
   *
   * @param {string} id
   * @param {MessagePort[]} ports
   * @returns {Promise<void>}
   */
  openGeneRoute(id, ports) {
    if (!this.deliversGenes()) throw new Error('This dataset cannot deliver genes to analysis workers.');
    return this.varFieldLoader.openGeneRoute(id, ports);
  }

  /**
   * The new port of route `id`'s worker `worker`, which the pool replaced.
   *
   * @returns {Promise<void>}
   */
  replaceGeneRoutePort(id, worker, port, generation) {
    if (!this.deliversGenes()) throw new Error('This dataset cannot deliver genes to analysis workers.');
    return this.varFieldLoader.replaceGeneRoutePort(id, worker, port, generation);
  }

  /**
   * Let route `id` go; a dataset that no longer delivers holds none.
   *
   * @param {string} id
   * @returns {Promise<void>}
   */
  async closeGeneRoute(id) {
    if (!this.deliversGenes()) return;
    await this.varFieldLoader.closeGeneRoute(id);
  }

  /**
   * Some genes' non-zero entries delivered to analysis workers over a gene
   * route (`data/gene-delivery.js`): what returns is only each gene's bytes.
   * Scheduled at `priority` like `readVarSparseColumn`.
   *
   * @param {number[]} fieldIndices - Deliverable var fields (`isVarFieldDeliverable`)
   * @param {Object} delivery
   * @param {{signal?: AbortSignal|null, priority?: string, owner?: string|null}} [options]
   * @returns {Promise<{bytes: number[]}>}
   */
  async deliverVarSparseColumns(fieldIndices, delivery, options = {}) {
    const signal = requireAbortSignal(options.signal ?? null);
    if (signal?.aborted) throw abortReason(signal);
    return this._deliverWith(this.varFieldLoader, this._deliverableDescriptors(fieldIndices), options, signal,
      (loader, descriptors, downloadSignal, owner) => loader.deliverSparseColumns(descriptors, delivery, { signal: downloadSignal, owner }));
  }

  /**
   * `deliverVarSparseColumns` from an expression matrix other than the
   * mapped one (`openExpressionMatrix`).
   *
   * @param {{generation: number, fields: ReadonlyArray<Object>, loader: Function}} matrix
   * @param {number[]} genes - Positions in `matrix.fields`
   * @param {Object} delivery
   * @param {{signal?: AbortSignal|null, priority?: string, owner?: string|null}} [options]
   * @returns {Promise<{bytes: number[]}>}
   */
  async deliverMatrixSparseColumns(matrix, genes, delivery, options = {}) {
    const signal = requireAbortSignal(options.signal ?? null);
    if (signal?.aborted) throw abortReason(signal);
    return this._deliverWith(requireOpenMatrix(this, matrix).loader, matrixDescriptors(matrix, genes), options, signal,
      (loader, descriptors, downloadSignal, owner) => loader.deliverSparseColumns(descriptors, delivery, { signal: downloadSignal, owner }));
  }

  /**
   * Some genes in some cells (`readVarCellSubset`), each run of genes
   * delivered to its analysis worker. One of a long run's reads.
   *
   * @param {number[]} fieldIndices - Deliverable var fields
   * @param {ArrayLike<number>} cells
   * @param {Object} delivery
   * @param {{signal?: AbortSignal|null, owner?: string|null, runGenes?: number|null}} [options]
   * @returns {Promise<{bytes: number}>}
   */
  async deliverVarCellSubset(fieldIndices, cells, delivery, options = {}) {
    const signal = requireAbortSignal(options.signal ?? null);
    if (signal?.aborted) throw abortReason(signal);
    return this._deliverWith(this.varFieldLoader, this._deliverableDescriptors(fieldIndices), { ...options, priority: 'bulk' }, signal,
      (loader, descriptors, downloadSignal, owner) => loader.deliverCellSubset(descriptors, cells, delivery, { signal: downloadSignal, owner, runGenes: options.runGenes ?? null }));
  }

  /**
   * `deliverVarCellSubset` from an expression matrix other than the mapped one.
   *
   * @returns {Promise<{bytes: number}>}
   */
  async deliverMatrixCellSubset(matrix, genes, cells, delivery, options = {}) {
    const signal = requireAbortSignal(options.signal ?? null);
    if (signal?.aborted) throw abortReason(signal);
    return this._deliverWith(requireOpenMatrix(this, matrix).loader, matrixDescriptors(matrix, genes), { ...options, priority: 'bulk' }, signal,
      (loader, descriptors, downloadSignal, owner) => loader.deliverCellSubset(descriptors, cells, delivery, { signal: downloadSignal, owner, runGenes: options.runGenes ?? null }));
  }

  /** The descriptors of deliverable var fields. @private */
  _deliverableDescriptors(fieldIndices) {
    return fieldIndices.map(index => {
      if (!this.isVarFieldDeliverable(index)) {
        throw new RangeError(`Var field ${index} has no payload of its own to deliver.`);
      }
      return this._varFieldDescriptors[index];
    });
  }

  /** One delivery, through the download scheduler. @private */
  _deliverWith(loader, descriptors, options, signal, start) {
    if (typeof loader?.deliverSparseColumns !== 'function') {
      throw new Error('This dataset cannot deliver genes to analysis workers.');
    }
    return fetchSchedulerOf(this).run({
      key: {},
      priority: options.priority ?? 'normal',
      signal,
      start: downloadSignal => start(loader, descriptors, downloadSignal, options.owner ?? null)
    });
  }

  /**
   * Unload a var field (gene) to free memory.
   *
   * Note: Genes loaded for bulk analyses (e.g., differential expression) can otherwise
   * accumulate in memory because loaded arrays are referenced from `varData.fields`.
   *
   * @param {number} fieldIndex - Index of the field in varData.fields
   * @param {Object} [options]
   * @param {boolean} [options.preserveActive=true] - If true, do not unload an active gene field
   * @returns {boolean} True if unloaded
   */
  unloadVarField(fieldIndex, options = {}) {
    const { preserveActive = true } = options;

    if (!Number.isInteger(fieldIndex) || fieldIndex < 0) return false;

    const isActiveInCurrent =
      this.activeFieldSource === 'var' && this.activeVarFieldIndex === fieldIndex;

    if (preserveActive && isActiveInCurrent) {
      return false;
    }

    // If this field is active in any saved view context, optionally preserve it too.
    if (preserveActive) {
      for (const ctx of this.viewContexts.values()) {
        if (!ctx) continue;
        if (ctx.activeFieldSource === 'var' && ctx.activeVarFieldIndex === fieldIndex) {
          return false;
        }
      }
    }

    const field = this.varData?.fields?.[fieldIndex];
    if (!field) return false;

    const cacheKey = field._originalKey || field.key || String(fieldIndex);

    // Clear LRU reference first so it doesn't keep the ArrayBuffer alive.
    this._varFieldDataCache?.delete?.(cacheKey);
    abortSharedLoad(
      field,
      `Gene "${field.key}" was unloaded before loading completed.`
    );

    const clearFieldState = (f) => {
      if (!f) return;
      f.values = null;
      f.loaded = false;
      f._loadingPromise = null;
      f._loadingSignal = null;
    };

    // Clear from current varData
    clearFieldState(field);

    // Clear from all stored view contexts (they clone field objects but may share values refs)
    for (const ctx of this.viewContexts.values()) {
      const ctxField = ctx?.varData?.fields?.[fieldIndex];
      if (!ctxField) continue;
      if ((ctxField.key || String(fieldIndex)) === cacheKey) {
        clearFieldState(ctxField);
      }
    }

    // If the gene was active and we were asked to unload anyway, reset active state.
    if (isActiveInCurrent && !preserveActive && typeof this.clearActiveField === 'function') {
      try {
        this.clearActiveField();
      } catch (err) {
        console.warn('[DataState] Failed to clear active field after unload:', err);
      }
    }

    return true;
  }

  setActiveField(fieldIndex) {
    const nextField = this.obsData?.fields?.[fieldIndex];
    if (!nextField || nextField._isDeleted === true) return null;
    const field = nextField;
    // Refused before anything changes: the view stays what it shows.
    if (!field.loaded) {
      throw new Error(`Field "${field.key}" not loaded yet.`);
    }
    this.activeFieldIndex = fieldIndex;
    this.activeVarFieldIndex = -1;
    this.activeFieldSource = 'obs';

    if (field.kind === 'continuous') {
      this.updateColorsContinuous(field);
      this.clearCentroids();
    } else {
      this.updateColorsCategorical(field);
      // Its colours are now written whole; a recolour this batch still owes
      // it (restored filter colours) is already in them.
      if (this._batchMode === true) this._batchDirty.affectedFields.delete(field);
      this.buildCentroidsForField(field, {
        viewId: this.activeViewId,
        layoutKey: this.getViewLayoutKey(this.activeViewId)
      });
    }

    if (field.outlierQuantiles !== undefined && field.outlierQuantiles !== null) {
      // Proven once per decoded array; every later filter pass reads it as is.
      requireOutlierQuantiles(field.outlierQuantiles, this.pointCount);
      if (field.outlierQuantiles.length > 0 && field._outlierThreshold == null) {
        field._outlierThreshold = 1.0;
      }
    }

    this._pushColorsToViewer();
    this._pushCentroidsToViewer();
    this.computeGlobalVisibility();
    this._syncActiveContext();
    this._pushActiveViewLabelToViewer();
    releaseInactiveFieldsOverBudget(this);

    const currentCentroids = this._getCentroidsForActiveLayout(field);
    const centroidInfo =
      field.kind === 'category' && currentCentroids.length > 0 ? ` • Centroids: ${currentCentroids.length}` : '';
    return {
      field,
      pointCount: this.pointCount,
      centroidInfo
    };
  }

  setActiveVarField(fieldIndex) {
    const nextField = this.varData?.fields?.[fieldIndex];
    if (!nextField || nextField._isDeleted === true) return null;
    const field = nextField;
    // Refused before anything changes: the view stays what it shows.
    if (!field.loaded) {
      throw new Error(`Var field "${field.key}" not loaded yet.`);
    }
    this.activeVarFieldIndex = fieldIndex;
    this.activeFieldIndex = -1;
    this.activeFieldSource = 'var';

    // Gene expression is always continuous
    this.updateColorsContinuous(field);
    this.clearCentroids();

    this._pushColorsToViewer();
    this._pushCentroidsToViewer();
    this.computeGlobalVisibility();
    this._syncActiveContext();
    this._pushActiveViewLabelToViewer();
    releaseInactiveFieldsOverBudget(this);

    return {
      field,
      pointCount: this.pointCount,
      centroidInfo: ''
    };
  }

  /**
   * Colour the view by a gene's values on the cells read so far, while its
   * gene index is built (`ensureVarFieldLoaded`'s `onPartial`): the cells
   * not read yet are NaN and are drawn as not read (`UNREAD_ALPHA_BYTE`,
   * faded beneath the cells read). Only the colours change -- the
   * gene is not loaded, so nothing else (filters, analysis, sessions) ever
   * sees partial values -- and once it is loaded whole, showing it
   * (`setActiveVarField`) writes every colour again.
   *
   * @param {number} fieldIndex
   * @param {Float32Array|import('../../../../data/column-forms.js').ColumnForm} column -
   *   The cells read so far: their sparse form (`readRows` the cells read),
   *   or one value an open cell (NaN on the cells not read)
   * @returns {boolean} Whether the colours were written
   */
  showPartialVarField(fieldIndex, column) {
    const field = this.varData?.fields?.[fieldIndex];
    if (!field || field.loaded === true) return false;
    if (isColumnForm(column)) requireColumnForm(column, this.pointCount);
    else if (!(column instanceof Float32Array) || column.length !== this.pointCount) return false;
    // A form says which cells it read; a column's NaN tail is its cells not read.
    const readRows = isColumnForm(column) ? column.readRows : unreadTailOf(column);
    this.updateColorsContinuous({ ...field, values: column }, { expression: true, readRows });
    this._pushColorsToViewer();
    return true;
  }

  /**
   * Write the colours of the field shown again: a gene's partial colours
   * (`showPartialVarField`) were drawn and its load stopped or failed.
   */
  restoreActiveFieldColors() {
    if (this.activeFieldSource === 'var' && this.activeVarFieldIndex >= 0) return this.setActiveVarField(this.activeVarFieldIndex);
    if (this.activeFieldSource === 'obs' && this.activeFieldIndex >= 0) return this.setActiveField(this.activeFieldIndex);
    return this.clearActiveField();
  }

  getContinuousFieldRef(fieldIndex) {
    if (this.activeFieldSource === 'var' && this.activeVarFieldIndex >= 0) {
      const field = this.varData?.fields?.[this.activeVarFieldIndex];
      return { field, source: 'var', index: this.activeVarFieldIndex };
    }
    const idx = fieldIndex != null ? fieldIndex : this.activeFieldIndex;
    if (idx == null || idx < 0) return { field: null, source: null, index: -1 };
    const field = this.obsData?.fields?.[idx];
    return { field, source: 'obs', index: idx };
  }
}
