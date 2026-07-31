/**
 * @fileoverview The "n = N selected" badge drawn over an exported plot.
 *
 * WHY THIS IS SHARED:
 * The badge is a count claim about the panel it sits on. Single-view exports
 * take N from DataState (the same number the highlight summary shows). A grid
 * cannot: each panel carries its own filters, so the active view's count is
 * wrong for every other panel — which is why the badge must be counted from
 * the panel's own snapshot instead of being copied across.
 *
 * `countHighlightedVisiblePoints` reproduces DataState.getHighlightedCellCount
 * exactly (highlighted, alpha-visible, and admitted by the level of detail),
 * so a panel's badge means the same thing as the single-view badge.
 *
 * The geometry lives here too, so the SVG rectangle and the Canvas rectangle
 * are the same rectangle.
 *
 * @module ui/modules/figure-export/utils/selection-badge
 */

import {
  MIN_VISIBLE_ALPHA_BYTE,
  POINT_VISIBILITY_THRESHOLD,
} from './lod-membership.js';

/** Inset of the badge from the top-left corner of the plot (px). */
const BADGE_INSET = 8;

/** Padding between the badge border and its text (px). */
const BADGE_PADDING = 6;

/** Narrowest badge that still fits a short count (px). */
const BADGE_MIN_WIDTH = 90;

/**
 * Count the highlighted cells one exported panel actually shows.
 *
 * @param {object} options
 * @param {Uint8Array|null} options.highlightArray
 * @param {Float32Array|null} options.transparency
 * @param {{ indices: Uint32Array }|null} [options.lodMembership]
 * @returns {number}
 */
export function countHighlightedVisiblePoints({
  highlightArray,
  transparency,
  lodMembership = null,
}) {
  if (!(highlightArray instanceof Uint8Array)) return 0;

  let count = 0;
  if (lodMembership !== null) {
    const indices = lodMembership.indices;
    for (let cursor = 0; cursor < indices.length; cursor++) {
      const index = indices[cursor];
      if ((highlightArray[index] ?? 0) < MIN_VISIBLE_ALPHA_BYTE) continue;
      if (
        transparency !== null &&
        (transparency[index] ?? 0) < POINT_VISIBILITY_THRESHOLD
      ) {
        continue;
      }
      count++;
    }
    return count;
  }

  for (let index = 0; index < highlightArray.length; index++) {
    if (highlightArray[index] < MIN_VISIBLE_ALPHA_BYTE) continue;
    if (
      transparency !== null &&
      (transparency[index] ?? 0) < POINT_VISIBILITY_THRESHOLD
    ) {
      continue;
    }
    count++;
  }
  return count;
}

/**
 * Text and geometry for one selection badge, or null when nothing is selected.
 *
 * @param {object} options
 * @param {number} options.count
 * @param {{ x: number; y: number; width: number; height: number }} options.plotRect
 * @param {number} options.fontSizePx
 * @returns {{
 *   label: string;
 *   x: number;
 *   y: number;
 *   width: number;
 *   height: number;
 *   textX: number;
 *   textY: number;
 * }|null}
 */
export function buildSelectionBadge({ count, plotRect, fontSizePx }) {
  if (!Number.isSafeInteger(count) || count <= 0) return null;

  const label = `n = ${count.toLocaleString()} selected`;
  const height = Math.max(16, Math.round(fontSizePx * 1.35));
  const width = Math.min(
    Math.max(1, plotRect.width - BADGE_INSET * 2),
    Math.max(
      BADGE_MIN_WIDTH,
      Math.round(label.length * (fontSizePx * 0.62) + BADGE_PADDING * 2)
    )
  );
  const x = plotRect.x + BADGE_INSET;
  const y = plotRect.y + BADGE_INSET;

  return {
    label,
    x,
    y,
    width,
    height,
    textX: x + BADGE_PADDING,
    textY: y + height - BADGE_PADDING,
  };
}
