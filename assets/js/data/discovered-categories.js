/**
 * The categories of a text or boolean obs column, or of integer labels (a
 * Loom clustering, `isClusteringColumn`), which a file stores no
 * dictionary for: its distinct values among the open cells, found and coded
 * in the reader worker (`anndata-reader-worker.js`), so the page receives
 * narrowed codes and never walks the values.
 *
 * How they are shown does not depend on which cells are open:
 *
 * - **Order**: the labels in code-point order (`compareCategoryLabels`;
 *   `false` before `true`), whatever cells hold them.
 * - **Colour**: derived from the label (`categoryNameSlots`): a stable hash
 *   of it picks a colour of Cellucid's category sequence (`getCategoryColor`),
 *   a label whose colour an earlier label (in code-point order) took moving
 *   to the next free one. Opening more cells adds categories without moving
 *   any: the labels already shown keep their colours, and each new one takes
 *   its own the same way among the colours left.
 *
 * A categorical the file stores keeps its own dictionary and the colours its
 * file stores (`uns['<column>_colors']`); none of this applies to it.
 *
 * @module data/discovered-categories
 */

import { BOOLEAN_FLAG_MISSING } from './anndata-value-kinds.js';
import { categoricalStorageForCount } from './categorical-storage-contract.js';
import { compareCodePoints } from './data-mapping.js';
import { allocateTypedArray } from './sparse-column-index.js';
import { getCategoryColor, getCategoryColorSeedCount } from './palettes.js';

/**
 * The order of category labels: booleans (`false` first), then numbers in
 * numeric order, then text in code-point order.
 *
 * @param {string|number|boolean} left
 * @param {string|number|boolean} right
 * @returns {number}
 */
export function compareCategoryLabels(left, right) {
  const leftType = typeof left;
  const rightType = typeof right;
  if (leftType !== rightType) {
    const rank = type => (type === 'boolean' ? 0 : (type === 'number' ? 1 : 2));
    return rank(leftType) - rank(rightType);
  }
  if (leftType === 'boolean') return Number(left) - Number(right);
  if (leftType === 'number') return left - right;
  // Code points, not UTF-16 code units: a label past U+FFFF sorts after
  // every label below it, as Python and R sort it.
  return compareCodePoints(left, right);
}

/** Code units of a surrogate pair: text holding one sorts by code point, not by code unit. */
const SURROGATE = /[\uD800-\uDFFF]/;

/**
 * Labels in label order (`compareCategoryLabels`). Text without a surrogate
 * pair sorts the same by UTF-16 code unit as by code point, so it is sorted
 * by the engine's own string order; only text past U+FFFF needs the slower
 * comparison.
 */
function sortLabels(labels) {
  if (labels.every(label => typeof label === 'string') && !labels.some(label => SURROGATE.test(label))) return labels.sort();
  return labels.sort(compareCategoryLabels);
}

/**
 * Code one text, boolean or integer-label column under `known` (the
 * categories it was coded with before, in order) and any label the values
 * hold that `known` lacks: the categories are `known` and those labels, in
 * label order (`compareCategoryLabels`), the codes narrowed to the storage
 * the page keeps (`categoricalStorageForCount`), a missing value (`null`,
 * or NaN among numbers) its marker.
 *
 * @param {ArrayLike<string|boolean|number|null>} values
 * @param {ReadonlyArray<string|boolean>|null} known
 * @param {string} label - What to name in a failure
 * @returns {{categories: Array<string|boolean>, codes: Uint8Array|Uint16Array|Uint32Array, added: boolean}}
 *   `added`: whether the values hold a label `known` lacks
 */
export function codeDiscoveredColumn(values, known, label) {
  const knownLabels = known ?? [];
  const index = new Map();
  for (let i = 0; i < knownLabels.length; i++) index.set(knownLabels[i], i);
  let found = null;
  // A value equal to the one before it (a file grouped by sample, cluster or
  // donor holds runs of one value) skips the Map: one comparison, not a hash.
  let previous;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value === previous) continue;
    previous = value;
    if (value === null || value === undefined || value !== value || index.has(value)) continue;
    if (typeof value !== 'string' && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value))) {
      throw new TypeError(`${label} holds a ${typeof value} value; a category is text, true/false or a number`);
    }
    (found ??= new Set()).add(value);
  }
  let categories = knownLabels;
  if (found !== null) {
    categories = sortLabels([...knownLabels, ...found]);
    index.clear();
    for (let i = 0; i < categories.length; i++) index.set(categories[i], i);
  }
  const { TypedArrayClass, missingValue } = categoricalStorageForCount(categories.length, label);
  const codes = allocateTypedArray(TypedArrayClass, values.length, `${label} codes`);
  let last;
  let lastCode = missingValue;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value !== last) {
      last = value;
      lastCode = value === null || value === undefined || value !== value ? missingValue : index.get(value);
    }
    codes[i] = lastCode;
  }
  return { categories: [...categories], codes, added: found !== null };
}

/**
 * Code one boolean column held as flags (`decodeAnnDataBooleanFlags`: 0
 * false, 1 true, `BOOLEAN_FLAG_MISSING` none) exactly as
 * `codeDiscoveredColumn` codes the same values, in one pass over bytes: no
 * JavaScript boolean or Map lookup per cell.
 *
 * @param {Uint8Array} flags
 * @param {ReadonlyArray<string|boolean>|null} known
 * @param {string} label
 * @returns {{categories: Array<string|boolean>, codes: Uint8Array|Uint16Array|Uint32Array, added: boolean}}
 */
export function codeBooleanColumn(flags, known, label) {
  if (!(flags instanceof Uint8Array)) throw new TypeError(`${label} flags must be a Uint8Array`);
  let seen = 0;
  for (let i = 0; i < flags.length && seen !== 3; i++) if (flags[i] < BOOLEAN_FLAG_MISSING) seen |= 1 << flags[i];
  const knownLabels = known ?? [];
  const found = [false, true].filter((value, bit) => ((seen >> bit) & 1) === 1 && !knownLabels.includes(value));
  const categories = found.length > 0 ? sortLabels([...knownLabels, ...found]) : [...knownLabels];
  const { TypedArrayClass, missingValue } = categoricalStorageForCount(categories.length, label);
  const codeOf = [categories.indexOf(false), categories.indexOf(true), missingValue];
  const codes = allocateTypedArray(TypedArrayClass, flags.length, `${label} codes`);
  for (let i = 0; i < flags.length; i++) codes[i] = codeOf[flags[i]];
  return { categories, codes, added: found.length > 0 };
}

/** FNV-1a, 32 bits, over a label's UTF-16 code units (two bytes each): the same on every engine. */
function labelHash(label) {
  const text = String(label);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    hash = Math.imul(hash ^ (unit & 0xff), 0x01000193);
    hash = Math.imul(hash ^ (unit >>> 8), 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The colour each category of a column whose categories were found takes,
 * as its place in Cellucid's category colour sequence (`getCategoryColor`):
 * labels already given one (`previous`, label to place) keep it; every other
 * label, in label order, takes the place its hash names among
 * `max(the sequence's designed colours, twice the categories)`, or the next
 * place no label took.
 *
 * @param {ReadonlyArray<string|boolean>} categories - In label order
 * @param {ReadonlyMap<string|boolean, number>} [previous]
 * @returns {Int32Array} One place a category
 */
export function categoryNameSlots(categories, previous = new Map()) {
  const places = Math.max(getCategoryColorSeedCount(), 2 * categories.length);
  const slots = allocateTypedArray(Int32Array, categories.length, 'Category colour places').fill(-1);
  const taken = new Set();
  categories.forEach((category, i) => {
    const kept = previous.get(category);
    if (kept !== undefined) {
      slots[i] = kept;
      taken.add(kept);
    }
  });
  categories.forEach((category, i) => {
    if (slots[i] >= 0) return;
    let slot = labelHash(category) % places;
    while (taken.has(slot)) slot = (slot + 1) % places;
    slots[i] = slot;
    taken.add(slot);
  });
  return slots;
}

/**
 * The colours of `categoryNameSlots`, one RGB triplet (0 to 1) a category:
 * what a field's `palette` holds (`defaultCategoryColor`).
 *
 * @param {Int32Array} slots
 * @returns {number[][]}
 */
export function paletteOfSlots(slots) {
  return Array.from(slots, slot => {
    const color = getCategoryColor(slot);
    return [color[0], color[1], color[2]];
  });
}
