/**
 * @fileoverview Where one dataset's outlier quantiles come from: read from
 * the file when it stores them for the latent space in use, computed in the
 * reader worker otherwise. One rule either way (`data/latent-outliers.js`),
 * so both give the same bytes.
 *
 * - **Stored.** `prepare()` and `cellucid_prepare()` write every categorical
 *   field's quantiles in their latent space into
 *   `uns['cellucid']['outlierQuantiles']` (a few MB a field). They are used
 *   when the latent space in use and the fewest cells a category needs
 *   (`minPoints`) are the ones they were written for, and when they fit the
 *   field's categories as the file holds them now (`storedQuantilesDefect`):
 *   a file whose obs was changed after it was prepared gets them computed.
 * - **Computed.** Any other file, or another latent space: the whole latent
 *   space is read, once — every field asked for at about the same time is
 *   computed in the same passes, and the worker keeps the latent space while
 *   it fits its memory budget, so every later field reads nothing.
 *
 * `describe` says which it will be and what it costs before anything is read,
 * so the outlier control can say so; `quantiles` gets them. Both are
 * cancellable through their signals: a computation stops once no caller
 * still waits for it.
 *
 * @module data/outlier-quantile-source
 */

import { storedQuantilesDefect } from './latent-outliers.js';

/** An `AbortError` for a caller whose signal aborted. */
function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name === 'AbortError') return reason;
  return new DOMException('The outlier quantiles were cancelled.', 'AbortError');
}

/**
 * The outlier quantiles of one open dataset.
 */
export class OutlierQuantileSource {
  /**
   * @param {{
   *   loader: {nObs: number, latentOutlierQuantiles: Function, readStoredOutlierQuantiles: Function,
   *     storedOutlierQuantilesBytes: Function, describeLatentOutliers: Function},
   *   stored: import('./anndata-cellucid-metadata.js').StoredOutlierQuantiles|null,
   *   minPoints: number
   * }} options
   */
  constructor({ loader, stored, minPoints }) {
    this._loader = loader;
    this._stored = stored;
    this.minPoints = minPoints;
    /** Fields whose stored quantiles did not fit them, by field key: computed instead. */
    this._unfit = new Map();
    /** @type {Map<string, {fields: Array, controller: AbortController, waiting: number, timer: any}>} */
    this._batches = new Map();
    /** The worker computation running in each latent space. */
    this._running = new Map();
    this._closed = false;
  }

  /** The latent space the file stores quantiles for, when they apply to this rule; else null. */
  get storedLatentKey() {
    return this._stored !== null && this._stored.minPoints === this.minPoints ? this._stored.latentKey : null;
  }

  /** Whether the file stores usable quantiles of `fieldKey` in `latentKey`. */
  isStored(latentKey, fieldKey) {
    return this.storedLatentKey === latentKey
      && this._stored.fields.get(fieldKey) === this._loader.nObs
      && !this._unfit.has(fieldKey);
  }

  /**
   * What getting one field's quantiles in one latent space costs, before
   * anything is read:
   * - `{source: 'stored', latentKey, bytes}`: read from the file (`bytes`
   *   stored, null when the store cannot say);
   * - `{source: 'held', latentKey}`: computed from the latent space the
   *   worker keeps, reading nothing;
   * - `{source: 'read', latentKey, storedBytes, valueBytes, kept, storedLatentKey}`:
   *   the whole latent space is read (its stored bytes, null when unknown,
   *   and its bytes as values); `kept` says whether it is then kept, so every
   *   later field reads nothing; `storedLatentKey` names another latent space
   *   the file stores quantiles for, or null.
   *
   * @param {{latentKey: string, width: number, fieldKey: string, signal?: AbortSignal|null}} request
   */
  async describe({ latentKey, width, fieldKey, signal = null }) {
    if (this.isStored(latentKey, fieldKey)) {
      const bytes = await this._loader.storedOutlierQuantilesBytes(fieldKey, { signal });
      return { source: 'stored', latentKey, bytes };
    }
    const cost = await this._loader.describeLatentOutliers(latentKey, width, { signal });
    if (cost.held) return { source: 'held', latentKey };
    return {
      source: 'read',
      latentKey,
      storedBytes: cost.storedBytes,
      valueBytes: cost.valueBytes,
      kept: cost.kept,
      storedLatentKey: this.storedLatentKey,
    };
  }

  /**
   * One field's quantiles in one latent space, as the rule gives them (NaN
   * where a cell has none).
   *
   * @param {{latentKey: string, width: number, fieldKey: string,
   *   codes: Uint8Array|Uint16Array|Uint32Array, nCategories: number, signal?: AbortSignal|null}} request
   * @returns {Promise<Float32Array>}
   */
  async quantiles({ latentKey, width, fieldKey, codes, nCategories, signal = null }) {
    if (signal?.aborted) throw abortError(signal);
    if (this.isStored(latentKey, fieldKey)) {
      const stored = await this._loader.readStoredOutlierQuantiles(fieldKey, { signal });
      const defect = storedQuantilesDefect(stored, codes, nCategories, this.minPoints);
      if (defect === null) return stored;
      // Written for other categories than the file's obs holds now.
      this._unfit.set(fieldKey, defect);
      console.warn(
        `[cellucid:outliers] The outlier quantiles uns['cellucid']['outlierQuantiles'] stores for obs['${fieldKey}'] ` +
        `do not fit its categories (${defect}); they are computed from obsm['${latentKey}'] instead.`
      );
    }
    return this._compute({ latentKey, width, codes, nCategories, signal });
  }

  /**
   * Compute in the worker, with every other field asked for in this latent
   * space before the batch starts (the same task, the next macrotask): one
   * read of the latent space serves them all.
   * @private
   */
  _compute({ latentKey, width, codes, nCategories, signal }) {
    if (this._closed) return Promise.reject(new Error('The dataset was closed.'));
    let batch = this._batches.get(latentKey);
    if (batch === undefined || batch.width !== width) {
      batch = { width, fields: [], controller: new AbortController(), waiting: 0, timer: null };
      this._batches.set(latentKey, batch);
      batch.timer = setTimeout(() => this._run(latentKey, batch), 0);
    }
    const open = batch;
    return new Promise((resolve, reject) => {
      const member = { codes, nCategories, resolve, reject, settled: false };
      open.fields.push(member);
      open.waiting += 1;
      if (signal === null) {
        // A caller that cannot cancel keeps the batch running.
        open.waiting = Number.POSITIVE_INFINITY;
        return;
      }
      const leave = () => {
        if (member.settled) return;
        member.settled = true;
        reject(abortError(signal));
        open.waiting -= 1;
        if (open.waiting <= 0) {
          open.controller.abort(abortError(signal));
          if (this._batches.get(latentKey) === open) {
            clearTimeout(open.timer);
            this._batches.delete(latentKey);
          }
        }
      };
      if (signal.aborted) leave();
      else signal.addEventListener('abort', leave, { once: true });
    });
  }

  /**
   * Start one batch once the batch before it in the same latent space has
   * ended (it may leave the latent space kept, so this one reads nothing);
   * fields asked for meanwhile join it.
   * @private
   */
  async _run(latentKey, batch) {
    const previous = this._running.get(latentKey);
    if (previous !== undefined) await previous.catch(() => {});
    if (this._batches.get(latentKey) === batch) this._batches.delete(latentKey);
    const members = batch.fields.filter(member => !member.settled);
    if (members.length === 0 || batch.controller.signal.aborted || this._closed) return;
    const running = this._loader.latentOutlierQuantiles(
      latentKey,
      batch.width,
      members.map(({ codes, nCategories }) => ({ codes, nCategories })),
      this.minPoints,
      { signal: batch.controller.signal }
    );
    this._running.set(latentKey, running);
    try {
      const results = await running;
      members.forEach((member, index) => {
        if (member.settled) return;
        member.settled = true;
        member.resolve(results[index]);
      });
    } catch (error) {
      for (const member of members) {
        if (member.settled) continue;
        member.settled = true;
        member.reject(error);
      }
    } finally {
      if (this._running.get(latentKey) === running) this._running.delete(latentKey);
    }
  }

  /** Stop: every waiting caller is refused, and nothing more is computed. */
  close() {
    this._closed = true;
    for (const batch of this._batches.values()) {
      clearTimeout(batch.timer);
      batch.controller.abort();
      for (const member of batch.fields) {
        if (member.settled) continue;
        member.settled = true;
        member.reject(new DOMException('The dataset was closed.', 'AbortError'));
      }
    }
    this._batches.clear();
  }
}
