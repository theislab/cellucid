/**
 * @fileoverview Outlier-related color helpers for DataState.
 *
 * Kept separate from the core color buffer update logic so the main color
 * manager stays focused on performance-critical per-point color computation.
 *
 * @module state/managers/color-outliers
 */

/**
 * Quantile arrays already proven to hold only the -1 sentinel or values in
 * [0, 1]. Decoded field arrays are never written in place once published (a
 * changed field gets a new array), so one proof per array holds for its whole
 * lifetime instead of a dataset-length rescan on every filter pass.
 */
const PROVEN_OUTLIER_QUANTILES = new WeakSet();

/**
 * Require one exact Float32 outlier quantile per observation.
 *
 * @param {unknown} quantiles
 * @param {number} pointCount
 * @returns {Float32Array}
 */
export function requireOutlierQuantiles(quantiles, pointCount) {
  if (!(quantiles instanceof Float32Array) || quantiles.length !== pointCount) {
    throw new TypeError(
      'Active outlier filtering requires one Float32 quantile per observation.'
    );
  }
  if (PROVEN_OUTLIER_QUANTILES.has(quantiles)) return quantiles;
  for (let index = 0; index < quantiles.length; index++) {
    const quantile = quantiles[index];
    if (
      !Number.isFinite(quantile)
      || (quantile !== -1 && (quantile < 0 || quantile > 1))
    ) {
      throw new RangeError(
        `Active-field outlier quantile ${index} must be -1 or a finite value from 0 through 1.`
      );
    }
  }
  PROVEN_OUTLIER_QUANTILES.add(quantiles);
  return quantiles;
}

/**
 * Whether outlier quantiles hold at least one available value. An unavailable
 * quantile is -1, and a field where no category reached `centroid_min_points`
 * has nothing but those, so its control would filter nothing. Remembered per
 * array: the scan stops at the first available value, and an all-unavailable
 * array is scanned once.
 */
const OUTLIER_AVAILABILITY = new WeakMap();
export function hasAvailableOutlierQuantile(quantiles) {
  if (!quantiles || quantiles.length === 0) return false;
  let available = OUTLIER_AVAILABILITY.get(quantiles);
  if (available === undefined) {
    available = false;
    for (let index = 0; index < quantiles.length; index++) {
      if (quantiles[index] >= 0) {
        available = true;
        break;
      }
    }
    OUTLIER_AVAILABILITY.set(quantiles, available);
  }
  return available;
}

export const colorOutlierMethods = {
  /**
   * Set the active categorical field's outlier threshold. The field's
   * quantiles are got on the first threshold below 1 (never when the field
   * is picked: `state/managers/outlier-quantiles.js`); the filter applies
   * once they arrive, at the threshold the control holds by then. Cancelled
   * or failed, the threshold is back at 1 and the field's outlier status
   * says why.
   *
   * @param {number} threshold
   * @returns {Promise<void>} Settles once the threshold is applied, or the
   *   quantiles were cancelled or failed.
   */
  async setOutlierThresholdForActive(threshold) {
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      throw new RangeError('Outlier threshold must be a finite value from 0 through 1.');
    }
    const field = this.getActiveField();
    if (!field || this.activeFieldSource !== 'obs' || field.kind !== 'category') return;
    const fieldIndex = this.activeFieldIndex;
    if (!(field.outlierQuantiles instanceof Float32Array)) {
      const { state } = this.getOutlierFilterStatus(fieldIndex);
      if (state !== 'available' && state !== 'running' && state !== 'failed') return;
      field._outlierThreshold = threshold;
      if (threshold >= 0.9999) return;
      let quantiles;
      try {
        quantiles = await this.ensureOutlierQuantiles(fieldIndex);
      } catch {
        // Cancelled or failed: the outlier status says which, and why.
        return;
      }
      if (quantiles === null || this.getActiveField() !== field) return;
      this.computeGlobalVisibility();
      return;
    }
    if (!field.outlierQuantiles.length) return;
    field._outlierThreshold = threshold;
    this.computeGlobalVisibility();
  },

  /**
   * Outlier filtering is only applicable when the active field provides
   * `outlierQuantiles` (latent-space outlier stats).
   *
   * User-defined categoricals never have these stats, so this prevents outlier
   * filtering from being applied silently when the UI control is hidden.
   * @returns {boolean}
   */
  isOutlierFilterEnabledForActiveField() {
    const field = this.getActiveField?.();
    if (
      this.activeFieldSource !== 'obs'
      || !field
      || field._isDeleted === true
      || !field.outlierQuantiles
      || !field.outlierQuantiles.length
    ) {
      return false;
    }
    if (field._outlierFilterEnabled === false) return false;
    const threshold = field._outlierThreshold != null ? field._outlierThreshold : 1.0;
    return threshold < 0.9999;
  },

  /**
   * The quantiles the active outlier filter reads, or null while it is off.
   *
   * This is the active field's own decoded array. No view keeps a copy: the
   * array is immutable once published, and every view that colours by the
   * field reads the same one.
   *
   * @returns {Float32Array|null}
   */
  getActiveOutlierQuantiles() {
    if (!this.isOutlierFilterEnabledForActiveField()) return null;
    return requireOutlierQuantiles(
      this.getActiveField().outlierQuantiles,
      this.pointCount
    );
  },

  getCurrentOutlierThreshold() {
    const field = this.getActiveField();
    if (field && field._outlierThreshold != null) return field._outlierThreshold;
    return 1.0;
  }
};
