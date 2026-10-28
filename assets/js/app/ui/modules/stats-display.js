/**
 * @fileoverview Sidebar stats display renderer.
 *
 * Responsible for updating the compact stats line showing the open cells
 * (of every cell, on a subsample) and the active field label. Kept as a tiny module so other UI areas can remain
 * focused (field selection, legend, filters, etc.).
 *
 * @module ui/modules/stats-display
 */

import { formatOpenCells } from '../../../utils/format-units.js';

/**
 * @typedef {object} FieldInfo
 * @property {object|null} field
 * @property {number} pointCount - The open cells
 * @property {number} [cellTotal] - Every cell of the dataset (a subsample opens fewer)
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
    const { field, pointCount, cellTotal, centroidInfo } = fieldInfo;
    // A subsample's open cells, said against every cell (`formatOpenCells`).
    const cells = formatOpenCells(pointCount, cellTotal);
    if (!field) {
      statsEl.textContent = `${cells} • Field: None`;
      return;
    }
    statsEl.textContent =
      `${cells} • Field: ${field.key} (${field.kind})${centroidInfo || ''}`;
  }

  return { updateStats };
}

