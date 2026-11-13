/**
 * @fileoverview Color vision simulation for the figure export preview.
 *
 * Each mode is the full-severity (dichromat) model of Machado, Oliveira and
 * Fernandes (2009, "A Physiologically-based Model for Simulation of Color
 * Vision Deficiency", IEEE TVCG 15(6)), a 3×3 matrix that applies to
 * *linear* RGB: a pixel is decoded from sRGB, transformed, and encoded again.
 * Applying a matrix to the encoded values instead (the old "Coblis"
 * approximation) shows colors as plainly different that a red–green
 * colorblind reader cannot tell apart, so a figure they cannot read would
 * pass the preview (36_decisions_figure_export.md).
 *
 * Preview-only: the exported figure keeps its colors.
 *
 * @module ui/modules/figure-export/utils/colorblindness
 */

/**
 * @typedef {'none'|'deuteranopia'|'protanopia'|'tritanopia'} ColorblindMode
 */

/** Machado et al. (2009), severity 1.0, for linear RGB. */
const MATRICES = /** @type {Record<Exclude<ColorblindMode,'none'>, number[][]>} */ ({
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.011820, 0.042940, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.303900],
  ],
});

/** sRGB byte → linear light, for every byte. */
const TO_LINEAR = new Float32Array(256);
for (let v = 0; v < 256; v++) {
  const c = v / 255;
  TO_LINEAR[v] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Linear light in 1/4096 steps → sRGB byte (finer than a byte's step anywhere). */
const ENCODE_STEPS = 4096;
const TO_SRGB = new Uint8ClampedArray(ENCODE_STEPS + 1);
for (let i = 0; i <= ENCODE_STEPS; i++) {
  const c = i / ENCODE_STEPS;
  TO_SRGB[i] = Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
}

function encode(linear) {
  if (!(linear > 0)) return 0;
  if (linear >= 1) return 255;
  return TO_SRGB[Math.round(linear * ENCODE_STEPS)];
}

/**
 * One sRGB color as a reader with `mode` sees it.
 *
 * @param {[number, number, number]} rgb - sRGB bytes
 * @param {ColorblindMode} mode
 * @returns {[number, number, number]} sRGB bytes
 */
export function simulateColorVision(rgb, mode) {
  const m = mode && mode !== 'none' ? MATRICES[/** @type {Exclude<ColorblindMode,'none'>} */ (mode)] : null;
  if (!m) return [rgb[0], rgb[1], rgb[2]];
  const r = TO_LINEAR[rgb[0]];
  const g = TO_LINEAR[rgb[1]];
  const b = TO_LINEAR[rgb[2]];
  return [
    encode(m[0][0] * r + m[0][1] * g + m[0][2] * b),
    encode(m[1][0] * r + m[1][1] * g + m[1][2] * b),
    encode(m[2][0] * r + m[2][1] * g + m[2][2] * b),
  ];
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
    const r = TO_LINEAR[data[i]];
    const g = TO_LINEAR[data[i + 1]];
    const b = TO_LINEAR[data[i + 2]];
    data[i] = encode((m[0][0] * r) + (m[0][1] * g) + (m[0][2] * b));
    data[i + 1] = encode((m[1][0] * r) + (m[1][1] * g) + (m[1][2] * b));
    data[i + 2] = encode((m[2][0] * r) + (m[2][1] * g) + (m[2][2] * b));
    // Alpha is kept.
  }
  return imageData;
}

