/**
 * @fileoverview The legend entry for the highlighted cells a figure draws.
 *
 * A figure draws the active highlight page's cells over the coloring in the
 * highlight's color (`HIGHLIGHT_COLOR`), as the screen does: a reader of the
 * figure who never saw the app cannot tell that color from the coloring's
 * (a cyan highlight over a gene's viridis reads as the cells of high
 * expression). So wherever the figure draws highlighted
 * cells its legend carries an entry for them: a swatch of the highlight's
 * color, the page's name and its highlighted cell count. The entry
 * follows the legend (Legend off, no entry) and the cells drawn: a panel that
 * draws none of them carries none.
 *
 * @module ui/modules/figure-export/utils/highlight-legend
 */

import { HIGHLIGHT_COLOR } from '../../../../../rendering/shaders/high-perf-shaders.js';
import { formatCountOf } from '../../../../../utils/format-units.js';
import { countHighlightedVisiblePoints } from './selection-badge.js';

/** The highlight's color in 0–255 channels, as a figure writes it. */
export const HIGHLIGHT_RGB = Object.freeze(HIGHLIGHT_COLOR.map(channel => Math.round(channel * 255)));

/** The highlight's color as CSS, for the legend swatch. */
export const HIGHLIGHT_CSS = `rgb(${HIGHLIGHT_RGB.join(', ')})`;

/**
 * @typedef {object} HighlightLegendEntry
 * @property {string} label - "Highlighted: <page> (<N> cells)"
 * @property {string} color - CSS color of the swatch (`HIGHLIGHT_CSS`)
 */

/**
 * The legend entry for a highlight page's cells, or null when it has none.
 *
 * @param {object} options
 * @param {string|null} options.pageName - the active highlight page's name
 * @param {number} options.cellCount - the page's highlighted cells
 * @returns {HighlightLegendEntry|null}
 */
export function highlightLegendEntry({ pageName, cellCount }) {
  if (!Number.isSafeInteger(cellCount) || cellCount <= 0) return null;
  const name = String(pageName ?? '').trim();
  const cells = formatCountOf(cellCount, 'cell');
  return {
    label: name === '' ? `Highlighted (${cells})` : `Highlighted: ${name} (${cells})`,
    color: HIGHLIGHT_CSS,
  };
}

/**
 * @typedef {object} FigureHighlightLegend
 * @property {HighlightLegendEntry} entry
 * @property {boolean[]} panels - whether each panel draws highlighted cells, in `views` order
 */

/**
 * The highlight entry of an export payload's legends: the entry, and which
 * panels draw highlighted cells (`countHighlightedVisiblePoints`, the count
 * the selection badge gives: highlighted, drawn, admitted by the level of
 * detail). Null when the figure draws none.
 *
 * @param {{ selection: { highlightArray: Uint8Array|null, totalCount: number, pageName: string|null },
 *   views: ReadonlyArray<{ data: { transparency: Uint8Array|null }, scientificState: { lodMembership: any } }> }} payload
 * @returns {FigureHighlightLegend|null}
 */
export function figureHighlightLegend({ selection, views }) {
  const entry = highlightLegendEntry({ pageName: selection.pageName, cellCount: selection.totalCount });
  if (entry === null) return null;
  const panels = views.map(view => countHighlightedVisiblePoints({
    highlightArray: selection.highlightArray,
    transparency: view.data?.transparency ?? null,
    lodMembership: view.scientificState.lodMembership ?? null,
  }) > 0);
  return panels.some(Boolean) ? { entry, panels } : null;
}
