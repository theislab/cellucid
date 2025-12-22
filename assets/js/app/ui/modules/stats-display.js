/**
 * @fileoverview Sidebar stats display renderer.
 *
 * Responsible for updating the compact stats line showing point count and
 * active field label. Kept as a tiny module so other UI areas can remain
 * focused (field selection, legend, filters, etc.).
 *
 * @module ui/modules/stats-display
 */

/**
 * @typedef {object} FieldInfo
 * @property {object|null} field
 * @property {number} pointCount
 * @property {string} [centroidInfo]
 */

export function initStatsDisplay({ dom }) {
  const statsEl = dom?.el || null;

  /**
   * Update the stats line.
   * @param {FieldInfo|null} fieldInfo
   */
  function updateStats(fieldInfo) {
    if (!statsEl || !fieldInfo) return;
    const { field, pointCount, centroidInfo } = fieldInfo;
    if (!field) {
      statsEl.textContent = `Points: ${pointCount.toLocaleString()} • Field: None`;
      return;
    }
    statsEl.textContent =
      `Points: ${pointCount.toLocaleString()} • Field: ${field.key} (${field.kind})${centroidInfo || ''}`;
  }

  return { updateStats };
}

