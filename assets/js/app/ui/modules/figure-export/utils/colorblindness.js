/**
 * @fileoverview Colorblind simulation utilities for figure export previews.
 *
 * Applies a simple 3×3 RGB matrix transform (Daltonize-style approximation)
 * to preview rasters so users can sanity-check accessibility before export.
 *
 * This is intentionally preview-only to avoid altering exported scientific
 * colors without explicit user intent.
 *
 * @module ui/modules/figure-export/utils/colorblindness
 */

/**
 * @typedef {'none'|'deuteranopia'|'protanopia'|'tritanopia'} ColorblindMode
 */

const MATRICES = /** @type {Record<Exclude<ColorblindMode,'none'>, number[][]>} */ ({
  deuteranopia: [
    [0.625, 0.375, 0],
    [0.7, 0.3, 0],
    [0, 0.3, 0.7],
  ],
  protanopia: [
    [0.567, 0.433, 0],
    [0.558, 0.442, 0],
    [0, 0.242, 0.758],
  ],
  tritanopia: [
    [0.95, 0.05, 0],
    [0, 0.433, 0.567],
    [0, 0.475, 0.525],
  ],
});

function clamp8(v) {
  return v < 0 ? 0 : (v > 255 ? 255 : v);
}

/**
 * Mutate ImageData in-place using the requested simulation mode.
 *
 * @param {ImageData} imageData
 * @param {ColorblindMode} mode
 * @returns {ImageData}
 */
export function applyColorblindSimulationToImageData(imageData, mode) {
  const m = mode && mode !== 'none' ? MATRICES[/** @type {Exclude<ColorblindMode,'none'>} */ (mode)] : null;
  if (!m) return imageData;

  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const rr = (m[0][0] * r) + (m[0][1] * g) + (m[0][2] * b);
    const gg = (m[1][0] * r) + (m[1][1] * g) + (m[1][2] * b);
    const bb = (m[2][0] * r) + (m[2][1] * g) + (m[2][2] * b);

    data[i] = clamp8(Math.round(rr));
    data[i + 1] = clamp8(Math.round(gg));
    data[i + 2] = clamp8(Math.round(bb));
    // Preserve alpha channel.
  }
  return imageData;
}

