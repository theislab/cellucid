/**
 * @fileoverview Each category's color and whether it is shown, for a
 * categorical field, as typed arrays that are never changed in place.
 *
 * - `field._categoryColors`: a `Uint8Array` of `3 × K` bytes, category `i`'s
 *   red, green and blue at `3i`, `3i + 1`, `3i + 2` (the bytes it is drawn
 *   in);
 * - `field._categoryVisible`: a `Uint8Array` of `K` bytes, 1 where category
 *   `i` is shown, 0 where it is hidden.
 *
 * Neither array is written once made: every change makes a new one
 * (`withCategoryColor`, `withCategoryVisibility`, `withCategoriesVisible`,
 * `carriedCategoryState`). So a kept view shares its source's arrays until
 * either view changes one (copy on write: a new view costs nothing per
 * category), and an array is checked once (`checkCategoryState`), not on
 * every coloring, filter pass or legend draw. A field of 1M categories
 * (clone or lineage ids, a text column of one label per cell) holds 4 MB,
 * shared by every view, where an RGB array per category and an object keyed
 * by index held ~90 MB per view and took ~50 ms to check on every action.
 *
 * Colors enter and leave as `[r, g, b]` channels from 0 to 1 (the color
 * picker's, a palette's, a session's): `categoryRgbAt` gives a category's as
 * its bytes over 255, the same numbers a hex color gives.
 *
 * @module utils/category-state
 */

import { defaultCategoryColor } from '../../data/palettes.js';

/** Arrays checked to be a field's colors or visibility, by the count they were checked for. */
const CHECKED = new WeakMap();
/** How many categories each visibility array hides (counted once per array). */
const HIDDEN = new WeakMap();
/** Each visibility array's complement: 1 where a category is hidden (made once per array). */
const HIDDEN_BYTES = new WeakMap();

/**
 * Category lists checked to hold distinct labels of a category's kinds. A
 * field's category list is never written once made (a rename makes a new
 * one, `renameCategory`), so a list checked stays checked.
 */
const CHECKED_LABELS = new WeakSet();

/**
 * Whether a category list was checked (`markLabelsChecked`): a list is
 * checked once, not on every coloring of a field of a million categories.
 *
 * @param {ReadonlyArray<unknown>} categories
 */
export function labelsChecked(categories) {
  return CHECKED_LABELS.has(categories);
}

/** Record that `categories` holds distinct labels of a category's kinds. */
export function markLabelsChecked(categories) {
  CHECKED_LABELS.add(categories);
}

/** One color channel from 0 to 1 as the byte it is drawn in. */
function channelByte(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${label} must be an RGB triplet of channels from 0 through 1.`);
  }
  return Math.round(value * 255);
}

/** Write `[r, g, b]` (channels from 0 to 1) as category `index`'s bytes. */
function writeRgb(colors, index, rgb, label) {
  if (!Array.isArray(rgb) && !ArrayBuffer.isView(rgb)) throw new TypeError(`${label} must be an RGB triplet.`);
  if (rgb.length !== 3) throw new TypeError(`${label} must be an RGB triplet.`);
  colors[index * 3] = channelByte(rgb[0], label);
  colors[index * 3 + 1] = channelByte(rgb[1], label);
  colors[index * 3 + 2] = channelByte(rgb[2], label);
}

/** Mark `array` as checked for `count` categories. */
function checked(array, count) {
  CHECKED.set(array, count);
  return array;
}

/**
 * The colors a field's categories open with (`defaultCategoryColor`: its
 * file's palette, else Cellucid's sequence).
 *
 * @param {{categories: ReadonlyArray<unknown>, palette?: ReadonlyArray<ReadonlyArray<number>>|null}} field
 * @returns {Uint8Array}
 */
export function defaultCategoryColors(field) {
  const count = field.categories.length;
  const colors = new Uint8Array(count * 3);
  for (let index = 0; index < count; index++) writeRgb(colors, index, defaultCategoryColor(field, index), `Category color ${index}`);
  return checked(colors, count);
}

/** Every category of `count` shown. */
function allCategoriesVisible(count) {
  return checked(new Uint8Array(count).fill(1), count);
}

/**
 * Check a field's colors and visibility (each array once: an array is
 * never written after it is made), making either it lacks: its default
 * colors, every category shown.
 *
 * @param {Object} field - A categorical field with its categories
 */
export function checkCategoryState(field) {
  const count = field.categories.length;
  // Both are checked before either is made: a field with one wrong is
  // refused as it is, never half repaired.
  const colors = field._categoryColors;
  if (colors !== undefined && CHECKED.get(colors) !== count) {
    if (!(colors instanceof Uint8Array) || colors.length !== count * 3) {
      throw new TypeError('Category colors must be one RGB triplet per category, as bytes.');
    }
  }
  const visible = field._categoryVisible;
  if (visible !== undefined && CHECKED.get(visible) !== count) {
    if (!(visible instanceof Uint8Array) || visible.length !== count) {
      throw new TypeError('Category visibility must hold every category index exactly once, a byte each.');
    }
    for (let index = 0; index < count; index++) {
      if (visible[index] > 1) throw new TypeError(`Category visibility ${index} must be 0 or 1.`);
    }
  }
  field._categoryColors = colors === undefined ? defaultCategoryColors(field) : checked(colors, count);
  field._categoryVisible = visible === undefined ? allCategoriesVisible(count) : checked(visible, count);
}

/**
 * Category `index`'s color as `[r, g, b]`, channels from 0 to 1.
 *
 * @param {Uint8Array} colors - A field's `_categoryColors`
 * @param {number} index
 * @returns {number[]}
 */
export function categoryRgbAt(colors, index) {
  return [colors[index * 3] / 255, colors[index * 3 + 1] / 255, colors[index * 3 + 2] / 255];
}

/**
 * Category `index`'s color as CSS, `rgb(r,g,b)` of its bytes: what a
 * swatch, a figure's legend or a chart draws it in.
 *
 * @param {Uint8Array} colors - A field's `_categoryColors`
 * @param {number} index
 * @returns {string}
 */
export function categoryCssAt(colors, index) {
  return `rgb(${colors[index * 3]},${colors[index * 3 + 1]},${colors[index * 3 + 2]})`;
}

/**
 * Whether category `index` is shown.
 *
 * @param {Uint8Array} visible - A field's `_categoryVisible`
 * @param {number} index
 * @returns {boolean}
 */
export function categoryShownAt(visible, index) {
  return visible[index] === 1;
}

/**
 * The color `field`'s category `index` is drawn in, as CSS: its own once
 * the field holds colors, else the one it opens with
 * (`defaultCategoryColor`); read without making the field's state (an
 * analysis reads a field no view has colored).
 *
 * @param {{categories: ReadonlyArray<unknown>, _categoryColors?: Uint8Array, palette?: ReadonlyArray<ReadonlyArray<number>>|null}} field
 * @param {number} index
 * @returns {string}
 */
export function fieldCategoryCss(field, index) {
  if (field._categoryColors !== undefined) return categoryCssAt(field._categoryColors, index);
  const [r, g, b] = defaultCategoryColor(field, index);
  return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
}

/** How many categories `visible` hides. */
export function hiddenCategoryCount(visible) {
  let hidden = HIDDEN.get(visible);
  if (hidden === undefined) {
    hidden = 0;
    for (let index = 0; index < visible.length; index++) if (visible[index] === 0) hidden++;
    HIDDEN.set(visible, hidden);
  }
  return hidden;
}

/**
 * One byte per category of `visible`, 1 where it is hidden: made once per
 * visibility array (never written: shared by every caller).
 *
 * @param {Uint8Array} visible
 * @returns {Uint8Array}
 */
export function hiddenCategoryBytes(visible) {
  let hidden = HIDDEN_BYTES.get(visible);
  if (hidden === undefined) {
    hidden = new Uint8Array(visible.length);
    for (let index = 0; index < visible.length; index++) hidden[index] = 1 - visible[index];
    HIDDEN_BYTES.set(visible, hidden);
  }
  return hidden;
}

/**
 * Give category `index` of `field` the color `rgb` (channels from 0 to 1):
 * a new color array, so a view sharing the old one keeps its own.
 */
export function withCategoryColor(field, index, rgb) {
  checkCategoryState(field);
  const colors = field._categoryColors.slice();
  writeRgb(colors, index, rgb, `Category color ${index}`);
  field._categoryColors = checked(colors, field.categories.length);
}

/**
 * Show or hide category `index` of `field`: a new visibility array, so a
 * view sharing the old one keeps its own.
 */
export function withCategoryVisibility(field, index, visible) {
  if (typeof visible !== 'boolean') throw new TypeError('Category visibility must be exactly true or false.');
  checkCategoryState(field);
  if ((field._categoryVisible[index] === 1) === visible) return;
  const next = field._categoryVisible.slice();
  next[index] = visible ? 1 : 0;
  field._categoryVisible = checked(next, field.categories.length);
}

/**
 * Show or hide every category of `field` (`only(index)` false leaves one as
 * it is): a new visibility array.
 *
 * @param {Object} field
 * @param {boolean} visible
 * @param {((index: number) => boolean)|null} [only]
 */
export function withCategoriesVisible(field, visible, only = null) {
  checkCategoryState(field);
  const next = field._categoryVisible.slice();
  const byte = visible ? 1 : 0;
  if (only === null) next.fill(byte);
  else for (let index = 0; index < next.length; index++) if (only(index)) next[index] = byte;
  field._categoryVisible = checked(next, field.categories.length);
}

/**
 * Several categories' visibility and colors changed at once (a restored
 * session's, labels held until their cells opened): each array copied once,
 * whatever the number of changes.
 *
 * @param {Object} field
 * @param {{visibility?: Array<{index: number, visible: boolean}>, colors?: Array<{index: number, rgb: ArrayLike<number>}>}} changes
 */
export function withCategoryChanges(field, { visibility = [], colors = [] }) {
  checkCategoryState(field);
  const count = field.categories.length;
  const inRange = index => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw new RangeError('Category index is outside the category inventory.');
    return index;
  };
  if (visibility.length > 0) {
    const next = field._categoryVisible.slice();
    for (const { index, visible } of visibility) {
      if (typeof visible !== 'boolean') throw new TypeError('Category visibility must be exactly true or false.');
      next[inRange(index)] = visible ? 1 : 0;
    }
    field._categoryVisible = checked(next, count);
  }
  if (colors.length > 0) {
    const next = field._categoryColors.slice();
    for (const { index, rgb } of colors) writeRgb(next, inRange(index), rgb, `Category color ${index}`);
    field._categoryColors = checked(next, count);
  }
}

/**
 * One view's colors and visibility carried to another category list:
 * category `index` of the new list takes old category `from(index)`'s
 * color and visibility; where that is -1 it opens in `opening(index)`'s
 * color (`[r, g, b]`, channels from 0 to 1), shown.
 *
 * @param {{colors: Uint8Array, visible: Uint8Array}} state - By old index
 * @param {number} count - The new list's categories
 * @param {(index: number) => number} from
 * @param {(index: number) => ArrayLike<number>} opening - The color a new category opens with
 * @returns {{colors: Uint8Array, visible: Uint8Array}} By new index, checked
 */
export function carriedCategoryState({ colors, visible }, count, from, opening) {
  const nextColors = new Uint8Array(count * 3);
  const nextVisible = new Uint8Array(count);
  for (let index = 0; index < count; index++) {
    const old = from(index);
    if (old < 0) {
      writeRgb(nextColors, index, opening(index), `Category color ${index}`);
      nextVisible[index] = 1;
      continue;
    }
    nextColors[index * 3] = colors[old * 3];
    nextColors[index * 3 + 1] = colors[old * 3 + 1];
    nextColors[index * 3 + 2] = colors[old * 3 + 2];
    nextVisible[index] = visible[old];
  }
  return { colors: checked(nextColors, count), visible: checked(nextVisible, count) };
}
