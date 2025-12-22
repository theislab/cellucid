/**
 * Label utilities
 *
 * Centralizes common label/string behaviors used across the app to keep the
 * codebase DRY and reduce ad-hoc implementations in UI + state code.
 *
 * This module is intentionally dependency-free.
 */

/**
 * Normalize a value for case-insensitive comparisons.
 * @param {*} value
 * @returns {string}
 */
export function normalizeForCompare(value) {
  return String(value ?? '').trim().toLocaleLowerCase();
}

/**
 * Create a unique label by appending a numeric suffix when needed.
 *
 * Example:
 * - base="Unassigned", existing=["A","Unassigned"] -> "Unassigned 2"
 *
 * Uniqueness is case-insensitive to avoid near-duplicate labels.
 *
 * @param {string} baseLabel
 * @param {Iterable<string>} existingLabels
 * @param {object} [options]
 * @param {number} [options.startIndex=2] - First suffix number to try.
 * @param {string} [options.separator=' '] - Separator between base and number.
 * @returns {string}
 */
export function makeUniqueLabel(baseLabel, existingLabels, options = {}) {
  const { startIndex = 2, separator = ' ' } = options;
  const base = String(baseLabel ?? '').trim();
  if (!base) return '';

  const existingNormalized = new Set();
  for (const label of existingLabels || []) {
    existingNormalized.add(normalizeForCompare(label));
  }

  const baseNorm = normalizeForCompare(base);
  if (!existingNormalized.has(baseNorm)) return base;

  let suffix = Math.max(2, Number.isFinite(startIndex) ? startIndex : 2);
  while (existingNormalized.has(normalizeForCompare(`${base}${separator}${suffix}`))) {
    suffix += 1;
  }
  return `${base}${separator}${suffix}`;
}
