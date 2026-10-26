/**
 * @fileoverview Getting each categorical field's outlier quantiles, as one
 * explicit, cancellable operation the interface can describe at every step.
 *
 * A categorical obs field's outlier filter needs its outlier quantiles in the
 * dataset's latent space (`data/latent-outliers.js` is the rule). They are
 * got on the filter's first use, never when the field is picked: read from
 * the file when it stores them (a few MB), else computed in the reader worker
 * by reading the whole latent space once (`data/outlier-quantile-source.js`).
 * This module runs that as one job per field and says, at any moment, where
 * each field stands (`getOutlierFilterStatus`):
 *
 * - `none`: not a categorical field of the file (a numeric or user-defined
 *   field): no outlier filter.
 * - `no-latent`: no latent space is chosen; `suggestions` are the file's
 *   `obsm` arrays that look like one (more than three columns), never chosen
 *   for the person.
 * - `too-small`: no category has `minPoints` cells (`largest` is the biggest).
 * - `available`: not got yet; `plan` says what getting them costs
 *   (`OutlierQuantileSource.describe`), null until known.
 * - `running`: being got; `progress` is the latest read activity of it
 *   (bytes of how many, rate, time left), `plan` what it was to cost.
 * - `ready`: got; the filter works at once.
 * - `failed`: getting them failed; `message` says why. Using the filter
 *   again tries again; `latentUnusable` says the latent space itself cannot
 *   be read (a NaN), so another must be chosen.
 *
 * Each job is a `CancellableJob` (`app/jobs/cancellable-job.js`, the one
 * mechanism every expensive run uses): it is cancelled by
 * `cancelOutlierQuantiles` (the outlier control's Cancel) or its progress
 * notification's Cancel: its reads stop in the worker, nothing it got is
 * kept, and every view's threshold of the field is back at 100%, as before
 * the job; it can be started again. A job that fails leaves the same state
 * and says why. `outliers:status` is emitted at every change.
 *
 * @module state/managers/outlier-quantiles
 */

import { CancellableJob, awaitWithSignal, isCancellation } from '../../jobs/cancellable-job.js';
import { categorySizes } from '../../../data/latent-outliers.js';
import { latentReadLabel } from '../../../data/latent-outliers-stream.js';
import { MappingLoadError, obsmWidth, parseMappingLatentPath } from '../../../data/data-mapping-candidates.js';
import { vectorFieldKeys } from '../../../data/data-mapping.js';
import { hasAvailableOutlierQuantile, requireOutlierQuantiles } from './color-outliers.js';
import { formatBytes, formatDuration } from '../../../utils/format-units.js';

/** Thresholds at or above this filter nothing. */
const NO_FILTER = 0.9999;

/**
 * Names that mark an `obsm` array as a latent space, most telling first, so
 * the likeliest candidates are suggested first.
 */
const LATENT_NAME_HINTS = Object.freeze([
  /scanvi/i, /scvi/i, /totalvi/i, /multivi/i, /harmony/i, /scanorama/i, /mofa/i, /pca/i, /lsi/i, /latent/i, /emb/i,
]);

/**
 * Names that mark an `obsm` array as positions, not a latent space: a
 * segmentation export's 4-column `coordinates` (pixel boxes) is wider than an
 * embedding, but no distance in it says how unlike its category a cell is.
 * Such an array is still in the Latent space menu; it is only not suggested.
 */
const POSITION_NAME_HINTS = Object.freeze([/spatial/i, /coord/i]);

function hintRank(key) {
  const rank = LATENT_NAME_HINTS.findIndex(pattern => pattern.test(key));
  return rank < 0 ? LATENT_NAME_HINTS.length : rank;
}

/** Category sizes of one codes array, computed once per array. */
const SIZES = new WeakMap();
function sizesOf(codes, nCategories, minPoints) {
  let byRule = SIZES.get(codes);
  if (byRule === undefined) {
    byRule = new Map();
    SIZES.set(codes, byRule);
  }
  const key = `${nCategories}:${minPoints}`;
  if (!byRule.has(key)) byRule.set(key, categorySizes(codes, nCategories, minPoints));
  return byRule.get(key);
}

/** What a plan costs in words: `54 MB`, or the values' size when the stored one is not known. */
export function describePlanBytes(plan) {
  if (plan?.source === 'stored') return plan.bytes === null ? null : formatBytes(plan.bytes);
  if (plan?.source !== 'read') return null;
  if (plan.storedBytes !== null) return formatBytes(plan.storedBytes);
  return plan.valueBytes === null ? null : `${formatBytes(plan.valueBytes)} of values`;
}

export class DataStateOutlierQuantileMethods {
  /** @private */
  _outlierRegistry() {
    if (!(this._outlierJobs instanceof Map)) {
      this._outlierJobs = new Map();
      this._outlierPlans = new Map();
      this._outlierFailures = new Map();
    }
    return this;
  }

  /**
   * The descriptor of an obs field the file holds, when it is that field
   * (a user-defined field has none), else null. @private
   */
  _outlierDescriptor(fieldIndex) {
    const field = this.obsData?.fields?.[fieldIndex];
    if (!field || field.kind !== 'category' || field._isDeleted === true) return null;
    const descriptor = this._obsFieldDescriptors?.[fieldIndex];
    if (descriptor?.kind !== 'category') return null;
    return descriptor.key === (field._originalKey ?? field.key) ? descriptor : null;
  }

  /**
   * The latent space a descriptor's outlier route measures in: the route
   * names it, whatever the data mapping says while a new one is applied.
   * @private
   */
  _outlierLatentKey(descriptor) {
    const route = parseMappingLatentPath(descriptor?.outlierQuantilesPath);
    if (route === null) return null;
    return this.getMappingCandidates?.()?.obsm?.[route.obsmIndex]?.key ?? null;
  }

  /**
   * The `obsm` arrays that look like a latent space, likeliest first: wider
   * than an embedding, not a vector field, not named as positions. @private
   */
  _latentSuggestions() {
    const candidates = this.getMappingCandidates?.() ?? null;
    if (candidates === null) return [];
    const usable = new Set(
      (this.getMappingGroupChoices?.('latent') ?? [])
        .filter(choice => choice.value !== null && choice.usable)
        .map(choice => choice.value)
    );
    const vectors = vectorFieldKeys(candidates.obsm.map(item => item.key));
    return candidates.obsm
      .filter(item => (
        usable.has(item.key)
        && !vectors.has(item.key)
        && (obsmWidth(item) ?? 0) > 3
        && !POSITION_NAME_HINTS.some(pattern => pattern.test(item.key))
      ))
      .map(item => ({ key: item.key, width: obsmWidth(item) }))
      .sort((a, b) => hintRank(a.key) - hintRank(b.key) || a.key.localeCompare(b.key));
  }

  /** What getting a descriptor's quantiles costs, once known; asks for it once. @private */
  _outlierPlan(descriptor) {
    const plans = this._outlierRegistry()._outlierPlans;
    if (plans.has(descriptor)) {
      const plan = plans.get(descriptor);
      return plan instanceof Promise ? null : plan;
    }
    const describe = this.fieldLoader?.describeOutlierQuantiles;
    if (typeof describe !== 'function') return null;
    const pending = describe(descriptor).then(
      plan => {
        if (plans.get(descriptor) !== pending) return;
        plans.set(descriptor, Object.freeze(plan));
        this.emit('outliers:status', { descriptor });
      },
      error => {
        // The plan only informs: getting the quantiles says what went wrong.
        if (plans.get(descriptor) === pending) plans.set(descriptor, null);
        console.warn(`[cellucid:outliers] Could not tell what the outlier quantiles of "${descriptor.key}" cost:`, error);
      }
    );
    plans.set(descriptor, pending);
    return null;
  }

  /**
   * Where one obs field's outlier filter stands (module states).
   *
   * @param {number} [fieldIndex] - The active field by default
   * @returns {Readonly<Object>}
   */
  getOutlierFilterStatus(fieldIndex = this.activeFieldIndex) {
    const field = this.obsData?.fields?.[fieldIndex];
    const descriptor = this._outlierDescriptor(fieldIndex);
    if (descriptor === null) return Object.freeze({ state: 'none' });
    const fieldKey = field.key;
    const latentKey = this._outlierLatentKey(descriptor);
    if (descriptor.outlierQuantilesPath === null) {
      return Object.freeze({ state: 'no-latent', fieldKey, suggestions: this._latentSuggestions() });
    }
    const registry = this._outlierRegistry();
    const minPoints = this.fieldLoader?.outlierMinPoints ?? null;
    const job = registry._outlierJobs.get(descriptor);
    if (job !== undefined) {
      return Object.freeze({
        state: 'running',
        fieldKey,
        latentKey,
        plan: job.plan,
        progress: job.cancellable.latestRead,
        startedAt: job.cancellable.startedAt,
      });
    }
    if (registry._outlierFailures.has(descriptor)) {
      const { message, latentUnusable } = registry._outlierFailures.get(descriptor);
      return Object.freeze({ state: 'failed', fieldKey, latentKey, message, latentUnusable });
    }
    const tooSmall = largest => Object.freeze({ state: 'too-small', fieldKey, latentKey, minPoints, largest });
    if (field.outlierQuantiles instanceof Float32Array) {
      if (hasAvailableOutlierQuantile(field.outlierQuantiles)) return Object.freeze({ state: 'ready', fieldKey, latentKey });
    }
    const categories = field.categories ?? null;
    if (Number.isSafeInteger(minPoints) && field.codes && Array.isArray(categories)) {
      const sizes = sizesOf(field.codes, categories.length, minPoints);
      if (sizes.scored === 0) return tooSmall(sizes.largest);
    }
    return Object.freeze({ state: 'available', fieldKey, latentKey, plan: this._outlierPlan(descriptor) });
  }

  /**
   * One obs field's outlier quantiles, got once for every view (read from
   * the file, else computed: module overview) and shared by every view's
   * copy of the field and the field cache. Null when the field has none (no
   * latent space, not a field of the file) or the dataset or its latent space
   * was replaced meanwhile. Rejects with an `AbortError` when the job was
   * cancelled or `signal` aborted (the job goes on for other callers), and
   * with the failure otherwise.
   *
   * @param {number} fieldIndex
   * @param {{signal?: AbortSignal|null}} [options]
   * @returns {Promise<Float32Array|null>}
   */
  async ensureOutlierQuantiles(fieldIndex, { signal = null } = {}) {
    const field = this.obsData?.fields?.[fieldIndex];
    if (field?.outlierQuantiles instanceof Float32Array) return field.outlierQuantiles;
    const descriptor = this._outlierDescriptor(fieldIndex);
    if (descriptor === null || descriptor.outlierQuantilesPath === null) return null;
    const job = this._outlierRegistry()._outlierJobs.get(descriptor) ?? this._startOutlierJob(fieldIndex, descriptor);
    return awaitWithSignal(job.promise, signal);
  }

  /**
   * Cancel getting one field's outlier quantiles: its reads stop, nothing is
   * kept, and its thresholds are back at 100%. Nothing happens when none is
   * being got.
   *
   * @param {number} [fieldIndex] - The active field by default
   * @returns {boolean} Whether a job was cancelled
   */
  cancelOutlierQuantiles(fieldIndex = this.activeFieldIndex) {
    const descriptor = this._outlierDescriptor(fieldIndex);
    const job = descriptor === null ? undefined : this._outlierRegistry()._outlierJobs.get(descriptor);
    if (job === undefined) return false;
    return job.cancellable.cancel();
  }

  /**
   * Retire every outlier job of the dataset being replaced: each is
   * cancelled (its reads of the latent space stop), and the plans and
   * failures recorded for its fields go with it. Called when another dataset
   * (or none) is published: a job left running would keep reading the old
   * latent space and then report on, or mark choices of, the new dataset.
   */
  retireOutlierJobs() {
    const registry = this._outlierRegistry();
    const jobs = [...registry._outlierJobs.values()];
    registry._outlierJobs.clear();
    registry._outlierPlans.clear();
    registry._outlierFailures.clear();
    for (const job of jobs) job.cancellable.cancel();
  }

  /**
   * Get the quantiles of every field whose outlier filter is in use (a
   * threshold below 100% in some view) and does not have them — after the
   * latent space changed — and recolour the views once each arrives. Each is
   * an ordinary job: it shows progress and can be cancelled.
   */
  resumeOutlierFilters() {
    const indexes = new Set();
    const lists = [this.obsData?.fields ?? []];
    for (const [viewId, context] of this.viewContexts ?? []) {
      if (viewId !== this.activeViewId && Array.isArray(context?.obsData?.fields)) lists.push(context.obsData.fields);
    }
    for (const fields of lists) {
      fields.forEach((field, index) => {
        if (field?._outlierThreshold != null && field._outlierThreshold < NO_FILTER) indexes.add(index);
      });
    }
    for (const index of indexes) {
      if (this.obsData?.fields?.[index]?.outlierQuantiles instanceof Float32Array) continue;
      this.ensureOutlierQuantiles(index).then(
        quantiles => {
          if (quantiles !== null) this._recolourCategoricalViews();
        },
        () => {
          // The job's own status and notification say what happened.
        }
      );
    }
  }

  /** @private */
  _startOutlierJob(fieldIndex, descriptor) {
    const registry = this._outlierRegistry();
    registry._outlierFailures.delete(descriptor);
    const fieldKey = this.obsData.fields[fieldIndex].key;
    const latentKey = this._outlierLatentKey(descriptor);
    const plan = this._outlierPlan(descriptor);
    const storedLabel = `stored outlier quantiles of obs['${descriptor.key}']`;
    const cancellable = new CancellableJob({
      title: `Outlier filter of "${fieldKey}"`,
      category: 'filter',
      readKind: 'outliers',
      // A latent space is read once for every field that waits on it
      // (`data/outlier-quantile-source.js`): each of their jobs follows it.
      ownsRead: activity => (latentKey !== null && activity.label.startsWith(latentReadLabel(latentKey)))
        || activity.label === storedLabel,
      // The outlier control says why it failed, every time.
      failureNotice: false,
    });
    cancellable.step(plan?.source === 'stored'
      ? 'Reading the stored outlier distances'
      : `Computing the outlier distances in ${latentKey}`);
    const job = { descriptor, fieldIndex, fieldKey, latentKey, plan, cancellable, promise: null };
    registry._outlierJobs.set(descriptor, job);
    cancellable.subscribe(() => {
      if (cancellable.running) this.emit('outliers:status', { descriptor });
    });

    const { signal } = cancellable;
    job.promise = (async () => {
      const loader = this.fieldLoader?.loadOutlierQuantiles;
      if (typeof loader !== 'function') throw new Error(`No outlier loader is configured for field "${fieldKey}".`);
      await this.ensureFieldLoaded(fieldIndex, { signal });
      const field = this.obsData?.fields?.[fieldIndex];
      const quantiles = await loader(descriptor, { codes: field?.codes ?? null, signal });
      // The dataset or its latent space was replaced meanwhile: these
      // quantiles belong to neither.
      if (this._obsFieldDescriptors?.[fieldIndex] !== descriptor) return null;
      requireOutlierQuantiles(quantiles, this.pointCount);
      this._installOutlierQuantiles(fieldIndex, quantiles);
      return quantiles;
    })();
    job.promise.then(
      () => this._endOutlierJob(job, null),
      error => this._endOutlierJob(job, error)
    );
    this.emit('outliers:status', { descriptor });
    return job;
  }

  /** Every view's copy of the field, and the field cache, get `quantiles`. @private */
  _installOutlierQuantiles(fieldIndex, quantiles) {
    const field = this.obsData.fields[fieldIndex];
    const lists = [this.obsData.fields];
    for (const [viewId, context] of this.viewContexts ?? []) {
      if (viewId !== this.activeViewId) lists.push(context?.obsData?.fields);
    }
    for (const fields of lists) {
      const copy = fields?.[fieldIndex];
      if (copy?.kind === 'category' && copy.key === field.key && copy.outlierQuantiles === undefined) {
        copy.outlierQuantiles = quantiles;
      }
    }
    const cacheKey = field._originalKey || field.key || String(fieldIndex);
    const cached = this._fieldDataCache?.get(cacheKey);
    if (cached) this._fieldDataCache.set(cacheKey, { ...cached, outlierQuantiles: quantiles });
  }

  /** Every view's threshold of the field back at 100%: no quantiles, no filter. @private */
  _resetOutlierThresholds(fieldIndex) {
    const lists = [this.obsData?.fields];
    for (const [viewId, context] of this.viewContexts ?? []) {
      if (viewId !== this.activeViewId) lists.push(context?.obsData?.fields);
    }
    for (const fields of lists) {
      const copy = fields?.[fieldIndex];
      if (copy?.kind === 'category' && copy._outlierThreshold != null && copy._outlierThreshold < NO_FILTER) {
        copy._outlierThreshold = 1;
      }
    }
  }

  /** @private */
  _endOutlierJob(job, error) {
    const registry = this._outlierRegistry();
    if (registry._outlierJobs.get(job.descriptor) === job) registry._outlierJobs.delete(job.descriptor);
    const { cancellable } = job;
    const current = this._obsFieldDescriptors?.[job.fieldIndex] === job.descriptor;
    if (error === null && !current) {
      // Its dataset or latent space was replaced: the quantiles were dropped.
      cancellable.cancel();
    } else if (error === null) {
      // A latent space read now may be kept: what the next field costs changed.
      registry._outlierPlans.clear();
      const fetched = cancellable.readTotals().fetched;
      const read = fetched > 0 ? `${formatBytes(fetched)} read, ` : '';
      cancellable.succeed(
        `Outlier filter of "${job.fieldKey}" ready (${read}${formatDuration(performance.now() - cancellable.startedAt)})`
      );
    } else {
      if (current) this._resetOutlierThresholds(job.fieldIndex);
      if (isCancellation(error)) {
        cancellable.cancel();
      } else {
        const message = error?.message ?? String(error);
        // A latent space that cannot be read (a NaN) fails again; anything
        // else (a dropped connection) may not.
        if (current) {
          registry._outlierFailures.set(job.descriptor, { message, latentUnusable: error instanceof MappingLoadError });
        }
        if (current && error instanceof MappingLoadError && job.latentKey !== null) {
          // The Data mapping list offers it no more, with its reason.
          this._markMappingChoiceUnusable?.('latent', job.latentKey, error.reason);
          this.emit('mapping:choices-changed', { group: 'latent' });
        }
        console.warn(`[cellucid:outliers] The outlier quantiles of "${job.fieldKey}" could not be got:`, error);
        cancellable.fail(error, `Outlier filter of "${job.fieldKey}" unavailable: ${message}`);
      }
      if (current && this.getActiveField?.() === this.obsData?.fields?.[job.fieldIndex]) {
        this.computeGlobalVisibility?.();
      }
    }
    this.emit('outliers:status', { descriptor: job.descriptor });
  }
}
