/**
 * @fileoverview Copy-on-write ownership of the per-cell view arrays.
 *
 * Every view context (the live view and each kept view) owns three per-cell
 * arrays: RGBA colors, transparency and the cell visibility mask. A kept view
 * starts out sharing all three with the view it was kept from, so keeping a
 * view costs no per-cell bytes until one of the views actually diverges. Each
 * writer asks this module for a writable array first, and an array another
 * view still holds is copied at that moment, so no view ever observes another
 * view's write.
 *
 * Colors carry one more rule. The viewer and renderer keep a snapshot's colors
 * by reference (the renderer's snapshot store never copies them), so an array
 * once handed to a snapshot is frozen: it is never written again, and any view
 * that recolors from it writes a copy.
 *
 * @module state/managers/per-cell-array-ownership
 */

import { firstNonBinaryByte } from '../../../rendering/alpha-visibility.js';
import { fillNeutralGray } from '../core/constants.js';

/** Colors arrays handed to a snapshot view; never written again. */
const SNAPSHOT_PUBLISHED_COLORS = new WeakSet();

/**
 * How many times each transparency array and each cell visibility mask was
 * handed out for writing. A result derived from one array (a visibility pass,
 * `filter-manager.js`) records its count and stays valid while the count does,
 * whichever view holds the array by then.
 */
const TRANSPARENCY_WRITES = new WeakMap();
const MASK_WRITES = new WeakMap();

/**
 * @param {Uint8Array} transparency
 * @returns {number} How many times `transparency` was handed out for writing.
 */
export function transparencyArrayWrites(transparency) {
  return TRANSPARENCY_WRITES.get(transparency) ?? 0;
}

/**
 * @param {Uint8Array} mask
 * @returns {number} How many times `mask` was handed out for writing.
 */
export function cellVisibilityMaskWrites(mask) {
  return MASK_WRITES.get(mask) ?? 0;
}

/**
 * Record that `colors` was handed to a snapshot view.
 *
 * @param {Uint8Array} colors
 */
export function markSnapshotPublishedColors(colors) {
  SNAPSHOT_PUBLISHED_COLORS.add(colors);
}

/**
 * Whether a stored view context other than the active one holds `array`.
 *
 * @param {{viewContexts?: Map<string, object>, activeViewId?: string}} state
 * @param {ArrayBufferView} array
 * @returns {boolean}
 */
function isHeldByInactiveView(state, array) {
  const contexts = state.viewContexts;
  if (!(contexts instanceof Map)) return false;
  const activeId = String(state.activeViewId);
  for (const [viewId, ctx] of contexts) {
    if (viewId === activeId || ctx === null || typeof ctx !== 'object') continue;
    if (
      ctx.colorsArray === array
      || ctx.categoryTransparency === array
      || ctx.cellVisibilityMask === array
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The active view's colors, safe to write in place.
 *
 * @param {object} state - DataState (or an equivalent view owner).
 * @returns {Uint8Array}
 */
export function writableColors(state) {
  const colors = state.colorsArray;
  if (
    SNAPSHOT_PUBLISHED_COLORS.has(colors)
    || isHeldByInactiveView(state, colors)
  ) {
    state.colorsArray = new Uint8Array(colors);
  }
  NEUTRAL_COLORS.delete(state.colorsArray);
  ALPHA_MIRRORS.delete(state.colorsArray);
  return state.colorsArray;
}

/**
 * Colors arrays whose every cell holds the neutral gray (`fillNeutralGray`)
 * in its RGB bytes since they were last handed out by `writableColors`.
 * Their alpha bytes are the view's visibility (`writableColorAlphaBytes`),
 * so only the RGB bytes are proven.
 */
const NEUTRAL_COLORS = new WeakSet();

/**
 * A new colors array of `pointCount` cells, opaque neutral gray.
 *
 * @param {number} pointCount
 * @returns {Uint8Array}
 */
export function createNeutralColors(pointCount) {
  const colors = fillNeutralGray(new Uint8Array(pointCount * 4));
  NEUTRAL_COLORS.add(colors);
  return colors;
}

/**
 * The active view's colors with neutral gray RGB bytes, written only when
 * they do not already hold it. The alpha bytes are left for the caller to
 * publish from the view's visibility.
 *
 * @param {object} state
 * @returns {Uint8Array}
 */
export function writableNeutralColors(state) {
  const colors = state.colorsArray;
  if (
    NEUTRAL_COLORS.has(colors)
    && !SNAPSHOT_PUBLISHED_COLORS.has(colors)
    && !isHeldByInactiveView(state, colors)
  ) {
    return colors;
  }
  const writable = writableColors(state);
  fillNeutralGray(writable);
  NEUTRAL_COLORS.add(writable);
  return writable;
}

/**
 * The active view's colors, safe for rewriting only their alpha bytes.
 *
 * The alpha byte of a colors array mirrors that view's own transparency. A
 * snapshot's renderer reads alpha from its own R8 texture and never from the
 * colors it keeps by reference, so a snapshot-held array may take its own
 * view's alpha bytes in place; only an array another view still holds is
 * copied first.
 *
 * @param {object} state
 * @returns {Uint8Array}
 */
export function writableColorAlphaBytes(state) {
  const colors = state.colorsArray;
  if (isHeldByInactiveView(state, colors)) {
    state.colorsArray = new Uint8Array(colors);
  }
  ALPHA_MIRRORS.delete(state.colorsArray);
  return state.colorsArray;
}

/**
 * For a colors array, the transparency its alpha bytes were last published
 * from (`recordAlphaBytesMirror`) and that array's write count then. Any
 * handing out of the colors for writing withdraws the record.
 */
const ALPHA_MIRRORS = new WeakMap();

/**
 * Record that every alpha byte of `colors` is now `transparency * 255`.
 *
 * @param {Uint8Array} colors
 * @param {Uint8Array} transparency
 */
export function recordAlphaBytesMirror(colors, transparency) {
  ALPHA_MIRRORS.set(colors, { transparency, writes: transparencyArrayWrites(transparency) });
}

/**
 * Whether every alpha byte of `colors` is `transparency * 255`: they were
 * published from it, and neither array was handed out for writing since.
 *
 * @param {Uint8Array} colors
 * @param {Uint8Array} transparency
 * @returns {boolean}
 */
export function alphaBytesMirror(colors, transparency) {
  const entry = ALPHA_MIRRORS.get(colors);
  return entry !== undefined
    && entry.transparency === transparency
    && entry.writes === transparencyArrayWrites(transparency);
}

/**
 * The active view's transparency, safe to write in place. The viewer copies
 * every transparency it accepts, so only stored contexts can share this array.
 *
 * @param {object} state
 * @returns {Uint8Array}
 */
export function writableTransparency(state) {
  const transparency = state.categoryTransparency;
  if (isHeldByInactiveView(state, transparency)) {
    state.categoryTransparency = new Uint8Array(transparency);
  }
  // Every transparency write goes through here, so these counters move on
  // every write: results derived from the array (category counts, visibility
  // passes) compare them instead of rescanning the array.
  state._transparencyEpoch = transparencyEpoch(state) + 1;
  const writable = state.categoryTransparency;
  TRANSPARENCY_WRITES.set(writable, transparencyArrayWrites(writable) + 1);
  return writable;
}

/**
 * How many times the state's transparency has been handed out for writing.
 *
 * @param {object} state
 * @returns {number}
 */
export function transparencyEpoch(state) {
  return Number.isSafeInteger(state._transparencyEpoch)
    ? state._transparencyEpoch
    : 0;
}

/**
 * Masks proven to hold only 0 and 1 since their last write. Every write goes
 * through `writableCellVisibilityMask`, which withdraws the proof, so a mask
 * is checked once per change instead of on every visibility computation.
 */
const PROVEN_BINARY_MASKS = new WeakSet();

/**
 * The active view's cell visibility mask, safe to write in place.
 *
 * @param {object} state
 * @returns {Uint8Array}
 */
export function writableCellVisibilityMask(state) {
  const mask = state.cellVisibilityMask;
  if (isHeldByInactiveView(state, mask)) {
    state.cellVisibilityMask = new Uint8Array(mask);
  }
  const writable = state.cellVisibilityMask;
  PROVEN_BINARY_MASKS.delete(writable);
  ALL_SHOWN_MASKS.delete(writable);
  MASK_WRITES.set(writable, cellVisibilityMaskWrites(writable) + 1);
  return writable;
}

/**
 * A new cell visibility mask that shows every cell; it holds only 1s, so it
 * is proven binary as it is made.
 *
 * @param {number} pointCount
 * @returns {Uint8Array}
 */
export function createShownCellVisibilityMask(pointCount) {
  const mask = new Uint8Array(pointCount).fill(1);
  PROVEN_BINARY_MASKS.add(mask);
  ALL_SHOWN_MASKS.add(mask);
  return mask;
}

/**
 * Masks made by `createShownCellVisibilityMask` and not handed out for
 * writing since: every entry is 1.
 */
const ALL_SHOWN_MASKS = new WeakSet();

/**
 * Whether every entry of `mask` is known to be 1 (it was made showing every
 * cell and has not been handed out for writing since).
 *
 * @param {Uint8Array} mask
 * @returns {boolean}
 */
export function isAllShownCellVisibilityMask(mask) {
  return ALL_SHOWN_MASKS.has(mask);
}

/**
 * Require every entry of a cell visibility mask to be exactly 0 or 1.
 *
 * @param {Uint8Array} mask
 * @returns {Uint8Array}
 */
export function requireBinaryCellVisibilityMask(mask) {
  if (PROVEN_BINARY_MASKS.has(mask)) return mask;
  const index = firstNonBinaryByte(mask);
  if (index >= 0) {
    throw new TypeError(`Cell visibility mask entry ${index} must be exactly 0 or 1.`);
  }
  PROVEN_BINARY_MASKS.add(mask);
  return mask;
}
