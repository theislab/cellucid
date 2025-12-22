/**
 * @fileoverview Figure layout utilities for scientific figure export.
 *
 * This module provides layout calculations for exporting publication-quality figures.
 * It handles positioning of the plot area, legend, title, and axes while ensuring
 * the plot content maintains its intended size.
 *
 * KEY DESIGN DECISION:
 * The user-specified dimensions (width x height) represent the desired PLOT content size.
 * Legend, axes, and title are added as ADDITIONAL space around the plot, expanding
 * the total output dimensions. This ensures the scientific visualization maintains
 * its intended size and aspect ratio regardless of annotation settings.
 *
 * @module ui/modules/figure-export/utils/layout
 */

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
 * @returns {LayoutDimensions}
 */
export function computeExpandedDimensions({
  desiredPlotWidth,
  desiredPlotHeight,
  hasTitle = false,
  includeAxes = true,
  includeLegend = true,
  legendPosition = 'right'
}) {
  const plotWidth = Math.max(1, Math.round(desiredPlotWidth));
  const plotHeight = Math.max(1, Math.round(desiredPlotHeight));

  // Axis space allocation
  const axisLeft = includeAxes ? AXIS_LEFT_SPACE : NO_AXIS_PADDING;
  const axisRight = includeAxes ? AXIS_RIGHT_SPACE : NO_AXIS_PADDING;
  const axisTop = includeAxes ? AXIS_TOP_SPACE : NO_AXIS_PADDING;
  const axisBottom = includeAxes ? AXIS_BOTTOM_SPACE : NO_AXIS_PADDING;

  // Legend space allocation (added OUTSIDE the plot, not subtracted from it)
  const legendWidth = includeLegend && legendPosition === 'right' ? LEGEND_WIDTH_RIGHT : 0;
  const legendHeight = includeLegend && legendPosition === 'bottom' ? LEGEND_HEIGHT_BOTTOM : 0;
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
 * For backwards compatibility, if you need the plot to fit WITHIN specified
 * total dimensions, use computeSingleViewLayoutConstrained instead.
 *
 * @param {object} options
 * @param {number} options.width              - Desired plot content width (px)
 * @param {number} options.height             - Desired plot content height (px)
 * @param {string} [options.title='']         - Figure title (empty string = no title)
 * @param {boolean} [options.includeAxes=true] - Whether to include axes
 * @param {boolean} [options.includeLegend=true] - Whether to include legend
 * @param {LegendPosition} [options.legendPosition='right'] - Legend position
 * @returns {SingleViewLayout}
 */
export function computeSingleViewLayout({
  width,
  height,
  title = '',
  includeAxes = true,
  includeLegend = true,
  legendPosition = 'right'
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
    legendPosition
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

/**
 * Compute layout with the plot constrained to fit WITHIN specified total dimensions.
 *
 * This is the legacy behavior where the plot area shrinks to accommodate
 * legend and other elements within the user-specified total dimensions.
 *
 * USE CASE: When you need exact output dimensions (e.g., for journal requirements)
 * and are willing to have a smaller plot area.
 *
 * @param {object} options
 * @param {number} options.totalWidth         - Total output width (px)
 * @param {number} options.totalHeight        - Total output height (px)
 * @param {string} [options.title='']         - Figure title
 * @param {boolean} [options.includeAxes=true] - Whether to include axes
 * @param {boolean} [options.includeLegend=true] - Whether to include legend
 * @param {LegendPosition} [options.legendPosition='right'] - Legend position
 * @returns {SingleViewLayout}
 */
export function computeSingleViewLayoutConstrained({
  totalWidth,
  totalHeight,
  title = '',
  includeAxes = true,
  includeLegend = true,
  legendPosition = 'right'
}) {
  const outerPadding = OUTER_PADDING;
  const hasTitle = Boolean(String(title || '').trim());
  const titleHeight = hasTitle ? TITLE_HEIGHT : 0;

  // Axis space
  const axisLeft = includeAxes ? AXIS_LEFT_SPACE : NO_AXIS_PADDING;
  const axisBottom = includeAxes ? AXIS_BOTTOM_SPACE : NO_AXIS_PADDING;
  const axisTop = includeAxes ? AXIS_TOP_SPACE : NO_AXIS_PADDING;
  const axisRight = includeAxes ? AXIS_RIGHT_SPACE : NO_AXIS_PADDING;

  // Legend space (subtracts from content area)
  const legendW = includeLegend && legendPosition === 'right' ? LEGEND_WIDTH_RIGHT : 0;
  const legendH = includeLegend && legendPosition === 'bottom' ? LEGEND_HEIGHT_BOTTOM : 0;

  const contentX = outerPadding;
  const contentY = outerPadding + titleHeight;
  const contentW = Math.max(1, totalWidth - outerPadding * 2);
  const contentH = Math.max(1, totalHeight - outerPadding * 2 - titleHeight);

  // Plot area (shrinks to fit within constraints)
  const plotW = Math.max(1, contentW - axisLeft - axisRight - (legendW ? (LEGEND_GAP + legendW) : 0));
  const plotH = Math.max(1, contentH - axisTop - axisBottom - (legendH ? (LEGEND_GAP + legendH) : 0));

  const plotRect = {
    x: contentX + axisLeft,
    y: contentY + axisTop,
    width: plotW,
    height: plotH
  };

  const legendRect = includeLegend
    ? (legendPosition === 'right'
      ? {
        x: plotRect.x + plotRect.width + LEGEND_GAP,
        y: plotRect.y,
        width: legendW,
        height: plotRect.height
      }
      : {
        x: plotRect.x,
        y: plotRect.y + plotRect.height + LEGEND_GAP,
        width: plotRect.width,
        height: legendH
      })
    : null;

  const titleRect = hasTitle
    ? { x: outerPadding, y: outerPadding, width: contentW, height: titleHeight }
    : null;

  return {
    outerPadding,
    totalWidth,
    totalHeight,
    titleRect,
    plotRect,
    legendRect
  };
}

// ============================================================================
// Grid Layout Utilities
// ============================================================================

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
  NO_AXIS_PADDING
};
