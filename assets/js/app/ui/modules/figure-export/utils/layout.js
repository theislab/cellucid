/**
 * @fileoverview Figure layout utilities for scientific figure export.
 *
 * This module provides layout calculations for exporting publication-quality figures.
 * It handles positioning of the plot area, legend, title, and axes while ensuring
 * the plot content maintains its intended size.
 *
 * NOTE: Legend size is computed dynamically from the legend model so exports
 * can show all legend entries (no “+N more” truncation).
 *
 * Both the single-view layout and the multi-panel grid cell layout live here,
 * so the SVG and PNG renderers place identical rectangles from one source.
 *
 * KEY DESIGN DECISION:
 * The user-specified dimensions (width x height) represent the desired PLOT content size.
 * Legend, axes, and title are added as ADDITIONAL space around the plot, expanding
 * the total output dimensions. This ensures the scientific visualization maintains
 * its intended size and aspect ratio regardless of annotation settings.
 *
 * @module ui/modules/figure-export/utils/layout
 */

import {
  HIDDEN_LEGEND_ENTRY_SUFFIX,
  isCategoryHidden
} from '../components/legend-builder.js';
import { clamp } from '../../../../utils/number-utils.js';

// ============================================================================
// Layout Constants
// ============================================================================

/** Outer padding around the entire figure (px) */
const OUTER_PADDING = 20;

/** Height reserved for title when present (px) */
const TITLE_HEIGHT = 34;

/** Gap between plot area and legend (px) */
const LEGEND_GAP = 16;

/** Width of legend panel when positioned on the right (px) */
const LEGEND_WIDTH_RIGHT = 240;

/** Height of legend panel when positioned at the bottom (px) */
const LEGEND_HEIGHT_BOTTOM = 140;

/** Legend layout padding (px) */
const LEGEND_PADDING = 8;

/** Legend swatch size (px) */
const LEGEND_SWATCH = 10;

/** Gap between swatch and text (px) */
const LEGEND_SWATCH_GAP = 6;

/**
 * Right-hand margin the legend builder keeps free inside every entry column.
 *
 * It has to be part of the width estimate: without it the panel is sized to
 * the bare text and the builder then truncates the longest entry — which, for
 * a hidden category, is exactly the entry whose marker must survive.
 */
const LEGEND_LABEL_MARGIN = 2;

/** Approximate average character width in pixels (multiplier × fontSize) */
const LEGEND_CHAR_WIDTH = 0.62;

/** Space reserved for Y-axis labels and ticks (px) */
const AXIS_LEFT_SPACE = 62;

/** Space reserved for X-axis labels and ticks (px) */
const AXIS_BOTTOM_SPACE = 62;

/** Minimal top margin for axes mode (px) */
const AXIS_TOP_SPACE = 10;

/** Minimal right margin for axes mode (px) */
const AXIS_RIGHT_SPACE = 10;

/** Minimal padding when axes are disabled (px) */
const NO_AXIS_PADDING = 10;

/**
 * Panel-legend geometry for grid (multi-panel) exports.
 *
 * A panel legend is only drawn when the panels disagree, so it competes with
 * the plot for room inside one cell. The floor is the width below which a
 * legend stops being readable at all; the ceiling matches the single-view
 * legend so a panel legend never dwarfs the data it explains. Between them the
 * panel may never surrender more than half its inner width (or body height) to
 * the legend.
 */
const PANEL_LEGEND_GAP = 8;
const PANEL_LEGEND_MIN_WIDTH = 96;
const PANEL_LEGEND_MIN_HEIGHT = 44;
const PANEL_LEGEND_MAX_SHARE = 0.5;

/**
 * Longest rendered legend entry, in characters.
 *
 * Hidden categories keep their entry and carry the hidden marker, so the marker
 * has to be reserved here too; otherwise the panel is sized for the bare names
 * and the legend builder truncates the very entries that need to stay readable.
 *
 * @param {any} model
 */
function longestCategoryEntryLength(model) {
  const categories = model.categories || [];
  let maxLen = 0;
  for (let index = 0; index < categories.length; index++) {
    const length = String(categories[index] ?? '').length
      + (isCategoryHidden(model, index) ? HIDDEN_LEGEND_ENTRY_SUFFIX.length : 0);
    if (length > maxLen) maxLen = length;
  }
  return maxLen;
}

function estimateLegendWidthRight({
  model,
  fontSizePx,
  plotHeight,
  minimumWidth = LEGEND_WIDTH_RIGHT
}) {
  if (!model) return minimumWidth;
  if (model.kind !== 'category') return minimumWidth;
  const categories = model.categories || [];
  if (!categories.length) return minimumWidth;

  const lineH = Math.max(14, Math.round(fontSizePx * 1.2));
  const headerSpace = LEGEND_PADDING + fontSizePx + 8;
  const availH = Math.max(1, plotHeight - headerSpace - LEGEND_PADDING);
  const rowsPerCol = Math.max(1, Math.floor(availH / lineH));
  const cols = Math.max(1, Math.ceil(categories.length / rowsPerCol));

  const textW = longestCategoryEntryLength(model) * fontSizePx * LEGEND_CHAR_WIDTH;
  const colW = LEGEND_SWATCH + LEGEND_SWATCH_GAP + textW + LEGEND_LABEL_MARGIN;
  const width = Math.ceil(LEGEND_PADDING * 2 + cols * colW);
  return Math.max(minimumWidth, width);
}

function estimateLegendHeightBottom({
  model,
  fontSizePx,
  plotWidth,
  minimumHeight = LEGEND_HEIGHT_BOTTOM
}) {
  if (!model) return minimumHeight;
  if (model.kind !== 'category') return minimumHeight;
  const categories = model.categories || [];
  if (!categories.length) return minimumHeight;

  const textW = longestCategoryEntryLength(model) * fontSizePx * LEGEND_CHAR_WIDTH;
  const colW = LEGEND_SWATCH + LEGEND_SWATCH_GAP + textW + LEGEND_LABEL_MARGIN;

  const lineH = Math.max(14, Math.round(fontSizePx * 1.2));
  const headerSpace = LEGEND_PADDING + fontSizePx + 8;
  const availW = Math.max(1, plotWidth - LEGEND_PADDING * 2);
  const cols = Math.max(1, Math.floor(availW / Math.max(1, colW)));
  const rows = Math.max(1, Math.ceil(categories.length / cols));
  const height = Math.ceil(headerSpace + rows * lineH + LEGEND_PADDING);
  return Math.max(minimumHeight, height);
}

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * @typedef {object} Rect
 * @property {number} x      - X coordinate of top-left corner
 * @property {number} y      - Y coordinate of top-left corner
 * @property {number} width  - Width of the rectangle
 * @property {number} height - Height of the rectangle
 */

/**
 * @typedef {'right'|'bottom'} LegendPosition
 */

/**
 * @typedef {object} LayoutDimensions
 * @property {number} totalWidth      - Total output width including all elements
 * @property {number} totalHeight     - Total output height including all elements
 * @property {number} plotWidth       - Width of the plot content area
 * @property {number} plotHeight      - Height of the plot content area
 * @property {number} legendWidth     - Width allocated for legend (0 if no legend)
 * @property {number} legendHeight    - Height allocated for legend (0 if no legend)
 */

/**
 * @typedef {object} SingleViewLayout
 * @property {number} outerPadding    - Outer padding value used
 * @property {number} totalWidth      - Total output width
 * @property {number} totalHeight     - Total output height
 * @property {Rect|null} titleRect    - Title area rectangle (null if no title)
 * @property {Rect} plotRect          - Plot content area rectangle
 * @property {Rect|null} legendRect   - Legend area rectangle (null if no legend)
 */

// ============================================================================
// Core Layout Functions
// ============================================================================

/**
 * Compute the total output dimensions needed to accommodate a desired plot size
 * plus all annotation elements (legend, axes, title).
 *
 * This is the primary function for determining figure dimensions. The user
 * specifies their desired plot size, and this function calculates how large
 * the total output needs to be to fit everything without shrinking the plot.
 *
 * @param {object} options
 * @param {number} options.desiredPlotWidth   - Desired width of the plot content area
 * @param {number} options.desiredPlotHeight  - Desired height of the plot content area
 * @param {boolean} [options.hasTitle=false]  - Whether a title will be included
 * @param {boolean} [options.includeAxes=true] - Whether axes will be rendered
 * @param {boolean} [options.includeLegend=true] - Whether legend will be rendered
 * @param {LegendPosition} [options.legendPosition='right'] - Legend position
 * @param {any} [options.legendModel=null] - Legend model (for sizing)
 * @param {number} [options.legendFontSizePx=12] - Legend font size (px, for sizing)
 * @returns {LayoutDimensions}
 */
export function computeExpandedDimensions({
  desiredPlotWidth,
  desiredPlotHeight,
  hasTitle = false,
  includeAxes = true,
  includeLegend = true,
  legendPosition = 'right',
  legendModel = null,
  legendFontSizePx = 12
}) {
  const plotWidth = Math.max(1, Math.round(desiredPlotWidth));
  const plotHeight = Math.max(1, Math.round(desiredPlotHeight));
  const legendFontPx = Math.max(6, Math.round(Number(legendFontSizePx) || 12));

  // Axis space allocation
  const axisLeft = includeAxes ? AXIS_LEFT_SPACE : NO_AXIS_PADDING;
  const axisRight = includeAxes ? AXIS_RIGHT_SPACE : NO_AXIS_PADDING;
  const axisTop = includeAxes ? AXIS_TOP_SPACE : NO_AXIS_PADDING;
  const axisBottom = includeAxes ? AXIS_BOTTOM_SPACE : NO_AXIS_PADDING;

  // Legend space allocation (added OUTSIDE the plot, not subtracted from it)
  const legendWidth = includeLegend && legendPosition === 'right'
    ? estimateLegendWidthRight({ model: legendModel, fontSizePx: legendFontPx, plotHeight })
    : 0;
  const legendHeight = includeLegend && legendPosition === 'bottom'
    ? estimateLegendHeightBottom({ model: legendModel, fontSizePx: legendFontPx, plotWidth })
    : 0;
  const legendGapH = legendWidth > 0 ? LEGEND_GAP : 0;
  const legendGapV = legendHeight > 0 ? LEGEND_GAP : 0;

  // Title space
  const titleSpace = hasTitle ? TITLE_HEIGHT : 0;

  // Calculate total dimensions
  const totalWidth = OUTER_PADDING + axisLeft + plotWidth + axisRight + legendGapH + legendWidth + OUTER_PADDING;
  const totalHeight = OUTER_PADDING + titleSpace + axisTop + plotHeight + axisBottom + legendGapV + legendHeight + OUTER_PADDING;

  return {
    totalWidth,
    totalHeight,
    plotWidth,
    plotHeight,
    legendWidth,
    legendHeight
  };
}

/**
 * Compute complete layout for a single-view figure export.
 *
 * IMPORTANT: This function interprets the input width/height as the desired
 * PLOT CONTENT size, not the total output size. The total output will be
 * LARGER to accommodate legend, axes, and title.
 *
 * @param {object} options
 * @param {number} options.width              - Desired plot content width (px)
 * @param {number} options.height             - Desired plot content height (px)
 * @param {string} [options.title='']         - Figure title (empty string = no title)
 * @param {boolean} [options.includeAxes=true] - Whether to include axes
 * @param {boolean} [options.includeLegend=true] - Whether to include legend
 * @param {LegendPosition} [options.legendPosition='right'] - Legend position
 * @param {any} [options.legendModel=null] - Legend model (for sizing)
 * @param {number} [options.legendFontSizePx=12] - Legend font size (px, for sizing)
 * @returns {SingleViewLayout}
 */
export function computeSingleViewLayout({
  width,
  height,
  title = '',
  includeAxes = true,
  includeLegend = true,
  legendPosition = 'right',
  legendModel = null,
  legendFontSizePx = 12
}) {
  const hasTitle = Boolean(String(title || '').trim());
  const plotWidth = Math.max(1, Math.round(width));
  const plotHeight = Math.max(1, Math.round(height));

  // Get expanded dimensions
  const dims = computeExpandedDimensions({
    desiredPlotWidth: plotWidth,
    desiredPlotHeight: plotHeight,
    hasTitle,
    includeAxes,
    includeLegend,
    legendPosition,
    legendModel,
    legendFontSizePx
  });

  // Axis margins
  const axisLeft = includeAxes ? AXIS_LEFT_SPACE : NO_AXIS_PADDING;
  const axisTop = includeAxes ? AXIS_TOP_SPACE : NO_AXIS_PADDING;

  // Title height
  const titleSpace = hasTitle ? TITLE_HEIGHT : 0;

  // Calculate plot rectangle position
  const plotRect = {
    x: OUTER_PADDING + axisLeft,
    y: OUTER_PADDING + titleSpace + axisTop,
    width: plotWidth,
    height: plotHeight
  };

  // Calculate legend rectangle
  const legendRect = includeLegend
    ? (legendPosition === 'right'
      ? {
        x: plotRect.x + plotRect.width + LEGEND_GAP,
        y: plotRect.y,
        width: dims.legendWidth,
        height: plotRect.height
      }
      : {
        x: plotRect.x,
        y: plotRect.y + plotRect.height + LEGEND_GAP,
        width: plotRect.width,
        height: dims.legendHeight
      })
    : null;

  // Calculate title rectangle
  const contentWidth = dims.totalWidth - OUTER_PADDING * 2;
  const titleRect = hasTitle
    ? { x: OUTER_PADDING, y: OUTER_PADDING, width: contentWidth, height: TITLE_HEIGHT }
    : null;

  return {
    outerPadding: OUTER_PADDING,
    totalWidth: dims.totalWidth,
    totalHeight: dims.totalHeight,
    titleRect,
    plotRect,
    legendRect
  };
}

// ============================================================================
// Grid Layout Utilities
// ============================================================================

/**
 * Compute the layout of one grid cell: panel label, plot area, and — when the
 * panels cannot share one legend — that panel's own legend.
 *
 * WHERE THE PANEL LEGEND GOES, AND WHY:
 * The cell is divided top-to-bottom into a header row (the "A. Live" label)
 * and a body. The legend is carved out of the body on the side the user chose
 * for the figure legend (`legendPosition`), so it can never overlap the plot,
 * the axes, or the panel label — every rectangle this function returns is
 * disjoint from the others. Axis space is then allocated from what is left,
 * which is why the plot shrinks rather than the legend overlapping it: a panel
 * a reader cannot decode is worse than a slightly smaller panel.
 *
 * The axis margins reuse the single-view constants (AXIS_LEFT_SPACE,
 * AXIS_RIGHT_SPACE, AXIS_BOTTOM_SPACE); they hold ticks and axis labels and so
 * cannot host a legend themselves.
 *
 * A cell too small to carry a readable legend (see PANEL_LEGEND_MIN_WIDTH /
 * PANEL_LEGEND_MIN_HEIGHT) returns `legendRect: null`; at that size no legend
 * text would be legible either.
 *
 * @param {object} options
 * @param {number} options.cellX
 * @param {number} options.cellY
 * @param {number} options.cellWidth
 * @param {number} options.cellHeight
 * @param {boolean} options.includeAxes
 * @param {number} options.fontSize        - Panel label font size (px)
 * @param {any} [options.legendModel=null] - Panel legend model, or null for none
 * @param {LegendPosition} [options.legendPosition='right']
 * @param {number} [options.legendFontSizePx=12]
 * @returns {{
 *   labelX: number;
 *   labelY: number;
 *   panelRect: Rect;
 *   plotRect: Rect;
 *   legendRect: Rect|null;
 * }}
 */
export function computeGridPaneLayout({
  cellX,
  cellY,
  cellWidth,
  cellHeight,
  includeAxes,
  fontSize,
  legendModel = null,
  legendPosition = 'right',
  legendFontSizePx = 12
}) {
  const padding = clamp(Math.round(fontSize * 0.65), 6, 12);
  const innerWidth = Math.max(1, cellWidth - padding * 2);
  const innerHeight = Math.max(1, cellHeight - padding * 2);
  const headerHeight = Math.min(
    Math.max(18, Math.round(fontSize * 1.5)),
    Math.max(0, innerHeight - 1)
  );
  const bodyHeight = Math.max(1, innerHeight - headerHeight);
  const legendFontPx = Math.max(6, Math.round(Number(legendFontSizePx) || 12));

  let legendRect = null;
  let legendReserveWidth = 0;
  let legendReserveHeight = 0;

  if (legendModel !== null) {
    if (legendPosition === 'right') {
      const affordable =
        Math.floor(innerWidth * PANEL_LEGEND_MAX_SHARE) - PANEL_LEGEND_GAP;
      if (affordable >= PANEL_LEGEND_MIN_WIDTH) {
        const width = Math.min(
          affordable,
          Math.min(
            LEGEND_WIDTH_RIGHT,
            estimateLegendWidthRight({
              model: legendModel,
              fontSizePx: legendFontPx,
              plotHeight: bodyHeight,
              minimumWidth: PANEL_LEGEND_MIN_WIDTH
            })
          )
        );
        legendReserveWidth = width + PANEL_LEGEND_GAP;
        legendRect = {
          x: cellX + padding + innerWidth - width,
          y: cellY + padding + headerHeight,
          width,
          height: bodyHeight
        };
      }
    } else {
      const affordable =
        Math.floor(bodyHeight * PANEL_LEGEND_MAX_SHARE) - PANEL_LEGEND_GAP;
      if (affordable >= PANEL_LEGEND_MIN_HEIGHT) {
        const height = Math.min(
          affordable,
          Math.min(
            LEGEND_HEIGHT_BOTTOM,
            estimateLegendHeightBottom({
              model: legendModel,
              fontSizePx: legendFontPx,
              plotWidth: innerWidth,
              minimumHeight: PANEL_LEGEND_MIN_HEIGHT
            })
          )
        );
        legendReserveHeight = height + PANEL_LEGEND_GAP;
        legendRect = {
          x: cellX + padding,
          y: cellY + padding + innerHeight - height,
          width: innerWidth,
          height
        };
      }
    }
  }

  const plotAreaWidth = Math.max(1, innerWidth - legendReserveWidth);
  const plotAreaHeight = Math.max(1, bodyHeight - legendReserveHeight);
  const minPlotWidth = Math.min(80, Math.max(1, plotAreaWidth * 0.45));
  const minPlotHeight = Math.min(64, Math.max(1, plotAreaHeight * 0.45));
  const axisRight = includeAxes
    ? Math.min(AXIS_RIGHT_SPACE, Math.max(0, plotAreaWidth - minPlotWidth))
    : 0;
  const axisLeft = includeAxes
    ? Math.min(
      AXIS_LEFT_SPACE,
      Math.max(0, plotAreaWidth - axisRight - minPlotWidth)
    )
    : 0;
  const axisBottom = includeAxes
    ? Math.min(AXIS_BOTTOM_SPACE, Math.max(0, plotAreaHeight - minPlotHeight))
    : 0;
  const plotRect = {
    x: cellX + padding + axisLeft,
    y: cellY + padding + headerHeight,
    width: Math.max(1, plotAreaWidth - axisLeft - axisRight),
    height: Math.max(1, plotAreaHeight - axisBottom),
  };

  return {
    labelX: plotRect.x,
    labelY: cellY + padding + Math.min(fontSize, Math.max(1, headerHeight)),
    panelRect: {
      x: cellX + 1,
      y: cellY + 1,
      width: Math.max(1, cellWidth - 2),
      height: Math.max(1, cellHeight - 2),
    },
    plotRect,
    legendRect,
  };
}

/**
 * Compute optimal grid dimensions (columns × rows) for multi-panel layouts.
 *
 * Uses a square-ish layout that slightly favors more columns than rows
 * for typical landscape aspect ratios.
 *
 * @param {number} count - Number of panels to arrange
 * @returns {{ cols: number; rows: number }}
 *
 * @example
 * computeGridDims(1)  // { cols: 1, rows: 1 }
 * computeGridDims(2)  // { cols: 2, rows: 1 }
 * computeGridDims(4)  // { cols: 2, rows: 2 }
 * computeGridDims(6)  // { cols: 3, rows: 2 }
 */
export function computeGridDims(count) {
  const n = Math.max(1, count);

  // For 1-3 panels, use single row
  if (n <= 3) {
    return { cols: n, rows: 1 };
  }

  // For larger counts, aim for square-ish grid
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);

  return { cols, rows };
}

// ============================================================================
// Export Layout Constants for External Use
// ============================================================================

export const LAYOUT_CONSTANTS = {
  OUTER_PADDING,
  TITLE_HEIGHT,
  LEGEND_GAP,
  LEGEND_WIDTH_RIGHT,
  LEGEND_HEIGHT_BOTTOM,
  AXIS_LEFT_SPACE,
  AXIS_BOTTOM_SPACE,
  AXIS_TOP_SPACE,
  AXIS_RIGHT_SPACE,
  NO_AXIS_PADDING,
  PANEL_LEGEND_GAP,
  PANEL_LEGEND_MIN_WIDTH,
  PANEL_LEGEND_MIN_HEIGHT,
  PANEL_LEGEND_MAX_SHARE
};
