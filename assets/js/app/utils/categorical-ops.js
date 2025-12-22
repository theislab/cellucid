/**
 * Categorical field operations (pure utilities).
 *
 * Centralizes category-index transforms used by destructive categorical edits
 * (merge categories, delete-to-unassigned) so state/UI code stays DRY.
 *
 * These helpers are intentionally state-free:
 * - Input: categories array + indices
 * - Output: an index mapping + a derived categories array
 *
 * @module categorical-ops
 */

import { normalizeForCompare } from './label-utils.js';

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Detect labels like "unassigned", "Unassigned 2", "UNASSIGNED 10".
 * @param {string} label
 * @param {string} baseLabelLower - already normalized lower-case base
 * @returns {boolean}
 */
function isUnassignedVariant(label, baseLabelLower) {
  const norm = normalizeForCompare(label);
  if (!norm) return false;
  const re = new RegExp(`^${escapeRegExp(baseLabelLower)}(\\s+\\d+)?$`, 'i');
  return re.test(norm);
}

/**
 * Build an index mapping that merges a "deleted" category (and any existing
 * unassigned variants) into a single "unassigned" category.
 *
 * The output mapping is defined for indices `[0, categories.length)`.
 * Codes outside that range are expected to be handled by the caller.
 *
 * @param {Array<string>} categories
 * @param {number} deleteIndex
 * @param {object} [options]
 * @param {string} [options.unassignedLabel='unassigned'] - canonical label to use
 * @returns {{
 *   categories: string[],
 *   mapping: Uint16Array,
 *   unassignedNewIndex: number,
 *   keptOldUnassignedIndex: number|null,
 *   mergedOldIndices: number[]
 * }}
 */
export function buildDeleteToUnassignedTransform(categories, deleteIndex, options = {}) {
  const labels = Array.isArray(categories) ? categories : [];
  const oldCount = labels.length;
  const unassignedLabel = String(options.unassignedLabel ?? 'unassigned').trim() || 'unassigned';
  const baseLower = normalizeForCompare(unassignedLabel) || 'unassigned';
  const canonicalLabel = baseLower; // keep a consistent canonical representation

  const unassignedIndices = [];
  let baseUnassignedOldIndex = null;

  for (let i = 0; i < oldCount; i++) {
    const label = labels[i];
    if (!isUnassignedVariant(label, baseLower)) continue;
    unassignedIndices.push(i);
    if (baseUnassignedOldIndex == null && normalizeForCompare(label) === baseLower) {
      baseUnassignedOldIndex = i;
    }
  }

  // If we only have "unassigned N" variants, pick the first as the base and normalize its label.
  if (baseUnassignedOldIndex == null && unassignedIndices.length > 0) {
    baseUnassignedOldIndex = unassignedIndices[0];
  }

  if (!Number.isInteger(deleteIndex) || deleteIndex < 0 || deleteIndex >= oldCount) {
    throw new Error(`deleteIndex out of bounds (${deleteIndex})`);
  }

  // Deleting the canonical unassigned bucket is never meaningful.
  if (baseUnassignedOldIndex != null && deleteIndex === baseUnassignedOldIndex) {
    throw new Error('Cannot delete the unassigned category');
  }

  const indicesToMerge = new Set(unassignedIndices);
  indicesToMerge.add(deleteIndex);
  if (baseUnassignedOldIndex != null) indicesToMerge.delete(baseUnassignedOldIndex);

  const mapping = new Uint16Array(oldCount);
  const newCategories = [];
  let unassignedNewIndex = -1;

  for (let i = 0; i < oldCount; i++) {
    if (i === baseUnassignedOldIndex) {
      unassignedNewIndex = newCategories.length;
      newCategories.push(canonicalLabel);
      mapping[i] = unassignedNewIndex;
      continue;
    }

    if (indicesToMerge.has(i)) {
      // mapped after we know unassignedNewIndex
      continue;
    }

    const nextIndex = newCategories.length;
    newCategories.push(String(labels[i] ?? ''));
    mapping[i] = nextIndex;
  }

  // No existing unassigned bucket -> append one.
  if (unassignedNewIndex < 0) {
    unassignedNewIndex = newCategories.length;
    newCategories.push(canonicalLabel);
  }

  const mergedOldIndices = [...indicesToMerge];
  for (const idx of mergedOldIndices) {
    mapping[idx] = unassignedNewIndex;
  }

  return {
    categories: newCategories,
    mapping,
    unassignedNewIndex,
    keptOldUnassignedIndex: baseUnassignedOldIndex,
    mergedOldIndices
  };
}

/**
 * Build an index mapping that merges one category into another.
 * The merged-away category is removed from the output categories list.
 *
 * @param {Array<string>} categories
 * @param {number} fromIndex
 * @param {number} toIndex
 * @returns {{
 *   categories: string[],
 *   mapping: Uint16Array,
 *   targetNewIndex: number
 * }}
 */
export function buildMergeCategoriesTransform(categories, fromIndex, toIndex) {
  const labels = Array.isArray(categories) ? categories : [];
  const oldCount = labels.length;

  if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= oldCount) {
    throw new Error(`fromIndex out of bounds (${fromIndex})`);
  }
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= oldCount) {
    throw new Error(`toIndex out of bounds (${toIndex})`);
  }
  if (fromIndex === toIndex) {
    throw new Error('Cannot merge a category into itself');
  }

  const targetNewIndex = toIndex > fromIndex ? toIndex - 1 : toIndex;
  const mapping = new Uint16Array(oldCount);

  for (let i = 0; i < oldCount; i++) {
    if (i === fromIndex) {
      mapping[i] = targetNewIndex;
      continue;
    }
    mapping[i] = i > fromIndex ? i - 1 : i;
  }

  const newCategories = labels
    .filter((_, idx) => idx !== fromIndex)
    .map((l) => String(l ?? ''));

  return { categories: newCategories, mapping, targetNewIndex };
}

/**
 * Apply an old-index -> new-index mapping to a codes array.
 *
 * Codes that are out of range (>= oldCategoryCount) are preserved as-is.
 * This allows sentinel values like 255 to remain untouched.
 *
 * @param {Uint8Array|Uint16Array|Array<number>} codes
 * @param {Uint16Array|ArrayLike<number>} mapping
 * @param {number} newCategoryCount
 * @returns {Uint8Array|Uint16Array|Array<number>}
 */
export function applyCategoryIndexMapping(codes, mapping, newCategoryCount) {
  const oldCategoryCount = mapping?.length ?? 0;
  const n = codes?.length ?? 0;

  const getNewIndex = (oldIndex) => {
    if (oldIndex >= 0 && oldIndex < oldCategoryCount) return mapping[oldIndex];
    return oldIndex;
  };

  // Preserve plain arrays for callers that use them.
  if (!codes || typeof codes.length !== 'number' || !codes.constructor) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = getNewIndex(Number(codes?.[i] ?? 0));
    return out;
  }

  // Choose an output type that can hold the remapped indices.
  const isUint8 = codes instanceof Uint8Array;
  const needsUint16 = isUint8 && Number.isFinite(newCategoryCount) && newCategoryCount > 255;
  const ArrayType = needsUint16 ? Uint16Array : codes.constructor;

  const out = new ArrayType(n);
  for (let i = 0; i < n; i++) {
    const oldIndex = codes[i];
    out[i] = getNewIndex(oldIndex);
  }
  return out;
}

/**
 * Apply an old-index -> new-index mapping to a typed codes array *in place*.
 *
 * This is used for repeated destructive categorical edits (drag-merge, delete→unassigned)
 * on user-defined fields where we want to avoid allocating a full copy of the per-cell
 * codes array on every operation.
 *
 * Caller responsibilities:
 * - Only call when `codes` is a TypedArray (Uint8Array/Uint16Array/etc.)
 * - Ensure mapping values fit into the existing `codes` element type
 * - New indices must be valid for the updated categories list
 *
 * Codes outside `[0, mapping.length)` are preserved as-is (e.g., sentinel 255).
 *
 * @param {Uint8Array|Uint16Array|Int32Array|Uint32Array} codes
 * @param {Uint16Array|ArrayLike<number>} mapping
 * @returns {boolean} true when applied, false when not applicable
 */
export function applyCategoryIndexMappingInPlace(codes, mapping) {
  const oldCategoryCount = mapping?.length ?? 0;
  const n = codes?.length ?? 0;
  if (!oldCategoryCount || !n) return false;

  const isTypedArray =
    codes instanceof Uint8Array ||
    codes instanceof Uint16Array ||
    codes instanceof Uint32Array ||
    codes instanceof Int32Array;
  if (!isTypedArray) return false;

  // Fast path: mutate in place.
  for (let i = 0; i < n; i++) {
    const oldIndex = codes[i];
    if (oldIndex >= 0 && oldIndex < oldCategoryCount) {
      codes[i] = mapping[oldIndex];
    }
  }
  return true;
}
