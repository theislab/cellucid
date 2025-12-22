/**
 * @fileoverview Outlier-related color helpers for DataState.
 *
 * Kept separate from the core color buffer update logic so the main color
 * manager stays focused on performance-critical per-point color computation.
 *
 * @module state/managers/color-outliers
 */

export const colorOutlierMethods = {
  setOutlierThresholdForActive(threshold) {
    const field = this.getActiveField();
    if (!field || !field.outlierQuantiles || !field.outlierQuantiles.length) return;
    field._outlierThreshold = threshold;
    this._pushOutlierThresholdToViewer(threshold);
    this.updateOutlierQuantiles();
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
    if (!field || !field.outlierQuantiles || !field.outlierQuantiles.length) return false;
    if (field._outlierFilterEnabled === false) return false;
    const threshold = field._outlierThreshold != null ? field._outlierThreshold : 1.0;
    return threshold < 0.9999;
  },

  getCurrentOutlierThreshold() {
    const field = this.getActiveField();
    if (field && field._outlierThreshold != null) return field._outlierThreshold;
    return 1.0;
  }
};

