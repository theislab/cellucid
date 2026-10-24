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
import { getReadActivityLog } from '../../../../data/read-activity-log.js';
import { abortReasonOf as abortReason, awaitWithSignal } from '../../../jobs/cancellable-job.js';
import { FieldKind, FieldSource } from '../../../utils/field-constants.js';
import { getFieldRegistry } from '../../../utils/field-registry.js';
import { adoptScientificFieldDescriptors } from './descriptor-ownership.js';
import { requireOutlierQuantiles } from '../color-outliers.js';
import {
  FetchScheduler,
  requirePriority
} from '../../../../data/fetch-scheduler.js';
import {
  releaseInactiveFieldsOverBudget,
  touchFieldResidency,
} from './residency.js';

const sharedLoadOwners = new WeakMap();

const DATASET_FIELD_LOAD_SUPERSEDED_CODE =
  'CELLUCID_DATASET_FIELD_LOAD_SUPERSEDED';

export function createDatasetFieldLoadSupersededError() {
  const error = new Error(
    'Field loading was superseded by a replacement dataset generation.'
  );
  error.name = 'AbortError';
  error.code = DATASET_FIELD_LOAD_SUPERSEDED_CODE;
  return error;
}

export function isDatasetFieldLoadSupersededError(error) {
  return error?.code === DATASET_FIELD_LOAD_SUPERSEDED_CODE;
}

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
    entry?.scheduler.close(createDatasetFieldLoadSupersededError());
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
  if (matrix.generation !== readDatasetGeneration(state)) throw createDatasetFieldLoadSupersededError();
  return matrix;
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
  const release = () => {
    if (released) return;
    released = true;
    signal?.removeEventListener('abort', release);
    owner.waiters.delete(lease);
    if (
      owner.settled === false
      && owner.waiters.size === 0
      && owner.controller.signal.aborted === false
    ) {
      owner.controller.abort(
        signal?.aborted === true
          ? abortReason(signal)
          : new DOMException(
              'Field loading has no remaining consumers.',
              'AbortError'
            )
      );
    }
  };
  owner.waiters.add(lease);
  signal?.addEventListener('abort', release, { once: true });
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
    throw createDatasetFieldLoadSupersededError();
  }
}

function abortSharedLoad(field, message) {
  const owner = sharedLoadOwners.get(field);
  if (
    owner?.task === field?._loadingPromise
    && owner.settled === false
    && owner.controller.signal.aborted === false
  ) {
    owner.controller.abort(new DOMException(message, 'AbortError'));
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
    throw createDatasetFieldLoadSupersededError();
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
 * its distinct values, a categorical's its stored dictionary), with the
 * colours its file stores for them, shown under their display names. A field
 * whose categories are known keeps them: the dataset codes a column one way
 * for its whole life.
 */
function adoptFoundCategories(state, field, categories, palette = null) {
  if (categories === undefined || field.categories !== null) return;
  if (!Array.isArray(categories)) {
    throw new TypeError(`Field "${field.key}" found categories must be an array.`);
  }
  if (Array.isArray(palette) && palette.length === categories.length) field.palette = palette;
  field.categories = [...categories];
  state._applyCategoryOverlay(
    field,
    FieldSource.OBS,
    field._originalKey || field.key,
    `obs field "${field.key}"`
  );
}

export class FieldLoadingMethods {
  setFieldLoader(loaderFn) {
    this.fieldLoader = loaderFn;
  }

  setVarFieldLoader(loaderFn) {
    this.varFieldLoader = loaderFn;
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
    const field = this.obsData?.fields?.[fieldIndex];
    if (!field) throw new Error(`Obs field ${fieldIndex} is not available.`);
    const cacheKey = field._originalKey || field.key || String(fieldIndex);

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
        throw createDatasetFieldLoadSupersededError();
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
      adoptFoundCategories(this, field, cached.categories, cached.palette);
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

    // Show loading notification (unless silent mode for batch operations)
    const notifications = getNotificationCenter();
    const notifId = silent ? null : notifications.loading(`Loading field: ${field.key}`, { category: 'data' });

    const sharedOwner = createSharedLoadOwner();
    const sharedSignal = sharedOwner.controller.signal;
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
        adoptFoundCategories(this, field, foundCategories, loadedData?.palette ?? null);
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
            : { categories: foundCategories, palette: loadedData?.palette ?? null })
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
          if (
            sharedSignal.aborted
            || isDatasetFieldLoadSupersededError(err)
          ) {
            notifications.dismiss(notifId);
          } else {
            notifications.fail(
              notifId,
              `Failed to load field: ${field.key}`
            );
          }
        }
        throw err;
      });

    sharedOwner.task = task;
    sharedLoadOwners.set(field, sharedOwner);
    observeSharedLoad(field, sharedOwner);
    field._loadingPromise = task;
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
   * @returns {Promise<Object>} The loaded field object
   */
  async ensureVarFieldLoaded(fieldIndex, options = {}) {
    const {
      signal: rawSignal = null,
      silent = false,
      priority = 'normal',
      owner: readOwner = null
    } = options;
    requirePriority(priority);
    const signal = requireAbortSignal(rawSignal);
    if (signal?.aborted) throw abortReason(signal);
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
        throw createDatasetFieldLoadSupersededError();
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
        return subscribeToSharedLoad(activeOwner, signal);
      }
      if (activeOwner?.task !== field._loadingPromise) {
        return awaitWithSignal(field._loadingPromise, signal);
      }
    }
    if (!this.varFieldLoader) throw new Error(`No loader configured for var field "${field.key}".`);

    const cached = this._varFieldDataCache.get(cacheKey);
    if (cached) {
      if (cached.values) field.values = cached.values;
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

    // Show loading notification for gene expression (unless silent mode for batch operations)
    const notifications = getNotificationCenter();
    const notifId = silent ? null : notifications.loading(`Loading gene: ${field.key}`, { category: 'data' });

    const sharedOwner = createSharedLoadOwner();
    const sharedSignal = sharedOwner.controller.signal;
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
              key: sharedOwner.readKey
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
        if (notifId) {
          if (
            sharedSignal.aborted
            || isDatasetFieldLoadSupersededError(err)
          ) {
            notifications.dismiss(notifId);
          } else {
            notifications.fail(
              notifId,
              `Failed to load gene: ${field.key}`
            );
          }
        }
        throw err;
      });

    sharedOwner.task = task;
    sharedLoadOwners.set(field, sharedOwner);
    observeSharedLoad(field, sharedOwner);
    field._loadingPromise = task;
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
   * @param {{signal?: AbortSignal|null, owner?: string|null}} [options]
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
        owner: options.owner ?? null
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
   * @param {{signal?: AbortSignal|null, owner?: string|null}} [options] -
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
        owner: options.owner ?? null
      })
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
    this.activeFieldIndex = fieldIndex;
    this.activeVarFieldIndex = -1;
    this.activeFieldSource = 'obs';
    const field = nextField;
    if (!field.loaded) {
      throw new Error(`Field "${field.key}" not loaded yet.`);
    }

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
    this.activeVarFieldIndex = fieldIndex;
    this.activeFieldIndex = -1;
    this.activeFieldSource = 'var';
    const field = nextField;
    if (!field.loaded) {
      throw new Error(`Var field "${field.key}" not loaded yet.`);
    }

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
