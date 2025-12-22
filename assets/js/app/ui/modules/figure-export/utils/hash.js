/**
 * @fileoverview Small deterministic hashing helpers (export-only).
 *
 * Used to derive stable, dataset-specific seeds for jitter/reduction without
 * pulling in a full hashing library.
 *
 * @module ui/modules/figure-export/utils/hash
 */

/**
 * Deterministic 32-bit seed from an arbitrary string (FNV-1a).
 * @param {unknown} value
 * @returns {number}
 */
export function hashStringToSeed(value) {
  const s = String(value || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

